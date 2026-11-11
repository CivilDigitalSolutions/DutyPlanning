// Pure spreadsheet parsing shared by the server and the browser demo build.
// Layout: identity columns (Staff No, Name, Initials, Mobile, [Team]), accreditation
// columns (any other non-date header) and one column per date holding duty codes.
// Teams come from a "Team" column or heading rows containing just the team name;
// blank / "VACANT" rows inside a team are vacant posts.
import { isoDate } from './dates.js';

const IDENTITY = {
  staffNumber: /^(staff|payroll|employee|emp|service|warrant|collar)\s*(no\.?|num(ber)?|#|id|ref)?$|^(staff|employee)\s*id$|^id$/i,
  name: /^(full\s*)?name$|^(employee|staff|person)\s*name$|^surname$/i,
  initials: /^init(ial)?s?$/i,
  mobile: /^(mobile|mob|phone|tel(ephone)?|contact)(\s*(no\.?|number|#))?$/i,
  team: /^(team|group|unit|crew|watch|shift\s*team)$/i,
};
const WEEKDAY = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?$/i;
const VACANT = /^vacan(t|cy|cies)\b/i;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const monthNum = (s) => MONTHS[String(s).slice(0, 3).toLowerCase()];

/** Normalise an ExcelJS cell value (or CSV string) to string | Date | number | null. */
export function cellValue(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('').trim() || null;
    if ('text' in v) return cellValue(v.text);
    if ('error' in v) return null;
    return String(v);
  }
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  return v;
}

function ymd(y, m, d) {
  if (y < 100) y += 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return isoDate(dt);
}

/** Try to interpret a header cell as a date; returns ISO date or null. */
export function headerDate(v, { dateOrder = 'dmy', allowSerial = false } = {}) {
  if (v instanceof Date) return isNaN(v) ? null : isoDate(v);
  if (typeof v === 'number') {
    if (allowSerial && v > 20000 && v < 80000) return isoDate(new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5));
    return null;
  }
  if (typeof v !== 'string') return null;
  let s = v.trim().replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i, '');
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(T.*)?$/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) return dateOrder === 'mdy' ? ymd(+m[3], +m[1], +m[2]) : ymd(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[\s/-]+([a-z]{3,9})[\s/,-]*(\d{2,4})$/i);
  if (m && monthNum(m[2])) return ymd(+m[3], monthNum(m[2]), +m[1]);
  m = s.match(/^([a-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})$/i);
  if (m && monthNum(m[1])) return ymd(+m[3], monthNum(m[1]), +m[2]);
  return null;
}

const str = (v) => (v == null ? '' : v instanceof Date ? isoDate(v) : String(v).trim());

/** Minimal RFC 4180 CSV parser. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map(cellValue));
}

/**
 * Turn a 2D grid into structured teams/people/duties.
 * @returns {{teams: Array, dates: string[], accreditations: string[], warnings: string[]}}
 */
export function parseGrid(rows, opts = {}) {
  const { dateOrder = 'dmy', blankRowsAreVacancies = true } = opts;
  const warnings = [];
  const scan = rows.slice(0, 20);

  // Identity header row: the row that names a "Name" column.
  let headerIdx = scan.findIndex((r) => r.some((v) => typeof v === 'string' && IDENTITY.name.test(v.trim())));
  if (headerIdx < 0) headerIdx = scan.findIndex((r) => r.some((v) => typeof v === 'string' && IDENTITY.staffNumber.test(v.trim())));
  if (headerIdx < 0) throw new Error('Could not find a header row with a "Name" or "Staff No" column in the first 20 rows');

  // Date header row: the row with the most date-like cells (may be the same as the identity row).
  let dateIdx = headerIdx;
  let bestCount = -1;
  scan.forEach((r, i) => {
    const n = r.filter((v) => headerDate(v, { dateOrder, allowSerial: true })).length;
    if (n > bestCount) {
      bestCount = n;
      dateIdx = i;
    }
  });

  const header = rows[headerIdx];
  const dateRow = rows[dateIdx];
  const width = Math.max(...rows.slice(0, 20).map((r) => r.length));
  const cols = {};
  const dateCols = [];
  const accCols = [];
  for (let c = 0; c < width; c++) {
    const d = headerDate(dateRow[c], { dateOrder, allowSerial: true });
    if (d) {
      dateCols.push({ c, date: d });
      continue;
    }
    const h = str(header[c]);
    if (!h) continue;
    const key = Object.keys(IDENTITY).find((k) => !(k in cols) && IDENTITY[k].test(h));
    if (key) cols[key] = c;
    else accCols.push({ c, name: h });
  }
  if (!('name' in cols) && !('staffNumber' in cols)) throw new Error('No Name or Staff No column found');
  if (!dateCols.length) warnings.push('No date columns were found - only people and accreditations will be imported');
  // Duplicate dates: keep the first occurrence.
  const seen = new Set();
  const dates = [];
  for (const d of [...dateCols]) {
    if (seen.has(d.date)) {
      warnings.push(`Date ${d.date} appears more than once - only the first column is used`);
      dateCols.splice(dateCols.indexOf(d), 1);
    } else {
      seen.add(d.date);
      dates.push(d.date);
    }
  }

  const teams = [];
  const teamByName = new Map();
  const getTeam = (name) => {
    const key = name.toLowerCase();
    if (!teamByName.has(key)) {
      const t = { name, members: [], vacancies: 0 };
      teamByName.set(key, t);
      teams.push(t);
    }
    return teamByName.get(key);
  };
  let current = null;
  const staffSeen = new Set();
  let autoId = 0;

  const start = Math.max(headerIdx, dateIdx) + 1;
  for (let r = start; r < rows.length; r++) {
    const row = rows[r] || [];
    const get = (k) => (k in cols ? str(row[cols[k]]) : '');
    const staffNumber = get('staffNumber');
    const name = get('name');
    const teamCell = get('team');
    const duties = {};
    for (const { c, date } of dateCols) {
      const v = str(row[c]);
      if (v) duties[date] = v;
    }
    const nonEmpty = row.map(str).filter(Boolean);
    const hasDuties = Object.keys(duties).length > 0;

    // Weekday sub-header rows ("Mon", "Tue", ...)
    if (nonEmpty.length && nonEmpty.every((v) => WEEKDAY.test(v))) continue;

    if ('team' in cols) {
      if (teamCell) current = getTeam(teamCell);
    } else if (!hasDuties && nonEmpty.length === 1 && !VACANT.test(nonEmpty[0]) && !/^\d+$/.test(nonEmpty[0])) {
      // A row holding a single non-numeric value (in any column) is a team heading.
      current = getTeam(nonEmpty[0]);
      continue;
    }

    const isVacant = VACANT.test(name) || VACANT.test(staffNumber);
    if (!staffNumber && !name) {
      if (!nonEmpty.length || ('team' in cols && nonEmpty.length === 1 && teamCell)) {
        if (current && (blankRowsAreVacancies || teamCell)) current.vacancies++;
        continue;
      }
      if (!hasDuties) continue;
    }
    if (isVacant) {
      if (current) current.vacancies++;
      continue;
    }
    if (!current) current = getTeam('Unassigned');

    let sn = staffNumber;
    if (!sn) {
      sn = `AUTO-${++autoId}`;
      warnings.push(`Row ${r + 1}: "${name}" has no staff number - assigned ${sn}`);
    }
    if (staffSeen.has(sn.toLowerCase())) {
      warnings.push(`Row ${r + 1}: duplicate staff number ${sn} - row skipped`);
      continue;
    }
    staffSeen.add(sn.toLowerCase());
    const accreditations = {};
    for (const { c, name: an } of accCols) {
      const v = row[c];
      accreditations[an] = v == null ? null : v instanceof Date ? isoDate(v) : String(v).trim();
    }
    current.members.push({
      staffNumber: sn,
      name: name || sn,
      initials: get('initials') || initialsOf(name),
      mobile: get('mobile'),
      accreditations,
      duties,
    });
  }

  return { teams, dates, accreditations: accCols.map((a) => a.name), warnings };
}

export function initialsOf(name) {
  return String(name || '')
    .split(/[\s,.-]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase())
    .join('')
    .slice(0, 4);
}

export function guessCategory(code) {
  if (/^(rd|rest|off|r)$/i.test(code)) return 'rest';
  if (/^(al|a\/l|leave|sick|s|ml|pl|bh|toil|lieu)\b/i.test(code)) return 'leave';
  if (/course|train|^tc\d*|^trg/i.test(code)) return 'training';
  return 'duty';
}
export function colorFor(code) {
  let h = 0;
  for (const ch of code) h = (h * 31 + ch.charCodeAt(0)) % 360;
  // HSL(h, 60%, 80%) -> hex
  const s = 0.6,
    l = 0.8;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return '#' + [f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

