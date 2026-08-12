const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { hashPassword, comparePassword } = require('../utils/password');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();
const ROLES = ['supplier', 'engineer', 'contractor', 'owner'];
const COOKIE_NAME = () => process.env.COOKIE_NAME || 'mmp_token';

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME(), token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
}

router.post('/signup', asyncHandler(async (req, res) => {
  const { email, password, role, companyName } = req.body || {};
  if (!email || !password || !role) {
    return res.status(400).json({ error: 'email, password, and role are required' });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of ${ROLES.join(', ')}` });
  }

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const passwordHash = await hashPassword(password);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, role, company_name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, role, company_name`,
    [email, passwordHash, role, companyName || null]
  );
  const user = rows[0];
  setAuthCookie(res, signToken(user));
  res.status(201).json({ id: user.id, email: user.email, role: user.role, companyName: user.company_name });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user || !(await comparePassword(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  setAuthCookie(res, signToken(user));
  res.json({ id: user.id, email: user.email, role: user.role, companyName: user.company_name });
}));

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME());
  res.status(204).end();
});

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, email, role, company_name FROM users WHERE id = $1',
    [req.user.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
  const user = rows[0];
  res.json({ id: user.id, email: user.email, role: user.role, companyName: user.company_name });
}));

router.patch('/me', requireAuth, asyncHandler(async (req, res) => {
  const { companyName } = req.body || {};
  const { rows } = await pool.query(
    'UPDATE users SET company_name = $1 WHERE id = $2 RETURNING id, email, role, company_name',
    [companyName || null, req.user.id]
  );
  const user = rows[0];
  res.json({ id: user.id, email: user.email, role: user.role, companyName: user.company_name });
}));

module.exports = router;
