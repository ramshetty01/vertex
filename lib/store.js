// lib/store.js — durable per-user state (SQLite via better-sqlite3).
// Replaces the in-memory-only Map so state survives restarts (CLAUDE.md §2.7).
// One row per user; the whole user object is stored as a JSON blob (all fields are
// plain data — no functions — so it round-trips cleanly).

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = process.env.BOT_DB_PATH || path.join(__dirname, "..", "bot.db");
// better-sqlite3 won't create the parent dir (e.g. a fresh /data volume mount), so ensure it.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`);

const selStmt = db.prepare("SELECT data FROM users WHERE id = ?");
const upStmt = db.prepare(
  `INSERT INTO users (id, data, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
);
const delStmt = db.prepare("DELETE FROM users WHERE id = ?");

function load(id) {
  const row = selStmt.get(id);
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

function save(id, obj) {
  upStmt.run(id, JSON.stringify(obj), Date.now());
}

function remove(id) {
  delStmt.run(id);
}

module.exports = { load, save, remove, db };
