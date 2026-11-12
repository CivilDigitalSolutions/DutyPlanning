// Populates the database with demo data so the app can be explored.
// Usage: npm run seed:demo [-- --xlsx samples/demo-plan.xlsx]
// Demo logins: admin / admin1234, planner / planner1234, staff number 1001 / staff1234
import fs from 'node:fs';
import path from 'node:path';
import { openDb, tx } from '../server/db.js';
import { hashPassword } from '../server/auth.js';
import { addDays, eachDate } from '../server/dates.js';
import { exportWorkbook } from '../server/spreadsheet.js';
import { ukBankHolidays } from '../server/holidays.js';

const db = openDb(process.env.DB_FILE || './data/dutyplanning.db');
const FIRST = ['Alex', 'Sam', 'Jordan', 'Chris', 'Taylor', 'Morgan', 'Jamie', 'Robin', 'Casey', 'Drew', 'Avery', 'Riley', 'Quinn', 'Charlie', 'Frankie', 'Harper', 'Jesse', 'Kai', 'Lee', 'Max'];
const LAST = ['Smith', 'Jones', 'Patel', 'Brown', 'Taylor', 'Wilson', 'Evans', 'Khan', 'Walker', 'Wright', 'Hughes', 'Green', 'Hall', 'Wood', 'Clarke', 'Ahmed', 'Turner', 'Hill', 'Moore', 'Cooper'];

let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

const today = new Date().toISOString().slice(0, 10);
const from = addDays(today, -14);
const to = addDays(today, 120);

tx(db, () => {
  db.exec('DELETE FROM leave_events; DELETE FROM leave_requests; DELETE FROM assignments; DELETE FROM person_accreditations; DELETE FROM people; DELETE FROM teams; DELETE FROM accreditations;');
  const accs = [
    ['FA', 'First Aid'],
    ['DRV', 'Response Driver'],
    ['SUP', 'Supervisor'],
    ['INS', 'Instructor'],
  ].map(([code, name], i) => Number(db.prepare('INSERT INTO accreditations (code,name,sort_order) VALUES (?,?,?)').run(code, name, i).lastInsertRowid));

  const teams = [
    ['Team 1', 'T1', 10, 8],
    ['Team 2', 'T2', 10, 9],
    ['Team 3', 'T3', 10, 7],
    ['Team 4', 'T4', 10, 10],
  ];
  let staffNo = 1001;
  const insPerson = db.prepare('INSERT INTO people (staff_number,name,initials,mobile,team_id,sort_order) VALUES (?,?,?,?,?,?)');
  const insAcc = db.prepare('INSERT INTO person_accreditations (person_id,accreditation_id,value,expires) VALUES (?,?,?,?)');
  const insAsg = db.prepare('INSERT INTO assignments (person_id,date,code) VALUES (?,?,?)');
  teams.forEach(([name, code, establishment, filled], ti) => {
    const teamId = Number(db.prepare('INSERT INTO teams (name,sort_order,establishment) VALUES (?,?,?)').run(name, ti, establishment).lastInsertRowid);
    for (let i = 0; i < filled; i++) {
      const first = FIRST[(ti * 7 + i * 3) % FIRST.length];
      const last = LAST[(ti * 5 + i * 7) % LAST.length];
      const pid = Number(
        insPerson.run(String(staffNo++), `${first} ${last}`, `${first[0]}${last[0]}`, `07700 9${String(10000 + ti * 100 + i).slice(1)}`, teamId, i).lastInsertRowid,
      );
      accs.forEach((aid, ai) => {
        if (rnd() < [0.8, 0.5, i === 0 ? 1 : 0.1, 0.15][ai]) {
          const expires = ai === 0 ? addDays(today, Math.floor(rnd() * 500) - 60) : null;
          insAcc.run(pid, aid, expires ? 'Y' : 'Y', expires);
        }
      });
      // 4 on / 4 off rota, offset per team so two teams are always on.
      const leaveStart = Math.floor(rnd() * 100);
      const courseStart = Math.floor(rnd() * 110);
      eachDate(from, to).forEach((d, di) => {
        const cycle = (di + ti * 2) % 8;
        let c = cycle < 4 ? code : 'RD';
        if (di >= leaveStart && di < leaveStart + 7 && rnd() < 0.35) c = 'AL';
        if (cycle < 4 && di >= courseStart && di < courseStart + 3 && i % 3 === 0) c = ti % 2 ? 'TC2' : 'TC1';
        if (cycle < 4 && rnd() < 0.01) c = 'SICK';
        insAsg.run(pid, d, c);
      });
    }
  });

  // England and Wales bank holidays for this year and next.
  db.exec('DELETE FROM public_holidays');
  const y = Number(today.slice(0, 4));
  for (const h of [...ukBankHolidays(y), ...ukBankHolidays(y + 1)]) db.prepare('INSERT OR IGNORE INTO public_holidays (date, name) VALUES (?,?)').run(h.date, h.name);

  // Line managers: the first person in each team manages the rest; team leads report to no one (admins approve).
  for (const t of db.prepare('SELECT id FROM teams').all()) {
    const members = db.prepare('SELECT id FROM people WHERE team_id = ? ORDER BY sort_order').all(t.id);
    const lead = members[0]?.id;
    for (const m of members.slice(1)) db.prepare('UPDATE people SET line_manager_id = ? WHERE id = ?').run(lead, m.id);
  }

  // Sample leave requests at each stage of the workflow.
  const pid = (sn) => db.prepare('SELECT id FROM people WHERE staff_number = ?').get(sn).id;
  const workDays = (p, a, b) => db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE person_id = ? AND date BETWEEN ? AND ? AND code <> 'RD'").get(p, a, b).n;
  const leave = (sn, startOffset, len, status, note) => {
    const p = pid(sn);
    const a = addDays(today, startOffset);
    const b = addDays(a, len - 1);
    const id = Number(
      db
        .prepare("INSERT INTO leave_requests (person_id, type_code, start_date, end_date, days, note, status, decided_at, decision_note) VALUES (?, 'AL', ?, ?, ?, ?, ?, ?, ?)")
        .run(p, a, b, workDays(p, a, b), note, status, status === 'pending' ? null : new Date().toISOString(), status === 'rejected' ? 'Team is already short that week' : null).lastInsertRowid,
    );
    db.prepare("INSERT INTO leave_events (request_id, username, action, note) VALUES (?, ?, 'requested', ?)").run(id, sn, note);
    if (status !== 'pending') db.prepare('INSERT INTO leave_events (request_id, username, action, note) VALUES (?, ?, ?, ?)').run(id, 'manager', status === 'rejected' ? 'reject' : 'approve', null);
  };
  leave('1003', 21, 7, 'pending', 'Family holiday');
  leave('1005', 35, 4, 'pending', null);
  leave('1001', 49, 5, 'pending', 'Long weekend away');
  leave('1010', 14, 7, 'approved', 'Booked flights');
  leave('1019', 28, 3, 'approved', null);
  leave('1006', 10, 2, 'rejected', 'Wedding');

  const user = (username, password, role, personId = null) =>
    db
      .prepare(
        `INSERT INTO users (username,password_hash,role,person_id) VALUES (?,?,?,?)
         ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash, role=excluded.role, person_id=excluded.person_id, must_change_password=0`,
      )
      .run(username, hashPassword(password), role, personId);
  user('admin', 'admin1234', 'admin');
  user('planner', 'planner1234', 'planner', db.prepare("SELECT id FROM people WHERE staff_number='1002'").get().id);
  db.prepare("UPDATE users SET leave_admin = 1 WHERE username = 'planner'").run();
  user('1001', 'staff1234', 'staff', db.prepare("SELECT id FROM people WHERE staff_number='1001'").get().id);
});

console.log(`Demo data loaded for ${from} to ${to}.`);
console.log('Logins: admin/admin1234 (admin), planner/planner1234 (planner + leave administrator), 1001/staff1234 (staff, manages Team 1)');

const xi = process.argv.indexOf('--xlsx');
if (xi > 0) {
  const out = process.argv[xi + 1];
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(await exportWorkbook(db, { from, to })));
  console.log(`Wrote ${out}`);
}
