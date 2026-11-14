'use strict';
/**
 * Dispara Yuna — disparo agendado de mensagens no WhatsApp
 * Node.js + Express + Socket.io + whatsapp-web.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

// ───────────────────────── Config ─────────────────────────
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TZ = process.env.APP_TZ || 'America/Maceio';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const CONTACTS_DIR = path.join(DATA_DIR, 'contacts');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const CONNECT_TIMEOUT_MS = 10 * 60 * 1000; // QR/código expira e libera memória após 10 min
const MAX_CONSECUTIVE_FAILS = 5;

if (!ADMIN_PASSWORD) {
  console.error('ERRO: defina a variável de ambiente ADMIN_PASSWORD (senha do painel).');
  process.exit(1);
}
for (const d of [DATA_DIR, SESSIONS_DIR, UPLOADS_DIR, CONTACTS_DIR]) fs.mkdirSync(d, { recursive: true });

// ───────────────────────── Armazenamento (JSON) ─────────────────────────
function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}
const db = readJson(DB_FILE, { sessions: {}, campaigns: {} });
db.sessions = db.sessions || {};
db.campaigns = db.campaigns || {};
let saveTimer = null;
function saveDb() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; try { writeJsonAtomic(DB_FILE, db); } catch (e) { console.error('saveDb', e.message); } }, 800);
}
function flushDb() { try { writeJsonAtomic(DB_FILE, db); } catch (e) { console.error('flushDb', e.message); } }
const contactsFile = (sid) => path.join(CONTACTS_DIR, `${sid}.json`);
const getContactsStored = (sid) => readJson(contactsFile(sid), []);

// ───────────────────────── Utilidades ─────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const uid = (n = 8) => crypto.randomBytes(n).toString('hex');
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };

function nowParts() {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
function inWindow(minutes, start, end) {
  const s = toMin(start), e = toMin(end);
  if (s === e) return true;
  return s < e ? minutes >= s && minutes < e : minutes >= s || minutes < e; // suporta janela que vira a noite
}
function digits(s) { return String(s || '').replace(/\D/g, ''); }

/** {nome} + variações {oi|olá|e aí} para as mensagens não ficarem idênticas */
function renderMessage(template, name) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  let out = template.replace(/\{nome\}/gi, first);
  out = out.replace(/\{([^{}|]+(?:\|[^{}|]+)+)\}/g, (_, opts) => {
    const arr = opts.split('|');
    return arr[Math.floor(Math.random() * arr.length)];
  });
  return out.replace(/[ \t]+,/g, ',').replace(/[ \t]{2,}/g, ' ').trim();
}

// ───────────────────────── Express / Socket.io ─────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_TOKEN = crypto.createHmac('sha256', ADMIN_PASSWORD).update('dispara-yuna-admin').digest('hex');
const safeEq = (a, b) => { const A = Buffer.from(String(a)); const B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };
function requireAdmin(req, res, next) {
  const t = req.get('x-admin-token') || '';
  if (!safeEq(t, ADMIN_TOKEN)) return res.status(401).json({ error: 'Não autorizado' });
  next();
}

io.on('connection', (socket) => {
  const { adminToken, connectToken } = socket.handshake.auth || {};
  if (adminToken && safeEq(adminToken, ADMIN_TOKEN)) {
    socket.join('admin');
  } else if (connectToken) {
    const s = Object.values(db.sessions).find((x) => x.token === connectToken);
    if (s) { socket.join(`s:${s.id}`); socket.emit('session', publicState(s.id)); }
  }
});

// ───────────────────────── Sessões WhatsApp ─────────────────────────
/** estado em memória: id -> { client, status, qr, code, error, busy, nextAt, manualStop, timer } */
const rt = new Map();
const getRt = (id) => {
  if (!rt.has(id)) rt.set(id, { client: null, status: 'idle', qr: null, code: null, error: null, busy: false, nextAt: 0, manualStop: false, timer: null, syncing: false });
  return rt.get(id);
};

function publicState(id) {
  const s = db.sessions[id]; const r = getRt(id);
  if (!s) return null;
  return {
    id, name: s.name, token: s.token, phone: s.phone || null,
    status: r.status, qr: r.qr, code: r.code, error: r.error, syncing: r.syncing,
    contactCount: getContactsStored(id).length, autoStart: !!s.autoStart,
  };
}
function emitSession(id) {
  const st = publicState(id);
  if (!st) return;
  io.to('admin').emit('session', st);
  // o cliente nunca recebe o token nem dados além do necessário para conectar
  const { token, ...safe } = st;
  io.to(`s:${id}`).emit('session', safe);
}
function setState(id, patch) { Object.assign(getRt(id), patch); emitSession(id); }

function cleanChromiumLocks(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) cleanChromiumLocks(p);
    else if (/^Singleton(Lock|Cookie|Socket)$/.test(entry.name)) { try { fs.rmSync(p, { force: true }); } catch {} }
  }
}

async function destroyClient(id) {
  const r = getRt(id);
  if (r.timer) { clearTimeout(r.timer); r.timer = null; }
  const c = r.client; r.client = null;
  if (c) { try { await c.destroy(); } catch {} }
}

async function startSession(id, { phone } = {}) {
  const s = db.sessions[id]; if (!s) throw new Error('Conexão não encontrada');
  const r = getRt(id);
  if (r.status === 'ready') return;
  await destroyClient(id);
  r.manualStop = false;
  setState(id, { status: 'starting', qr: null, code: null, error: null });
  cleanChromiumLocks(path.join(SESSIONS_DIR, `session-${id}`));

  const opts = {
    authStrategy: new LocalAuth({ clientId: id, dataPath: SESSIONS_DIR }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
        '--disable-extensions', '--disable-background-networking', '--no-first-run', '--mute-audio'],
    },
  };
  const num = digits(phone);
  if (num) opts.pairWithPhoneNumber = { phoneNumber: num, showNotification: true };

  const client = new Client(opts);
  r.client = client;

  client.on('qr', async (qr) => {
    try { setState(id, { status: 'qr', qr: await QRCode.toDataURL(qr, { margin: 1, width: 320 }), code: null }); } catch {}
  });
  client.on('code', (code) => setState(id, { status: 'code', code, qr: null }));
  client.on('authenticated', () => {
    if (r.timer) { clearTimeout(r.timer); r.timer = null; }
    setState(id, { status: 'authenticated', qr: null, code: null });
  });
  client.on('auth_failure', (msg) => {
    console.error(`[${s.name}] auth_failure`, msg);
    setState(id, { status: 'error', error: 'Falha na autenticação. Gere um novo QR Code.', qr: null, code: null });
  });
  client.on('ready', async () => {
    if (r.timer) { clearTimeout(r.timer); r.timer = null; }
    s.phone = client.info?.wid?.user || null;
    s.autoStart = true;
    saveDb();
    setState(id, { status: 'ready', qr: null, code: null, error: null, nextAt: Date.now() + 5000 });
    syncContacts(id).catch((e) => console.error('sync', e.message));
  });
  client.on('disconnected', async (reason) => {
    console.log(`[${s.name}] disconnected:`, reason);
    const loggedOut = String(reason).toUpperCase().includes('LOGOUT');
    await destroyClient(id);
    pauseCampaignsOfSession(id, 'WhatsApp desconectado');
    if (loggedOut || r.manualStop) {
      s.autoStart = false; saveDb();
      setState(id, { status: 'disconnected', phone: null });
    } else {
      setState(id, { status: 'disconnected' });
      setTimeout(() => { if (!r.manualStop) startSession(id).catch(() => {}); }, 15000);
    }
  });

  // QR/código não ficam abertos para sempre (economiza memória)
  r.timer = setTimeout(async () => {
    if (['qr', 'code', 'starting'].includes(getRt(id).status)) {
      await destroyClient(id);
      setState(id, { status: 'idle', qr: null, code: null, error: 'Tempo esgotado. Gere um novo código.' });
    }
  }, CONNECT_TIMEOUT_MS);

  client.initialize().catch((e) => {
    console.error(`[${s.name}] initialize`, e.message);
    setState(id, { status: 'error', error: 'Não foi possível iniciar o navegador do WhatsApp: ' + e.message.slice(0, 120) });
  });
}

async function syncContacts(id) {
  const r = getRt(id);
  if (!r.client || r.status !== 'ready') throw new Error('WhatsApp não está conectado');
  setState(id, { syncing: true });
  try {
    await sleep(4000); // dá tempo do WhatsApp Web carregar a agenda
    const all = await r.client.getContacts();
    const seen = new Set(); const list = [];
    const push = (c, saved) => {
      const server = c.id?.server;
      if (server !== 'c.us' && server !== 'lid') return;
      const number = digits(c.number || (server === 'c.us' ? c.id.user : ''));
      const key = number || c.id._serialized;
      if (seen.has(key)) return; seen.add(key);
      list.push({ id: c.id._serialized, number, saved, name: c.name || c.pushname || c.shortName || '' });
    };
    // 1) contatos salvos na agenda
    for (const c of all) { if (!c.isGroup && !c.isMe && c.isMyContact) push(c, true); }
    // 2) números NÃO salvos: quem já conversou com esse WhatsApp (conversas individuais)
    let unsavedOk = false;
    try {
      // leitura direta das conversas individuais (não depende de grupos, que às vezes quebram o getChats)
      const rows = await r.client.pupPage.evaluate(() => {
        const C = window.require('WAWebCollections');
        const out = [];
        for (const chat of C.Chat.getModelsArray()) {
          try {
            const cid = chat.id; if (!cid) continue;
            if (cid.server !== 'c.us' && cid.server !== 'lid') continue;
            const ct = (C.Contact && C.Contact.get(cid)) || chat.contact || null;
            out.push({
              id: cid._serialized, server: cid.server, user: cid.user,
              name: (ct && (ct.name || ct.shortName)) || '',
              pushname: (ct && ct.pushname) || chat.formattedTitle || chat.name || '',
              isMyContact: !!(ct && ct.isMyContact),
              phone: (ct && ct.phoneNumber && ct.phoneNumber.user) || '',
            });
          } catch (e) {}
        }
        return out;
      });
      const names = new Set(list.map((x) => (x.name || '').toLowerCase()).filter(Boolean));
      for (const x of rows) {
        const number = x.phone || (x.server === 'c.us' ? x.user : '');
        if (!number && names.has((x.name || x.pushname || '').toLowerCase())) continue; // mesma pessoa já salva (ID interno)
        push({ id: { server: x.server, user: x.user, _serialized: x.id }, number, name: x.name, pushname: x.pushname }, !!x.isMyContact);
      }
      unsavedOk = true;
    } catch (e) { console.error('chats (leitura direta)', e.stack || e.message); }
    if (!unsavedOk) {
      try {
        const chats = await r.client.getChats();
        for (const ch of chats) {
          if (ch.isGroup) continue;
          let c = null;
          try { c = await ch.getContact(); } catch {}
          if (!c || c.isMe) continue;
          if (!c.id) c = { ...c, id: ch.id };
          push(c, !!c.isMyContact);
        }
      } catch (e) { console.error('getChats', e.stack || e.message); }
    }
    list.sort((a, b) => (a.name || a.number).localeCompare(b.name || b.number, 'pt-BR'));
    writeJsonAtomic(contactsFile(id), list);
    return list.length;
  } finally {
    setState(id, { syncing: false });
  }
}

async function disconnectSession(id, { remove = false } = {}) {
  const r = getRt(id); const s = db.sessions[id];
  r.manualStop = true;
  pauseCampaignsOfSession(id, 'Desconectado manualmente');
  if (r.client) {
    try { if (r.status === 'ready') await r.client.logout(); } catch (e) { console.error('logout', e.message); }
  }
  await destroyClient(id);
  try { fs.rmSync(path.join(SESSIONS_DIR, `session-${id}`), { recursive: true, force: true }); } catch {}
  if (s) { s.autoStart = false; s.phone = null; saveDb(); }
  setState(id, { status: 'disconnected', qr: null, code: null, error: null });
}

// ───────────────────────── Campanhas ─────────────────────────
function campaignSummary(c, withRecipients = false) {
  const total = c.recipients.length;
  const sent = c.recipients.filter((x) => x.status === 'sent').length;
  const failed = c.recipients.filter((x) => x.status === 'failed').length;
  const pending = total - sent - failed;
  const now = nowParts();
  let phase = c.status;
  if (c.status === 'active') {
    if (getRt(c.sessionId).status !== 'ready') phase = 'offline';
    else if (now.date < c.startDate) phase = 'not_started';
    else if (!inWindow(now.minutes, c.windowStart, c.windowEnd)) phase = 'outside_window';
    else phase = 'sending';
  }
  const out = {
    id: c.id, sessionId: c.sessionId, name: c.name, status: c.status, phase, pauseReason: c.pauseReason || null,
    text: c.text, media: c.media ? { type: c.media.mimetype, name: c.media.originalName } : null,
    startDate: c.startDate, windowStart: c.windowStart, windowEnd: c.windowEnd,
    minDelay: c.minDelay, maxDelay: c.maxDelay, createdAt: c.createdAt,
    total, sent, failed, pending,
  };
  if (withRecipients) out.recipients = c.recipients;
  return out;
}
const emitCampaign = (c) => io.to('admin').emit('campaign', campaignSummary(c));

function pauseCampaignsOfSession(sessionId, reason) {
  for (const c of Object.values(db.campaigns)) {
    if (c.sessionId === sessionId && c.status === 'active') {
      c.status = 'paused'; c.pauseReason = reason; emitCampaign(c);
    }
  }
  saveDb();
}

async function sendOne(client, camp, rcpt) {
  const text = renderMessage(camp.text || '', rcpt.name);
  let target = rcpt.id;
  if (rcpt.number) {
    // resolve o ID atual do número (evita erros de LID depois de reiniciar)
    try { const nid = await client.getNumberId(rcpt.number); if (nid?._serialized) target = nid._serialized; else if (rcpt.id.endsWith('@c.us')) throw new Error('Número não tem WhatsApp'); }
    catch (e) { if (/não tem whatsapp/i.test(e.message)) throw e; }
  }
  if (camp.media) {
    const file = path.join(UPLOADS_DIR, camp.media.file);
    const media = MessageMedia.fromFilePath(file);
    try {
      await client.sendMessage(target, media, { caption: text || undefined, sendSeen: false });
    } catch (e) {
      // vídeos/arquivos que o navegador não consegue processar vão como documento
      await client.sendMessage(target, media, { caption: text || undefined, sendSeen: false, sendMediaAsDocument: true });
    }
  } else {
    await client.sendMessage(target, text, { sendSeen: false });
  }
}

async function tick() {
  const now = nowParts();
  for (const [id, r] of rt) {
    if (r.status !== 'ready' || !r.client || r.busy || Date.now() < r.nextAt) continue;
    const camp = Object.values(db.campaigns)
      .filter((c) => c.sessionId === id && c.status === 'active' && now.date >= c.startDate
        && inWindow(now.minutes, c.windowStart, c.windowEnd) && c.recipients.some((x) => x.status === 'pending'))
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!camp) continue;

    r.busy = true;
    const rcpt = camp.recipients.find((x) => x.status === 'pending');
    try {
      await sendOne(r.client, camp, rcpt);
      rcpt.status = 'sent'; rcpt.sentAt = Date.now(); rcpt.error = null;
      camp.failStreak = 0;
    } catch (e) {
      rcpt.status = 'failed'; rcpt.error = String(e.message || e).slice(0, 160);
      camp.failStreak = (camp.failStreak || 0) + 1;
      console.error(`[${camp.name}] falha para ${rcpt.number || rcpt.id}:`, rcpt.error);
      if (camp.failStreak >= MAX_CONSECUTIVE_FAILS) {
        camp.status = 'paused'; camp.pauseReason = `${MAX_CONSECUTIVE_FAILS} falhas seguidas — verifique a conexão e retome.`;
      }
    }
    if (camp.status === 'active' && !camp.recipients.some((x) => x.status === 'pending')) camp.status = 'done';
    r.nextAt = Date.now() + rand(camp.minDelay, camp.maxDelay) * 1000;
    r.busy = false;
    saveDb(); emitCampaign(camp);
  }
}
setInterval(() => tick().catch((e) => console.error('tick', e)), 3000);
// atualiza a "fase" (fora do horário, etc.) no painel
setInterval(() => { for (const c of Object.values(db.campaigns)) if (c.status === 'active') emitCampaign(c); }, 30000);

// ───────────────────────── Rotas: login ─────────────────────────
app.post('/api/login', (req, res) => {
  if (safeEq(req.body?.password || '', ADMIN_PASSWORD)) return res.json({ token: ADMIN_TOKEN });
  res.status(401).json({ error: 'Senha incorreta' });
});
app.get('/api/config', requireAdmin, (req, res) => res.json({ tz: TZ, today: nowParts().date }));

// ───────────────────────── Rotas: conexões ─────────────────────────
app.get('/api/sessions', requireAdmin, (req, res) => res.json(Object.keys(db.sessions).map(publicState)));

app.post('/api/sessions', requireAdmin, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Informe o nome do cliente' });
  const id = uid(4);
  db.sessions[id] = { id, name, token: uid(16), createdAt: Date.now(), phone: null, autoStart: false };
  saveDb(); emitSession(id);
  res.json(publicState(id));
});

app.post('/api/sessions/:id/start', requireAdmin, async (req, res) => {
  if (!db.sessions[req.params.id]) return res.status(404).json({ error: 'Não encontrada' });
  const mode = req.body?.mode === 'code' ? 'code' : 'qr';
  if (mode === 'code' && digits(req.body?.phone).length < 10) return res.status(400).json({ error: 'Informe o número com DDI e DDD (ex.: 5582999999999)' });
  startSession(req.params.id, { phone: mode === 'code' ? req.body.phone : null }).catch((e) => console.error(e));
  res.json({ ok: true });
});

app.post('/api/sessions/:id/sync', requireAdmin, async (req, res) => {
  try { res.json({ count: await syncContacts(req.params.id) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/sessions/:id/disconnect', requireAdmin, async (req, res) => {
  if (!db.sessions[req.params.id]) return res.status(404).json({ error: 'Não encontrada' });
  await disconnectSession(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/sessions/:id', requireAdmin, async (req, res) => {
  const id = req.params.id;
  if (!db.sessions[id]) return res.status(404).json({ error: 'Não encontrada' });
  await disconnectSession(id);
  for (const c of Object.values(db.campaigns)) {
    if (c.sessionId !== id) continue;
    if (c.media) { try { fs.rmSync(path.join(UPLOADS_DIR, c.media.file), { force: true }); } catch {} }
    delete db.campaigns[c.id];
    io.to('admin').emit('campaign_removed', c.id); // some da tela também
  }
  delete db.sessions[id]; rt.delete(id);
  try { fs.rmSync(contactsFile(id), { force: true }); } catch {}
  saveDb(); io.to('admin').emit('session_removed', id);
  res.json({ ok: true });
});

app.get('/api/sessions/:id/contacts', requireAdmin, (req, res) => {
  if (!db.sessions[req.params.id]) return res.status(404).json({ error: 'Não encontrada' });
  res.json(getContactsStored(req.params.id));
});

// ───────────────────────── Rotas: página pública do cliente ─────────────────────────
function sessionByToken(token) { return Object.values(db.sessions).find((s) => safeEq(s.token, token)); }
app.get('/api/public/:token', (req, res) => {
  const s = sessionByToken(req.params.token);
  if (!s) return res.status(404).json({ error: 'Link inválido' });
  const { token, ...safe } = publicState(s.id);
  res.json(safe);
});
app.post('/api/public/:token/start', (req, res) => {
  const s = sessionByToken(req.params.token);
  if (!s) return res.status(404).json({ error: 'Link inválido' });
  const mode = req.body?.mode === 'code' ? 'code' : 'qr';
  if (mode === 'code' && digits(req.body?.phone).length < 10) return res.status(400).json({ error: 'Digite o número com DDD (e DDI, ex.: 5582999999999)' });
  startSession(s.id, { phone: mode === 'code' ? req.body.phone : null }).catch((e) => console.error(e));
  res.json({ ok: true });
});
app.get('/c/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'connect.html')));

// ───────────────────────── Rotas: campanhas ─────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => cb(null, uid(8) + path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '')),
  }),
  limits: { fileSize: 64 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^(image|video)\//.test(file.mimetype) || file.mimetype === 'application/pdf'),
});

app.get('/api/campaigns', requireAdmin, (req, res) => {
  res.json(Object.values(db.campaigns).sort((a, b) => b.createdAt - a.createdAt).map((c) => campaignSummary(c)));
});
app.get('/api/campaigns/:id', requireAdmin, (req, res) => {
  const c = db.campaigns[req.params.id];
  if (!c) return res.status(404).json({ error: 'Não encontrada' });
  res.json(campaignSummary(c, true));
});

app.post('/api/campaigns', requireAdmin, upload.single('media'), (req, res) => {
  try {
    const b = req.body;
    const session = db.sessions[b.sessionId];
    if (!session) throw new Error('Escolha uma conexão');
    const text = String(b.text || '').trim();
    if (!text && !req.file) throw new Error('Escreva a mensagem ou anexe uma foto/vídeo');
    const windowStart = /^\d{2}:\d{2}$/.test(b.windowStart) ? b.windowStart : '09:00';
    const windowEnd = /^\d{2}:\d{2}$/.test(b.windowEnd) ? b.windowEnd : '18:00';
    if (windowStart === windowEnd) throw new Error('O horário de início e fim não podem ser iguais');
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(b.startDate) ? b.startDate : nowParts().date;
    let minDelay = Math.max(5, parseInt(b.minDelay, 10) || 20);
    let maxDelay = Math.max(minDelay, parseInt(b.maxDelay, 10) || 60);

    // destinatários
    const stored = getContactsStored(session.id);
    const byId = new Map(stored.map((c) => [c.id, c]));
    let chosen;
    if (b.recipientsMode === 'selected') {
      const ids = JSON.parse(b.contactIds || '[]');
      chosen = ids.map((i) => byId.get(i)).filter(Boolean);
    } else chosen = stored.filter((c) => b.includeUnsaved !== '0' || c.saved !== false);
    const recipients = []; const seen = new Set();
    const add = (id, number, name) => { const k = number || id; if (seen.has(k)) return; seen.add(k); recipients.push({ id, number, name, status: 'pending' }); };
    chosen.forEach((c) => add(c.id, c.number, c.name));
    String(b.extraNumbers || '').split(/[\n,;]+/).map((l) => l.trim()).filter(Boolean).forEach((line) => {
      const m = line.match(/^(.*?)[\s:-]*([+\d][\d\s().-]{7,})$/); // "Nome 5582999999999" ou só o número
      let num = digits(m ? m[2] : line); const name = m ? m[1].trim() : '';
      if (num.length === 10 || num.length === 11) num = '55' + num; // assume Brasil
      if (num.length >= 12 && num.length <= 15) add(num + '@c.us', num, name);
    });
    if (!recipients.length) throw new Error('Nenhum contato selecionado');

    const c = {
      id: uid(5), sessionId: session.id, name: String(b.name || 'Campanha').trim().slice(0, 80) || 'Campanha',
      text, media: req.file ? { file: req.file.filename, mimetype: req.file.mimetype, originalName: req.file.originalname } : null,
      startDate, windowStart, windowEnd, minDelay, maxDelay, recipients,
      status: 'active', createdAt: Date.now(), failStreak: 0,
    };
    db.campaigns[c.id] = c; saveDb(); emitCampaign(c);
    res.json(campaignSummary(c));
  } catch (e) {
    if (req.file) try { fs.rmSync(req.file.path, { force: true }); } catch {}
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/campaigns/:id/pause', requireAdmin, (req, res) => {
  const c = db.campaigns[req.params.id]; if (!c) return res.status(404).json({ error: 'Não encontrada' });
  if (c.status === 'active') { c.status = 'paused'; c.pauseReason = 'Pausada por você'; saveDb(); emitCampaign(c); }
  res.json(campaignSummary(c));
});
app.post('/api/campaigns/:id/resume', requireAdmin, (req, res) => {
  const c = db.campaigns[req.params.id]; if (!c) return res.status(404).json({ error: 'Não encontrada' });
  if (c.status === 'paused') { c.status = 'active'; c.pauseReason = null; c.failStreak = 0; saveDb(); emitCampaign(c); }
  res.json(campaignSummary(c));
});
app.post('/api/campaigns/:id/retry-failed', requireAdmin, (req, res) => {
  const c = db.campaigns[req.params.id]; if (!c) return res.status(404).json({ error: 'Não encontrada' });
  c.recipients.forEach((r) => { if (r.status === 'failed') { r.status = 'pending'; r.error = null; } });
  if (c.status === 'done') c.status = 'active';
  saveDb(); emitCampaign(c); res.json(campaignSummary(c));
});
app.delete('/api/campaigns/:id', requireAdmin, (req, res) => {
  const c = db.campaigns[req.params.id]; if (!c) return res.status(404).json({ error: 'Não encontrada' });
  if (c.media) try { fs.rmSync(path.join(UPLOADS_DIR, c.media.file), { force: true }); } catch {}
  delete db.campaigns[c.id]; saveDb(); io.to('admin').emit('campaign_removed', c.id);
  res.json({ ok: true });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/healthz', (req, res) => res.send('ok'));

// ───────────────────────── Inicialização ─────────────────────────
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e?.message || e));
process.on('uncaughtException', (e) => console.error('uncaughtException', e?.message || e));
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    flushDb();
    for (const id of rt.keys()) { try { await getRt(id).client?.destroy(); } catch {} }
    process.exit(0);
  });
}

server.listen(PORT, () => {
  console.log(`Dispara Yuna rodando na porta ${PORT} (fuso ${TZ})`);
  // reconecta automaticamente as contas que já estavam conectadas (um navegador por vez, para não estourar a memória)
  (async () => {
    for (const s of Object.values(db.sessions)) {
      if (s.autoStart) {
        try { await startSession(s.id); } catch (e) { console.error('autostart', e.message); }
        await sleep(8000);
      }
    }
  })();
});
