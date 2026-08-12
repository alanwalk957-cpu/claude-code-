const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireProjectMember } = require('../middleware/requireProjectMember');
const { requireLedgerParty } = require('../middleware/requireLedgerParty');
const { asyncHandler } = require('../utils/asyncHandler');

// Mounted at /api/projects/:projectId/ledger-folders. Unilateral CRUD — no approval
// gate, matching the app's existing folder behavior exactly (see saveW3Folder/
// deleteW3Folder in the frontend).
const router = express.Router({ mergeParams: true });

router.get('/', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM ledger_folders WHERE project_id = $1 ORDER BY id', [req.params.projectId]);
  res.json(rows);
}));

router.post('/', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { name, budget } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const { rows } = await pool.query(
    'INSERT INTO ledger_folders (project_id, name, budget) VALUES ($1,$2,$3) RETURNING *',
    [req.params.projectId, name, budget != null ? budget : null]
  );
  res.status(201).json(rows[0]);
}));

router.patch('/:id', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { name, budget } = req.body || {};
  const { rows } = await pool.query(
    'UPDATE ledger_folders SET name = COALESCE($1, name), budget = $2 WHERE id = $3 AND project_id = $4 RETURNING *',
    [name || null, budget != null ? budget : null, req.params.id, req.params.projectId]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Folder not found' });
  res.json(rows[0]);
}));

router.delete('/:id', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  // Reassign any items in this folder to 'all' before dropping it — mirrors deleteW3Folder.
  await pool.query(
    "UPDATE ledger_items SET folder_id = 'all' WHERE project_id = $1 AND folder_id = $2",
    [req.params.projectId, req.params.id]
  );
  const { rowCount } = await pool.query(
    'DELETE FROM ledger_folders WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Folder not found' });
  res.status(204).end();
}));

module.exports = router;
