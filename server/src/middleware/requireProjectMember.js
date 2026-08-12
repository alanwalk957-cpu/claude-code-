const { pool } = require('../db');

// Loads :projectId and 403s unless the authenticated user is that project's
// contractor, owner, or invited engineer. Attaches the project row to
// req.project so route handlers don't need to re-fetch it.
function requireProjectMember(paramName = 'projectId') {
  return async (req, res, next) => {
    const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [req.params[paramName]]);
    const project = rows[0];
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const isMember = [project.contractor_id, project.owner_id, project.engineer_id].includes(req.user.id);
    if (!isMember) return res.status(403).json({ error: 'Not a member of this project' });

    req.project = project;
    next();
  };
}

module.exports = { requireProjectMember };
