// Daily postings: a finer layer on top of the duty plan saying what each person on duty is
// doing that day (appointments, driving, paperwork...). Changing a posting never changes the plan.
import { tx, audit } from './db.js';
import { daysBetween, isValidIso } from './dates.js';
import { canEditPostings, canViewPostings, normalisePosting } from './postings-rules.js';

const HEX = /^#[0-9a-f]{6}$/i;

export function registerPostingRoutes(app, { db, staff, planner, json, wrap, HttpError, broadcast }) {
  const bad = (m) => new HttpError(400, m);
  const viewerOf = (u) => {
    const p = u.personId ? db.prepare('SELECT team_id FROM people WHERE id = ?').get(u.personId) : null;
    const positions = u.personId ? db.prepare('SELECT team_id AS teamId, role FROM team_positions WHERE person_id = ?').all(u.personId) : [];
    return { role: u.role, teamId: p?.team_id ?? null, positions };
  };
  const editableTeams = (u) => {
    const v = viewerOf(u);
    return db.prepare('SELECT id FROM teams').all().map((t) => t.id).filter((id) => canEditPostings(v, id));
  };
  // Postings are private to each team: you see your own team's, plus any team you lead or supervise.
  const visibleTeams = (u) => {
    const v = viewerOf(u);
    return db.prepare('SELECT id FROM teams').all().map((t) => t.id).filter((id) => canViewPostings(v, id));
  };
  const listTypes = () =>
    db.prepare('SELECT id, name, color, sort_order AS sortOrder, active FROM posting_types ORDER BY active DESC, sort_order, name').all().map((t) => ({ ...t, active: !!t.active }));

  // ---- posting types ----
  app.get('/api/posting-types', staff, (req, res) => res.json({ types: listTypes() }));
  const typeBody = (b) => {
    const name = String(b?.name ?? '').trim().slice(0, 60);
    if (!name) throw bad('Give the posting type a name');
    const color = String(b.color || '#d0d7de');
    if (!HEX.test(color)) throw bad('Colour must be #rrggbb');
    const sortOrder = Number.isInteger(Number(b.sortOrder)) ? Number(b.sortOrder) : 0;
    return [name, color, sortOrder, b.active === false ? 0 : 1];
  };
  const unique = (fn) => {
    try {
      return fn();
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'A posting type with that name already exists');
      throw e;
    }
  };
  app.post(
    '/api/posting-types',
    planner,
    json,
    wrap((req, res) => {
      const id = unique(() => Number(db.prepare('INSERT INTO posting_types (name, color, sort_order, active) VALUES (?,?,?,?)').run(...typeBody(req.body)).lastInsertRowid));
      audit(db, req.user, 'postingType.create', { id, name: req.body.name });
      broadcast({ type: 'postings' });
      res.json({ id });
    }),
  );
  app.put(
    '/api/posting-types/:id',
    planner,
    json,
    wrap((req, res) => {
      const r = unique(() => db.prepare('UPDATE posting_types SET name=?, color=?, sort_order=?, active=? WHERE id=?').run(...typeBody(req.body), Number(req.params.id)));
      if (!r.changes) throw new HttpError(404, 'Posting type not found');
      audit(db, req.user, 'postingType.update', { id: Number(req.params.id), name: req.body.name });
      broadcast({ type: 'postings' });
      res.json({ ok: true });
    }),
  );
  app.delete(
    '/api/posting-types/:id',
    planner,
    wrap((req, res) => {
      const id = Number(req.params.id);
      const used = db.prepare('SELECT COUNT(*) AS n FROM postings WHERE type_id = ?').get(id).n;
      // Types already used are hidden rather than deleted, so past postings keep their name.
      const r = used ? db.prepare('UPDATE posting_types SET active = 0 WHERE id = ?').run(id) : db.prepare('DELETE FROM posting_types WHERE id = ?').run(id);
      if (!r.changes) throw new HttpError(404, 'Posting type not found');
      audit(db, req.user, used ? 'postingType.hide' : 'postingType.delete', { id });
      broadcast({ type: 'postings' });
      res.json({ ok: true, hidden: !!used });
    }),
  );

  // ---- postings ----
  // GET ?date=  or ?from=&to= (optionally &person=)
  app.get('/api/postings', staff, (req, res) => {
    const from = req.query.date || req.query.from;
    const to = req.query.date || req.query.to;
    if (!isValidIso(from) || !isValidIso(to) || to < from) throw bad('Give a date, or from and to dates');
    if (daysBetween(from, to) > 400) throw bad('Range is limited to 400 days');
    const person = req.query.person ? Number(req.query.person) : null;
    const rows = db
      .prepare(
        `SELECT p.person_id AS personId, p.date, p.type_id AS typeId, p.time, p.detail, p.updated_at AS updatedAt, COALESCE(up.name, u.username) AS updatedBy, pe.team_id AS teamId
         FROM postings p JOIN people pe ON pe.id = p.person_id LEFT JOIN users u ON u.id = p.updated_by LEFT JOIN people up ON up.id = u.person_id
         WHERE p.date BETWEEN ? AND ?${person ? ' AND p.person_id = ?' : ''} ORDER BY p.date`,
      )
      .all(...[from, to, ...(person ? [person] : [])]);
    const visible = new Set(visibleTeams(req.user));
    // Everyone can see their own postings, whichever team they are in.
    const mine = (r) => req.user.personId != null && r.personId === req.user.personId;
    const postings = rows.filter((r) => mine(r) || visible.has(r.teamId)).map(({ teamId, ...r }) => r);
    res.json({ postings, editableTeams: editableTeams(req.user), visibleTeams: [...visible] });
  });

  // PUT { date, changes: [{ personId, typeId, time, detail }] } - empty change clears the posting.
  app.put(
    '/api/postings',
    staff,
    json,
    wrap((req, res) => {
      const date = req.body?.date;
      if (!isValidIso(date)) throw bad('Choose a date');
      const changes = req.body?.changes;
      if (!Array.isArray(changes) || !changes.length) throw bad('Nothing to save');
      const v = viewerOf(req.user);
      const typeOk = db.prepare('SELECT 1 FROM posting_types WHERE id = ?');
      const teamOf = db.prepare('SELECT team_id FROM people WHERE id = ?');
      const up = db.prepare(
        `INSERT INTO postings (person_id, date, type_id, time, detail, updated_at, updated_by) VALUES (?,?,?,?,?,datetime('now'),?)
         ON CONFLICT(person_id, date) DO UPDATE SET type_id = excluded.type_id, time = excluded.time, detail = excluded.detail, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      );
      const del = db.prepare('DELETE FROM postings WHERE person_id = ? AND date = ?');
      tx(db, () => {
        for (const ch of changes) {
          const { posting, error, empty } = normalisePosting(ch);
          if (error) throw bad(error);
          const person = teamOf.get(posting.personId);
          if (!person) throw bad('Unknown person');
          if (!canEditPostings(v, person.team_id)) throw new HttpError(403, "Only that team's team leader, supervisors or a planner can change its postings");
          if (posting.typeId != null && !typeOk.get(posting.typeId)) throw bad('Unknown posting type');
          if (empty) del.run(posting.personId, date);
          else up.run(posting.personId, date, posting.typeId, posting.time, posting.detail, req.user.id);
        }
        audit(db, req.user, 'postings.update', { date, count: changes.length });
      });
      broadcast({ type: 'postings', from: date, to: date });
      res.json({ ok: true, count: changes.length });
    }),
  );

  // Copy a team's postings onto another day for the people on duty that day.
  // POST { teamId, to, from? (default: the team's most recent earlier day with postings), overwrite? }
  app.post(
    '/api/postings/copy',
    staff,
    json,
    wrap((req, res) => {
      const teamId = Number(req.body?.teamId);
      const to = req.body?.to;
      if (!isValidIso(to)) throw bad('Choose the day to copy to');
      if (!canEditPostings(viewerOf(req.user), teamId)) throw new HttpError(403, "Only that team's team leader, supervisors or a planner can change its postings");
      const from =
        req.body?.from && isValidIso(req.body.from)
          ? req.body.from
          : db
              .prepare('SELECT MAX(p.date) AS d FROM postings p JOIN people pe ON pe.id = p.person_id WHERE pe.team_id = ? AND p.date < ?')
              .get(teamId, to).d;
      if (!from) throw bad('There are no earlier postings for this team to copy');
      const source = db
        .prepare('SELECT p.person_id AS personId, p.type_id AS typeId, p.time, p.detail FROM postings p JOIN people pe ON pe.id = p.person_id WHERE pe.team_id = ? AND p.date = ?')
        .all(teamId, from);
      // Only people on a duty on the target day get a posting.
      const onDuty = db.prepare("SELECT 1 FROM assignments a JOIN duty_codes dc ON dc.code = a.code WHERE a.person_id = ? AND a.date = ? AND dc.category = 'duty'");
      const exists = db.prepare('SELECT 1 FROM postings WHERE person_id = ? AND date = ?');
      const up = db.prepare(
        `INSERT INTO postings (person_id, date, type_id, time, detail, updated_at, updated_by) VALUES (?,?,?,?,?,datetime('now'),?)
         ON CONFLICT(person_id, date) DO UPDATE SET type_id = excluded.type_id, time = excluded.time, detail = excluded.detail, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      );
      let copied = 0;
      let skipped = 0;
      tx(db, () => {
        for (const p of source) {
          if (!onDuty.get(p.personId, to) || (!req.body?.overwrite && exists.get(p.personId, to))) {
            skipped++;
            continue;
          }
          up.run(p.personId, to, p.typeId, p.time, p.detail, req.user.id);
          copied++;
        }
        audit(db, req.user, 'postings.copy', { teamId, from, to, copied });
      });
      broadcast({ type: 'postings', from: to, to });
      res.json({ from, copied, skipped });
    }),
  );
}
