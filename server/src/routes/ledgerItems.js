const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireProjectMember } = require('../middleware/requireProjectMember');
const { requireLedgerParty } = require('../middleware/requireLedgerParty');
const { asyncHandler } = require('../utils/asyncHandler');
const { logActivity } = require('../utils/activityLog');

// Mounted at /api/projects/:projectId/ledger-items. Implements the app's existing
// mutual-approval pattern directly on each row (status/pending_action/pending_data/
// requester) plus the separate "Bought" sub-workflow (bought_status/bought_requested_by/
// bought_method/bought_by) — see the frontend's saveLedgerItem/resolveItemAction and
// confirmMarkBought/resolveBoughtAction for the behavior this mirrors.
const router = express.Router({ mergeParams: true });

const money = (v) => (v != null ? parseFloat(v) : null);

router.get('/', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM ledger_items WHERE project_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC',
    [req.params.projectId]
  );
  res.json(rows);
}));

router.get('/deleted', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM ledger_items WHERE project_id = $1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 20',
    [req.params.projectId]
  );
  res.json(rows);
}));

router.post('/', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { folderId, name, supplier, price, quantity, unit, paymentStatus, actualPayer, payer, dueDate, costCode, image, attachments, linkedFromRoom } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });

  const { rows } = await pool.query(
    `INSERT INTO ledger_items
      (project_id, folder_id, name, supplier, price, quantity, unit, payment_status, actual_payer, payer,
       due_date, cost_code, image, attachments, linked_from_room, creator, status, pending_action, requester)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'Pending Creation','create',$16)
     RETURNING *`,
    [req.params.projectId, folderId || 'all', name, supplier || null, money(price), money(quantity), unit || null,
     paymentStatus || null, actualPayer || null, payer || null, dueDate || null, costCode || null,
     image || null, JSON.stringify(attachments || []), !!linkedFromRoom, req.myRole]
  );
  const item = rows[0];
  await logActivity(req.params.projectId, req.user.id, 'ledger', 'Logged new entry',
    `"${item.name}" from ${item.supplier || 'unknown supplier'} — $${((money(price) || 0) * (money(quantity) || 0)).toFixed(2)}`);
  res.status(201).json(item);
}));

// Propose an edit — the live row is untouched; the staged fields sit in pending_data
// until the OTHER party approves (see POST /:id/resolve).
router.patch('/:id', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { rows: existingRows } = await pool.query('SELECT * FROM ledger_items WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]);
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'Item not found' });

  const pendingData = req.body || {};
  const { rows } = await pool.query(
    `UPDATE ledger_items SET status = 'Pending Edit', pending_action = 'edit', pending_data = $1, requester = $2
     WHERE id = $3 RETURNING *`,
    [JSON.stringify(pendingData), req.myRole, req.params.id]
  );
  await logActivity(req.params.projectId, req.user.id, 'ledger', 'Proposed edit', `"${existing.name}" — awaiting the other party's approval`);
  res.json(rows[0]);
}));

router.post('/:id/request-delete', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    "UPDATE ledger_items SET status = 'Pending Deletion', pending_action = 'delete', requester = $1 WHERE id = $2 AND project_id = $3 RETURNING *",
    [req.myRole, req.params.id, req.params.projectId]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Item not found' });
  res.json(rows[0]);
}));

router.post('/:id/move', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { folderId } = req.body || {};
  const { rows: existingRows } = await pool.query('SELECT * FROM ledger_items WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]);
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'Item not found' });

  const { rows } = await pool.query(
    "UPDATE ledger_items SET status = 'Pending Move', pending_action = 'move', pending_data = $1, requester = $2 WHERE id = $3 RETURNING *",
    [JSON.stringify({ folderId }), req.myRole, req.params.id]
  );
  await logActivity(req.params.projectId, req.user.id, 'ledger', 'Proposed move', `"${existing.name}" — awaiting the other party's approval`);
  res.json(rows[0]);
}));

// The single resolver for create/edit/delete/move — mirrors resolveItemAction exactly.
// Only the party who did NOT propose the pending action may resolve it.
router.post('/:id/resolve', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { approved } = req.body || {};
  const { rows: existingRows } = await pool.query('SELECT * FROM ledger_items WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]);
  const item = existingRows[0];
  if (!item || !item.pending_action) return res.status(404).json({ error: 'No pending action on this item' });
  if (item.requester === req.myRole) return res.status(403).json({ error: 'You proposed this change — the other party must resolve it' });

  const action = item.pending_action;
  let result;
  if (approved) {
    if (action === 'delete') {
      const { rows } = await pool.query(
        "UPDATE ledger_items SET status = 'Approved', pending_action = NULL, requester = NULL, deleted_at = now() WHERE id = $1 RETURNING *",
        [req.params.id]
      );
      result = rows[0];
    } else if (action === 'create') {
      const { rows } = await pool.query(
        "UPDATE ledger_items SET status = 'Approved', pending_action = NULL, requester = NULL WHERE id = $1 RETURNING *",
        [req.params.id]
      );
      result = rows[0];
    } else if (action === 'edit') {
      const d = item.pending_data || {};
      const { rows } = await pool.query(
        `UPDATE ledger_items SET
           folder_id = COALESCE($1, folder_id), name = COALESCE($2, name), supplier = COALESCE($3, supplier),
           price = COALESCE($4, price), quantity = COALESCE($5, quantity), unit = COALESCE($6, unit),
           payment_status = COALESCE($7, payment_status), actual_payer = COALESCE($8, actual_payer), payer = COALESCE($9, payer),
           due_date = COALESCE($10, due_date), cost_code = COALESCE($11, cost_code),
           image = COALESCE($12, image), attachments = COALESCE($13, attachments),
           status = 'Approved', pending_action = NULL, pending_data = NULL, requester = NULL
         WHERE id = $14 RETURNING *`,
        [d.folderId, d.name, d.supplier, money(d.price), money(d.quantity), d.unit, d.paymentStatus, d.actualPayer, d.payer,
         d.dueDate, d.costCode, d.image, d.attachments ? JSON.stringify(d.attachments) : null, req.params.id]
      );
      result = rows[0];
    } else if (action === 'move') {
      const d = item.pending_data || {};
      const { rows } = await pool.query(
        "UPDATE ledger_items SET folder_id = $1, status = 'Approved', pending_action = NULL, pending_data = NULL, requester = NULL WHERE id = $2 RETURNING *",
        [d.folderId, req.params.id]
      );
      result = rows[0];
    }
    await logActivity(req.params.projectId, req.user.id, 'ledger', `Approved ${action}`, `"${item.name}"`);
  } else {
    if (action === 'create') {
      await pool.query('DELETE FROM ledger_items WHERE id = $1', [req.params.id]);
      result = { id: item.id, deleted: true };
    } else {
      const { rows } = await pool.query(
        "UPDATE ledger_items SET status = 'Approved', pending_action = NULL, pending_data = NULL, requester = NULL WHERE id = $1 RETURNING *",
        [req.params.id]
      );
      result = rows[0];
    }
    await logActivity(req.params.projectId, req.user.id, 'ledger', `Rejected ${action}`, `"${item.name}"`);
  }
  res.json(result);
}));

router.post('/:id/restore', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { rows: existingRows } = await pool.query('SELECT * FROM ledger_items WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]);
  const item = existingRows[0];
  if (!item || !item.deleted_at) return res.status(404).json({ error: 'Deleted item not found' });

  let folderId = item.folder_id;
  if (folderId && folderId !== 'all') {
    const { rows: folderRows } = await pool.query('SELECT id FROM ledger_folders WHERE id = $1 AND project_id = $2', [folderId, req.params.projectId]);
    if (folderRows.length === 0) folderId = 'all';
  }

  const { rows } = await pool.query(
    'UPDATE ledger_items SET deleted_at = NULL, folder_id = $1 WHERE id = $2 RETURNING *',
    [folderId, req.params.id]
  );
  await logActivity(req.params.projectId, req.user.id, 'ledger', 'Restored deleted entry', `"${item.name}"`);
  res.json(rows[0]);
}));

router.post('/:id/mark-bought', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { method } = req.body || {};
  const { rows: existingRows } = await pool.query('SELECT * FROM ledger_items WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]);
  const item = existingRows[0];
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.bought_status && item.bought_status !== 'Not Bought') return res.status(400).json({ error: 'Already bought or pending' });

  const { rows } = await pool.query(
    "UPDATE ledger_items SET bought_status = 'Pending Bought', bought_requested_by = $1, bought_method = $2 WHERE id = $3 RETURNING *",
    [req.myRole, method, req.params.id]
  );
  await logActivity(req.params.projectId, req.user.id, 'ledger', 'Marked bought', `"${item.name}" as ${method} — awaiting approval`);
  res.json(rows[0]);
}));

router.post('/:id/resolve-bought', requireAuth, requireProjectMember('projectId'), requireLedgerParty, asyncHandler(async (req, res) => {
  const { approved } = req.body || {};
  const { rows: existingRows } = await pool.query('SELECT * FROM ledger_items WHERE id = $1 AND project_id = $2', [req.params.id, req.params.projectId]);
  const item = existingRows[0];
  if (!item || item.bought_status !== 'Pending Bought') return res.status(404).json({ error: 'No pending bought request on this item' });
  if (item.bought_requested_by === req.myRole) return res.status(403).json({ error: 'You proposed this — the other party must resolve it' });

  let rows;
  if (approved) {
    const paymentStatus = item.bought_method === 'Cash' ? 'Paid in Cash' : 'Debt';
    const boughtBy = item.bought_requested_by;
    ({ rows } = await pool.query(
      `UPDATE ledger_items SET bought_status = 'Bought', bought_by = $1, bought_requested_by = NULL,
         payment_status = $2, actual_payer = $1, payer = $1 WHERE id = $3 RETURNING *`,
      [boughtBy, paymentStatus, req.params.id]
    ));
    await logActivity(req.params.projectId, req.user.id, 'ledger', 'Approved bought', `"${item.name}" (${paymentStatus})`);
  } else {
    ({ rows } = await pool.query(
      "UPDATE ledger_items SET bought_status = 'Not Bought', bought_method = NULL, bought_requested_by = NULL WHERE id = $1 RETURNING *",
      [req.params.id]
    ));
    await logActivity(req.params.projectId, req.user.id, 'ledger', 'Rejected bought', `"${item.name}"`);
  }
  res.json(rows[0]);
}));

module.exports = router;
