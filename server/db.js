import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_DUTY_CODES } from './duty-codes.js';

export { DEFAULT_DUTY_CODES };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  establishment INTEGER NOT NULL DEFAULT 0,
  min_strength INTEGER,
  color TEXT
);

CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  staff_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  initials TEXT,
  mobile TEXT,
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS people_team ON people(team_id);

CREATE TABLE IF NOT EXISTS accreditations (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS person_accreditations (
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  accreditation_id INTEGER NOT NULL REFERENCES accreditations(id) ON DELETE CASCADE,
  value TEXT,
  expires TEXT,
  PRIMARY KEY (person_id, accreditation_id)
);

CREATE TABLE IF NOT EXISTS duty_codes (
  code TEXT PRIMARY KEY COLLATE NOCASE,
  label TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'duty' CHECK (category IN ('duty','rest','leave','training','other')),
  color TEXT NOT NULL DEFAULT '#d0d7de',
  private INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS assignments (
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  code TEXT NOT NULL,
  note TEXT,
  updated_at TEXT,
  updated_by INTEGER,
  PRIMARY KEY (person_id, date)
);
CREATE INDEX IF NOT EXISTS assignments_date ON assignments(date);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','planner','staff')),
  person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  details TEXT
);
`;


export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const count = db.prepare('SELECT COUNT(*) AS n FROM duty_codes').get().n;
  if (count === 0) {
    const ins = db.prepare('INSERT INTO duty_codes (code,label,category,color,private,sort_order) VALUES (?,?,?,?,?,?)');
    DEFAULT_DUTY_CODES.forEach((d, i) => ins.run(d.code, d.label, d.category, d.color, d.private ? 1 : 0, i));
  }
  return db;
}

/** Run fn inside a transaction. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function audit(db, user, action, details) {
  db.prepare('INSERT INTO audit_log (user_id, username, action, details) VALUES (?,?,?,?)').run(
    user?.id ?? null,
    user?.username ?? null,
    action,
    details == null ? null : JSON.stringify(details),
  );
}
