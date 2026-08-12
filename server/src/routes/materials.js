const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();

// Any authenticated account (any role) can browse the global catalog.
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM materials ORDER BY created_at DESC');
  res.json(rows);
}));

router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM materials WHERE id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Material not found' });
  res.json(rows[0]);
}));

// Only suppliers can post materials into the catalog.
router.post('/', requireAuth, requireRole('supplier'), asyncHandler(async (req, res) => {
  const {
    folderId, name, code, price, unitType, dimUnit, perUnit,
    length, width, height, weight, measureBy, bulkDensity, concreteRole,
    description, images
  } = req.body || {};

  if (!name) return res.status(400).json({ error: 'name is required' });

  const { rows } = await pool.query(
    `INSERT INTO materials
      (folder_id, name, code, price, unit_type, dim_unit, per_unit,
       length, width, height, weight, measure_by, bulk_density, concrete_role,
       description, images, creator_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [folderId || null, name, code || null, price || null, unitType || null, dimUnit || null, perUnit || null,
     length || null, width || null, height || null, weight || null, measureBy || null, bulkDensity || null, concreteRole || null,
     description || null, JSON.stringify(images || []), req.user.id]
  );
  res.status(201).json(rows[0]);
}));

router.patch('/:id', requireAuth, requireRole('supplier'), asyncHandler(async (req, res) => {
  const { rows: existingRows } = await pool.query('SELECT * FROM materials WHERE id = $1', [req.params.id]);
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'Material not found' });
  if (existing.creator_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only edit materials you created' });
  }

  const fields = [
    'folderId', 'name', 'code', 'price', 'unitType', 'dimUnit', 'perUnit',
    'length', 'width', 'height', 'weight', 'measureBy', 'bulkDensity', 'concreteRole',
    'description', 'images'
  ];
  const columnFor = {
    folderId: 'folder_id', unitType: 'unit_type', dimUnit: 'dim_unit', perUnit: 'per_unit',
    measureBy: 'measure_by', bulkDensity: 'bulk_density', concreteRole: 'concrete_role'
  };

  const updates = [];
  const values = [];
  fields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
      const column = columnFor[field] || field;
      values.push(field === 'images' ? JSON.stringify(req.body[field]) : req.body[field]);
      updates.push(`${column} = $${values.length}`);
    }
  });
  if (updates.length === 0) return res.json(existing);

  values.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE materials SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  res.json(rows[0]);
}));

router.delete('/:id', requireAuth, requireRole('supplier'), asyncHandler(async (req, res) => {
  const { rows: existingRows } = await pool.query('SELECT creator_id FROM materials WHERE id = $1', [req.params.id]);
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'Material not found' });
  if (existing.creator_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only delete materials you created' });
  }
  await pool.query('DELETE FROM materials WHERE id = $1', [req.params.id]);
  res.status(204).end();
}));

module.exports = router;
