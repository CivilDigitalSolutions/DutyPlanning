// Excel files built the same way on the server and in the browser demo.
// Each builder takes the ExcelJS library (Node import or browser global) and plain data.
import { USER_COLUMNS, ROLES, accreditationColumns } from './user-import.js';

const ROWS_WITH_VALIDATION = 1000;

/**
 * The duty plan workbook, in the same layout the importer reads.
 * data: { dates, teams:[{id,name,establishment}], accs:[{id,code}], people:[{id,staffNumber,name,initials,mobile,teamId}],
 *         accMap: Map("pid:aid" -> value), asgMap: Map("pid:date" -> code), colorOf: (code) => '#rrggbb', teamIds }
 */
export async function buildPlanWorkbook(ExcelJS, { dates, teams, accs, people, accMap, asgMap, colorOf, teamIds }) {
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
    const members = people.filter((p) => p.teamId === t.id);
    for (const p of members) {
      const row = ws.addRow([
        p.staffNumber,
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
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(colorOf(code)) } };
          cell.alignment = { horizontal: 'center' };
        }
      });
    }
    for (let v = members.length; v < t.establishment; v++) {
      const row = ws.addRow([null, 'VACANT', null, null, t.name]);
      row.font = { italic: true, color: { argb: 'FF888888' } };
    }
  }
  const unassigned = people.filter((p) => !p.teamId || !teams.some((t) => t.id === p.teamId));
  if (!teamIds?.length)
    for (const p of unassigned.filter((p) => !p.teamId))
      ws.addRow([p.staffNumber, p.name, p.initials, p.mobile, null, ...accs.map((a) => accMap.get(`${p.id}:${a.id}`) ?? null), ...dates.map((d) => asgMap.get(`${p.id}:${d}`) ?? null)]);
  return wb.xlsx.writeBuffer();
}

/** The new-users import template: a "New users" sheet with dropdowns, plus instructions. teams: [names], accs: [{id,code,name}] */
export async function buildUserTemplate(ExcelJS, { teams, accs }) {
  const cols = [...USER_COLUMNS, ...accreditationColumns(accs)];
  const letter = (i) => {
    let s = '';
    for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  };

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Duty Planning';
  const ws = wb.addWorksheet('New users', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = cols.map((c) => ({ header: c.header + (c.required ? ' *' : ''), key: c.key, width: c.width }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.height = 22;
  head.alignment = { vertical: 'middle' };
  cols.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.required ? 'FF9B2C2C' : c.acc ? 'FF4A6A85' : 'FF1F4E79' } };
    cell.note = c.desc;
  });

  // Lists for dropdowns live on a hidden sheet (avoids Excel's 255 character limit).
  const lists = wb.addWorksheet('Lists', { state: 'veryHidden' });
  ROLES.forEach((r, i) => (lists.getCell(i + 1, 1).value = r));
  teams.forEach((t, i) => (lists.getCell(i + 1, 2).value = t));

  const idx = Object.fromEntries(cols.map((c, i) => [c.key, i]));
  for (let r = 2; r <= ROWS_WITH_VALIDATION + 1; r++) {
    ws.getCell(`${letter(idx.email)}${r}`).dataValidation = {
      type: 'custom',
      allowBlank: true,
      formulae: [`ISNUMBER(SEARCH("@",${letter(idx.email)}${r}))`],
      showErrorMessage: true,
      errorTitle: 'Email',
      error: 'Enter a valid email address',
    };
    ws.getCell(`${letter(idx.role)}${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`Lists!$A$1:$A$${ROLES.length}`], showErrorMessage: true, error: 'Choose staff, planner or admin' };
    if (teams.length)
      ws.getCell(`${letter(idx.team)}${r}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [`Lists!$B$1:$B$${teams.length}`],
        showErrorMessage: false, // allow new team names when "create missing teams" is used
      };
    ws.getCell(`${letter(idx.startDate)}${r}`).numFmt = 'dd/mm/yyyy';
    ws.getCell(`${letter(idx.staffNumber)}${r}`).numFmt = '@';
    ws.getCell(`${letter(idx.mobile)}${r}`).numFmt = '@';
  }

  const info = wb.addWorksheet('Instructions');
  info.columns = [
    { header: 'Column', key: 'h', width: 20 },
    { header: 'Required', key: 'r', width: 10 },
    { header: 'What to enter', key: 'd', width: 80 },
    { header: 'Example', key: 'e', width: 24 },
  ];
  info.getRow(1).font = { bold: true };
  for (const c of cols) info.addRow({ h: c.header, r: c.required ? 'Yes' : c.key === 'firstName' || c.key === 'name' ? 'Name' : '', d: c.desc, e: c.example });
  info.addRow({});
  for (const line of [
    'Fill in one row per person on the "New users" sheet, starting on row 2. Do not change the header row.',
    'Each person needs an Email and a name (First + Last name, or Full name). Everything else is optional.',
    'Teams: pick from the list. New team names are only accepted if "Create missing teams" is ticked when importing.',
    'Accreditation columns: enter Y if held, or the expiry date. Leave blank if not held.',
    'People whose email already has an account are updated (details only - passwords are not changed).',
    'Everyone gets a temporary password and must choose their own at first sign-in.',
    'Save as .xlsx (or .csv) and upload it under Manage > User accounts > Import users.',
  ])
    info.addRow({ h: line }).getCell(1).alignment = { wrapText: false };
  info.getColumn(3).alignment = { wrapText: true, vertical: 'top' };
  return wb.xlsx.writeBuffer();
}
