// Day view: who is doing what on a given date, grouped by team and by duty.
import { replaceRoute } from '../router.js';
import { state, loadRoster, codeInfo, onDuty, accStatus } from '../state.js';
import { get, put, post } from '../api.js';
import { $, $$, html, addDays, todayIso, fmtDate, contrast, toast, confirmDialog, store } from '../util.js';

const chip = (code) => {
  const info = codeInfo(code);
  return html`<span class="chip" style="background:${info.color};color:${contrast(info.color)}">${code === '*' ? '–' : code}</span>`;
};

export async function render(root, params) {
  let date = /^\d{4}-\d{2}-\d{2}$/.test(params[0] || '') ? params[0] : todayIso();
  let mode = store.get('dayMode', 'team');
  let postings = new Map(); // personId -> { typeId, time, detail, updatedBy }
  let editable = new Set(); // team ids this user may post
  let visible = new Set(); // team ids whose postings this user may see
  let types = [];
  const dirty = new Set(); // team ids with unsaved posting changes
  let acc = '';

  root.innerHTML = html`
    <section class="dayview">
      <div class="toolbar">
        <div class="group">
          <button class="btn icon-btn" data-act="prev" aria-label="Previous day">‹</button>
          <button class="btn" data-act="today">Today</button>
          <button class="btn icon-btn" data-act="next" aria-label="Next day">›</button>
          <input type="date" class="date-jump" aria-label="Date" />
        </div>
        <div class="group">
          <div class="seg" role="group" aria-label="Group by">
            <button class="btn" data-mode="team">By team</button><button class="btn" data-mode="code">By duty</button><button class="btn" data-mode="postings">Postings</button>
          </div>
          <select data-f="acc" aria-label="Filter by accreditation"><option value="">Any accreditation</option>${state.meta.accreditations.map((a) => html`<option value="${a.id}">${a.name}</option>`)}</select>
        </div>
      </div>
      <h1 class="day-title"></h1>
      <div class="summary"></div>
      <div class="day-body"></div>
    </section>`;

  let data = null;
  async function load() {
    replaceRoute(`#/day/${date}`);
    $('.date-jump', root).value = date;
    $('.day-title', root).textContent = fmtDate(date, 'long');
    $('.day-body', root).innerHTML = '<p class="muted">Loading…</p>';
    try {
      const [roster, pd, pt] = await Promise.all([loadRoster(date, date), get(`/postings?date=${date}`), get('/posting-types')]);
      data = roster;
      postings = new Map(pd.postings.map((x) => [x.personId, x]));
      editable = new Set(pd.editableTeams);
      visible = new Set(pd.visibleTeams || []);
      types = pt.types;
      dirty.clear();
      draw();
    } catch (e) {
      $('.day-body', root).innerHTML = html`<p class="error">${e.message}</p>`;
    }
  }

  function draw() {
    for (const b of root.querySelectorAll('[data-mode]')) b.classList.toggle('btn-primary', b.dataset.mode === mode);
    const hol = data.publicHolidays?.[date];
    $('.day-title', root).innerHTML = html`${fmtDate(date, 'long')}${hol ? html` <span class="holiday-tag">${hol}</span>` : ''}`;
    const today = todayIso();
    const people = data.people.filter((p) => !acc || accStatus(p.acc[acc], today) && accStatus(p.acc[acc], today) !== 'expired');
    const codeOf = (p) => data.cells.get(`${p.id}|${date}`)?.c ?? '';
    // Summary by category
    const cats = { duty: 0, rest: 0, leave: 0, training: 0, other: 0, none: 0 };
    for (const p of people) {
      const c = codeOf(p);
      if (!c) cats.none++;
      else cats[c === '*' ? 'other' : codeInfo(c).category]++;
    }
    $('.summary', root).innerHTML = html`<div class="stats">
      <div class="stat"><small>On duty</small><b>${cats.duty}</b></div>
      <div class="stat"><small>Rest</small><b>${cats.rest}</b></div>
      <div class="stat"><small>Leave / absent</small><b>${cats.leave + cats.other}</b></div>
      <div class="stat"><small>Training</small><b>${cats.training}</b></div>
      ${cats.none ? html`<div class="stat"><small>Not planned</small><b>${cats.none}</b></div>` : ''}
    </div>`;

    const RANK = { leader: 0, supervisor: 1 };
    const abbr = (teamId) => {
      const name = state.teamMap.get(teamId)?.name || '';
      const m = name.match(/^team\s*(\w+)$/i);
      return m ? `T${m[1]}`.slice(0, 4) : (name.split(/\s+/).filter(Boolean).map((w) => w[0]).join('') || '?').toUpperCase().slice(0, 3);
    };
    // Badges for positions held in other teams, e.g. "SUP·T2".
    const otherBadges = (p) =>
      (p.positions || [])
        .filter((x) => x.teamId !== p.teamId)
        .map((x) => html`<span class="role ${x.role === 'leader' ? 'role-leader' : 'role-sup'} role-other" title="${x.role === 'leader' ? 'Team leader' : 'Supervisor'} of ${state.teamMap.get(x.teamId)?.name || 'another team'}">${x.role === 'leader' ? 'TL' : 'SUP'}·${abbr(x.teamId)}</span>`);
    const person = (p, guestRole) => {
      const c = codeOf(p);
      const ps = postings.get(p.id);
      return html`<li class="${p.id === state.user.person?.id ? 'me' : ''}">${c ? chip(c) : html`<span class="chip empty">·</span>`}<span class="nm">${p.name}${ps ? html`<small class="posting-line">${postingText(ps)}</small>` : ''}</span>${
        guestRole
          ? html`<span class="role ${guestRole === 'leader' ? 'role-leader' : 'role-sup'}">${guestRole === 'leader' ? 'TL' : 'SUP'}</span><small class="guest-from">${state.teamMap.get(p.teamId)?.name || ''}</small>`
          : html`${p.teamRole === 'leader' ? html`<span class="role role-leader" title="Team leader">TL</span>` : p.teamRole === 'supervisor' ? html`<span class="role role-sup" title="Supervisor">SUP</span>` : ''}${otherBadges(p)}`
      }<span class="muted">${p.initials || ''}</span>${p.mobile ? html`<a class="tel" href="tel:${p.mobile.replace(/[^+\d]/g, '')}" aria-label="Call ${p.name}">📞</a>` : ''}</li>`;
    };
    let out = '';
    if (mode === 'postings') {
      const note =
        visible.size < data.teams.length
          ? html`<p class="muted small posting-privacy">Postings are private to each team. You can see ${visible.size === 1 ? 'your own team' : 'the teams you belong to, lead or supervise'}.</p>`
          : '';
      $('.day-body', root).innerHTML = note + (postingsHtml(people, codeOf, RANK) || '<p class="empty">Nobody in your team is on duty this day.</p>');
      return;
    }
    if (mode === 'team') {
      for (const t of data.teams) {
        const members = people.filter((p) => p.teamId === t.id);
        if (!members.length) continue;
        const on = members.filter((p) => onDuty(codeOf(p))).length;
        const low = t.minStrength != null && on < t.minStrength;
        // Team leader / supervisors of this team (they may belong to another team).
        const leads = data.people
          .map((p) => ({ p, role: (p.positions || []).find((x) => x.teamId === t.id)?.role }))
          .filter((x) => x.role);
        const lead = leads.filter((x) => onDuty(codeOf(x.p)));
        const guests = leads.filter((x) => x.p.teamId !== t.id && people.includes(x.p)).sort((a, b) => (RANK[a.role] ?? 2) - (RANK[b.role] ?? 2));
        const supervision = on && leads.length
          ? lead.length
            ? `In charge: ${lead.sort((a, b) => (RANK[a.role] ?? 2) - (RANK[b.role] ?? 2))[0].p.name}${lead[0].p.teamId !== t.id ? ` (${state.teamMap.get(lead[0].p.teamId)?.name || 'another team'})` : ''}`
            : 'No team leader or supervisor on duty'
          : '';
        out += html`<div class="card group-card"><h2>${t.name} <small class="${low ? 'error' : 'muted'}">${on} on duty${t.minStrength != null ? ` / min ${t.minStrength}` : ''}</small></h2>${supervision ? html`<p class="in-charge ${lead.length ? '' : 'warn-text'}">${supervision}</p>` : ''}
          <ul class="who-list">${members.sort((a, b) => Number(onDuty(codeOf(b))) - Number(onDuty(codeOf(a))) || (RANK[a.teamRole] ?? 2) - (RANK[b.teamRole] ?? 2)).map((p) => person(p))}</ul>${
            guests.length ? html`<h3 class="guest-head">From other teams</h3><ul class="who-list guest-list">${guests.map((x) => person(x.p, x.role))}</ul>` : ''
          }</div>`;
      }
    } else {
      const order = [...state.meta.dutyCodes.map((c) => c.code), '*', ''];
      const groups = new Map(order.map((c) => [c, []]));
      for (const p of people) {
        const c = codeOf(p);
        const key = order.find((o) => o.toLowerCase() === c.toLowerCase()) ?? c;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      }
      for (const [code, list] of groups) {
        if (!list.length) continue;
        const label = code ? codeInfo(code).label : 'Not planned';
        out += html`<div class="card group-card"><h2>${code ? chip(code) : ''} ${label} <small class="muted">${list.length}</small></h2><ul class="who-list">${list.map((p) => person(p))}</ul></div>`;
      }
    }
    $('.day-body', root).innerHTML = out || '<p class="empty">Nobody matches.</p>';
  }

  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const m = e.target.closest('[data-mode]')?.dataset.mode;
    if (m) {
      mode = m;
      store.set('dayMode', m);
      return draw();
    }
    const card = e.target.closest('[data-team]');
    if (act === 'save' && card) return savePostings(Number(card.dataset.team));
    if (act === 'copy' && card) return copyPostings(Number(card.dataset.team));
    if (act === 'applySel' && card) return applyToSelected(card);
    if (act === 'clearRow') {
      const row = e.target.closest('[data-pid]');
      row.querySelector('[data-p=type]').value = '';
      row.querySelector('[data-p=time]').value = '';
      row.querySelector('[data-p=detail]').value = '';
      return markDirty(card);
    }
    if (!['prev', 'next', 'today'].includes(act)) return;
    leaveDay(() => {
      if (act === 'prev') date = addDays(date, -1);
      else if (act === 'next') date = addDays(date, 1);
      else date = todayIso();
      load();
    });
  });
  root.addEventListener('input', (e) => {
    const card = e.target.closest('[data-team]');
    if (card && e.target.dataset.p) markDirty(card);
  });
  root.addEventListener('change', (e) => {
    if (e.target.dataset.p === 'type') return markDirty(e.target.closest('[data-team]'));
    if (e.target.dataset.sel !== undefined) return;
    if (e.target.classList.contains('date-jump') && e.target.value) {
      const to = e.target.value;
      leaveDay(() => {
        date = to;
        load();
      }, () => (e.target.value = date));
    } else if (e.target.dataset.f === 'acc') {
      acc = e.target.value;
      draw();
    }
  });
  const onChanged = (e) => {
    const d = e.detail;
    if (dirty.size) return; // don't wipe someone's unsaved postings
    if (d.type === 'meta' || ((d.type === 'roster' || d.type === 'postings') && (!d.from || (d.from <= date && d.to >= date)))) load();
  };

  // ---------- Daily postings ----------
  const typeById = (id) => types.find((t) => t.id === id);
  function postingText(ps) {
    const t = typeById(ps.typeId);
    return html`${t ? html`<span class="posting-tag" style="background:${t.color};color:${contrast(t.color)}">${t.name}</span>` : ''}${ps.time ? html` <b>${ps.time}</b>` : ''}${
      ps.detail ? html` ${ps.detail}` : ''
    }`;
  }

  function postingsHtml(people, codeOf, RANK) {
    const byRole = (a, b) => (RANK[a.teamRole] ?? 2) - (RANK[b.teamRole] ?? 2);
    const badge = (p) =>
      p.teamRole === 'leader' ? html`<span class="role role-leader" title="Team leader">TL</span>` : p.teamRole === 'supervisor' ? html`<span class="role role-sup" title="Supervisor">SUP</span>` : '';
    let out = '';
    // Postings are private to each team: only teams you belong to, lead or supervise are shown.
    for (const t of data.teams.filter((x) => visible.has(x.id))) {
      const members = people.filter((p) => p.teamId === t.id);
      const working = members.filter((p) => onDuty(codeOf(p))).sort(byRole);
      // People with a posting who aren't on duty (e.g. put on leave since): shown so it can be cleared.
      const stray = members.filter((p) => !onDuty(codeOf(p)) && postings.has(p.id));
      if (!working.length && !stray.length) continue;
      const canEdit = editable.has(t.id);
      const posted = working.filter((p) => postings.has(p.id)).length;
      const activeTypes = types.filter((x) => x.active);
      const row = (p, off) => {
        const ps = postings.get(p.id) || {};
        const c = codeOf(p);
        if (!canEdit)
          return html`<li class="post-row ${off ? 'off' : ''}"><span class="post-who">${c ? chip(c) : ''}<span class="nm">${p.name}</span>${badge(p)}</span>
            <span class="post-what">${postings.has(p.id) ? postingText(ps) : html`<span class="muted">Not posted</span>`}${off ? html` <span class="warn-text small">not on duty</span>` : ''}</span></li>`;
        return html`<li class="post-row ${off ? 'off' : ''}" data-pid="${p.id}">
          <label class="pick"><input type="checkbox" data-sel aria-label="Select ${p.name}" /></label>
          <span class="post-who">${c ? chip(c) : ''}<span class="nm">${p.name}</span>${badge(p)}${off ? html`<span class="warn-text small">not on duty</span>` : ''}</span>
          <span class="post-edit">
            <select data-p="type" aria-label="Posting for ${p.name}"><option value="">No posting</option>${[...activeTypes, ...types.filter((x) => !x.active && x.id === ps.typeId)].map(
              (x) => html`<option value="${x.id}" ${x.id === ps.typeId ? 'selected' : ''}>${x.name}</option>`,
            )}</select>
            <input type="time" data-p="time" value="${ps.time || ''}" aria-label="Time" />
            <input data-p="detail" value="${ps.detail || ''}" maxlength="200" placeholder="Detail (optional)" aria-label="Detail for ${p.name}" />
            <button type="button" class="btn btn-sm btn-ghost" data-act="clearRow" title="Clear this posting">✕</button>
          </span>
        </li>`;
      };
      out += html`<div class="card group-card post-card" data-team="${t.id}">
        <h2>${t.name} <small class="muted">${posted} of ${working.length} on duty posted</small></h2>
        ${canEdit
          ? html`<div class="post-tools">
              <button type="button" class="btn btn-sm" data-act="copy" title="Copy this team's postings from its last working day, for people on duty today">Copy from last working day</button>
              <span class="spacer"></span>
              <select data-bulk aria-label="Posting for selected people"><option value="">Give selected…</option>${activeTypes.map((x) => html`<option value="${x.id}">${x.name}</option>`)}</select>
              <button type="button" class="btn btn-sm" data-act="applySel">Apply</button>
            </div>`
          : ''}
        <ul class="post-list">${working.map((p) => row(p, false))}${stray.map((p) => row(p, true))}</ul>
        ${canEdit ? html`<div class="post-save"><span class="muted small" data-dirty hidden>Unsaved changes</span><span class="spacer"></span><button type="button" class="btn btn-primary btn-sm" data-act="save" disabled>Save postings</button></div>` : ''}
      </div>`;
    }
    return out;
  }

  function markDirty(card) {
    if (!card) return;
    dirty.add(Number(card.dataset.team));
    $('[data-act=save]', card).disabled = false;
    $('[data-dirty]', card).hidden = false;
  }

  function applyToSelected(card) {
    const typeId = $('[data-bulk]', card).value;
    const rows = $$('[data-pid]', card).filter((r) => r.querySelector('[data-sel]').checked);
    if (!typeId || !rows.length) return toast('Tick some people and choose a posting first', 'warn');
    for (const r of rows) {
      r.querySelector('[data-p=type]').value = typeId;
      r.querySelector('[data-sel]').checked = false;
    }
    markDirty(card);
  }

  async function savePostings(teamId) {
    const card = $(`[data-team="${teamId}"]`, root);
    const changes = $$('[data-pid]', card)
      .map((r) => ({
        personId: Number(r.dataset.pid),
        typeId: r.querySelector('[data-p=type]').value || null,
        time: r.querySelector('[data-p=time]').value,
        detail: r.querySelector('[data-p=detail]').value,
      }))
      .filter((ch) => {
        const old = postings.get(ch.personId) || {};
        return String(old.typeId ?? '') !== String(ch.typeId ?? '') || (old.time || '') !== ch.time || (old.detail || '') !== ch.detail.trim();
      });
    if (!changes.length) {
      dirty.delete(teamId);
      return draw();
    }
    try {
      await put('/postings', { date, changes });
      toast(`Postings saved (${changes.length})`, 'success');
      dirty.delete(teamId);
      await load();
    } catch (ex) {
      toast(ex.message, 'error');
    }
  }

  async function copyPostings(teamId) {
    if (dirty.has(teamId) && !(await confirmDialog('Discard your unsaved changes for this team and copy from its last working day?', 'Copy'))) return;
    try {
      const r = await post('/postings/copy', { teamId, to: date });
      toast(`Copied ${r.copied} posting${r.copied === 1 ? '' : 's'} from ${fmtDate(r.from, 'dm')}${r.skipped ? ` · ${r.skipped} skipped (not on duty or already posted)` : ''}`, 'success', 6000);
      dirty.delete(teamId);
      await load();
    } catch (ex) {
      toast(ex.message, 'error');
    }
  }

  /** Ask before leaving a day with unsaved postings. */
  async function leaveDay(go, stay) {
    if (dirty.size && !(await confirmDialog('You have unsaved postings for this day. Leave without saving?', 'Leave without saving', true))) return stay?.();
    go();
  }
  window.addEventListener('dp:changed', onChanged);
  await load();
  return () => window.removeEventListener('dp:changed', onChanged);
}
