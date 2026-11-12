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
 * @param holidayAt (date) => public holiday name or null
 * A day counts against the allowance when the person is rostered to work it (duty or
 * training), or - where nothing is planned yet - when it is a weekday. Public holidays
 * and rest days never count.
 */
export function leaveBreakdown({ dates, codeAt, info, teamOnDuty, minStrength, holidayAt }) {
  const days = dates.map((date) => {
    const code = codeAt(date) || null;
    const category = code ? info(code)?.category || 'other' : null;
    const publicHoliday = (holidayAt && holidayAt(date)) || null;
    const working = !publicHoliday && (code ? category === 'duty' || category === 'training' : isWeekday(date));
    const onShift = category === 'duty';
    const onDuty = teamOnDuty ? teamOnDuty(date) : null;
    const coverLow = onShift && minStrength != null && onDuty != null && onDuty - 1 < minStrength;
    return { date, code, category, publicHoliday, working, teamOnDuty: onDuty, teamAfter: onShift && onDuty != null ? onDuty - 1 : onDuty, coverLow };
  });
  return { days, workingDays: days.filter((d) => d.working).length, coverWarnings: days.filter((d) => d.coverLow).length };
}

/**
 * What each day becomes when leave is added to the roster.
 *   working day      -> the leave code (e.g. AL)
 *   rest day         -> "RD-<code>"  (Rest Day - AL), if that code exists, otherwise left alone
 *   public holiday   -> "PH-<code>"  (Public holiday - AL), if that code exists, otherwise the leave code
 * Days already showing other leave (e.g. sickness) are never overwritten.
 * @returns [{ date, code }]
 */
export function leavePlan(days, code, hasCode) {
  const out = [];
  for (const d of days) {
    if (d.category === 'leave' && !/^(PH|RD)-/i.test(d.code || '')) continue;
    if (d.publicHoliday) out.push({ date: d.date, code: hasCode(`PH-${code}`) ? `PH-${code}` : code });
    else if (d.working) out.push({ date: d.date, code });
    else if (hasCode(`RD-${code}`)) out.push({ date: d.date, code: `RD-${code}` });
  }
  return out;
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
