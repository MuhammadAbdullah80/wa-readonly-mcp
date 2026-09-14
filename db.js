import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Everything lives next to the code unless WA_DATA_DIR points elsewhere.
export const ROOT = process.env.WA_DATA_DIR
  ? resolve(process.env.WA_DATA_DIR)
  : dirname(fileURLToPath(import.meta.url));
export const MEDIA_DIR = join(ROOT, 'media');
export const AUTH_DIR = join(ROOT, 'auth');
export const DB_PATH = join(ROOT, 'store.db');

export function openDb({ readonly = false } = {}) {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH, { readOnly: readonly });
  if (!readonly) {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS chats (
        jid       TEXT PRIMARY KEY,
        name      TEXT,
        is_group  INTEGER NOT NULL DEFAULT 0,
        last_ts   INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS messages (
        id           TEXT NOT NULL,
        chat_jid     TEXT NOT NULL,
        sender_jid   TEXT,
        sender_name  TEXT,
        ts           INTEGER NOT NULL DEFAULT 0,
        from_me      INTEGER NOT NULL DEFAULT 0,
        kind         TEXT,
        body         TEXT,
        quoted_id    TEXT,
        media_path   TEXT,
        media_mime   TEXT,
        media_bytes  INTEGER,
        filename     TEXT,
        PRIMARY KEY (chat_jid, id)
      );
      CREATE INDEX IF NOT EXISTS idx_msg_chat_ts ON messages (chat_jid, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_msg_ts      ON messages (ts DESC);

      CREATE TABLE IF NOT EXISTS reactions (
        chat_jid   TEXT NOT NULL,
        target_id  TEXT NOT NULL,
        sender_jid TEXT NOT NULL,
        emoji      TEXT,
        ts         INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (chat_jid, target_id, sender_jid)
      );
      CREATE INDEX IF NOT EXISTS idx_react_chat ON reactions (chat_jid, ts DESC);

      CREATE TABLE IF NOT EXISTS contacts (
        jid    TEXT PRIMARY KEY,
        name   TEXT,
        notify TEXT
      );

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  }
  return db;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

export function getMeta(db, key) {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return r ? r.value : null;
}
