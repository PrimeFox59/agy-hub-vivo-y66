const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'primeprojectx_agy_secret_key_2026_super_secure_99';
const JWT_EXPIRES = '7d';

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function comparePassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, full_name: user.full_name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

function requireAuth(req, res, next) {
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.cookies && req.cookies.agy_token) {
    token = req.cookies.agy_token;
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: Token tidak ditemukan' });
  }

  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Unauthorized: Token tidak valid atau kedaluwarsa' });
  }

  // Check if user still exists in db
  const user = db.prepare('SELECT id, username, full_name, role, telegram_chat_id, telegram_username, telegram_notifications FROM users WHERE id = ?').get(payload.id);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized: User tidak ditemukan' });
  }

  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden: Hanya admin yang diizinkan' });
  }
  next();
}

function logAudit(userId, username, action, details, ipAddress = '') {
  try {
    db.prepare(`
      INSERT INTO audit_logs (user_id, username, action, details, ip_address)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId || null, username || 'anonymous', action, details || '', ipAddress || '');
  } catch (e) {
    console.error('Audit log error:', e);
  }
}

module.exports = {
  hashPassword,
  comparePassword,
  generateToken,
  verifyToken,
  requireAuth,
  requireAdmin,
  logAudit
};
