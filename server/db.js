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

CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  type_code TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER,
  decided_by INTEGER,
  decided_at TEXT,
  decision_note TEXT,
  applied_by INTEGER,
  applied_at TEXT,
  applied_code TEXT,
  applied_snapshot TEXT
);
CREATE INDEX IF NOT EXISTS leave_person ON leave_requests(person_id, start_date);
CREATE INDEX IF NOT EXISTS leave_status ON leave_requests(status);

CREATE TABLE IF NOT EXISTS leave_events (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS leave_events_req ON leave_events(request_id);

CREATE TABLE IF NOT EXISTS leave_lockdowns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS public_holidays (
  date TEXT PRIMARY KEY,
  name TEXT NOT NULL
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
  migrate(db);
  const count = db.prepare('SELECT COUNT(*) AS n FROM duty_codes').get().n;
  if (count === 0) {
    const ins = db.prepare('INSERT INTO duty_codes (code,label,category,color,private,sort_order) VALUES (?,?,?,?,?,?)');
    DEFAULT_DUTY_CODES.forEach((d, i) => ins.run(d.code, d.label, d.category, d.color, d.private ? 1 : 0, i));
  } else {
    // Existing databases: add the combined codes used when annual leave covers a rest day or public holiday.
    const order = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM duty_codes').get().m;
    const add = db.prepare('INSERT OR IGNORE INTO duty_codes (code, label, category, color, private, sort_order) VALUES (?,?,?,?,0,?)');
    DEFAULT_DUTY_CODES.filter((c) => c.code === 'RD-AL' || c.code === 'PH-AL').forEach((c, i) => add.run(c.code, c.label, c.category, c.color, order + i + 1));
  }
  return db;
}

/** Add columns introduced after the first release to existing databases. */
function migrate(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(people)').all().map((c) => c.name));
  if (!cols.has('email')) db.exec('ALTER TABLE people ADD COLUMN email TEXT');
  if (!cols.has('job_title')) db.exec('ALTER TABLE people ADD COLUMN job_title TEXT');
  if (!cols.has('start_date')) db.exec('ALTER TABLE people ADD COLUMN start_date TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS people_email ON people(email COLLATE NOCASE) WHERE email IS NOT NULL');
  if (!cols.has('line_manager_id')) db.exec('ALTER TABLE people ADD COLUMN line_manager_id INTEGER REFERENCES people(id) ON DELETE SET NULL');
  const lcols = new Set(db.prepare('PRAGMA table_info(leave_requests)').all().map((c) => c.name));
  if (!lcols.has('form')) db.exec('ALTER TABLE leave_requests ADD COLUMN form TEXT');
  const ucols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  if (!ucols.has('leave_admin')) db.exec('ALTER TABLE users ADD COLUMN leave_admin INTEGER NOT NULL DEFAULT 0');
  if (!ucols.has('supervisor')) db.exec('ALTER TABLE users ADD COLUMN supervisor INTEGER NOT NULL DEFAULT 0');
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
