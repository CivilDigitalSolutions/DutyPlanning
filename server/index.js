import { openDb } from './db.js';
import { createApp } from './app.js';
import { hashPassword } from './auth.js';

const env = process.env;
const db = openDb(env.DB_FILE || './data/dutyplanning.db');

// First run: create an initial admin account if none exists.
if (!db.prepare("SELECT 1 FROM users WHERE role = 'admin'").get()) {
  const username = env.ADMIN_USERNAME || 'admin';
  const password = env.ADMIN_PASSWORD;
  if (!password) {
    console.error('No admin account exists. Set ADMIN_PASSWORD (and optionally ADMIN_USERNAME) for the first start.');
    process.exit(1);
  }
  db.prepare("INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?,?,'admin',1)").run(username, hashPassword(password));
  console.log(`Created initial admin account "${username}" - you will be asked to change the password at first sign-in.`);
}

const app = createApp(db, {
  orgName: env.ORG_NAME || 'Duty Planning',
  mobileVisibility: env.MOBILE_VISIBILITY || 'team',
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
  trustProxy: env.TRUST_PROXY || (env.NODE_ENV === 'production' ? 'loopback, uniquelocal' : false),
  dateOrder: env.DATE_ORDER === 'mdy' ? 'mdy' : 'dmy',
});

const port = Number(env.PORT || 3000);
const host = env.HOST || '0.0.0.0';
const server = app.listen(port, host, () => console.log(`Duty Planning listening on http://${host}:${port}`));

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
