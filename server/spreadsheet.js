// Import/export of the duty plan spreadsheet layout:
//   identity columns (Staff No, Name, Initials, Mobile, [Team])
//   accreditation columns (any other non-date header)
//   one column per date, cell value = duty code (RD, T1, AL, ...)
// Rows are grouped by team either with a "Team" column or with team heading
// rows (a row containing just the team name). Blank rows / "VACANT" rows inside
// a team represent vacancies and count towards the team establishment.
import ExcelJS from 'exceljs';
import { tx, audit } from './db.js';
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

/** Read an uploaded file buffer into a 2D array of normalised cell values. */
export async function readGrid(buffer, filename = '') {
  const isXlsx = buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b; // PK zip header
  if (!isXlsx) {
    if (/\.xls$/i.test(filename)) throw new Error('Legacy .xls files are not supported - save as .xlsx or .csv');
    return { rows: parseCsv(buffer.toString('utf8')), csv: true };
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  // Pick the sheet with the most cells.
  let best = null;
  wb.eachSheet((ws) => {
    if (!best || ws.actualCellCount > best.actualCellCount) best = ws;
  });
  if (!best) throw new Error('Workbook has no worksheets');
  const rows = [];
  for (let r = 1; r <= best.rowCount; r++) {
    const row = best.getRow(r);
    const out = [];
    for (let c = 1; c <= best.columnCount; c++) out.push(cellValue(row.getCell(c).value));
    rows.push(out);
  }
  return { rows, csv: false };
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

function guessCategory(code) {
  if (/^(rd|rest|off|r)$/i.test(code)) return 'rest';
  if (/^(al|a\/l|leave|sick|s|ml|pl|bh|toil|lieu)\b/i.test(code)) return 'leave';
  if (/course|train|^tc\d*|^trg/i.test(code)) return 'training';
  return 'duty';
}
function colorFor(code) {
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

/** Write parsed data into the database. mode: 'merge' (default) or 'replace'. */
export function applyImport(db, parsed, { mode = 'merge', user } = {}) {
  const summary = { teams: 0, peopleCreated: 0, peopleUpdated: 0, vacancies: 0, assignments: 0, newDutyCodes: [], newAccreditations: [] };
  tx(db, () => {
    if (mode === 'replace') {
      db.exec('DELETE FROM assignments; DELETE FROM person_accreditations; DELETE FROM people; DELETE FROM teams;');
    }
    // Duty codes
    const existingCodes = new Set(db.prepare('SELECT code FROM duty_codes').all().map((r) => r.code.toLowerCase()));
    const canonical = new Map(db.prepare('SELECT code FROM duty_codes').all().map((r) => [r.code.toLowerCase(), r.code]));
    let maxSort = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM duty_codes').get().m;
    const insCode = db.prepare('INSERT INTO duty_codes (code,label,category,color,sort_order) VALUES (?,?,?,?,?)');
    for (const t of parsed.teams)
      for (const p of t.members)
        for (const code of Object.values(p.duties)) {
          const k = code.toLowerCase();
          if (!existingCodes.has(k)) {
            existingCodes.add(k);
            canonical.set(k, code);
            insCode.run(code, code, guessCategory(code), colorFor(code), ++maxSort);
            summary.newDutyCodes.push(code);
          }
        }

    // Accreditations
    const accId = new Map(db.prepare('SELECT id, code FROM accreditations').all().map((r) => [r.code.toLowerCase(), r.id]));
    let accSort = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM accreditations').get().m;
    for (const name of parsed.accreditations) {
      if (!accId.has(name.toLowerCase())) {
        const { lastInsertRowid } = db.prepare('INSERT INTO accreditations (code,name,sort_order) VALUES (?,?,?)').run(name, name, ++accSort);
        accId.set(name.toLowerCase(), Number(lastInsertRowid));
        summary.newAccreditations.push(name);
      }
    }

    const findTeam = db.prepare('SELECT id FROM teams WHERE name = ?');
    const insTeam = db.prepare('INSERT INTO teams (name, sort_order, establishment) VALUES (?,?,?)');
    const updTeam = db.prepare('UPDATE teams SET sort_order = ?, establishment = ? WHERE id = ?');
    const findPerson = db.prepare('SELECT id FROM people WHERE staff_number = ?');
    const insPerson = db.prepare('INSERT INTO people (staff_number,name,initials,mobile,team_id,sort_order,active) VALUES (?,?,?,?,?,?,1)');
    const updPerson = db.prepare('UPDATE people SET name=?, initials=?, mobile=?, team_id=?, sort_order=?, active=1 WHERE id=?');
    const setAcc = db.prepare(
      'INSERT INTO person_accreditations (person_id,accreditation_id,value,expires) VALUES (?,?,?,?) ON CONFLICT(person_id,accreditation_id) DO UPDATE SET value=excluded.value, expires=excluded.expires',
    );
    const delAcc = db.prepare('DELETE FROM person_accreditations WHERE person_id=? AND accreditation_id=?');
    const delAsg = db.prepare('DELETE FROM assignments WHERE person_id=? AND date=?');
    const insAsg = db.prepare(
      "INSERT INTO assignments (person_id,date,code,updated_at,updated_by) VALUES (?,?,?,datetime('now'),?) ON CONFLICT(person_id,date) DO UPDATE SET code=excluded.code, updated_at=excluded.updated_at, updated_by=excluded.updated_by",
    );

    const teamOffset = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM teams').get().m;
    parsed.teams.forEach((t, ti) => {
      const establishment = t.members.length + t.vacancies;
      let teamId = findTeam.get(t.name)?.id;
      if (teamId) updTeam.run(mode === 'replace' ? ti : teamOffset + ti, establishment, teamId);
      else teamId = Number(insTeam.run(t.name, mode === 'replace' ? ti : teamOffset + ti + 1, establishment).lastInsertRowid);
      summary.teams++;
      summary.vacancies += t.vacancies;
      t.members.forEach((p, pi) => {
        let pid = findPerson.get(p.staffNumber)?.id;
        if (pid) {
          updPerson.run(p.name, p.initials || null, p.mobile || null, teamId, pi, pid);
          summary.peopleUpdated++;
        } else {
          pid = Number(insPerson.run(p.staffNumber, p.name, p.initials || null, p.mobile || null, teamId, pi).lastInsertRowid);
          summary.peopleCreated++;
        }
        for (const [an, v] of Object.entries(p.accreditations)) {
          const aid = accId.get(an.toLowerCase());
          if (v == null || v === '' || /^(n|no|false|0|-|x)$/i.test(v)) delAcc.run(pid, aid);
          else setAcc.run(pid, aid, v, /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
        }
        for (const date of parsed.dates) {
          const code = p.duties[date];
          if (code) {
            insAsg.run(pid, date, canonical.get(code.toLowerCase()) ?? code, user?.id ?? null);
            summary.assignments++;
          } else delAsg.run(pid, date);
        }
      });
    });
    audit(db, user, 'import', { mode, ...summary, dates: parsed.dates.length ? [parsed.dates[0], parsed.dates.at(-1)] : [] });
  });
  return summary;
}

/** Build an .xlsx workbook of the plan in the same layout the importer reads. */
export async function exportWorkbook(db, { from, to, teamIds }) {
  const { eachDate } = await import('./dates.js');
  const dates = eachDate(from, to);
  const teams = db.prepare('SELECT * FROM teams ORDER BY sort_order, name').all().filter((t) => !teamIds?.length || teamIds.includes(t.id));
  const accs = db.prepare('SELECT * FROM accreditations ORDER BY sort_order, name').all();
  const codes = new Map(db.prepare('SELECT * FROM duty_codes').all().map((c) => [c.code.toLowerCase(), c]));
  const people = db.prepare('SELECT * FROM people WHERE active = 1 ORDER BY sort_order, name').all();
  const pacc = db.prepare('SELECT * FROM person_accreditations').all();
  const asg = db.prepare('SELECT person_id, date, code FROM assignments WHERE date BETWEEN ? AND ?').all(from, to);
  const accMap = new Map();
  for (const a of pacc) accMap.set(`${a.person_id}:${a.accreditation_id}`, a.expires ?? a.value);
  const asgMap = new Map();
  for (const a of asg) asgMap.set(`${a.person_id}:${a.date}`, a.code);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Duty Planning';
  const ws = wb.addWorksheet('Duty Plan', { views: [{ state: 'frozen', xSplit: 5 + accs.length, ySplit: 1 }] });
  const fixed = ['Staff No', 'Name', 'Initials', 'Mobile', 'Team', ...accs.map((a) => a.code)];
  ws.addRow([...fixed, ...dates.map((d) => new Date(d + 'T00:00:00Z'))]);
  const head = ws.getRow(1);
  head.font = { bold: true };
  dates.forEach((_, i) => {
    const cell = head.getCell(fixed.length + i + 1);
    cell.numFmt = 'ddd dd/mm/yy';
    cell.alignment = { textRotation: 90, horizontal: 'center' };
  });
  ws.columns.forEach((col, i) => (col.width = i < fixed.length ? [10, 24, 8, 14, 12][i] ?? 8 : 5));

  const argb = (hex) => 'FF' + String(hex || '#ffffff').replace('#', '').toUpperCase();
  for (const t of teams) {
    const members = people.filter((p) => p.team_id === t.id);
    for (const p of members) {
      const row = ws.addRow([
        p.staff_number,
        p.name,
        p.initials,
        p.mobile,
        t.name,
        ...accs.map((a) => accMap.get(`${p.id}:${a.id}`) ?? null),
        ...dates.map((d) => asgMap.get(`${p.id}:${d}`) ?? null),
      ]);
      dates.forEach((d, i) => {
        const code = asgMap.get(`${p.id}:${d}`);
        if (code) {
          const cell = row.getCell(fixed.length + i + 1);
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(codes.get(code.toLowerCase())?.color) } };
          cell.alignment = { horizontal: 'center' };
        }
      });
    }
    for (let v = members.length; v < t.establishment; v++) {
      const row = ws.addRow([null, 'VACANT', null, null, t.name]);
      row.font = { italic: true, color: { argb: 'FF888888' } };
    }
  }
  const unassigned = people.filter((p) => !p.team_id || !teams.some((t) => t.id === p.team_id));
  if (!teamIds?.length)
    for (const p of unassigned.filter((p) => !p.team_id))
      ws.addRow([p.staff_number, p.name, p.initials, p.mobile, null, ...accs.map((a) => accMap.get(`${p.id}:${a.id}`) ?? null), ...dates.map((d) => asgMap.get(`${p.id}:${d}`) ?? null)]);
  return wb.xlsx.writeBuffer();
}
