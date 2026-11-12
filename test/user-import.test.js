import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { hashPassword } from '../server/auth.js';

let server, base, db;
before(async () => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO teams (name, sort_order, establishment) VALUES ('Team 1', 0, 5)").run();
  db.prepare("INSERT INTO accreditations (code, name) VALUES ('FA', 'First Aid')").run();
  db.prepare("INSERT INTO people (staff_number, name, team_id, email) VALUES ('100', 'Existing Person', 1, 'existing@org.test')").run();
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('admin', ?, 'admin')").run(hashPassword('password123'));
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('plan', ?, 'planner')").run(hashPassword('password123'));
  const app = createApp(db);
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function session(username, password = 'password123') {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'DutyPlanning' },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) return null;
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (path, { method = 'GET', body, headers = {} } = {}) => {
    const r = await fetch(base + '/api' + path, { method, headers: { cookie, 'X-Requested-With': 'DutyPlanning', ...headers }, body });
    const json = (r.headers.get('content-type') || '').includes('json');
    return { status: r.status, body: json ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
}

const CSV = [
  'Email,First name,Last name,Staff No,Mobile,Team,Job title,Start date,App role,FA',
  'new.one@org.test,New,One,200,07700 900001,Team 1,Officer,01/04/2026,,Y',
  'NEW.TWO@org.test,New,Two,,,Night Shift,,,planner,31/12/2027',
  'existing@org.test,Existing,Person,,07700 900099,Team 1,Sergeant,,,',
  'bad-email,No,Good,,,,,,,',
  'new.one@org.test,Dup,Licate,,,,,,,',
  'third@org.test,,,,,,,,boss,',
].join('\n');

test('template downloads (admin only)', async () => {
  const planner = await session('plan');
  assert.equal((await planner('/users/template.xlsx')).status, 403);
  const admin = await session('admin');
  const x = await admin('/users/template.xlsx');
  assert.equal(x.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.body);
  const headers = wb.getWorksheet('New users').getRow(1).values.filter(Boolean);
  assert.deepEqual(headers.slice(0, 3), ['Email *', 'First name', 'Last name']);
  assert.ok(headers.includes('Team') && headers.includes('Mobile') && headers.includes('FA'));
  assert.ok(wb.getWorksheet('Instructions'));
  const c = await admin('/users/template.csv');
  assert.match(c.body.toString(), /Email,First name,Last name,Full name,Staff No/);
});

test('dry run reports actions and row errors', async () => {
  const admin = await session('admin');
  const r = await admin('/users/import?dryRun=1', { method: 'POST', body: CSV });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = r.body.preview;
  assert.deepEqual(p.counts, { create: 2, update: 1, skip: 0, error: 3 });
  assert.deepEqual(p.newTeams, ['Night Shift']);
  const byLine = Object.fromEntries(p.rows.map((x) => [x.line, x]));
  assert.match(byLine[5].errors[0], /not a valid email/);
  assert.match(byLine[6].errors[0], /also used on row 2/);
  assert.ok(byLine[7].errors.some((e) => /Name is missing/.test(e)) && byLine[7].errors.some((e) => /App role/.test(e)));
  const noCreate = await admin('/users/import?dryRun=1&createTeams=0', { method: 'POST', body: CSV });
  assert.match(noCreate.body.preview.rows[1].errors[0], /Team "Night Shift" does not exist/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM people').get().n, 1, 'dry run writes nothing');
});

test('import creates people, accounts, teams and generated passwords; email sign-in works', async () => {
  const admin = await session('admin');
  const r = await admin('/users/import', { method: 'POST', body: CSV });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = r.body.summary;
  assert.equal(s.created, 2);
  assert.equal(s.updated, 1);
  assert.equal(s.skipped, 3);
  assert.deepEqual(s.teamsCreated, ['Night Shift']);
  assert.equal(s.credentials.length, 3); // two new people + existing person had no login
  const one = db.prepare("SELECT * FROM people WHERE email = 'new.one@org.test'").get();
  assert.equal(one.staff_number, '200');
  assert.equal(one.job_title, 'Officer');
  assert.equal(one.start_date, '2026-04-01');
  assert.equal(one.initials, 'NO');
  const two = db.prepare("SELECT * FROM people WHERE email = 'new.two@org.test'").get();
  assert.match(two.staff_number, /^U\d{5}$/);
  assert.equal(db.prepare("SELECT role FROM users WHERE username = 'new.two@org.test'").get().role, 'planner');
  assert.equal(db.prepare('SELECT expires FROM person_accreditations WHERE person_id = ?').get(two.id).expires, '2027-12-31');
  const existing = db.prepare("SELECT * FROM people WHERE email = 'existing@org.test'").get();
  assert.equal(existing.mobile, '07700 900099');
  assert.equal(existing.job_title, 'Sergeant');

  const cred = s.credentials.find((c) => c.email === 'new.one@org.test');
  const user = await session('New.One@org.test', cred.password);
  assert.ok(user, 'can sign in with email');
  assert.equal((await user('/meta')).status, 403, 'must change password first');

  // Re-running with a shared password does not reset existing accounts.
  const again = await admin('/users/import', { method: 'POST', body: CSV, headers: { 'X-Temp-Password': 'Welcome2026' } });
  assert.equal(again.body.summary.accountsCreated, 0);
  assert.equal(again.body.summary.updated, 3);
});

test('the downloaded Excel template can be filled in and uploaded as-is', async () => {
  const admin = await session('admin');
  const x = await admin('/users/template.xlsx');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.body);
  const ws = wb.getWorksheet('New users');
  const col = Object.fromEntries(ws.getRow(1).values.map((v, i) => [String(v).replace(' *', ''), i]).filter(([k]) => k !== 'undefined'));
  const row = ws.getRow(2);
  row.getCell(col.Email).value = 'from.template@org.test';
  row.getCell(col['Full name']).value = 'From Template';
  row.getCell(col.Team).value = 'Team 1';
  row.getCell(col['Start date']).value = new Date(Date.UTC(2026, 5, 1));
  row.getCell(col['App role']).value = 'staff';
  row.getCell(col.FA).value = new Date(Date.UTC(2028, 0, 31));
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const r = await admin('/users/import', { method: 'POST', body: buf, headers: { 'X-Temp-Password': 'Welcome2026' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.summary.created, 1);
  assert.equal(r.body.summary.credentials.length, 0, 'shared password is not echoed back');
  const p = db.prepare("SELECT * FROM people WHERE email = 'from.template@org.test'").get();
  assert.equal(p.start_date, '2026-06-01');
  assert.equal(db.prepare('SELECT expires FROM person_accreditations WHERE person_id = ?').get(p.id).expires, '2028-01-31');
  assert.ok(await session('from.template@org.test', 'Welcome2026'));
});

test('import sets line managers, including ones in the same file', async () => {
  const admin = await session('admin');
  const csv = [
    'Email,Full name,Line manager email',
    'report@org.test,Rae Report,boss@org.test',
    'boss@org.test,Bo Boss,',
    'other@org.test,Oli Other,nobody@org.test',
  ].join('\n');
  const dry = await admin('/users/import?dryRun=1', { method: 'POST', body: csv });
  assert.ok(dry.body.preview.warnings.some((w) => /nobody@org.test/.test(w)));
  const r = await admin('/users/import', { method: 'POST', body: csv, headers: { 'X-Temp-Password': 'Welcome2026' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rep = db.prepare("SELECT * FROM people WHERE email = 'report@org.test'").get();
  const boss = db.prepare("SELECT * FROM people WHERE email = 'boss@org.test'").get();
  assert.equal(rep.line_manager_id, boss.id);
  assert.deepEqual(r.body.summary.managersNotFound, ['nobody@org.test']);
});
