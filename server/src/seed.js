require('dotenv').config();

const { pool } = require('./db');
const { hashPassword } = require('./utils/password');

const TEST_USERS = [
  { email: 'supplier@test.local', role: 'supplier', companyName: 'Test Supplier Co' },
  { email: 'engineer@test.local', role: 'engineer', companyName: null },
  { email: 'contractor@test.local', role: 'contractor', companyName: 'Test Contractor LLC' },
  { email: 'owner@test.local', role: 'owner', companyName: null }
];
const TEST_PASSWORD = 'password123';

async function seed() {
  for (const u of TEST_USERS) {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [u.email]);
    if (existing.rows.length > 0) {
      console.log(`Skipping ${u.email} — already exists`);
      continue;
    }
    const passwordHash = await hashPassword(TEST_PASSWORD);
    await pool.query(
      `INSERT INTO users (email, password_hash, role, company_name) VALUES ($1, $2, $3, $4)`,
      [u.email, passwordHash, u.role, u.companyName]
    );
    console.log(`Created ${u.role}: ${u.email} / ${TEST_PASSWORD}`);
  }
  await pool.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
