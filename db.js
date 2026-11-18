import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function createDB(filename = process.env.DB_PATH || path.join(process.env.DATA_DIR || './data', 'arena.sqlite')) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename, { timeout: 5000 });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS friend_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      UNIQUE(from_id, to_id),
      CHECK(from_id != to_id)
    );
    CREATE TABLE IF NOT EXISTS friends (
      low_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      high_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(low_id, high_id),
      CHECK(low_id < high_id)
    );
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      player1_id INTEGER NOT NULL REFERENCES users(id),
      player2_id INTEGER REFERENCES users(id),
      invited_user_id INTEGER REFERENCES users(id),
      status TEXT NOT NULL CHECK(status IN ('waiting', 'active', 'finished', 'cancelled')),
      state_json TEXT,
      winner_id INTEGER REFERENCES users(id),
      finish_reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS queue (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS games_player1 ON games(player1_id, updated_at);
    CREATE INDEX IF NOT EXISTS games_player2 ON games(player2_id, updated_at);
    CREATE INDEX IF NOT EXISTS games_invited ON games(invited_user_id, updated_at);
    CREATE INDEX IF NOT EXISTS requests_to ON friend_requests(to_id);
  `);
  return db;
}
