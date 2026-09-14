/**
 * WhatsApp MCP server — read-only.
 *
 * Serves the local store.db that bridge.js maintains. Exposes no way to send,
 * edit, delete or react to anything.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { openDb, getMeta, setMeta, DB_PATH, ROOT } from './db.js';

const db = openDb();

/**
 * Start the bridge if nothing is holding the WhatsApp connection. Detached and
 * window-hidden, so it outlives this session — opening any Claude Code session
 * is enough to bring the mirror back up.
 */
function bridgeAlive() {
  const pid = Number(getMeta(db, 'pid') || 0);
  if (!pid) return false;
  try {
    process.kill(pid, 0);        // signal 0 tests existence without touching it
    return true;
  } catch {
    return false;                // gone, or not ours any more
  }
}

function ensureBridge() {
  try {
    if (bridgeAlive()) return;

    const lastTry = Number(getMeta(db, 'spawn_attempt') || 0);
    if (Date.now() - lastTry < 30_000) return;   // a concurrent session just tried

    setMeta(db, 'spawn_attempt', Date.now());
    spawn(process.execPath, [join(ROOT, 'bridge.js')], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: ROOT,
    }).unref();
  } catch {
    // Nothing to do — wa_status reports the bridge as down.
  }
}

/* ---------- helpers ---------- */

const iso = (ts) => (ts ? new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 16) : '');
const phone = (jid) => (jid === 'me' ? 'me' : String(jid || '').replace(/@.*$/, '').replace(/^/, '+'));

function displayName(jid) {
  if (jid === 'me') return 'me';
  const c = db.prepare('SELECT name, notify FROM contacts WHERE jid = ?').get(jid);
  return c?.name || c?.notify || phone(jid);
}

function chatLabel(row) {
  if (row.name) return row.name;
  if (row.is_group) return `group ${row.jid.split('@')[0]}`;
  return displayName(row.jid);
}

/** Accept a jid, or fuzzy-match a chat/contact name. Returns [{jid, name, is_group}]. */
function resolveChats(query, limit = 8) {
  if (!query) return [];
  if (query.includes('@')) {
    const r = db.prepare('SELECT jid, name, is_group FROM chats WHERE jid = ?').get(query);
    return r ? [r] : [{ jid: query, name: null, is_group: query.endsWith('@g.us') ? 1 : 0 }];
  }
  const like = `%${query}%`;
  return db.prepare(`
    SELECT c.jid, c.name, c.is_group, c.last_ts
    FROM chats c
    LEFT JOIN contacts ct ON ct.jid = c.jid
    WHERE c.name LIKE ? OR ct.name LIKE ? OR ct.notify LIKE ? OR c.jid LIKE ?
    ORDER BY c.last_ts DESC LIMIT ?`).all(like, like, like, like, limit);
}

function requireChat(query) {
  const hits = resolveChats(query);
  if (!hits.length) throw new Error(`No chat matches "${query}". Use wa_list_chats to see what's available.`);
  return hits[0];
}

function renderMessages(rows, { showChat = false } = {}) {
  if (!rows.length) return '(no messages)';
  return rows.map((m) => {
    const who = m.from_me ? 'me' : (m.sender_name || displayName(m.sender_jid));
    const tag = m.kind === 'text' ? '' : ` [${m.kind}${m.filename ? `: ${m.filename}` : ''}${m.media_path ? '' : ', not downloaded'}]`;
    const where = showChat ? ` {${chatLabel({ jid: m.chat_jid, name: m.chat_name, is_group: m.chat_is_group })}}` : '';
    const body = (m.body || '').replace(/\s+/g, ' ').trim();
    return `[${iso(m.ts)}]${where} ${who}${tag}: ${body}   (id:${m.id})`;
  }).join('\n');
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });

/* ---------- tools ---------- */

const TOOLS = [
  {
    name: 'wa_status',
    description: 'Bridge health: whether WhatsApp is linked, when it last synced, and how much is stored.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wa_list_chats',
    description: 'List chats most recent first. Optionally filter by name, or restrict to groups.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Filter by chat or contact name (substring).' },
        groups_only: { type: 'boolean', description: 'Only group chats.' },
        limit: { type: 'number', description: 'Default 30.' },
      },
    },
  },
  {
    name: 'wa_list_messages',
    description: 'Read messages from one chat, newest last. Identify the chat by name or jid.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Chat name (fuzzy) or jid.' },
        limit: { type: 'number', description: 'Default 50, max 500.' },
        since: { type: 'string', description: 'Only messages on/after this date, YYYY-MM-DD.' },
        until: { type: 'string', description: 'Only messages before this date, YYYY-MM-DD.' },
      },
      required: ['chat'],
    },
  },
  {
    name: 'wa_search',
    description: 'Search message text across all chats, or within one chat.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to find.' },
        chat: { type: 'string', description: 'Optional: restrict to this chat.' },
        limit: { type: 'number', description: 'Default 40.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'wa_context',
    description: 'Show the messages surrounding a specific message id, for reading a thread in context.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
        before: { type: 'number', description: 'Default 5.' },
        after: { type: 'number', description: 'Default 5.' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'wa_media',
    description: 'Resolve the local file path of a message attachment so it can be opened or read.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'wa_list_media',
    description: 'List downloaded attachments in a chat (images, PDFs, documents) with their local paths.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Chat name (fuzzy) or jid.' },
        limit: { type: 'number', description: 'Default 30.' },
      },
      required: ['chat'],
    },
  },
  {
    name: 'wa_reactions',
    description: 'List emoji reactions in a chat, with the message each one is attached to.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Chat name (fuzzy) or jid.' },
        emoji: { type: 'string', description: 'Optional: only this emoji.' },
        limit: { type: 'number', description: 'Default 40.' },
      },
      required: ['chat'],
    },
  },
];

const day = (s) => Math.floor(new Date(`${s}T00:00:00Z`).getTime() / 1000);

const handlers = {
  wa_status() {
    if (!existsSync(DB_PATH)) return text('No store yet. Run: node bridge.js');
    const n = db.prepare('SELECT COUNT(*) c FROM messages').get().c;
    const chats = db.prepare('SELECT COUNT(*) c FROM chats').get().c;
    const media = db.prepare('SELECT COUNT(*) c FROM messages WHERE media_path IS NOT NULL').get().c;
    const reacts = db.prepare('SELECT COUNT(*) c FROM reactions').get().c;
    const hb = Number(getMeta(db, 'heartbeat') || 0);
    const age = hb ? Math.round((Date.now() - hb) / 1000) : null;
    const live = bridgeAlive();
    return text([
      `Bridge:    ${live ? `running (pid ${getMeta(db, 'pid')})` : 'starting — call again in a few seconds'}`,
      hb ? `Heartbeat: ${age}s ago` : 'Heartbeat: never',
      `Linked as: ${getMeta(db, 'self_jid') || '(not linked)'}`,
      `Stored:    ${n} messages across ${chats} chats, ${media} downloaded attachments, ${reacts} reactions`,
      `Database:  ${DB_PATH} (${(statSync(DB_PATH).size / 1e6).toFixed(1)} MB)`,
    ].join('\n'));
  },

  wa_list_chats({ query, groups_only, limit = 30 }) {
    const like = query ? `%${query}%` : '%';
    const rows = db.prepare(`
      SELECT c.jid, c.name, c.is_group, c.last_ts,
             (SELECT COUNT(*) FROM messages m WHERE m.chat_jid = c.jid) AS n
      FROM chats c
      LEFT JOIN contacts ct ON ct.jid = c.jid
      WHERE (c.name LIKE ? OR ct.name LIKE ? OR ct.notify LIKE ? OR c.jid LIKE ?)
        AND (? = 0 OR c.is_group = 1)
      ORDER BY c.last_ts DESC LIMIT ?`)
      .all(like, like, like, like, groups_only ? 1 : 0, Math.min(limit, 200));
    if (!rows.length) return text('(no chats)');
    return text(rows.map((r) =>
      `${r.is_group ? '[group]' : '[dm]   '} ${chatLabel(r).padEnd(32)} ${String(r.n).padStart(5)} msgs  last ${iso(r.last_ts)}  ${r.jid}`
    ).join('\n'));
  },

  wa_list_messages({ chat, limit = 50, since, until }) {
    const c = requireChat(chat);
    const rows = db.prepare(`
      SELECT * FROM messages
      WHERE chat_jid = ? AND (? IS NULL OR ts >= ?) AND (? IS NULL OR ts < ?)
      ORDER BY ts DESC LIMIT ?`)
      .all(c.jid, since ?? null, since ? day(since) : 0, until ?? null, until ? day(until) : 0,
        Math.min(limit, 500));
    return text(`Chat: ${chatLabel(c)}  (${c.jid})\n\n${renderMessages(rows.reverse())}`);
  },

  wa_search({ query, chat, limit = 40 }) {
    const jid = chat ? requireChat(chat).jid : null;
    const rows = db.prepare(`
      SELECT m.*, c.name AS chat_name, c.is_group AS chat_is_group
      FROM messages m LEFT JOIN chats c ON c.jid = m.chat_jid
      WHERE m.body LIKE ? AND (? IS NULL OR m.chat_jid = ?)
      ORDER BY m.ts DESC LIMIT ?`)
      .all(`%${query}%`, jid, jid, Math.min(limit, 200));
    return text(rows.length ? renderMessages(rows, { showChat: !jid }) : `(nothing matching "${query}")`);
  },

  wa_context({ message_id, before = 5, after = 5 }) {
    const anchor = db.prepare('SELECT * FROM messages WHERE id = ?').get(message_id);
    if (!anchor) return text(`No message with id ${message_id}`);
    const pre = db.prepare('SELECT * FROM messages WHERE chat_jid = ? AND ts < ? ORDER BY ts DESC LIMIT ?')
      .all(anchor.chat_jid, anchor.ts, before).reverse();
    const post = db.prepare('SELECT * FROM messages WHERE chat_jid = ? AND ts > ? ORDER BY ts ASC LIMIT ?')
      .all(anchor.chat_jid, anchor.ts, after);
    return text(renderMessages([...pre, anchor, ...post]));
  },

  wa_media({ message_id }) {
    const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(message_id);
    if (!m) return text(`No message with id ${message_id}`);
    if (!m.media_path) {
      return text(`Message ${message_id} is a "${m.kind}" with no downloaded file. `
        + 'Video and audio are stored as metadata only; other files may have expired off WhatsApp servers.');
    }
    if (!existsSync(m.media_path)) return text(`Recorded at ${m.media_path} but the file is gone.`);
    return text(`${m.media_path}\n${m.media_mime || ''} ${m.media_bytes ? `${(m.media_bytes / 1024).toFixed(0)} KB` : ''}`);
  },

  wa_list_media({ chat, limit = 30 }) {
    const c = requireChat(chat);
    const rows = db.prepare(`
      SELECT * FROM messages WHERE chat_jid = ? AND media_path IS NOT NULL
      ORDER BY ts DESC LIMIT ?`).all(c.jid, Math.min(limit, 200));
    if (!rows.length) return text(`No downloaded attachments in ${chatLabel(c)}.`);
    return text(rows.map((m) =>
      `[${iso(m.ts)}] ${m.kind.padEnd(9)} ${m.filename || '(unnamed)'}\n    ${m.media_path}   (id:${m.id})`
    ).join('\n'));
  },

  wa_reactions({ chat, emoji, limit = 40 }) {
    const c = requireChat(chat);
    const rows = db.prepare(`
      SELECT r.*, m.body, m.kind, m.filename, m.sender_name, m.from_me
      FROM reactions r LEFT JOIN messages m ON m.id = r.target_id AND m.chat_jid = r.chat_jid
      WHERE r.chat_jid = ? AND (? IS NULL OR r.emoji = ?) AND r.emoji <> ''
      ORDER BY r.ts DESC LIMIT ?`)
      .all(c.jid, emoji ?? null, emoji ?? null, Math.min(limit, 200));
    if (!rows.length) return text(`No reactions recorded in ${chatLabel(c)}.`);
    return text(rows.map((r) => {
      const target = r.body ? r.body.replace(/\s+/g, ' ').slice(0, 60)
        : (r.filename || r.kind || 'unknown message');
      return `${r.emoji}  by ${displayName(r.sender_jid)} at ${iso(r.ts)}  ->  ${target}   (id:${r.target_id})`;
    }).join('\n'));
  },
};

/* ---------- wiring ---------- */

const server = new Server(
  { name: 'whatsapp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  ensureBridge();            // every call, so a dead bridge is revived on next use
  const fn = handlers[req.params.name];
  if (!fn) return { content: [{ type: 'text', text: `Unknown tool ${req.params.name}` }], isError: true };
  try {
    return fn(req.params.arguments || {});
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
