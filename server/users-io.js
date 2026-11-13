// Server side of the bulk user import: the Excel template and writing rows to the database.
import ExcelJS from 'exceljs';
import { tx, audit } from './db.js';
import { hashPassword } from './auth.js';
import { generatePassword } from './user-import.js';
import { buildUserTemplate } from './workbooks.js';


/** Build the .xlsx template: a "New users" sheet with dropdowns, plus instructions. */
export async function userTemplateWorkbook(db) {
  const teams = db.prepare('SELECT name FROM teams ORDER BY sort_order, name').all().map((t) => t.name);
  const accs = db.prepare('SELECT id, code, name FROM accreditations ORDER BY sort_order, name').all();
  return buildUserTemplate(ExcelJS, { teams, accs });
}

/**
 * Write validated rows. Options: createTeams, updateExisting, defaultRole, password (shared temp
 * password; blank = generate one per new account).
 */
export function applyUserImport(db, parsed, { createTeams = true, updateExisting = true, defaultRole = 'staff', password = '', user } = {}) {
  const summary = { created: 0, updated: 0, skipped: 0, accountsCreated: 0, teamsCreated: [], credentials: [] };
  tx(db, () => {
    const findTeam = db.prepare('SELECT id, establishment FROM teams WHERE name = ?');
    const findByEmail = db.prepare('SELECT id, staff_number FROM people WHERE email = ?');
    const findByStaff = db.prepare('SELECT id, email FROM people WHERE staff_number = ?');
    const userByName = db.prepare('SELECT id, person_id FROM users WHERE username = ?');
    const userByPerson = db.prepare('SELECT id FROM users WHERE person_id = ?');
    const maxPos = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM people WHERE team_id IS ?');
    const accExists = new Set(db.prepare('SELECT id FROM accreditations').all().map((a) => a.id));
    const setAcc = db.prepare(
      'INSERT INTO person_accreditations (person_id, accreditation_id, value, expires) VALUES (?,?,?,?) ON CONFLICT(person_id, accreditation_id) DO UPDATE SET value=excluded.value, expires=excluded.expires',
    );
    const delAcc = db.prepare('DELETE FROM person_accreditations WHERE person_id = ? AND accreditation_id = ?');
    const nextStaffNo = () => {
      for (let n = db.prepare('SELECT COUNT(*) AS n FROM people').get().n + 1; ; n++) {
        const sn = 'U' + String(n).padStart(5, '0');
        if (!findByStaff.get(sn)) return sn;
      }
    };
    const shared = password ? hashPassword(password) : null;
    const touchedTeams = new Set();

    for (const row of parsed.rows) {
      if (row.errors.length) {
        summary.skipped++;
        continue;
      }
      // Team
      let teamId = null;
      if (row.teamName) {
        teamId = findTeam.get(row.teamName)?.id ?? null;
        if (!teamId) {
          if (!createTeams) throw new Error(`Row ${row.line}: team "${row.teamName}" does not exist`);
          const order = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM teams').get().n;
          teamId = Number(db.prepare('INSERT INTO teams (name, sort_order, establishment) VALUES (?,?,0)').run(row.teamName, order).lastInsertRowid);
          summary.teamsCreated.push(row.teamName);
        }
        touchedTeams.add(teamId);
      }

      // Person: match on email first, then staff number.
      let person = findByEmail.get(row.email);
      if (!person && row.staffNumber) {
        const bySn = findByStaff.get(row.staffNumber);
        if (bySn && bySn.email && bySn.email.toLowerCase() !== row.email) throw new Error(`Row ${row.line}: Staff No ${row.staffNumber} already belongs to ${bySn.email}`);
        person = bySn;
      }
      if (person && !updateExisting) {
        summary.skipped++;
        continue;
      }
      if (row.staffNumber && person) {
        const clash = findByStaff.get(row.staffNumber);
        if (clash && clash.id !== person.id) throw new Error(`Row ${row.line}: Staff No ${row.staffNumber} is already used by someone else`);
      }
      const position = row.position ?? maxPos.get(teamId).m + 1;
      let pid;
      if (person) {
        pid = person.id;
        db.prepare(
          `UPDATE people SET email=?, name=?, initials=?, mobile=COALESCE(?, mobile), team_id=?, sort_order=?, job_title=COALESCE(?, job_title),
             start_date=COALESCE(?, start_date), staff_number=COALESCE(?, staff_number), active=1 WHERE id=?`,
        ).run(row.email, row.name, row.initials || null, row.mobile || null, teamId, position, row.jobTitle || null, row.startDate, row.staffNumber || null, pid);
        summary.updated++;
      } else {
        pid = Number(
          db
            .prepare(
              'INSERT INTO people (staff_number, name, initials, mobile, team_id, sort_order, email, job_title, start_date, active) VALUES (?,?,?,?,?,?,?,?,?,1)',
            )
            .run(row.staffNumber || nextStaffNo(), row.name, row.initials || null, row.mobile || null, teamId, position, row.email, row.jobTitle || null, row.startDate)
            .lastInsertRowid,
        );
        summary.created++;
      }

      for (const [aid, val] of Object.entries(row.acc)) {
        if (!accExists.has(Number(aid))) continue;
        if (!val) delAcc.run(pid, Number(aid));
        else setAcc.run(pid, Number(aid), val.v, val.e ?? null);
      }

      // Sign-in account (username = email).
      const existing = userByPerson.get(pid) || userByName.get(row.email);
      if (existing) {
        db.prepare('UPDATE users SET person_id = ? WHERE id = ?').run(pid, existing.id);
        if (row.role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(row.role, existing.id);
      } else {
        const pw = shared ? null : generatePassword();
        db.prepare('INSERT INTO users (username, password_hash, role, person_id, must_change_password) VALUES (?,?,?,?,1)').run(row.email, shared || hashPassword(pw), row.role || defaultRole, pid);
        summary.accountsCreated++;
        if (pw) summary.credentials.push({ email: row.email, name: row.name, password: pw });
      }
    }

    // Line managers last, so a manager can appear anywhere in the same file.
    summary.managersNotFound = [];
    for (const row of parsed.rows) {
      if (row.errors.length || !row.lineManagerEmail) continue;
      const m = findByEmail.get(row.lineManagerEmail);
      const p = findByEmail.get(row.email);
      if (!p) continue;
      if (!m) summary.managersNotFound.push(row.lineManagerEmail);
      else db.prepare('UPDATE people SET line_manager_id = ? WHERE id = ?').run(m.id, p.id);
    }
    summary.managersNotFound = [...new Set(summary.managersNotFound)];

    // Team positions: set where given; a new team leader steps the previous one down.
    for (const row of parsed.rows) {
      if (row.errors.length || !row.teamRole) continue;
      const p = findByEmail.get(row.email);
      if (!p) continue;
      const teamId = db.prepare('SELECT team_id FROM people WHERE id = ?').get(p.id).team_id;
      if (row.teamRole === 'leader') db.prepare("UPDATE people SET team_role = NULL WHERE team_id = ? AND team_role = 'leader' AND id <> ?").run(teamId, p.id);
      db.prepare('UPDATE people SET team_role = ? WHERE id = ?').run(row.teamRole, p.id);
    }

    // Keep establishment at least as large as the number of people, so new starters fill vacancies.
    for (const id of touchedTeams) {
      const n = db.prepare('SELECT COUNT(*) AS n FROM people WHERE team_id = ? AND active = 1').get(id).n;
      db.prepare('UPDATE teams SET establishment = MAX(establishment, ?) WHERE id = ?').run(n, id);
    }
    audit(db, user, 'user.import', { created: summary.created, updated: summary.updated, skipped: summary.skipped, accountsCreated: summary.accountsCreated, teamsCreated: summary.teamsCreated });
  });
  return summary;
}
