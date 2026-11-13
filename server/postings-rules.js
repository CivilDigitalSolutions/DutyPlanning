// Daily postings rules, shared by the server and the browser demo build.

/**
 * Who may set a team's daily postings: planners and admins for any team; a team's team leader
 * and supervisors (who may lead or supervise several teams) for those teams.
 * viewer: { role, teamId (their own team), positions: [{ teamId, role }] }
 */
export function canEditPostings(viewer, teamId) {
  if (viewer.role === 'planner' || viewer.role === 'admin') return true;
  return teamId != null && (viewer.positions || []).some((p) => p.teamId === teamId);
}

/** Who may see a team's daily postings: planners/admins, its own members, and its team leader and supervisors. */
export function canViewPostings(viewer, teamId) {
  return canEditPostings(viewer, teamId) || (teamId != null && viewer.teamId === teamId);
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Tidy one posting change: { personId, typeId, time, detail }. Returns { posting, error }. */
export function normalisePosting(ch) {
  const personId = Number(ch?.personId);
  if (!Number.isInteger(personId)) return { error: 'Unknown person' };
  const typeId = ch.typeId == null || ch.typeId === '' ? null : Number(ch.typeId);
  if (typeId != null && !Number.isInteger(typeId)) return { error: 'Unknown posting type' };
  const time = ch.time ? String(ch.time).trim() : '';
  if (time && !TIME.test(time)) return { error: `"${time}" is not a time (use HH:MM)` };
  const detail = ch.detail == null ? '' : String(ch.detail).trim().slice(0, 200);
  return { posting: { personId, typeId, time: time || null, detail: detail || null }, empty: typeId == null && !detail && !time };
}
