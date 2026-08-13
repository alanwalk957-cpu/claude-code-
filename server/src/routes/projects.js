const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { requireProjectMember } = require('../middleware/requireProjectMember');
const { requireLedgerParty } = require('../middleware/requireLedgerParty');
const { asyncHandler } = require('../utils/asyncHandler');
const { projectRoleFor } = require('../utils/projectRole');

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

router.get('/:projectId/activity', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const windowName = req.query.window === 'work_plan' ? 'work_plan' : 'ledger';
  const { rows } = await pool.query(
    `SELECT activity_log.*, users.company_name, users.email FROM activity_log
     LEFT JOIN users ON users.id = activity_log.actor_id
     WHERE project_id = $1 AND window_name = $2 ORDER BY created_at DESC LIMIT 500`,
    [req.params.projectId, windowName]
  );
  // actor label is the role they held on THIS project, not their raw account name — matches
  // the app's existing "Owner"/"Contractor" activity-log labeling.
  const withRoleLabel = rows.map(r => ({ ...r, actorRole: projectRoleFor(req.project, r.actor_id) }));
  res.json(withRoleLabel);
}));

router.patch('/:projectId/work-plan-start-date', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { date } = req.body || {};
  const { rows } = await pool.query(
    'UPDATE projects SET work_plan_start_date = $1 WHERE id = $2 RETURNING *',
    [date || null, req.params.projectId]
  );
  res.json(rows[0]);
}));

// Contractor-only: the markup percentage applied to the whole ledger.
router.patch('/:projectId/profit-percent', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  if (req.myRole !== 'Contractor') return res.status(403).json({ error: 'Only the Contractor can set the profit percentage' });
  const { percent } = req.body || {};
  const { rows } = await pool.query(
    'UPDATE projects SET contractor_profit_percent = $1 WHERE id = $2 RETURNING *',
    [percent, req.params.projectId]
  );
  res.json(rows[0]);
}));

// "Direct paid" figures — each side proposes its own out-of-pocket total; only the OTHER
// party can approve/reject it. Mirrors the app's existing bespoke triplet per side rather
// than the generic pending_actions table (see schema.sql comment on the projects table).
router.post('/:projectId/direct-paid', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { side, pendingValue } = req.body || {};
  if (!['contractor', 'owner'].includes(side)) return res.status(400).json({ error: 'side must be contractor or owner' });
  if (req.myRole.toLowerCase() !== side) return res.status(403).json({ error: `Only the ${side} can propose this` });

  const { rows } = await pool.query(
    `UPDATE projects SET ${side}_direct_paid_pending_val = $1, ${side}_direct_paid_status = 'Pending Approval' WHERE id = $2 RETURNING *`,
    [pendingValue, req.params.projectId]
  );
  res.json(rows[0]);
}));

router.post('/:projectId/direct-paid/resolve', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { side, approved } = req.body || {};
  if (!['contractor', 'owner'].includes(side)) return res.status(400).json({ error: 'side must be contractor or owner' });
  const resolverRole = side === 'contractor' ? 'Owner' : 'Contractor';
  if (req.myRole !== resolverRole) return res.status(403).json({ error: `Only the ${resolverRole} can resolve this` });

  const { rows: existingRows } = await pool.query('SELECT * FROM projects WHERE id = $1', [req.params.projectId]);
  const project = existingRows[0];
  const newAmount = approved ? project[`${side}_direct_paid_pending_val`] : project[`${side}_direct_paid_amount`];

  const { rows } = await pool.query(
    `UPDATE projects SET ${side}_direct_paid_amount = $1, ${side}_direct_paid_status = 'Approved', ${side}_direct_paid_pending_val = 0 WHERE id = $2 RETURNING *`,
    [newAmount, req.params.projectId]
  );
  res.json(rows[0]);
}));

module.exports = router;
