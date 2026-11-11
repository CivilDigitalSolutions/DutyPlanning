// Management screens for planners and admins.
import { api, get, post, put, del, download } from '../api.js';
import { state, isAdmin, loadMeta, loadRoster } from '../state.js';
import { $, html, toast, dialog, confirmDialog, contrast, todayIso, addDays, debounce } from '../util.js';

const TABS = [
  ['people', 'People'],
  ['teams', 'Teams'],
  ['codes', 'Duty codes'],
  ['accreditations', 'Accreditations'],
  ['import', 'Import / export'],
  ['users', 'User accounts', true],
  ['audit', 'Activity log', true],
];

export async function render(root, params) {
  const tab = TABS.find(([k, , adminOnly]) => k === params[0] && (!adminOnly || isAdmin()))?.[0] || 'people';
  root.innerHTML = html`
    <section class="admin">
      <nav class="subtabs" aria-label="Manage">
        ${TABS.filter(([, , a]) => !a || isAdmin()).map(([k, l]) => html`<a href="#/admin/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`)}
      </nav>
      <div class="admin-body"></div>
    </section>`;
  const body = $('.admin-body', root);
  const handlers = { people, teams, codes, accreditations, import: importExport, users, audit };
  await handlers[tab](body, params.slice(1));
}

const refreshMeta = () => loadMeta().catch(() => {});
const formData = (form) => Object.fromEntries(new FormData(form).entries());
const actions = (okLabel = 'Save', extra = '') =>
  `${extra}<span class="spacer"></span><button value="cancel" class="btn" formnovalidate>Cancel</button><button value="ok" class="btn btn-primary">${okLabel}</button>`;

/** Open a form dialog, call save(values) on submit; keep open on error. */
function formDialog(title, fields, save, { wide = false, extraActions = '', onOpen } = {}) {
  const d = dialog(title, fields, { wide, actions: actions('Save', extraActions) });
  const form = $('form', d);
  onOpen?.(d, form);
  form.addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    try {
      await save(formData(form), form);
      d.close('ok');
    } catch (ex) {
      toast(ex.message, 'error');
    }
  });
  return d;
}

// ---------------- People ----------------
async function people(body, params) {
  let list = [];
  let q = '';
  let team = '';
  body.innerHTML = html`
    <div class="toolbar">
      <input type="search" placeholder="Search people" data-f="q" />
      <select data-f="team"><option value="">All teams</option>${state.meta.teams.map((t) => html`<option value="${t.id}">${t.name}</option>`)}<option value="none">No team</option></select>
      <span class="spacer"></span>
      <button class="btn btn-primary" data-act="add">Add person</button>
    </div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Staff no</th><th>Name</th><th>Initials</th><th>Team</th><th>Job title</th><th>Mobile</th><th>Email</th><th>Login</th><th></th></tr></thead><tbody></tbody></table></div>`;

  const load = async () => {
    list = (await get('/people')).people;
    draw();
  };
  const draw = () => {
    const rows = list.filter(
      (p) =>
        (!q || `${p.name} ${p.staffNumber} ${p.initials} ${p.email || ''}`.toLowerCase().includes(q)) &&
        (!team || (team === 'none' ? !p.teamId : p.teamId === Number(team))),
    );
    $('tbody', body).innerHTML = html`${rows.map(
      (p) => html`<tr class="${p.active ? '' : 'inactive'}">
        <td>${p.staffNumber}</td><td>${p.name}${p.active ? '' : html` <small class="muted">(inactive)</small>`}</td><td>${p.initials || ''}</td>
        <td>${state.teamMap.get(p.teamId)?.name || '–'}</td><td>${p.jobTitle || ''}</td><td>${p.mobile || ''}</td><td>${p.email || ''}</td><td>${p.username || html`<span class="muted">–</span>`}</td>
        <td class="actions"><button class="btn btn-sm" data-edit="${p.id}">Edit</button></td></tr>`,
    )}`;
    if (!rows.length) $('tbody', body).innerHTML = '<tr><td colspan="9" class="empty">No people</td></tr>';
  };
  body.addEventListener('input', debounce((e) => {
    if (e.target.dataset.f === 'q') {
      q = e.target.value.toLowerCase();
      draw();
    }
  }, 120));
  body.addEventListener('change', (e) => {
    if (e.target.dataset.f === 'team') {
      team = e.target.value;
      draw();
    }
  });
  body.addEventListener('click', (e) => {
    if (e.target.closest('[data-act=add]')) edit(null);
    const id = e.target.closest('[data-edit]')?.dataset.edit;
    if (id) edit(list.find((p) => p.id === Number(id)));
  });

  async function edit(p) {
    // Fetch accreditation values for this person from the roster endpoint (today only).
    let acc = {};
    if (p) {
      const r = await loadRoster(todayIso(), todayIso());
      acc = r.peopleById.get(p.id)?.acc || {};
    }
    const d = formDialog(
      p ? `Edit ${p.name}` : 'Add person',
      html`<div class="form-grid">
        <label>Staff number<input name="staffNumber" value="${p?.staffNumber || ''}" required maxlength="50" /></label>
        <label>Name<input name="name" value="${p?.name || ''}" required maxlength="150" /></label>
        <label>Initials<input name="initials" value="${p?.initials || ''}" maxlength="10" /></label>
        <label>Mobile<input name="mobile" type="tel" value="${p?.mobile || ''}" maxlength="30" /></label>
        <label>Email<input name="email" type="email" value="${p?.email || ''}" maxlength="200" /></label>
        <label>Job title<input name="jobTitle" value="${p?.jobTitle || ''}" maxlength="100" /></label>
        <label>Start date<input name="startDate" type="date" value="${p?.startDate || ''}" /></label>
        <label>Team<select name="teamId"><option value="">No team</option>${state.meta.teams.map((t) => html`<option value="${t.id}" ${p?.teamId === t.id ? 'selected' : ''}>${t.name}</option>`)}</select></label>
        <label>Position in team<input name="sortOrder" type="number" value="${p?.sortOrder ?? 0}" /></label>
        <label class="check span2"><input type="checkbox" name="active" ${!p || p.active ? 'checked' : ''} /> Active (shown on the plan)</label>
        ${state.meta.accreditations.length
          ? html`<fieldset class="span2"><legend>Accreditations</legend><div class="acc-edit">
            ${state.meta.accreditations.map(
              (a) => html`<div class="acc-row"><label class="check"><input type="checkbox" name="acc_${a.id}" ${acc[a.id] ? 'checked' : ''} /> ${a.name}</label>
              <label class="inline">Expires <input type="date" name="exp_${a.id}" value="${acc[a.id]?.e || ''}" /></label></div>`,
            )}</div></fieldset>`
          : ''}
      </div>`,
      async (v, form) => {
        const payload = { ...v, active: form.active.checked, teamId: v.teamId || null };
        let id = p?.id;
        if (p) await put(`/people/${p.id}`, payload);
        else id = (await post('/people', payload)).id;
        const accBody = {};
        for (const a of state.meta.accreditations) {
          const on = form[`acc_${a.id}`].checked;
          const e = form[`exp_${a.id}`].value;
          accBody[a.id] = on || e ? { v: acc[a.id]?.v || 'Y', e: e || null } : null;
        }
        if (Object.keys(accBody).length) await put(`/people/${id}/accreditations`, accBody);
        toast('Saved', 'success');
        await refreshMeta();
        load();
      },
      {
        wide: true,
        extraActions: p ? '<button value="delete" class="btn btn-danger" formnovalidate>Delete</button>' : '',
      },
    );
    $('form', d).addEventListener('submit', async (e) => {
      if (e.submitter?.value !== 'delete') return;
      e.preventDefault();
      if (!(await confirmDialog(`Delete ${p.name} and all of their planned duties? Consider marking them inactive instead.`, 'Delete', true))) return;
      try {
        await del(`/people/${p.id}`);
        d.close();
        toast('Deleted');
        await refreshMeta();
        load();
      } catch (ex) {
        toast(ex.message, 'error');
      }
    });
  }

  await load();
  if (params[0]) {
    const p = list.find((x) => x.id === Number(params[0]));
    if (p) edit(p);
  }
}

// ---------------- Generic simple CRUD table ----------------
async function simpleCrud(body, { title, rows, columns, fields, keyOf, create, update, remove, addLabel }) {
  const draw = () => {
    const data = rows();
    body.innerHTML = html`
      <div class="toolbar"><h2>${title}</h2><span class="spacer"></span><button class="btn btn-primary" data-act="add">${addLabel}</button></div>
      <div class="table-wrap"><table class="data"><thead><tr>${columns.map(([l]) => html`<th>${l}</th>`)}<th></th></tr></thead>
      <tbody>${data.map((r) => html`<tr>${columns.map(([, f]) => html`<td>${f(r)}</td>`)}<td class="actions"><button class="btn btn-sm" data-edit="${keyOf(r)}">Edit</button></td></tr>`)}</tbody></table></div>`;
    if (!data.length) $('tbody', body).innerHTML = `<tr><td colspan="${columns.length + 1}" class="empty">None yet</td></tr>`;
  };
  const open = (row) => {
    const d = formDialog(
      row ? `Edit` : addLabel,
      fields(row),
      async (v, form) => {
        if (row) await update(row, v, form);
        else await create(v, form);
        await refreshMeta();
        toast('Saved', 'success');
        draw();
      },
      { extraActions: row ? '<button value="delete" class="btn btn-danger" formnovalidate>Delete</button>' : '' },
    );
    $('form', d).addEventListener('submit', async (e) => {
      if (e.submitter?.value !== 'delete') return;
      e.preventDefault();
      if (!(await confirmDialog('Delete this item?', 'Delete', true))) return;
      try {
        await remove(row);
        d.close();
        await refreshMeta();
        draw();
      } catch (ex) {
        toast(ex.message, 'error');
      }
    });
  };
  body.onclick = (e) => {
    if (e.target.closest('[data-act=add]')) open(null);
    const k = e.target.closest('[data-edit]')?.dataset.edit;
    if (k != null) open(rows().find((r) => String(keyOf(r)) === k));
  };
  draw();
}

function teams(body) {
  return simpleCrud(body, {
    title: 'Teams',
    addLabel: 'Add team',
    rows: () => state.meta.teams,
    keyOf: (t) => t.id,
    columns: [
      ['Order', (t) => t.sortOrder],
      ['Team', (t) => t.name],
      ['Establishment', (t) => t.establishment],
      ['Filled', (t) => t.strength],
      ['Vacancies', (t) => Math.max(0, t.establishment - t.strength)],
      ['Minimum on duty', (t) => t.minStrength ?? '–'],
    ],
    fields: (t) => html`<div class="form-grid">
      <label class="span2">Team name<input name="name" value="${t?.name || ''}" required maxlength="100" /></label>
      <label>Establishment (posts)<input name="establishment" type="number" min="0" value="${t?.establishment ?? 0}" /></label>
      <label>Minimum on duty per day<input name="minStrength" type="number" min="0" value="${t?.minStrength ?? ''}" placeholder="none" /></label>
      <label>Display order<input name="sortOrder" type="number" value="${t?.sortOrder ?? state.meta.teams.length}" /></label>
      <p class="span2 muted">Vacant posts (establishment minus people in the team) are shown as empty rows on the plan.</p>
    </div>`,
    create: (v) => post('/teams', v),
    update: (t, v) => put(`/teams/${t.id}`, v),
    remove: (t) => del(`/teams/${t.id}`),
  });
}

function codes(body) {
  const chip = (c) => html`<span class="chip" style="background:${c.color};color:${contrast(c.color)}">${c.code}</span>`;
  return simpleCrud(body, {
    title: 'Duty codes',
    addLabel: 'Add code',
    rows: () => state.meta.dutyCodes,
    keyOf: (c) => c.code,
    columns: [
      ['Code', chip],
      ['Meaning', (c) => c.label],
      ['Type', (c) => c.category],
      ['Private', (c) => (c.private ? 'Yes' : '')],
      ['Order', (c) => c.sortOrder],
    ],
    fields: (c) => html`<div class="form-grid">
      <label>Code (as written in cells)<input name="code" value="${c?.code || ''}" ${c ? 'readonly' : ''} required maxlength="30" /></label>
      <label>Meaning<input name="label" value="${c?.label || ''}" required maxlength="100" /></label>
      <label>Type<select name="category">${state.meta.categories.map((k) => html`<option value="${k}" ${c?.category === k ? 'selected' : ''}>${k}</option>`)}</select></label>
      <label>Colour<input name="color" type="color" value="${c?.color || '#8ecae6'}" /></label>
      <label>Display order<input name="sortOrder" type="number" value="${c?.sortOrder ?? state.meta.dutyCodes.length}" /></label>
      <label class="check"><input type="checkbox" name="private" ${c?.private ? 'checked' : ''} /> Private (others see "unavailable")</label>
      <p class="span2 muted">Only "duty" codes count towards the number on duty. Private codes (e.g. sickness) are hidden from colleagues - only planners and the person can see them.</p>
    </div>`,
    create: (v, f) => post('/duty-codes', { ...v, private: f.private.checked }),
    update: (c, v, f) => put(`/duty-codes/${encodeURIComponent(c.code)}`, { ...v, private: f.private.checked }),
    remove: (c) => del(`/duty-codes/${encodeURIComponent(c.code)}`),
  });
}

function accreditations(body) {
  return simpleCrud(body, {
    title: 'Accreditations',
    addLabel: 'Add accreditation',
    rows: () => state.meta.accreditations,
    keyOf: (a) => a.id,
    columns: [
      ['Order', (a) => a.sortOrder],
      ['Short code', (a) => a.code],
      ['Name', (a) => a.name],
    ],
    fields: (a) => html`<div class="form-grid">
      <label>Short code (column header)<input name="code" value="${a?.code || ''}" required maxlength="30" /></label>
      <label>Full name<input name="name" value="${a?.name || ''}" maxlength="100" /></label>
      <label>Display order<input name="sortOrder" type="number" value="${a?.sortOrder ?? state.meta.accreditations.length}" /></label>
    </div>`,
    create: (v) => post('/accreditations', v),
    update: (a, v) => put(`/accreditations/${a.id}`, v),
    remove: (a) => del(`/accreditations/${a.id}`),
  });
}

// ---------------- Import / export ----------------
function importExport(body) {
  const today = todayIso();
  body.innerHTML = html`
    <div class="cards-2">
      <form class="card" data-form="import">
        <h2>Import spreadsheet</h2>
        <p class="muted">Upload the duty plan as <b>.xlsx</b> or <b>.csv</b>. Expected layout: a header row with <i>Staff No, Name, Initials, Mobile</i>
          (optionally <i>Team</i>), any number of accreditation columns, then one column per date. Teams can be a column or a heading row
          containing just the team name. Blank or "VACANT" rows inside a team count as vacant posts.</p>
        <label>File<input type="file" name="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" required /></label>
        <div class="form-grid">
          <label>Dates written as<select name="dateOrder"><option value="dmy">Day/Month/Year</option><option value="mdy">Month/Day/Year</option></select></label>
          <label>Mode<select name="mode"><option value="merge">Merge - update people and the dates in the file</option><option value="replace">Replace - remove all teams, people and plan first</option></select></label>
          <label class="check span2"><input type="checkbox" name="blankVacancies" checked /> Blank rows inside a team are vacant posts</label>
        </div>
        <button class="btn btn-primary" value="preview">Check file</button>
        <div class="import-result"></div>
      </form>
      <form class="card" data-form="export">
        <h2>Export to Excel</h2>
        <p class="muted">Download the plan in the same layout, with duty colours, accreditations and vacant posts.</p>
        <div class="form-grid">
          <label>From<input type="date" name="from" value="${today}" required /></label>
          <label>To<input type="date" name="to" value="${addDays(today, 90)}" required /></label>
        </div>
        <button class="btn btn-primary">Download .xlsx</button>
      </form>
    </div>`;

  const imp = $('[data-form=import]', body);
  let file = null;
  const send = async (dryRun) => {
    const f = imp.file.files[0];
    if (!f) throw new Error('Choose a file');
    file = f;
    const qs = new URLSearchParams({ dryRun: dryRun ? '1' : '0', mode: imp.mode.value, dateOrder: imp.dateOrder.value, blankVacancies: imp.blankVacancies.checked ? '1' : '0' });
    return api(`/import?${qs}`, { method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name) } });
  };
  imp.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = $('.import-result', imp);
    out.innerHTML = '<p class="muted">Reading…</p>';
    try {
      const { preview } = await send(true);
      out.innerHTML = html`
        <h3>Preview</h3>
        <ul>
          <li>${preview.people} people in ${preview.teams.length} teams</li>
          <li>${preview.dates ? html`${preview.dates.count} days: ${preview.dates.from} to ${preview.dates.to}` : 'No date columns found'}</li>
          <li>Accreditation columns: ${preview.accreditations.join(', ') || 'none'}</li>
        </ul>
        <table class="data"><thead><tr><th>Team</th><th>People</th><th>Vacant</th></tr></thead>
        <tbody>${preview.teams.map((t) => html`<tr><td>${t.name}</td><td>${t.people}</td><td>${t.vacancies}</td></tr>`)}</tbody></table>
        ${preview.warnings.length ? html`<details open><summary>${preview.warnings.length} warning(s)</summary><ul class="warn">${preview.warnings.map((w) => html`<li>${w}</li>`)}</ul></details>` : ''}
        <button type="button" class="btn btn-primary" data-act="commit">Import now (${imp.mode.value})</button>`;
    } catch (ex) {
      out.innerHTML = html`<p class="error">${ex.message}</p>`;
    }
  });
  imp.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-act=commit]')) return;
    if (imp.mode.value === 'replace' && !(await confirmDialog('Replace mode deletes ALL existing teams, people and planned duties before importing. Continue?', 'Replace everything', true))) return;
    if (imp.file.files[0] !== file) return toast('File changed - check it again first', 'warn');
    try {
      const { summary } = await send(false);
      await refreshMeta();
      $('.import-result', imp).innerHTML = html`<p class="success">Imported: ${summary.peopleCreated} people added, ${summary.peopleUpdated} updated, ${summary.assignments} duties,
        ${summary.vacancies} vacancies across ${summary.teams} teams.${summary.newDutyCodes.length ? html` New duty codes: ${summary.newDutyCodes.join(', ')} - set their colours under Duty codes.` : ''}</p>`;
      toast('Import complete', 'success');
    } catch (ex) {
      toast(ex.message, 'error');
    }
  });
  $('[data-form=export]', body).addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    download(`/export.xlsx?from=${f.from.value}&to=${f.to.value}`);
  });
}

// ---------------- Users ----------------
async function users(body) {
  const [{ users: list }, { people: ppl }] = await Promise.all([get('/users'), get('/people')]);
  const personOptions = (sel) =>
    html`<option value="">Not linked</option>${ppl.map((p) => html`<option value="${p.id}" ${sel === p.id ? 'selected' : ''}>${p.name} (${p.staffNumber})</option>`)}`;
  const unlinked = ppl.filter((p) => p.active && !p.username).length;
  body.innerHTML = html`
    <div class="toolbar"><h2>User accounts</h2><span class="spacer"></span>
      <button class="btn" data-act="bulk">Create logins for everyone (${unlinked})</button>
      <button class="btn" data-act="import">Import users</button>
      <button class="btn btn-primary" data-act="add">Add user</button></div>
    <p class="muted">People sign in with their email address or staff number. To add many new people at once, use <b>Import users</b> with the template. Planners can edit the plan; admins can also manage accounts. Linking an account to a person shows them "My duties".</p>
    <div class="table-wrap"><table class="data"><thead><tr><th>Username</th><th>Role</th><th>Person</th><th>Status</th><th></th></tr></thead>
    <tbody>${list.map(
      (u) => html`<tr><td>${u.username}</td><td>${u.role}</td><td>${u.personName || html`<span class="muted">–</span>`}</td>
        <td>${u.mustChangePassword ? 'Must change password' : 'Active'}</td><td class="actions"><button class="btn btn-sm" data-edit="${u.id}">Edit</button></td></tr>`,
    )}</tbody></table></div>`;
  const reload = () => users(body);
  const roleSel = (r) => html`<select name="role">${['staff', 'planner', 'admin'].map((k) => html`<option ${r === k ? 'selected' : ''}>${k}</option>`)}</select>`;
  body.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const id = e.target.closest('[data-edit]')?.dataset.edit;
    if (act === 'import') return importUsers(reload);
    if (act === 'add')
      formDialog(
        'Add user',
        html`<div class="form-grid">
          <label>Username<input name="username" required maxlength="100" /></label>
          <label>Role${roleSel('staff')}</label>
          <label class="span2">Linked person<select name="personId">${personOptions(null)}</select></label>
          <label class="span2">Temporary password<input name="password" type="text" minlength="8" required autocomplete="off" /></label>
          <p class="span2 muted">They will be asked to change it at first sign-in.</p></div>`,
        async (v) => {
          await post('/users', { ...v, personId: v.personId || null });
          reload();
        },
      );
    else if (act === 'bulk')
      formDialog(
        'Create staff logins',
        html`<p>Creates a <b>staff</b> login for each of the ${unlinked} active people without one. Their username is their staff number.</p>
          <label>Temporary password for all<input name="password" type="text" minlength="8" required autocomplete="off" /></label>
          <p class="muted">Everyone must change it at first sign-in. Share it securely.</p>`,
        async (v) => {
          const r = await post('/users/bulk', v);
          toast(`Created ${r.created} logins${r.skipped.length ? `; ${r.skipped.length} skipped (username taken)` : ''}`, 'success');
          reload();
        },
      );
    else if (id) {
      const u = list.find((x) => x.id === Number(id));
      const d = formDialog(
        `Edit ${u.username}`,
        html`<div class="form-grid">
          <label>Role${roleSel(u.role)}</label>
          <label>Linked person<select name="personId">${personOptions(u.personId)}</select></label>
          <label class="span2">Reset password <small class="muted">(leave blank to keep)</small><input name="password" type="text" minlength="8" autocomplete="off" /></label></div>`,
        async (v) => {
          await put(`/users/${u.id}`, { ...v, personId: v.personId || null, password: v.password || undefined });
          reload();
        },
        { extraActions: '<button value="delete" class="btn btn-danger" formnovalidate>Delete</button>' },
      );
      $('form', d).addEventListener('submit', async (ev) => {
        if (ev.submitter?.value !== 'delete') return;
        ev.preventDefault();
        if (!(await confirmDialog(`Delete the login "${u.username}"?`, 'Delete', true))) return;
        try {
          await del(`/users/${u.id}`);
          d.close();
          reload();
        } catch (ex) {
          toast(ex.message, 'error');
        }
      });
    }
  };
}

// ---------------- Bulk user import ----------------
function importUsers(onDone) {
  const d = dialog(
    'Import users',
    html`<div class="import-users">
      <section class="step">
        <h3><span class="step-n">1</span> Download the template</h3>
        <p class="muted">One row per person. Email and name are required; it also has staff number, initials, mobile, team, position in team, job title,
          start date, app role and a column for each accreditation. The Excel version has dropdowns and an instructions sheet.</p>
        <div class="row-btns">
          <button type="button" class="btn" data-dl="xlsx">Excel template (.xlsx)</button>
          <button type="button" class="btn" data-dl="csv">CSV template (.csv)</button>
        </div>
      </section>
      <section class="step">
        <h3><span class="step-n">2</span> Upload the completed file</h3>
        <label>Completed template<input type="file" name="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" /></label>
        <div class="form-grid">
          <label>Role if "App role" is blank<select name="defaultRole"><option>staff</option><option>planner</option><option>admin</option></select></label>
          <label>Dates written as<select name="dateOrder"><option value="dmy">Day/Month/Year</option><option value="mdy">Month/Day/Year</option></select></label>
          <label class="span2">Temporary password <small class="muted">(optional - leave blank to generate a different one for each person)</small>
            <input name="tempPassword" type="text" minlength="8" autocomplete="off" placeholder="Generate one per person" /></label>
          <label class="check span2"><input type="checkbox" name="createTeams" checked /> Create teams that don't exist yet</label>
          <label class="check span2"><input type="checkbox" name="updateExisting" checked /> Update people who are already in the app (matched on email, then staff number)</label>
        </div>
        <div class="row-btns"><button type="button" class="btn btn-primary" data-act="check">Check file</button></div>
      </section>
      <section class="step" data-step="3" hidden></section>
    </div>`,
    { wide: true },
  );
  const f = $('form', d);
  const step3 = $('[data-step="3"]', d);
  let checkedFile = null;
  const send = (dryRun) => {
    const file = f.file.files[0];
    if (!file) throw new Error('Choose the completed template first');
    const pw = f.tempPassword.value.trim();
    if (pw && pw.length < 8) throw new Error('Temporary password must be at least 8 characters');
    const qs = new URLSearchParams({
      dryRun: dryRun ? '1' : '0',
      createTeams: f.createTeams.checked ? '1' : '0',
      updateExisting: f.updateExisting.checked ? '1' : '0',
      defaultRole: f.defaultRole.value,
      dateOrder: f.dateOrder.value,
    });
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (pw) headers['X-Temp-Password'] = pw;
    return api(`/users/import?${qs}`, { method: 'POST', body: file, headers });
  };
  const badge = (a) => html`<span class="badge badge-${a}">${{ create: 'New', update: 'Update', skip: 'Skip', error: 'Error' }[a]}</span>`;

  d.addEventListener('click', async (e) => {
    const dl = e.target.closest('[data-dl]')?.dataset.dl;
    if (dl) return download(`/users/template.${dl}`);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'check') {
      step3.hidden = false;
      step3.innerHTML = '<p class="muted">Checking…</p>';
      try {
        const { preview: p } = await send(true);
        checkedFile = f.file.files[0];
        requestAnimationFrame(() => step3.scrollIntoView({ block: 'start', behavior: 'smooth' }));
        const ok = p.counts.create + p.counts.update;
        step3.innerHTML = html`
          <h3><span class="step-n">3</span> Check and import</h3>
          <div class="chips">
            <span>${badge('create')} ${p.counts.create} new</span>
            <span>${badge('update')} ${p.counts.update} to update</span>
            ${p.counts.skip ? html`<span>${badge('skip')} ${p.counts.skip} skipped</span>` : ''}
            ${p.counts.error ? html`<span>${badge('error')} ${p.counts.error} with problems (not imported)</span>` : ''}
          </div>
          ${p.newTeams.length ? html`<p>New teams to be created: <b>${p.newTeams.join(', ')}</b></p>` : ''}
          ${p.warnings.length ? html`<ul class="warn">${p.warnings.map((w) => html`<li>${w}</li>`)}</ul>` : ''}
          <div class="table-wrap preview-table"><table class="data">
            <thead><tr><th>Row</th><th></th><th>Email</th><th>Name</th><th>Team</th><th>Role</th><th>Problems</th></tr></thead>
            <tbody>${p.rows.map(
              (r) => html`<tr class="${r.action === 'error' ? 'row-error' : ''}"><td>${r.line}</td><td>${badge(r.action)}</td><td>${r.email}</td><td>${r.name}</td>
                <td>${r.team || '–'}</td><td>${r.role}</td><td class="details">${r.errors.join('; ')}</td></tr>`,
            )}</tbody></table></div>
          <div class="row-btns">
            <button type="button" class="btn btn-primary" data-act="commit" ${ok ? '' : 'disabled'}>Import ${ok} ${ok === 1 ? 'person' : 'people'}</button>
            ${p.counts.error ? html`<span class="muted">Fix the rows marked Error in your file and check it again, or import the rest now.</span>` : ''}
          </div>`;
      } catch (ex) {
        step3.innerHTML = html`<p class="error">${ex.message}</p>`;
      }
    } else if (act === 'commit') {
      if (f.file.files[0] !== checkedFile) return toast('The file changed - check it again first', 'warn');
      e.target.disabled = true;
      try {
        const { summary: s } = await send(false);
        await refreshMeta();
        const tsv = ['Email\tName\tTemporary password', ...s.credentials.map((c) => `${c.email}\t${c.name}\t${c.password}`)].join('\n');
        step3.innerHTML = html`
          <h3>Import complete</h3>
          <p class="success">${s.created} people added, ${s.updated} updated, ${s.accountsCreated} new sign-in accounts${s.skipped ? `, ${s.skipped} ${s.skipped === 1 ? 'row' : 'rows'} skipped` : ''}.
            ${s.teamsCreated.length ? html`New teams: ${s.teamsCreated.join(', ')}.` : ''}</p>
          ${s.credentials.length
            ? html`<p><b>Temporary passwords</b> - copy these now and share them securely; they won't be shown again. Everyone signs in with their email address
                and must choose a new password straight away.</p>
              <div class="table-wrap preview-table"><table class="data"><thead><tr><th>Email</th><th>Name</th><th>Temporary password</th></tr></thead>
              <tbody>${s.credentials.map((c) => html`<tr><td>${c.email}</td><td>${c.name}</td><td><code>${c.password}</code></td></tr>`)}</tbody></table></div>
              <div class="row-btns"><button type="button" class="btn" data-act="copy">Copy list (paste into Excel)</button></div>
              <textarea class="copy-src" readonly hidden>${tsv}</textarea>`
            : s.accountsCreated
              ? html`<p>New accounts use the temporary password you entered. People sign in with their email address and must change it straight away.</p>`
              : ''}`;
        step3.scrollIntoView({ block: 'start', behavior: 'smooth' });
        onDone();
      } catch (ex) {
        e.target.disabled = false;
        toast(ex.message, 'error');
      }
    } else if (act === 'copy') {
      const ta = $('.copy-src', d);
      try {
        await navigator.clipboard.writeText(ta.value);
        toast('Copied', 'success');
      } catch {
        ta.hidden = false;
        ta.select();
        toast('Press Ctrl+C to copy', 'warn');
      }
    }
  });
  f.addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'cancel') e.preventDefault();
  });
}

// ---------------- Audit ----------------
async function audit(body) {
  const { entries } = await get('/audit?limit=500');
  const summary = (e) => {
    const d = e.details;
    if (!d) return '';
    if (e.action === 'assignments.update') return `${d.count} cell(s) ${d.from}${d.to !== d.from ? ` to ${d.to}` : ''}`;
    if (e.action === 'assignments.pattern') return `${d.personIds.length} people, ${d.from} to ${d.to}: ${d.pattern.map((x) => x || '-').join(' ')}`;
    if (e.action === 'user.import') return `${d.created} added, ${d.updated} updated, ${d.accountsCreated} accounts`;
    if (e.action === 'import') return `${d.mode}: ${d.peopleCreated} added, ${d.peopleUpdated} updated, ${d.assignments} duties`;
    return JSON.stringify(d).slice(0, 160);
  };
  body.innerHTML = html`<div class="toolbar"><h2>Activity log</h2></div>
    <div class="table-wrap"><table class="data"><thead><tr><th>When (UTC)</th><th>User</th><th>Action</th><th>Details</th></tr></thead>
    <tbody>${entries.map((e) => html`<tr><td>${e.at}</td><td>${e.username || '–'}</td><td>${e.action}</td><td class="details">${summary(e)}</td></tr>`)}</tbody></table></div>`;
}
