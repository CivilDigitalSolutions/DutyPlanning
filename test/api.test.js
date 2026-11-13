import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { hashPassword } from '../server/auth.js';

let server, base, db;

before(async () => {
  db = openDb(':memory:');
  const t1 = Number(db.prepare("INSERT INTO teams (name, sort_order, establishment) VALUES ('Team 1', 0, 3)").run().lastInsertRowid);
  const t2 = Number(db.prepare("INSERT INTO teams (name, sort_order, establishment) VALUES ('Team 2', 1, 1)").run().lastInsertRowid);
  db.prepare("INSERT INTO people (staff_number, name, initials, mobile, team_id) VALUES ('100','Ann Able','AA','0711',?)").run(t1);
  db.prepare("INSERT INTO people (staff_number, name, initials, mobile, team_id) VALUES ('101','Bob Baker','BB','0722',?)").run(t1);
  db.prepare("INSERT INTO people (staff_number, name, initials, mobile, team_id) VALUES ('200','Cat Cole','CC','0733',?)").run(t2);
  const pw = hashPassword('password123');
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('admin', ?, 'admin')").run(pw);
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('plan', ?, 'planner')").run(pw);
  db.prepare("INSERT INTO users (username, password_hash, role, person_id) VALUES ('100', ?, 'staff', 1)").run(pw);
  db.prepare("INSERT INTO users (username, password_hash, role, person_id, must_change_password) VALUES ('new', ?, 'staff', 2, 1)").run(pw);
  const app = createApp(db, { mobileVisibility: 'team' });
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function login(username, password = 'password123') {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'DutyPlanning' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login ${username}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (path, { method = 'GET', body, headers = {} } = {}) => {
    const r = await fetch(base + '/api' + path, {
      method,
      headers: { cookie, 'X-Requested-With': 'DutyPlanning', ...(body && !(body instanceof Buffer) ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body instanceof Buffer ? body : body ? JSON.stringify(body) : undefined,
    });
    const type = r.headers.get('content-type') || '';
    return { status: r.status, body: type.includes('json') ? await r.json() : await r.arrayBuffer(), headers: r.headers };
  };
}

test('rejects bad credentials and unauthenticated access', async () => {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'DutyPlanning' },
    body: JSON.stringify({ username: 'admin', password: 'nope' }),
  });
  assert.equal(res.status, 401);
  assert.equal((await fetch(base + '/api/meta')).status, 401);
});

test('mutations require the CSRF header', async () => {
  const res = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('forced password change blocks other endpoints until changed', async () => {
  const api = await login('new');
  assert.equal((await api('/meta')).status, 403);
  const r = await api('/auth/password', { method: 'POST', body: { current: 'password123', password: 'brandnewpass' } });
  assert.equal(r.status, 200);
  assert.equal((await api('/meta')).status, 200);
});

test('planner edits assignments; staff cannot', async () => {
  const plan = await login('plan');
  const staff = await login('100');
  const ok = await plan('/assignments', { method: 'PUT', body: { changes: [{ personId: 2, date: '2030-01-01', code: 'T1' }, { personId: 3, date: '2030-01-01', code: 'SICK', note: 'flu' }] } });
  assert.equal(ok.status, 200);
  assert.equal((await staff('/assignments', { method: 'PUT', body: { changes: [{ personId: 1, date: '2030-01-01', code: 'T1' }] } })).status, 403);
  const badCode = await plan('/assignments', { method: 'PUT', body: { changes: [{ personId: 1, date: '2030-01-01', code: 'NOPE' }] } });
  assert.equal(badCode.status, 400);
  // Case-insensitive code is normalised
  await plan('/assignments', { method: 'PUT', body: { changes: [{ personId: 1, date: '2030-01-02', code: 'rd' }] } });
  const r = await plan('/roster?from=2030-01-01&to=2030-01-02');
  assert.deepEqual(r.body.assignments.find((a) => a[0] === 1), [1, '2030-01-02', 'RD']);
});

test('staff see private codes masked, notes hidden, mobiles only for own team', async () => {
  const staff = await login('100');
  const r = await staff('/roster?from=2030-01-01&to=2030-01-01');
  const cat = r.body.assignments.find((a) => a[0] === 3);
  assert.deepEqual(cat, [3, '2030-01-01', '*']);
  const people = Object.fromEntries(r.body.people.map((p) => [p.staffNumber, p]));
  assert.equal(people['101'].mobile, '0722'); // team mate
  assert.equal(people['200'].mobile, undefined); // other team
  const plan = await login('plan');
  const r2 = await plan('/roster?from=2030-01-01&to=2030-01-01');
  assert.deepEqual(r2.body.assignments.find((a) => a[0] === 3), [3, '2030-01-01', 'SICK', 'flu']);
});

test('rota pattern applies with anchor and offsets', async () => {
  const plan = await login('plan');
  const r = await plan('/assignments/pattern', {
    method: 'POST',
    body: { personIds: [1, 2], from: '2031-01-01', to: '2031-01-08', anchor: '2031-01-01', pattern: ['T1', 'T1', 'RD', 'RD'], offsets: { 2: 2 } },
  });
  assert.equal(r.status, 200);
  const roster = await plan('/roster?from=2031-01-01&to=2031-01-08');
  const codes = (pid) => roster.body.assignments.filter((a) => a[0] === pid).map((a) => a[2]).join(' ');
  assert.equal(codes(1), 'T1 T1 RD RD T1 T1 RD RD');
  assert.equal(codes(2), 'RD RD T1 T1 RD RD T1 T1');
});

test('import CSV with team heading rows and vacancies, then export round trip', async () => {
  const plan = await login('plan');
  const csv = [
    'Staff No,Name,Initials,Mobile,First Aid,Driver,Mon 05/01/2032,06/01/2032,2032-01-07',
    'Red Watch,,,,,,,,',
    '500,Dan Dean,DD,0744,Y,,T1,T1,RD',
    '501,Eve East,,0755,2033-01-01,Y,AL,AL,AL',
    ',,,,,,,,',
    'VACANT,,,,,,,,',
    'Blue Watch,,,,,,,,',
    '502,Fay Fox,FF,,,,,Course X,RD',
  ].join('\n');
  const dry = await plan('/import?dryRun=1', { method: 'POST', body: Buffer.from(csv), headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.deepEqual(dry.body.preview.teams, [
    { name: 'Red Watch', people: 2, vacancies: 2 },
    { name: 'Blue Watch', people: 1, vacancies: 0 },
  ]);
  assert.deepEqual(dry.body.preview.dates, { from: '2032-01-05', to: '2032-01-07', count: 3 });
  assert.deepEqual(dry.body.preview.accreditations, ['First Aid', 'Driver']);

  const run = await plan('/import', { method: 'POST', body: Buffer.from(csv), headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal(run.status, 200);
  assert.equal(run.body.summary.peopleCreated, 3);
  assert.deepEqual(run.body.summary.newDutyCodes, ['Course X']);

  const meta = await plan('/meta');
  const red = meta.body.teams.find((t) => t.name === 'Red Watch');
  assert.equal(red.establishment, 4);
  assert.equal(meta.body.dutyCodes.find((c) => c.code === 'Course X').category, 'training');

  const roster = await plan('/roster?from=2032-01-05&to=2032-01-07');
  const eve = roster.body.people.find((p) => p.staffNumber === '501');
  const fa = meta.body.accreditations.find((a) => a.code === 'First Aid');
  assert.deepEqual(eve.acc[fa.id], { v: '2033-01-01', e: '2033-01-01' });

  const xlsx = await plan('/export.xlsx?from=2032-01-05&to=2032-01-07');
  assert.equal(xlsx.status, 200);
  const buf = Buffer.from(xlsx.body);
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  // Re-import the export (dry run) and check it reads back the same structure.
  const again = await plan('/import?dryRun=1', { method: 'POST', body: buf, headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  const redAgain = again.body.preview.teams.find((t) => t.name === 'Red Watch');
  assert.deepEqual(redAgain, { name: 'Red Watch', people: 2, vacancies: 2 });
  assert.equal(again.body.preview.dates.count, 3);
});

test('admin manages users; planner cannot', async () => {
  const plan = await login('plan');
  assert.equal((await plan('/users')).status, 403);
  const admin = await login('admin');
  const bulk = await admin('/users/bulk', { method: 'POST', body: { password: 'welcome123' } });
  assert.equal(bulk.status, 200);
  assert.ok(bulk.body.created >= 3);
  const u = await admin('/users');
  assert.ok(u.body.users.some((x) => x.username === '500' && x.role === 'staff' && x.mustChangePassword));
});

test('calendar export for linked staff', async () => {
  const staff = await login('100');
  const r = await staff('/my.ics');
  assert.equal(r.status, 200);
  assert.match(Buffer.from(r.body).toString(), /BEGIN:VCALENDAR/);
});

test('team leader and supervisors: set per team, one leader, shown on the roster', async () => {
  const plan = await login('plan');
  const staff = await login('100');
  // Team 1 has people 1 (Ann) and 2 (Bob); person 3 (Cat) is in Team 2.
  assert.equal((await staff('/teams/1/roles', { method: 'PUT', body: { leaderId: 1 } })).status, 403);
  assert.equal((await plan('/teams/1/roles', { method: 'PUT', body: { leaderId: 3 } })).status, 400, 'leader must be in the team');
  assert.equal((await plan('/teams/1/roles', { method: 'PUT', body: { leaderId: 1, supervisorIds: [1] } })).status, 400, 'not both');
  assert.equal((await plan('/teams/1/roles', { method: 'PUT', body: { leaderId: 1, supervisorIds: [2] } })).status, 200);

  const roster = await staff('/roster?from=2030-01-01&to=2030-01-01');
  const role = Object.fromEntries(roster.body.people.map((p) => [p.staffNumber, p.teamRole]));
  assert.deepEqual([role['100'], role['101'], role['200']], ['leader', 'supervisor', null]);
  const team = roster.body.teams.find((t) => t.id === 1);
  assert.deepEqual([team.leaderName, team.supervisorNames], ['Ann Able', 'Bob Baker']);

  // Making Bob leader on his own record steps Ann down: one leader per team.
  const bob = (await plan('/people')).body.people.find((p) => p.staffNumber === '101');
  assert.equal((await plan(`/people/${bob.id}`, { method: 'PUT', body: { ...bob, teamRole: 'leader' } })).status, 200);
  const after = Object.fromEntries((await plan('/people')).body.people.map((p) => [p.staffNumber, p.teamRole]));
  assert.deepEqual([after['100'], after['101']], [null, 'leader']);
  assert.equal((await plan(`/people/${bob.id}`, { method: 'PUT', body: { ...bob, teamRole: 'boss' } })).status, 400);
});
