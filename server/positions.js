// Team leader / supervisor positions (team_positions). One team leader per team; a person may
// hold positions in several teams. people.team_role mirrors the position in their own team.

/** Keep people.team_role in step with the person's position in their own team. */
export function syncHomeRole(db, personId) {
  db.prepare(
    'UPDATE people SET team_role = (SELECT tp.role FROM team_positions tp WHERE tp.person_id = people.id AND tp.team_id = people.team_id) WHERE id = ?',
  ).run(personId);
}

/** Set (or with role null, remove) someone's position in a team. A new team leader replaces the old one. */
export function setPosition(db, teamId, personId, role) {
  if (teamId == null) return;
  const affected = new Set([personId]);
  if (role === 'leader')
    for (const r of db.prepare("SELECT person_id FROM team_positions WHERE team_id = ? AND role = 'leader' AND person_id <> ?").all(teamId, personId)) {
      db.prepare('DELETE FROM team_positions WHERE team_id = ? AND person_id = ?').run(teamId, r.person_id);
      affected.add(r.person_id);
    }
  if (role) db.prepare('INSERT INTO team_positions (team_id, person_id, role) VALUES (?,?,?) ON CONFLICT(team_id, person_id) DO UPDATE SET role = excluded.role').run(teamId, personId, role);
  else db.prepare('DELETE FROM team_positions WHERE team_id = ? AND person_id = ?').run(teamId, personId);
  for (const id of affected) syncHomeRole(db, id);
}

/** Replace a team's team leader and supervisors in one go. */
export function replaceTeamPositions(db, teamId, leaderId, supervisorIds) {
  const before = db.prepare('SELECT person_id FROM team_positions WHERE team_id = ?').all(teamId).map((r) => r.person_id);
  db.prepare('DELETE FROM team_positions WHERE team_id = ?').run(teamId);
  const ins = db.prepare('INSERT INTO team_positions (team_id, person_id, role) VALUES (?,?,?)');
  if (leaderId != null) ins.run(teamId, leaderId, 'leader');
  for (const id of supervisorIds) ins.run(teamId, id, 'supervisor');
  for (const id of new Set([...before, ...(leaderId != null ? [leaderId] : []), ...supervisorIds])) syncHomeRole(db, id);
}

/** All positions held: Map personId -> [{ teamId, role }] */
export function positionsByPerson(db) {
  const out = new Map();
  for (const r of db.prepare('SELECT person_id, team_id, role FROM team_positions').all()) {
    if (!out.has(r.person_id)) out.set(r.person_id, []);
    out.get(r.person_id).push({ teamId: r.team_id, role: r.role });
  }
  return out;
}
