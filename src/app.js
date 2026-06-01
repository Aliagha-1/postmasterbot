require('dotenv').config();
const { Telegraf, session, Markup } = require('telegraf');
const express = require('express');
const { pool } = require('./db/postgres');
const scheduler = require('./services/scheduler');

const bot = new Telegraf(process.env.BOT_TOKEN);
const MASTER_ADMIN_ID = 6645336839;
const KABUL_OFFSET = 4.5 * 60 * 60 * 1000; // +4:30 افغانستان

// ════════════════════════════════════════════════════════════════
// MIDDLEWARE
// ════════════════════════════════════════════════════════════════

bot.use(session());

bot.use(async (ctx, next) => {
  if (!ctx.session) {
    ctx.session = {
      step: null,
      postData: {
        channel_ids: [],
        text: null,
        media_url: null,
        media_type: 'none',
        repeat: false,
        times: []
      },
      selectedChannels: [],
      tempMonth: null,
      tempDay: null,
      tempHour: null,
      tempMinute: null,
      channels: [],
      newLicense: {},
      editPostId: null,
      editHelpId: null,
      editLicenseId: null,
      editUserId: null,
      broadcastMsg: null,
      notificationsShown: false,
      lastActivity: Date.now(),
      confirmAction: null
    };
  }
  ctx.session.lastActivity = Date.now();
  return next();
});

/**
 * MIDDLEWARE: نمایش نوتیفیکیشن‌ها
 * فقط در چت خصوصی با ربات، نه در کانال‌ها!
 */
bot.use(async (ctx, next) => {
  // فقط در پیام خصوصی (chat type = private)
  if (ctx.chat?.type === 'private' && ctx.from && !ctx.session?.notificationsShown) {
    try {
      const { rows: [user] } = await pool.query(
        'SELECT id FROM users WHERE telegram_id = $1',
        [ctx.from.id]
      );
      if (user) {
        ctx.session.notificationsShown = true;
        await showAllNotificationsInPrivateChat(ctx, user.id);
      }
    } catch (e) {
      console.error('Notification middleware error:', e.message);
    }
  }
  return next();
});

// خطایابی سراسری
bot.catch(async (err, ctx) => {
  console.error('❌ Global Error:', err.message);
  // فقط در چت خصوصی پاسخ بده
  if (ctx.chat?.type === 'private') {
    try {
      await ctx.answerCbQuery('⚠️ خطایی رخ داد! لطفاً دوباره تلاش کنید.').catch(() => {});
    } catch {}
  }
});

// ════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ════════════════════════════════════════════════════════════════

/**
 * پاکسازی آیدی کانال از کاراکترهای اضافی
 * @param {string} input - آیدی وارد شده توسط کاربر
 * @returns {string} آیدی پاکسازی شده
 */
function cleanChannelId(input) {
  if (!input) return '';
  let c = input.trim();
  if (c.includes('t.me/')) c = c.split('t.me/')[1];
  if (c.startsWith('@')) c = c.substring(1);
  return c.replace(/[/?#].*$/, '');
}

/**
 * بررسی ادمین بودن ربات در کانال
 * @param {string} channelInput - آیدی کانال
 * @returns {Promise<boolean>} آیا ربات ادمین است؟
 */
async function checkBotInChannel(channelInput) {
  try {
    const clean = cleanChannelId(channelInput);
    const botId = (await bot.telegram.getMe()).id;
    const m = await bot.telegram.getChatMember(`@${clean}`, botId);
    return ['administrator', 'creator'].includes(m.status);
  } catch {
    return false;
  }
}

/**
 * دریافت کاربر با telegram_id
 * @param {number} telegramId
 * @returns {Promise<Object|null>}
 */
async function getUserByTelegramId(telegramId) {
  const { rows } = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
  return rows[0] || null;
}

/**
 * دریافت کاربر با id دیتابیس
 * @param {number} id
 * @returns {Promise<Object|null>}
 */
async function getUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

/**
 * ایجاد یا دریافت کاربر
 * فقط در چت خصوصی کاربر ایجاد میشود
 * @param {number} telegramId
 * @param {string} username
 * @param {string} firstName
 * @returns {Promise<Object>}
 */
async function createOrGetUser(telegramId, username, firstName) {
  let user = await getUserByTelegramId(telegramId);
  
  if (user) {
    // بروزرسانی اطلاعات
    if (username || firstName) {
      await pool.query(
        'UPDATE users SET username = COALESCE($1, username), first_name = COALESCE($2, first_name) WHERE telegram_id = $3',
        [username, firstName, telegramId]
      );
      user = await getUserByTelegramId(telegramId);
    }
    return user;
  }
  
  // کاربر جدید
  const role = (telegramId === MASTER_ADMIN_ID) ? 'master_admin' : 'user';
  const isActive = (telegramId === MASTER_ADMIN_ID);
  const licenseId = (telegramId === MASTER_ADMIN_ID) ? 1 : null;
  
  const { rows: newUser } = await pool.query(
    `INSERT INTO users (telegram_id, username, first_name, role, is_active, license_id) 
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [telegramId, username, firstName, role, isActive, licenseId]
  );
  
  return newUser[0];
}

/**
 * بررسی ادمین اصلی بودن
 * @param {Object} ctx - context تلگرام
 * @returns {Promise<boolean>}
 */
async function isMasterAdmin(ctx) {
  const user = await getUserByTelegramId(ctx.from.id);
  return user && user.role === 'master_admin' && !user.test_mode;
}

/**
 * بررسی دسترسی به امکانات ربات
 * @param {Object} ctx
 * @returns {Promise<boolean>}
 */
async function hasAccess(ctx) {
  const user = await getUserByTelegramId(ctx.from.id);
  if (!user) return false;
  // ادمین اصلی همیشه دسترسی دارد
  if (user.role === 'master_admin' && !user.test_mode) return true;
  // در حالت تست مثل کاربر عادی رفتار کن
  if (user.test_mode) return user.is_active;
  // کاربر عادی با لایسنس فعال
  return user.is_active;
}

/**
 * تبدیل تاریخ کابل به UTC برای ذخیره در دیتابیس
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @returns {number} timestamp UTC
 */
function kabulToUTC(year, month, day, hour, minute) {
  return Date.UTC(year, month, day, hour, minute) - KABUL_OFFSET;
}

/**
 * فرمت تاریخ UTC به صورت readable کابل
 * @param {Date|string|number} utc
 * @returns {string}
 */
function formatKabulDate(utc) {
  if (!utc) return 'نامشخص';
  const d = new Date(new Date(utc).getTime() + KABUL_OFFSET);
  const persianMonths = [
    'حمل', 'ثور', 'جوزا', 'سرطان', 'اسد', 'سنبله',
    'میزان', 'عقرب', 'قوس', 'جدی', 'دلو', 'حوت'
  ];
  const year = d.getFullYear();
  const month = persianMonths[d.getMonth()];
  const day = d.getDate();
  const hour = String(d.getHours()).padStart(2, '0');
  const minute = String(d.getMinutes()).padStart(2, '0');
  return `${year}/${month}/${day} ${hour}:${minute}`;
}

/**
 * محاسبه زمان باقی‌مانده
 * @param {number} utc
 * @returns {string}
 */
function timeRemaining(utc) {
  const diff = utc - Date.now();
  if (diff <= 0) return 'همین الان';
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  if (days > 0) return `${days} روز و ${hours} ساعت`;
  if (hours > 0) return `${hours} ساعت و ${minutes} دقیقه`;
  return `${minutes} دقیقه`;
}

/**
 * بررسی private chat بودن
 * @param {Object} ctx
 * @returns {boolean}
 */
function isPrivateChat(ctx) {
  return ctx.chat?.type === 'private';
}

/**
 * نمایش نوتیفیکیشن‌ها فقط در چت خصوصی
 * @param {Object} ctx
 * @param {number} userId
 */
async function showAllNotificationsInPrivateChat(ctx, userId) {
  // اطمینان از اینکه در چت خصوصی هستیم
  if (!isPrivateChat(ctx)) return;
  
  // پاک کردن نوتیفیکیشن‌های قدیمی (بیش از ۷ روز)
  await pool.query(
    "DELETE FROM notifications WHERE user_id = $1 AND created_at < NOW() - INTERVAL '7 days'",
    [userId]
  );
  
  // نمایش ارسال‌های موفق
  const { rows: successNotifs } = await pool.query(
    "SELECT * FROM notifications WHERE user_id = $1 AND type = 'success' ORDER BY created_at DESC LIMIT 5",
    [userId]
  );
  
  if (successNotifs.length) {
    let msg = `📬 **گزارش ارسال‌های موفق** (${successNotifs.length} مورد)\n\n`;
    for (const n of successNotifs) {
      msg += `✅ کانال: @${n.channel_id}\n`;
      msg += `📝 متن: ${n.post_text?.substring(0, 60) || 'بدون متن'}\n`;
      msg += `📅 تاریخ: ${formatKabulDate(n.publish_time)}\n\n`;
    }
    // فقط در چت خصوصی ارسال کن
    await ctx.reply(msg);
    await pool.query("DELETE FROM notifications WHERE user_id = $1 AND type = 'success'", [userId]);
  }
  
  // نمایش خطاها
  const { rows: errorNotifs } = await pool.query(
    "SELECT * FROM notifications WHERE user_id = $1 AND type = 'error' ORDER BY created_at DESC LIMIT 5",
    [userId]
  );
  
  if (errorNotifs.length) {
    let errMsg = `⚠️ **مشکلات ارسال** (${errorNotifs.length} مورد)\n\n`;
    for (const e of errorNotifs) {
      errMsg += `❌ کانال: @${e.channel_id}\n`;
      errMsg += `📝 متن: ${e.post_text?.substring(0, 50)}\n`;
      errMsg += `🔴 علت: ${e.error_message || 'خطای نامشخص'}\n\n`;
    }
    await ctx.reply(errMsg);
    await pool.query("DELETE FROM notifications WHERE user_id = $1 AND type = 'error'", [userId]);
  }
}

// ════════════════════════════════════════════════════════════════
// KEYBOARDS
// ════════════════════════════════════════════════════════════════

/** کیبورد کاربر عادی با لایسنس فعال */
const userKeyboard = Markup.keyboard([
  ['📢 افزودن کانال', '📋 کانال‌ها'],
  ['✏️ پست جدید', '📨 پست چند کاناله'],
  ['📝 پست‌ها', '❓ راهنما']
]).resize();

/** کیبورد ادمین اصلی */
const adminKeyboard = Markup.keyboard([
  ['👑 پنل مدیریت', '🔑 لایسنس‌ها'],
  ['🧪 حالت تست', '👥 کاربران', '📊 گزارشات'],
  ['⚙️ تنظیمات', '❓ راهنما']
]).resize();

/** کیبورد کاربر بدون لایسنس */
const licenseKeyboard = Markup.keyboard([
  ['🔑 فعالسازی لایسنس'],
  ['❓ راهنما']
]).resize();

/** کیبورد حالت تست */
const testKeyboard = Markup.keyboard([
  ['📢 افزودن کانال', '📋 کانال‌ها'],
  ['✏️ پست جدید', '📨 پست چند کاناله'],
  ['📝 پست‌ها', '❌ خروج از تست'],
  ['❓ راهنما']
]).resize();

/**
 * تشخیص کیبورد مناسب بر اساس وضعیت کاربر
 * @param {Object} user - اطلاعات کاربر از دیتابیس
 * @returns {Object} Markup.keyboard
 */
function getKeyboard(user) {
  if (!user) return licenseKeyboard;
  if (user.test_mode) return testKeyboard;
  if (!user.is_active && user.role !== 'master_admin') return licenseKeyboard;
  if (user.role === 'master_admin') return adminKeyboard;
  return userKeyboard;
}

// ════════════════════════════════════════════════════════════════
// HELP SYSTEM
// ════════════════════════════════════════════════════════════════

/**
 * دریافت همه دکمه‌های فعال راهنما
 * @returns {Promise<Array>}
 */
async function getHelpButtonsData() {
  const { rows } = await pool.query(
    'SELECT * FROM help_buttons WHERE is_active = true ORDER BY button_order ASC'
  );
  return rows;
}

/**
 * دریافت یک دکمه راهنما با id
 * @param {number} id
 * @returns {Promise<Object|null>}
 */
async function getHelpButtonById(id) {
  const { rows } = await pool.query('SELECT * FROM help_buttons WHERE id = $1', [id]);
  return rows[0] || null;
}

/**
 * ساخت کیبورد راهنما (برای کاربران عادی)
 * @param {boolean} isAdminUser - آیا کاربر ادمین است؟
 * @returns {Promise<Object>} Markup.inlineKeyboard
 */
async function buildHelpKeyboard(isAdminUser) {
  const buttons = await getHelpButtonsData();
  const rows = [];
  
  // دو دکمه در هر ردیف
  for (let i = 0; i < buttons.length; i += 2) {
    const row = [Markup.button.callback(buttons[i].button_text, `help_view_${buttons[i].id}`)];
    if (buttons[i + 1]) {
      row.push(Markup.button.callback(buttons[i + 1].button_text, `help_view_${buttons[i + 1].id}`));
    }
    rows.push(row);
  }
  
  // دکمه‌های مدیریت فقط برای ادمین
  if (isAdminUser) {
    rows.push([Markup.button.callback('➕ افزودن راهنما', 'help_admin_add')]);
    rows.push([Markup.button.callback('✏️ مدیریت راهنماها', 'help_admin_list')]);
  }
  
  return Markup.inlineKeyboard(rows);
}

/**
 * ساخت کیبورد مدیریت راهنما (مخصوص ادمین)
 * @returns {Promise<Object>} Markup.inlineKeyboard
 */
async function buildHelpAdminListKeyboard() {
  const buttons = await getHelpButtonsData();
  const rows = [];
  
  if (buttons.length === 0) {
    rows.push([Markup.button.callback('➕ افزودن اولین راهنما', 'help_admin_add')]);
  } else {
    for (const btn of buttons) {
      rows.push([
        Markup.button.callback(`✏️ ویرایش`, `help_admin_edit_${btn.id}`),
        Markup.button.callback(`🗑 حذف`, `help_admin_delete_${btn.id}`)
      ]);
    }
    rows.push([Markup.button.callback('➕ افزودن راهنما', 'help_admin_add')]);
  }
  
  rows.push([Markup.button.callback('🔙 بازگشت', 'help_back_to_main')]);
  
  return Markup.inlineKeyboard(rows);
}

/**
 * ایجاد دکمه‌های پیش‌فرض راهنما (فقط یکبار)
 */
async function initDefaultHelpButtons() {
  const { rows } = await pool.query('SELECT COUNT(*) as cnt FROM help_buttons');
  if (parseInt(rows[0].cnt) > 0) return; // قبلاً ساخته شده
  
  const defaults = [
    {
      text: '🔑 فعالسازی لایسنس',
      content: '🔑 **راهنمای فعالسازی لایسنس**\n\n' +
        '1️⃣ دکمه "🔑 فعالسازی لایسنس" را بزنید\n' +
        '2️⃣ کد لایسنس خریداری شده را وارد کنید\n' +
        '3️⃣ پس از تایید، حساب شما فعال می‌شود\n\n' +
        '📞 پشتیبانی: @ali11512',
      order: 1
    },
    {
      text: '📢 افزودن کانال',
      content: '📢 **راهنمای افزودن کانال**\n\n' +
        '1️⃣ ابتدا ربات را در کانال خود **ادمین** کنید\n' +
        '2️⃣ دکمه "📢 افزودن کانال" را بزنید\n' +
        '3️⃣ آیدی کانال را بفرستید\n' +
        '   مثال: @my_channel\n' +
        '4️⃣ ربات بررسی می‌کند که ادمین هست یا نه\n\n' +
        '⚠️ **نکته مهم:** حتماً ربات را ادمین کنید!',
      order: 2
    },
    {
      text: '✏️ ساخت پست',
      content: '✏️ **راهنمای ساخت پست**\n\n' +
        '1️⃣ کانال مورد نظر را انتخاب کنید\n' +
        '2️⃣ متن پست را بنویسید (می‌توانید عکس یا ویدیو هم بفرستید)\n' +
        '3️⃣ تاریخ را به صورت ماه و روز وارد کنید\n' +
        '4️⃣ ساعت و دقیقه را وارد کنید\n' +
        '5️⃣ می‌توانید **زمان‌های دیگری** هم اضافه کنید\n\n' +
        '🔄 قابلیت **تکرار** برای ارسال تبلیغات در چند نوبت عالیه!',
      order: 3
    },
    {
      text: '📨 پست چند کاناله',
      content: '📨 **راهنمای پست چند کاناله**\n\n' +
        '1️⃣ "📨 پست چند کاناله" را انتخاب کنید\n' +
        '2️⃣ چند کانال را تیک بزنید\n' +
        '3️⃣ "✅ ادامه" را بزنید\n' +
        '4️⃣ متن و زمان را مثل پست عادی وارد کنید\n\n' +
        '💡 با این قابلیت یک پست را همزمان در چند کانال زمان‌بندی کنید!',
      order: 4
    },
    {
      text: '📝 مدیریت پست‌ها',
      content: '📝 **مدیریت پست‌های در انتظار**\n\n' +
        '1️⃣ دکمه "📝 پست‌ها" را بزنید\n' +
        '2️⃣ لیست پست‌های زمان‌بندی شده را می‌بینید\n' +
        '3️⃣ می‌توانید هر پست را ✏️ **ویرایش** یا ❌ **حذف** کنید\n\n' +
        '⏱ پست‌های ارسال شده خودکار حذف می‌شوند تا دیتابیس خلوت بماند.',
      order: 5
    },
    {
      text: '❓ سوالات متداول',
      content: '❓ **سوالات متداول**\n\n' +
        '**س: چرا پست ارسال نشد؟**\n' +
        'ج: ربات باید در کانال **ادمین** باشد.\n\n' +
        '**س: چطور لایسنس بخرم؟**\n' +
        'ج: به ادمین پیام بدید:\n@ali11512\n\n' +
        '**س: محدودیت زمانی داره؟**\n' +
        'ج: خیر، هر موقع می‌خواهید.\n\n' +
        '**س: چند کانال می‌تونم اضافه کنم؟**\n' +
        'ج: بستگی به لایسنس شما دارد.',
      order: 6
    }
  ];
  
  for (const h of defaults) {
    await pool.query(
      `INSERT INTO help_buttons (button_text, button_action, content_type, content, button_order) 
       VALUES ($1, $2, 'text', $3, $4)`,
      [h.text, 'help_default', h.content, h.order]
    );
  }
  
  console.log('✅ Default help buttons initialized');
}

// ════════════════════════════════════════════════════════════════
// COMMAND: /start
// ════════════════════════════════════════════════════════════════

bot.start(async (ctx) => {
  // فقط در چت خصوصی
  if (!isPrivateChat(ctx)) return;
  
  await initDefaultHelpButtons();
  const user = await createOrGetUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  
  // نمایش نوتیفیکیشن‌ها
  ctx.session.notificationsShown = false;
  await showAllNotificationsInPrivateChat(ctx, user.id);
  ctx.session.notificationsShown = true;
  
  let welcomeMsg = `✅ سلام **${ctx.from.first_name}**!`;
  
  if (user.role === 'master_admin') {
    welcomeMsg += '\n\n👑 شما ادمین اصلی هستید.';
  } else if (user.is_active) {
    welcomeMsg += '\n\n✅ حساب شما فعال است.';
    if (user.license_id) {
      const { rows: [lic] } = await pool.query('SELECT * FROM licenses WHERE id = $1', [user.license_id]);
      if (lic) {
        welcomeMsg += `\n📋 لایسنس: ${lic.name}`;
        welcomeMsg += `\n📢 کانال مجاز: ${lic.max_channels}`;
      }
    }
  } else {
    welcomeMsg += '\n\n🔑 برای استفاده از ربات، لطفاً لایسنس خود را فعال کنید.';
    welcomeMsg += '\n📞 خرید لایسنس: @ali11512';
  }
  
  await ctx.reply(welcomeMsg, getKeyboard(user));
});

// ════════════════════════════════════════════════════════════════
// HELP HANDLERS
// ════════════════════════════════════════════════════════════════

bot.hears('❓ راهنما', async (ctx) => {
  if (!isPrivateChat(ctx)) return;
  
  await initDefaultHelpButtons();
  const user = await getUserByTelegramId(ctx.from.id);
  const isAdminUser = (user && user.role === 'master_admin' && !user.test_mode);
  const keyboard = await buildHelpKeyboard(isAdminUser);
  
  await ctx.reply(
    '📖 **راهنمای ربات**\n\nلطفاً موضوع مورد نظر خود را انتخاب کنید:',
    keyboard
  );
});

// مشاهده محتوای راهنما
bot.action(/help_view_(\d+)/, async (ctx) => {
  const helpId = parseInt(ctx.match[1]);
  const help = await getHelpButtonById(helpId);
  
  if (!help) {
    await ctx.answerCbQuery('❌ این راهنما دیگر وجود ندارد');
    return;
  }
  
  await ctx.editMessageText(
    help.content,
    Markup.inlineKeyboard([[Markup.button.callback('🔙 بازگشت به راهنما', 'help_back_to_main')]])
  ).catch(async () => {
    // اگر edit نشد (مثلاً پیام خیلی قدیمی)، پیام جدید بفرست
    await ctx.reply(
      help.content,
      Markup.inlineKeyboard([[Markup.button.callback('🔙 بازگشت', 'help_back_to_main')]])
    );
  });
  
  await ctx.answerCbQuery();
});

// بازگشت به منوی اصلی راهنما
bot.action('help_back_to_main', async (ctx) => {
  const user = await getUserByTelegramId(ctx.from.id);
  const isAdminUser = (user && user.role === 'master_admin' && !user.test_mode);
  const keyboard = await buildHelpKeyboard(isAdminUser);
  
  await ctx.editMessageText(
    '📖 **راهنمای ربات**\n\nلطفاً موضوع مورد نظر خود را انتخاب کنید:',
    keyboard
  ).catch(async () => {
    await ctx.reply(
      '📖 **راهنمای ربات**\n\nلطفاً موضوع مورد نظر خود را انتخاب کنید:',
      keyboard
    );
  });
});

// ════════════════════════════════════════════════════════════════
// HELP ADMIN HANDLERS (فقط ادمین اصلی)
// ════════════════════════════════════════════════════════════════

// افزودن راهنما
bot.action('help_admin_add', async (ctx) => {
  if (!await isMasterAdmin(ctx)) {
    await ctx.answerCbQuery('❌ فقط مدیر سیستم!', { show_alert: true });
    return;
  }
  
  ctx.session.step = 'help_add_title';
  await ctx.editMessageText(
    '➕ **افزودن راهنمای جدید**\n\n📝 متن دکمه را وارد کنید:'
  ).catch(() => {});
});

// لیست مدیریت
bot.action('help_admin_list', async (ctx) => {
  if (!await isMasterAdmin(ctx)) {
    await ctx.answerCbQuery('❌ فقط مدیر سیستم!', { show_alert: true });
    return;
  }
  
  const buttons = await getHelpButtonsData();
  
  if (buttons.length === 0) {
    await ctx.editMessageText(
      '❌ هیچ راهنمایی وجود ندارد.',
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ افزودن اولین راهنما', 'help_admin_add')],
        [Markup.button.callback('🔙 بازگشت', 'help_back_to_main')]
      ])
    ).catch(() => {});
    return;
  }
  
  let msg = '✏️ **مدیریت راهنماها**\n\n';
  for (const b of buttons) {
    msg += `🆔 ${b.id} | ${b.button_text}\n`;
  }
  msg += '\nبرای ویرایش یا حذف کلیک کنید:';
  
  const keyboard = await buildHelpAdminListKeyboard();
  
  await ctx.editMessageText(msg, keyboard).catch(async () => {
    await ctx.reply(msg, keyboard);
  });
});

// ویرایش راهنما
bot.action(/help_admin_edit_(\d+)/, async (ctx) => {
  if (!await isMasterAdmin(ctx)) {
    await ctx.answerCbQuery('❌ فقط مدیر سیستم!', { show_alert: true });
    return;
  }
  
  const helpId = parseInt(ctx.match[1]);
  const help = await getHelpButtonById(helpId);
  
  if (!help) {
    await ctx.answerCbQuery('❌ این راهنما دیگر وجود ندارد');
    return;
  }
  
  ctx.session.editHelpId = helpId;
  ctx.session.step = 'help_edit_content';
  
  await ctx.editMessageText(
    `✏️ **ویرایش راهنما #${helpId}**\n\n` +
    `📝 عنوان فعلی: ${help.button_text}\n\n` +
    'محتوای جدید را وارد کنید:'
  ).catch(() => {});
});

// حذف راهنما (با تایید)
bot.action(/help_admin_delete_(\d+)/, async (ctx) => {
  if (!await isMasterAdmin(ctx)) {
    await ctx.answerCbQuery('❌ فقط مدیر سیستم!', { show_alert: true });
    return;
  }
  
  const helpId = parseInt(ctx.match[1]);
  const help = await getHelpButtonById(helpId);
  
  if (!help) {
    await ctx.answerCbQuery('❌ این راهنما دیگر وجود ندارد');
    return;
  }
  
  ctx.session.confirmAction = {
    action: 'delete_help',
    helpId: helpId,
    helpText: help.button_text
  };
  
  await ctx.editMessageText(
    `⚠️ **آیا از حذف این راهنما مطمئن هستید؟**\n\n` +
    `🆔 ${helpId}\n📝 ${help.button_text}\n\n` +
    'این عمل قابل بازگشت نیست!',
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ بله، حذف کن', 'help_confirm_delete')],
      [Markup.button.callback('❌ لغو', 'help_admin_list')]
    ])
  ).catch(() => {});
});

// تایید حذف
bot.action('help_confirm_delete', async (ctx) => {
  if (!await isMasterAdmin(ctx)) {
    await ctx.answerCbQuery('❌ فقط مدیر سیستم!', { show_alert: true });
    return;
  }
  
  const confirm = ctx.session.confirmAction;
  if (!confirm || confirm.action !== 'delete_help') {
    await ctx.answerCbQuery('❌ عملیات منقضی شد');
    return;
  }
  
  await pool.query('DELETE FROM help_buttons WHERE id = $1', [confirm.helpId]);
  ctx.session.confirmAction = null;
  
  await ctx.answerCbQuery('✅ راهنما حذف شد');
  
  // برگشت به لیست
  const buttons = await getHelpButtonsData();
  const keyboard = await buildHelpAdminListKeyboard();
  
  let msg = '✅ **راهنما با موفقیت حذف شد.**\n\n';
  if (buttons.length > 0) {
    msg += '📋 **لیست فعلی:**\n\n';
    for (const b of buttons) {
      msg += `🆔 ${b.id} | ${b.button_text}\n`;
    }
  }
  
  await ctx.editMessageText(msg, keyboard).catch(() => {});
});

// ════════════════════════════════════════════════════════════════
// LICENSE SYSTEM
// ════════════════════════════════════════════════════════════════

bot.hears('🔑 فعالسازی لایسنس', async (ctx) => {
  if (!isPrivateChat(ctx)) return;
  
  const user = await createOrGetUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  
  // اگر لایسنس فعال است، دوباره نخواه
  if (user.is_active && user.license_id) {
    const { rows: [lic] } = await pool.query('SELECT * FROM licenses WHERE id = $1', [user.license_id]);
    return ctx.reply(
      `✅ لایسنس شما در حال حاضر فعال است.\n\n` +
      `📋 ${lic?.name || 'نامشخص'}\n` +
      `📢 ${lic?.max_channels || '?'} کانال مجاز`,
      getKeyboard(user)
    );
  }
  
  ctx.session.step = 'enter_license';
  await ctx.reply(
    '🔑 **فعالسازی لایسنس**\n\n' +
    'لطفاً کد لایسنس خود را وارد کنید:\n\n' +
    '💡 برای خرید لایسنس با ادمین تماس بگیرید:\n@ali11512'
  );
});

bot.hears('🔑 لایسنس‌ها', async (ctx) => {
  if (!isPrivateChat(ctx)) return;
  if (!await isMasterAdmin(ctx)) return;
  
  const { rows: licenses } = await pool.query(
    "SELECT * FROM licenses WHERE is_active = true AND is_admin_license = false ORDER BY created_at DESC"
  );
  
  if (!licenses.length) {
    return ctx.reply(
      '❌ هیچ لایسنس فعالی وجود ندارد.',
      Markup.inlineKeyboard([[Markup.button.callback('➕ ساخت لایسنس جدید', 'new_license')]])
    );
  }
  
  let msg = '🔑 **مدیریت لایسنس‌ها**\n\n';
  const btns = [];
  
  for (const l of licenses) {
    const { rows: [cnt] } = await pool.query('SELECT COUNT(*) FROM users WHERE license_id = $1', [l.id]);
    msg += `📋 نام: ${l.name}\n`;
    msg += `🔑 کد: \`${l.code}\`\n`;
    msg += `👥 کاربران: ${cnt.count}/${l.max_users}\n`;
    msg += `📢 کانال مجاز: ${l.max_channels}\n`;
    msg += `💰 قیمت: ${l.price?.toLocaleString() || 0} افغانی\n\n`;
    btns.push([
      Markup.button.callback(`✏️ ویرایش`, `edit_license_${l.id}`),
      Markup.button.callback(`🗑 حذف`, `delete_license_${l.id}`)
    ]);
  }
  btns.push([Markup.button.callback('➕ ساخت لایسنس جدید', 'new_license')]);
  
  await ctx.reply(msg, Markup.inlineKeyboard(btns));
});

bot.action('new_license', async (ctx) => {
  if (!await isMasterAdmin(ctx)) return;
  ctx.session.step = 'create_license_name';
  await ctx.editMessageText('📝 **ساخت لایسنس جدید**\n\nنام لایسنس را وارد کنید:').catch(() => {});
});

bot.action(/edit_license_(\d+)/, async (ctx) => {
  if (!await isMasterAdmin(ctx)) return;
  ctx.session.editLicenseId = parseInt(ctx.match[1]);
  ctx.session.step = 'edit_license_name';
  await ctx.editMessageText('✏️ **ویرایش لایسنس**\n\nنام جدید را وارد کنید (یا /skip):').catch(() => {});
});

bot.action(/delete_license_(\d+)/, async (ctx) => {
  if (!await isMasterAdmin(ctx)) return;
  const licenseId = parseInt(ctx.match[1]);
  
  // غیرفعال کردن کاربران این لایسنس
  await pool.query('UPDATE users SET is_active = false, license_id = NULL WHERE license_id = $1', [licenseId]);
  // غیرفعال کردن لایسنس
  await pool.query('UPDATE licenses SET is_active = false WHERE id = $1', [licenseId]);
  
  await ctx.answerCbQuery('✅ لایسنس و کاربرانش غیرفعال شدند');
  await ctx.editMessageText('✅ لایسنس و همه کاربران آن غیرفعال شدند.').catch(() => {});
});

// ════════════════════════════════════════════════════════════════
// ADMIN PANEL
// ════════════════════════════════════════════════════════════════

bot.hears('👑 پنل مدیریت', async (ctx) => {
  if (!isPrivateChat(ctx)) return;
  if (!await isMasterAdmin(ctx)) return ctx.reply('❌ دسترسی غیرمجاز!');
  
  const { rows: [u] } = await pool.query('SELECT COUNT(*) FROM users');
  const { rows: [a] } = await pool.query('SELECT COUNT(*) FROM users WHERE is_active = true');
  const { rows: [p] } = await pool.query('SELECT COUNT(*) FROM posts');
  const { rows: [c] } = await pool.query('SELECT COUNT(*) FROM channels');
  const { rows: [l] } = await pool.query("SELECT COUNT(*) FROM licenses WHERE is_active = true AND is_admin_license = false");
  
  await ctx.reply(
    `👑 **پنل مدیریت**\n\n` +
    `👥 کل کاربران: ${u.count}\n` +
    `✅ فعال: ${a.count}\n` +
    `📝 پست‌های در انتظار: ${p.count}\n` +
    `📢 کانال‌ها: ${c.count}\n` +
    `🔑 لایسنس‌های فعال: ${l.count}`,
    adminKeyboard
  );
});

bot.hears('👥 کاربران', async (ctx) => {
  if (!isPrivateChat(ctx)) return;
  if (!await isMasterAdmin(ctx)) return ctx.reply('❌ دسترسی غیرمجاز!');
  
  const { rows: users } = await pool.query(
    `SELECT u.*, l.name as license_name, l.code as license_code, l.max_channels
     FROM users u 
     LEFT JOIN licenses l ON u.license_id = l.id 
     WHERE u.role != 'master_admin' 
     ORDER BY u.created_at DESC LIMIT 30`
  );
  
  if (!users.length) return ctx.reply('❌ هیچ کاربری ثبت نام نکرده.');
  
  let msg = '👥 **لیست کاربران**\n\n';
  const btns = [];
  
  for (const u of users) {
    msg += `🆔 \`${u.telegram_id}\`\n`;
    msg += `👤 ${u.first_name || 'بدون نام'}\n`;
    msg += `📎 @${u.username || 'ندارد'}\n`;
    msg += `🔑 ${u.license_name || 'بدون لایسنس'}\n`;
    msg += `📢 ${u.max_channels || '?'} کانال مجاز\n`;
    msg += `${u.is_active ? '✅ فعال' : '❌ غیرفعال'}\n`;
    msg += `⏰ ${new Date(u.created_at).toLocaleString('fa-IR')}\n\n`;
    
    btns.push([
      Markup.button.callback(`✏️ ${u.first_name || u.telegram_id}`, `edit_user_${u.id}`),
      Markup.button.callback(`🗑 ${u.first_name || u.telegram_id}`, `delete_user_${u.id}`)
    ]);
  }
  
  await ctx.reply(msg, Markup.inlineKeyboard(btns));
});

// ویرایش کاربر
bot.action(/edit_user_(\d+)/, async (ctx) => {
  if (!await isMasterAdmin(ctx)) return ctx.answerCbQuery('❌ دسترسی غیرمجاز!', { show_alert: true });
  
  const userId = parseInt(ctx.match[1]);
  ctx.session.editUserId = userId;
  
  const user = await getUserById(userId);
  if (!user) return ctx.answerCbQuery('کاربر یافت نشد');
  
  const { rows: licenses } = await pool.query(
    "SELECT * FROM licenses WHERE is_active = true AND is_admin_license = false"
  );
  
  let msg = `✏️ **ویرایش کاربر**\n\n`;
  msg += `👤 ${user.first_name || 'بدون نام'}\n`;
  msg += `📎 @${user.username || 'ندارد'}\n`;
  msg += `🆔 ${user.telegram_id}\n\n`;
  msg += 'لایسنس جدید را انتخاب کنید:';
  
  const btns = licenses.map(l => [
    Markup.button.callback(`🔑 ${l.name} (${l.max_channels} کانال)`, `set_user_license_${l.id}`)
  ]);
  btns.push([Markup.button.callback('❌ غیرفعال کردن', 'deactivate_user')]);
  btns.push([Markup.button.callback('🔙 بازگشت', 'back_to_admin')]);
  
  await ctx.editMessageText(msg, Markup.inlineKeyboard(btns)).catch(() => {});
});

bot.action(/set_user_license_(\d+)/, async (ctx) => {
  if (!await isMasterAdmin(ctx)) return;
  
  const licenseId = parseInt(ctx.match[1]);
  await pool.query('UPDATE users SET license_id = $1, is_active = true WHERE id = $2', [licenseId, ctx.session.editUserId]);
  
  await ctx.answerCbQuery('✅ به‌روزرسانی شد');
  await ctx.editMessageText('✅ کاربر با موفقیت به‌روزرسانی شد.').catch(() => {});
});

bot.action('deactivate_user', async (ctx) => {
  if (!await isMasterAdmin(ctx)) return;
  
  await pool.query('UPDATE users SET is_active = false, license_id = NULL WHERE id = $1', [ctx.session.editUserId]);
  
  await ctx.answerCbQuery('✅ غیرفعال شد');
  await ctx.editMessageText('✅ کاربر غیرفعال شد. برای استفاده مجدد باید لایسنس جدید وارد کند.').catch(() => {});
});

// حذف کاربر (با تایید)
bot.action(/delete_user_(\d+)/, async (ctx) => {
  if (!await isMasterAdmin(ctx)) return ctx.answerCbQuery('❌ دسترسی غیرمجاز!', { show_alert: true });
  
  const userId = parseInt(ctx.match[1]);
  ctx.session.confirmAction = { action: 'delete_user', userId };
  
  const user = await getUserById(userId);
  
  await ctx.editMessageText(
    `⚠️ **حذف کاربر**\n\n` +
    `👤 ${user?.first_name || 'بدون نام'}\n` +
    `📎 @${user?.username || 'ندارد'}\n` +
    `🆔 ${user?.telegram_id}\n\n` +
    'همه داده‌ها حذف می‌شوند. مطمئن هستید؟',
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ بله حذف کن', 'confirm_delete_user')],
      [Markup.button.callback('❌ لغو', 'back_to_admin')]
    ])
  ).catch(() => {});
});

bot.action('confirm_delete_user', async (ctx) => {
  if (!await isMasterAdmin(ctx)) return;
  
  const confirm = ctx.session.confirmAction;
  if (!confirm || confirm.action !== 'delete_user') return ctx.answerCbQuery('منقضی شد');
  
  const userId = confirm.userId;
  
  await pool.query('DELETE FROM notifications WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM posts WHERE channel_id IN (SELECT id FROM channels WHERE user_id = $1)', [userId]);
  await pool.query('DELETE FROM channels WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  
  ctx.session.confirmAction = null;
  
  await ctx.answerCbQuery('✅ کاربر حذف شد');
  await ctx.editMessageText('✅ کاربر و تمام داده‌هایش حذف شدند.').catch(() => {});
});

bot.action('back_to_admin', async (ctx) => {
  await ctx.editMessageText('◀️ بازگشت به پنل مدیریت.').catch(() => {});
});

bot.hears('📊 گزارشات', async (ctx) => {
  if (!isPrivateChat(ctx)) return;
  if (!await isMasterAdmin(ctx)) return;
  
  const { rows: [s] } = await pool.query(`
    SELECT 
      COUNT(*) FILTER (WHERE status='pending') as pending,
      COUNT(*) FILTER (WHERE status='sent') as sent,
      COUNT(*) FILTER (WHERE status='failed') as failed
    FROM posts
  `);
  
  const { rows: [n] } = await pool.query("SELECT COUNT(*) FROM notifications WHERE type = 'error'");
  
  await ctx.reply(
    `📊 **گزارشات**\n\n` +
    `⏳ در انتظار: ${s.pending}\n` +
    `✅ ارسال شده: ${s.sent}\n` +
    `❌ ناموفق: ${s.failed}\n` +
    `⚠️ خطاهای ثبت‌شده: ${n.count}`
  );
});

bot.hears('⚙️ تنظیمات', async (ctx) => {
  if (!isPrivateChat(ctx)) return;
  if (!await isMasterAdmin(ctx)) return;
  
  await ctx.reply(
    '⚙️ **تنظیمات**\n\n' +
    '/broadcast [متن] - ارسال پیام همگانی\n' +
    '/stats - آمار دقیق'
  );
});

// ════════════════════════════════════════════════════════════════
// BROADCAST SYSTEM
// ════════════════════════════════════════════════════════════════

bot.command('broadcast', async (ctx) => {
  if (!isPrivateChat(ctx)) return;
  if (!await isMasterAdmin(ctx)) return;
  
  const msg = ctx.message.text.replace('/broadcast', '').trim();
  if (!msg) return ctx.reply('❌ /broadcast [متن پیام]');
  
  ctx.session.broadcastMsg = msg;
  
  await ctx.reply(
    `📢 **پیش‌نمایش پیام همگانی:**\n\n${msg}\n\n` +
    'به همه کاربران ارسال شود؟',
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ ارسال به همه', 'confirm_broadcast')],
      [Markup.button.callback('❌ لغو', 'cancel_broadcast')]
    ])
  );
});

bot.action('confirm_broadcast', async (ctx) => {
  const msg = ctx.session.broadcastMsg;
  if (!msg) return ctx.editMessageText('❌ منقضی شد.').catch(() => {});
  
  const { rows: users } = await pool.query('SELECT telegram_id FROM users');
  let sent = 0, failed = 0;
  
  await ctx.editMessageText(`📨 در حال ارسال به ${users.length} کاربر...`).catch(() => {});
  
  for (const u of users) {
    try {
      await bot.telegram.sendMessage(u.telegram_id, `📢 **پیام مدیر:**\n\n${msg}`);
      sent++;
    } catch { failed++; }
    await new Promise(r => setTimeout(r, 50));
  }
  
  await ctx.editMessageText(
    `✅ **نتیجه ارسال همگانی**\n\n✅ موفق: ${sent} نفر\n❌ ناموفق: ${failed} نفر`
  ).catch(() => {});
  
  ctx.session.broadcastMsg = null;
});

bot.action('cancel_broadcast', async (ctx) => {
  await ctx.editMessageText('❌ ارسال همگانی لغو شد.').catch(() => {});
  ctx.session.broadcastMsg = null;
});

bot.command('stats', async (ctx) => {
  if (!isPrivateChat(ctx)) return;
  if (!await isMasterAdmin(ctx)) return;
  
  const { rows: [u] } = await pool.query('SELECT COUNT(*) FROM users');
  const { rows: [p] } = await pool.query('SELECT COUNT(*) FROM posts');
  const { rows: [c] } = await pool.query('SELECT COUNT(*) FROM channels');
  
  await ctx.reply(`📊 کاربران: ${u.count} | پست‌ها: ${p.count} | کانال‌ها: ${c.count}`);
});

// ════════════════════════════════════════════════════════════════
// TEST MODE (فقط ادمین اصلی)
// ════════════════════════════════════════════════════════════════

bot.hears('🧪 حالت تست', async (ctx) => {
  if (!isPrivateChat(ctx)) return;
  if (!await isMasterAdmin(ctx)) return;
  
  await pool.query(
    "UPDATE users SET test_mode = true, is_active = false, license_id = NULL WHERE telegram_id = $1",
    [ctx.from.id]
  );
  
  await ctx.reply(
    '🧪 **حالت تست فعال شد!**\n\n' +
    'شما اکنون مثل یک کاربر عادی هستید.\n' +
    'برای استفاده باید لایسنس وارد کنید.\n\n' +
    '🔑 کد تست: LIC-TEST-001',
    testKeyboard
  );
});

bot.hears('❌ خروج از تست', async (ctx) => {
  if (!isPrivateChat(ctx)) return;
  
  const user = await getUserByTelegramId(ctx.from.id);
  if (!user || user.role !== 'master_admin') return; // کاربر عادی نتونه
  
  await pool.query(
    "UPDATE users SET test_mode = false, is_active = true, license_id = 1 WHERE telegram_id = $1",
    [ctx.from.id]
  );
  
  // ریست session
  ctx.session = null;
  
  await ctx.reply('✅ از حالت تست خارج شدید.', adminKeyboard);
});

// ════════════════════════════════════════════════════════════════
// CHANNEL MANAGEMENT
// ════════════════════════════════════════════════════════════════

bot.hears('📢 افزودن کانال', async (ctx) => {
  if (!isPrivateChat(ctx)) return;
  
  if (!await hasAccess(ctx)) {
    return ctx.reply('🔑 ابتدا لایسنس خود را فعال کنید.', licenseKeyboard);
  }
  
  ctx.session.step = 'add_channel';
  await ctx.reply(
    '📢 **افزودن کانال جدید**\n\n' +
    'لطفاً آیدی کانال را بفرستید:\n\n' +
    'مثال: @my_channel\n' +
    'یا: https://t.me/my_channel\n\n' +
    '⚠️ **نکته مهم:** ربات باید در کانال ادمین باشد!'
  );
});

bot.hears('📋 کانال‌ها', async (ctx) => {
  if (!isPrivateChat(ctx)) return;
  
  const user = await createOrGetUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const { rows: channels } = await pool.query(
    'SELECT * FROM channels WHERE user_id = $1 ORDER BY id DESC',
    [user.id]
  );
  
  if (!channels.length) return ctx.reply('❌ هیچ کانالی ثبت نشده.', getKeyboard(user));
  
  let msg = '📋 **کانال‌های شما**\n\n';
  const btns = [];
  for (const ch of channels) {
    msg += `📢 @${ch.channel_id}\n`;
    btns.push([Markup.button.callback(`🗑 حذف @${ch.channel_id}`, `delete_ch_${ch.id}`)]);
  }
  await ctx.reply(msg, Markup.inlineKeyboard(btns));
});

bot.action(/delete_ch_(\d+)/, async (ctx) => {
  await pool.query('DELETE FROM channels WHERE id = $1', [parseInt(ctx.match[1])]);
  await ctx.answerCbQuery('✅ کانال حذف شد');
  await ctx.editMessageText('✅ کانال با موفقیت حذف شد.').catch(() => {});
});

// ════════════════════════════════════════════════════════════════
// POST CREATION FLOW
// ════════════════════════════════════════════════════════════════

bot.hears('✏️ پست جدید', async (ctx) => startPostFlow(ctx, false));
bot.hears('📨 پست چند کاناله', async (ctx) => startPostFlow(ctx, true));

async function startPostFlow(ctx, multi) {
  if (!isPrivateChat(ctx)) return;
  if (!await hasAccess(ctx)) return ctx.reply('🔑 ابتدا لایسنس خود را فعال کنید.', licenseKeyboard);
  
  const user = await createOrGetUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const { rows: channels } = await pool.query('SELECT * FROM channels WHERE user_id = $1', [user.id]);
  
  if (!channels.length) return ctx.reply('❌ ابتدا کانال اضافه کنید.', getKeyboard(user));
  
  ctx.session.channels = channels;
  ctx.session.postData.multi = multi;
  ctx.session.selectedChannels = [];
  ctx.session.postData.channel_ids = [];
  ctx.session.postData.times = [];
  
  if (multi) {
    const btns = channels.map(ch => [Markup.button.callback(`☑️ ${ch.channel_id}`, `select_multi_${ch.id}`)]);
    btns.push([Markup.button.callback('✅ ادامه', 'finish_multi')], [Markup.button.callback('🔙 لغو', 'cancel_post')]);
    ctx.session.step = 'select_multi_channels';
    await ctx.reply('📨 **انتخاب کانال‌ها**\n\nچند کانال را انتخاب کنید:', Markup.inlineKeyboard(btns));
  } else {
    const btns = channels.map(ch => [Markup.button.callback(`📢 ${ch.channel_id}`, `select_single_${ch.id}`)]);
    btns.push([Markup.button.callback('🔙 لغو', 'cancel_post')]);
    ctx.session.step = 'select_channel';
    await ctx.reply('📢 **انتخاب کانال**\n\nیک کانال را انتخاب کنید:', Markup.inlineKeyboard(btns));
  }
}

bot.action(/select_single_(\d+)/, async (ctx) => {
  ctx.session.postData.channel_ids = [parseInt(ctx.match[1])];
  ctx.session.step = 'enter_text';
  await ctx.editMessageText('✏️ **متن پست را بنویسید**\n\nمی‌توانید عکس یا ویدیو هم بفرستید:').catch(() => {});
});

bot.action(/select_multi_(\d+)/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const arr = ctx.session.selectedChannels;
  if (arr.includes(id)) arr.splice(arr.indexOf(id), 1);
  else arr.push(id);
  await ctx.answerCbQuery(arr.includes(id) ? '✅ انتخاب شد' : '❌ حذف شد');
});

bot.action('finish_multi', async (ctx) => {
  if (!ctx.session.selectedChannels.length) return ctx.answerCbQuery('حداقل یک کانال انتخاب کنید');
  ctx.session.postData.channel_ids = [...ctx.session.selectedChannels];
  ctx.session.step = 'enter_text';
  await ctx.editMessageText(
    `✏️ **متن پست را بنویسید**\n\n${ctx.session.selectedChannels.length} کانال انتخاب شده است.`
  ).catch(() => {});
});

bot.action('cancel_post', async (ctx) => {
  ctx.session.step = null;
  const user = await createOrGetUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  await ctx.editMessageText('❌ ساخت پست لغو شد.').catch(() => {});
  await ctx.reply('منوی اصلی:', getKeyboard(user));
});

// ════════════════════════════════════════════════════════════════
// DATE & TIME INPUT
// ════════════════════════════════════════════════════════════════

async function askMonth(ctx) {
  ctx.session.step = 'enter_month';
  await ctx.reply('📅 **ماه را وارد کنید ماه های میلادی** (1 تا 12):');
}

async function savePost(ctx, month, day, hour, minute) {
  const nowKabul = new Date(Date.now() + KABUL_OFFSET);
  const year = nowKabul.getFullYear();
  const utc = kabulToUTC(year, month - 1, day, hour, minute);
  
  if (utc <= Date.now()) {
    await ctx.reply('❌ این زمان گذشته است!\n\nلطفاً زمان دیگری انتخاب کنید.');
    return askMonth(ctx);
  }
  
  const channelIds = ctx.session.postData.channel_ids;
  
  for (const chId of channelIds) {
    const { rows: [ch] } = await pool.query('SELECT * FROM channels WHERE id = $1', [chId]);
    if (!ch) continue;
    if (!await checkBotInChannel(ch.channel_id)) {
      await ctx.reply(`❌ ربات در کانال @${ch.channel_id} ادمین نیست!\n\nلطفاً ابتدا ربات را ادمین کنید.`);
      ctx.session.step = null;
      return;
    }
  }
  
  ctx.session.postData.times.push({ month, day, hour, minute, utc });
  
  for (const chId of channelIds) {
    await pool.query(
      `INSERT INTO posts (channel_id, text, media_url, media_type, publish_time, status) VALUES ($1,$2,$3,$4,$5,'pending')`,
      [chId, ctx.session.postData.text, ctx.session.postData.media_url, ctx.session.postData.media_type || 'none', new Date(utc)]
    );
  }
  
  await ctx.reply(`✅ **پست زمان‌بندی شد!**\n\n📅 ${formatKabulDate(utc)}\n⏱ ${timeRemaining(utc)}`);
  
  await ctx.reply(
    '🔁 **آیا می‌خواهید زمان دیگری برای همین پست اضافه کنید؟**',
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ بله - اضافه کردن زمان جدید', 'add_another_time')],
      [Markup.button.callback('❌ خیر - تمام', 'finish_posting')]
    ])
  );
}

bot.action('add_another_time', async (ctx) => {
  await ctx.editMessageText('✅ **زمان جدید برای همین پست**').catch(() => {});
  return askMonth(ctx);
});

bot.action('finish_posting', async (ctx) => {
  ctx.session.step = null;
  const user = await createOrGetUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const count = ctx.session.postData.times.length;
  await ctx.editMessageText(`✅ **${count} پست با موفقیت زمان‌بندی شد!** 🎉`).catch(() => {});
  ctx.session.postData = { channel_ids: [], text: null, media_url: null, media_type: 'none', repeat: false, times: [] };
  await ctx.reply('منوی اصلی:', getKeyboard(user));
});

// ════════════════════════════════════════════════════════════════
// MY POSTS
// ════════════════════════════════════════════════════════════════

bot.hears('📝 پست‌ها', async (ctx) => {
  if (!isPrivateChat(ctx)) return;
  
  const user = await createOrGetUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  
  const { rows: posts } = await pool.query(
    `SELECT p.*, c.channel_id FROM posts p JOIN channels c ON p.channel_id = c.id WHERE c.user_id = $1 ORDER BY p.created_at DESC LIMIT 15`,
    [user.id]
  );
  
  if (!posts.length) return ctx.reply('❌ پستی در انتظار ندارید.', getKeyboard(user));
  
  let msg = '📝 **پست‌های در انتظار**\n\n';
  const btns = [];
  
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const icon = p.status === 'pending' ? '⏳' : '❌';
    const remaining = p.status === 'pending' ? `⏱ ${timeRemaining(new Date(p.publish_time).getTime())}` : '';
    msg += `${i + 1}. ${icon} ${p.text?.substring(0, 30) || 'بدون متن'}...\n`;
    msg += `📅 ${formatKabulDate(p.publish_time)} ${remaining}\n`;
    msg += `📢 @${p.channel_id}\n\n`;
    
    if (p.status === 'pending') {
      btns.push([
        Markup.button.callback(`✏️ ${i + 1}`, `edit_post_${p.id}`),
        Markup.button.callback(`❌ ${i + 1}`, `delete_post_${p.id}`)
      ]);
    }
  }
  
  await ctx.reply(msg, btns.length ? Markup.inlineKeyboard(btns) : undefined);
});

bot.action(/edit_post_(\d+)/, async (ctx) => {
  ctx.session.editPostId = parseInt(ctx.match[1]);
  ctx.session.step = 'edit_post_text';
  await ctx.editMessageText('📝 متن جدید را وارد کنید:').catch(() => {});
});

bot.action(/delete_post_(\d+)/, async (ctx) => {
  await pool.query('DELETE FROM posts WHERE id = $1', [parseInt(ctx.match[1])]);
  await ctx.answerCbQuery('✅ حذف شد');
  await ctx.editMessageText('✅ پست با موفقیت حذف شد.').catch(() => {});
});

// ════════════════════════════════════════════════════════════════
// TEXT HANDLERS (step-based)
// ════════════════════════════════════════════════════════════════

bot.on('text', async (ctx) => {
  if (!isPrivateChat(ctx)) return; // فقط چت خصوصی
  
  const step = ctx.session?.step;
  if (!step) return;
  
  const text = ctx.message.text.trim();
  
  // فعالسازی لایسنس
  if (step === 'enter_license') {
    const { rows: lics } = await pool.query(
      "SELECT * FROM licenses WHERE code = $1 AND is_active = true AND is_admin_license = false",
      [text.toUpperCase()]
    );
    
    if (!lics.length) return ctx.reply('❌ کد لایسنس نامعتبر است.');
    
    const license = lics[0];
    const { rows: cnt } = await pool.query('SELECT COUNT(*) FROM users WHERE license_id = $1', [license.id]);
    
    if (parseInt(cnt[0].count) >= license.max_users) {
      return ctx.reply('❌ ظرفیت این لایسنس تکمیل شده است.');
    }
    
    const user = await createOrGetUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
    await pool.query('UPDATE users SET license_id = $1, is_active = true WHERE id = $2', [license.id, user.id]);
    
    ctx.session.step = null;
    const updated = await getUserByTelegramId(ctx.from.id);
    await ctx.reply(
      `✅ **لایسنس فعال شد!**\n\n📋 ${license.name}\n📢 ${license.max_channels} کانال مجاز`,
      getKeyboard(updated)
    );
    return;
  }
  
  // افزودن کانال
  if (step === 'add_channel') {
    const clean = cleanChannelId(text);
    const user = await createOrGetUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
    
    if (!await checkBotInChannel(clean)) {
      return ctx.reply('❌ ربات در کانال ادمین نیست!\n\nلطفاً ابتدا ربات را در کانال ادمین کنید.');
    }
    
    const { rows: ex } = await pool.query('SELECT id FROM channels WHERE user_id=$1 AND channel_id=$2', [user.id, clean]);
    if (ex.length) return ctx.reply('❌ این کانال قبلاً اضافه شده است.');
    
    if (user.role !== 'master_admin' || user.test_mode) {
      const { rows: [lic] } = await pool.query('SELECT max_channels FROM licenses WHERE id = $1', [user.license_id]);
      const { rows: [cnt] } = await pool.query('SELECT COUNT(*) FROM channels WHERE user_id = $1', [user.id]);
      if (lic && parseInt(cnt.count) >= lic.max_channels) {
        return ctx.reply(`❌ حداکثر ${lic.max_channels} کانال مجاز است.`);
      }
    }
    
    await pool.query('INSERT INTO channels (user_id, channel_id, channel_name) VALUES ($1,$2,$3)', [user.id, clean, clean]);
    ctx.session.step = null;
    await ctx.reply(`✅ کانال @${clean} با موفقیت اضافه شد!`, getKeyboard(user));
    return;
  }
  
  // متن پست
  if (step === 'enter_text') {
    ctx.session.postData.text = text;
    return askMonth(ctx);
  }
  
  // ماه
  if (step === 'enter_month') {
    const m = parseInt(text);
    if (isNaN(m) || m < 1 || m > 12) return ctx.reply('❌ ماه نامعتبر! عدد ۱ تا ۱۲:');
    ctx.session.tempMonth = m;
    ctx.session.step = 'enter_day';
    await ctx.reply('📅 روز را وارد کنید:');
    return;
  }
  
  // روز
  if (step === 'enter_day') {
    const d = parseInt(text);
    if (isNaN(d) || d < 1 || d > 31) return ctx.reply('❌ روز نامعتبر!');
    ctx.session.tempDay = d;
    ctx.session.step = 'enter_hour';
    await ctx.reply('🕐 ساعت (0 تا 23):');
    return;
  }
  
  // ساعت
  if (step === 'enter_hour') {
    const h = parseInt(text);
    if (isNaN(h) || h < 0 || h > 23) return ctx.reply('❌ ساعت نامعتبر! ۰ تا ۲۳:');
    ctx.session.tempHour = h;
    ctx.session.step = 'enter_minute';
    await ctx.reply('🕐 دقیقه (0 تا 59):');
    return;
  }
  
  // دقیقه
  if (step === 'enter_minute') {
    const min = parseInt(text);
    if (isNaN(min) || min < 0 || min > 59) return ctx.reply('❌ دقیقه نامعتبر! ۰ تا ۵۹:');
    await savePost(ctx, ctx.session.tempMonth, ctx.session.tempDay, ctx.session.tempHour, min);
    return;
  }
  
  // ویرایش پست
  if (step === 'edit_post_text') {
    await pool.query('UPDATE posts SET text=$1 WHERE id=$2', [text, ctx.session.editPostId]);
    ctx.session.step = null;
    await ctx.reply('✅ پست ویرایش شد!');
    return;
  }
  
  // ساخت لایسنس
  if (step === 'create_license_name') {
    ctx.session.newLicense.name = text;
    ctx.session.step = 'create_license_users';
    await ctx.reply('👥 حداکثر کاربران:');
    return;
  }
  if (step === 'create_license_users') {
    const v = parseInt(text); if (isNaN(v)) return ctx.reply('❌ عدد');
    ctx.session.newLicense.max_users = v;
    ctx.session.step = 'create_license_channels';
    await ctx.reply('📢 حداکثر کانال:');
    return;
  }
  if (step === 'create_license_channels') {
    const v = parseInt(text); if (isNaN(v)) return ctx.reply('❌ عدد');
    ctx.session.newLicense.max_channels = v;
    ctx.session.step = 'create_license_price';
    await ctx.reply('💰 قیمت (افغانی):');
    return;
  }
  if (step === 'create_license_price') {
    const v = parseInt(text); if (isNaN(v)) return ctx.reply('❌ عدد');
    const code = 'LIC-' + Math.random().toString(36).substring(2,10).toUpperCase();
    const user = await createOrGetUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
    await pool.query(
      "INSERT INTO licenses (code, name, max_users, max_channels, price, created_by, is_admin_license) VALUES ($1,$2,$3,$4,$5,$6,false)",
      [code, ctx.session.newLicense.name, ctx.session.newLicense.max_users, ctx.session.newLicense.max_channels, v, user.id]
    );
    ctx.session.step = null;
    await ctx.reply(`✅ ساخته شد!\n🔑 ${code}\n📋 ${ctx.session.newLicense.name}\n👥 ${ctx.session.newLicense.max_users}\n📢 ${ctx.session.newLicense.max_channels}\n💰 ${v} افغانی`);
    return;
  }
  
  // ویرایش لایسنس
  if (step === 'edit_license_name') {
    if (text !== '/skip') await pool.query('UPDATE licenses SET name=$1 WHERE id=$2', [text, ctx.session.editLicenseId]);
    ctx.session.step = 'edit_license_users';
    await ctx.reply('👥 کاربران جدید (/skip):');
    return;
  }
  if (step === 'edit_license_users') {
    if (text !== '/skip') { const v = parseInt(text); if (!isNaN(v)) await pool.query('UPDATE licenses SET max_users=$1 WHERE id=$2', [v, ctx.session.editLicenseId]); }
    ctx.session.step = 'edit_license_channels';
    await ctx.reply('📢 کانال جدید (/skip):');
    return;
  }
  if (step === 'edit_license_channels') {
    if (text !== '/skip') { const v = parseInt(text); if (!isNaN(v)) await pool.query('UPDATE licenses SET max_channels=$1 WHERE id=$2', [v, ctx.session.editLicenseId]); }
    ctx.session.step = 'edit_license_price';
    await ctx.reply('💰 قیمت جدید (/skip):');
    return;
  }
  if (step === 'edit_license_price') {
    if (text !== '/skip') { const v = parseInt(text); if (!isNaN(v)) await pool.query('UPDATE licenses SET price=$1 WHERE id=$2', [v, ctx.session.editLicenseId]); }
    ctx.session.step = null;
    await ctx.reply('✅ ویرایش شد.');
    return;
  }
  
  // راهنما
  if (step === 'help_add_title') {
    ctx.session.newHelpText = text;
    ctx.session.step = 'help_add_content';
    await ctx.reply('📝 متن راهنما:');
    return;
  }
  if (step === 'help_add_content') {
    const { rows: [o] } = await pool.query('SELECT COALESCE(MAX(button_order),0)+1 as n FROM help_buttons');
    await pool.query(
      "INSERT INTO help_buttons (button_text, button_action, content_type, content, button_order) VALUES ($1,$2,'text',$3,$4)",
      [ctx.session.newHelpText, 'help_default', text, o.n]
    );
    ctx.session.step = null;
    await ctx.reply('✅ راهنما اضافه شد!');
    return;
  }
  if (step === 'help_edit_content') {
    await pool.query('UPDATE help_buttons SET content=$1 WHERE id=$2', [text, ctx.session.editHelpId]);
    ctx.session.step = null;
    await ctx.reply('✅ راهنما ویرایش شد!');
    return;
  }
});

// ════════════════════════════════════════════════════════════════
// MEDIA HANDLERS
// ════════════════════════════════════════════════════════════════

bot.on('photo', async (ctx) => {
  if (!isPrivateChat(ctx)) return;
  if (ctx.session?.step !== 'enter_text') return;
  
  const p = ctx.message.photo.pop();
  ctx.session.postData.media_url = p.file_id;
  ctx.session.postData.media_type = 'photo';
  ctx.session.postData.text = ctx.message.caption || '';
  
  await ctx.reply('✅ عکس دریافت شد.');
  return askMonth(ctx);
});

bot.on('video', async (ctx) => {
  if (!isPrivateChat(ctx)) return;
  if (ctx.session?.step !== 'enter_text') return;
  
  ctx.session.postData.media_url = ctx.message.video.file_id;
  ctx.session.postData.media_type = 'video';
  ctx.session.postData.text = ctx.message.caption || '';
  
  await ctx.reply('✅ ویدیو دریافت شد.');
  return askMonth(ctx);
});

// ════════════════════════════════════════════════════════════════
// LAUNCH
// ════════════════════════════════════════════════════════════════

const app = express();
app.get('/', (req, res) => res.send('OK'));
app.listen(process.env.PORT || 3000, () => console.log('🌐 Web server'));

scheduler.start(bot, pool);

bot.launch().then(() => console.log('🚀 Bot started!')).catch(e => console.error(e.message));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
