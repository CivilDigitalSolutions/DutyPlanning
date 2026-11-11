// Writes a consistent copy of the live database (safe while the app is running).
// Usage: npm run backup [-- /path/to/backups]
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const src = process.env.DB_FILE || './data/dutyplanning.db';
const dir = process.argv[2] || './data/backups';
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, `dutyplanning-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
const db = new DatabaseSync(src);
db.exec('PRAGMA busy_timeout = 10000');
db.prepare('VACUUM INTO ?').run(out);
db.close();
console.log(`Backup written to ${out}`);
