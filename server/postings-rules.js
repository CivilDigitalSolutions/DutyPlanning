// Daily postings rules, shared by the server and the browser demo build.

/**
 * Who may set a team's daily postings: planners and admins for any team; a team's
 * team leader and supervisors for their own team.
 * viewer: { role, teamRole, teamId } (teamRole/teamId of the viewer's own person record)
 */
export function canEditPostings(viewer, teamId) {
  if (viewer.role === 'planner' || viewer.role === 'admin') return true;
  return teamId != null && viewer.teamId === teamId && (viewer.teamRole === 'leader' || viewer.teamRole === 'supervisor');
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
