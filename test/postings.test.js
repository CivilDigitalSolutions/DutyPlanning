import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { hashPassword } from '../server/auth.js';

let server, base, db;
const pw = hashPassword('password123');
before(async () => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO teams (id, name) VALUES (1, 'Team 1'), (2, 'Team 2')").run();
  db.prepare("INSERT INTO people (id, staff_number, name, team_id, team_role) VALUES (1, '1', 'Tess Leader', 1, 'leader'), (2, '2', 'Sid Super', 1, 'supervisor'), (3, '3', 'Pat Member', 1, NULL), (4, '4', 'Other Team', 2, NULL)").run();
  db.prepare("INSERT INTO users (username, password_hash, role, person_id) VALUES ('tess', ?, 'staff', 1), ('sid', ?, 'staff', 2), ('pat', ?, 'staff', 3)").run(pw, pw, pw);
  db.prepare("INSERT INTO team_positions (team_id, person_id, role) VALUES (1, 1, 'leader'), (1, 2, 'supervisor')").run();
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('plan', ?, 'planner')").run(pw);
  // 2031-03-03 and 04: everyone in Team 1 on T1; Pat on RD on the 5th.
  const ins = db.prepare('INSERT INTO assignments (person_id, date, code) VALUES (?,?,?)');
  for (const pid of [1, 2, 3]) for (const d of ['2031-03-03', '2031-03-04']) ins.run(pid, d, 'T1');
  ins.run(3, '2031-03-05', 'RD');
  ins.run(1, '2031-03-05', 'T1');
  const app = createApp(db);
  await new Promise((r) => (server = app.listen(0, r)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function as(username) {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'DutyPlanning' },
    body: JSON.stringify({ username, password: 'password123' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (path, body, method) => {
    const r = await fetch(base + '/api' + path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { cookie, 'X-Requested-With': 'DutyPlanning', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
}

test('team leader and supervisors set postings for their own team; others can only view', async () => {
  const tess = await as('tess');
  const sid = await as('sid');
  const pat = await as('pat');
  const types = (await pat('/posting-types')).body.types;
  const appts = types.find((t) => t.name === 'Appointments').id;
  const driver = types.find((t) => t.name === 'Response driver').id;

  const r = await tess('/postings', { date: '2031-03-03', changes: [{ personId: 3, typeId: appts, time: '10:00', detail: 'Statement - Smith' }, { personId: 2, typeId: driver }] }, 'PUT');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await sid('/postings', { date: '2031-03-03', changes: [{ personId: 1, typeId: driver }] }, 'PUT')).status, 200, 'supervisor can edit');
  assert.equal((await pat('/postings', { date: '2031-03-03', changes: [{ personId: 3, typeId: driver }] }, 'PUT')).status, 403, 'member cannot edit');
  assert.equal((await tess('/postings', { date: '2031-03-03', changes: [{ personId: 4, typeId: driver }] }, 'PUT')).status, 403, 'not another team');
  assert.equal((await tess('/postings', { date: '2031-03-03', changes: [{ personId: 3, typeId: appts, time: '25:00' }] }, 'PUT')).status, 400);

  const day = await pat('/postings?date=2031-03-03');
  assert.deepEqual(day.body.editableTeams, []);
  assert.deepEqual((await tess('/postings?date=2031-03-03')).body.editableTeams, [1]);
  const patPost = day.body.postings.find((p) => p.personId === 3);
  assert.deepEqual([patPost.typeId, patPost.time, patPost.detail, patPost.updatedBy], [appts, '10:00', 'Statement - Smith', 'Tess Leader']);
  // The duty plan is untouched.
  assert.equal(db.prepare("SELECT code FROM assignments WHERE person_id = 3 AND date = '2031-03-03'").get().code, 'T1');

  // Clearing a posting.
  await tess('/postings', { date: '2031-03-03', changes: [{ personId: 2, typeId: null }] }, 'PUT');
  assert.equal((await pat('/postings?date=2031-03-03')).body.postings.length, 2);
});

test('copy from the last working day only posts people on duty', async () => {
  const tess = await as('tess');
  const plan = await as('plan');
  const a = await tess('/postings/copy', { teamId: 1, to: '2031-03-04' });
  assert.deepEqual([a.body.from, a.body.copied, a.body.skipped], ['2031-03-03', 2, 0]);
  // Pat is on a rest day on the 5th, so only Tess's posting copies.
  const b = await tess('/postings/copy', { teamId: 1, to: '2031-03-05' });
  assert.deepEqual([b.body.from, b.body.copied, b.body.skipped], ['2031-03-04', 1, 1]);
  assert.equal((await tess('/postings/copy', { teamId: 2, to: '2031-03-05' })).status, 403);
  assert.equal((await plan('/postings/copy', { teamId: 2, to: '2031-03-05' })).status, 400, 'nothing to copy for team 2');
  const range = await plan('/postings?from=2031-03-01&to=2031-03-31&person=3');
  assert.equal(range.body.postings.length, 2);
});

test('posting types: planners manage them; used types are hidden, not deleted', async () => {
  const plan = await as('plan');
  const pat = await as('pat');
  assert.equal((await pat('/posting-types', { name: 'Nope' })).status, 403);
  const id = (await plan('/posting-types', { name: 'Scene guard', color: '#123456' })).body.id;
  assert.equal((await plan('/posting-types', { name: 'scene GUARD' })).status, 409);
  const appts = (await plan('/posting-types')).body.types.find((t) => t.name === 'Appointments').id;
  assert.equal((await plan(`/posting-types/${appts}`, undefined, 'DELETE')).body.hidden, true);
  assert.equal((await plan(`/posting-types/${id}`, undefined, 'DELETE')).body.hidden, false);
  const after = (await plan('/posting-types')).body.types;
  assert.equal(after.find((t) => t.id === appts).active, false);
  assert.equal(after.some((t) => t.id === id), false);
});

test('postings are private to each team; leaders/supervisors of several teams see all of theirs', async () => {
  db.prepare("INSERT INTO users (username, password_hash, role, person_id) VALUES ('otto', ?, 'staff', 4)").run(pw);
  db.prepare("INSERT INTO assignments (person_id, date, code) VALUES (4, '2031-03-03', 'T2')").run();
  const plan = await as('plan');
  const pat = await as('pat');
  const otto = await as('otto');
  const sid = await as('sid');
  const patrol = (await plan('/posting-types')).body.types.find((t) => t.name === 'Patrol').id;
  assert.equal((await plan('/postings', { date: '2031-03-03', changes: [{ personId: 4, typeId: patrol, detail: 'Team 2 only' }] }, 'PUT')).status, 200);

  const ids = async (who) => (await who('/postings?date=2031-03-03')).body.postings.map((p) => p.personId).sort();
  assert.deepEqual(await ids(pat), [1, 3], 'Team 1 member sees Team 1 only');
  assert.deepEqual(await ids(otto), [4], 'Team 2 member sees Team 2 only');
  assert.deepEqual(await ids(plan), [1, 3, 4], 'planner sees all teams');
  assert.deepEqual((await pat('/postings?date=2031-03-03')).body.visibleTeams, [1]);
  assert.equal((await otto('/postings?from=2031-03-01&to=2031-03-31&person=3')).body.postings.length, 0, 'cannot read another team by asking for a person');

  // Sid supervises Team 1 (own team) and now Team 2 as well: sees and can post both.
  assert.equal((await sid('/postings', { date: '2031-03-03', changes: [{ personId: 4, typeId: patrol }] }, 'PUT')).status, 403);
  assert.equal((await plan('/teams/2/roles', { leaderId: null, supervisorIds: [2] }, 'PUT')).status, 200);
  assert.deepEqual(await ids(sid), [1, 3, 4]);
  assert.deepEqual((await sid('/postings?date=2031-03-03')).body.editableTeams, [1, 2]);
  assert.equal((await sid('/postings', { date: '2031-03-03', changes: [{ personId: 4, typeId: patrol, detail: 'Set by Sid' }] }, 'PUT')).status, 200);

  // Positions show on the roster; Sid's own-team role is unchanged.
  const sidRow = (await plan('/roster?from=2031-03-03&to=2031-03-03')).body.people.find((p) => p.id === 2);
  assert.equal(sidRow.teamRole, 'supervisor');
  assert.deepEqual(sidRow.positions.map((x) => [x.teamId, x.role]).sort(), [
    [1, 'supervisor'],
    [2, 'supervisor'],
  ]);
  const team2 = (await plan('/roster?from=2031-03-03&to=2031-03-03')).body.teams.find((t) => t.id === 2);
  assert.equal(team2.supervisorNames, 'Sid Super');
});

test('postings for several days at once, and short codes for posting types', async () => {
  const tess = await as('tess');
  const plan = await as('plan');
  const types = (await plan('/posting-types')).body.types;
  assert.equal(types.find((t) => t.name === 'Response driver').short, 'DRV');
  const id = (await plan('/posting-types', { name: 'Scene watch', short: 'scw' })).body.id;
  assert.equal((await plan('/posting-types')).body.types.find((t) => t.id === id).short, 'SCW');
  const pat = types.find((t) => t.name === 'Patrol').id;
  const r = await tess('/postings', { changes: [{ personId: 3, date: '2031-03-03', typeId: pat }, { personId: 3, date: '2031-03-04', typeId: pat }] }, 'PUT');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const got = (await tess('/postings?from=2031-03-03&to=2031-03-04&person=3')).body.postings.map((p) => [p.date, p.typeId]);
  assert.deepEqual(got, [
    ['2031-03-03', pat],
    ['2031-03-04', pat],
  ]);
  assert.equal((await tess('/postings', { changes: [{ personId: 3, typeId: pat }] }, 'PUT')).status, 400, 'a date is needed');
});
