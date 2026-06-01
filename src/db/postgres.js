const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }  // برای Neon
});

pool.on('error', (err) => {
  console.error('❌ خطای غیرمنتظره دیتابیس:', err);
});

// تست اتصال
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ اتصال به دیتابیس失敗:', err.message);
  } else {
    console.log('✅ اتصال به دیتابیس برقرار شد در:', res.rows[0].now);
  }
});

module.exports = { pool };