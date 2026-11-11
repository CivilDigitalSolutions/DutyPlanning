// Import/export of the duty plan spreadsheet (see sheet-parse.js for the layout).
import ExcelJS from 'exceljs';
import { tx, audit } from './db.js';
import { cellValue, parseCsv, guessCategory, colorFor } from './sheet-parse.js';

export { cellValue, headerDate, parseCsv, parseGrid, initialsOf } from './sheet-parse.js';

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
