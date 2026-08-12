const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireProjectMember } = require('../middleware/requireProjectMember');
const { asyncHandler } = require('../utils/asyncHandler');

// Mounted at /api/projects/:projectId/room-materials.
// The frontend's PROJECT_SCOPE_ID ('__project__') sentinel roomId — used for
// "whole project" pipe/fitting driver mappings that aren't tied to a real
// room — arrives here as roomId: null and is stored as a NULL room_id.
const router = express.Router({ mergeParams: true });

router.get('/', requireAuth, requireProjectMember('projectId'), asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM mapped_room_materials WHERE project_id = $1 ORDER BY id', [req.params.projectId]);
  res.json(rows);
}));

router.post('/', requireAuth, requireProjectMember('projectId'), asyncHandler(async (req, res) => {
  const { roomId, materialId, wastage, manualQty, surface } = req.body || {};
  if (!materialId) return res.status(400).json({ error: 'materialId is required' });

  const { rows } = await pool.query(
    `INSERT INTO mapped_room_materials (project_id, room_id, material_id, wastage, manual_qty, surface)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.params.projectId, roomId || null, materialId, wastage || 0, manualQty != null ? manualQty : 1, surface || null]
  );
  res.status(201).json(rows[0]);
}));

router.patch('/:id', requireAuth, requireProjectMember('projectId'), asyncHandler(async (req, res) => {
  const { rows: existingRows } = await pool.query(
    'SELECT * FROM mapped_room_materials WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]
  );
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'Mapping not found' });

  const fields = ['wastage', 'manualQty'];
  const columnFor = { manualQty: 'manual_qty' };
  const updates = [];
  const values = [];
  fields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
      values.push(req.body[field]);
      updates.push(`${columnFor[field] || field} = $${values.length}`);
    }
  });
  if (updates.length === 0) return res.json(existing);

  values.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE mapped_room_materials SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  res.json(rows[0]);
}));

router.delete('/:id', requireAuth, requireProjectMember('projectId'), asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM mapped_room_materials WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Mapping not found' });
  res.status(204).end();
}));

// Bulk-clear all mappings for one room (mirrors clearAllMappingsForActiveRoom).
router.delete('/', requireAuth, requireProjectMember('projectId'), asyncHandler(async (req, res) => {
  const { roomId } = req.query;
  if (!roomId) return res.status(400).json({ error: 'roomId query param is required' });
  await pool.query('DELETE FROM mapped_room_materials WHERE project_id = $1 AND room_id = $2', [req.params.projectId, roomId]);
  res.status(204).end();
}));

module.exports = router;
