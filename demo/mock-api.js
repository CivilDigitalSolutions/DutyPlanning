// In-browser stand-in for the server API, used only by the standalone demo build.
// It exports the same interface as public/js/api.js and applies the same rules
// (roles, private codes, mobile visibility, validation) against data held in
// memory and saved to this browser's localStorage.
import { parseCsv, parseGrid, cellValue, guessCategory, colorFor } from '../server/sheet-parse.js';
import { daysBetween, eachDate, isValidIso } from '../server/dates.js';
import { seedDemo } from './seed.js';
import { dialog, html, todayIso } from '../public/js/util.js';

const KEY = 'dp-demo-v1';
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
  if (list.some((x) => lc(x[key]) === lc(val) && x.id !== exceptId)) fail(409, msg);
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
  const u = db.users.find((x) => lc(x.username) === lc(s(body?.username, 100)));
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
      person: p ? { id: p.id, staffNumber: p.staffNumber, name: p.name, initials: p.initials, teamId: p.teamId } : null,
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
    const out = { id: p.id, staffNumber: p.staffNumber, name: p.name, initials: p.initials, mobile: p.mobile, teamId: p.teamId, sortOrder: p.sortOrder, acc: db.pacc[p.id] || {} };
    const canSee = planner || p.id === mine?.id || (mine?.teamId && mine.teamId === p.teamId);
    if (!canSee) delete out.mobile;
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
  return { from, to, teams: listTeams(), people, assignments };
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
const personBody = (b) => {
  const staffNumber = s(b.staffNumber, 50);
  const name = s(b.name, 150);
  if (!staffNumber) bad('Staff number is required');
  if (!name) bad('Name is required');
  const teamId = optInt(b.teamId);
  if (Number.isNaN(teamId)) bad('Invalid team');
  if (teamId != null && !db.teams.some((t) => t.id === teamId)) bad('Team not found');
  const sortOrder = optInt(b.sortOrder) ?? 0;
  return { staffNumber, name, initials: s(b.initials, 10) || null, mobile: s(b.mobile, 30) || null, teamId, sortOrder: Number.isNaN(sortOrder) ? 0 : sortOrder, active: b.active !== false };
};
on('POST', '/people', ({ body }) => {
  const u = need('planner');
  const p = personBody(body || {});
  unique(db.people, 'staffNumber', p.staffNumber, null, 'That staff number already exists');
  const id = nextId();
  db.people.push({ id, ...p });
  audit(u, 'person.create', { id, staffNumber: p.staffNumber });
  changed({ type: 'meta' });
  return { id };
});
on('PUT', '/people/:id', ({ body, params }) => {
  const u = need('planner');
  const p = db.people.find((x) => x.id === Number(params.id)) || fail(404, 'Person not found');
  const v = personBody(body || {});
  unique(db.people, 'staffNumber', v.staffNumber, p.id, 'That staff number already exists');
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
  db.users.push({ id, username, password: body.password, ...f, mustChangePassword: true });
  audit(u, 'user.create', { id, username, role: f.role });
  return { id };
});
on('PUT', '/users/:id', ({ body, params }) => {
  const me_ = need('admin');
  const u = db.users.find((x) => x.id === Number(params.id)) || fail(404, 'User not found');
  const f = userFields(body || {});
  if (u.id === me_.id && f.role !== 'admin') bad('You cannot remove your own admin role');
  Object.assign(u, f);
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

// ---------------- Public interface (same as public/js/api.js) ----------------
export async function api(path, { method = 'GET', body } = {}) {
  const url = new URL(path, 'http://demo');
  const route = routes.find((r) => r.method === method && r.re.test(url.pathname));
  try {
    if (!route) fail(404, 'Not found');
    const params = url.pathname.match(route.re).groups || {};
    const result = await route.fn({ body: body instanceof Blob ? body : clone(body), query: Object.fromEntries(url.searchParams), params });
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
  const what = path.startsWith('/my.ics') ? 'your duties as a calendar file (.ics) to add to your phone or Outlook calendar' : 'the plan as a colour-coded Excel workbook in the same layout used for import';
  dialog('Downloads are off in this preview', html`<p>In the deployed app this button downloads ${what}.</p><p class="muted">This preview runs entirely in your browser, which can't save files.</p>`);
}
