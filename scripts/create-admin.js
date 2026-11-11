// Usage: npm run create-admin -- <username> <password>
// Creates (or resets the password of) an admin account.
import { openDb } from '../server/db.js';
import { hashPassword, validatePassword } from '../server/auth.js';

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.error('Usage: npm run create-admin -- <username> <password>');
  process.exit(1);
}
const err = validatePassword(password);
if (err) {
  console.error(err);
  process.exit(1);
}
const db = openDb(process.env.DB_FILE || './data/dutyplanning.db');
db.prepare(
  `INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?,?,'admin',1)
   ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash, role = 'admin', must_change_password = 1`,
).run(username, hashPassword(password));
db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)').run(username);
console.log(`Admin "${username}" ready (password change required at next sign-in).`);
