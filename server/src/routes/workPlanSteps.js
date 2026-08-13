const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireProjectMember } = require('../middleware/requireProjectMember');
const { requireLedgerParty } = require('../middleware/requireLedgerParty');
const { asyncHandler } = require('../utils/asyncHandler');
const { logActivity } = require('../utils/activityLog');

// Mounted at /api/projects/:projectId/work-plan-steps. Contractor+Owner both get full
// read/write (same population as the Shared Ledger, reusing requireLedgerParty) — the
// app has never gated Work Plan by role, and both parties work on it together.
const router = express.Router({ mergeParams: true });

const num = (v) => (v != null ? parseFloat(v) : null);
const FIELD_LABELS = { name: 'name', area: 'area', planned_days: 'time to finish', budget: 'budget', status: 'status' };

async function loadStepsWithChildren(projectId) {
  const { rows: steps } = await pool.query('SELECT * FROM work_plan_steps WHERE project_id = $1 ORDER BY sort_order, id', [projectId]);
  if (steps.length === 0) return [];
  const stepIds = steps.map(s => s.id);
  const { rows: materials } = await pool.query('SELECT * FROM work_plan_materials WHERE step_id = ANY($1)', [stepIds]);
  const { rows: labor } = await pool.query('SELECT * FROM work_plan_labor WHERE step_id = ANY($1)', [stepIds]);
  return steps.map(s => ({
    ...s,
    materials: materials.filter(m => m.step_id === s.id),
    labor: labor.filter(l => l.step_id === s.id)
  }));
}

router.get('/', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  res.json(await loadStepsWithChildren(req.params.projectId));
}));

router.post('/', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { name, area, plannedDays, budget, status } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { rows: countRows } = await pool.query('SELECT COUNT(*)::int AS c FROM work_plan_steps WHERE project_id = $1', [req.params.projectId]);
  const { rows } = await pool.query(
    `INSERT INTO work_plan_steps (project_id, name, area, planned_days, budget, status, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.params.projectId, name, area || 'Base', num(plannedDays) || 1, num(budget) || 0, status || 'not', countRows[0].c]
  );
  await logActivity(req.params.projectId, req.user.id, 'work_plan', 'Added step', `"${rows[0].name}"`);
  res.status(201).json({ ...rows[0], materials: [], labor: [] });
}));

router.patch('/:id', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { rows: existingRows } = await pool.query('SELECT * FROM work_plan_steps WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]);
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'Step not found' });

  const fields = ['name', 'area', 'plannedDays', 'budget', 'status'];
  const columnFor = { plannedDays: 'planned_days' };
  const updates = [];
  const values = [];
  const logs = [];
  fields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
      const column = columnFor[field] || field;
      const newVal = field === 'plannedDays' || field === 'budget' ? num(req.body[field]) : req.body[field];
      if (existing[column] != newVal) {
        logs.push({ column, prev: existing[column], next: newVal });
      }
      values.push(newVal);
      updates.push(`${column} = $${values.length}`);
    }
  });
  if (updates.length === 0) return res.json(existing);

  values.push(req.params.id);
  const { rows } = await pool.query(`UPDATE work_plan_steps SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`, values);

  for (const log of logs) {
    const label = FIELD_LABELS[log.column] || log.column;
    const fmt = (v) => (log.column === 'budget' ? `$${(parseFloat(v) || 0).toFixed(2)}` : log.column === 'planned_days' ? `${v} day(s)` : v);
    await logActivity(req.params.projectId, req.user.id, 'work_plan', `Edited step ${label}`, `"${existing.name}": ${fmt(log.prev)} → ${fmt(log.next)}`);
  }
  res.json(rows[0]);
}));

router.delete('/:id', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('DELETE FROM work_plan_steps WHERE id = $1 AND project_id = $2 RETURNING *', [req.params.id, req.params.projectId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Step not found' });
  await logActivity(req.params.projectId, req.user.id, 'work_plan', 'Removed step', `"${rows[0].name}"`);
  res.status(204).end();
}));

router.post('/reorder', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { stepIds } = req.body || {};
  if (!Array.isArray(stepIds)) return res.status(400).json({ error: 'stepIds must be an array' });
  await Promise.all(stepIds.map((id, i) =>
    pool.query('UPDATE work_plan_steps SET sort_order = $1 WHERE id = $2 AND project_id = $3', [i, id, req.params.projectId])
  ));
  res.json(await loadStepsWithChildren(req.params.projectId));
}));

router.post('/:id/labor', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { rows: stepRows } = await pool.query('SELECT * FROM work_plan_steps WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]);
  const step = stepRows[0];
  if (!step) return res.status(404).json({ error: 'Step not found' });
  const { description, amount } = req.body || {};
  const { rows } = await pool.query(
    'INSERT INTO work_plan_labor (step_id, description, amount) VALUES ($1,$2,$3) RETURNING *',
    [req.params.id, description || 'Payment', num(amount) || 0]
  );
  await logActivity(req.params.projectId, req.user.id, 'work_plan', 'Added labor payment', `"${rows[0].description}" — $${(num(amount) || 0).toFixed(2)} on step "${step.name}"`);
  res.status(201).json(rows[0]);
}));

router.delete('/:id/labor/:laborId', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { rows: stepRows } = await pool.query('SELECT * FROM work_plan_steps WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]);
  const step = stepRows[0];
  if (!step) return res.status(404).json({ error: 'Step not found' });
  const { rows } = await pool.query('DELETE FROM work_plan_labor WHERE id = $1 AND step_id = $2 RETURNING *', [req.params.laborId, req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Labor line not found' });
  await logActivity(req.params.projectId, req.user.id, 'work_plan', 'Removed labor payment', `"${rows[0].description}" — $${(num(rows[0].amount) || 0).toFixed(2)} on step "${step.name}"`);
  res.status(204).end();
}));

router.post('/:id/materials', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { rows: stepRows } = await pool.query('SELECT * FROM work_plan_steps WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]);
  const step = stepRows[0];
  if (!step) return res.status(404).json({ error: 'Step not found' });
  const { name, cost, unit, qty, source, materialId, roomId, mappingId } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { rows } = await pool.query(
    `INSERT INTO work_plan_materials (step_id, name, cost, unit, qty, bought, source, material_id, room_id, mapping_id)
     VALUES ($1,$2,$3,$4,$5,false,$6,$7,$8,$9) RETURNING *`,
    [req.params.id, name, num(cost) || 0, unit || 'units', num(qty) || 0, source || null, materialId || null, roomId || null, mappingId || null]
  );
  await logActivity(req.params.projectId, req.user.id, 'work_plan', 'Added material', `"${name}" to step "${step.name}"`);
  res.status(201).json(rows[0]);
}));

router.delete('/:id/materials/:materialId', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { rows: stepRows } = await pool.query('SELECT * FROM work_plan_steps WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]);
  const step = stepRows[0];
  if (!step) return res.status(404).json({ error: 'Step not found' });
  const { rows: matRows } = await pool.query('SELECT * FROM work_plan_materials WHERE id = $1 AND step_id = $2', [req.params.materialId, req.params.id]);
  const mat = matRows[0];
  if (!mat) return res.status(404).json({ error: 'Material line not found' });
  if (mat.ledger_item_id) return res.status(403).json({ error: 'This material is in the Shared Ledger — remove it from Window 3 instead' });
  await pool.query('DELETE FROM work_plan_materials WHERE id = $1', [req.params.materialId]);
  await logActivity(req.params.projectId, req.user.id, 'work_plan', 'Removed material', `"${mat.name}" from step "${step.name}"`);
  res.status(204).end();
}));

router.patch('/:id/materials/:materialId', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { rows: stepRows } = await pool.query('SELECT * FROM work_plan_steps WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]);
  const step = stepRows[0];
  if (!step) return res.status(404).json({ error: 'Step not found' });
  const { bought, ledgerItemId } = req.body || {};
  const { rows } = await pool.query(
    'UPDATE work_plan_materials SET bought = COALESCE($1, bought), ledger_item_id = COALESCE($2, ledger_item_id) WHERE id = $3 AND step_id = $4 RETURNING *',
    [bought, ledgerItemId, req.params.materialId, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Material line not found' });
  await logActivity(req.params.projectId, req.user.id, 'work_plan', bought ? 'Marked material bought' : 'Unmarked material bought', `"${rows[0].name}" on step "${step.name}"`);
  res.json(rows[0]);
}));

module.exports = router;
