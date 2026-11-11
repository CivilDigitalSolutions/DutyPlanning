import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tx, audit } from './db.js';
import {
  COOKIE,
  ROLE_RANK,
  clearLoginFailures,
  createSession,
  destroySession,
  destroyUserSessions,
  hashPassword,
  loginThrottled,
  parseCookies,
  recordLoginFailure,
  sessionUser,
  validatePassword,
  verifyPassword,
} from './auth.js';
import { addDays, daysBetween, eachDate, isValidIso } from './dates.js';
import { applyImport, exportWorkbook, parseGrid, readGrid } from './spreadsheet.js';
import { parseUserRows, templateCsv, ROLES } from './user-import.js';
import { applyUserImport, userTemplateWorkbook } from './users-io.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_RANGE_DAYS = 400;
const CATEGORIES = ['duty', 'rest', 'leave', 'training', 'other'];
const HEX = /^#[0-9a-f]{6}$/i;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

const s = (v, max = 200) => (v == null ? '' : String(v).trim().slice(0, max));
const optInt = (v) => (v == null || v === '' ? null : Number.isInteger(Number(v)) ? Number(v) : NaN);

export function createApp(db, config = {}) {
  const cfg = {
    orgName: 'Duty Planning',
    mobileVisibility: 'team', // 'all' | 'team' | 'planners'
    cookieSecure: false,
    dateOrder: 'dmy',
    ...config,
  };
  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', cfg.trustProxy);

  // ---- live update fan-out (Server-Sent Events) ----
  const clients = new Set();
  const broadcast = (event) => {
    const msg = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) res.write(msg);
  };
  app.locals.broadcast = broadcast;

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    next();
  });

  // ---- authentication middleware ----
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const token = parseCookies(req.headers.cookie)[COOKIE];
    req.token = token;
    req.user = sessionUser(db, token);
    // CSRF defence: state-changing requests must carry a custom header (not sendable cross-site without CORS).
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-Requested-With') !== 'DutyPlanning') {
      return res.status(403).json({ error: 'Missing request header' });
    }
    next();
  });

  const requireRole = (role) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    if (req.user.mustChangePassword)
      return res.status(403).json({ error: 'You must change your password first', code: 'PASSWORD_CHANGE' });
    if (ROLE_RANK[req.user.role] < ROLE_RANK[role]) return res.status(403).json({ error: 'Not permitted' });
    next();
  };
  const staff = requireRole('staff');
  const planner = requireRole('planner');
  const admin = requireRole('admin');
  const json = express.json({ limit: '2mb' });
  const wrap = (fn) => async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (e) {
      next(e);
    }
  };

  const setCookie = (res, token, expires) =>
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: !!cfg.cookieSecure,
      path: '/',
      expires: new Date(expires),
    });

  // ---------------- Auth ----------------
  app.post(
    '/api/auth/login',
    json,
    wrap((req, res) => {
      const username = s(req.body?.username, 100);
      const password = String(req.body?.password ?? '');
      const key = `${req.ip}|${username.toLowerCase()}`;
      if (loginThrottled(key)) throw new HttpError(429, 'Too many attempts - try again in 15 minutes');
      // Sign in with a username (staff number or email), or the email recorded on the person.
      const u =
        db.prepare('SELECT * FROM users WHERE username = ?').get(username) ||
        db.prepare('SELECT u.* FROM users u JOIN people p ON p.id = u.person_id WHERE p.email = ? ORDER BY u.id LIMIT 1').get(username);
      if (!u || !verifyPassword(password, u.password_hash)) {
        recordLoginFailure(key);
        throw new HttpError(401, 'Incorrect username or password');
      }
      clearLoginFailures(key);
      const { token, expires } = createSession(db, u.id);
      setCookie(res, token, expires);
      audit(db, u, 'login');
      res.json({ ok: true });
    }),
  );

  app.post('/api/auth/logout', (req, res) => {
    destroySession(db, req.token);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    const person = req.user.personId
      ? db.prepare('SELECT id, staff_number AS staffNumber, name, initials, team_id AS teamId FROM people WHERE id = ?').get(req.user.personId)
      : null;
    res.json({ user: { id: req.user.id, username: req.user.username, role: req.user.role, mustChangePassword: req.user.mustChangePassword, person } });
  });

  app.post(
    '/api/auth/password',
    json,
    wrap((req, res) => {
      if (!req.user) throw new HttpError(401, 'Not signed in');
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
      if (!verifyPassword(String(req.body?.current ?? ''), u.password_hash)) throw bad('Current password is incorrect');
      const err = validatePassword(req.body?.password);
      if (err) throw bad(err);
      if (req.body.password === req.body.current) throw bad('New password must be different');
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(req.body.password), u.id);
      destroyUserSessions(db, u.id, req.token);
      audit(db, req.user, 'password.change');
      res.json({ ok: true });
    }),
  );

  // ---------------- Reference data ----------------
  const listTeams = () =>
    db
      .prepare(
        `SELECT t.id, t.name, t.sort_order AS sortOrder, t.establishment, t.min_strength AS minStrength, t.color,
                (SELECT COUNT(*) FROM people p WHERE p.team_id = t.id AND p.active = 1) AS strength
         FROM teams t ORDER BY t.sort_order, t.name`,
      )
      .all();
  const listCodes = () =>
    db
      .prepare('SELECT code, label, category, color, private AS private, sort_order AS sortOrder FROM duty_codes ORDER BY sort_order, code')
      .all()
      .map((c) => ({ ...c, private: !!c.private }));
  const listAccs = () => db.prepare('SELECT id, code, name, sort_order AS sortOrder FROM accreditations ORDER BY sort_order, name').all();

  app.get('/api/meta', staff, (req, res) => {
    res.json({
      orgName: cfg.orgName,
      teams: listTeams(),
      dutyCodes: listCodes(),
      accreditations: listAccs(),
      categories: CATEGORIES,
      today: new Date().toISOString().slice(0, 10),
    });
  });

  // ---------------- Roster ----------------
  const readRange = (q) => {
    const from = q.from;
    const to = q.to;
    if (!isValidIso(from) || !isValidIso(to)) throw bad('from and to must be YYYY-MM-DD dates');
    if (to < from) throw bad('to must not be before from');
    if (daysBetween(from, to) > MAX_RANGE_DAYS) throw bad(`Range is limited to ${MAX_RANGE_DAYS} days`);
    return { from, to };
  };

  app.get('/api/roster', staff, (req, res) => {
    const { from, to } = readRange(req.query);
    const u = req.user;
    const isPlanner = ROLE_RANK[u.role] >= ROLE_RANK.planner;
    const me = u.personId ? db.prepare('SELECT id, team_id FROM people WHERE id = ?').get(u.personId) : null;
    const privateCodes = new Set(listCodes().filter((c) => c.private).map((c) => c.code.toLowerCase()));

    const people = db
      .prepare(
        `SELECT id, staff_number AS staffNumber, name, initials, mobile, email, job_title AS jobTitle, team_id AS teamId, sort_order AS sortOrder
         FROM people WHERE active = 1 ORDER BY sort_order, name`,
      )
      .all();
    const acc = {};
    for (const r of db.prepare('SELECT person_id, accreditation_id, value, expires FROM person_accreditations').all()) {
      (acc[r.person_id] ??= {})[r.accreditation_id] = r.expires ? { v: r.value, e: r.expires } : { v: r.value };
    }
    for (const p of people) {
      p.acc = acc[p.id] || {};
      const canSeeMobile =
        isPlanner || p.id === me?.id || cfg.mobileVisibility === 'all' || (cfg.mobileVisibility === 'team' && me && me.team_id && me.team_id === p.teamId);
      if (!canSeeMobile) {
        delete p.mobile;
        delete p.email;
      }
      if (!p.jobTitle) delete p.jobTitle;
    }
    // Optional ?person=<id> limits assignments to one person (used for long personal views).
    const onlyPerson = req.query.person ? Number(req.query.person) : null;
    const assignments = (
      onlyPerson
        ? db.prepare('SELECT person_id AS p, date AS d, code AS c, note AS n FROM assignments WHERE person_id = ? AND date BETWEEN ? AND ? ORDER BY date').all(onlyPerson, from, to)
        : db.prepare('SELECT person_id AS p, date AS d, code AS c, note AS n FROM assignments WHERE date BETWEEN ? AND ? ORDER BY date').all(from, to)
    )
      .map((a) => {
        const own = a.p === me?.id;
        if (!isPlanner && !own && privateCodes.has(a.c.toLowerCase())) return [a.p, a.d, '*'];
        return a.n && (isPlanner || own) ? [a.p, a.d, a.c, a.n] : [a.p, a.d, a.c];
      });
    res.json({ from, to, teams: listTeams(), people, assignments });
  });

  const validCode = (code) => db.prepare('SELECT code FROM duty_codes WHERE code = ?').get(code)?.code;

  app.put(
    '/api/assignments',
    planner,
    json,
    wrap((req, res) => {
      const changes = req.body?.changes;
      if (!Array.isArray(changes) || !changes.length) throw bad('changes must be a non-empty array');
      if (changes.length > 20000) throw bad('Too many changes in one request');
      const personExists = db.prepare('SELECT 1 FROM people WHERE id = ?');
      const upsert = db.prepare(
        `INSERT INTO assignments (person_id, date, code, note, updated_at, updated_by) VALUES (?,?,?,?,datetime('now'),?)
         ON CONFLICT(person_id, date) DO UPDATE SET code = excluded.code, note = excluded.note, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      );
      const del = db.prepare('DELETE FROM assignments WHERE person_id = ? AND date = ?');
      let min = null,
        max = null;
      tx(db, () => {
        for (const ch of changes) {
          const pid = Number(ch.personId);
          if (!Number.isInteger(pid) || !personExists.get(pid)) throw bad(`Unknown person ${ch.personId}`);
          if (!isValidIso(ch.date)) throw bad(`Invalid date ${ch.date}`);
          if (ch.code == null || ch.code === '') del.run(pid, ch.date);
          else {
            const code = validCode(String(ch.code));
            if (!code) throw bad(`Unknown duty code "${ch.code}"`);
            upsert.run(pid, ch.date, code, s(ch.note, 500) || null, req.user.id);
          }
          if (!min || ch.date < min) min = ch.date;
          if (!max || ch.date > max) max = ch.date;
        }
        audit(db, req.user, 'assignments.update', { count: changes.length, from: min, to: max, sample: changes.slice(0, 20) });
      });
      broadcast({ type: 'roster', from: min, to: max });
      res.json({ ok: true, count: changes.length });
    }),
  );

  // Apply a repeating rota pattern (e.g. T1,T1,T1,T1,RD,RD,RD,RD) to people over a date range.
  app.post(
    '/api/assignments/pattern',
    planner,
    json,
    wrap((req, res) => {
      const { personIds, pattern, overwrite = true } = req.body || {};
      const { from, to } = readRange(req.body || {});
      const anchor = req.body?.anchor || from;
      if (!isValidIso(anchor)) throw bad('anchor must be a date');
      if (!Array.isArray(personIds) || !personIds.length) throw bad('Choose at least one person');
      if (!Array.isArray(pattern) || !pattern.length || pattern.length > 366) throw bad('Pattern must have 1-366 entries');
      const codes = pattern.map((c) => {
        if (c == null || c === '') return null;
        const code = validCode(String(c).trim());
        if (!code) throw bad(`Unknown duty code "${c}"`);
        return code;
      });
      const offsets = req.body?.offsets || {};
      const upsert = db.prepare(
        `INSERT INTO assignments (person_id, date, code, updated_at, updated_by) VALUES (?,?,?,datetime('now'),?)
         ON CONFLICT(person_id, date) DO UPDATE SET code = excluded.code, note = NULL, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      );
      const insIfEmpty = db.prepare(
        `INSERT INTO assignments (person_id, date, code, updated_at, updated_by) VALUES (?,?,?,datetime('now'),?) ON CONFLICT(person_id, date) DO NOTHING`,
      );
      const del = db.prepare('DELETE FROM assignments WHERE person_id = ? AND date = ?');
      let count = 0;
      tx(db, () => {
        for (const raw of personIds) {
          const pid = Number(raw);
          if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(pid)) throw bad(`Unknown person ${raw}`);
          const off = Number(offsets[pid] ?? 0) || 0;
          for (const d of eachDate(from, to)) {
            const idx = (((daysBetween(anchor, d) + off) % codes.length) + codes.length) % codes.length;
            const code = codes[idx];
            if (code == null) {
              if (overwrite) del.run(pid, d);
            } else (overwrite ? upsert : insIfEmpty).run(pid, d, code, req.user.id);
            count++;
          }
        }
        audit(db, req.user, 'assignments.pattern', { personIds, from, to, anchor, pattern: codes, overwrite });
      });
      broadcast({ type: 'roster', from, to });
      res.json({ ok: true, count });
    }),
  );

  // Personal calendar feed download (.ics)
  app.get('/api/my.ics', staff, (req, res) => {
    if (!req.user.personId) throw bad('Your account is not linked to a person on the plan');
    const from = new Date().toISOString().slice(0, 10);
    const to = addDays(from, 365);
    const codes = new Map(listCodes().map((c) => [c.code.toLowerCase(), c]));
    const rows = db.prepare('SELECT date, code, note FROM assignments WHERE person_id = ? AND date BETWEEN ? AND ? ORDER BY date').all(req.user.personId, from, to);
    const esc = (t) => String(t).replace(/[\\;,]/g, (m) => '\\' + m).replace(/\n/g, '\\n');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DutyPlanning//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${esc(cfg.orgName)} duties`];
    for (const r of rows) {
      const c = codes.get(r.code.toLowerCase());
      if (c?.category === 'rest') continue;
      const d = r.date.replace(/-/g, '');
      lines.push(
        'BEGIN:VEVENT',
        `UID:${req.user.personId}-${d}@dutyplanning`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${d}`,
        `DTEND;VALUE=DATE:${addDays(r.date, 1).replace(/-/g, '')}`,
        `SUMMARY:${esc(c && c.label !== r.code ? `${r.code} - ${c.label}` : r.code)}`,
        ...(r.note ? [`DESCRIPTION:${esc(r.note)}`] : []),
        'TRANSP:TRANSPARENT',
        'END:VEVENT',
      );
    }
    lines.push('END:VCALENDAR');
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="my-duties.ics"');
    res.send(lines.join('\r\n') + '\r\n');
  });

  // Live updates
  app.get('/api/events', staff, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  });

  // ---------------- Teams ----------------
  const teamBody = (b) => {
    const name = s(b.name, 100);
    if (!name) throw bad('Team name is required');
    const establishment = optInt(b.establishment) ?? 0;
    if (!(establishment >= 0 && establishment <= 1000)) throw bad('Establishment must be 0-1000');
    const sortOrder = optInt(b.sortOrder) ?? 0;
    if (Number.isNaN(sortOrder)) throw bad('Sort order must be a whole number');
    const color = b.color ? s(b.color, 7) : null;
    if (color && !HEX.test(color)) throw bad('Colour must be #rrggbb');
    const minStrength = optInt(b.minStrength);
    if (Number.isNaN(minStrength) || (minStrength != null && minStrength < 0)) throw bad('Minimum on duty must be a whole number');
    return [name, sortOrder, establishment, color, minStrength];
  };
  app.post(
    '/api/teams',
    planner,
    json,
    wrap((req, res) => {
      const id = Number(db.prepare('INSERT INTO teams (name, sort_order, establishment, color, min_strength) VALUES (?,?,?,?,?)').run(...teamBody(req.body || {})).lastInsertRowid);
      audit(db, req.user, 'team.create', { id, ...req.body });
      broadcast({ type: 'meta' });
      res.json({ id });
    }),
  );
  app.put(
    '/api/teams/:id',
    planner,
    json,
    wrap((req, res) => {
      const r = db.prepare('UPDATE teams SET name=?, sort_order=?, establishment=?, color=?, min_strength=? WHERE id=?').run(...teamBody(req.body || {}), Number(req.params.id));
      if (!r.changes) throw new HttpError(404, 'Team not found');
      audit(db, req.user, 'team.update', { id: req.params.id, ...req.body });
      broadcast({ type: 'meta' });
      res.json({ ok: true });
    }),
  );
  app.delete(
    '/api/teams/:id',
    planner,
    wrap((req, res) => {
      const r = db.prepare('DELETE FROM teams WHERE id = ?').run(Number(req.params.id));
      if (!r.changes) throw new HttpError(404, 'Team not found');
      audit(db, req.user, 'team.delete', { id: req.params.id });
      broadcast({ type: 'meta' });
      res.json({ ok: true });
    }),
  );

  // ---------------- People ----------------
  app.get('/api/people', planner, (req, res) => {
    const people = db
      .prepare(
        `SELECT p.id, p.staff_number AS staffNumber, p.name, p.initials, p.mobile, p.email, p.job_title AS jobTitle, p.start_date AS startDate,
                p.team_id AS teamId, p.sort_order AS sortOrder, p.active,
                (SELECT u.username FROM users u WHERE u.person_id = p.id LIMIT 1) AS username
         FROM people p LEFT JOIN teams t ON t.id = p.team_id
         ORDER BY p.active DESC, t.id IS NULL, t.sort_order, t.name, p.sort_order, p.name`,
      )
      .all()
      .map((p) => ({ ...p, active: !!p.active }));
    res.json({ people });
  });
  const personBody = (b) => {
    const staffNumber = s(b.staffNumber, 50);
    const name = s(b.name, 150);
    if (!staffNumber) throw bad('Staff number is required');
    if (!name) throw bad('Name is required');
    const teamId = optInt(b.teamId);
    if (Number.isNaN(teamId)) throw bad('Invalid team');
    if (teamId != null && !db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId)) throw bad('Team not found');
    const sortOrder = optInt(b.sortOrder) ?? 0;
    const email = s(b.email, 200).toLowerCase() || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address');
    const startDate = s(b.startDate, 10) || null;
    if (startDate && !isValidIso(startDate)) throw bad('Start date must be a date');
    return [
      staffNumber,
      name,
      s(b.initials, 10) || null,
      s(b.mobile, 30) || null,
      teamId,
      Number.isNaN(sortOrder) ? 0 : sortOrder,
      b.active === false ? 0 : 1,
      email,
      s(b.jobTitle, 100) || null,
      startDate,
    ];
  };
  const uniqueGuard = (fn, msg) => {
    try {
      return fn();
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, msg);
      throw e;
    }
  };
  app.post(
    '/api/people',
    planner,
    json,
    wrap((req, res) => {
      const id = uniqueGuard(
        () =>
          Number(
            db
              .prepare('INSERT INTO people (staff_number,name,initials,mobile,team_id,sort_order,active,email,job_title,start_date) VALUES (?,?,?,?,?,?,?,?,?,?)')
              .run(...personBody(req.body || {})).lastInsertRowid,
          ),
        'That staff number or email is already used by someone else',
      );
      audit(db, req.user, 'person.create', { id, staffNumber: req.body.staffNumber });
      broadcast({ type: 'meta' });
      res.json({ id });
    }),
  );
  app.put(
    '/api/people/:id',
    planner,
    json,
    wrap((req, res) => {
      const r = uniqueGuard(
        () =>
          db
            .prepare('UPDATE people SET staff_number=?, name=?, initials=?, mobile=?, team_id=?, sort_order=?, active=?, email=?, job_title=?, start_date=? WHERE id=?')
            .run(...personBody(req.body || {}), Number(req.params.id)),
        'That staff number or email is already used by someone else',
      );
      if (!r.changes) throw new HttpError(404, 'Person not found');
      audit(db, req.user, 'person.update', { id: req.params.id });
      broadcast({ type: 'meta' });
      res.json({ ok: true });
    }),
  );
  app.delete(
    '/api/people/:id',
    planner,
    wrap((req, res) => {
      const r = db.prepare('DELETE FROM people WHERE id = ?').run(Number(req.params.id));
      if (!r.changes) throw new HttpError(404, 'Person not found');
      audit(db, req.user, 'person.delete', { id: req.params.id });
      broadcast({ type: 'meta' });
      res.json({ ok: true });
    }),
  );
  app.put(
    '/api/people/:id/accreditations',
    planner,
    json,
    wrap((req, res) => {
      const pid = Number(req.params.id);
      if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(pid)) throw new HttpError(404, 'Person not found');
      const set = db.prepare(
        'INSERT INTO person_accreditations (person_id, accreditation_id, value, expires) VALUES (?,?,?,?) ON CONFLICT(person_id, accreditation_id) DO UPDATE SET value=excluded.value, expires=excluded.expires',
      );
      const del = db.prepare('DELETE FROM person_accreditations WHERE person_id = ? AND accreditation_id = ?');
      tx(db, () => {
        for (const [aid, val] of Object.entries(req.body || {})) {
          if (!db.prepare('SELECT 1 FROM accreditations WHERE id = ?').get(Number(aid))) throw bad(`Unknown accreditation ${aid}`);
          const v = val && typeof val === 'object' ? val : { v: val };
          const value = s(v.v, 100);
          const expires = v.e && isValidIso(v.e) ? v.e : null;
          if (!value && !expires) del.run(pid, Number(aid));
          else set.run(pid, Number(aid), value || 'Y', expires);
        }
        audit(db, req.user, 'person.accreditations', { id: pid, ...req.body });
      });
      broadcast({ type: 'meta' });
      res.json({ ok: true });
    }),
  );

  // ---------------- Duty codes ----------------
  const codeBody = (b) => {
    const label = s(b.label, 100);
    const category = CATEGORIES.includes(b.category) ? b.category : 'duty';
    const color = s(b.color, 7) || '#d0d7de';
    if (!label) throw bad('Label is required');
    if (!HEX.test(color)) throw bad('Colour must be #rrggbb');
    const sortOrder = optInt(b.sortOrder) ?? 0;
    return [label, category, color, b.private ? 1 : 0, Number.isNaN(sortOrder) ? 0 : sortOrder];
  };
  app.post(
    '/api/duty-codes',
    planner,
    json,
    wrap((req, res) => {
      const code = s(req.body?.code, 30);
      if (!code) throw bad('Code is required');
      if (code === '*') throw bad('"*" is reserved');
      uniqueGuard(
        () => db.prepare('INSERT INTO duty_codes (code,label,category,color,private,sort_order) VALUES (?,?,?,?,?,?)').run(code, ...codeBody(req.body)),
        'That code already exists',
      );
      audit(db, req.user, 'dutycode.create', req.body);
      broadcast({ type: 'meta' });
      res.json({ ok: true });
    }),
  );
  app.put(
    '/api/duty-codes/:code',
    planner,
    json,
    wrap((req, res) => {
      const r = db.prepare('UPDATE duty_codes SET label=?, category=?, color=?, private=?, sort_order=? WHERE code=?').run(...codeBody(req.body || {}), req.params.code);
      if (!r.changes) throw new HttpError(404, 'Code not found');
      audit(db, req.user, 'dutycode.update', { code: req.params.code, ...req.body });
      broadcast({ type: 'meta' });
      res.json({ ok: true });
    }),
  );
  app.delete(
    '/api/duty-codes/:code',
    planner,
    wrap((req, res) => {
      const used = db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE code = ?').get(req.params.code).n;
      if (used) throw new HttpError(409, `Code is used in ${used} plan entries - change those first`);
      const r = db.prepare('DELETE FROM duty_codes WHERE code = ?').run(req.params.code);
      if (!r.changes) throw new HttpError(404, 'Code not found');
      audit(db, req.user, 'dutycode.delete', { code: req.params.code });
      broadcast({ type: 'meta' });
      res.json({ ok: true });
    }),
  );

  // ---------------- Accreditations ----------------
  const accBody = (b) => {
    const code = s(b.code, 30);
    const name = s(b.name, 100) || code;
    if (!code) throw bad('Code is required');
    const sortOrder = optInt(b.sortOrder) ?? 0;
    return [code, name, Number.isNaN(sortOrder) ? 0 : sortOrder];
  };
  app.post(
    '/api/accreditations',
    planner,
    json,
    wrap((req, res) => {
      const id = uniqueGuard(
        () => Number(db.prepare('INSERT INTO accreditations (code,name,sort_order) VALUES (?,?,?)').run(...accBody(req.body || {})).lastInsertRowid),
        'That code already exists',
      );
      audit(db, req.user, 'accreditation.create', req.body);
      broadcast({ type: 'meta' });
      res.json({ id });
    }),
  );
  app.put(
    '/api/accreditations/:id',
    planner,
    json,
    wrap((req, res) => {
      const r = uniqueGuard(
        () => db.prepare('UPDATE accreditations SET code=?, name=?, sort_order=? WHERE id=?').run(...accBody(req.body || {}), Number(req.params.id)),
        'That code already exists',
      );
      if (!r.changes) throw new HttpError(404, 'Accreditation not found');
      audit(db, req.user, 'accreditation.update', { id: req.params.id, ...req.body });
      broadcast({ type: 'meta' });
      res.json({ ok: true });
    }),
  );
  app.delete(
    '/api/accreditations/:id',
    planner,
    wrap((req, res) => {
      const r = db.prepare('DELETE FROM accreditations WHERE id = ?').run(Number(req.params.id));
      if (!r.changes) throw new HttpError(404, 'Accreditation not found');
      audit(db, req.user, 'accreditation.delete', { id: req.params.id });
      broadcast({ type: 'meta' });
      res.json({ ok: true });
    }),
  );

  // ---------------- Users ----------------
  app.get('/api/users', admin, (req, res) => {
    const users = db
      .prepare(
        `SELECT u.id, u.username, u.role, u.person_id AS personId, u.must_change_password AS mustChangePassword, u.created_at AS createdAt, p.name AS personName
         FROM users u LEFT JOIN people p ON p.id = u.person_id ORDER BY u.role, u.username`,
      )
      .all()
      .map((u) => ({ ...u, mustChangePassword: !!u.mustChangePassword }));
    res.json({ users });
  });
  const userFields = (b) => {
    const role = ['admin', 'planner', 'staff'].includes(b.role) ? b.role : null;
    if (!role) throw bad('Role must be admin, planner or staff');
    const personId = optInt(b.personId);
    if (Number.isNaN(personId)) throw bad('Invalid person');
    if (personId != null && !db.prepare('SELECT 1 FROM people WHERE id = ?').get(personId)) throw bad('Person not found');
    return { role, personId };
  };
  app.post(
    '/api/users',
    admin,
    json,
    wrap((req, res) => {
      const username = s(req.body?.username, 100);
      if (!username) throw bad('Username is required');
      const { role, personId } = userFields(req.body);
      const err = validatePassword(req.body.password);
      if (err) throw bad(err);
      const id = uniqueGuard(
        () =>
          Number(
            db
              .prepare('INSERT INTO users (username, password_hash, role, person_id, must_change_password) VALUES (?,?,?,?,1)')
              .run(username, hashPassword(req.body.password), role, personId).lastInsertRowid,
          ),
        'That username already exists',
      );
      audit(db, req.user, 'user.create', { id, username, role, personId });
      res.json({ id });
    }),
  );
  app.put(
    '/api/users/:id',
    admin,
    json,
    wrap((req, res) => {
      const id = Number(req.params.id);
      const { role, personId } = userFields(req.body || {});
      if (id === req.user.id && role !== 'admin') throw bad('You cannot remove your own admin role');
      const r = db.prepare('UPDATE users SET role=?, person_id=? WHERE id=?').run(role, personId, id);
      if (!r.changes) throw new HttpError(404, 'User not found');
      if (req.body.password) {
        const err = validatePassword(req.body.password);
        if (err) throw bad(err);
        db.prepare('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?').run(hashPassword(req.body.password), id);
        destroyUserSessions(db, id);
      }
      audit(db, req.user, 'user.update', { id, role, personId, passwordReset: !!req.body.password });
      res.json({ ok: true });
    }),
  );
  app.delete(
    '/api/users/:id',
    admin,
    wrap((req, res) => {
      const id = Number(req.params.id);
      if (id === req.user.id) throw bad('You cannot delete your own account');
      const r = db.prepare('DELETE FROM users WHERE id = ?').run(id);
      if (!r.changes) throw new HttpError(404, 'User not found');
      audit(db, req.user, 'user.delete', { id });
      res.json({ ok: true });
    }),
  );
  // Create staff logins (username = staff number) for everyone on the plan without one.
  app.post(
    '/api/users/bulk',
    admin,
    json,
    wrap((req, res) => {
      const err = validatePassword(req.body?.password);
      if (err) throw bad(err);
      const people = db
        .prepare('SELECT p.id, p.staff_number FROM people p WHERE p.active = 1 AND NOT EXISTS (SELECT 1 FROM users u WHERE u.person_id = p.id)')
        .all();
      const hash = hashPassword(req.body.password);
      let created = 0;
      const skipped = [];
      tx(db, () => {
        const ins = db.prepare("INSERT INTO users (username, password_hash, role, person_id, must_change_password) VALUES (?,?,'staff',?,1)");
        for (const p of people) {
          if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(p.staff_number)) skipped.push(p.staff_number);
          else {
            ins.run(p.staff_number, hash, p.id);
            created++;
          }
        }
        audit(db, req.user, 'user.bulkCreate', { created, skipped });
      });
      res.json({ created, skipped });
    }),
  );

  // ---- Bulk user import from the email-based template ----
  const listAccsForImport = () => db.prepare('SELECT id, code, name FROM accreditations ORDER BY sort_order, name').all();
  app.get(
    '/api/users/template.xlsx',
    admin,
    wrap(async (req, res) => {
      const buf = await userTemplateWorkbook(db);
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', 'attachment; filename="new-users-template.xlsx"');
      res.send(Buffer.from(buf));
    }),
  );
  app.get('/api/users/template.csv', admin, (req, res) => {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="new-users-template.csv"');
    res.send('\uFEFF' + templateCsv(listAccsForImport()));
  });
  app.post(
    '/api/users/import',
    admin,
    express.raw({ type: () => true, limit: '10mb' }),
    wrap(async (req, res) => {
      if (!req.body?.length) throw bad('Upload the filled-in template (.xlsx or .csv)');
      const q = req.query;
      const createTeams = q.createTeams !== '0';
      const updateExisting = q.updateExisting !== '0';
      const defaultRole = ROLES.includes(q.defaultRole) ? q.defaultRole : 'staff';
      const password = String(req.get('X-Temp-Password') || '');
      if (password) {
        const err = validatePassword(password);
        if (err) throw bad(err);
      }
      let parsed;
      try {
        const { rows } = await readGrid(req.body, '');
        parsed = parseUserRows(rows, {
          teams: db.prepare('SELECT id, name FROM teams').all(),
          accreditations: listAccsForImport(),
          dateOrder: q.dateOrder === 'mdy' ? 'mdy' : cfg.dateOrder,
        });
      } catch (e) {
        throw bad(`Could not read file: ${e.message}`);
      }
      // Work out what will happen to each row.
      const byEmail = db.prepare('SELECT id FROM people WHERE email = ?');
      const byStaff = db.prepare('SELECT id, email FROM people WHERE staff_number = ?');
      const userByName = db.prepare('SELECT 1 FROM users WHERE username = ?');
      for (const r of parsed.rows) {
        if (r.newTeam && !createTeams) r.errors.push(`Team "${r.teamName}" does not exist`);
        const sn = r.staffNumber ? byStaff.get(r.staffNumber) : null;
        if (sn?.email && sn.email.toLowerCase() !== r.email) r.errors.push(`Staff No ${r.staffNumber} already belongs to ${sn.email}`);
        const existing = byEmail.get(r.email) || sn || userByName.get(r.email);
        r.action = r.errors.length ? 'error' : existing ? (updateExisting ? 'update' : 'skip') : 'create';
      }
      const preview = {
        columns: parsed.columns,
        warnings: parsed.warnings,
        counts: ['create', 'update', 'skip', 'error'].reduce((o, k) => ({ ...o, [k]: parsed.rows.filter((r) => r.action === k).length }), {}),
        newTeams: [...new Set(parsed.rows.filter((r) => r.newTeam && createTeams).map((r) => r.teamName))],
        rows: parsed.rows.map((r) => ({ line: r.line, email: r.email, name: r.name, staffNumber: r.staffNumber, team: r.teamName, role: r.role || defaultRole, jobTitle: r.jobTitle, action: r.action, errors: r.errors })),
      };
      if (q.dryRun === '1') return res.json({ preview });
      let summary;
      try {
        summary = applyUserImport(db, parsed, { createTeams, updateExisting, defaultRole, password, user: req.user });
      } catch (e) {
        throw bad(e.message);
      }
      broadcast({ type: 'meta' });
      res.json({ preview, summary });
    }),
  );

  app.get('/api/audit', admin, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const rows = db.prepare('SELECT id, at, username, action, details FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
    res.json({ entries: rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null })) });
  });

  // ---------------- Import / export ----------------
  app.post(
    '/api/import',
    planner,
    express.raw({ type: () => true, limit: '25mb' }),
    wrap(async (req, res) => {
      if (!req.body?.length) throw bad('Upload a .xlsx or .csv file');
      let filename = '';
      try {
        filename = decodeURIComponent(s(req.get('X-Filename'), 300));
      } catch {
        /* ignore malformed name */
      }
      let parsed;
      try {
        const { rows } = await readGrid(req.body, filename);
        parsed = parseGrid(rows, { dateOrder: req.query.dateOrder === 'mdy' ? 'mdy' : cfg.dateOrder, blankRowsAreVacancies: req.query.blankVacancies !== '0' });
      } catch (e) {
        throw bad(`Could not read spreadsheet: ${e.message}`);
      }
      const preview = {
        dates: parsed.dates.length ? { from: parsed.dates[0], to: parsed.dates.at(-1), count: parsed.dates.length } : null,
        accreditations: parsed.accreditations,
        teams: parsed.teams.map((t) => ({ name: t.name, people: t.members.length, vacancies: t.vacancies })),
        people: parsed.teams.reduce((n, t) => n + t.members.length, 0),
        warnings: parsed.warnings.slice(0, 100),
      };
      if (req.query.dryRun === '1') return res.json({ preview });
      const mode = req.query.mode === 'replace' ? 'replace' : 'merge';
      const summary = applyImport(db, parsed, { mode, user: req.user });
      broadcast({ type: 'meta' });
      res.json({ preview, summary });
    }),
  );

  app.get(
    '/api/export.xlsx',
    planner,
    wrap(async (req, res) => {
      const { from, to } = readRange(req.query);
      const teamIds = req.query.teams ? String(req.query.teams).split(',').map(Number).filter(Number.isInteger) : null;
      const buf = await exportWorkbook(db, { from, to, teamIds });
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', `attachment; filename="duty-plan-${from}-to-${to}.xlsx"`);
      res.send(Buffer.from(buf));
    }),
  );

  app.get('/healthz', (req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // ---------------- Static PWA ----------------
  // The service worker's cache version is a hash of the front-end files, so every
  // deploy that changes the app automatically refreshes users' offline caches.
  const swSource = fs.readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8');
  const hash = crypto.createHash('sha1');
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else hash.update(e.name).update(fs.readFileSync(f));
    }
  };
  walk(PUBLIC_DIR);
  const swBody = swSource.replace("const VERSION = 'v1';", `const VERSION = '${hash.digest('hex').slice(0, 12)}';`);
  app.get('/sw.js', (req, res) => {
    res.set({ 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.send(swBody);
  });
  app.use(
    express.static(PUBLIC_DIR, {
      index: false,
      setHeaders(res, file) {
        if (/(sw\.js|\.webmanifest|\.html)$/.test(file)) res.set('Cache-Control', 'no-cache');
        else res.set('Cache-Control', 'public, max-age=3600');
      },
    }),
  );
  // SPA fallback
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || (err.type === 'entity.too.large' ? 413 : err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
  });

  return app;
}
