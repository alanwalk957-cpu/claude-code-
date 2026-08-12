const { pool } = require('../db');

// Server-side logging (not client-driven) so the audit trail can't be forged by a client
// sending arbitrary log entries — every route handler that mutates ledger data calls this
// itself after the mutation succeeds.
async function logActivity(projectId, actorId, windowName, action, detail) {
  await pool.query(
    'INSERT INTO activity_log (project_id, actor_id, window_name, action, detail) VALUES ($1,$2,$3,$4,$5)',
    [projectId, actorId, windowName, action, detail || '']
  );
}

module.exports = { logActivity };
