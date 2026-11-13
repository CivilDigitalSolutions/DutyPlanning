// Sample data for the standalone demo build (mirrors scripts/seed-demo.js).
import { addDays, eachDate } from '../server/dates.js';
import { DEFAULT_DUTY_CODES } from '../server/duty-codes.js';
import { ukBankHolidays } from '../server/holidays.js';

const FIRST = ['Alex', 'Sam', 'Jordan', 'Chris', 'Taylor', 'Morgan', 'Jamie', 'Robin', 'Casey', 'Drew', 'Avery', 'Riley', 'Quinn', 'Charlie', 'Frankie', 'Harper', 'Jesse', 'Kai', 'Lee', 'Max'];
const LAST = ['Smith', 'Jones', 'Patel', 'Brown', 'Taylor', 'Wilson', 'Evans', 'Khan', 'Walker', 'Wright', 'Hughes', 'Green', 'Hall', 'Wood', 'Clarke', 'Ahmed', 'Turner', 'Hill', 'Moore', 'Cooper'];

export function seedDemo(today) {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const from = addDays(today, -28);
  const to = addDays(today, 180);
  let id = 0;
  const nextId = () => ++id;
  const db = {
    orgName: 'Duty Planning (demo)',
    teams: [],
    people: [],
    accs: [],
    pacc: {},
    codes: DEFAULT_DUTY_CODES.map((c, i) => ({ ...c, private: !!c.private, sortOrder: i })),
    asg: {},
    users: [],
    audit: [],
    session: null,
  };
  db.accs = [
    ['FA', 'First Aid'],
    ['DRV', 'Response Driver'],
    ['SUP', 'Supervisor'],
    ['INS', 'Instructor'],
  ].map(([code, name], i) => ({ id: nextId(), code, name, sortOrder: i }));

  const teams = [
    ['Team 1', 'T1', 10, 8, 6],
    ['Team 2', 'T2', 10, 9, 6],
    ['Team 3', 'T3', 10, 7, 6],
    ['Team 4', 'T4', 10, 10, 6],
  ];
  let staffNo = 1001;
  teams.forEach(([name, code, establishment, filled, min], ti) => {
    const teamId = nextId();
    db.teams.push({ id: teamId, name, sortOrder: ti, establishment, minStrength: min, color: null });
    for (let i = 0; i < filled; i++) {
      const first = FIRST[(ti * 7 + i * 3) % FIRST.length];
      const last = LAST[(ti * 5 + i * 7) % LAST.length];
      const pid = nextId();
      db.people.push({
        id: pid,
        staffNumber: String(staffNo++),
        name: `${first} ${last}`,
        initials: `${first[0]}${last[0]}`,
        mobile: `07700 9${String(10000 + ti * 100 + i).slice(1)}`,
        teamId,
        sortOrder: i,
        active: true,
      });
      db.accs.forEach((a, ai) => {
        if (rnd() < [0.8, 0.5, i === 0 ? 1 : 0.1, 0.15][ai]) {
          const e = ai === 0 ? addDays(today, Math.floor(rnd() * 500) - 60) : null;
          (db.pacc[pid] ??= {})[a.id] = e ? { v: 'Y', e } : { v: 'Y' };
        }
      });
      // 4 on / 4 off rota, offset per team so two teams are always on.
      const leaveStart = Math.floor(rnd() * 150);
      const courseStart = Math.floor(rnd() * 170);
      eachDate(from, to).forEach((d, di) => {
        const cycle = (di + ti * 2) % 8;
        let c = cycle < 4 ? code : 'RD';
        if (di >= leaveStart && di < leaveStart + 7 && rnd() < 0.35) c = 'AL';
        if (cycle < 4 && di >= courseStart && di < courseStart + 3 && i % 3 === 0) c = ti % 2 ? 'TC2' : 'TC1';
        if (cycle < 4 && rnd() < 0.01) c = 'SICK';
        db.asg[`${pid}|${d}`] = { c };
      });
    }
  });
  const pidOf = (sn) => db.people.find((p) => p.staffNumber === sn).id;
  // Line managers: the first person in each team manages the rest; team leads have none (admins approve).
  for (const t of db.teams) {
    const members = db.people.filter((p) => p.teamId === t.id).sort((a, b) => a.sortOrder - b.sortOrder);
    for (const m of members.slice(1)) m.lineManagerId = members[0].id;
  }
  db.users = [
    { id: nextId(), username: 'admin', password: 'admin1234', role: 'admin', personId: null, mustChangePassword: false, supervisor: true },
    { id: nextId(), username: 'planner', password: 'planner1234', role: 'planner', personId: pidOf('1002'), mustChangePassword: false, leaveAdmin: true },
    { id: nextId(), username: '1001', password: 'staff1234', role: 'staff', personId: pidOf('1001'), mustChangePassword: false },
  ];
  const yr = Number(today.slice(0, 4));
  db.holidays = Object.fromEntries([...ukBankHolidays(yr), ...ukBankHolidays(yr + 1)].map((h) => [h.date, h.name]));
  for (const p of db.people) {
    p.jobTitle = p.sortOrder === 0 ? 'Sergeant' : 'Constable';
    p.startDate = `${2008 + (p.id % 15)}-${String(1 + (p.id % 12)).padStart(2, '0')}-01`;
  }
  db.formSettings = { unit: 'Response Branch' };
  // Sample leave requests at each stage.
  db.leave = [];
  db.leaveEvents = [];
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const leave = (sn, offset, len, status, note, receivedDaysAgo = 3, receivedHour = 9) => {
    const pid = pidOf(sn);
    const start = addDays(today, offset);
    const end = addDays(start, len - 1);
    const days = eachDate(start, end).filter((d) => db.asg[`${pid}|${d}`] && db.asg[`${pid}|${d}`].c !== 'RD').length;
    const rid = nextId();
    const received = `${addDays(today, -receivedDaysAgo)} ${String(receivedHour).padStart(2, '0')}:${String((pid * 7) % 60).padStart(2, '0')}:00`;
    const decided = status === 'pending' ? null : `${addDays(today, -Math.max(0, receivedDaysAgo - 1))} 14:00:00`;
    const person = db.people.find((p) => p.id === pid);
    const manager = db.people.find((p) => p.id === person.lineManagerId);
    const form = {
      applicant: {
        unit: 'Response Branch',
        address: `${10 + (pid % 80)} Example Road, Sampletown`,
        phone: person.mobile,
        joinDate: person.startDate,
        noCourtCases: pid % 4 !== 0,
        crownCourtCases: pid % 4 === 0 ? 1 : null,
        availableForCourt: false,
        trainingCourses: 0,
        signedBy: person.name,
        signedAt: received.replace(' ', 'T') + 'Z',
      },
      ...(status === 'approved' ? { approval: { name: manager?.name || 'Admin', rank: manager?.jobTitle || '', at: decided.replace(' ', 'T') + 'Z', note: null } } : {}),
    };
    db.leave.push({ id: rid, personId: pid, type: 'AL', start, end, days, note, status, form, createdAt: received, decidedAt: decided, decidedBy: status === 'pending' ? null : 'Team leader', decisionNote: status === 'rejected' ? 'Team is already short that week' : null });
    db.leaveEvents.push({ id: nextId(), requestId: rid, at: received, username: db.people.find((p) => p.id === pid).name, action: 'requested', note });
    if (status !== 'pending') db.leaveEvents.push({ id: nextId(), requestId: rid, at: decided, username: 'Team leader', action: status === 'rejected' ? 'reject' : 'approve', note: null });
  };
  db.lockdowns = [{ id: nextId(), name: 'Winter operation', start: addDays(today, 26), end: addDays(today, 40), teamId: null, note: 'Maximum staffing needed for the winter operation' }];
  leave('1003', 21, 7, 'pending', 'Family holiday', 5, 8);
  leave('1005', 35, 4, 'pending', null, 3, 11);
  leave('1001', 49, 5, 'pending', 'Long weekend away', 1, 16);
  leave('1010', 14, 7, 'approved', 'Booked flights', 14, 10);
  leave('1019', 28, 3, 'approved', null, 11, 9);
  leave('1006', 10, 2, 'rejected', 'Wedding', 9, 15);
  // A queue of requests for the Winter operation lockdown, received on different days.
  leave('1004', 27, 3, 'approved', 'Christmas shopping', 9, 8);
  leave('1007', 30, 2, 'approved', null, 6, 13);
  leave('1012', 29, 4, 'approved', 'Family visiting', 12, 9);
  leave('1013', 33, 3, 'pending', null, 2, 10);
  leave('1020', 26, 5, 'approved', "Children's nativity play", 4, 17);
  leave('1026', 31, 2, 'pending', 'Wedding anniversary', 1, 9);
  leave('1015', 36, 3, 'approved', null, 8, 12);
  leave('1029', 37, 2, 'approved', 'Hospital appointment', 2, 8);
  db.seq = id;
  return db;
}
