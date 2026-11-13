// Annual leave: request -> line manager approves -> leave administrator adds it to the roster.
import { get, post } from '../api.js';
import { state, codeInfo } from '../state.js';
import { $, html, toast, dialog, fmtDate, todayIso, addDays, contrast, debounce, store } from '../util.js';
import { AVAILABLE_FOR_COURT_MAX_DAYS, WEEKDAYS, formDate, formWeeks, normaliseApplicantForm, trainingCoursesIn } from '../shared/leave-form.js';

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
      ? html` - <span>needs a planner supervisor to add it to the roster</span>`
      : r.status === 'pending' || r.status === 'approved'
        ? html` - only a planner supervisor can add it to the roster`
        : ''
  }</div>`;
}
function requestCard(r, { showPerson = true, meta = '' } = {}) {
  const acts = actionsOf(r);
  return html`<li class="req card" data-id="${r.id}">
    <div class="req-main">
      ${meta}
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
      <button type="button" class="btn btn-sm btn-ghost" data-act="form">View form</button>
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
    else if (b.dataset.act === 'form') openForm(r.id);
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
      actions: `${acts.map((a) => `<button type="button" class="btn ${a === 'approve' || a === 'apply' ? 'btn-primary' : DANGER.has(a) ? 'btn-danger' : ''}" data-act="${a}">${ACTION_LABEL[a]}</button>`).join('')}<span class="spacer"></span><button type="button" class="btn" data-act="form">View form</button><button value="cancel" class="btn" formnovalidate>Close</button>`,
    },
  );
  d.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (!a) return;
    d.close();
    if (a === 'form') return openForm(r.id);
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
        <span></span>
        <p class="span2 muted small">Admin Unit section of the form (optional):</p>
        <label>Annual leave outstanding if taken as above (days)<input type="number" name="leaveOutstanding" min="0" max="400" step="0.5" /></label>
        <label>Outstanding rest days remaining<input type="number" name="restDaysOutstanding" min="0" max="400" step="0.5" /></label>
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
      await post(`/leave/${r.id}/apply`, { code: f.code.value, leaveOutstanding: f.leaveOutstanding.value, restDaysOutstanding: f.restDaysOutstanding.value });
      d.close();
      toast('Leave added to the roster', 'success');
      refresh();
    } catch (ex) {
      toast(ex.message, 'error');
    }
  });
}

// ---------- Form 410: application for annual leave ----------
const CHECK = (on) => (on ? 'X' : '');
const when = (iso) => (iso ? `${formDate(iso.slice(0, 10))} ${new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : '');

async function requestDialog(sum, refresh) {
  const [{ user }, { settings }] = await Promise.all([get('/auth/me'), get('/settings/leave-form')]);
  const me = user.person || {};
  const team = state.teamMap.get(me.teamId)?.name || '';
  const types = sum.leaveTypes.length ? sum.leaveTypes : [{ code: 'AL', label: 'Annual leave' }];
  const start = addDays(todayIso(), 7);
  const d = dialog(
    `${settings.number} - ${settings.title}`,
    html`<div class="f410-req">
      ${settings.notice ? html`<p class="f410-notice">${settings.notice}</p>` : ''}
      <fieldset><legend>Applicant</legend><div class="form-grid">
        <label>OCU/Branch<input name="unit" value="${settings.unit}" maxlength="100" /></label>
        <label>Date<input value="${formDate(todayIso())}" readonly /></label>
        <label>Name<input value="${me.name || user.username}" readonly /></label>
        <label>Rank/Band<input value="${me.jobTitle || ''}" readonly placeholder="Not recorded" /></label>
        <label>Warrant/Pay No.<input value="${me.staffNumber || ''}" readonly /></label>
        <label>Leave party<input value="${team}" readonly /></label>
      </div></fieldset>
      <fieldset><legend>Leave</legend><div class="form-grid">
        <label>Type<select name="type">${types.map((t) => html`<option value="${t.code}">${t.label}</option>`)}</select></label>
        <span></span>
        <label>From<input type="date" name="start" value="${start}" required /></label>
        <label>To<input type="date" name="end" value="${start}" required /></label>
        <div class="span2 leave-preview muted">Checking your roster…</div>
      </div></fieldset>
      <fieldset><legend>While on leave</legend><div class="form-grid">
        <label class="span2">Address while on leave<textarea name="address" rows="2" maxlength="300"></textarea></label>
        <label>Telephone number<input name="phone" type="tel" value="${me.mobile || ''}" maxlength="40" /></label>
        <label>Date of joining<input name="joinDate" type="date" value="${me.startDate || ''}" /></label>
      </div></fieldset>
      <fieldset><legend>Declarations</legend><div class="f410-decl">
        <label class="check"><input type="checkbox" name="noCourtCases" /> <span>(a) I have no cases at Magistrates' Courts during the above period. I have no cases pending at Crown Court.</span></label>
        <label class="inline">(b) I have <input type="number" name="crownCourtCases" min="0" max="999" class="num" /> cases pending at Crown Court.</label>
        <label class="check"><input type="checkbox" name="availableForCourt" /> <span>(c) During the above period of <b data-days>0</b> days I will be at the address shown and available to attend Court. <small class="muted">(leave of ${AVAILABLE_FOR_COURT_MAX_DAYS} days or less)</small></span></label>
        <label class="inline">(d) I have <input type="number" name="trainingCourses" min="0" max="999" class="num" value="0" /> training courses over the above dates. <small class="muted" data-training-hint></small></label>
      </div></fieldset>
      <fieldset><legend>Signature</legend>
        <label class="check"><input type="checkbox" name="declaration" /> <span>I confirm the entries above are correct. Signed electronically as <b>${me.name || user.username}</b> on submission.</span></label>
        <label>Note for your line manager (optional)<textarea name="note" rows="2" maxlength="500"></textarea></label>
      </fieldset>
      <div class="f410-errors error" role="alert" hidden></div>
    </div>`,
    { wide: true, actions: '<button value="cancel" class="btn" formnovalidate>Cancel</button><button value="ok" class="btn btn-primary">Sign and submit</button>' },
  );
  const f = $('form', d);
  const box = $('.leave-preview', d);
  let workingDays = 0;
  let trainingTouched = false;
  f.trainingCourses.addEventListener('input', () => (trainingTouched = true));
  const preview = debounce(async () => {
    if (f.end.value && f.start.value && f.end.value < f.start.value) f.end.value = f.start.value;
    try {
      const p = await get(`/leave/preview?start=${f.start.value}&end=${f.end.value}`);
      workingDays = p.workingDays;
      $('[data-days]', d).textContent = p.workingDays;
      f.availableForCourt.disabled = p.workingDays > AVAILABLE_FOR_COURT_MAX_DAYS;
      if (f.availableForCourt.disabled) f.availableForCourt.checked = false;
      const courses = trainingCoursesIn(p.days);
      if (!trainingTouched) f.trainingCourses.value = courses;
      $('[data-training-hint]', d).textContent = courses ? `(${plural(courses, 'course')} on your roster in this period)` : '';
      const manager = state.user.person?.lineManagerId;
      box.innerHTML = html`
        <p>This covers <b>${plural(p.workingDays, 'working day')}</b> on your roster.</p>
        ${weekGrid(formWeeks(p.days, f.type.value))}
        ${p.days.some((x) => x.publicHoliday)
          ? html`<p class="small">Public holidays in this period (not counted): ${p.days.filter((x) => x.publicHoliday).map((x) => `${fmtDate(x.date, 'dm')} ${x.publicHoliday}`).join(', ')}.</p>`
          : ''}
        ${p.lockdowns?.length
          ? html`<div class="lock-box"><b>🔒 Leave lockdown:</b> ${p.lockdowns.map((l) => `${l.name} (${range(l)})`).join('; ')}.
              Your manager can still approve this, but only a planner supervisor can add it to the roster.</div>`
          : ''}
        ${p.overlaps.length ? html`<p class="error">This overlaps your request for ${p.overlaps.map(range).join(', ')}.</p>` : ''}
        ${p.coverWarnings ? html`<p class="warn-text">Your team would be below its minimum on ${plural(p.coverWarnings, 'day')} - your manager will see this.</p>` : ''}
        <p class="small">${manager ? 'This goes to your line manager to approve.' : 'You have no line manager set, so an administrator will approve it.'}</p>`;
    } catch (e) {
      box.innerHTML = html`<p class="error">${e.message}</p>`;
    }
  }, 250);
  f.addEventListener('input', (e) => {
    if (['start', 'end', 'type'].includes(e.target.name)) preview();
  });
  f.addEventListener('change', (e) => {
    if (e.target.name === 'type') preview();
  });
  preview();
  const formValues = () => ({
    unit: f.unit.value,
    address: f.address.value,
    phone: f.phone.value,
    joinDate: f.joinDate.value,
    noCourtCases: f.noCourtCases.checked,
    crownCourtCases: f.crownCourtCases.value,
    availableForCourt: f.availableForCourt.checked,
    trainingCourses: f.trainingCourses.value,
    declaration: f.declaration.checked,
  });
  f.addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    const errBox = $('.f410-errors', d);
    const { errors } = normaliseApplicantForm(formValues(), { workingDays });
    if (errors.length) {
      errBox.innerHTML = html`<b>Please complete the form:</b><ul>${errors.map((x) => html`<li>${x}</li>`)}</ul>`;
      errBox.hidden = false;
      errBox.scrollIntoView({ block: 'nearest' });
      return;
    }
    errBox.hidden = true;
    try {
      await post('/leave', { type: f.type.value, start: f.start.value, end: f.end.value, note: f.note.value, form: formValues() });
      d.close();
      toast(state.user.person?.lineManagerId ? 'Form 410 signed and sent to your line manager to approve' : 'Form 410 signed and sent to an administrator to approve', 'success');
      refresh();
    } catch (ex) {
      toast(ex.message, 'error');
    }
  });
}

/** Sat-Fri grid of Date / Nature of leave rows, as on the paper form. */
function weekGrid(weeks) {
  if (!weeks.length) return '';
  return html`<div class="table-wrap"><table class="f410-weeks">
    <thead><tr><th></th>${WEEKDAYS.map((w) => html`<th>${w}</th>`)}</tr></thead>
    <tbody>${weeks.map(
      (wk) => html`<tr><th>Date</th>${wk.map((c) => html`<td>${c ? formDate(c.date, true) : ''}</td>`)}</tr>
        <tr class="nature"><th>Nature of leave</th>${wk.map((c) => html`<td>${c ? c.nature : ''}</td>`)}</tr>`,
    )}</tbody></table></div>`;
}

/** The completed form, laid out like the paper Form 410. */
function form410Html({ request: r, person = {}, form, days }, settings) {
  const a = form?.applicant || {};
  const ap = form?.approval;
  const ad = form?.admin;
  const weeks = formWeeks(days, r.type);
  while (weeks.length < 1) weeks.push(Array(7).fill(null));
  const managerSig = ap
    ? `Digitally approved ${when(ap.at)}`
    : r.status === 'rejected'
      ? `Not approved${r.decidedBy ? ` by ${r.decidedBy}` : ''}`
      : r.status === 'pending'
        ? 'Awaiting approval'
        : r.decidedBy
          ? `Approved by ${r.decidedBy}`
          : '';
  const guidance = (settings.guidance || '').split('\n').map((x) => x.trim()).filter(Boolean);
  return html`<article class="f410">
    <header class="f410-top"><div></div><div class="f410-no">${settings.number}</div></header>
    <h1 class="f410-title">${settings.title}</h1>
    ${settings.notice ? html`<p class="f410-notice">${settings.notice}</p>` : ''}
    <table class="f410-table">
      <tr><th>OCU/Branch:</th><td colspan="3">${a.unit || settings.unit}</td><th>Date:</th><td>${a.signedAt ? formDate(a.signedAt.slice(0, 10)) : formDate((r.createdAt || '').slice(0, 10))}</td></tr>
      <tr><th>Name:</th><td>${person.name || r.personName}</td><th>Rank/Band:</th><td>${person.jobTitle || ''}</td><th>Warrant/Pay No.:</th><td>${person.staffNumber || r.staffNumber || ''}</td></tr>
      <tr><td colspan="6" class="f410-period">I apply to take leave covering the period from: <b>${formDate(r.start)}</b> to: <b>${formDate(r.end)}</b> as detailed below:</td></tr>
    </table>
    <table class="f410-table f410-weeks">
      <thead><tr><th></th>${WEEKDAYS.map((w) => html`<th>${w}</th>`)}</tr></thead>
      <tbody>${weeks.map(
        (wk) => html`<tr><th>Date</th>${wk.map((c) => html`<td>${c ? formDate(c.date, true) : ''}</td>`)}</tr>
          <tr class="nature"><th>Nature of leave</th>${wk.map((c) => html`<td>${c ? c.nature : ''}</td>`)}</tr>`,
      )}</tbody>
    </table>
    <p class="f410-small">Against "Nature of Leave", show as applicable, Annual Leave - A/L, Rest Day - R/D, Bank Holiday Leave - B.H.L., Monthly Leave - M/L (Superintendents and Chief Superintendents only), etc.</p>
    <table class="f410-table">
      <tr><th>Address while on leave:</th><td colspan="3">${a.address || ''}</td></tr>
      <tr><th>Telephone Number:</th><td colspan="3">${a.phone || ''}</td></tr>
      <tr><th>Date of joining:</th><td>${formDate(a.joinDate || person.startDate || '')}</td><th>Leave party:</th><td>${r.teamName || ''}</td></tr>
    </table>
    <p class="f410-small">Enter X in appropriate box</p>
    <table class="f410-table f410-decl-table">
      <tr><td class="box">${CHECK(a.noCourtCases)}</td><td>(a) I have no cases at Magistrates' Courts during the above period. I have no cases pending at Crown Court.</td></tr>
      <tr><td class="box">${CHECK(a.crownCourtCases > 0)}</td><td>(b) I have <b class="fill">${a.crownCourtCases ?? ''}</b> cases pending at Crown Court.</td></tr>
      <tr><td class="box">${CHECK(a.availableForCourt)}</td><td>(c) During the above period of <b class="fill">${r.days}</b> days I will be at the address shown and available to attend Court.<sup>1</sup></td></tr>
      <tr><td class="box">${CHECK(a.trainingCourses > 0)}</td><td>(d) I have <b class="fill">${a.trainingCourses ?? ''}</b> training courses over the above dates.<sup>4</sup></td></tr>
    </table>
    <table class="f410-table">
      <tr><th>Annual Leave Applicant Signature:</th><td>${a.signedBy ? `Signed electronically by ${a.signedBy} ${when(a.signedAt)}` : ''}</td></tr>
    </table>
    <p class="f410-section">AUTHORISATION BY SUPERVISING OFFICER - All above entries have been checked and are found to be correct, I therefore authorise this leave. (*RCRD - applies only where less than 35 days given)</p>
    <table class="f410-table">
      <tr><th>Line Manager Name:</th><td>${ap?.name || r.managerName || ''}</td><th>Rank:</th><td>${ap?.rank || ''}</td></tr>
      <tr><th>Line Manager Signature:</th><td colspan="3">${managerSig}</td></tr>
    </table>
    <p class="f410-section">This section to be completed by the Admin Unit</p>
    <table class="f410-table">
      <tr><th>Noted for duty purposes:</th><td>${ad ? `${ad.notedBy} ${when(ad.at)}` : ''}</td><th>Entered in Annual leave register by:</th><td>${ad?.enteredBy || ''}</td></tr>
      <tr><th>Annual leave outstanding if taken as above:</th><td colspan="3">${ad?.leaveOutstanding ?? ''} days.</td></tr>
      <tr><th>Total number of outstanding rest days remaining:</th><td colspan="3">${ad?.restDaysOutstanding ?? ''} days.</td></tr>
      <tr><th>(Approved) Signature:</th><td colspan="2">${ad ? `Added to roster electronically by ${ad.notedBy} ${when(ad.at)}` : ''}</td><td class="f410-small">Admin/Officer in charge</td></tr>
    </table>
    ${guidance.length
      ? html`<section class="f410-guidance"><h2>Notes for guidance on leave:</h2><ol>${guidance.map((g) => html`<li>${g.replace(/^\d+\.\s*/, '')}</li>`)}</ol></section>`
      : ''}
    ${settings.reference ? html`<footer class="f410-ref">${settings.reference}</footer>` : ''}
  </article>`;
}

async function openForm(id) {
  let data, settings;
  try {
    [data, { settings }] = await Promise.all([get(`/leave/${id}`), get('/settings/leave-form')]);
  } catch (e) {
    return toast(e.message, 'error');
  }
  const d = dialog(`${settings.number}: ${data.request.personName}`, form410Html(data, settings), {
    wide: true,
    actions: '<button type="button" class="btn btn-primary" data-print>Print or save as PDF</button><span class="spacer"></span><button value="cancel" class="btn" formnovalidate>Close</button>',
  });
  d.classList.add('f410-dialog');
  $('[data-print]', d).addEventListener('click', () => printForm(form410Html(data, settings)));
}

/** Print just the form (the browser's print dialog also offers "Save as PDF"). */
function printForm(content) {
  const root = document.createElement('div');
  root.id = 'print-root';
  root.innerHTML = String(content);
  document.body.append(root);
  document.body.classList.add('printing');
  const done = () => {
    document.body.classList.remove('printing');
    root.remove();
    removeEventListener('afterprint', done);
  };
  addEventListener('afterprint', done);
  window.print();
  setTimeout(() => document.body.classList.contains('printing') && done(), 60000);
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

// ---------- work queues: To approve / To add to roster / All requests ----------
const ACTIVE = ['pending', 'approved', 'applied', 'cancel_requested'];
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const SORTS = {
  received: ['Order received - oldest first', (a, b) => cmp(a.createdAt, b.createdAt) || a.id - b.id],
  receivedDesc: ['Order received - newest first', (a, b) => cmp(b.createdAt, a.createdAt) || b.id - a.id],
  approved: ['Date approved - oldest first', (a, b) => cmp(a.decidedAt || '~', b.decidedAt || '~') || cmp(a.createdAt, b.createdAt)],
  start: ['Leave start date', (a, b) => cmp(a.start, b.start) || cmp(a.createdAt, b.createdAt)],
  team: ['Team, then order received', (a, b) => cmp(a.teamName || '~', b.teamName || '~') || cmp(a.createdAt, b.createdAt)],
  name: ['Name', (a, b) => a.personName.localeCompare(b.personName)],
  days: ['Most working days first', (a, b) => b.days - a.days || cmp(a.createdAt, b.createdAt)],
};
const QUEUES = {
  approve: {
    title: 'Leave to approve',
    scope: 'approve',
    statuses: ['pending', 'approved', 'applied', 'rejected', 'cancel_requested', 'cancelled'],
    defaults: { status: 'pending', sort: 'received' },
    bulk: 'approve',
    intro: (sum) =>
      `Requests from people you line manage${sum.administers || state.user.role === 'admin' ? ', and from people with no line manager set' : ''}. Approved leave goes to the leave administrators, who add it to the roster.`,
  },
  apply: {
    title: 'Leave to add to the roster',
    scope: 'apply',
    statuses: ['approved', 'cancel_requested', 'applied'],
    defaults: { status: 'approved', sort: 'received' },
    bulk: 'apply',
    intro: () => 'Approved leave waiting to go on the roster, cancellations to process, and leave already added.',
  },
  all: {
    title: 'All leave requests',
    scope: 'all',
    statuses: Object.keys(STATUS),
    defaults: { status: '', sort: 'receivedDesc' },
    bulk: null,
    intro: () => 'Every leave request, in any state.',
  },
};
const stamp = (s) => (s ? new Date(s.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z')) : null);
const fmtStamp = (s) => {
  const d = stamp(s);
  return d ? `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : '';
};
const ago = (s) => {
  const d = stamp(s);
  if (!d) return '';
  const days = Math.floor((Date.now() - d) / 864e5);
  return days <= 0 ? 'today' : days === 1 ? '1 day' : `${days} days`;
};

function queueMeta(r, { queueNo, selectable, selected, clashes }) {
  const waitingSince = r.status === 'pending' ? r.createdAt : r.status === 'approved' ? r.decidedAt || r.createdAt : null;
  return html`<div class="queue-meta">
    ${selectable ? html`<label class="pick" title="Select"><input type="checkbox" data-pick="${r.id}" ${selected ? 'checked' : ''} aria-label="Select ${r.personName}" /></label>` : ''}
    ${queueNo ? html`<span class="queue-no" title="Position in this queue">#${queueNo}</span>` : ''}
    <span class="muted small">Received ${fmtStamp(r.createdAt)}${waitingSince ? html` · <b>waiting ${ago(waitingSince)}</b>${r.status === 'approved' ? ' since approval' : ''}` : ''}</span>
    ${clashes.length ? html`<span class="clash" title="${clashes.map((c) => `${c.personName}: ${range(c)} (${STATUS[c.status]?.[0]})`).join('\n')}">⚠ ${plural(clashes.length, 'other')} in ${r.teamName} off at the same time</span>` : ''}
  </div>`;
}

async function queue(tab, body, sum, refresh) {
  const cfg = QUEUES[tab];
  const [{ requests }, { lockdowns }] = await Promise.all([get(`/leave?scope=${cfg.scope}`), get('/lockdowns')]);
  const saved = store.get(`leaveq.${tab}`, {});
  const f = { q: '', lockdown: '', team: '', from: '', to: '', clashes: false, ...cfg.defaults, ...saved };
  if (f.status && !cfg.statuses.includes(f.status)) f.status = cfg.defaults.status;
  if (!SORTS[f.sort]) f.sort = cfg.defaults.sort;
  const selected = new Set();

  // Team-mates off at overlapping times (among requests in this list).
  const clashesOf = new Map(
    requests.map((r) => [
      r.id,
      requests.filter((o) => o.id !== r.id && o.teamId && o.teamId === r.teamId && o.personId !== r.personId && ACTIVE.includes(o.status) && o.start <= r.end && o.end >= r.start),
    ]),
  );
  const teams = [...new Map(requests.filter((r) => r.teamId).map((r) => [r.teamId, r.teamName])).entries()].sort((a, b) => cmp(a[1], b[1]));
  const counts = Object.fromEntries(cfg.statuses.map((st) => [st, requests.filter((r) => r.status === st).length]));
  const lockLabel = (l) => `${l.name} (${range(l)})`;
  const relevantLocks = lockdowns.filter((l) => requests.some((r) => r.lockdowns?.some((x) => x.id === l.id)) || l.end >= todayIso());

  body.innerHTML = html`
    <div class="toolbar"><h2>${cfg.title}</h2></div>
    <p class="muted">${cfg.intro(sum)}</p>
    <details class="filters card" ${innerWidth > 720 ? 'open' : ''}>
      <summary><b>Filter and order</b> <span class="muted filter-summary"></span></summary>
      <div class="filter-grid">
        <label>Status<select data-f="status">${cfg.statuses.length > 1 ? html`<option value="">Any status (${requests.length})</option>` : ''}${cfg.statuses.map(
          (st) => html`<option value="${st}" ${f.status === st ? 'selected' : ''}>${STATUS[st][0]} (${counts[st]})</option>`,
        )}</select></label>
        <label>Leave lockdown<select data-f="lockdown">
          <option value="">Any</option>
          <option value="any" ${f.lockdown === 'any' ? 'selected' : ''}>In any lockdown</option>
          <option value="none" ${f.lockdown === 'none' ? 'selected' : ''}>Not in a lockdown</option>
          ${relevantLocks.map((l) => html`<option value="${l.id}" ${String(f.lockdown) === String(l.id) ? 'selected' : ''}>${lockLabel(l)}</option>`)}
        </select></label>
        <label>Team<select data-f="team"><option value="">All teams</option>${teams.map(([id, name]) => html`<option value="${id}" ${String(f.team) === String(id) ? 'selected' : ''}>${name}</option>`)}</select></label>
        <label>Order<select data-f="sort">${Object.entries(SORTS).map(([k, [l]]) => html`<option value="${k}" ${f.sort === k ? 'selected' : ''}>${l}</option>`)}</select></label>
        <label>Leave between<input type="date" data-f="from" value="${f.from}" /></label>
        <label>and<input type="date" data-f="to" value="${f.to}" /></label>
        <label>Search<input type="search" data-f="q" value="${f.q}" placeholder="Name or staff no." /></label>
        <label class="check"><input type="checkbox" data-f="clashes" ${f.clashes ? 'checked' : ''} /> Only where team-mates are off at the same time</label>
        <div class="filter-actions"><button type="button" class="btn btn-sm" data-act="reset">Clear filters</button></div>
      </div>
    </details>
    <div class="queue-bar">
      <span class="queue-count"></span>
      <span class="spacer"></span>
      ${cfg.bulk ? html`<span class="bulk" hidden><b class="bulk-n"></b> <button type="button" class="btn btn-sm" data-act="selectAll">Select all shown</button>
        <button type="button" class="btn btn-sm btn-primary" data-act="bulk">${ACTION_LABEL[cfg.bulk]} selected</button>
        <button type="button" class="btn btn-sm btn-ghost" data-act="clearSel">Clear</button></span>
        <button type="button" class="btn btn-sm" data-act="selectAll" data-when-empty>Select all shown</button>` : ''}
    </div>
    <ul class="req-list" data-list="q"></ul>`;

  const listEl = $('.req-list', body);
  let shown = [];
  const filtered = () =>
    requests
      .filter((r) => !f.status || r.status === f.status)
      .filter((r) => {
        const ids = (r.lockdowns || []).map((l) => String(l.id));
        return !f.lockdown || (f.lockdown === 'any' ? ids.length > 0 : f.lockdown === 'none' ? ids.length === 0 : ids.includes(String(f.lockdown)));
      })
      .filter((r) => !f.team || String(r.teamId) === String(f.team))
      .filter((r) => (!f.from || r.end >= f.from) && (!f.to || r.start <= f.to))
      .filter((r) => !f.q || `${r.personName} ${r.staffNumber || ''}`.toLowerCase().includes(f.q.toLowerCase()))
      .filter((r) => !f.clashes || clashesOf.get(r.id).length)
      .sort(SORTS[f.sort][1]);

  const draw = () => {
    shown = filtered();
    const numbered = f.sort === 'received' || f.sort === 'approved';
    listEl.innerHTML = shown.length
      ? html`${shown.map((r, i) =>
          requestCard(r, {
            meta: queueMeta(r, {
              queueNo: numbered ? i + 1 : null,
              selectable: cfg.bulk && r.actions[cfg.bulk],
              selected: selected.has(r.id),
              clashes: clashesOf.get(r.id),
            }),
          }),
        )}`
      : html`<li class="empty-inline">No requests match these filters.</li>`;
    const active = [
      f.status && STATUS[f.status][0],
      f.lockdown && (f.lockdown === 'any' ? 'in a lockdown' : f.lockdown === 'none' ? 'no lockdown' : lockdowns.find((l) => String(l.id) === String(f.lockdown))?.name),
      f.team && teams.find(([id]) => String(id) === String(f.team))?.[1],
      (f.from || f.to) && `${f.from ? fmtDate(f.from, 'dm') : '…'} – ${f.to ? fmtDate(f.to, 'dm') : '…'}`,
      f.q && `"${f.q}"`,
      f.clashes && 'team clashes',
    ].filter(Boolean);
    $('.filter-summary', body).textContent = active.length ? `· ${active.join(' · ')}` : '';
    $('.queue-count', body).textContent = `Showing ${shown.length} of ${plural(requests.length, 'request')} · ${SORTS[f.sort][0].toLowerCase()}`;
    drawBulk();
  };
  const drawBulk = () => {
    if (!cfg.bulk) return;
    for (const id of [...selected]) if (!shown.some((r) => r.id === id)) selected.delete(id);
    const n = selected.size;
    $('.bulk', body).hidden = !n;
    $('[data-when-empty]', body).hidden = !!n || !shown.some((r) => r.actions[cfg.bulk]);
    $('.bulk-n', body).textContent = `${n} selected`;
  };
  const save = () => store.set(`leaveq.${tab}`, f);

  body.oninput = debounce((e) => {
    const k = e.target.dataset.f;
    if (k === 'q') {
      f.q = e.target.value.trim();
      save();
      draw();
    }
  }, 150);
  body.onchange = (e) => {
    const k = e.target.dataset.f;
    if (e.target.dataset.pick) {
      const id = Number(e.target.dataset.pick);
      if (e.target.checked) selected.add(id);
      else selected.delete(id);
      return drawBulk();
    }
    if (!k || k === 'q') return;
    f[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    save();
    draw();
  };
  body.onclick = async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const a = b.dataset.act;
    if (a === 'reset') {
      store.set(`leaveq.${tab}`, {});
      return queue(tab, body, sum, refresh);
    }
    if (a === 'selectAll') {
      shown.filter((r) => r.actions[cfg.bulk]).forEach((r) => selected.add(r.id));
      return draw();
    }
    if (a === 'clearSel') {
      selected.clear();
      return draw();
    }
    if (a === 'bulk') return runBulk(cfg.bulk, shown.filter((r) => selected.has(r.id)), refresh);
    const li = b.closest('[data-id]');
    if (!li) return;
    const r = requests.find((x) => x.id === Number(li.dataset.id));
    if (a === 'open') openRequest(r.id, refresh);
    else if (a === 'form') openForm(r.id);
    else act(r, a, refresh);
  };
  draw();
}

/** Approve, or add to the roster, several requests in the order shown. */
async function runBulk(action, list, refresh) {
  if (!list.length) return;
  const what =
    action === 'approve'
      ? `Approve ${plural(list.length, 'request')}? They then go to the leave administrators to add to the roster.`
      : `Add ${plural(list.length, 'request')} to the roster, in the order shown? Each uses its own leave type; rest days and public holidays become Rest Day / Public holiday leave.`;
  const d = dialog(
    `${ACTION_LABEL[action]} selected`,
    html`<p>${what}</p><ol class="bulk-list">${list.map((r) => html`<li>${r.personName} · ${range(r)} · ${plural(r.days, 'working day')}</li>`)}</ol>`,
    { actions: `<button value="cancel" class="btn" formnovalidate>Back</button><button value="ok" class="btn btn-primary">${ACTION_LABEL[action]} ${list.length}</button>` },
  );
  if ((await d.closed) !== 'ok') return;
  let ok = 0;
  const failed = [];
  for (const r of list) {
    try {
      await post(`/leave/${r.id}/${action}`, action === 'apply' ? { code: r.type } : {});
      ok++;
    } catch (e) {
      failed.push(`${r.personName}: ${e.message}`);
    }
  }
  toast(`${ok} done${failed.length ? ` · ${failed.length} not done` : ''}`, failed.length ? 'warn' : 'success', failed.length ? 8000 : 3500);
  if (failed.length) dialog('Some requests were not processed', html`<ul>${failed.map((m) => html`<li>${m}</li>`)}</ul>`);
  refresh();
}

const approve = (body, sum, refresh) => queue('approve', body, sum, refresh);
const apply = (body, sum, refresh) => queue('apply', body, sum, refresh);
const all = (body, sum, refresh) => queue('all', body, sum, refresh);
