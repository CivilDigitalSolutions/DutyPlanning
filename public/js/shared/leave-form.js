// Annual leave application form (modelled on "Form 410 - Application for Annual Leave").
// Pure functions shared by the browser app, the server and the demo build.

/** Organisation-specific wording, editable by admins (Manage -> Leave form). */
export const DEFAULT_FORM_SETTINGS = {
  number: 'Form 410',
  title: 'Application for Annual Leave',
  unit: '',
  notice: 'Before travelling abroad, all staff must familiarise themselves with the latest travel advice.',
  reference: '',
  guidance: [
    'Paragraph (c) is to be completed for periods of Annual Leave not exceeding 3 days where the officer will be either at his/her registered address or a similarly accessible address and will be available to attend court should the need arise.',
    'If an officer reports sick during annual leave he/she must obtain a medical certificate which will be sent forthwith to his/her OCU Commander and the directions regarding claims for National Insurance benefit complied with. The officer will then be shown on the sick list and his/her annual leave will be cancelled for the duration of his/her sickness.',
    'An officer taken ill away from home and unable to return will so inform Central HR to whom his/her medical certificate is sent or produced, at the time it is sent or produced. Certificates and treatment while away from home will be obtained from a doctor taking part in the National Health Service unless the officer is willing to pay for them him/herself.',
    'Paragraph (d): it is the responsibility of both the individual and the authorising officer to ascertain if any training will be disrupted by the individual taking Annual Leave. The training manager and Learning Support Unit must be informed prior to the leave being authorised.',
  ].join('\n'),
};
export const SETTING_KEYS = Object.keys(DEFAULT_FORM_SETTINGS);

/** Paragraph (c) applies to leave of up to this many working days. */
export const AVAILABLE_FOR_COURT_MAX_DAYS = 3;

const str = (v, max) => (v == null ? '' : String(v).trim().slice(0, max));
const count = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 999 ? n : NaN;
};
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Check and tidy the applicant's part of the form.
 * Input: { unit, address, phone, joinDate, noCourtCases, crownCourtCases, availableForCourt, trainingCourses, declaration }
 * @returns {{ form, errors: string[] }}
 */
export function normaliseApplicantForm(input = {}, { workingDays = 0 } = {}) {
  const errors = [];
  const crown = count(input.crownCourtCases);
  const training = count(input.trainingCourses);
  if (Number.isNaN(crown)) errors.push('Crown Court cases must be a whole number');
  if (Number.isNaN(training)) errors.push('Training courses must be a whole number');
  const form = {
    unit: str(input.unit, 100),
    address: str(input.address, 300),
    phone: str(input.phone, 40),
    joinDate: ISO.test(input.joinDate || '') ? input.joinDate : '',
    noCourtCases: !!input.noCourtCases,
    crownCourtCases: Number.isNaN(crown) ? null : crown,
    availableForCourt: !!input.availableForCourt,
    trainingCourses: Number.isNaN(training) ? null : training,
  };
  if (!form.address) errors.push('Give the address while on leave');
  if (!form.phone) errors.push('Give a telephone number');
  if (form.noCourtCases && form.crownCourtCases > 0) errors.push('Tick (a) or give a number of Crown Court cases in (b), not both');
  if (!form.noCourtCases && form.crownCourtCases == null) errors.push('Complete court declaration (a) or (b)');
  if (form.availableForCourt && workingDays > AVAILABLE_FOR_COURT_MAX_DAYS)
    errors.push(`Declaration (c) only applies to leave of ${AVAILABLE_FOR_COURT_MAX_DAYS} days or less`);
  if (!input.declaration) errors.push('Confirm the declaration to sign the application');
  return { form, errors };
}

const natureOf = (code) => (String(code).toUpperCase() === 'AL' ? 'A/L' : String(code));

/**
 * "Nature of leave" for one day of the period, as written on the form:
 * A/L annual leave, R/D rest day, B.H.L. bank holiday leave.
 * day: a leaveBreakdown day { code, category, working, publicHoliday }; type: requested leave code.
 */
export function natureOfLeave(day, type = 'AL') {
  const c = String(day.code || '').toUpperCase();
  if (c.startsWith('PH-') || day.publicHoliday) return 'B.H.L.';
  if (c.startsWith('RD-')) return 'R/D';
  if (c && c === String(type).toUpperCase()) return natureOf(type);
  if (day.working) return natureOf(type);
  if (!day.code || day.category === 'rest') return 'R/D';
  return day.code;
}

const dow = (iso) => new Date(iso + 'T00:00:00Z').getUTCDay();
const plus = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const WEEKDAYS = ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

/** The form's week grid: weeks run Saturday to Friday; days outside the period are null. */
export function formWeeks(days, type = 'AL') {
  if (!days.length) return [];
  const byDate = new Map(days.map((d) => [d.date, d]));
  const first = days[0].date;
  const last = days[days.length - 1].date;
  let start = first;
  while (dow(start) !== 6) start = plus(start, -1);
  const weeks = [];
  for (let w = start; w <= last; w = plus(w, 7)) {
    weeks.push(
      WEEKDAYS.map((_, i) => {
        const date = plus(w, i);
        const d = byDate.get(date);
        return d ? { date, nature: natureOfLeave(d, type) } : null;
      }),
    );
  }
  return weeks;
}

/** dd.mm.yyyy, as used on the paper form. */
export const formDate = (iso, short = false) => {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${short ? y.slice(2) : y}`;
};

/** Training courses in the period (for paragraph (d)): each run of consecutive days with the same training code. */
export function trainingCoursesIn(days) {
  let n = 0;
  let prev = null;
  for (const d of days) {
    const code = d.category === 'training' ? d.code : null;
    if (code && code !== prev) n++;
    prev = code;
  }
  return n;
}
