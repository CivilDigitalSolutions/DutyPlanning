// Annual leave: request -> line manager approves -> leave administrator adds it to the roster.
import { get, post } from '../api.js';
import { state, codeInfo } from '../state.js';
import { $, html, toast, dialog, fmtDate, todayIso, addDays, contrast, debounce, dayNum } from '../util.js';

const STATUS = {
  pending: ['Awaiting approval', 'pending'],
  approved: ['Approved - to add to roster', 'approved'],
  applied: ['On the roster', 'applied'],
  cancel_requested: ['Cancellation requested', 'pending'],
  rejected: ['Not approved', 'rejected'],
  cancelled: ['Cancelled', 'cancelled'],
};
const pill = (s) => html`<span class="status status-${STATUS[s]?.[1] || s}">${STATUS[s]?.[0] || s}</span>`;
const chip = (code) => {
  if (!code) return html`<span class="chip empty">·</span>`;
  const info = codeInfo(code);
  return html`<span class="chip" style="background:${info.color};color:${contrast(info.color)}">${code === '*' ? '–' : code}</span>`;
};
const range = (r) => (r.start === r.end ? fmtDate(r.start, 'dmy') : `${fmtDate(r.start, 'dm')} – ${fmtDate(r.end, 'dmy')}`);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const ACTION_LABEL = {
  approve: 'Approve',
  reject: 'Reject',
  apply: 'Add to roster',
  decline: 'Decline',
  cancel: 'Cancel request',
  requestCancel: 'Ask to cancel',
  remove: 'Remove from roster',
  keep: 'Keep leave',
};
const DANGER = new Set(['reject', 'decline', 'cancel', 'remove']);
const EVENT_LABEL = {
  requested: 'Requested',
  approve: 'Approved',
  reject: 'Rejected',
  apply: 'Added to roster',
  decline: 'Declined by leave administrator',
  cancel: 'Cancelled',
  requestCancel: 'Asked to cancel',
  remove: 'Removed from roster',
  keep: 'Cancellation refused - leave kept',
};

export async function render(root, params) {
  const sum = await get('/leave/summary');
  const me = state.user;
  const tabs = [
    ...(me.person ? [['mine', 'My leave']] : []),
    ...(sum.isManager || sum.administers || me.role === 'admin' ? [['approve', 'To approve', sum.toApprove]] : []),
    ...(sum.administers || sum.canRosterLockdown ? [['apply', 'To add to roster', sum.toApply]] : []),
    ...(me.role === 'planner' || sum.administers ? [['all', 'All requests']] : []),
  ];
  if (!tabs.length) {
    root.innerHTML = '<div class="empty">Your account is not linked to anyone on the plan, so you cannot request leave. Ask an administrator to link it.</div>';
    return;
  }
  const tab = tabs.find(([k]) => k === params[0])?.[0] || (sum.toApprove && !me.person ? 'approve' : tabs[0][0]);
  root.innerHTML = html`
    <section class="leave">
      <nav class="subtabs" aria-label="Leave">
        ${tabs.map(([k, l, n]) => html`<a href="#/leave/${k}" class="${k === tab ? 'active' : ''}">${l}${n ? html` <span class="count">${n}</span>` : ''}</a>`)}
      </nav>
      <div class="leave-body"></div>
    </section>`;
  const body = $('.leave-body', root);
  const views = { mine, approve, apply, all };
  const refresh = () => views[tab](body, sum, refresh);
  await refresh();
  if (params[1]) openRequest(Number(params[1]), refresh);

  const onChanged = (e) => {
    if (e.detail.type === 'leave') refresh();
  };
  window.addEventListener('dp:changed', onChanged);
  return () => window.removeEventListener('dp:changed', onChanged);
}

// ---------- shared list rendering ----------
const actionsOf = (r) => Object.entries(r.actions).filter(([k, v]) => v && k in ACTION_LABEL).map(([k]) => k);

function lockdownNote(r) {
  if (!r.lockdowns?.length) return '';
  const names = r.lockdowns.map((l) => l.name).join(', ');
  return html`<div class="lock-note">🔒 In leave lockdown: <b>${names}</b>${
    r.actions.needsSupervisor
      ? html` - <span>needs a supervisor or planner to add it to the roster</span>`
      : r.status === 'pending' || r.status === 'approved'
        ? html` - only a supervisor or planner can add it to the roster`
        : ''
  }</div>`;
}
function requestCard(r, { showPerson = true } = {}) {
  const acts = actionsOf(r);
  return html`<li class="req card" data-id="${r.id}">
    <div class="req-main">
      <div class="req-top">
        ${showPerson ? html`<strong>${r.personName}</strong><span class="muted">${r.teamName || 'No team'}</span>` : ''}
        ${pill(r.status)}
      </div>
      <div class="req-dates"><b>${range(r)}</b> · ${chip(r.type)} ${r.typeLabel || r.type} · ${plural(r.days, 'working day')}</div>
      ${r.note ? html`<div class="muted req-note">"${r.note}"</div>` : ''}
      ${r.decisionNote && (r.status === 'rejected' || r.status === 'approved' || r.status === 'applied') ? html`<div class="req-note"><span class="muted">${r.decidedBy || 'Manager'}:</span> ${r.decisionNote}</div>` : ''}
      ${lockdownNote(r)}
      ${r.status === 'pending' ? html`<div class="muted small">${r.managerName ? `With ${r.managerName} for approval` : 'No line manager set - an administrator will approve'}</div>` : ''}
    </div>
    <div class="req-actions">
      ${acts.map((a) => html`<button type="button" class="btn btn-sm ${a === 'approve' || a === 'apply' ? 'btn-primary' : DANGER.has(a) ? 'btn-danger' : ''}" data-act="${a}">${ACTION_LABEL[a]}</button>`)}
      <button type="button" class="btn btn-sm btn-ghost" data-act="open">Details</button>
    </div>
  </li>`;
}

function bindList(el, list, refresh) {
  el.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    const li = e.target.closest('[data-id]');
    if (!b || !li) return;
    const r = list.find((x) => x.id === Number(li.dataset.id));
    if (b.dataset.act === 'open') openRequest(r.id, refresh);
    else act(r, b.dataset.act, refresh);
  };
}

// ---------- actions ----------
async function act(r, action, refresh) {
  if (action === 'apply') return applyDialog(r, refresh);
  const needsReason = action === 'reject' || action === 'decline';
  const confirmText = {
    approve: `Approve ${r.personName}'s leave, ${range(r)} (${plural(r.days, 'working day')})? It then goes to the leave administrators to add to the roster.`,
    reject: `Reject ${r.personName}'s leave, ${range(r)}?`,
    decline: `Decline ${r.personName}'s approved leave, ${range(r)}? It will not be added to the roster.`,
    cancel: `Cancel your leave request for ${range(r)}?`,
    requestCancel: `Ask the leave administrators to take your leave for ${range(r)} off the roster?`,
    remove: `Remove ${r.personName}'s leave for ${range(r)} from the roster? Their original duties are put back.`,
    keep: `Refuse the cancellation and keep ${r.personName}'s leave on the roster?`,
  }[action];
  const d = dialog(
    ACTION_LABEL[action],
    html`<p>${confirmText}</p>
      <label>${needsReason ? 'Reason (shown to the person)' : 'Note (optional)'}<textarea name="note" rows="2" maxlength="500" ${needsReason ? 'required' : ''}></textarea></label>`,
    { actions: `<button value="cancel" class="btn" formnovalidate>Back</button><button value="ok" class="btn ${DANGER.has(action) ? 'btn-danger' : 'btn-primary'}">${ACTION_LABEL[action]}</button>` },
  );
  $('form', d).addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    try {
      await post(`/leave/${r.id}/${action}`, { note: e.target.note.value });
      d.close();
      toast(`${ACTION_LABEL[action]}: done`, 'success');
      refresh();
    } catch (ex) {
      toast(ex.message, 'error');
    }
  });
}

// What each day becomes when leave is added (mirrors leavePlan in server/leave-rules.js).
function planCode(d, code) {
  const has = (c) => state.codeMap.has(c.toLowerCase());
  if (d.category === 'leave' && !/^(PH|RD)-/i.test(d.code || '')) return null;
  if (d.publicHoliday) return has(`PH-${code}`) ? `PH-${code}` : code;
  if (d.working) return code;
  return has(`RD-${code}`) ? `RD-${code}` : null;
}

function breakdownTable(days, { applyCode = null } = {}) {
  return html`<div class="table-wrap day-table"><table class="data">
    <thead><tr><th>Day</th><th>Rostered</th>${applyCode ? html`<th>Becomes</th>` : ''}<th>Team on duty after</th></tr></thead>
    <tbody>${days.map((d) => {
      const becomes = applyCode ? planCode(d, applyCode) : null;
      return html`<tr class="${d.coverLow ? 'row-error' : ''} ${d.working ? '' : 'muted'}">
        <td>${fmtDate(d.date, 'dow')} ${fmtDate(d.date, 'dm')}${d.publicHoliday ? html`<div class="ph-name">${d.publicHoliday}</div>` : ''}${d.lockdown ? html`<div class="lock-name">🔒 ${d.lockdown}</div>` : ''}</td>
        <td>${chip(d.code)} ${d.working ? '' : html`<small>${d.publicHoliday ? 'public holiday - not counted' : 'not counted'}</small>`}</td>
        ${applyCode ? html`<td>${becomes ? html`${chip(becomes)} <small>${codeInfo(becomes).label}</small>` : html`<small class="muted">unchanged</small>`}</td>` : ''}
        <td>${d.teamOnDuty == null ? '–' : d.category === 'duty' ? html`${d.teamAfter}${d.coverLow ? html` <b class="error">below minimum</b>` : ''}` : d.teamOnDuty}</td>
      </tr>`;
    })}</tbody></table></div>`;
}

async function openRequest(id, refresh) {
  let data;
  try {
    data = await get(`/leave/${id}`);
  } catch (e) {
    return toast(e.message, 'error');
  }
  const r = data.request;
  const acts = actionsOf(r);
  const d = dialog(
    `${r.personName}: ${range(r)}`,
    html`<div class="req-detail">
      <div class="req-top">${pill(r.status)} <span>${chip(r.type)} ${r.typeLabel || r.type}</span> <span>${plural(r.days, 'working day')}</span></div>
      ${lockdownNote(r)}
      <dl class="kv">
        <dt>Team</dt><dd>${r.teamName || '–'}</dd>
        <dt>Line manager</dt><dd>${r.managerName || 'None set'}</dd>
        ${r.note ? html`<dt>Note</dt><dd>${r.note}</dd>` : ''}
      </dl>
      ${data.coverWarnings ? html`<p class="error">Team would be below its minimum on ${plural(data.coverWarnings, 'day')}.</p>` : ''}
      ${breakdownTable(data.days)}
      <h3>History</h3>
      <ol class="timeline">${data.events.map(
        (e) => html`<li><b>${EVENT_LABEL[e.action] || e.action}</b> by ${e.username || 'unknown'} <span class="muted">${e.at.replace('T', ' ').slice(0, 16)} UTC</span>${e.note ? html`<div>"${e.note}"</div>` : ''}</li>`,
      )}</ol>
    </div>`,
    {
      wide: true,
      actions: `${acts.map((a) => `<button type="button" class="btn ${a === 'approve' || a === 'apply' ? 'btn-primary' : DANGER.has(a) ? 'btn-danger' : ''}" data-act="${a}">${ACTION_LABEL[a]}</button>`).join('')}<span class="spacer"></span><button value="cancel" class="btn" formnovalidate>Close</button>`,
    },
  );
  d.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (!a) return;
    d.close();
    act(r, a, refresh);
  });
}

async function applyDialog(r, refresh) {
  const data = await get(`/leave/${r.id}`);
  const codes = state.meta.dutyCodes.filter((c) => c.category === 'leave' && !c.private);
  const d = dialog(
    `Add leave to roster: ${r.personName}`,
    html`<p>${range(r)} · approved${r.decidedBy ? ` by ${r.decidedBy}` : ''}. Working days get the leave code, rest days show as <b>Rest Day - AL</b> and
      public holidays as <b>Public holiday - AL</b>. Existing leave such as sickness is left alone. The days it replaces are remembered, so removing the
      leave later puts them back.</p>
      <div class="form-grid">
        <label>Code to put on the roster<select name="code">${codes.map((c) => html`<option value="${c.code}" ${c.code === r.type ? 'selected' : ''}>${c.code} - ${c.label}</option>`)}</select></label>
      </div>
      ${data.coverWarnings ? html`<p class="error">Team would be below its minimum on ${plural(data.coverWarnings, 'day')}.</p>` : ''}
      <div class="apply-preview"></div>`,
    { wide: true, actions: '<button value="cancel" class="btn" formnovalidate>Cancel</button><button value="ok" class="btn btn-primary">Add to roster</button>' },
  );
  const f = $('form', d);
  const draw = () => {
    $('.apply-preview', d).innerHTML = breakdownTable(data.days, { applyCode: f.code.value });
  };
  f.addEventListener('change', draw);
  draw();
  f.addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    try {
      await post(`/leave/${r.id}/apply`, { code: f.code.value });
      d.close();
      toast('Leave added to the roster', 'success');
      refresh();
    } catch (ex) {
      toast(ex.message, 'error');
    }
  });
}

function requestDialog(sum, refresh) {
  const types = sum.leaveTypes.length ? sum.leaveTypes : [{ code: 'AL', label: 'Annual leave' }];
  const start = addDays(todayIso(), 7);
  const d = dialog(
    'Request leave',
    html`<div class="form-grid">
      <label>Type<select name="type">${types.map((t) => html`<option value="${t.code}">${t.label}</option>`)}</select></label>
      <span></span>
      <label>First day<input type="date" name="start" value="${start}" required /></label>
      <label>Last day<input type="date" name="end" value="${start}" required /></label>
      <label class="span2">Note for your manager (optional)<textarea name="note" rows="2" maxlength="500"></textarea></label>
      <div class="span2 leave-preview muted">Checking your roster…</div>
    </div>`,
    { wide: true, actions: '<button value="cancel" class="btn" formnovalidate>Cancel</button><button value="ok" class="btn btn-primary">Send request</button>' },
  );
  const f = $('form', d);
  const box = $('.leave-preview', d);
  const preview = debounce(async () => {
    if (f.end.value && f.start.value && f.end.value < f.start.value) f.end.value = f.start.value;
    try {
      const p = await get(`/leave/preview?start=${f.start.value}&end=${f.end.value}`);
      const manager = state.user.person?.lineManagerId;
      box.innerHTML = html`
        <p>This covers <b>${plural(p.workingDays, 'working day')}</b> on your roster.</p>
        <div class="mini-days">${p.days.map((x) => html`<div class="mini-day ${x.working ? '' : 'off'} ${x.publicHoliday ? 'ph' : ''}" title="${x.publicHoliday || ''}"><small>${x.publicHoliday ? 'Hol' : fmtDate(x.date, 'dow')}</small><b>${dayNum(x.date)}</b>${chip(x.code)}</div>`)}</div>
        ${p.days.some((x) => x.publicHoliday)
          ? html`<p class="small">Public holidays in this period (not counted): ${p.days.filter((x) => x.publicHoliday).map((x) => `${fmtDate(x.date, 'dm')} ${x.publicHoliday}`).join(', ')}.</p>`
          : ''}
        ${p.lockdowns?.length
          ? html`<div class="lock-box"><b>🔒 Leave lockdown:</b> ${p.lockdowns.map((l) => `${l.name} (${range(l)})`).join('; ')}.
              Your manager can still approve this, but only a supervisor or planner can add it to the roster.</div>`
          : ''}
        ${p.overlaps.length ? html`<p class="error">This overlaps your request for ${p.overlaps.map(range).join(', ')}.</p>` : ''}
        ${p.coverWarnings ? html`<p class="warn-text">Your team would be below its minimum on ${plural(p.coverWarnings, 'day')} - your manager will see this.</p>` : ''}
        <p class="small">${manager ? 'This goes to your line manager to approve.' : 'You have no line manager set, so an administrator will approve it.'}</p>`;
    } catch (e) {
      box.innerHTML = html`<p class="error">${e.message}</p>`;
    }
  }, 250);
  f.addEventListener('input', preview);
  preview();
  f.addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    try {
      await post('/leave', { type: f.type.value, start: f.start.value, end: f.end.value, note: f.note.value });
      d.close();
      toast(state.user.person?.lineManagerId ? 'Leave requested - sent to your line manager to approve' : 'Leave requested - sent to an administrator to approve', 'success');
      refresh();
    } catch (ex) {
      toast(ex.message, 'error');
    }
  });
}

// ---------- tabs ----------
async function mine(body, sum, refresh) {
  const { requests } = await get('/leave?scope=mine');
  const upcoming = requests.filter((r) => r.end >= todayIso() && !['rejected', 'cancelled'].includes(r.status));
  const past = requests.filter((r) => !upcoming.includes(r));
  body.innerHTML = html`
    <div class="toolbar"><h2>My leave</h2><span class="spacer"></span><button class="btn btn-primary" data-act="new">Request leave</button></div>
    <h3>Current and upcoming</h3>
    ${upcoming.length ? html`<ul class="req-list" data-list="up">${upcoming.map((r) => requestCard(r, { showPerson: false }))}</ul>` : html`<p class="muted">No leave booked. Use <b>Request leave</b> to ask for time off.</p>`}
    ${past.length ? html`<details><summary>Past, cancelled and rejected (${past.length})</summary><ul class="req-list" data-list="past">${past.map((r) => requestCard(r, { showPerson: false }))}</ul></details>` : ''}`;
  $('[data-act=new]', body).onclick = () => requestDialog(sum, refresh);
  body.querySelectorAll('.req-list').forEach((el) => bindList(el, requests, refresh));
}

async function approve(body, sum, refresh) {
  const { requests } = await get('/leave?scope=approve');
  const pending = requests.filter((r) => r.status === 'pending');
  const others = requests.filter((r) => r.status !== 'pending').slice(0, 50);
  body.innerHTML = html`
    <div class="toolbar"><h2>Leave to approve</h2></div>
    <p class="muted">Requests from people you line manage${sum.administers || state.user.role === 'admin' ? ', and from people with no line manager set' : ''}. Approved leave goes to the leave administrators, who add it to the roster.</p>
    ${pending.length ? html`<ul class="req-list" data-list="p">${pending.map((r) => requestCard(r))}</ul>` : html`<p class="empty-inline">Nothing waiting for you.</p>`}
    ${others.length ? html`<h3>Recent decisions</h3><ul class="req-list" data-list="o">${others.map((r) => requestCard(r))}</ul>` : ''}`;
  body.querySelectorAll('.req-list').forEach((el) => bindList(el, requests, refresh));
}

async function apply(body, sum, refresh) {
  const { requests } = await get('/leave?scope=apply');
  const approved = requests.filter((r) => r.status === 'approved');
  const cancels = requests.filter((r) => r.status === 'cancel_requested');
  const applied = requests.filter((r) => r.status === 'applied' && r.end >= addDays(todayIso(), -30)).slice(0, 50);
  body.innerHTML = html`
    <div class="toolbar"><h2>Approved leave to add to the roster</h2></div>
    ${approved.length ? html`<ul class="req-list" data-list="a">${approved.map((r) => requestCard(r))}</ul>` : html`<p class="empty-inline">No approved leave waiting.</p>`}
    ${cancels.length ? html`<h3>Cancellations to process</h3><ul class="req-list" data-list="c">${cancels.map((r) => requestCard(r))}</ul>` : ''}
    ${applied.length ? html`<h3>Recently added to the roster</h3><ul class="req-list" data-list="d">${applied.map((r) => requestCard(r))}</ul>` : ''}`;
  body.querySelectorAll('.req-list').forEach((el) => bindList(el, requests, refresh));
}

async function all(body, sum, refresh) {
  let status = '';
  let q = '';
  body.innerHTML = html`
    <div class="toolbar"><h2>All leave requests</h2><span class="spacer"></span>
      <input type="search" placeholder="Search name" data-f="q" />
      <select data-f="status"><option value="">Any status</option>${Object.entries(STATUS).map(([k, [l]]) => html`<option value="${k}">${l}</option>`)}</select>
    </div>
    <div class="table-wrap"><table class="data"><thead><tr><th>Person</th><th>Team</th><th>Dates</th><th>Days</th><th>Type</th><th>Status</th><th>Manager</th><th></th></tr></thead><tbody></tbody></table></div>`;
  let list = [];
  const draw = () => {
    const rows = list.filter((r) => !q || r.personName.toLowerCase().includes(q));
    body.querySelector('tbody').innerHTML = rows.length
      ? html`${rows.map(
          (r) => html`<tr data-id="${r.id}"><td>${r.personName}</td><td>${r.teamName || '–'}</td><td>${range(r)}</td><td>${r.days}</td><td>${chip(r.type)}</td><td>${pill(r.status)}</td>
            <td>${r.managerName || html`<span class="muted">–</span>`}</td><td class="actions"><button class="btn btn-sm" data-act="open">Details</button></td></tr>`,
        )}`
      : '<tr><td colspan="8" class="empty">No requests</td></tr>';
  };
  const load = async () => {
    list = (await get(`/leave?scope=all${status ? `&status=${status}` : ''}`)).requests;
    draw();
  };
  body.onchange = (e) => {
    if (e.target.dataset.f === 'status') {
      status = e.target.value;
      load();
    }
  };
  body.oninput = (e) => {
    if (e.target.dataset.f === 'q') {
      q = e.target.value.toLowerCase();
      draw();
    }
  };
  body.onclick = (e) => {
    const tr = e.target.closest('[data-id]');
    if (tr && e.target.closest('[data-act=open]')) openRequest(Number(tr.dataset.id), refresh);
  };
  await load();
}
