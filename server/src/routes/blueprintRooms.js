const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireProjectMember } = require('../middleware/requireProjectMember');
const { asyncHandler } = require('../utils/asyncHandler');

// Mounted at /api/projects/:projectId/rooms — every route here already ran
// through requireProjectMember, so req.project is available if needed.
const router = express.Router({ mergeParams: true });

router.get('/', requireAuth, requireProjectMember('projectId'), asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM blueprint_rooms WHERE project_id = $1 ORDER BY id', [req.params.projectId]);
  res.json(rows);
}));

router.post('/', requireAuth, requireProjectMember('projectId'), asyncHandler(async (req, res) => {
  const { name, length, width, height, group, extra } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });

  const { rows } = await pool.query(
    `INSERT INTO blueprint_rooms (project_id, name, length, width, height, group_name, extra)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.params.projectId, name, length || null, width || null, height || null, group || null, JSON.stringify(extra || {})]
  );
  res.status(201).json(rows[0]);
}));

router.patch('/:id', requireAuth, requireProjectMember('projectId'), asyncHandler(async (req, res) => {
  const { rows: existingRows } = await pool.query(
    'SELECT * FROM blueprint_rooms WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]
  );
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'Room not found' });

  const fields = ['name', 'length', 'width', 'height', 'group', 'extra'];
  const columnFor = { group: 'group_name' };
  const updates = [];
  const values = [];
  fields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
      const column = columnFor[field] || field;
      // `extra` is a full replace, not a merge — the frontend always sends the
      // complete object it wants stored (mirroring how it already treats
      // room.geom/mix fields as plain properties on the in-memory room object).
      values.push(field === 'extra' ? JSON.stringify(req.body[field]) : req.body[field]);
      updates.push(`${column} = $${values.length}`);
    }
  });
  if (updates.length === 0) return res.json(existing);

  values.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE blueprint_rooms SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  res.json(rows[0]);
}));

router.delete('/:id', requireAuth, requireProjectMember('projectId'), asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query(
    'DELETE FROM blueprint_rooms WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'Room not found' });
  res.status(204).end();
}));

module.exports = router;
