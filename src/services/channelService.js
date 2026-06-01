const { pool } = require('../db/postgres');

async function addChannel(userId, channelId) {
  // حذف @ از اول اگر داشت
  let cleanChannelId = channelId;
  if (cleanChannelId.startsWith('@')) {
    cleanChannelId = cleanChannelId.substring(1);
  }
  
  // حذف https://t.me/ اگر داشت
  if (cleanChannelId.startsWith('https://t.me/')) {
    cleanChannelId = cleanChannelId.replace('https://t.me/', '');
  }
  
  // بررسی تکراری نبودن
  const { rows: existing } = await pool.query(
    'SELECT id FROM channels WHERE user_id = $1 AND channel_id = $2',
    [userId, cleanChannelId]
  );
  
  if (existing.length > 0) {
    throw new Error('این کانال قبلاً اضافه شده است');
  }
  
  const { rows } = await pool.query(
    `INSERT INTO channels (user_id, channel_id, channel_name) 
     VALUES ($1, $2, $3) 
     RETURNING *`,
    [userId, cleanChannelId, cleanChannelId]
  );
  
  return rows[0];
}

async function getUserChannels(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM channels WHERE user_id = $1 ORDER BY id DESC',
    [userId]
  );
  return rows;
}

async function getChannelById(channelId) {
  const { rows } = await pool.query(
    'SELECT * FROM channels WHERE id = $1',
    [channelId]
  );
  return rows[0];
}

async function deleteChannel(channelId) {
  await pool.query('DELETE FROM channels WHERE id = $1', [channelId]);
}

async function getChannelByTelegramId(userId, telegramChannelId) {
  let cleanId = telegramChannelId;
  if (cleanId.startsWith('@')) cleanId = cleanId.substring(1);
  if (cleanId.startsWith('https://t.me/')) cleanId = cleanId.replace('https://t.me/', '');
  
  const { rows } = await pool.query(
    'SELECT * FROM channels WHERE user_id = $1 AND channel_id = $2',
    [userId, cleanId]
  );
  return rows[0];
}

async function getAllChannels() {
  const { rows } = await pool.query(
    'SELECT c.*, u.telegram_id, u.username, u.first_name FROM channels c JOIN users u ON c.user_id = u.id'
  );
  return rows;
}

module.exports = { 
  addChannel, 
  getUserChannels, 
  getChannelById, 
  deleteChannel,
  getChannelByTelegramId,
  getAllChannels
};
