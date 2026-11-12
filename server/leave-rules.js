// Annual leave workflow rules, shared by the server and the browser demo build.
//
//   pending ──(line manager approves)──▶ approved ──(leave administrator applies)──▶ applied
//      │                                    │                                         │
//      ├─(manager rejects)─▶ rejected       ├─(administrator declines)─▶ rejected     ├─(requester asks to cancel)─▶ cancel_requested
//      └─(requester cancels)─▶ cancelled    └─(requester cancels)─▶ cancelled         │        ├─(admin removes from roster)─▶ cancelled
//                                                                                     └────────┴─(admin keeps leave)─▶ applied
// Applying writes the leave code onto the roster and keeps a snapshot of what it
// replaced, so removing the leave later restores the original duties.

export const STATUSES = ['pending', 'approved', 'applied', 'cancel_requested', 'rejected', 'cancelled'];
export const ACTIVE_STATUSES = ['pending', 'approved', 'applied', 'cancel_requested'];
export const STATUS_LABELS = {
  pending: 'Awaiting approval',
  approved: 'Approved - to be added to roster',
  applied: 'On the roster',
  cancel_requested: 'Cancellation requested',
  rejected: 'Not approved',
  cancelled: 'Cancelled',
};
export const MAX_REQUEST_DAYS = 60;

/**
 * What the viewer may do with a request.
 * req: { personId, managerPersonId, status }
 * viewer: { personId, role, leaveAdmin }
 */
export function leaveActions(req, viewer) {
  const isOwner = viewer.personId != null && req.personId === viewer.personId;
  const isManager = req.managerPersonId != null && req.managerPersonId === viewer.personId;
  const isAdmin = viewer.role === 'admin';
  const administers = isAdmin || !!viewer.leaveAdmin;
  const s = req.status;
  return {
    // Managers decide for their reports; admins (or leave administrators, when no manager is set) can stand in.
    // Nobody approves their own leave.
    approve: s === 'pending' && !isOwner && (isManager || isAdmin || (req.managerPersonId == null && administers)),
    reject: s === 'pending' && !isOwner && (isManager || isAdmin || (req.managerPersonId == null && administers)),
    apply: s === 'approved' && administers,
    decline: s === 'approved' && administers && !isOwner,
    cancel: isOwner && (s === 'pending' || s === 'approved'),
    requestCancel: isOwner && s === 'applied',
    remove: administers && (s === 'applied' || s === 'cancel_requested'),
    keep: administers && s === 'cancel_requested',
  };
}

/** Status a successful action moves the request to. */
export const ACTION_RESULT = {
  approve: 'approved',
  reject: 'rejected',
  apply: 'applied',
  decline: 'rejected',
  cancel: 'cancelled',
  requestCancel: 'cancel_requested',
  remove: 'cancelled',
  keep: 'applied',
};

const isWeekday = (iso) => {
  const d = new Date(iso + 'T00:00:00Z').getUTCDay();
  return d >= 1 && d <= 5;
};

/**
 * Day-by-day view of a leave period against the roster.
 * @param dates ISO dates in the request
 * @param codeAt (date) => current roster code for the person or null
 * @param info (code) => { category, label }
 * @param teamOnDuty (date) => number of the person's team on a duty that day (including them)
 * @param minStrength team minimum or null
 * A day counts against the allowance when the person is rostered to work it (duty or
 * training), or - where nothing is planned yet - when it is a weekday.
 */
export function leaveBreakdown({ dates, codeAt, info, teamOnDuty, minStrength }) {
  const days = dates.map((date) => {
    const code = codeAt(date) || null;
    const category = code ? info(code)?.category || 'other' : null;
    const working = code ? category === 'duty' || category === 'training' : isWeekday(date);
    const onDuty = teamOnDuty ? teamOnDuty(date) : null;
    const coverLow = working && category === 'duty' && minStrength != null && onDuty != null && onDuty - 1 < minStrength;
    return { date, code, category, working, teamOnDuty: onDuty, teamAfter: working && category === 'duty' && onDuty != null ? onDuty - 1 : onDuty, coverLow };
  });
  return { days, workingDays: days.filter((d) => d.working).length, coverWarnings: days.filter((d) => d.coverLow).length };
}

/** Which dates get the leave code when applied. Existing leave (e.g. sickness) is never overwritten. */
export function datesToApply(days, { includeRestDays = false } = {}) {
  return days.filter((d) => d.category !== 'leave' && (d.working || includeRestDays)).map((d) => d.date);
}

/** Current leave year, given its start as "MM-DD" (default 1 January). */
export function leaveYear(today, start = '01-01') {
  const [m, d] = start.split('-').map(Number);
  const y = Number(today.slice(0, 4));
  const mmdd = today.slice(5);
  const startYear = mmdd >= start ? y : y - 1;
  const from = `${startYear}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const end = new Date(Date.UTC(startYear + 1, m - 1, d - 1));
  return { from, to: end.toISOString().slice(0, 10) };
}

export function validateRequestDates(start, end, isValidIso, daysBetween) {
  if (!isValidIso(start) || !isValidIso(end)) return 'Choose a first and last day';
  if (end < start) return 'The last day must be on or after the first day';
  if (daysBetween(start, end) + 1 > MAX_REQUEST_DAYS) return `A single request can cover up to ${MAX_REQUEST_DAYS} days - split longer leave into separate requests`;
  return null;
}
