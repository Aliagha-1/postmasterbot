const { pool } = require('../db/postgres');

async function createPost(postData) {
  let publishTime = postData.publish_time;
  
  // اگر تاریخ به صورت string اومده، تبدیل به Date کن
  if (typeof publishTime === 'string') {
    publishTime = new Date(publishTime);
  }
  
  console.log('📝 Creating post:');
  console.log('   Publish time (raw):', publishTime);
  console.log('   Publish time (ISO):', publishTime.toISOString());
  
  const { rows } = await pool.query(
    `INSERT INTO posts (channel_id, text, media_url, media_type, publish_time, status) 
     VALUES ($1, $2, $3, $4, $5, 'pending') 
     RETURNING *`,
    [postData.channel_id, postData.text, postData.media_url, postData.media_type, publishTime]
  );
  
  console.log('   Saved post ID:', rows[0].id);
  return rows[0];
}

async function createMultiChannelPost(channelIds, postData) {
  const results = [];
  for (const channelId of channelIds) {
    const result = await createPost({ ...postData, channel_id: channelId });
    results.push(result);
  }
  return results;
}

async function getPendingPosts() {
  const { rows } = await pool.query(
    `SELECT p.*, c.channel_id, c.user_id 
     FROM posts p
     JOIN channels c ON p.channel_id = c.id
     WHERE p.status = 'pending' 
     AND p.publish_time <= NOW() AT TIME ZONE 'UTC'
     ORDER BY p.publish_time ASC
     LIMIT 10`
  );
  
  console.log(`📋 Found ${rows.length} pending posts`);
  return rows;
}

async function updatePostStatus(postId, status, errorMessage = null) {
  if (errorMessage) {
    await pool.query(
      `UPDATE posts SET status = $1, error_message = $2, retry_count = retry_count + 1 WHERE id = $3`,
      [status, errorMessage, postId]
    );
  } else {
    await pool.query(
      `UPDATE posts SET status = $1, sent_at = CASE WHEN $1 = 'sent' THEN NOW() ELSE sent_at END WHERE id = $2`,
      [status, postId]
    );
  }
}

async function getUserPosts(userId) {
  const { rows } = await pool.query(
    `SELECT p.*, c.channel_id as channel_identifier, c.channel_name 
     FROM posts p
     JOIN channels c ON p.channel_id = c.id
     WHERE c.user_id = $1
     ORDER BY p.publish_time DESC`,
    [userId]
  );
  return rows;
}

async function cancelPost(postId) {
  const { rows } = await pool.query(
    `DELETE FROM posts WHERE id = $1 AND status = 'pending' RETURNING *`,
    [postId]
  );
  return rows[0];
}

async function updatePostStats(postId, viewCount, reactionCount, messageId) {
  await pool.query(
    `UPDATE posts SET view_count = $1, reaction_count = $2, message_id = $3, sent_at = NOW() WHERE id = $4`,
    [viewCount, reactionCount, messageId, postId]
  );
}

async function getPostById(postId) {
  const { rows } = await pool.query(
    `SELECT p.*, c.channel_id, c.user_id 
     FROM posts p
     JOIN channels c ON p.channel_id = c.id
     WHERE p.id = $1`,
    [postId]
  );
  return rows[0];
}

module.exports = { 
  createPost, 
  createMultiChannelPost,
  getPendingPosts, 
  updatePostStatus, 
  getUserPosts, 
  cancelPost,
  updatePostStats,
  getPostById
};
