// Derives which role the current user actually holds on this project — 'Contractor',
// 'Owner', or null (includes an invited Engineer, who has no ledger role). This replaces
// the old frontend "click a button to become Owner/Contractor" toggle: the role is now
// looked up from real project membership, so nobody can act as a party they aren't.
function projectRoleFor(project, userId) {
  if (project.contractor_id === userId) return 'Contractor';
  if (project.owner_id === userId) return 'Owner';
  return null;
}

module.exports = { projectRoleFor };
