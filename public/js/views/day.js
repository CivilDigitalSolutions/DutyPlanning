// Day view: who is doing what on a given date, grouped by team and by duty.
import { replaceRoute } from '../router.js';
import { state, loadRoster, codeInfo, onDuty, accStatus } from '../state.js';
import { $, html, addDays, todayIso, fmtDate, contrast } from '../util.js';

const chip = (code) => {
  const info = codeInfo(code);
  return html`<span class="chip" style="background:${info.color};color:${contrast(info.color)}">${code === '*' ? '–' : code}</span>`;
};

export async function render(root, params) {
  let date = /^\d{4}-\d{2}-\d{2}$/.test(params[0] || '') ? params[0] : todayIso();
  let mode = 'team';
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
            <button class="btn" data-mode="team">By team</button><button class="btn" data-mode="code">By duty</button>
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
      data = await loadRoster(date, date);
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

    const person = (p) => {
      const c = codeOf(p);
      return html`<li class="${p.id === state.user.person?.id ? 'me' : ''}">${c ? chip(c) : html`<span class="chip empty">·</span>`}<span class="nm">${p.name}</span><span class="muted">${p.initials || ''}</span>${p.mobile ? html`<a class="tel" href="tel:${p.mobile.replace(/[^+\d]/g, '')}" aria-label="Call ${p.name}">📞</a>` : ''}</li>`;
    };
    let out = '';
    if (mode === 'team') {
      for (const t of data.teams) {
        const members = people.filter((p) => p.teamId === t.id);
        if (!members.length) continue;
        const on = members.filter((p) => onDuty(codeOf(p))).length;
        const low = t.minStrength != null && on < t.minStrength;
        out += html`<div class="card group-card"><h2>${t.name} <small class="${low ? 'error' : 'muted'}">${on} on duty${t.minStrength != null ? ` / min ${t.minStrength}` : ''}</small></h2>
          <ul class="who-list">${members.sort((a, b) => Number(onDuty(codeOf(b))) - Number(onDuty(codeOf(a)))).map(person)}</ul></div>`;
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
        out += html`<div class="card group-card"><h2>${code ? chip(code) : ''} ${label} <small class="muted">${list.length}</small></h2><ul class="who-list">${list.map(person)}</ul></div>`;
      }
    }
    $('.day-body', root).innerHTML = out || '<p class="empty">Nobody matches.</p>';
  }

  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const m = e.target.closest('[data-mode]')?.dataset.mode;
    if (m) {
      mode = m;
      return draw();
    }
    if (act === 'prev') date = addDays(date, -1);
    else if (act === 'next') date = addDays(date, 1);
    else if (act === 'today') date = todayIso();
    else return;
    load();
  });
  root.addEventListener('change', (e) => {
    if (e.target.classList.contains('date-jump') && e.target.value) {
      date = e.target.value;
      load();
    } else if (e.target.dataset.f === 'acc') {
      acc = e.target.value;
      draw();
    }
  });
  const onChanged = (e) => {
    if (e.detail.type === 'meta' || (e.detail.type === 'roster' && e.detail.from <= date && e.detail.to >= date)) load();
  };
  window.addEventListener('dp:changed', onChanged);
  await load();
  return () => window.removeEventListener('dp:changed', onChanged);
}
