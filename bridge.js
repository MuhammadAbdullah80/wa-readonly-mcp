/**
 * WhatsApp bridge — read-only.
 *
 * Holds the WhatsApp linked-device connection, mirrors messages into store.db,
 * and downloads images, documents and voice notes to media/. Never sends anything.
 *
 *   node bridge.js                      first run prints a QR code to link
 *   node bridge.js --pair +15551234567  link with a pairing code instead
 *
 * Environment:
 *   WA_CHATS     comma-separated chat JIDs to mirror; everything else is
 *                ignored (default: all chats). Find JIDs with wa_list_chats.
 *   WA_DATA_DIR  where store.db, media/ and auth/ live (default: this folder)
 *   WA_MAX_MEDIA_MB  skip attachments larger than this (default: 25)
 *
 * Any of these can also go in a .env file next to this script.
 */
import {
  makeWASocket,          // named export — the default export is the module object in Baileys 6.17+
  Browsers,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  DisconnectReason,
  jidNormalizedUser,
} from 'baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, setMeta, AUTH_DIR, MEDIA_DIR, ROOT } from './db.js';

const MAX_MEDIA_BYTES = Number(process.env.WA_MAX_MEDIA_MB || 25) * 1024 * 1024;
const MEDIA_KINDS = new Set(['image', 'document', 'sticker', 'voice', 'audio']); // video: metadata only
const AUDIO_KINDS = new Set(['voice', 'audio']);
const EXT = { image: 'jpg', sticker: 'webp', voice: 'ogg', audio: 'm4a' };
const ALLOWED_CHATS = new Set((process.env.WA_CHATS || '').split(',').map((s) => s.trim()).filter(Boolean));

const logger = pino({ level: 'silent' });
const db = openDb();

setMeta(db, 'pid', process.pid);   // so the MCP server can tell if we are alive

// When started detached there is no console, so mirror output to a log file.
// Only connection events and counts are logged — never message content.
const logFile = join(ROOT, 'bridge.log');
for (const level of ['log', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    try {
      appendFileSync(logFile, `[${new Date().toISOString()}] ${args.join(' ')}\n`);
    } catch { /* logging must never take the bridge down */ }
  };
}

const upsertChat = db.prepare(`
  INSERT INTO chats (jid, name, is_group, last_ts) VALUES (?, ?, ?, ?)
  ON CONFLICT(jid) DO UPDATE SET
    name    = COALESCE(NULLIF(excluded.name, ''), chats.name),
    last_ts = MAX(chats.last_ts, excluded.last_ts)`);

const upsertMsg = db.prepare(`
  INSERT INTO messages (id, chat_jid, sender_jid, sender_name, ts, from_me, kind, body,
                        quoted_id, media_path, media_mime, media_bytes, filename, media_ref)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(chat_jid, id) DO UPDATE SET
    body       = COALESCE(NULLIF(excluded.body, ''), messages.body),
    media_path = COALESCE(excluded.media_path, messages.media_path),
    media_ref  = COALESCE(excluded.media_ref, messages.media_ref)`);

const upsertReaction = db.prepare(`
  INSERT INTO reactions (chat_jid, target_id, sender_jid, emoji, ts) VALUES (?,?,?,?,?)
  ON CONFLICT(chat_jid, target_id, sender_jid) DO UPDATE SET
    emoji = excluded.emoji, ts = excluded.ts`);

const upsertContact = db.prepare(`
  INSERT INTO contacts (jid, name, notify) VALUES (?,?,?)
  ON CONFLICT(jid) DO UPDATE SET
    name   = COALESCE(NULLIF(excluded.name, ''), contacts.name),
    notify = COALESCE(NULLIF(excluded.notify, ''), contacts.notify)`);

// With WA_CHATS set, only those chats are stored. Chat and contact *names* are
// still recorded for every chat so wa_list_chats can show you the JIDs to pick.
const wanted = (jid) => ALLOWED_CHATS.size === 0 || ALLOWED_CHATS.has(jid);

/** Unwrap the ephemeral / view-once / edited envelopes Baileys nests content in. */
function unwrap(message) {
  let m = message;
  for (let i = 0; i < 5 && m; i++) {
    if (m.ephemeralMessage) { m = m.ephemeralMessage.message; continue; }
    if (m.viewOnceMessage) { m = m.viewOnceMessage.message; continue; }
    if (m.viewOnceMessageV2) { m = m.viewOnceMessageV2.message; continue; }
    if (m.documentWithCaptionMessage) { m = m.documentWithCaptionMessage.message; continue; }
    if (m.editedMessage) { m = m.editedMessage.message; continue; }
    break;
  }
  return m;
}

/** -> { kind, body, filename, mime } */
function describe(message) {
  const m = unwrap(message);
  if (!m) return { kind: 'unknown', body: '' };

  if (m.conversation) return { kind: 'text', body: m.conversation };
  if (m.extendedTextMessage) return { kind: 'text', body: m.extendedTextMessage.text || '' };
  if (m.imageMessage) return { kind: 'image', body: m.imageMessage.caption || '', mime: m.imageMessage.mimetype };
  if (m.videoMessage) return { kind: 'video', body: m.videoMessage.caption || '', mime: m.videoMessage.mimetype };
  if (m.documentMessage) return {
    kind: 'document',
    body: m.documentMessage.caption || '',
    filename: m.documentMessage.fileName,
    mime: m.documentMessage.mimetype,
  };
  if (m.audioMessage) return {
    kind: m.audioMessage.ptt ? 'voice' : 'audio', body: '', mime: m.audioMessage.mimetype, audio: m.audioMessage,
  };
  if (m.stickerMessage) return { kind: 'sticker', body: '', mime: m.stickerMessage.mimetype };
  if (m.locationMessage) {
    const l = m.locationMessage;
    return { kind: 'location', body: `${l.degreesLatitude}, ${l.degreesLongitude}` };
  }
  if (m.contactMessage) return { kind: 'contact', body: m.contactMessage.displayName || '' };
  if (m.pollCreationMessage || m.pollCreationMessageV3) {
    const p = m.pollCreationMessage || m.pollCreationMessageV3;
    return { kind: 'poll', body: p.name || '' };
  }
  if (m.protocolMessage) return { kind: 'protocol', body: '' };
  return { kind: Object.keys(m)[0] || 'unknown', body: '' };
}

function quotedId(message) {
  const m = unwrap(message);
  const ctx = m?.extendedTextMessage?.contextInfo
    || m?.imageMessage?.contextInfo
    || m?.videoMessage?.contextInfo
    || m?.documentMessage?.contextInfo
    || m?.audioMessage?.contextInfo;
  return ctx?.stanzaId || null;
}

function safeName(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

async function saveMedia(msg, kind, filename) {
  if (!MEDIA_KINDS.has(kind)) return null;
  try {
    const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger });
    if (!buf || buf.length > MAX_MEDIA_BYTES) return null;
    const base = filename ? safeName(filename) : `${msg.key.id}.${EXT[kind] || 'bin'}`;
    const out = join(MEDIA_DIR, `${msg.key.id}_${base}`);
    writeFileSync(out, buf);
    return { path: out, bytes: buf.length };
  } catch {
    return null;   // expired off the CDN, or an unsupported type — metadata is still stored
  }
}

/**
 * Voice notes from history sync aren't downloaded up front. Keep the CDN
 * reference so wa_transcribe can fetch one later, while WhatsApp still has it
 * (typically a few weeks). The key decrypts only that one file.
 */
function mediaRef(audio) {
  if (!audio?.mediaKey || !(audio.directPath || audio.url)) return null;
  return JSON.stringify({
    mediaKey: Buffer.from(audio.mediaKey).toString('base64'),
    directPath: audio.directPath || null,
    url: audio.url || null,
    mimetype: audio.mimetype || null,
    seconds: Number(audio.seconds) || null,
  });
}

async function record(msg, { downloadMedia = true } = {}) {
  if (!msg?.key?.id || !msg.key.remoteJid || !msg.message) return;

  const chatJid = msg.key.remoteJid;
  if (chatJid === 'status@broadcast') return;
  if (!wanted(chatJid)) return;

  const inner = unwrap(msg.message);

  // Reactions ride in as normal messages pointing at a target.
  if (inner?.reactionMessage) {
    const r = inner.reactionMessage;
    const sender = jidNormalizedUser(msg.key.participant || msg.participant || msg.key.remoteJid);
    upsertReaction.run(chatJid, r.key?.id || '', sender, r.text || '', Number(msg.messageTimestamp) || 0);
    return;
  }

  const { kind, body, filename, mime, audio } = describe(msg.message);
  if (kind === 'protocol') return;

  const isGroup = chatJid.endsWith('@g.us');
  const senderJid = msg.key.fromMe
    ? 'me'
    : jidNormalizedUser(isGroup ? (msg.key.participant || msg.participant || chatJid) : chatJid);
  const ts = Number(msg.messageTimestamp) || 0;

  let media = null;
  if (downloadMedia) media = await saveMedia(msg, kind, filename);

  upsertMsg.run(
    msg.key.id, chatJid, senderJid, msg.pushName || null, ts, msg.key.fromMe ? 1 : 0,
    kind, body || '', quotedId(msg.message),
    media?.path || null, mime || null, media?.bytes || null, filename || null,
    AUDIO_KINDS.has(kind) ? mediaRef(audio) : null,
  );
  upsertChat.run(chatJid, isGroup ? '' : (msg.pushName || ''), isGroup ? 1 : 0, ts);
}

// A background daemon must never give up: a dropped wifi link, a sleeping laptop
// or a router reboot all surface as 408/428 closes. Back off, but keep trying.
const MAX_BACKOFF_MS = 300_000;
let attempt = 0;

async function start() {
  let closed = false;   // guards against a stale socket respawning the loop
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    // Load-bearing. Other browser identities are refused at the handshake with
    // a 428 before any QR appears — which looks exactly like rate limiting.
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: true,
    markOnlineOnConnect: false,   // don't steal notifications from the phone
    shouldSyncHistoryMessage: () => true,
  });

  sock.ev.on('creds.update', saveCreds);

  // Windows consoles often mangle the QR block characters. Pairing code is the
  // reliable alternative:  node bridge.js --pair +15551234567
  const pairAt = process.argv.indexOf('--pair');
  const pairing = pairAt !== -1 && !state.creds.registered;
  if (pairing) {
    const number = String(process.argv[pairAt + 1] || '').replace(/\D/g, '');
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(number);
        console.log(`\n  Pairing code: ${code}\n`);
        console.log('  WhatsApp -> Settings -> Linked devices -> Link a device');
        console.log('  -> "Link with phone number instead" -> enter the code\n');
      } catch (e) {
        console.error('pairing code failed:', e.message);
      }
    }, 4000);
  }

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr && !pairing) {
      console.log('\nScan this in WhatsApp -> Settings -> Linked devices -> Link a device\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      setMeta(db, 'connected_at', Date.now());
      setMeta(db, 'self_jid', jidNormalizedUser(sock.user?.id || ''));
      attempt = 0;   // a good connection clears the backoff
      console.log(`connected as ${sock.user?.id}${ALLOWED_CHATS.size ? ` (mirroring ${ALLOWED_CHATS.size} chat(s))` : ''}`);
    }
    if (connection === 'close') {
      if (closed) return;          // one close per socket; stale sockets must not respawn
      closed = true;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log('logged out — delete auth/ and re-link');
        process.exit(0);
      }
      attempt += 1;
      const wait = Math.min(MAX_BACKOFF_MS, 3000 * 2 ** (attempt - 1));
      console.log(`disconnected (${code}) — retry ${attempt} in ${wait / 1000}s`);
      setTimeout(() => { start().catch((e) => console.error('restart failed:', e.message)); }, wait);
    }
  });

  sock.ev.on('messaging-history.set', async ({ chats, contacts, messages }) => {
    for (const c of chats || []) {
      upsertChat.run(c.id, c.name || c.subject || '', c.id.endsWith('@g.us') ? 1 : 0,
        Number(c.conversationTimestamp) || 0);
    }
    for (const c of contacts || []) {
      upsertContact.run(jidNormalizedUser(c.id), c.name || '', c.notify || '');
    }
    for (const m of messages || []) await record(m, { downloadMedia: false });
    setMeta(db, 'last_sync', Date.now());
    console.log(`history: ${chats?.length || 0} chats, ${messages?.length || 0} messages`);
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) await record(m);
    setMeta(db, 'last_message_at', Date.now());
  });

  sock.ev.on('contacts.upsert', (cs) => {
    for (const c of cs) upsertContact.run(jidNormalizedUser(c.id), c.name || '', c.notify || '');
  });
  sock.ev.on('contacts.update', (cs) => {
    for (const c of cs) if (c.id) upsertContact.run(jidNormalizedUser(c.id), c.name || '', c.notify || '');
  });

  sock.ev.on('chats.upsert', (cs) => {
    for (const c of cs) {
      upsertChat.run(c.id, c.name || c.subject || '', c.id.endsWith('@g.us') ? 1 : 0,
        Number(c.conversationTimestamp) || 0);
    }
  });

  sock.ev.on('groups.upsert', (gs) => {
    for (const g of gs) upsertChat.run(g.id, g.subject || '', 1, 0);
  });

  setInterval(() => setMeta(db, 'heartbeat', Date.now()), 30_000).unref?.();
}

start().catch((e) => { console.error('bridge failed:', e); process.exit(1); });
