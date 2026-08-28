const crypto = require('crypto');
const { getDb } = require('./db');
const { getIO } = require('./sockets');

let isPolling = false;
let pollingAbortController = null;
let lastUpdateId = 0;
let cachedBotInfo = null;

/**
 * Get setting value helper
 */
function getSetting(key, defaultValue = '') {
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM agy_settings WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
  } catch (e) {
    return defaultValue;
  }
}

/**
 * Set setting value helper
 */
function setSetting(key, value) {
  try {
    const db = getDb();
    db.prepare('INSERT OR REPLACE INTO agy_settings (key, value) VALUES (?, ?)').run(key, String(value));
    return true;
  } catch (e) {
    console.error(`[Telegram] Error saving setting ${key}:`, e);
    return false;
  }
}

/**
 * Get Telegram Bot Configuration
 */
function getTelegramConfig() {
  const token = getSetting('telegram_bot_token', '');
  const username = getSetting('telegram_bot_username', '');
  const isActive = getSetting('telegram_bot_active', '1') === '1';
  const adminChatId = getSetting('telegram_admin_chat_id', '');
  const lastTestedAt = getSetting('telegram_last_tested_at', '');

  return {
    bot_token: token ? `${token.slice(0, 8)}...${token.slice(-6)}` : '',
    has_token: Boolean(token),
    bot_username: username,
    is_active: isActive,
    admin_chat_id: adminChatId,
    last_tested_at: lastTestedAt,
    is_polling: isPolling
  };
}

/**
 * Call Telegram Bot API
 */
async function callTelegramApi(endpoint, body = {}, customToken = null) {
  const token = customToken || getSetting('telegram_bot_token', '');
  if (!token) {
    throw new Error('Telegram Bot Token belum dikonfigurasi.');
  }

  const url = `https://api.telegram.org/bot${token}/${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000)
  });

  const data = await res.json();
  if (!data.ok) {
    throw new Error(data.description || `Telegram API Error (${data.error_code || res.status})`);
  }

  return data.result;
}

/**
 * Test Bot Token & Fetch Bot Info (getMe)
 */
async function testTelegramBot(tokenToTest = null) {
  const token = tokenToTest || getSetting('telegram_bot_token', '');
  if (!token) throw new Error('Token Telegram Bot tidak boleh kosong.');

  const botInfo = await callTelegramApi('getMe', {}, token);
  cachedBotInfo = botInfo;

  if (botInfo.username) {
    setSetting('telegram_bot_username', botInfo.username);
  }
  setSetting('telegram_last_tested_at', new Date().toISOString());

  return {
    success: true,
    bot_name: botInfo.first_name,
    bot_username: botInfo.username,
    can_join_groups: botInfo.can_join_groups,
    can_read_all_group_messages: botInfo.can_read_all_group_messages
  };
}

/**
 * Send Message to Telegram Chat
 */
async function sendTelegramMessage(chatId, text, options = {}) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: options.parse_mode || 'HTML',
    disable_web_page_preview: options.disable_web_page_preview !== false
  };

  if (options.reply_markup) {
    body.reply_markup = options.reply_markup;
  }

  return await callTelegramApi('sendMessage', body);
}

/**
 * Answer Telegram Callback Query
 */
async function answerCallbackQuery(callbackQueryId, text = '') {
  try {
    await callTelegramApi('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text
    });
  } catch (_) {}
}

/**
 * Escape HTML for Telegram HTML parse_mode
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Generate or retrieve Telegram Connect Auth Token for a User
 */
function getUserTelegramAuth(userId) {
  const db = getDb();
  const user = db.prepare('SELECT id, username, full_name, telegram_chat_id, telegram_username, telegram_auth_token, telegram_notifications FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('User tidak ditemukan');

  let token = user.telegram_auth_token;
  if (!token) {
    token = 'tga_' + crypto.randomBytes(12).toString('hex');
    db.prepare('UPDATE users SET telegram_auth_token = ? WHERE id = ?').run(token, userId);
  }

  const botUsername = getSetting('telegram_bot_username', '') || (cachedBotInfo?.username || '');

  return {
    user_id: user.id,
    username: user.username,
    full_name: user.full_name,
    is_linked: Boolean(user.telegram_chat_id),
    telegram_chat_id: user.telegram_chat_id || null,
    telegram_username: user.telegram_username || null,
    telegram_notifications: Boolean(user.telegram_notifications !== 0),
    auth_token: token,
    bot_username: botUsername,
    deep_link: botUsername ? `https://t.me/${botUsername}?start=${token}` : null,
    connect_command: `/connect ${token}`
  };
}

/**
 * Unlink Telegram from a User
 */
function unlinkUserTelegram(userId) {
  const db = getDb();
  db.prepare('UPDATE users SET telegram_chat_id = NULL, telegram_username = NULL, telegram_auth_token = NULL WHERE id = ?').run(userId);
  return { success: true, message: 'Akun Telegram berhasil dilepas.' };
}

/**
 * Helper to build and send MyApps message
 */
async function sendUserAppsList(chatId, user) {
  const db = getDb();
  let apps = [];
  if (user.role === 'admin') {
    apps = db.prepare('SELECT * FROM client_apps ORDER BY name ASC').all() || [];
  } else {
    apps = db.prepare('SELECT * FROM client_apps WHERE assigned_user_id = ? OR client_email = ? ORDER BY name ASC').all(user.id, user.username) || [];
  }

  // Also check active cloudflare_tunnels
  const tunnels = db.prepare('SELECT * FROM cloudflare_tunnels ORDER BY port ASC').all() || [];
  const tunnelMap = new Map();
  tunnels.forEach(t => tunnelMap.set(t.port, t.last_url || t.target_url));

  if (!apps.length && !tunnels.length) {
    await sendTelegramMessage(chatId, `📦 <b>Daftar Aplikasi (${escapeHtml(user.full_name)}):</b>\n\nBelum ada aplikasi yang terdaftar.`);
    return;
  }

  let appsHtml = `📦 <b>Daftar Aplikasi & Link Cloudflare Aktif (${escapeHtml(user.full_name)}):</b>\n\n`;
  const inlineButtons = [];

  if (apps.length > 0) {
    apps.forEach((a, i) => {
      const liveUrl = a.public_url || tunnelMap.get(a.internal_port);
      appsHtml += `<b>${i + 1}. ${escapeHtml(a.name)}</b>\n`;
      appsHtml += `🏢 Klien: <b>${escapeHtml(a.client_name)}</b>\n`;
      appsHtml += `🔌 Port: <code>${a.internal_port}</code>\n`;
      if (liveUrl) {
        appsHtml += `🌐 Link: <a href="${liveUrl}"><b>${liveUrl}</b></a>\n\n`;
        inlineButtons.push([{ text: `🚀 Buka ${a.name.slice(0, 20)}`, url: liveUrl }]);
      } else {
        appsHtml += `🌐 Link: <i>(Belum ada tunnel aktif)</i>\n\n`;
      }
    });
  } else if (tunnels.length > 0) {
    tunnels.forEach((t, i) => {
      const url = t.last_url || t.target_url;
      appsHtml += `<b>${i + 1}. ${escapeHtml(t.name || `Tunnel Port ${t.port}`)}</b>\n`;
      appsHtml += `🔌 Port: <code>${t.port}</code>\n`;
      if (url) {
        appsHtml += `🌐 Link: <a href="${url}"><b>${url}</b></a>\n\n`;
        inlineButtons.push([{ text: `🚀 Buka Port ${t.port}`, url: url }]);
      } else {
        appsHtml += `🌐 Link: <i>(Offline)</i>\n\n`;
      }
    });
  }

  const options = {};
  if (inlineButtons.length > 0) {
    options.reply_markup = { inline_keyboard: inlineButtons };
  }

  await sendTelegramMessage(chatId, appsHtml, options);
}

/**
 * Handle incoming Telegram command or message
 */
async function handleTelegramUpdate(update) {
  const db = getDb();

  // Handle Callback Query (from inline keyboard clicks)
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message?.chat?.id;
    const data = cb.data;
    await answerCallbackQuery(cb.id);

    if (data === 'myapps' && chatId) {
      const user = db.prepare('SELECT * FROM users WHERE telegram_chat_id = ?').get(String(chatId));
      if (user) {
        await sendUserAppsList(chatId, user);
      } else {
        await sendTelegramMessage(chatId, '⚠️ Akun Telegram belum ditautkan. Kirim <code>/connect KODE</code>.');
      }
    }
    return;
  }

  if (!update.message || !update.message.text) return;

  const msg = update.message;
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const text = msg.text.trim();

  // Command: /start or /start <token>
  if (text.startsWith('/start')) {
    const parts = text.split(' ');
    const param = parts[1]?.trim();

    if (param) {
      await processAuthTokenLinking(chatId, from, param);
      return;
    }

    // Default welcome
    const welcomeHtml = `
👋 <b>Halo, ${escapeHtml(from.first_name || 'Sahabat')}!</b>

Selamat datang di <b>AGY Integration Hub Telegram Bot</b>.
Bot ini berfungsi untuk membagikan link Cloudflare Tunnel & update server aplikasi langsung ke ponsel Anda.

🔐 <b>Cara Menautkan Akun Anda:</b>
1. Buka <b>Portal Klien</b> atau <b>Pengaturan Sandi & Akun</b> di Web AGY Hub.
2. Klik tombol <b>Hubungkan Telegram</b>.
3. Klik link langsung atau kirimkan perintah:
<code>/connect KODE_AUTORISASI_ANDA</code>

Ketik <code>/help</code> untuk bantuan perintah lainnya.
`;
    await sendTelegramMessage(chatId, welcomeHtml);
    return;
  }

  // Command: /connect <token>
  if (text.startsWith('/connect')) {
    const parts = text.split(' ');
    const token = parts[1]?.trim();

    if (!token) {
      await sendTelegramMessage(chatId, '⚠️ <b>Format salah.</b> Gunakan format:\n<code>/connect KODE_AUTORISASI</code>\n\nKode dapat dilihat di Portal Klien AGY Hub.');
      return;
    }

    await processAuthTokenLinking(chatId, from, token);
    return;
  }

  // Command: /myapps
  if (text === '/myapps' || text.startsWith('/myapps@')) {
    const user = db.prepare('SELECT * FROM users WHERE telegram_chat_id = ?').get(String(chatId));
    if (!user) {
      await sendTelegramMessage(chatId, '⚠️ Akun Telegram Anda belum ditautkan ke akun AGY Hub.\nKetik <code>/connect KODE</code> untuk menghubungkan.');
      return;
    }

    await sendUserAppsList(chatId, user);
    return;
  }

  // Command: /unlink
  if (text === '/unlink' || text.startsWith('/unlink@')) {
    const user = db.prepare('SELECT * FROM users WHERE telegram_chat_id = ?').get(String(chatId));
    if (!user) {
      await sendTelegramMessage(chatId, '⚠️ Akun Telegram ini belum terhubung dengan akun manapun.');
      return;
    }

    db.prepare('UPDATE users SET telegram_chat_id = NULL, telegram_username = NULL, telegram_auth_token = NULL WHERE id = ?').run(user.id);
    await sendTelegramMessage(chatId, `✅ Akun <b>${escapeHtml(user.full_name)}</b> (@${escapeHtml(user.username)}) berhasil dilepas dari Telegram ini.`);
    return;
  }

  // Command: /status
  if (text === '/status' || text.startsWith('/status@')) {
    const user = db.prepare('SELECT * FROM users WHERE telegram_chat_id = ?').get(String(chatId));
    const statusHtml = `
📊 <b>Status Sistem & Akun:</b>
• <b>Status Bot</b>: 🟢 Online & Siaga
• <b>Akun Terhubung</b>: ${user ? `✅ <b>${escapeHtml(user.full_name)}</b> (@${escapeHtml(user.username)}) [Role: ${user.role}]` : '❌ Belum Terhubung'}
• <b>Waktu Server</b>: <code>${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB</code>
`;
    await sendTelegramMessage(chatId, statusHtml);
    return;
  }

  // Command: /help
  if (text === '/help' || text.startsWith('/help@')) {
    const helpHtml = `
ℹ️ <b>Daftar Perintah AGY Telegram Bot:</b>

• <code>/myapps</code> - Menampilkan daftar aplikasi & link Cloudflare aktif Anda
• <code>/status</code> - Memeriksa status akun & bot
• <code>/connect KODE</code> - Menautkan akun AGY Hub dengan Telegram ini
• <code>/unlink</code> - Melepas tautan akun Telegram
• <code>/help</code> - Panduan bantuan ini

💡 <i>Link Cloudflare akan otomatis dikirimkan ke chat ini setiap kali ada refresh / restart aplikasi Anda.</i>
`;
    await sendTelegramMessage(chatId, helpHtml);
  }
}

/**
 * Process linking user via Auth Token
 */
async function processAuthTokenLinking(chatId, from, token) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE telegram_auth_token = ?').get(token.trim());

  if (!user) {
    await sendTelegramMessage(chatId, '❌ <b>Kode autorisasi tidak valid atau sudah kedaluwarsa.</b>\nSilakan generate kode baru dari Portal Klien / Pengaturan Akun di Web AGY Hub.');
    return;
  }

  const tgUsername = from.username ? `@${from.username}` : (from.first_name || 'User');

  // Safe update without updated_at error
  try {
    db.prepare(`
      UPDATE users 
      SET telegram_chat_id = ?, telegram_username = ?, telegram_notifications = 1 
      WHERE id = ?
    `).run(String(chatId), tgUsername, user.id);
  } catch (e) {
    db.prepare('UPDATE users SET telegram_chat_id = ?, telegram_username = ? WHERE id = ?').run(String(chatId), tgUsername, user.id);
  }

  const successHtml = `
🎉 <b>Autentikasi Berhasil!</b>

Halo <b>${escapeHtml(user.full_name)}</b> (@${escapeHtml(user.username)}),
Akun Telegram Anda berhasil ditautkan ke <b>AGY Control Center</b>!

🔔 <b>Layanan Notifikasi Otomatis Aktif:</b>
Setiap kali link Cloudflare Tunnel atau server aplikasi Anda diperbarui/refresh, Anda akan langsung menerima link terbaru secara instan di sini.
`;

  await sendTelegramMessage(chatId, successHtml);

  // Send current active apps list immediately!
  await sendUserAppsList(chatId, user);

  // Emit socket event to update Web UI instantly
  try {
    const io = getIO();
    if (io) {
      io.emit('telegram:user_linked', {
        userId: user.id,
        telegram_chat_id: String(chatId),
        telegram_username: tgUsername
      });
    }
  } catch (_) {}

  console.log(`[Telegram] ✅ User "${user.username}" (ID: ${user.id}) berhasil ditautkan ke Telegram chat ID: ${chatId} (${tgUsername})`);
}

/**
 * Broadcast Cloudflare Tunnel URL to relevant clients & users
 */
async function broadcastCloudflareUrlToClient({ port, url, name, isRefresh = false }) {
  if (!url) return { success: false, message: 'URL kosong' };

  const token = getSetting('telegram_bot_token', '');
  const isActive = getSetting('telegram_bot_active', '1') === '1';
  if (!token || !isActive) {
    console.log(`[Telegram] Broadcast dilewati: Telegram bot belum aktif atau token kosong.`);
    return { success: false, message: 'Telegram Bot tidak aktif' };
  }

  const db = getDb();

  // Find client app(s) registered for this port
  const apps = db.prepare('SELECT * FROM client_apps WHERE internal_port = ?').all(port) || [];
  
  // Find users to notify
  const targetUsers = new Map();

  for (const app of apps) {
    if (app.assigned_user_id) {
      const user = db.prepare('SELECT * FROM users WHERE id = ? AND telegram_chat_id IS NOT NULL AND telegram_notifications = 1').get(app.assigned_user_id);
      if (user && user.telegram_chat_id) {
        targetUsers.set(user.telegram_chat_id, { user, app });
      }
    }

    // Also match by client_email if matching username/email
    if (app.client_email) {
      const userByEmail = db.prepare('SELECT * FROM users WHERE username = ? AND telegram_chat_id IS NOT NULL AND telegram_notifications = 1').get(app.client_email);
      if (userByEmail && userByEmail.telegram_chat_id) {
        targetUsers.set(userByEmail.telegram_chat_id, { user: userByEmail, app });
      }
    }
  }

  // Also include all admin users who have linked Telegram
  const adminUsers = db.prepare("SELECT * FROM users WHERE role = 'admin' AND telegram_chat_id IS NOT NULL AND telegram_notifications = 1").all() || [];
  for (const admin of adminUsers) {
    if (!targetUsers.has(admin.telegram_chat_id)) {
      const mainApp = apps[0] || { name: name || `Port ${port}`, client_name: 'Internal Dev & System', category: 'Mission Control' };
      targetUsers.set(admin.telegram_chat_id, { user: admin, app: mainApp, isAdmin: true });
    }
  }

  // Also include adminChatId if configured in settings
  const adminChatId = getSetting('telegram_admin_chat_id', '');
  if (adminChatId && !targetUsers.has(adminChatId)) {
    const adminApp = apps[0] || { name: name || `Port ${port}`, client_name: 'Internal Server', category: 'Web App' };
    targetUsers.set(adminChatId, { user: { full_name: 'Administrator', username: 'admin' }, app: adminApp, isAdmin: true });
  }

  if (targetUsers.size === 0) {
    console.log(`[Telegram] Port ${port} aktif (${url}), namun tidak ada user dengan Telegram aktif yang terhubung.`);
    return { success: true, count: 0, message: 'Tidak ada user Telegram yang terhubung untuk port ini' };
  }

  const results = [];
  const nowStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  for (const [chatId, { user, app, isAdmin }] of targetUsers.entries()) {
    const appTitle = app?.name || name || `Port ${port}`;
    const clientTitle = app?.client_name || 'Aplikasi Terdaftar';
    const categoryTitle = app?.category || 'Web Application';

    const messageHtml = `
🚀 <b>Aplikasi Klien Diperbarui!</b>

🏢 <b>Klien</b>: <b>${escapeHtml(clientTitle)}</b>
📦 <b>Aplikasi</b>: <b>${escapeHtml(appTitle)}</b>
🏷️ <b>Kategori</b>: ${escapeHtml(categoryTitle)}
🔌 <b>Internal Port</b>: <code>${port}</code>

🌐 <b>Link Akses Cloudflare:</b>
👉 <a href="${url}"><b>${url}</b></a>

⏱️ <b>Waktu Update</b>: <code>${nowStr} WIB</code>
💡 <i>Link ini langsung online dan dapat dibagikan kepada tim Anda dengan aman.</i>
`;

    try {
      await sendTelegramMessage(chatId, messageHtml, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🚀 Buka Aplikasi Klien', url: url }
            ]
          ]
        }
      });
      results.push({ chatId, success: true, user: user.username });
      console.log(`[Telegram] 📢 Broadcast link port ${port} terkirim ke ${user.full_name} (${chatId})`);
    } catch (err) {
      console.error(`[Telegram] ❌ Gagal kirim ke ${chatId}:`, err.message);
      results.push({ chatId, success: false, error: err.message });
    }
  }

  return {
    success: true,
    count: results.filter(r => r.success).length,
    total: results.length,
    results
  };
}

/**
 * Long-polling worker loop for Telegram updates
 */
async function startTelegramPolling() {
  const token = getSetting('telegram_bot_token', '');
  const isActive = getSetting('telegram_bot_active', '1') === '1';

  if (!token || !isActive) {
    isPolling = false;
    return;
  }

  if (isPolling) return;
  isPolling = true;

  console.log('[Telegram] 🤖 Memulai Telegram Bot polling daemon...');

  try {
    const bot = await testTelegramBot(token);
    console.log(`[Telegram] ✅ Bot terhubung: @${bot.bot_username} (${bot.bot_name})`);
  } catch (err) {
    console.warn(`[Telegram] ⚠️ Gagal inisialisasi bot: ${err.message}`);
  }

  pollingAbortController = new AbortController();

  (async () => {
    while (isPolling) {
      const currentToken = getSetting('telegram_bot_token', '');
      const currentActive = getSetting('telegram_bot_active', '1') === '1';

      if (!currentToken || !currentActive) {
        isPolling = false;
        break;
      }

      try {
        const url = `https://api.telegram.org/bot${currentToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=15`;
        const res = await fetch(url, {
          signal: AbortSignal.timeout(25000)
        });

        if (!res.ok) {
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        const data = await res.json();
        if (data.ok && Array.isArray(data.result)) {
          for (const update of data.result) {
            lastUpdateId = Math.max(lastUpdateId, update.update_id);
            try {
              await handleTelegramUpdate(update);
            } catch (updateErr) {
              console.error('[Telegram] Error processing update:', updateErr);
            }
          }
        }
      } catch (err) {
        if (!isPolling) break;
        // Wait 5 seconds on connection error before retrying
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  })();
}

/**
 * Stop polling worker
 */
function stopTelegramPolling() {
  isPolling = false;
  if (pollingAbortController) {
    try { pollingAbortController.abort(); } catch (_) {}
    pollingAbortController = null;
  }
  console.log('[Telegram] ⏹️ Telegram Bot polling dihentikan.');
}

/**
 * Restart Telegram Bot
 */
async function restartTelegramBot() {
  stopTelegramPolling();
  await new Promise(r => setTimeout(r, 500));
  await startTelegramPolling();
}

// Auto-start on file load
setTimeout(() => {
  startTelegramPolling().catch(() => {});
}, 2000);

module.exports = {
  getTelegramConfig,
  testTelegramBot,
  sendTelegramMessage,
  getUserTelegramAuth,
  unlinkUserTelegram,
  broadcastCloudflareUrlToClient,
  startTelegramPolling,
  stopTelegramPolling,
  restartTelegramBot,
  setSetting,
  getSetting
};
