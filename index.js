const express = require('express');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ strict: false }));

const PORT = process.env.PORT || 3000;

// Telegram API bilgileri (Telegram'dan alınan resmi istemci bilgileri)
const API_ID = 2040;
const API_HASH = 'b18441a1ff607e10a989891a5462e627';

const DATA_FILE = path.join(__dirname, 'data.json');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

// Sessions klasörünü oluştur
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ─── Veri Yönetimi ───────────────────────────────────────────────────────────
const DEFAULT_DATA = {
  accounts: {},      // { accountId: { phone, name, connected } }
  botTokens: {},     // { tokenId: { token, name } }
  bots: {},          // { botName: { ...config, accountId veya tokenId } }
  botStates: {},
  logs: []
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const d = JSON.parse(raw);
      for (const k of Object.keys(DEFAULT_DATA)) {
        if (!(k in d)) d[k] = JSON.parse(JSON.stringify(DEFAULT_DATA[k]));
      }
      return d;
    }
  } catch (e) { console.error('Data okunamadı:', e.message); }
  return JSON.parse(JSON.stringify(DEFAULT_DATA));
}

function saveData() {
  data.logs = globalLogs;
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8'); } catch (e) { console.error('Data kaydedilemedi:', e.message); }
}

let data = loadData();
let globalLogs = data.logs || [];

// ─── Log Sistemi ──────────────────────────────────────────────────────────────
function addLog(msg, type = 'info') {
  const entry = { msg: String(msg), type, time: new Date().toLocaleTimeString('tr-TR') };
  globalLogs.unshift(entry);
  if (globalLogs.length > 500) globalLogs.length = 500;
  saveData();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

// ─── Aktif bağlantılar (bellekte) ────────────────────────────────────────────
// accounts: { accountId: TelegramClient }
// tokenClients: { tokenId: TelegramClient }
const activeClients = {};   // accountId -> TelegramClient (kullanıcı hesabı)
const tokenClients = {};    // tokenId -> TelegramClient (bot token)

// Geçici auth durumu (giriş sırasında kullanılır)
const authSessions = {};    // accountId -> { step, phone, phoneCodeHash, client }

// ─── Oturum dosyası yönetimi ─────────────────────────────────────────────────
function sessionFile(accountId) {
  return path.join(SESSIONS_DIR, `${accountId}.session`);
}

function saveSession(accountId, sessionStr) {
  try { fs.writeFileSync(sessionFile(accountId), sessionStr, 'utf8'); } catch (e) { console.error('Oturum kaydedilemedi:', e.message); }
}

function loadSession(accountId) {
  try {
    const f = sessionFile(accountId);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '';
  } catch (e) { return ''; }
}

function deleteSession(accountId) {
  try { if (fs.existsSync(sessionFile(accountId))) fs.unlinkSync(sessionFile(accountId)); } catch (e) {}
}

// ─── Hesap Otomatik Giriş ────────────────────────────────────────────────────
async function autoConnectAccount(accountId) {
  const saved = loadSession(accountId);
  if (!saved) return false;

  try {
    const client = new TelegramClient(new StringSession(saved), API_ID, API_HASH, {
      connectionRetries: 5,
      useWSS: true
    });
    await client.connect();
    if (await client.isUserAuthorized()) {
      activeClients[accountId] = client;
      if (data.accounts[accountId]) data.accounts[accountId].connected = true;
      addLog(`✅ [${accountId}] Oturum otomatik yüklendi.`, 'success');
      saveData();
      return true;
    }
    await client.disconnect();
  } catch (e) {
    addLog(`Oturum yüklenemedi [${accountId}]: ${e.message}`, 'error');
  }
  return false;
}

// ─── Bot Token Bağlantısı ────────────────────────────────────────────────────
async function connectBotToken(tokenId) {
  const tokenData = data.botTokens[tokenId];
  if (!tokenData) return false;

  try {
    const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
      connectionRetries: 5,
      useWSS: true
    });
    await client.start({ botAuthToken: tokenData.token });
    tokenClients[tokenId] = client;
    addLog(`🤖 [${tokenId}] Bot token bağlandı.`, 'success');
    return true;
  } catch (e) {
    addLog(`Bot token hatası [${tokenId}]: ${e.message}`, 'error');
    return false;
  }
}

// ─── Başlangıçta tümünü bağla ────────────────────────────────────────────────
async function autoConnectAll() {
  for (const accountId of Object.keys(data.accounts)) {
    await autoConnectAccount(accountId);
  }
  for (const tokenId of Object.keys(data.botTokens)) {
    await connectBotToken(tokenId);
  }
  // Çalışıyor olarak işaretlenmiş botları başlat
  for (const botName of Object.keys(data.bots)) {
    if (data.bots[botName].running) {
      data.botStates[botName] = { running: true };
      startBotSpam(botName);
      addLog(`🤖 Otomatik başlatıldı: ${botName}`, 'success');
    }
  }
}

// ─── KEEP-ALIVE ───────────────────────────────────────────────────────────────
async function keepAlive() {
  const host = process.env.RENDER_EXTERNAL_HOSTNAME || process.env.RENDER_INTERNAL_HOSTNAME;
  if (host) {
    try { await fetch(`https://${host}/api/ping`, { timeout: 8000 }); } catch (e) {}
  }
}
setInterval(keepAlive, 10 * 1000);

// ─── PING ─────────────────────────────────────────────────────────────────────
app.get('/api/ping', (_req, res) => res.json({ ok: true }));

// ═══════════════════════════════════════════════════════════════════════════════
// HESAP (USERBOT) API
// ═══════════════════════════════════════════════════════════════════════════════

// Tüm durum (hesaplar, botlar, loglar)
app.get('/api/status', (_req, res) => {
  const accounts = {};
  for (const [id, acc] of Object.entries(data.accounts)) {
    accounts[id] = {
      id,
      phone: acc.phone,
      name: acc.name || acc.phone,
      connected: !!(activeClients[id])
    };
  }

  const botTokens = {};
  for (const [id, t] of Object.entries(data.botTokens)) {
    botTokens[id] = {
      id,
      name: t.name,
      connected: !!(tokenClients[id])
    };
  }

  const bots = {};
  for (const [name, bot] of Object.entries(data.bots)) {
    bots[name] = {
      name,
      chatId: bot.chatId,
      messagesCount: (bot.messages || []).length,
      running: !!(data.botStates[name]?.running),
      delay: bot.delay,
      typingDelay: bot.typingDelay,
      prefix: bot.prefix,
      usePrefix: bot.usePrefix,
      accountId: bot.accountId || null,
      tokenId: bot.tokenId || null,
      stats: bot.stats || { sent: 0, errors: 0, loops: 0 }
    };
  }

  res.json({
    accounts,
    botTokens,
    bots,
    logs: globalLogs.slice(0, 80)
  });
});

// ── Hesap Ekle: Kod Gönder ────────────────────────────────────────────────────
app.post('/api/account/send-code', async (req, res) => {
  const { phone, accountId } = req.body;
  if (!phone) return res.json({ ok: false, error: 'Telefon numarası gerekli' });

  const id = accountId || ('acc_' + Date.now());

  try {
    // Varolan geçici istemciyi kapat
    if (authSessions[id]?.client) {
      try { await authSessions[id].client.disconnect(); } catch (e) {}
    }

    const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
      connectionRetries: 5,
      useWSS: true
    });
    await client.connect();

    const result = await client.sendCode({ apiId: API_ID, apiHash: API_HASH }, phone);
    authSessions[id] = { step: 'code_sent', phone, phoneCodeHash: result.phoneCodeHash, client };

    addLog(`📱 [${phone}] Doğrulama kodu gönderildi.`, 'success');
    res.json({ ok: true, accountId: id });
  } catch (e) {
    addLog('Kod gönderilemedi: ' + e.message, 'error');
    res.json({ ok: false, error: e.message });
  }
});

// ── Hesap Ekle: Kodu Doğrula ─────────────────────────────────────────────────
app.post('/api/account/verify-code', async (req, res) => {
  const { accountId, code } = req.body;
  if (!accountId || !code) return res.json({ ok: false, error: 'accountId ve code gerekli' });

  const sess = authSessions[accountId];
  if (!sess) return res.json({ ok: false, error: 'Önce kod gönderin' });

  try {
    await sess.client.invoke(new Api.auth.SignIn({
      phoneNumber: sess.phone,
      phoneCodeHash: sess.phoneCodeHash,
      phoneCode: code
    }));

    const sessionStr = sess.client.session.save();
    saveSession(accountId, sessionStr);
    activeClients[accountId] = sess.client;

    data.accounts[accountId] = { phone: sess.phone, name: sess.phone, connected: true };
    saveData();
    delete authSessions[accountId];

    addLog(`✅ [${sess.phone}] Giriş başarılı, oturum kaydedildi.`, 'success');
    res.json({ ok: true, accountId });
  } catch (e) {
    if (e.message.includes('SESSION_PASSWORD_NEEDED')) {
      sess.step = 'need_2fa';
      res.json({ ok: true, need2fa: true, accountId });
    } else {
      res.json({ ok: false, error: e.message });
    }
  }
});

// ── Hesap Ekle: 2FA ──────────────────────────────────────────────────────────
app.post('/api/account/verify-2fa', async (req, res) => {
  const { accountId, password } = req.body;
  if (!accountId || !password) return res.json({ ok: false, error: 'accountId ve password gerekli' });

  const sess = authSessions[accountId];
  if (!sess) return res.json({ ok: false, error: 'Oturum bulunamadı' });

  try {
    const { computeCheck } = require('telegram/Password');
    const srpData = await sess.client.invoke(new Api.account.GetPassword());
    const check = await computeCheck(srpData, password);
    await sess.client.invoke(new Api.auth.CheckPassword({ password: check }));

    const sessionStr = sess.client.session.save();
    saveSession(accountId, sessionStr);
    activeClients[accountId] = sess.client;

    data.accounts[accountId] = { phone: sess.phone, name: sess.phone, connected: true };
    saveData();
    delete authSessions[accountId];

    addLog(`✅ [${sess.phone}] 2FA doğrulandı.`, 'success');
    res.json({ ok: true, accountId });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── Hesap Çıkış ──────────────────────────────────────────────────────────────
app.post('/api/account/logout', async (req, res) => {
  const { accountId } = req.body;
  if (!accountId) return res.json({ ok: false, error: 'accountId gerekli' });

  const client = activeClients[accountId];
  if (client) {
    try { await client.invoke(new Api.auth.LogOut({})); } catch (e) {}
    try { await client.disconnect(); } catch (e) {}
    delete activeClients[accountId];
  }
  deleteSession(accountId);
  if (data.accounts[accountId]) data.accounts[accountId].connected = false;
  // Bu hesaba bağlı botları durdur
  for (const [name, bot] of Object.entries(data.bots)) {
    if (bot.accountId === accountId && data.botStates[name]?.running) {
      data.botStates[name].running = false;
      bot.running = false;
    }
  }
  delete data.accounts[accountId];
  saveData();
  addLog(`🚪 [${accountId}] Çıkış yapıldı ve hesap silindi.`, 'warn');
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BOT TOKEN API
// ═══════════════════════════════════════════════════════════════════════════════

// Bot Token Ekle
app.post('/api/token/add', async (req, res) => {
  const { token, name } = req.body;
  if (!token) return res.json({ ok: false, error: 'Token gerekli' });
  if (!name) return res.json({ ok: false, error: 'İsim gerekli' });

  const tokenId = 'tok_' + Date.now();
  data.botTokens[tokenId] = { token, name };
  saveData();

  const ok = await connectBotToken(tokenId);
  if (!ok) {
    delete data.botTokens[tokenId];
    saveData();
    return res.json({ ok: false, error: 'Token bağlanamadı, geçersiz olabilir' });
  }

  res.json({ ok: true, tokenId });
});

// Bot Token Sil
app.post('/api/token/remove', async (req, res) => {
  const { tokenId } = req.body;
  if (!tokenId) return res.json({ ok: false, error: 'tokenId gerekli' });

  const client = tokenClients[tokenId];
  if (client) { try { await client.disconnect(); } catch (e) {} delete tokenClients[tokenId]; }

  // Bu tokena bağlı botları durdur
  for (const [name, bot] of Object.entries(data.bots)) {
    if (bot.tokenId === tokenId && data.botStates[name]?.running) {
      data.botStates[name].running = false;
      bot.running = false;
    }
  }
  delete data.botTokens[tokenId];
  saveData();
  addLog(`🗑️ [${tokenId}] Token silindi.`, 'warn');
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BOT (SPAM) API
// ═══════════════════════════════════════════════════════════════════════════════

// Bot Ekle
app.post('/api/bot/add', (req, res) => {
  const { name, chatId, messages, delay, typingDelay, prefix, usePrefix, accountId, tokenId } = req.body;
  if (!name) return res.json({ ok: false, error: 'Bot adı gerekli' });
  if (data.bots[name]) return res.json({ ok: false, error: 'Bu isimde bot zaten var' });
  if (!chatId) return res.json({ ok: false, error: 'Chat ID gerekli' });
  if (!messages || messages.length === 0) return res.json({ ok: false, error: 'En az 1 mesaj girin' });
  if (!accountId && !tokenId) return res.json({ ok: false, error: 'Hesap veya bot token seçin' });
  if (accountId && !activeClients[accountId]) return res.json({ ok: false, error: 'Seçilen hesap bağlı değil' });
  if (tokenId && !tokenClients[tokenId]) return res.json({ ok: false, error: 'Seçilen token bağlı değil' });

  data.bots[name] = {
    name,
    chatId,
    messages: messages.filter(m => m.trim()),
    delay: delay || 1000,
    typingDelay: typingDelay || 2000,
    prefix: prefix || '',
    usePrefix: usePrefix || false,
    accountId: accountId || null,
    tokenId: tokenId || null,
    running: false,
    stats: { sent: 0, errors: 0, loops: 0 }
  };
  saveData();
  addLog(`🤖 Bot eklendi: ${name}`, 'success');
  res.json({ ok: true });
});

// Bot Güncelle
app.post('/api/bot/update', (req, res) => {
  const { name, chatId, messages, delay, typingDelay, prefix, usePrefix } = req.body;
  if (!data.bots[name]) return res.json({ ok: false, error: 'Bot bulunamadı' });
  const bot = data.bots[name];
  if (chatId !== undefined) bot.chatId = chatId;
  if (messages !== undefined) bot.messages = messages.filter(m => m.trim());
  if (delay !== undefined) bot.delay = delay;
  if (typingDelay !== undefined) bot.typingDelay = typingDelay;
  if (prefix !== undefined) bot.prefix = prefix;
  if (usePrefix !== undefined) bot.usePrefix = usePrefix;
  saveData();
  addLog(`✏️ Bot güncellendi: ${name}`, 'info');
  res.json({ ok: true });
});

// Bot Sil
app.post('/api/bot/remove', (req, res) => {
  const { name } = req.body;
  if (!data.bots[name]) return res.json({ ok: false, error: 'Bot bulunamadı' });
  if (data.botStates[name]?.running) data.botStates[name].running = false;
  delete data.bots[name];
  delete data.botStates[name];
  saveData();
  addLog(`🗑️ Bot silindi: ${name}`, 'warn');
  res.json({ ok: true });
});

// Bot Başlat
app.post('/api/bot/start', async (req, res) => {
  const { name } = req.body;
  if (!data.bots[name]) return res.json({ ok: false, error: 'Bot bulunamadı' });
  const bot = data.bots[name];

  if (bot.accountId && !activeClients[bot.accountId])
    return res.json({ ok: false, error: 'Hesap bağlı değil' });
  if (bot.tokenId && !tokenClients[bot.tokenId])
    return res.json({ ok: false, error: 'Bot token bağlı değil' });
  if (data.botStates[name]?.running)
    return res.json({ ok: false, error: 'Bot zaten çalışıyor' });

  data.botStates[name] = { running: true };
  bot.running = true;
  saveData();
  addLog(`🚀 Bot başlatıldı: ${name}`, 'success');
  startBotSpam(name);
  res.json({ ok: true });
});

// Bot Durdur
app.post('/api/bot/stop', (req, res) => {
  const { name } = req.body;
  if (!data.bots[name]) return res.json({ ok: false, error: 'Bot bulunamadı' });
  if (data.botStates[name]?.running) {
    data.botStates[name].running = false;
    data.bots[name].running = false;
    saveData();
    addLog(`⏹ Bot durduruldu: ${name}`, 'warn');
  }
  res.json({ ok: true });
});

// ─── Spam Döngüsü ─────────────────────────────────────────────────────────────
async function startBotSpam(botName) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const state = data.botStates[botName];
  if (!state?.running) return;

  while (state.running) {
    const bot = data.bots[botName];
    if (!bot || !bot.messages?.length || !bot.chatId) { await sleep(3000); continue; }

    // Hangi istemciyi kullanacağız?
    const client = bot.accountId ? activeClients[bot.accountId] : (bot.tokenId ? tokenClients[bot.tokenId] : null);
    if (!client) {
      addLog(`❌ [${botName}] Bağlı istemci yok!`, 'error');
      await sleep(5000);
      continue;
    }

    bot.stats.loops++;

    for (let i = 0; i < bot.messages.length; i++) {
      if (!state.running) break;

      let msg = bot.messages[i];
      if (bot.usePrefix && bot.prefix) msg = bot.prefix + ' ' + msg;

      try {
        // Typing efekti (yalnızca kullanıcı hesapları için)
        if (bot.accountId) {
          try {
            await client.invoke(new Api.messages.SetTyping({
              peer: bot.chatId,
              action: new Api.SendMessageTypingAction()
            }));
          } catch (e) {}
          if (bot.typingDelay > 0) await sleep(bot.typingDelay);
        }

        if (!state.running) break;

        await client.sendMessage(bot.chatId, { message: msg });
        bot.stats.sent++;
        addLog(`✓ [${botName}] ${msg.substring(0, 40)}`, 'success');
        saveData();

      } catch (e) {
        bot.stats.errors++;
        addLog(`✗ [${botName}] ${e.message.substring(0, 60)}`, 'error');

        if (e.message.includes('FLOOD_WAIT')) {
          const secs = parseInt((e.message.match(/\d+/) || ['10'])[0]);
          addLog(`⏳ FloodWait ${secs}sn bekleniyor...`, 'warn');
          await sleep(secs * 1000);
        }
      }

      if (bot.delay > 0 && state.running) await sleep(bot.delay);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTML ARAYÜZÜ
// ═══════════════════════════════════════════════════════════════════════════════
const HTML = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>kemal patron manager</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,sans-serif;background:#07070f;color:#e2e8f0;min-height:100vh}
.header{text-align:center;padding:36px 20px 24px;background:linear-gradient(160deg,#0d0d1f,#12121e)}
.badge{display:inline-block;background:#7c3aed18;border:1px solid #7c3aed40;border-radius:100px;padding:5px 14px;font-size:11px;color:#a855f7;margin-bottom:14px}
h1{font-size:40px;background:linear-gradient(135deg,#fff,#a855f7,#fbbf24);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.sub{color:#475569;font-size:12px;margin-top:6px}
.stats{display:flex;justify-content:center;gap:36px;margin-top:20px;flex-wrap:wrap}
.stat-value{font-size:30px;font-weight:800;background:linear-gradient(135deg,#a855f7,#fbbf24);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.stat-label{font-size:10px;color:#475569;text-transform:uppercase;letter-spacing:.5px}
.nav{display:flex;justify-content:center;gap:8px;padding:16px 20px;border-bottom:1px solid #1e1e30;flex-wrap:wrap}
.nav-btn{border:1px solid #1e1e30;background:#0d0d14;color:#64748b;border-radius:10px;padding:8px 18px;cursor:pointer;font-size:12px;font-weight:600;transition:all .2s}
.nav-btn.active,.nav-btn:hover{background:#7c3aed;border-color:#7c3aed;color:#fff}
.tab{display:none;max-width:1200px;margin:24px auto;padding:0 20px}
.tab.active{display:block}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:20px}
.card{background:#0d0d14;border:1px solid #1e1e30;border-radius:18px;padding:20px}
.card-title{font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin-bottom:16px;display:flex;align-items:center;gap:8px}
label{font-size:11px;font-weight:600;color:#94a3b8;display:block;margin-bottom:4px;margin-top:10px}
input,textarea,select{width:100%;background:#12121e;border:1px solid #1e1e30;border-radius:10px;padding:10px 12px;color:#e2e8f0;font-size:13px;outline:none}
input:focus,textarea:focus,select:focus{border-color:#7c3aed}
textarea{resize:vertical;min-height:90px;font-family:monospace}
select option{background:#0d0d14}
.btn{border:none;border-radius:10px;padding:10px 16px;font-weight:600;cursor:pointer;font-size:12px;transition:all .2s;display:inline-flex;align-items:center;gap:6px}
.btn-primary{background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff}
.btn-success{background:linear-gradient(135deg,#10b981,#059669);color:#fff}
.btn-danger{background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff}
.btn-warning{background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff}
.btn-secondary{background:#1e1e30;color:#94a3b8}
.btn-sm{padding:6px 12px;font-size:11px;border-radius:8px}
.btn-full{width:100%;margin-top:12px;justify-content:center}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.acc-item,.bot-item,.tok-item{background:#12121e;border:1px solid #1e1e30;border-radius:12px;padding:14px;margin-bottom:10px}
.item-head{display:flex;justify-content:space-between;align-items:center}
.item-name{font-weight:700;color:#a855f7;font-size:13px}
.item-meta{font-size:11px;color:#64748b;margin-top:6px}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px}
.dot-green{background:#10b981;box-shadow:0 0 6px #10b981}
.dot-red{background:#ef4444}
.dot-gray{background:#475569}
.badge-connected{display:inline-block;padding:3px 10px;border-radius:20px;font-size:10px;font-weight:600;background:#10b98118;color:#10b981;border:1px solid #10b98130}
.badge-disconnected{display:inline-block;padding:3px 10px;border-radius:20px;font-size:10px;font-weight:600;background:#ef444418;color:#ef4444;border:1px solid #ef444430}
.logs-box{background:#09090f;border:1px solid #1e1e30;border-radius:14px;padding:16px;max-height:340px;overflow-y:auto;font-family:monospace;font-size:11px}
.log-row{display:flex;gap:10px;padding:3px 6px;border-radius:5px}
.log-time{color:#334155;min-width:60px}
.log-success{color:#10b981}
.log-error{color:#f87171}
.log-warn{color:#fbbf24}
.log-info{color:#64748b}
.switch{position:relative;display:inline-block;width:38px;height:20px;flex-shrink:0}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;cursor:pointer;inset:0;background:#1e1e30;border-radius:20px;transition:.3s}
.slider:before{position:absolute;content:"";height:14px;width:14px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.3s}
input:checked+.slider{background:#a855f7}
input:checked+.slider:before{transform:translateX(18px)}
.flex-center{display:flex;align-items:center;gap:8px}
.auth-forms>div{display:none}
.auth-forms>div.visible{display:block}
.empty{text-align:center;padding:40px;color:#334155;font-size:13px}
</style>
</head>
<body>

<div class="header">
  <div class="badge">yenilmezlik</div>
  <h1>kemal patron Userbot Manager</h1>
  <p class="sub">:)</p>
  <div class="stats">
    <div class="stat"><div class="stat-value" id="sAccounts">0</div><div class="stat-label">Hesap</div></div>
    <div class="stat"><div class="stat-value" id="sTokens">0</div><div class="stat-label">Bot Token</div></div>
    <div class="stat"><div class="stat-value" id="sBots">0</div><div class="stat-label">Toplam Bot</div></div>
    <div class="stat"><div class="stat-value" id="sRunning">0</div><div class="stat-label">Aktif Bot</div></div>
    <div class="stat"><div class="stat-value" id="sSent">0</div><div class="stat-label">Toplam Gönderi</div></div>
  </div>
</div>

<div class="nav">
  <button class="nav-btn active" onclick="showTab('tab-accounts')">👤 Hesaplar</button>
  <button class="nav-btn" onclick="showTab('tab-tokens')">🔑 Bot Token</button>
  <button class="nav-btn" onclick="showTab('tab-bots')">🤖 Botlar</button>
  <button class="nav-btn" onclick="showTab('tab-logs')">📋 Loglar</button>
</div>

<!-- HESAPLAR -->
<div class="tab active" id="tab-accounts">
  <div class="grid2">
    <div class="card">
      <div class="card-title">➕ Yeni Hesap Ekle</div>
      <div class="auth-forms" id="authForms">
        <div class="visible" id="f-phone">
          <label>📱 Telefon Numarası</label>
          <input type="tel" id="inp-phone" placeholder="+905551234567">
          <button class="btn btn-primary btn-full" onclick="sendCode()">📱 Kod Gönder</button>
        </div>
        <div id="f-code">
          <label>🔢 Doğrulama Kodu</label>
          <input type="text" id="inp-code" placeholder="12345" maxlength="6">
          <button class="btn btn-success btn-full" onclick="verifyCode()">✅ Doğrula</button>
          <button class="btn btn-secondary btn-full" onclick="resetAuthForm()">← Geri</button>
        </div>
        <div id="f-2fa">
          <label>🔐 2FA Şifresi</label>
          <input type="password" id="inp-2fa" placeholder="Şifrenizi girin">
          <button class="btn btn-success btn-full" onclick="verify2FA()">✅ Doğrula</button>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">👤 Bağlı Hesaplar</div>
      <div id="acc-list"><div class="empty">Henüz hesap eklenmedi</div></div>
    </div>
  </div>
</div>

<!-- BOT TOKEN -->
<div class="tab" id="tab-tokens">
  <div class="grid2">
    <div class="card">
      <div class="card-title">🔑 Bot Token Ekle</div>
      <label>📛 İsim (Tanımlayıcı)</label>
      <input type="text" id="inp-tok-name" placeholder="Botum">
      <label>🔑 Bot Token</label>
      <input type="text" id="inp-tok-token" placeholder="123456:ABCdef...">
      <button class="btn btn-primary btn-full" onclick="addToken()">➕ Token Ekle</button>
    </div>
    <div class="card">
      <div class="card-title">🔑 Kayıtlı Token'lar</div>
      <div id="tok-list"><div class="empty">Henüz token eklenmedi</div></div>
    </div>
  </div>
</div>

<!-- BOTLAR -->
<div class="tab" id="tab-bots">
  <div class="grid2">
    <div class="card">
      <div class="card-title">➕ Yeni Bot Ekle</div>
      <label>📛 Bot Adı</label>
      <input type="text" id="inp-bot-name" placeholder="ornek_bot">
      <label>🎯 Hedef Chat ID / @username</label>
      <input type="text" id="inp-bot-chat" placeholder="-1001234567890 veya @username">
      <label>📝 Mesajlar (Her satır bir mesaj)</label>
      <textarea id="inp-bot-msgs" placeholder="Mesaj 1&#10;Mesaj 2&#10;Mesaj 3"></textarea>
      <div class="row">
        <div style="flex:1"><label>⏱️ Aralık (ms)</label><input type="number" id="inp-bot-delay" value="1000"></div>
        <div style="flex:1"><label>✏️ Typing (ms)</label><input type="number" id="inp-bot-typing" value="2000"></div>
      </div>
      <div class="row">
        <div style="flex:2"><label>🏷️ Prefix</label><input type="text" id="inp-bot-prefix" placeholder="@tag"></div>
        <div style="flex:1"><label class="flex-center">Aktif <label class="switch"><input type="checkbox" id="inp-bot-useprefix"><span class="slider"></span></label></label></div>
      </div>
      <label>🔗 Bağlantı Türü</label>
      <select id="inp-bot-src" onchange="updateSourceSelect()">
        <option value="">-- Seçin --</option>
      </select>
      <button class="btn btn-primary btn-full" onclick="addBot()">➕ Bot Ekle</button>
    </div>
    <div class="card" style="max-height:680px;overflow-y:auto">
      <div class="card-title">🤖 Bot Listesi</div>
      <div id="bot-list"><div class="empty">Henüz bot eklenmedi</div></div>
    </div>
  </div>
</div>

<!-- LOGLAR -->
<div class="tab" id="tab-logs">
  <div class="card">
    <div class="card-title">📋 Canlı Loglar</div>
    <div class="logs-box" id="log-box"><div class="empty">Log bekleniyor...</div></div>
  </div>
</div>

<script>
let state = { accounts: {}, botTokens: {}, bots: {}, logs: [] };
let pendingAccountId = null;

// Sekme geçişi
function showTab(id) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  event.target.classList.add('active');
}

// API çağrısı
async function api(url, method = 'GET', body = null) {
  try {
    const opt = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opt.body = JSON.stringify(body);
    const r = await fetch(url, opt);
    return await r.json();
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── Auth Formları ─────────────────────────────────────────────────────────────
function showAuthStep(step) {
  document.querySelectorAll('#authForms > div').forEach(d => d.classList.remove('visible'));
  document.getElementById('f-' + step).classList.add('visible');
}

function resetAuthForm() {
  pendingAccountId = null;
  showAuthStep('phone');
}

async function sendCode() {
  const phone = document.getElementById('inp-phone').value.trim();
  if (!phone) return alert('Telefon numarası girin!');
  const btn = event.target; btn.disabled = true; btn.textContent = 'Gönderiliyor...';
  const res = await api('/api/account/send-code', 'POST', { phone });
  btn.disabled = false; btn.innerHTML = '📱 Kod Gönder';
  if (res.ok) { pendingAccountId = res.accountId; showAuthStep('code'); }
  else alert('Hata: ' + res.error);
}

async function verifyCode() {
  const code = document.getElementById('inp-code').value.trim();
  if (!code) return alert('Kodu girin!');
  const btn = event.target; btn.disabled = true; btn.textContent = 'Doğrulanıyor...';
  const res = await api('/api/account/verify-code', 'POST', { accountId: pendingAccountId, code });
  btn.disabled = false; btn.innerHTML = '✅ Doğrula';
  if (res.ok) {
    if (res.need2fa) { showAuthStep('2fa'); }
    else { resetAuthForm(); loadStatus(); alert('Hesap eklendi!'); }
  } else alert('Hata: ' + res.error);
}

async function verify2FA() {
  const password = document.getElementById('inp-2fa').value;
  if (!password) return alert('2FA şifresini girin!');
  const btn = event.target; btn.disabled = true; btn.textContent = 'Doğrulanıyor...';
  const res = await api('/api/account/verify-2fa', 'POST', { accountId: pendingAccountId, password });
  btn.disabled = false; btn.innerHTML = '✅ Doğrula';
  if (res.ok) { resetAuthForm(); loadStatus(); alert('Hesap eklendi!'); }
  else alert('Hata: ' + res.error);
}

async function logoutAccount(accountId) {
  if (!confirm('Bu hesabı silmek istediğinize emin misiniz?')) return;
  const res = await api('/api/account/logout', 'POST', { accountId });
  if (res.ok) loadStatus();
  else alert('Hata: ' + res.error);
}

// ── Token ─────────────────────────────────────────────────────────────────────
async function addToken() {
  const name = document.getElementById('inp-tok-name').value.trim();
  const token = document.getElementById('inp-tok-token').value.trim();
  if (!name || !token) return alert('İsim ve token gerekli!');
  const btn = event.target; btn.disabled = true; btn.textContent = 'Bağlanıyor...';
  const res = await api('/api/token/add', 'POST', { name, token });
  btn.disabled = false; btn.innerHTML = '➕ Token Ekle';
  if (res.ok) {
    document.getElementById('inp-tok-name').value = '';
    document.getElementById('inp-tok-token').value = '';
    loadStatus();
    alert('Token eklendi!');
  } else alert('Hata: ' + res.error);
}

async function removeToken(tokenId) {
  if (!confirm('Token silinsin mi?')) return;
  const res = await api('/api/token/remove', 'POST', { tokenId });
  if (res.ok) loadStatus();
  else alert('Hata: ' + res.error);
}

// ── Kaynak Select'ini Güncelle ────────────────────────────────────────────────
function updateSourceSelect() {}

function rebuildSourceSelect() {
  const sel = document.getElementById('inp-bot-src');
  const prev = sel.value;
  sel.innerHTML = '<option value="">-- Seçin --</option>';
  for (const [id, acc] of Object.entries(state.accounts)) {
    if (acc.connected) sel.innerHTML += \`<option value="acc:\${id}">👤 \${acc.name || acc.phone}</option>\`;
  }
  for (const [id, tok] of Object.entries(state.botTokens)) {
    if (tok.connected) sel.innerHTML += \`<option value="tok:\${id}">🔑 \${tok.name}</option>\`;
  }
  if (prev) sel.value = prev;
}

// ── Bot ───────────────────────────────────────────────────────────────────────
async function addBot() {
  const name = document.getElementById('inp-bot-name').value.trim();
  const chatId = document.getElementById('inp-bot-chat').value.trim();
  const msgs = document.getElementById('inp-bot-msgs').value.split('\\n').filter(m => m.trim());
  const delay = parseInt(document.getElementById('inp-bot-delay').value) || 1000;
  const typingDelay = parseInt(document.getElementById('inp-bot-typing').value) || 2000;
  const prefix = document.getElementById('inp-bot-prefix').value.trim();
  const usePrefix = document.getElementById('inp-bot-useprefix').checked;
  const src = document.getElementById('inp-bot-src').value;

  if (!name || !chatId || !msgs.length || !src) return alert('Tüm alanları doldurun ve bağlantı türü seçin!');

  const body = { name, chatId, messages: msgs, delay, typingDelay, prefix, usePrefix };
  if (src.startsWith('acc:')) body.accountId = src.slice(4);
  else body.tokenId = src.slice(4);

  const res = await api('/api/bot/add', 'POST', body);
  if (res.ok) {
    document.getElementById('inp-bot-name').value = '';
    document.getElementById('inp-bot-chat').value = '';
    document.getElementById('inp-bot-msgs').value = '';
    document.getElementById('inp-bot-prefix').value = '';
    document.getElementById('inp-bot-src').value = '';
    document.getElementById('inp-bot-useprefix').checked = false;
    loadStatus();
    alert('Bot eklendi!');
  } else alert('Hata: ' + res.error);
}

async function startBot(name) {
  const res = await api('/api/bot/start', 'POST', { name });
  if (!res.ok) alert('Hata: ' + res.error);
  else loadStatus();
}

async function stopBot(name) {
  const res = await api('/api/bot/stop', 'POST', { name });
  if (res.ok) loadStatus();
}

async function removeBot(name) {
  if (!confirm('Bot silinsin mi?')) return;
  const res = await api('/api/bot/remove', 'POST', { name });
  if (res.ok) loadStatus();
  else alert('Hata: ' + res.error);
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  // Hesaplar
  const accList = document.getElementById('acc-list');
  const accs = Object.values(state.accounts);
  if (!accs.length) { accList.innerHTML = '<div class="empty">Henüz hesap eklenmedi</div>'; }
  else {
    accList.innerHTML = accs.map(a => \`
      <div class="acc-item">
        <div class="item-head">
          <span class="item-name"><span class="dot \${a.connected?'dot-green':'dot-red'}"></span>\${a.name||a.phone}</span>
          <button class="btn btn-sm btn-danger" onclick="logoutAccount('\${a.id}')">🗑 Sil</button>
        </div>
        <div class="item-meta">\${a.connected ? '<span class="badge-connected">✅ Bağlı</span>' : '<span class="badge-disconnected">❌ Bağlı değil</span>'}</div>
      </div>\`).join('');
  }

  // Token
  const tokList = document.getElementById('tok-list');
  const toks = Object.values(state.botTokens);
  if (!toks.length) { tokList.innerHTML = '<div class="empty">Henüz token eklenmedi</div>'; }
  else {
    tokList.innerHTML = toks.map(t => \`
      <div class="tok-item">
        <div class="item-head">
          <span class="item-name"><span class="dot \${t.connected?'dot-green':'dot-red'}"></span>\${t.name}</span>
          <button class="btn btn-sm btn-danger" onclick="removeToken('\${t.id}')">🗑 Sil</button>
        </div>
        <div class="item-meta">\${t.connected ? '<span class="badge-connected">✅ Bağlı</span>' : '<span class="badge-disconnected">❌ Bağlı değil</span>'}</div>
      </div>\`).join('');
  }

  // Botlar
  rebuildSourceSelect();
  const botList = document.getElementById('bot-list');
  const bots = Object.values(state.bots);
  if (!bots.length) { botList.innerHTML = '<div class="empty">Henüz bot eklenmedi</div>'; }
  else {
    botList.innerHTML = bots.map(b => {
      const srcLabel = b.accountId
        ? ('👤 ' + (state.accounts[b.accountId]?.name || b.accountId))
        : ('🔑 ' + (state.botTokens[b.tokenId]?.name || b.tokenId));
      return \`
        <div class="bot-item">
          <div class="item-head">
            <span class="item-name"><span class="dot \${b.running?'dot-green':'dot-gray'}"></span>\${b.name}</span>
            <div class="row">
              <button class="btn btn-sm \${b.running?'btn-warning':'btn-success'}" onclick="\${b.running?'stopBot':'startBot'}('\${b.name}')">\${b.running?'⏹ Durdur':'▶ Başlat'}</button>
              <button class="btn btn-sm btn-danger" onclick="removeBot('\${b.name}')">🗑</button>
            </div>
          </div>
          <div class="item-meta">
            🎯 \${b.chatId} &nbsp;|&nbsp; 📝 \${b.messagesCount} mesaj &nbsp;|&nbsp; \${srcLabel}<br>
            📊 Gönderilen: \${(b.stats?.sent||0).toLocaleString()} &nbsp; Hata: \${b.stats?.errors||0} &nbsp; Döngü: \${b.stats?.loops||0}
          </div>
        </div>\`}).join('');
  }

  // İstatistikler
  const connAccs = Object.values(state.accounts).filter(a => a.connected).length;
  const connToks = Object.values(state.botTokens).filter(t => t.connected).length;
  const running = bots.filter(b => b.running).length;
  const sent = bots.reduce((s, b) => s + (b.stats?.sent || 0), 0);
  document.getElementById('sAccounts').textContent = Object.keys(state.accounts).length;
  document.getElementById('sTokens').textContent = Object.keys(state.botTokens).length;
  document.getElementById('sBots').textContent = bots.length;
  document.getElementById('sRunning').textContent = running;
  document.getElementById('sSent').textContent = sent.toLocaleString();

  // Loglar
  const logBox = document.getElementById('log-box');
  if (!state.logs?.length) { logBox.innerHTML = '<div class="empty">Log bekleniyor...</div>'; }
  else {
    logBox.innerHTML = state.logs.slice(0, 80).map(l => {
      const cls = 'log-' + (l.type || 'info');
      return \`<div class="log-row"><span class="log-time">[\${l.time}]</span><span class="\${cls}">\${l.msg}</span></div>\`;
    }).join('');
  }
}

async function loadStatus() {
  const res = await api('/api/status');
  if (res && !res.error) {
    state = res;
    render();
  }
}

setInterval(loadStatus, 2500);
loadStatus();
</script>
</body>
</html>`;

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(HTML);
});

// ─── Başlangıç ────────────────────────────────────────────────────────────────
autoConnectAll();

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════╗
║     👤 WAZER USERBOT MANAGER v5.0             ║
║     Çoklu Hesap · Bot Token · Kalıcı Oturum  ║
║                                               ║
║     🚀 http://localhost:${PORT}                ║
║     💾 Veriler: data.json + sessions/         ║
╚═══════════════════════════════════════════════╝
  `);
});
