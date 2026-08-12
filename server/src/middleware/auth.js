const jwt = require('jsonwebtoken');

// Verifies the JWT stored in the httpOnly cookie set at login and attaches
// { id, role } to req.user. Rejects with 401 if missing/invalid — every
// route under /api except /api/auth/signup and /api/auth/login goes through this.
function requireAuth(req, res, next) {
  const cookieName = process.env.COOKIE_NAME || 'mmp_token';
  const token = req.cookies && req.cookies[cookieName];
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

module.exports = { requireAuth };
