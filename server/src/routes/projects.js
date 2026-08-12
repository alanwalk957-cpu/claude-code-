const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { requireProjectMember } = require('../middleware/requireProjectMember');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();
const OPPOSITE_ROLE = { contractor: 'owner', owner: 'contractor' };

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM projects WHERE contractor_id = $1 OR owner_id = $1 OR engineer_id = $1 ORDER BY created_at DESC',
    [req.user.id]
  );
  res.json(rows);
}));

// Only a Contractor or Owner can start a project — the other party is
// identified by email and must already have an account with the opposite role.
router.post('/', requireAuth, requireRole('contractor', 'owner'), asyncHandler(async (req, res) => {
  const { name, partnerEmail } = req.body || {};
  if (!name || !partnerEmail) return res.status(400).json({ error: 'name and partnerEmail are required' });

  const expectedRole = OPPOSITE_ROLE[req.user.role];
  const { rows } = await pool.query('SELECT id, role FROM users WHERE email = $1', [partnerEmail]);
  const partner = rows[0];
  if (!partner) return res.status(400).json({ error: `No account found for ${partnerEmail}` });
  if (partner.role !== expectedRole) {
    return res.status(400).json({ error: `${partnerEmail} is not registered as a ${expectedRole}` });
  }

  const contractorId = req.user.role === 'contractor' ? req.user.id : partner.id;
  const ownerId = req.user.role === 'owner' ? req.user.id : partner.id;
  const { rows: created } = await pool.query(
    'INSERT INTO projects (name, contractor_id, owner_id) VALUES ($1, $2, $3) RETURNING *',
    [name, contractorId, ownerId]
  );
  res.status(201).json(created[0]);
}));

router.patch('/:projectId/engineer', requireAuth, requireProjectMember('projectId'), requireRole('contractor', 'owner'), asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email is required' });

  const { rows } = await pool.query('SELECT id, role FROM users WHERE email = $1', [email]);
  const engineer = rows[0];
  if (!engineer) return res.status(400).json({ error: `No account found for ${email}` });
  if (engineer.role !== 'engineer') return res.status(400).json({ error: `${email} is not registered as an engineer` });

  const { rows: updated } = await pool.query(
    'UPDATE projects SET engineer_id = $1 WHERE id = $2 RETURNING *',
    [engineer.id, req.params.projectId]
  );
  res.json(updated[0]);
}));

module.exports = router;
