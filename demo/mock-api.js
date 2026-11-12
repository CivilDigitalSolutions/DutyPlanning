// In-browser stand-in for the server API, used only by the standalone demo build.
// It exports the same interface as public/js/api.js and applies the same rules
// (roles, private codes, mobile visibility, validation) against data held in
// memory and saved to this browser's localStorage.
import { parseCsv, parseGrid, cellValue, guessCategory, colorFor } from '../server/sheet-parse.js';
import { daysBetween, eachDate, isValidIso } from '../server/dates.js';
import { seedDemo } from './seed.js';
import { REGIONS, ukBankHolidays } from '../server/holidays.js';
import { parseUserRows, generatePassword, templateCsv, ROLES } from '../server/user-import.js';
import { ACTION_RESULT, ACTIVE_STATUSES, STATUSES, leavePlan, leaveActions, leaveBreakdown, validateRequestDates, lockdownsFor, canRosterLockdown } from '../server/leave-rules.js';
import { dialog, html, todayIso } from '../public/js/util.js';

const KEY = 'dp-demo-v6';
const RANK = { staff: 1, planner: 2, admin: 3 };
const CATEGORIES = ['duty', 'rest', 'leave', 'training', 'other'];
const HEX = /^#[0-9a-f]{6}$/i;

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const listeners = new Set();
export const onApiEvent = (fn) => listeners.add(fn);
const emit = (e) => listeners.forEach((fn) => fn(e));

function loadDb() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* storage unavailable */
  }
  return seedDemo(todayIso());
}
let db = loadDb();
const save = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch {
    /* storage unavailable or full: keep working in memory */
  }
};
window.DP_DEMO_RESET = () => {
  const session = db.session;
  db = seedDemo(todayIso());
  db.session = db.users.some((u) => u.id === session) ? session : null;
  save();
};

const fail = (status, msg, code) => {
  throw new ApiError(status, msg, code);
};
const bad = (msg) => fail(400, msg);
const s = (v, max = 200) => (v == null ? '' : String(v).trim().slice(0, max));
const optInt = (v) => (v == null || v === '' ? null : Number.isInteger(Number(v)) ? Number(v) : NaN);
const nextId = () => ++db.seq;
const lc = (x) => String(x).toLowerCase();
const clone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const changed = (detail) => setTimeout(() => emit({ type: 'changed', detail }), 0);

function audit(user, action, details) {
  db.audit.unshift({ id: nextId(), at: new Date().toISOString().replace('T', ' ').slice(0, 19), username: user?.username ?? null, action, details: details ?? null });
  db.audit.length = Math.min(db.audit.length, 500);
}

function me() {
  const u = db.users.find((x) => x.id === db.session);
  return u ? { ...u, mustChangePassword: !!u.mustChangePassword } : null;
}
function need(role) {
  const u = me();
  if (!u) fail(401, 'Not signed in');
  if (u.mustChangePassword) fail(403, 'You must change your password first', 'PASSWORD_CHANGE');
  if (RANK[u.role] < RANK[role]) fail(403, 'Not permitted');
  return u;
}

const findCode = (code) => db.codes.find((c) => lc(c.code) === lc(code));
const sortBy = (arr, ...keys) => [...arr].sort((a, b) => keys.reduce((r, k) => r || (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0), 0));
const listTeams = () =>
  sortBy(db.teams, 'sortOrder', 'name').map((t) => ({ ...t, strength: db.people.filter((p) => p.teamId === t.id && p.active).length }));
const listCodes = () => sortBy(db.codes, 'sortOrder', 'code');
const listAccs = () => sortBy(db.accs, 'sortOrder', 'name');
const unique = (list, key, val, exceptId, msg) => {
  if (list.some((x) => x[key] != null && lc(x[key]) === lc(val) && x.id !== exceptId)) fail(409, msg);
};

function readRange(q) {
  const { from, to } = q;
  if (!isValidIso(from) || !isValidIso(to)) bad('from and to must be YYYY-MM-DD dates');
  if (to < from) bad('to must not be before from');
  if (daysBetween(from, to) > 400) bad('Range is limited to 400 days');
  return { from, to };
}

// ---------------- Route handlers ----------------
const routes = [];
const on = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

on('POST', '/auth/login', ({ body }) => {
  const name = lc(s(body?.username, 100));
  const byEmail = db.people.find((p) => p.email && lc(p.email) === name);
  const u = db.users.find((x) => lc(x.username) === name) || (byEmail && db.users.find((x) => x.personId === byEmail.id));
  if (!u || u.password !== String(body?.password ?? '')) fail(401, 'Incorrect username or password');
  db.session = u.id;
  audit(u, 'login');
  return { ok: true };
});
on('POST', '/auth/logout', () => {
  db.session = null;
  return { ok: true };
});
on('GET', '/auth/me', () => {
  const u = me();
  if (!u) fail(401, 'Not signed in');
  const p = db.people.find((x) => x.id === u.personId);
  return {
    user: {
      id: u.id,
      username: u.username,
      role: u.role,
      mustChangePassword: u.mustChangePassword,
      leaveAdmin: !!u.leaveAdmin,
      supervisor: !!u.supervisor,
      person: p ? { id: p.id, staffNumber: p.staffNumber, name: p.name, initials: p.initials, teamId: p.teamId, lineManagerId: p.lineManagerId ?? null } : null,
    },
  };
});
on('POST', '/auth/password', ({ body }) => {
  const u = db.users.find((x) => x.id === db.session);
  if (!u) fail(401, 'Not signed in');
  if (u.password !== String(body?.current ?? '')) bad('Current password is incorrect');
  if (typeof body.password !== 'string' || body.password.length < 8) bad('Password must be at least 8 characters');
  if (body.password === body.current) bad('New password must be different');
  u.password = body.password;
  u.mustChangePassword = false;
  audit(u, 'password.change');
  return { ok: true };
});

on('GET', '/meta', () => {
  need('staff');
  return { orgName: db.orgName, teams: listTeams(), dutyCodes: listCodes(), accreditations: listAccs(), categories: CATEGORIES, today: todayIso() };
});

on('GET', '/roster', ({ query }) => {
  const u = need('staff');
  const { from, to } = readRange(query);
  const planner = RANK[u.role] >= RANK.planner;
  const mine = db.people.find((p) => p.id === u.personId);
  const priv = new Set(db.codes.filter((c) => c.private).map((c) => lc(c.code)));
  const people = sortBy(
    db.people.filter((p) => p.active),
    'sortOrder',
    'name',
  ).map((p) => {
    const out = { id: p.id, staffNumber: p.staffNumber, name: p.name, initials: p.initials, mobile: p.mobile, email: p.email, teamId: p.teamId, sortOrder: p.sortOrder, acc: db.pacc[p.id] || {} };
    if (p.jobTitle) out.jobTitle = p.jobTitle;
    const canSee = planner || p.id === mine?.id || (mine?.teamId && mine.teamId === p.teamId);
    if (!canSee) {
      delete out.mobile;
      delete out.email;
    }
    return out;
  });
  const only = query.person ? Number(query.person) : null;
  const ids = only ? [only] : db.people.map((p) => p.id);
  const assignments = [];
  for (const d of eachDate(from, to))
    for (const pid of ids) {
      const a = db.asg[`${pid}|${d}`];
      if (!a) continue;
      const own = pid === mine?.id;
      if (!planner && !own && priv.has(lc(a.c))) assignments.push([pid, d, '*']);
      else assignments.push(a.n && (planner || own) ? [pid, d, a.c, a.n] : [pid, d, a.c]);
    }
  const publicHolidays = Object.fromEntries(Object.entries(db.holidays || {}).filter(([d]) => d >= from && d <= to));
  const lockdowns = (db.lockdowns || []).filter((l) => l.start <= to && l.end >= from).map(({ id, name, start, end, teamId }) => ({ id, name, start, end, teamId }));
  return { from, to, teams: listTeams(), people, assignments, publicHolidays, lockdowns };
});

on('PUT', '/assignments', ({ body }) => {
  const u = need('planner');
  const changes = body?.changes;
  if (!Array.isArray(changes) || !changes.length) bad('changes must be a non-empty array');
  const next = { ...db.asg };
  let min = null,
    max = null;
  for (const ch of changes) {
    const pid = Number(ch.personId);
    if (!db.people.some((p) => p.id === pid)) bad(`Unknown person ${ch.personId}`);
    if (!isValidIso(ch.date)) bad(`Invalid date ${ch.date}`);
    const k = `${pid}|${ch.date}`;
    if (ch.code == null || ch.code === '') delete next[k];
    else {
      const code = findCode(ch.code);
      if (!code) bad(`Unknown duty code "${ch.code}"`);
      const note = s(ch.note, 500);
      next[k] = note ? { c: code.code, n: note } : { c: code.code };
    }
    if (!min || ch.date < min) min = ch.date;
    if (!max || ch.date > max) max = ch.date;
  }
  db.asg = next;
  audit(u, 'assignments.update', { count: changes.length, from: min, to: max });
  changed({ type: 'roster', from: min, to: max });
  return { ok: true, count: changes.length };
});

on('POST', '/assignments/pattern', ({ body }) => {
  const u = need('planner');
  const { personIds, pattern, overwrite = true, offsets = {} } = body || {};
  const { from, to } = readRange(body || {});
  const anchor = body?.anchor || from;
  if (!isValidIso(anchor)) bad('anchor must be a date');
  if (!Array.isArray(personIds) || !personIds.length) bad('Choose at least one person');
  if (!Array.isArray(pattern) || !pattern.length || pattern.length > 366) bad('Pattern must have 1-366 entries');
  const codes = pattern.map((c) => {
    if (c == null || c === '') return null;
    const code = findCode(String(c).trim());
    if (!code) bad(`Unknown duty code "${c}"`);
    return code.code;
  });
  let count = 0;
  for (const raw of personIds) {
    const pid = Number(raw);
    if (!db.people.some((p) => p.id === pid)) bad(`Unknown person ${raw}`);
    const off = Number(offsets[pid] ?? 0) || 0;
    for (const d of eachDate(from, to)) {
      const code = codes[(((daysBetween(anchor, d) + off) % codes.length) + codes.length) % codes.length];
      const k = `${pid}|${d}`;
      if (code == null) {
        if (overwrite) delete db.asg[k];
      } else if (overwrite || !db.asg[k]) db.asg[k] = { c: code };
      count++;
    }
  }
  audit(u, 'assignments.pattern', { personIds, from, to, anchor, pattern: codes, overwrite });
  changed({ type: 'roster', from, to });
  return { ok: true, count };
});

// Teams
const teamBody = (b) => {
  const name = s(b.name, 100);
  if (!name) bad('Team name is required');
  const establishment = optInt(b.establishment) ?? 0;
  if (!(establishment >= 0 && establishment <= 1000)) bad('Establishment must be 0-1000');
  const minStrength = optInt(b.minStrength);
  if (Number.isNaN(minStrength) || (minStrength != null && minStrength < 0)) bad('Minimum on duty must be a whole number');
  const sortOrder = optInt(b.sortOrder) ?? 0;
  const color = b.color ? s(b.color, 7) : null;
  if (color && !HEX.test(color)) bad('Colour must be #rrggbb');
  return { name, establishment, minStrength, sortOrder: Number.isNaN(sortOrder) ? 0 : sortOrder, color };
};
on('POST', '/teams', ({ body }) => {
  const u = need('planner');
  const t = teamBody(body || {});
  unique(db.teams, 'name', t.name, null, 'That team already exists');
  const id = nextId();
  db.teams.push({ id, ...t });
  audit(u, 'team.create', { id, name: t.name });
  changed({ type: 'meta' });
  return { id };
});
on('PUT', '/teams/:id', ({ body, params }) => {
  const u = need('planner');
  const t = db.teams.find((x) => x.id === Number(params.id)) || fail(404, 'Team not found');
  const v = teamBody(body || {});
  unique(db.teams, 'name', v.name, t.id, 'That team already exists');
  Object.assign(t, v);
  audit(u, 'team.update', { id: t.id, name: t.name });
  changed({ type: 'meta' });
  return { ok: true };
});
on('DELETE', '/teams/:id', ({ params }) => {
  const u = need('planner');
  const id = Number(params.id);
  if (!db.teams.some((t) => t.id === id)) fail(404, 'Team not found');
  db.teams = db.teams.filter((t) => t.id !== id);
  for (const p of db.people) if (p.teamId === id) p.teamId = null;
  audit(u, 'team.delete', { id });
  changed({ type: 'meta' });
  return { ok: true };
});

// People
on('GET', '/people', () => {
  need('planner');
  const team = new Map(db.teams.map((t) => [t.id, t]));
  const people = [...db.people].sort((a, b) => {
    const ta = team.get(a.teamId),
      tb = team.get(b.teamId);
    return (
      Number(b.active) - Number(a.active) ||
      Number(!ta) - Number(!tb) ||
      (ta?.sortOrder ?? 0) - (tb?.sortOrder ?? 0) ||
      a.sortOrder - b.sortOrder ||
      a.name.localeCompare(b.name)
    );
  });
  return { people: people.map((p) => ({ ...p, username: db.users.find((u) => u.personId === p.id)?.username ?? null })) };
});
const checkManager = (v, selfId) => {
  const mid = optInt(v);
  if (Number.isNaN(mid)) bad('Invalid line manager');
  if (mid != null && !db.people.some((p) => p.id === mid)) bad('Line manager not found');
  if (mid != null && mid === selfId) bad('Someone cannot be their own line manager');
  return mid;
};
const personBody = (b, selfId = null) => {
  const staffNumber = s(b.staffNumber, 50);
  const name = s(b.name, 150);
  if (!staffNumber) bad('Staff number is required');
  if (!name) bad('Name is required');
  const teamId = optInt(b.teamId);
  if (Number.isNaN(teamId)) bad('Invalid team');
  if (teamId != null && !db.teams.some((t) => t.id === teamId)) bad('Team not found');
  const sortOrder = optInt(b.sortOrder) ?? 0;
  const email = lc(s(b.email, 200)) || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad('Enter a valid email address');
  const startDate = s(b.startDate, 10) || null;
  if (startDate && !isValidIso(startDate)) bad('Start date must be a date');
  return {
    staffNumber,
    name,
    initials: s(b.initials, 10) || null,
    mobile: s(b.mobile, 30) || null,
    teamId,
    sortOrder: Number.isNaN(sortOrder) ? 0 : sortOrder,
    active: b.active !== false,
    email,
    jobTitle: s(b.jobTitle, 100) || null,
    startDate,
    lineManagerId: checkManager(b.lineManagerId, selfId),
  };
};
on('POST', '/people', ({ body }) => {
  const u = need('planner');
  const p = personBody(body || {});
  unique(db.people, 'staffNumber', p.staffNumber, null, 'That staff number already exists');
  if (p.email) unique(db.people, 'email', p.email, null, 'That email is already used by someone else');
  const id = nextId();
  db.people.push({ id, ...p });
  audit(u, 'person.create', { id, staffNumber: p.staffNumber });
  changed({ type: 'meta' });
  return { id };
});
on('PUT', '/people/:id', ({ body, params }) => {
  const u = need('planner');
  const p = db.people.find((x) => x.id === Number(params.id)) || fail(404, 'Person not found');
  const v = personBody(body || {}, p.id);
  unique(db.people, 'staffNumber', v.staffNumber, p.id, 'That staff number already exists');
  if (v.email) unique(db.people, 'email', v.email, p.id, 'That email is already used by someone else');
  Object.assign(p, v);
  audit(u, 'person.update', { id: p.id });
  changed({ type: 'meta' });
  return { ok: true };
});
on('DELETE', '/people/:id', ({ params }) => {
  const u = need('planner');
  const id = Number(params.id);
  if (!db.people.some((p) => p.id === id)) fail(404, 'Person not found');
  db.people = db.people.filter((p) => p.id !== id);
  delete db.pacc[id];
  for (const k of Object.keys(db.asg)) if (k.startsWith(id + '|')) delete db.asg[k];
  for (const x of db.users) if (x.personId === id) x.personId = null;
  audit(u, 'person.delete', { id });
  changed({ type: 'meta' });
  return { ok: true };
});
on('PUT', '/people/:id/accreditations', ({ body, params }) => {
  const u = need('planner');
  const pid = Number(params.id);
  if (!db.people.some((p) => p.id === pid)) fail(404, 'Person not found');
  const rec = (db.pacc[pid] ??= {});
  for (const [aid, val] of Object.entries(body || {})) {
    if (!db.accs.some((a) => a.id === Number(aid))) bad(`Unknown accreditation ${aid}`);
    const v = val && typeof val === 'object' ? val : { v: val };
    const value = s(v.v, 100);
    const e = v.e && isValidIso(v.e) ? v.e : null;
    if (!value && !e) delete rec[aid];
    else rec[aid] = e ? { v: value || 'Y', e } : { v: value || 'Y' };
  }
  audit(u, 'person.accreditations', { id: pid });
  changed({ type: 'meta' });
  return { ok: true };
});

// Duty codes
const codeBody = (b) => {
  const label = s(b.label, 100);
  const color = s(b.color, 7) || '#d0d7de';
  if (!label) bad('Label is required');
  if (!HEX.test(color)) bad('Colour must be #rrggbb');
  const sortOrder = optInt(b.sortOrder) ?? 0;
  return { label, category: CATEGORIES.includes(b.category) ? b.category : 'duty', color, private: !!b.private, sortOrder: Number.isNaN(sortOrder) ? 0 : sortOrder };
};
on('POST', '/duty-codes', ({ body }) => {
  const u = need('planner');
  const code = s(body?.code, 30);
  if (!code) bad('Code is required');
  if (code === '*') bad('"*" is reserved');
  if (findCode(code)) fail(409, 'That code already exists');
  db.codes.push({ code, ...codeBody(body) });
  audit(u, 'dutycode.create', { code });
  changed({ type: 'meta' });
  return { ok: true };
});
on('PUT', '/duty-codes/:code', ({ body, params }) => {
  const u = need('planner');
  const c = findCode(decodeURIComponent(params.code)) || fail(404, 'Code not found');
  Object.assign(c, codeBody(body || {}));
  audit(u, 'dutycode.update', { code: c.code });
  changed({ type: 'meta' });
  return { ok: true };
});
on('DELETE', '/duty-codes/:code', ({ params }) => {
  const u = need('planner');
  const c = findCode(decodeURIComponent(params.code)) || fail(404, 'Code not found');
  const used = Object.values(db.asg).filter((a) => lc(a.c) === lc(c.code)).length;
  if (used) fail(409, `Code is used in ${used} plan entries - change those first`);
  db.codes = db.codes.filter((x) => x !== c);
  audit(u, 'dutycode.delete', { code: c.code });
  changed({ type: 'meta' });
  return { ok: true };
});

// Accreditations
const accBody = (b) => {
  const code = s(b.code, 30);
  if (!code) bad('Code is required');
  const sortOrder = optInt(b.sortOrder) ?? 0;
  return { code, name: s(b.name, 100) || code, sortOrder: Number.isNaN(sortOrder) ? 0 : sortOrder };
};
on('POST', '/accreditations', ({ body }) => {
  const u = need('planner');
  const a = accBody(body || {});
  unique(db.accs, 'code', a.code, null, 'That code already exists');
  const id = nextId();
  db.accs.push({ id, ...a });
  audit(u, 'accreditation.create', { id, code: a.code });
  changed({ type: 'meta' });
  return { id };
});
on('PUT', '/accreditations/:id', ({ body, params }) => {
  const u = need('planner');
  const a = db.accs.find((x) => x.id === Number(params.id)) || fail(404, 'Accreditation not found');
  const v = accBody(body || {});
  unique(db.accs, 'code', v.code, a.id, 'That code already exists');
  Object.assign(a, v);
  audit(u, 'accreditation.update', { id: a.id });
  changed({ type: 'meta' });
  return { ok: true };
});
on('DELETE', '/accreditations/:id', ({ params }) => {
  const u = need('planner');
  const id = Number(params.id);
  if (!db.accs.some((a) => a.id === id)) fail(404, 'Accreditation not found');
  db.accs = db.accs.filter((a) => a.id !== id);
  for (const rec of Object.values(db.pacc)) delete rec[id];
  audit(u, 'accreditation.delete', { id });
  changed({ type: 'meta' });
  return { ok: true };
});

// Users
on('GET', '/users', () => {
  need('admin');
  const users = sortBy(db.users, 'role', 'username').map((u) => ({
    id: u.id,
    username: u.username,
    role: u.role,
    personId: u.personId,
    mustChangePassword: !!u.mustChangePassword,
    leaveAdmin: !!u.leaveAdmin,
    supervisor: !!u.supervisor,
    personName: db.people.find((p) => p.id === u.personId)?.name ?? null,
  }));
  return { users };
});
const userFields = (b) => {
  if (!['admin', 'planner', 'staff'].includes(b.role)) bad('Role must be admin, planner or staff');
  const personId = optInt(b.personId);
  if (Number.isNaN(personId)) bad('Invalid person');
  if (personId != null && !db.people.some((p) => p.id === personId)) bad('Person not found');
  return { role: b.role, personId };
};
const checkPw = (pw) => (typeof pw !== 'string' || pw.length < 8) && bad('Password must be at least 8 characters');
on('POST', '/users', ({ body }) => {
  const u = need('admin');
  const username = s(body?.username, 100);
  if (!username) bad('Username is required');
  const f = userFields(body);
  checkPw(body.password);
  unique(db.users, 'username', username, null, 'That username already exists');
  const id = nextId();
  db.users.push({ id, username, password: body.password, ...f, leaveAdmin: !!body.leaveAdmin, supervisor: !!body.supervisor, mustChangePassword: true });
  audit(u, 'user.create', { id, username, role: f.role });
  return { id };
});
on('PUT', '/users/:id', ({ body, params }) => {
  const me_ = need('admin');
  const u = db.users.find((x) => x.id === Number(params.id)) || fail(404, 'User not found');
  const f = userFields(body || {});
  if (u.id === me_.id && f.role !== 'admin') bad('You cannot remove your own admin role');
  Object.assign(u, f, { leaveAdmin: !!body.leaveAdmin, supervisor: !!body.supervisor });
  if (body.password) {
    checkPw(body.password);
    u.password = body.password;
    u.mustChangePassword = true;
  }
  audit(me_, 'user.update', { id: u.id, role: f.role, passwordReset: !!body.password });
  return { ok: true };
});
on('DELETE', '/users/:id', ({ params }) => {
  const me_ = need('admin');
  const id = Number(params.id);
  if (id === me_.id) bad('You cannot delete your own account');
  if (!db.users.some((u) => u.id === id)) fail(404, 'User not found');
  db.users = db.users.filter((u) => u.id !== id);
  audit(me_, 'user.delete', { id });
  return { ok: true };
});
on('POST', '/users/bulk', ({ body }) => {
  const u = need('admin');
  checkPw(body?.password);
  let created = 0;
  const skipped = [];
  for (const p of db.people.filter((x) => x.active && !db.users.some((y) => y.personId === x.id))) {
    if (db.users.some((y) => lc(y.username) === lc(p.staffNumber))) skipped.push(p.staffNumber);
    else {
      db.users.push({ id: nextId(), username: p.staffNumber, password: body.password, role: 'staff', personId: p.id, mustChangePassword: true });
      created++;
    }
  }
  audit(u, 'user.bulkCreate', { created, skipped });
  return { created, skipped };
});

on('GET', '/audit', ({ query }) => {
  need('admin');
  return { entries: db.audit.slice(0, Math.min(Number(query.limit) || 200, 500)) };
});

// Import: CSV is parsed directly; .xlsx is read with ExcelJS loaded on demand from cdnjs.
let excelLoading = null;
function loadExcel() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  excelLoading ??= new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
    el.onload = () => resolve(window.ExcelJS);
    el.onerror = () => {
      excelLoading = null;
      reject(new Error('Could not load the Excel reader - save the file as .csv and try again'));
    };
    document.head.append(el);
  });
  return excelLoading;
}
async function readGrid(buf) {
  const bytes = new Uint8Array(buf);
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) return parseCsv(new TextDecoder().decode(bytes));
  const ExcelJS = await loadExcel();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  let best = null;
  wb.eachSheet((ws) => {
    if (!best || ws.actualCellCount > best.actualCellCount) best = ws;
  });
  if (!best) throw new Error('Workbook has no worksheets');
  const rows = [];
  for (let r = 1; r <= best.rowCount; r++) {
    const row = best.getRow(r);
    const out = [];
    for (let c = 1; c <= best.columnCount; c++) out.push(cellValue(row.getCell(c).value));
    rows.push(out);
  }
  return rows;
}

function applyImport(parsed, mode, user) {
  const summary = { teams: 0, peopleCreated: 0, peopleUpdated: 0, vacancies: 0, assignments: 0, newDutyCodes: [], newAccreditations: [] };
  if (mode === 'replace') {
    db.asg = {};
    db.pacc = {};
    db.people = [];
    db.teams = [];
    for (const u of db.users) u.personId = null;
  }
  let maxSort = Math.max(0, ...db.codes.map((c) => c.sortOrder));
  for (const t of parsed.teams)
    for (const p of t.members)
      for (const code of Object.values(p.duties))
        if (!findCode(code)) {
          db.codes.push({ code, label: code, category: guessCategory(code), color: colorFor(code), private: false, sortOrder: ++maxSort });
          summary.newDutyCodes.push(code);
        }
  let accSort = Math.max(0, ...db.accs.map((a) => a.sortOrder));
  for (const name of parsed.accreditations)
    if (!db.accs.some((a) => lc(a.code) === lc(name))) {
      db.accs.push({ id: nextId(), code: name, name, sortOrder: ++accSort });
      summary.newAccreditations.push(name);
    }
  const teamOffset = Math.max(0, ...db.teams.map((t) => t.sortOrder));
  parsed.teams.forEach((t, ti) => {
    const establishment = t.members.length + t.vacancies;
    let team = db.teams.find((x) => lc(x.name) === lc(t.name));
    const sortOrder = mode === 'replace' ? ti : teamOffset + ti + 1;
    if (team) Object.assign(team, { establishment, sortOrder });
    else db.teams.push((team = { id: nextId(), name: t.name, sortOrder, establishment, minStrength: null, color: null }));
    summary.teams++;
    summary.vacancies += t.vacancies;
    t.members.forEach((m, pi) => {
      let p = db.people.find((x) => lc(x.staffNumber) === lc(m.staffNumber));
      const fields = { name: m.name, initials: m.initials || null, mobile: m.mobile || null, teamId: team.id, sortOrder: pi, active: true };
      if (p) {
        Object.assign(p, fields);
        summary.peopleUpdated++;
      } else {
        db.people.push((p = { id: nextId(), staffNumber: m.staffNumber, ...fields }));
        summary.peopleCreated++;
      }
      const rec = (db.pacc[p.id] ??= {});
      for (const [an, v] of Object.entries(m.accreditations)) {
        const aid = db.accs.find((a) => lc(a.code) === lc(an)).id;
        if (v == null || v === '' || /^(n|no|false|0|-|x)$/i.test(v)) delete rec[aid];
        else rec[aid] = /^\d{4}-\d{2}-\d{2}$/.test(v) ? { v, e: v } : { v };
      }
      for (const d of parsed.dates) {
        const code = m.duties[d];
        if (code) {
          db.asg[`${p.id}|${d}`] = { c: findCode(code).code };
          summary.assignments++;
        } else delete db.asg[`${p.id}|${d}`];
      }
    });
  });
  audit(user, 'import', { mode, ...summary });
  return summary;
}

on('POST', '/import', async ({ body, query }) => {
  const u = need('planner');
  if (!(body instanceof Blob) || !body.size) bad('Upload a .xlsx or .csv file');
  let parsed;
  try {
    const rows = await readGrid(await body.arrayBuffer());
    parsed = parseGrid(rows, { dateOrder: query.dateOrder === 'mdy' ? 'mdy' : 'dmy', blankRowsAreVacancies: query.blankVacancies !== '0' });
  } catch (e) {
    bad(`Could not read spreadsheet: ${e.message}`);
  }
  const preview = {
    dates: parsed.dates.length ? { from: parsed.dates[0], to: parsed.dates.at(-1), count: parsed.dates.length } : null,
    accreditations: parsed.accreditations,
    teams: parsed.teams.map((t) => ({ name: t.name, people: t.members.length, vacancies: t.vacancies })),
    people: parsed.teams.reduce((n, t) => n + t.members.length, 0),
    warnings: parsed.warnings.slice(0, 100),
  };
  if (query.dryRun === '1') return { preview };
  const summary = applyImport(parsed, query.mode === 'replace' ? 'replace' : 'merge', u);
  changed({ type: 'meta' });
  return { preview, summary };
});

// Bulk user import (same behaviour as server/users-io.js)
on('POST', '/users/import', async ({ body, query, headers }) => {
  const u = need('admin');
  if (!(body instanceof Blob) || !body.size) bad('Upload the filled-in template (.xlsx or .csv)');
  const createTeams = query.createTeams !== '0';
  const updateExisting = query.updateExisting !== '0';
  const defaultRole = ROLES.includes(query.defaultRole) ? query.defaultRole : 'staff';
  const password = String(headers?.['X-Temp-Password'] || '');
  if (password && password.length < 8) bad('Password must be at least 8 characters');
  let parsed;
  try {
    parsed = parseUserRows(await readGrid(await body.arrayBuffer()), { teams: db.teams, accreditations: db.accs, dateOrder: query.dateOrder === 'mdy' ? 'mdy' : 'dmy' });
  } catch (e) {
    bad(`Could not read file: ${e.message}`);
  }
  const byEmail = (e) => db.people.find((p) => p.email && lc(p.email) === e);
  const byStaff = (sn) => db.people.find((p) => lc(p.staffNumber) === lc(sn));
  for (const r of parsed.rows) {
    if (r.newTeam && !createTeams) r.errors.push(`Team "${r.teamName}" does not exist`);
    const sn = r.staffNumber ? byStaff(r.staffNumber) : null;
    if (sn?.email && lc(sn.email) !== r.email) r.errors.push(`Staff No ${r.staffNumber} already belongs to ${sn.email}`);
    const existing = byEmail(r.email) || sn || db.users.find((x) => lc(x.username) === r.email);
    r.action = r.errors.length ? 'error' : existing ? (updateExisting ? 'update' : 'skip') : 'create';
  }
  const preview = {
    columns: parsed.columns,
    warnings: parsed.warnings,
    counts: ['create', 'update', 'skip', 'error'].reduce((o, k) => ({ ...o, [k]: parsed.rows.filter((r) => r.action === k).length }), {}),
    newTeams: [...new Set(parsed.rows.filter((r) => r.newTeam && createTeams).map((r) => r.teamName))],
    rows: parsed.rows.map((r) => ({ line: r.line, email: r.email, name: r.name, staffNumber: r.staffNumber, team: r.teamName, role: r.role || defaultRole, jobTitle: r.jobTitle, action: r.action, errors: r.errors })),
  };
  if (query.dryRun === '1') return { preview };

  const summary = { created: 0, updated: 0, skipped: 0, accountsCreated: 0, teamsCreated: [], credentials: [] };
  const touched = new Set();
  for (const r of parsed.rows) {
    if (r.action === 'error' || r.action === 'skip') {
      summary.skipped++;
      continue;
    }
    let teamId = null;
    if (r.teamName) {
      let team = db.teams.find((t) => lc(t.name) === lc(r.teamName));
      if (!team) {
        db.teams.push((team = { id: nextId(), name: r.teamName, sortOrder: Math.max(-1, ...db.teams.map((t) => t.sortOrder)) + 1, establishment: 0, minStrength: null, color: null }));
        summary.teamsCreated.push(r.teamName);
      }
      teamId = team.id;
      touched.add(teamId);
    }
    let person = byEmail(r.email) || (r.staffNumber ? byStaff(r.staffNumber) : null);
    const position = r.position ?? Math.max(-1, ...db.people.filter((p) => p.teamId === teamId).map((p) => p.sortOrder)) + 1;
    const fields = { email: r.email, name: r.name, initials: r.initials || null, teamId, sortOrder: position, active: true };
    if (person) {
      Object.assign(person, fields);
      if (r.mobile) person.mobile = r.mobile;
      if (r.jobTitle) person.jobTitle = r.jobTitle;
      if (r.startDate) person.startDate = r.startDate;
      if (r.staffNumber) person.staffNumber = r.staffNumber;
      summary.updated++;
    } else {
      let staffNumber = r.staffNumber;
      for (let n = db.people.length + 1; !staffNumber; n++) {
        const sn = 'U' + String(n).padStart(5, '0');
        if (!byStaff(sn)) staffNumber = sn;
      }
      db.people.push((person = { id: nextId(), staffNumber, ...fields, mobile: r.mobile || null, jobTitle: r.jobTitle || null, startDate: r.startDate }));
      summary.created++;
    }
    const rec = (db.pacc[person.id] ??= {});
    for (const [aid, val] of Object.entries(r.acc)) {
      if (!val) delete rec[aid];
      else rec[aid] = val.e ? { v: val.v, e: val.e } : { v: val.v };
    }
    const existing = db.users.find((x) => x.personId === person.id) || db.users.find((x) => lc(x.username) === r.email);
    if (existing) {
      existing.personId = person.id;
      if (r.role) existing.role = r.role;
    } else {
      const pw = password || generatePassword();
      db.users.push({ id: nextId(), username: r.email, password: pw, role: r.role || defaultRole, personId: person.id, mustChangePassword: true });
      summary.accountsCreated++;
      if (!password) summary.credentials.push({ email: r.email, name: r.name, password: pw });
    }
  }
  summary.managersNotFound = [];
  for (const r of parsed.rows) {
    if (r.action === 'error' || r.action === 'skip' || !r.lineManagerEmail) continue;
    const m = byEmail(r.lineManagerEmail);
    if (m) byEmail(r.email).lineManagerId = m.id;
    else if (!summary.managersNotFound.includes(r.lineManagerEmail)) summary.managersNotFound.push(r.lineManagerEmail);
  }
  for (const id of touched) {
    const t = db.teams.find((x) => x.id === id);
    t.establishment = Math.max(t.establishment, db.people.filter((p) => p.teamId === id && p.active).length);
  }
  audit(u, 'user.import', { created: summary.created, updated: summary.updated, skipped: summary.skipped, accountsCreated: summary.accountsCreated, teamsCreated: summary.teamsCreated });
  changed({ type: 'meta' });
  return { preview, summary };
});

on('PUT', '/people/:id/line-manager', ({ body, params }) => {
  const u = need('planner');
  const p = db.people.find((x) => x.id === Number(params.id)) || fail(404, 'Person not found');
  p.lineManagerId = checkManager(body?.lineManagerId, p.id);
  audit(u, 'person.lineManager', { id: p.id, lineManagerId: p.lineManagerId });
  changed({ type: 'leave' });
  return { ok: true };
});

// ---------------- Annual leave (same behaviour as server/leave.js) ----------------
db.leave ??= [];
db.leaveEvents ??= [];
const administers = (u) => u.role === 'admin' || !!u.leaveAdmin;
const viewerOf = (u) => ({ personId: u.personId, role: u.role, leaveAdmin: !!u.leaveAdmin, supervisor: !!u.supervisor });
db.lockdowns ??= [];
const lockdownList = () =>
  [...db.lockdowns].sort((a, b) => (a.start < b.start ? -1 : 1)).map((l) => ({ ...l, teamName: db.teams.find((t) => t.id === l.teamId)?.name ?? null }));
const leaveTypes = () => listCodes().filter((c) => c.category === 'leave' && !c.private).map((c) => ({ code: c.code, label: c.label }));
function leaveView(r) {
  const p = db.people.find((x) => x.id === r.personId) || {};
  const m = db.people.find((x) => x.id === p.lineManagerId);
  return {
    ...r,
    personName: p.name,
    staffNumber: p.staffNumber,
    teamId: p.teamId,
    teamName: db.teams.find((t) => t.id === p.teamId)?.name ?? null,
    managerPersonId: p.lineManagerId ?? null,
    managerName: m?.name ?? null,
    typeLabel: findCode(r.type)?.label ?? r.type,
  };
}
const withActs = (u) => (r) => {
  const v = leaveView(r);
  v.lockdowns = lockdownsFor(db.lockdowns, v.teamId, v.start, v.end).map(({ id, name, start, end }) => ({ id, name, start, end }));
  return { ...v, actions: leaveActions(v, viewerOf(u)) };
};
function breakdown(personId, start, end) {
  const p = db.people.find((x) => x.id === personId);
  const team = db.teams.find((t) => t.id === p?.teamId);
  const mates = p?.teamId ? db.people.filter((x) => x.teamId === p.teamId && x.active) : [];
  return leaveBreakdown({
    holidayAt: (d) => db.holidays?.[d],
    lockdownAt: (d) => lockdownsFor(db.lockdowns, p?.teamId ?? null, d, d)[0]?.name,
    dates: eachDate(start, end),
    codeAt: (d) => db.asg[`${personId}|${d}`]?.c,
    info: (c) => findCode(c),
    teamOnDuty: p?.teamId ? (d) => mates.filter((x) => findCode(db.asg[`${x.id}|${d}`]?.c || '')?.category === 'duty').length : null,
    minStrength: team?.minStrength ?? null,
  });
}
const overlaps = (pid, start, end, except = 0) => db.leave.filter((r) => r.personId === pid && r.id !== except && ACTIVE_STATUSES.includes(r.status) && r.start <= end && r.end >= start);
const leaveEvent = (id, u, action, note) => db.leaveEvents.push({ id: nextId(), requestId: id, at: new Date().toISOString().replace('T', ' ').slice(0, 19), username: db.people.find((p) => p.id === u.personId)?.name || u.username, action, note: note || null });
function targetPerson(u, personId) {
  const id = personId ? Number(personId) : u.personId;
  if (!id) bad('Your account is not linked to anyone on the plan - ask an administrator to link it');
  if (id !== u.personId && !(u.role === 'planner' || administers(u))) fail(403, 'You can only request leave for yourself');
  if (!db.people.some((p) => p.id === id)) bad('Person not found');
  return id;
}

on('GET', '/leave/summary', () => {
  const u = need('staff');
  const toApprove = db.leave.filter((r) => {
    if (r.status !== 'pending' || r.personId === u.personId) return false;
    const mgr = db.people.find((p) => p.id === r.personId)?.lineManagerId ?? null;
    return mgr === u.personId && u.personId != null ? true : mgr == null && administers(u);
  }).length;
  const toApply = db.leave
    .filter((r) => r.status === 'approved' || r.status === 'cancel_requested')
    .map(withActs(u))
    .filter((r) => r.actions.apply || r.actions.remove).length;
  const isManager = !!u.personId && db.people.some((p) => p.lineManagerId === u.personId);
  return { toApprove, toApply, isManager, administers: administers(u), canRosterLockdown: canRosterLockdown(u), leaveTypes: leaveTypes() };
});

on('GET', '/leave', ({ query }) => {
  const u = need('staff');
  const scope = query.scope || 'mine';
  const mgrOf = (r) => db.people.find((p) => p.id === r.personId)?.lineManagerId ?? null;
  let list;
  if (scope === 'mine') list = db.leave.filter((r) => r.personId === u.personId);
  else if (scope === 'approve') list = db.leave.filter((r) => r.personId !== u.personId && ((u.personId != null && mgrOf(r) === u.personId) || (administers(u) && mgrOf(r) == null)));
  else if (scope === 'apply') {
    if (!administers(u) && !canRosterLockdown(u)) fail(403, 'Only leave administrators and planner supervisors can do this');
    list = db.leave.filter((r) => ['approved', 'cancel_requested', 'applied'].includes(r.status));
  } else if (scope === 'all') {
    if (!(u.role === 'planner' || administers(u))) fail(403, 'Not permitted');
    list = db.leave;
  } else bad('Unknown scope');
  if (STATUSES.includes(query.status)) list = list.filter((r) => r.status === query.status);
  const rank = { pending: 0, cancel_requested: 1, approved: 2 };
  list = [...list].sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || (a.start < b.start ? 1 : a.start > b.start ? -1 : 0));
  return { requests: list.slice(0, 500).map(withActs(u)) };
});

on('GET', '/leave/preview', ({ query }) => {
  const u = need('staff');
  const pid = targetPerson(u, query.personId);
  const err = validateRequestDates(query.start, query.end, isValidIso, daysBetween);
  if (err) bad(err);
  const teamId = db.people.find((p) => p.id === pid)?.teamId ?? null;
  return {
    ...breakdown(pid, query.start, query.end),
    overlaps: overlaps(pid, query.start, query.end).map((r) => ({ id: r.id, start: r.start, end: r.end, status: r.status })),
    lockdowns: lockdownsFor(db.lockdowns, teamId, query.start, query.end),
  };
});

on('POST', '/leave', ({ body }) => {
  const u = need('staff');
  const b = body || {};
  const pid = targetPerson(u, b.personId);
  const err = validateRequestDates(b.start, b.end, isValidIso, daysBetween);
  if (err) bad(err);
  const type = leaveTypes().find((t) => lc(t.code) === lc(b.type || 'AL'));
  if (!type) bad('Choose a leave type');
  const clash = overlaps(pid, b.start, b.end);
  if (clash.length) fail(409, `This overlaps another request (${clash[0].start} to ${clash[0].end})`);
  const r = {
    id: nextId(),
    personId: pid,
    type: type.code,
    start: b.start,
    end: b.end,
    days: breakdown(pid, b.start, b.end).workingDays,
    note: s(b.note, 500) || null,
    status: 'pending',
    createdAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
  };
  db.leave.push(r);
  leaveEvent(r.id, u, 'requested', r.note);
  audit(u, 'leave.request', { id: r.id, personId: pid, start: r.start, end: r.end });
  changed({ type: 'leave' });
  return { request: withActs(u)(r) };
});

on('GET', '/leave/:id', ({ params }) => {
  const u = need('staff');
  const r = db.leave.find((x) => x.id === Number(params.id));
  const v = r && leaveView(r);
  if (!v || !(v.personId === u.personId || v.managerPersonId === u.personId || u.role === 'planner' || administers(u))) fail(404, 'Request not found');
  return { request: withActs(u)(r), ...breakdown(r.personId, r.start, r.end), events: db.leaveEvents.filter((e) => e.requestId === r.id) };
});

on('POST', '/leave/:id/:action', ({ params, body }) => {
  const u = need('staff');
  const action = params.action;
  if (!(action in ACTION_RESULT)) fail(404, 'Unknown action');
  const r = db.leave.find((x) => x.id === Number(params.id)) || fail(404, 'Request not found');
  const view = withActs(u)(r);
  if (!view.actions[action]) {
    if (action === 'apply' && view.actions.needsSupervisor)
      fail(403, `This leave falls in a leave lockdown (${view.lockdowns.map((l) => l.name).join(', ')}) - only a planner supervisor can add it to the roster`);
    fail(403, 'You cannot do that to this request now');
  }
  const note = s(body?.note, 500) || null;
  if ((action === 'reject' || action === 'decline') && !note) bad('Give a reason so the person knows why');
  const who = db.people.find((p) => p.id === u.personId)?.name || u.username;
  let rosterChanged = false;
  if (action === 'approve' || action === 'reject' || action === 'decline') Object.assign(r, { status: ACTION_RESULT[action], decidedBy: who, decidedAt: new Date().toISOString(), decisionNote: note });
  else if (action === 'apply') {
    const code = findCode(String(body?.code || r.type));
    if (!code || code.category !== 'leave') bad('Choose a leave code to put on the roster');
    const plan = leavePlan(breakdown(r.personId, r.start, r.end).days, code.code, (c) => !!findCode(c));
    r.snapshot = plan.map((p) => [p.date, db.asg[`${r.personId}|${p.date}`]?.c ?? null, db.asg[`${r.personId}|${p.date}`]?.n ?? null, p.code]);
    for (const p of plan) db.asg[`${r.personId}|${p.date}`] = { c: p.code, n: `Leave request #${r.id}` };
    Object.assign(r, { status: 'applied', appliedBy: who, appliedAt: new Date().toISOString(), appliedCode: code.code });
    rosterChanged = plan.length > 0;
  } else if (action === 'remove') {
    for (const [d, code, prevNote, written] of r.snapshot || []) {
      const k = `${r.personId}|${d}`;
      if (db.asg[k]?.c !== (written ?? r.appliedCode)) continue;
      if (code) db.asg[k] = prevNote ? { c: code, n: prevNote } : { c: code };
      else delete db.asg[k];
      rosterChanged = true;
    }
    r.status = 'cancelled';
  } else r.status = ACTION_RESULT[action];
  leaveEvent(r.id, u, action, note);
  audit(u, `leave.${action}`, { id: r.id, personId: r.personId, start: r.start, end: r.end });
  if (rosterChanged) changed({ type: 'roster', from: r.start, to: r.end });
  changed({ type: 'leave' });
  return { request: withActs(u)(r) };
});

// ---------------- Leave lockdowns ----------------
const lockdownBody = (b) => {
  const name = s(b?.name, 100);
  if (!name) bad('Give the lockdown a name');
  if (!isValidIso(b.start) || !isValidIso(b.end)) bad('Choose a first and last day');
  if (b.end < b.start) bad('The last day must be on or after the first day');
  const teamId = b.teamId == null || b.teamId === '' ? null : Number(b.teamId);
  if (teamId != null && !db.teams.some((t) => t.id === teamId)) bad('Team not found');
  return { name, start: b.start, end: b.end, teamId, note: s(b.note, 500) || null };
};
on('GET', '/lockdowns', () => {
  need('staff');
  return { lockdowns: lockdownList() };
});
on('POST', '/lockdowns', ({ body }) => {
  const u = need('planner');
  const l = { id: nextId(), ...lockdownBody(body) };
  db.lockdowns.push(l);
  audit(u, 'lockdown.create', { id: l.id, name: l.name, start: l.start, end: l.end });
  changed({ type: 'meta' });
  changed({ type: 'leave' });
  return { id: l.id };
});
on('PUT', '/lockdowns/:id', ({ body, params }) => {
  const u = need('planner');
  const l = db.lockdowns.find((x) => x.id === Number(params.id)) || fail(404, 'Lockdown not found');
  Object.assign(l, lockdownBody(body));
  audit(u, 'lockdown.update', { id: l.id, name: l.name, start: l.start, end: l.end });
  changed({ type: 'meta' });
  changed({ type: 'leave' });
  return { ok: true };
});
on('DELETE', '/lockdowns/:id', ({ params }) => {
  const u = need('planner');
  const id = Number(params.id);
  if (!db.lockdowns.some((l) => l.id === id)) fail(404, 'Lockdown not found');
  db.lockdowns = db.lockdowns.filter((l) => l.id !== id);
  audit(u, 'lockdown.delete', { id });
  changed({ type: 'meta' });
  changed({ type: 'leave' });
  return { ok: true };
});

// ---------------- Public holidays ----------------
db.holidays ??= {};
on('GET', '/public-holidays', ({ query }) => {
  need('staff');
  const from = isValidIso(query.from) ? query.from : '0000-00-00';
  const to = isValidIso(query.to) ? query.to : '9999-12-31';
  const holidays = Object.entries(db.holidays)
    .filter(([d]) => d >= from && d <= to)
    .sort()
    .map(([date, name]) => ({ date, name }));
  return { holidays, regions: REGIONS };
});
on('POST', '/public-holidays', ({ body }) => {
  const u = need('planner');
  if (!isValidIso(body?.date)) bad('Choose a date');
  const name = s(body?.name, 100);
  if (!name) bad('Give the holiday a name');
  db.holidays[body.date] = name;
  audit(u, 'holiday.save', { date: body.date, name });
  changed({ type: 'meta' });
  return { ok: true };
});
on('DELETE', '/public-holidays/:date', ({ params }) => {
  const u = need('planner');
  if (!db.holidays[params.date]) fail(404, 'Holiday not found');
  delete db.holidays[params.date];
  audit(u, 'holiday.delete', { date: params.date });
  changed({ type: 'meta' });
  return { ok: true };
});
on('POST', '/public-holidays/generate', ({ body }) => {
  const u = need('planner');
  const year = Number(body?.year);
  if (!(Number.isInteger(year) && year >= 2000 && year <= 2100)) bad('Choose a year between 2000 and 2100');
  const region = body?.region in REGIONS ? body.region : 'england-wales';
  let added = 0;
  for (const h of ukBankHolidays(year, region))
    if (!db.holidays[h.date]) {
      db.holidays[h.date] = h.name;
      added++;
    }
  audit(u, 'holiday.generate', { year, region, added });
  changed({ type: 'meta' });
  return { added };
});

// ---------------- Public interface (same as public/js/api.js) ----------------
export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const url = new URL(path, 'http://demo');
  const route = routes.find((r) => r.method === method && r.re.test(url.pathname));
  try {
    if (!route) fail(404, 'Not found');
    const params = url.pathname.match(route.re).groups || {};
    const result = await route.fn({ body: body instanceof Blob ? body : clone(body), query: Object.fromEntries(url.searchParams), params, headers });
    if (method !== 'GET') save();
    emit({ type: 'online' });
    return clone(result);
  } catch (e) {
    if (e.status === 401) emit({ type: 'unauthorized' });
    if (e.code === 'PASSWORD_CHANGE') emit({ type: 'password-change' });
    throw e;
  }
}
export const get = (p) => api(p);
export const post = (p, body) => api(p, { method: 'POST', body: body ?? {} });
export const put = (p, body) => api(p, { method: 'PUT', body });
export const del = (p) => api(p, { method: 'DELETE' });

export function download(path) {
  if (path.startsWith('/users/template')) {
    // Downloads are blocked here, so show the template's columns to copy instead.
    const csv = templateCsv(listAccs());
    const d = dialog(
      'New users template',
      html`<p>Downloads are off in this preview. Copy this header row into a new spreadsheet (or a text file saved as .csv), add one row per person, then upload it.</p>
        <textarea class="copy-src" readonly>${csv}</textarea>
        <p class="muted">The deployed app downloads an Excel template with dropdowns for team and role, plus an instructions sheet.</p>`,
      { actions: '<button type="button" class="btn btn-primary" data-copy>Copy header row</button>' },
    );
    d.querySelector('[data-copy]').addEventListener('click', async () => {
      const ta = d.querySelector('textarea');
      try {
        await navigator.clipboard.writeText(ta.value);
        d.querySelector('[data-copy]').textContent = 'Copied';
      } catch {
        ta.select();
      }
    });
    return;
  }
  const what = path.startsWith('/my.ics') ? 'your duties as a calendar file (.ics) to add to your phone or Outlook calendar' : 'the plan as a colour-coded Excel workbook in the same layout used for import';
  dialog('Downloads are off in this preview', html`<p>In the deployed app this button downloads ${what}.</p><p class="muted">This preview runs entirely in your browser, which can't save files.</p>`);
}
