const { projectRoleFor } = require('../utils/projectRole');

// Must run after requireProjectMember (needs req.project). Only the project's real
// Contractor or Owner can touch the Shared Ledger — an invited Engineer is a project
// member for Window 2 purposes but has no ledger role. Attaches req.myRole.
function requireLedgerParty(req, res, next) {
  const role = projectRoleFor(req.project, req.user.id);
  if (!role) return res.status(403).json({ error: 'Only this project\'s Contractor or Owner can use the Shared Ledger' });
  req.myRole = role;
  next();
}

module.exports = { requireLedgerParty };
