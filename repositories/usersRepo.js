const bcrypt = require('bcryptjs');
const { query } = require('../config/database');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    name: row.full_name || row.name || '',
    full_name: row.full_name || row.name || '',
    email: row.email || '',
    phone: row.phone || '',
    address: row.address || '',
    password: row.password_hash || '',
    role: row.role || 'user',
    provider: row.provider || 'web',
    emailVerified: !!row.email_verified,
    status: row.status || 'active',
    googleId: row.google_id || '',
    lineId: row.line_id || '',
    createdAt: row.created_at
  };
}

async function findById(id) {
  const result = await query(`SELECT * FROM users WHERE id = $1 LIMIT 1`, [id]);
  return mapUser(result.rows[0]);
}
async function findByEmail(email) {
  const safeEmail = normalizeEmail(email);
  if (!safeEmail) return null;
  const result = await query(`SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1`, [safeEmail]);
  return mapUser(result.rows[0]);
}
async function findByGoogleId(googleId) {
  const result = await query(`SELECT * FROM users WHERE google_id = $1 LIMIT 1`, [String(googleId || '')]);
  return mapUser(result.rows[0]);
}
async function createUser(payload) {
  const passwordHash = payload.password ? await bcrypt.hash(String(payload.password), 10) : '';
  const result = await query(
    `INSERT INTO users (first_name, last_name, full_name, email, phone, address, password_hash, role, provider, email_verified, status, google_id, line_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      payload.firstName || '',
      payload.lastName || '',
      payload.name || [payload.firstName, payload.lastName].filter(Boolean).join(' '),
      normalizeEmail(payload.email),
      payload.phone || '',
      payload.address || '',
      passwordHash,
      payload.role || 'user',
      payload.provider || 'web',
      !!payload.emailVerified,
      payload.status || 'active',
      payload.googleId || '',
      payload.lineId || ''
    ]
  );
  return mapUser(result.rows[0]);
}

module.exports = { normalizeEmail, findById, findByEmail, findByGoogleId, createUser };
