import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { hashPassword } from '../server/auth.js';
import { leaveActions } from '../server/leave-rules.js';

let server, base, db;
const pw = hashPassword('password123');
// 2031-03-03 is a Monday.
before(async () => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO teams (id, name, establishment, min_strength) VALUES (1, 'Team 1', 4, 2)").run();
  db.prepare("INSERT INTO people (id, staff_number, name, team_id) VALUES (1, '1', 'Mary Manager', 1)").run();
  db.prepare("INSERT INTO people (id, staff_number, name, team_id, line_manager_id) VALUES (2, '2', 'Sam Staff', 1, 1)").run();
  db.prepare("INSERT INTO people (id, staff_number, name, team_id, line_manager_id) VALUES (3, '3', 'Pat Peer', 1, 1)").run();
  db.prepare("INSERT INTO users (username, password_hash, role, person_id) VALUES ('mary', ?, 'staff', 1)").run(pw);
  db.prepare("INSERT INTO users (username, password_hash, role, person_id) VALUES ('sam', ?, 'staff', 2)").run(pw);
  db.prepare("INSERT INTO users (username, password_hash, role, person_id) VALUES ('pat', ?, 'staff', 3)").run(pw);
  db.prepare("INSERT INTO users (username, password_hash, role, leave_admin) VALUES ('gt', ?, 'staff', 1)").run(pw);
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('admin', ?, 'admin')").run(pw);
  // Roster Mon-Sun: T1 T1 T1 RD RD T1 T1 for Sam and Pat; Mary T1 every day.
  const codes = ['T1', 'T1', 'T1', 'RD', 'RD', 'T1', 'T1'];
  const ins = db.prepare('INSERT INTO assignments (person_id, date, code, note) VALUES (?,?,?,?)');
  codes.forEach((c, i) => {
    const d = `2031-03-0${3 + i}`;
    ins.run(2, d, c, i === 3 ? 'keep me' : null);
    ins.run(3, d, c, null);
    ins.run(1, d, 'T1', null);
  });
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
  return async (path, body) => {
    const r = await fetch(base + '/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, 'X-Requested-With': 'DutyPlanning', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
}
const roster = (pid) => Object.fromEntries(db.prepare('SELECT date, code, note FROM assignments WHERE person_id = ? ORDER BY date').all(pid).map((a) => [a.date, a.note ? `${a.code}:${a.note}` : a.code]));

test('full workflow: request, approve, apply, cancel and restore', async () => {
  const sam = await as('sam');
  const mary = await as('mary');
  const pat = await as('pat');
  const gt = await as('gt');

  // Saturday 8 March is made a public holiday (Sam is rostered T1 that day).
  db.prepare("INSERT INTO public_holidays (date, name) VALUES ('2031-03-08', 'Test holiday')").run();
  const preview = await sam('/leave/preview?start=2031-03-03&end=2031-03-09');
  // Mon-Wed and Sun are working days; the rest days and the public holiday are not counted.
  assert.equal(preview.body.workingDays, 4);
  assert.equal(preview.body.days[5].publicHoliday, 'Test holiday');
  // Team of 3 on duty Mon, min 2: Sam leaving takes it to 2 - fine.
  assert.equal(preview.body.coverWarnings, 0);

  const made = await sam('/leave', { start: '2031-03-03', end: '2031-03-09', type: 'AL', note: 'Holiday' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const id = made.body.request.id;
  assert.equal(made.body.request.days, 4);
  assert.equal(made.body.request.status, 'pending');
  assert.equal(made.body.request.managerName, 'Mary Manager');

  assert.equal((await sam('/leave', { start: '2031-03-05', end: '2031-03-06', type: 'AL' })).status, 409, 'overlap rejected');
  assert.equal((await sam(`/leave/${id}/approve`, {})).status, 403, 'cannot approve own');
  assert.equal((await pat(`/leave/${id}/approve`, {})).status, 403, 'peer cannot approve');
  assert.equal((await pat(`/leave/${id}`)).status, 404, 'peer cannot see');
  assert.equal((await gt(`/leave/${id}/apply`, {})).status, 403, 'cannot apply before approval');

  const queue = await mary('/leave?scope=approve');
  assert.deepEqual(queue.body.requests.map((r) => [r.id, r.actions.approve]), [[id, true]]);
  assert.equal((await mary('/leave/summary')).body.toApprove, 1);
  assert.equal((await mary(`/leave/${id}/approve`, { note: 'Enjoy' })).body.request.status, 'approved');

  assert.equal((await gt('/leave/summary')).body.toApply, 1);
  const applied = await gt(`/leave/${id}/apply`, { code: 'AL' });
  assert.equal(applied.body.request.status, 'applied', JSON.stringify(applied.body));
  assert.deepEqual(roster(2), {
    '2031-03-03': 'AL:Leave request #' + id,
    '2031-03-04': 'AL:Leave request #' + id,
    '2031-03-05': 'AL:Leave request #' + id,
    '2031-03-06': 'RD-AL:Leave request #' + id,
    '2031-03-07': 'RD-AL:Leave request #' + id,
    '2031-03-08': 'PH-AL:Leave request #' + id,
    '2031-03-09': 'AL:Leave request #' + id,
  });
  const labels = Object.fromEntries(db.prepare("SELECT code, label FROM duty_codes WHERE code IN ('RD-AL','PH-AL')").all().map((c) => [c.code, c.label]));
  assert.deepEqual(labels, { 'RD-AL': 'Rest Day - AL', 'PH-AL': 'Public holiday - AL' });
  assert.equal((await sam('/leave/summary')).body.mine, undefined, 'no allowance tracking');

  // A planner changes one leave day before cancellation; that day is left alone on restore.
  db.prepare("UPDATE assignments SET code = 'T2', note = NULL WHERE person_id = 2 AND date = '2031-03-09'").run();
  assert.equal((await sam(`/leave/${id}/requestCancel`, {})).body.request.status, 'cancel_requested');
  assert.equal((await gt(`/leave/${id}/remove`, {})).body.request.status, 'cancelled');
  assert.deepEqual(roster(2), {
    '2031-03-03': 'T1',
    '2031-03-04': 'T1',
    '2031-03-05': 'T1',
    '2031-03-06': 'RD:keep me',
    '2031-03-07': 'RD',
    '2031-03-08': 'T1',
    '2031-03-09': 'T2',
  });
  const detail = await sam(`/leave/${id}`);
  assert.deepEqual(detail.body.events.map((e) => e.action), ['requested', 'approve', 'apply', 'requestCancel', 'remove']);
});

test('rejecting needs a reason; cover warnings; people without a manager go to admins', async () => {
  const pat = await as('pat');
  const mary = await as('mary');
  const admin = await as('admin');
  // Pat off Mon-Wed while Sam is also off would leave Mary alone (min 2) -> warn when Sam is on leave too.
  db.prepare("UPDATE assignments SET code = 'AL' WHERE person_id = 2 AND date = '2031-03-03'").run();
  const prev = await pat('/leave/preview?start=2031-03-03&end=2031-03-03');
  assert.equal(prev.body.coverWarnings, 1);
  const r = (await pat('/leave', { start: '2031-03-03', end: '2031-03-03' })).body.request;
  assert.equal((await mary(`/leave/${r.id}/reject`, {})).status, 400);
  assert.equal((await mary(`/leave/${r.id}/reject`, { note: 'Team too short that day' })).body.request.status, 'rejected');

  const m = (await mary('/leave', { start: '2031-04-01', end: '2031-04-02' })).body.request;
  assert.equal(m.managerName, null);
  assert.equal((await admin('/leave/summary')).body.toApprove, 1);
  assert.equal((await admin(`/leave/${m.id}/approve`, {})).body.request.status, 'approved');
  assert.equal((await mary(`/leave/${m.id}/cancel`, {})).body.request.status, 'cancelled');
});

test('leave rules helpers', () => {
  const a = leaveActions({ personId: 5, managerPersonId: null, status: 'pending' }, { personId: 9, role: 'staff', leaveAdmin: true });
  assert.equal(a.approve, true);
  assert.equal(leaveActions({ personId: 5, managerPersonId: 7, status: 'pending' }, { personId: 9, role: 'staff', leaveAdmin: true }).approve, false);
});

test('UK bank holidays: calculation and adding them for a year', async () => {
  const { ukBankHolidays } = await import('../server/holidays.js');
  assert.deepEqual(
    ukBankHolidays(2027).map((h) => h.date),
    ['2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28'],
  );
  assert.deepEqual(ukBankHolidays(2022).slice(-2).map((h) => [h.date, h.name]), [
    ['2022-12-26', 'Boxing Day'],
    ['2022-12-27', 'Christmas Day (substitute day)'],
  ]);
  assert.ok(ukBankHolidays(2027, 'scotland').some((h) => h.name.startsWith('St Andrew')));
  const admin = await as('admin');
  const sam = await as('sam');
  assert.equal((await sam('/public-holidays/generate', { year: 2027 })).status, 403);
  assert.equal((await admin('/public-holidays/generate', { year: 2027 })).body.added, 8);
  assert.equal((await admin('/public-holidays/generate', { year: 2027 })).body.added, 0, 'no duplicates');
  const list = (await sam('/public-holidays?from=2027-01-01&to=2027-12-31')).body.holidays;
  assert.equal(list.length, 8);
});
