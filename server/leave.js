// Annual leave requests: request -> line manager approval -> leave administrator applies to roster.
import { tx, audit } from './db.js';
import { daysBetween, eachDate, isValidIso } from './dates.js';
import { ACTION_RESULT, ACTIVE_STATUSES, STATUSES, datesToApply, leaveActions, leaveBreakdown, leaveYear, validateRequestDates } from './leave-rules.js';

export function registerLeaveRoutes(app, { db, staff, json, wrap, HttpError, broadcast, cfg }) {
  const bad = (m) => new HttpError(400, m);
  const s = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));
  const today = () => new Date().toISOString().slice(0, 10);
  const viewerOf = (u) => ({ personId: u.personId, role: u.role, leaveAdmin: u.leaveAdmin });
  const administers = (u) => u.role === 'admin' || u.leaveAdmin;

  const codeInfo = () => new Map(db.prepare('SELECT code, label, category, private FROM duty_codes').all().map((c) => [c.code.toLowerCase(), c]));
  const leaveTypes = () =>
    db.prepare("SELECT code, label FROM duty_codes WHERE category = 'leave' AND private = 0 ORDER BY sort_order, code").all();

  const SELECT = `
    SELECT r.id, r.person_id AS personId, p.name AS personName, p.staff_number AS staffNumber, p.team_id AS teamId, t.name AS teamName,
           p.line_manager_id AS managerPersonId, m.name AS managerName,
           r.type_code AS type, dc.label AS typeLabel, r.start_date AS start, r.end_date AS end, r.days, r.note, r.status,
           r.created_at AS createdAt, r.decided_at AS decidedAt, r.decision_note AS decisionNote, COALESCE(dp.name, du.username) AS decidedBy,
           r.applied_at AS appliedAt, COALESCE(ap.name, au.username) AS appliedBy, r.applied_code AS appliedCode
    FROM leave_requests r
    JOIN people p ON p.id = r.person_id
    LEFT JOIN teams t ON t.id = p.team_id
    LEFT JOIN people m ON m.id = p.line_manager_id
    LEFT JOIN duty_codes dc ON dc.code = r.type_code
    LEFT JOIN users du ON du.id = r.decided_by
    LEFT JOIN people dp ON dp.id = du.person_id
    LEFT JOIN users au ON au.id = r.applied_by
    LEFT JOIN people ap ON ap.id = au.person_id`;
  const withActions = (u) => (r) => ({ ...r, actions: leaveActions(r, viewerOf(u)) });
  const getRequest = (id) => db.prepare(`${SELECT} WHERE r.id = ?`).get(Number(id));

  function breakdownFor(personId, start, end) {
    const person = db.prepare('SELECT id, team_id FROM people WHERE id = ?').get(personId);
    const team = person?.team_id ? db.prepare('SELECT min_strength FROM teams WHERE id = ?').get(person.team_id) : null;
    const info = codeInfo();
    const own = new Map(db.prepare('SELECT date, code FROM assignments WHERE person_id = ? AND date BETWEEN ? AND ?').all(personId, start, end).map((a) => [a.date, a.code]));
    const counts = new Map();
    if (person?.team_id)
      for (const r of db
        .prepare(
          `SELECT a.date, COUNT(*) AS n FROM assignments a JOIN people p ON p.id = a.person_id JOIN duty_codes dc ON dc.code = a.code
           WHERE p.team_id = ? AND p.active = 1 AND dc.category = 'duty' AND a.date BETWEEN ? AND ? GROUP BY a.date`,
        )
        .all(person.team_id, start, end))
        counts.set(r.date, r.n);
    return leaveBreakdown({
      dates: eachDate(start, end),
      codeAt: (d) => own.get(d),
      info: (c) => info.get(c.toLowerCase()),
      teamOnDuty: person?.team_id ? (d) => counts.get(d) || 0 : null,
      minStrength: team?.min_strength ?? null,
    });
  }

  const overlapping = (personId, start, end, exceptId = 0) =>
    db
      .prepare(
        `SELECT id, start_date AS start, end_date AS end, status FROM leave_requests
         WHERE person_id = ? AND id <> ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) AND start_date <= ? AND end_date >= ?`,
      )
      .all(personId, exceptId, ...ACTIVE_STATUSES, end, start);

  function event(id, user, action, note) {
    db.prepare('INSERT INTO leave_events (request_id, user_id, username, action, note) VALUES (?,?,?,?,?)').run(id, user.id, user.username, action, note || null);
  }

  // Who the request is for: yourself, or (planners/admins/leave administrators) anyone.
  function targetPerson(u, personId) {
    const id = personId ? Number(personId) : u.personId;
    if (!id) throw bad('Your account is not linked to anyone on the plan - ask an administrator to link it');
    if (id !== u.personId && !(u.role === 'planner' || administers(u))) throw new HttpError(403, 'You can only request leave for yourself');
    if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(id)) throw bad('Person not found');
    return id;
  }

  function summary(u, date) {
    // Leave year containing `date` (default today), so next year's bookings can be checked too.
    const year = leaveYear(isValidIso(date) ? date : today(), cfg.leaveYearStart);
    let mine = null;
    if (u.personId) {
      const p = db.prepare('SELECT leave_allowance AS allowance FROM people WHERE id = ?').get(u.personId);
      const rows = db
        .prepare(`SELECT status, days FROM leave_requests WHERE person_id = ? AND start_date BETWEEN ? AND ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`)
        .all(u.personId, year.from, year.to, ...ACTIVE_STATUSES);
      const sum = (f) => rows.filter(f).reduce((n, r) => n + r.days, 0);
      mine = {
        allowance: p?.allowance ?? null,
        booked: sum((r) => r.status === 'applied' || r.status === 'cancel_requested' || r.status === 'approved'),
        pending: sum((r) => r.status === 'pending'),
      };
    }
    const toApprove = db
      .prepare(
        `SELECT COUNT(*) AS n FROM leave_requests r JOIN people p ON p.id = r.person_id
         WHERE r.status = 'pending' AND r.person_id IS NOT ? AND (p.line_manager_id = ?${administers(u) ? ' OR p.line_manager_id IS NULL' : ''})`,
      )
      .get(u.personId ?? -1, u.personId ?? -1).n;
    const toApply = administers(u) ? db.prepare("SELECT COUNT(*) AS n FROM leave_requests WHERE status IN ('approved','cancel_requested')").get().n : 0;
    const isManager = !!(u.personId && db.prepare('SELECT 1 FROM people WHERE line_manager_id = ? LIMIT 1').get(u.personId));
    return { year, mine, toApprove, toApply, isManager, administers: administers(u), leaveTypes: leaveTypes() };
  }

  app.get('/api/leave/summary', staff, (req, res) => res.json(summary(req.user, req.query.date)));

  // List requests. scope: mine | approve (my reports + stand-in approvals) | apply | all
  app.get('/api/leave', staff, (req, res) => {
    const u = req.user;
    const scope = String(req.query.scope || 'mine');
    const status = STATUSES.includes(req.query.status) ? req.query.status : null;
    let where;
    let args = [];
    if (scope === 'mine') {
      where = 'r.person_id = ?';
      args = [u.personId ?? -1];
    } else if (scope === 'approve') {
      // Direct reports; admins and leave administrators also see requests from people with no manager.
      where = '(p.line_manager_id = ?' + (administers(u) ? ' OR p.line_manager_id IS NULL' : '') + ') AND r.person_id IS NOT ?';
      args = [u.personId ?? -1, u.personId ?? -1];
    } else if (scope === 'apply') {
      if (!administers(u)) throw new HttpError(403, 'Only leave administrators can do this');
      where = "r.status IN ('approved','cancel_requested','applied')";
    } else if (scope === 'all') {
      if (!(u.role === 'planner' || administers(u))) throw new HttpError(403, 'Not permitted');
      where = '1=1';
    } else throw bad('Unknown scope');
    if (status) {
      where += ' AND r.status = ?';
      args.push(status);
    }
    const from = isValidIso(req.query.from) ? req.query.from : null;
    if (from) {
      where += ' AND r.end_date >= ?';
      args.push(from);
    }
    const rows = db.prepare(`${SELECT} WHERE ${where} ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'cancel_requested' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END, r.start_date DESC LIMIT 500`).all(...args);
    res.json({ requests: rows.map(withActions(u)) });
  });

  // Preview a request before it is made: working days, clashes and team cover.
  app.get('/api/leave/preview', staff, (req, res) => {
    const u = req.user;
    const personId = targetPerson(u, req.query.personId);
    const err = validateRequestDates(req.query.start, req.query.end, isValidIso, daysBetween);
    if (err) throw bad(err);
    const b = breakdownFor(personId, req.query.start, req.query.end);
    res.json({ ...b, overlaps: overlapping(personId, req.query.start, req.query.end) });
  });

  app.post(
    '/api/leave',
    staff,
    json,
    wrap((req, res) => {
      const u = req.user;
      const b = req.body || {};
      const personId = targetPerson(u, b.personId);
      const err = validateRequestDates(b.start, b.end, isValidIso, daysBetween);
      if (err) throw bad(err);
      const types = leaveTypes();
      const type = types.find((t) => t.code.toLowerCase() === String(b.type || 'AL').toLowerCase());
      if (!type) throw bad(`Leave type must be one of: ${types.map((t) => t.code).join(', ')}`);
      const clash = overlapping(personId, b.start, b.end);
      if (clash.length) throw new HttpError(409, `This overlaps another request (${clash[0].start} to ${clash[0].end})`);
      const { workingDays } = breakdownFor(personId, b.start, b.end);
      const id = tx(db, () => {
        const id = Number(
          db
            .prepare('INSERT INTO leave_requests (person_id, type_code, start_date, end_date, days, note, created_by) VALUES (?,?,?,?,?,?,?)')
            .run(personId, type.code, b.start, b.end, workingDays, s(b.note, 500) || null, u.id).lastInsertRowid,
        );
        event(id, u, 'requested', s(b.note, 500));
        audit(db, u, 'leave.request', { id, personId, start: b.start, end: b.end, days: workingDays });
        return id;
      });
      broadcast({ type: 'leave' });
      res.json({ request: withActions(u)(getRequest(id)) });
    }),
  );

  app.get('/api/leave/:id', staff, (req, res) => {
    const u = req.user;
    const r = getRequest(req.params.id);
    if (!r) throw new HttpError(404, 'Request not found');
    const canSee = r.personId === u.personId || r.managerPersonId === u.personId || u.role === 'planner' || administers(u);
    if (!canSee) throw new HttpError(404, 'Request not found');
    const events = db
      .prepare(
        `SELECT e.at, COALESCE(p.name, e.username) AS username, e.action, e.note FROM leave_events e
         LEFT JOIN users u ON u.id = e.user_id LEFT JOIN people p ON p.id = u.person_id WHERE e.request_id = ? ORDER BY e.id`,
      )
      .all(r.id);
    res.json({ request: withActions(u)(r), ...breakdownFor(r.personId, r.start, r.end), events });
  });

  app.post(
    '/api/leave/:id/:action',
    staff,
    json,
    wrap((req, res) => {
      const u = req.user;
      const action = req.params.action;
      if (!(action in ACTION_RESULT)) throw new HttpError(404, 'Unknown action');
      const r = getRequest(req.params.id);
      if (!r) throw new HttpError(404, 'Request not found');
      if (!leaveActions(r, viewerOf(u))[action]) throw new HttpError(403, 'You cannot do that to this request now');
      const note = s(req.body?.note, 500) || null;
      if ((action === 'reject' || action === 'decline') && !note) throw bad('Give a reason so the person knows why');
      const next = ACTION_RESULT[action];
      let rosterChanged = false;
      tx(db, () => {
        if (action === 'approve' || action === 'reject' || action === 'decline') {
          db.prepare("UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ? WHERE id = ?").run(next, u.id, note, r.id);
        } else if (action === 'apply') {
          const code = db.prepare("SELECT code FROM duty_codes WHERE code = ? AND category = 'leave'").get(String(req.body?.code || r.type))?.code;
          if (!code) throw bad('Choose a leave code to put on the roster');
          const { days } = breakdownFor(r.personId, r.start, r.end);
          const dates = datesToApply(days, { includeRestDays: !!req.body?.includeRestDays });
          const prev = db.prepare('SELECT code, note FROM assignments WHERE person_id = ? AND date = ?');
          const snapshot = dates.map((d) => {
            const p = prev.get(r.personId, d);
            return [d, p?.code ?? null, p?.note ?? null];
          });
          const up = db.prepare(
            `INSERT INTO assignments (person_id, date, code, note, updated_at, updated_by) VALUES (?,?,?,?,datetime('now'),?)
             ON CONFLICT(person_id, date) DO UPDATE SET code = excluded.code, note = excluded.note, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
          );
          for (const d of dates) up.run(r.personId, d, code, `Leave request #${r.id}`, u.id);
          db.prepare("UPDATE leave_requests SET status = 'applied', applied_by = ?, applied_at = datetime('now'), applied_code = ?, applied_snapshot = ? WHERE id = ?").run(
            u.id,
            code,
            JSON.stringify(snapshot),
            r.id,
          );
          rosterChanged = dates.length > 0;
        } else if (action === 'remove') {
          const row = db.prepare('SELECT applied_code, applied_snapshot FROM leave_requests WHERE id = ?').get(r.id);
          const snapshot = JSON.parse(row.applied_snapshot || '[]');
          const cur = db.prepare('SELECT code FROM assignments WHERE person_id = ? AND date = ?');
          const del = db.prepare('DELETE FROM assignments WHERE person_id = ? AND date = ?');
          const put = db.prepare("UPDATE assignments SET code = ?, note = ?, updated_at = datetime('now'), updated_by = ? WHERE person_id = ? AND date = ?");
          for (const [d, code, prevNote] of snapshot) {
            // Only restore days that still show this leave (a planner may have changed them since).
            if (cur.get(r.personId, d)?.code !== row.applied_code) continue;
            if (code) put.run(code, prevNote, u.id, r.personId, d);
            else del.run(r.personId, d);
            rosterChanged = true;
          }
          db.prepare("UPDATE leave_requests SET status = 'cancelled' WHERE id = ?").run(r.id);
        } else {
          db.prepare('UPDATE leave_requests SET status = ? WHERE id = ?').run(next, r.id);
        }
        event(r.id, u, action, note);
        audit(db, u, `leave.${action}`, { id: r.id, personId: r.personId, start: r.start, end: r.end });
      });
      if (rosterChanged) broadcast({ type: 'roster', from: r.start, to: r.end });
      broadcast({ type: 'leave' });
      res.json({ request: withActions(u)(getRequest(r.id)) });
    }),
  );
}
