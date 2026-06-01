const { pool } = require('../db/postgres');
const { updateUserLicense } = require('./userService');

function generateLicenseKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const parts = [];
  for (let i = 0; i < 4; i++) {
    let part = '';
    for (let j = 0; j < 4; j++) {
      part += chars[Math.floor(Math.random() * chars.length)];
    }
    parts.push(part);
  }
  return parts.join('-');
}

async function createLicense(maxUsers, maxChannelsPerUser, createdBy) {
  const licenseKey = generateLicenseKey();
  
  const { rows } = await pool.query(
    `INSERT INTO licenses (license_key, max_users, max_channels_per_user, created_by) 
     VALUES ($1, $2, $3, $4) 
     RETURNING *`,
    [licenseKey, maxUsers, maxChannelsPerUser, createdBy]
  );
  
  return rows[0];
}

async function validateLicense(licenseKey, telegramId) {
  // بررسی وجود لایسنس
  const { rows: licenses } = await pool.query(
    'SELECT * FROM licenses WHERE license_key = $1 AND is_active = true',
    [licenseKey]
  );
  
  if (licenses.length === 0) return false;
  
  const license = licenses[0];
  
  // بررسی انقضا
  if (license.expires_at && new Date(license.expires_at) < new Date()) return false;
  
  // بررسی تعداد کاربران
  const { rows: users } = await pool.query(
    'SELECT COUNT(*) FROM users WHERE license_id = $1',
    [license.id]
  );
  
  if (parseInt(users[0].count) >= license.max_users) return false;
  
  // پیدا کردن کاربر
  const { rows: targetUser } = await pool.query(
    'SELECT id FROM users WHERE telegram_id = $1',
    [telegramId]
  );
  
  if (targetUser.length === 0) return false;
  
  // ثبت کاربر
  await updateUserLicense(targetUser[0].id, license.id);
  
  return true;
}

async function getLicenseInfo(licenseId) {
  const { rows } = await pool.query('SELECT * FROM licenses WHERE id = $1', [licenseId]);
  return rows[0];
}

async function addAdminToLicense(licenseKey, adminTelegramId) {
  const { rows: licenses } = await pool.query(
    'SELECT id FROM licenses WHERE license_key = $1',
    [licenseKey]
  );
  
  if (licenses.length === 0) return null;
  
  const license = licenses[0];
  
  const { rows: users } = await pool.query(
    'SELECT id FROM users WHERE telegram_id = $1',
    [adminTelegramId]
  );
  
  if (users.length === 0) return null;
  
  await pool.query(
    `INSERT INTO license_admins (license_id, user_id) 
     VALUES ($1, $2) 
     ON CONFLICT DO NOTHING`,
    [license.id, users[0].id]
  );
  
  return true;
}

async function getLicenseAdmins(licenseId) {
  const { rows } = await pool.query(
    `SELECT u.* FROM license_admins la 
     JOIN users u ON la.user_id = u.id 
     WHERE la.license_id = $1`,
    [licenseId]
  );
  return rows;
}

module.exports = {
  createLicense,
  validateLicense,
  getLicenseInfo,
  addAdminToLicense,
  getLicenseAdmins
};
