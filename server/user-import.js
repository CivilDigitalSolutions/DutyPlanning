// Bulk import of new people + sign-in accounts from a template keyed on email
// address. Pure functions only: shared by the server and the browser demo build.
import { headerDate, initialsOf } from './sheet-parse.js';
import { isoDate } from './dates.js';

export const ROLES = ['staff', 'planner', 'admin'];

/** Template columns, in order. Accreditation columns are appended per accreditation. */
export const USER_COLUMNS = [
  { key: 'email', header: 'Email', required: true, width: 32, example: 'alex.smith@yourorg.org', desc: 'Work email address. This becomes their sign-in name and must be unique.', re: /^(work\s*)?e-?mail(\s*address)?$/i },
  { key: 'firstName', header: 'First name', width: 14, example: 'Alex', desc: 'First name. Give First and Last name, or Full name.', re: /^(first|fore|given)\s*names?$|^forenames?$/i },
  { key: 'lastName', header: 'Last name', width: 16, example: 'Smith', desc: 'Last name / surname.', re: /^(last|sur|family)\s*name$|^surname$/i },
  { key: 'name', header: 'Full name', width: 22, example: '', desc: 'Optional. If blank, First name + Last name is used. Use this if you only have one name column.', re: /^(full\s*|display\s*)?name$/i },
  { key: 'staffNumber', header: 'Staff No', width: 11, example: '10234', desc: 'Payroll or staff number. If blank, one is generated (e.g. U00042).', re: /^(staff|payroll|employee|emp|service|warrant|collar)\s*(no\.?|num(ber)?|#|id|ref)?$|^(staff|employee)\s*id$/i },
  { key: 'initials', header: 'Initials', width: 9, example: 'AS', desc: 'Shown on the plan. If blank, made from the name.', re: /^init(ial)?s?$/i },
  { key: 'mobile', header: 'Mobile', width: 16, example: '07700 900123', desc: 'Mobile phone number.', re: /^(mobile|mob|cell|phone|tel(ephone)?|contact)(\s*(phone\s*)?(no\.?|number|#))?$/i },
  { key: 'team', header: 'Team', width: 14, example: 'Team 1', desc: 'Team name exactly as it appears in the app. Leave blank for no team.', re: /^(team|group|unit|crew|watch|shift\s*team)(\s*name)?$/i },
  { key: 'position', header: 'Position in team', width: 10, example: '3', desc: 'Optional order within the team on the plan (a number). Blank puts them at the end.', re: /^(position|order)(\s*in\s*team)?$|^sort(\s*order)?$/i },
  { key: 'jobTitle', header: 'Job title', width: 18, example: 'Officer', desc: 'Rank, grade or job title.', re: /^(job\s*title|title|rank|grade|post|position\s*title)$/i },
  { key: 'startDate', header: 'Start date', width: 12, example: '01/04/2026', desc: 'Date they joined, as dd/mm/yyyy.', re: /^(start(\s*date)?|date\s*(joined|started)|joined)$/i },
  { key: 'role', header: 'App role', width: 10, example: 'staff', desc: 'What they can do in the app: staff (view only, the default), planner (edit the plan) or admin (also manage accounts).', re: /^((app|system|access|user)\s*)?role$|^access(\s*level)?$|^permissions?$/i },
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v) => (v == null ? '' : v instanceof Date ? isoDate(v) : String(v).trim());

/** Columns for accreditations: header is the accreditation's short code. */
export const accreditationColumns = (accreditations) =>
  accreditations.map((a) => ({ key: `acc:${a.id}`, header: a.code, width: Math.max(6, a.code.length + 2), example: 'Y', desc: `${a.name}: Y if held, or the expiry date (dd/mm/yyyy). Blank if not held.`, acc: a }));

/**
 * Validate uploaded rows.
 * @param rows 2D array of cell values (from readGrid / parseCsv)
 * @param ctx { teams:[{id,name}], accreditations:[{id,code,name}], dateOrder }
 * @returns {{ rows: Array, warnings: string[], columns: string[] }}
 */
export function parseUserRows(rows, { teams, accreditations, dateOrder = 'dmy' }) {
  const warnings = [];
  const clean = (v) => str(v).replace(/\s*\*+$/, ''); // template marks required columns with "*"
  const headerIdx = rows.slice(0, 15).findIndex((r) => r.some((v) => typeof v === 'string' && USER_COLUMNS[0].re.test(clean(v))));
  if (headerIdx < 0) throw new Error('Could not find a header row with an "Email" column. Download the template and keep its first row.');
  const header = rows[headerIdx];
  const accCols = accreditationColumns(accreditations);
  const col = {};
  const used = [];
  header.forEach((h, c) => {
    const text = clean(h);
    if (!text) return;
    const def = USER_COLUMNS.find((d) => !(d.key in col) && d.re.test(text)) || accCols.find((d) => !(d.key in col) && [d.acc.code, d.acc.name].some((x) => x.toLowerCase() === text.toLowerCase()));
    if (def) {
      col[def.key] = c;
      used.push(def.header);
    } else warnings.push(`Column "${text}" was not recognised and is ignored`);
  });

  const teamByName = new Map(teams.map((t) => [t.name.toLowerCase(), t]));
  const seenEmail = new Map();
  const seenStaff = new Map();
  const out = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const raw = rows[r] || [];
    const get = (k) => (k in col ? str(raw[col[k]]) : '');
    if (!raw.some((v) => str(v))) continue; // blank row
    const errors = [];
    const email = get('email').toLowerCase();
    if (!email) errors.push('Email is missing');
    else if (!EMAIL.test(email)) errors.push(`"${email}" is not a valid email address`);
    else if (seenEmail.has(email)) errors.push(`Email also used on row ${seenEmail.get(email)}`);
    else seenEmail.set(email, r + 1);

    const name = get('name') || [get('firstName'), get('lastName')].filter(Boolean).join(' ');
    if (!name) errors.push('Name is missing (fill in First and Last name, or Full name)');

    const staffNumber = get('staffNumber');
    if (staffNumber) {
      if (seenStaff.has(staffNumber.toLowerCase())) errors.push(`Staff No also used on row ${seenStaff.get(staffNumber.toLowerCase())}`);
      else seenStaff.set(staffNumber.toLowerCase(), r + 1);
    }

    const teamName = get('team');
    const team = teamName ? teamByName.get(teamName.toLowerCase()) : null;

    let role = get('role').toLowerCase();
    if (role && !ROLES.includes(role)) {
      errors.push(`App role "${role}" must be staff, planner or admin`);
      role = '';
    }

    let startDate = null;
    if ('startDate' in col && raw[col.startDate] != null && str(raw[col.startDate])) {
      startDate = headerDate(raw[col.startDate], { dateOrder, allowSerial: true });
      if (!startDate) errors.push(`Start date "${str(raw[col.startDate])}" is not a date`);
    }

    let position = null;
    if (get('position')) {
      position = Number(get('position'));
      if (!Number.isInteger(position)) {
        errors.push('Position in team must be a whole number');
        position = null;
      }
    }

    const acc = {};
    for (const d of accCols) {
      if (!(d.key in col)) continue;
      const v = raw[col[d.key]];
      const text = str(v);
      if (!text || /^(n|no|false|0|-|x)$/i.test(text)) acc[d.acc.id] = null;
      else {
        const date = v instanceof Date || /\d/.test(text) ? headerDate(v, { dateOrder, allowSerial: true }) : null;
        acc[d.acc.id] = date ? { v: 'Y', e: date } : { v: text.length <= 3 ? text.toUpperCase() : text };
      }
    }

    out.push({
      line: r + 1,
      email,
      name,
      staffNumber,
      initials: get('initials') || initialsOf(name),
      mobile: get('mobile'),
      teamName: team?.name || teamName,
      teamId: team?.id ?? null,
      newTeam: !!teamName && !team,
      position,
      jobTitle: get('jobTitle'),
      startDate,
      role,
      acc,
      errors,
    });
  }
  if (!out.length) warnings.push('No people found below the header row');
  return { rows: out, warnings, columns: used };
}

/** Readable random temporary password (no ambiguous characters). */
export function generatePassword(length = 10) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

/** CSV version of the template (header row only). */
export function templateCsv(accreditations) {
  const cols = [...USER_COLUMNS, ...accreditationColumns(accreditations)];
  const q = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return cols.map((c) => q(c.header)).join(',') + '\r\n';
}
