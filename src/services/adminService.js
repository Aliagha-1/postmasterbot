const { pool } = require('../db/postgres');

async function getSetting(key) {
  const { rows } = await pool.query(
    'SELECT value FROM settings WHERE key = $1',
    [key]
  );
  return rows[0]?.value || '🔑 لطفاً لایسنس خود را وارد کنید.';
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) 
     VALUES ($1, $2, NOW()) 
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, value]
  );
}

async function getSystemStats() {
  const { rows: userStats } = await pool.query(
    `SELECT 
       COUNT(*) as total_users,
       COUNT(CASE WHEN is_active THEN 1 END) as approved_users
     FROM users`
  );
  
  const { rows: postStats } = await pool.query(
    `SELECT 
       COUNT(*) as total_posts,
       COUNT(CASE WHEN status = 'sent' THEN 1 END) as sent_posts,
       COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_posts
     FROM posts`
  );
  
  const { rows: channelStats } = await pool.query(
    'SELECT COUNT(*) as total_channels FROM channels'
  );
  
  return {
    users: {
      total_users: parseInt(userStats[0]?.total_users || 0),
      approved_users: parseInt(userStats[0]?.approved_users || 0),
      pending_users: parseInt(userStats[0]?.total_users || 0) - parseInt(userStats[0]?.approved_users || 0)
    },
    posts: {
      total_posts: parseInt(postStats[0]?.total_posts || 0),
      sent_posts: parseInt(postStats[0]?.sent_posts || 0),
      failed_posts: parseInt(postStats[0]?.failed_posts || 0)
    },
    channels: {
      total_channels: parseInt(channelStats[0]?.total_channels || 0)
    }
  };
}

async function sendMessageToUser(telegramId, message, bot) {
  try {
    await bot.telegram.sendMessage(telegramId, message, { parse_mode: 'HTML' });
    return true;
  } catch (error) {
    console.error('Error sending message:', error.message);
    return false;
  }
}

async function getAllApprovedUsers() {
  const { rows } = await pool.query(
    'SELECT id, telegram_id FROM users WHERE is_active = true'
  );
  return rows;
}

module.exports = {
  getSetting,
  setSetting,
  getSystemStats,
  sendMessageToUser,
  getAllApprovedUsers
};
