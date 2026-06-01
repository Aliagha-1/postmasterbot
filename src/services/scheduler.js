const cron = require('node-cron');

function start(bot, pool) {
  cron.schedule('* * * * *', async () => {
    try {
      const { rows: posts } = await pool.query(`
        SELECT p.*, c.channel_id, c.user_id 
        FROM posts p 
        JOIN channels c ON p.channel_id = c.id 
        WHERE p.status = 'pending' AND p.publish_time <= NOW()
        ORDER BY p.publish_time LIMIT 10
      `);

      for (const post of posts) {
        try {
          let ch = post.channel_id;
          if (!ch.startsWith('@')) ch = '@' + ch;

          // چک دوباره ادمین بودن
          try {
            const botId = (await bot.telegram.getMe()).id;
            const chatMember = await bot.telegram.getChatMember(ch, botId);
            if (!['administrator', 'creator'].includes(chatMember.status)) {
              throw new Error('BOT_NOT_ADMIN');
            }
          } catch (adminErr) {
            // ثبت خطا برای کاربر
            await pool.query(
              `INSERT INTO notifications (user_id, post_text, channel_id, publish_time, type, error_message) VALUES ($1,$2,$3,$4,'error',$5)`,
              [post.user_id, post.text?.substring(0, 200), post.channel_id, new Date(), 'ربات در کانال ادمین نیست!']
            );
            await pool.query("UPDATE posts SET status='failed' WHERE id=$1", [post.id]);
            console.log(`⚠️ Bot not admin in ${ch} - post #${post.id} failed`);
            continue;
          }

          if (post.media_url && post.media_type === 'photo') {
            await bot.telegram.sendPhoto(ch, post.media_url, { caption: post.text || '' });
          } else if (post.media_url && post.media_type === 'video') {
            await bot.telegram.sendVideo(ch, post.media_url, { caption: post.text || '' });
          } else if (post.text) {
            await bot.telegram.sendMessage(ch, post.text);
          } else continue;

          // ثبت موفقیت
          await pool.query(
            `INSERT INTO notifications (user_id, post_text, channel_id, publish_time, type) VALUES ($1,$2,$3,$4,'success')`,
            [post.user_id, post.text?.substring(0, 200), post.channel_id, new Date()]
          );
          await pool.query('DELETE FROM posts WHERE id = $1', [post.id]);
          console.log(`✅ Post #${post.id} sent to ${ch}`);

        } catch (err) {
          console.error(`❌ Post #${post.id} failed:`, err.message);
          // ثبت خطا
          await pool.query(
            `INSERT INTO notifications (user_id, post_text, channel_id, publish_time, type, error_message) VALUES ($1,$2,$3,$4,'error',$5)`,
            [post.user_id, post.text?.substring(0, 200), post.channel_id, new Date(), err.message]
          );
          await pool.query("UPDATE posts SET status='failed' WHERE id=$1", [post.id]);
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (err) {
      console.error('❌ Scheduler error:', err.message);
    }
  });
}

module.exports = { start };
