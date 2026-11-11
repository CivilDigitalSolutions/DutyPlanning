// "My duties" - a phone friendly personal view.
import { download } from '../api.js';
import { state, loadRoster, codeInfo, onDuty } from '../state.js';
import { $, html, addDays, eachDate, startOfWeek, todayIso, fmtDate, dayNum, contrast } from '../util.js';

const chip = (code) => {
  const info = codeInfo(code);
  return html`<span class="chip" style="background:${info.color};color:${contrast(info.color)}">${code === '*' ? '–' : code}</span>`;
};

export async function render(root) {
  const me = state.user.person;
  if (!me) {
    root.innerHTML = '<div class="empty">Your account is not linked to anyone on the plan. Ask a planner to link it.</div>';
    return;
  }
  const today = todayIso();
  const start = startOfWeek(today);
  let end = addDays(start, 83);
  let cells = new Map();
  const dayCache = new Map();

  root.innerHTML = html`
    <section class="mine">
      <div class="mine-head">
        <div>
          <h1>${me.name}</h1>
          <p class="muted">${state.teamMap.get(me.teamId)?.name || 'No team'} · ${me.staffNumber}</p>
        </div>
        <button class="btn" data-act="ics">Add to calendar</button>
      </div>
      <div class="stats"></div>
      <div class="weeks"></div>
      <button class="btn btn-block more">Show more weeks</button>
    </section>`;

  async function load() {
    const data = await loadRoster(start, end, { person: me.id });
    cells = new Map([...data.cells].filter(([k]) => k.startsWith(me.id + '|')).map(([k, v]) => [k.split('|')[1], v]));
    draw();
  }

  function draw() {
    const all = eachDate(today, end);
    const at = (d) => cells.get(d);
    const todayA = at(today);
    const nextWork = all.find((d) => d > today && at(d) && onDuty(at(d).c));
    const nextRest = all.find((d) => d > today && at(d) && codeInfo(at(d).c).category === 'rest');
    const leave = all.filter((d) => at(d) && codeInfo(at(d).c).category === 'leave').length;
    const training = all.filter((d) => at(d) && codeInfo(at(d).c).category === 'training').length;
    const stat = (label, d, extra = '') =>
      html`<div class="stat"><small>${label}</small>${d ? html`<b>${fmtDate(d, 'dow')} ${fmtDate(d, 'dm')}</b>${chip(at(d).c)}` : html`<b>–</b>`}${extra}</div>`;
    $('.stats', root).innerHTML = html`
      <div class="stat today"><small>Today</small>${todayA ? html`<b>${codeInfo(todayA.c).label}</b>${chip(todayA.c)}` : html`<b>Nothing planned</b>`}</div>
      ${stat('Next duty', nextWork)}
      ${stat('Next rest day', nextRest)}
      <div class="stat"><small>Next ${Math.round(all.length / 7)} weeks</small><b>${leave} leave · ${training} training</b></div>`;

    let out = '';
    for (let w = start; w <= end; w = addDays(w, 7)) {
      out += html`<h2 class="week-h">Week commencing ${fmtDate(w, 'dmy')}</h2><ul class="days">`;
      for (const d of eachDate(w, addDays(w, 6))) {
        const a = at(d);
        const info = a ? codeInfo(a.c) : null;
        out += html`<li class="day ${d === today ? 'is-today' : ''} ${d < today ? 'past' : ''}">
          <button class="day-btn" data-day="${d}" aria-expanded="false">
            <span class="dow">${fmtDate(d, 'dow')}</span><span class="dnum">${dayNum(d)}</span>
            ${a ? chip(a.c) : html`<span class="chip empty">·</span>`}
            <span class="lbl">${info ? info.label : 'Nothing planned'}${a?.n ? html`<small>${a.n}</small>` : ''}</span>
            <span class="chev" aria-hidden="true">›</span>
          </button>
          <div class="who" hidden></div>
        </li>`;
      }
      out += '</ul>';
    }
    $('.weeks', root).innerHTML = out;
  }

  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-act=ics]')) return download('/my.ics');
    if (e.target.closest('.more')) {
      end = addDays(end, 84);
      return load();
    }
    const btn = e.target.closest('[data-day]');
    if (!btn) return;
    const who = btn.nextElementSibling;
    const open = who.hidden;
    who.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (!open || who.dataset.loaded) return;
    who.innerHTML = '<p class="muted">Loading…</p>';
    const d = btn.dataset.day;
    try {
      const data = dayCache.get(d) || (await loadRoster(d, d));
      dayCache.set(d, data);
      const mine = cells.get(d)?.c;
      const byCode = (code) => data.people.filter((p) => p.id !== me.id && data.cells.get(`${p.id}|${d}`)?.c === code);
      const team = data.people.filter((p) => p.teamId === me.teamId && p.id !== me.id);
      const working = mine && onDuty(mine) ? byCode(mine) : [];
      who.innerHTML = html`
        ${working.length ? html`<h3>Also on ${mine} (${working.length})</h3><p>${working.map((p) => p.name).join(', ')}</p>` : ''}
        <h3>My team</h3>
        <ul class="who-list">${team.map((p) => {
          const a = data.cells.get(`${p.id}|${d}`);
          return html`<li>${a ? chip(a.c) : html`<span class="chip empty">·</span>`} ${p.name}${p.mobile ? html` <a href="tel:${p.mobile.replace(/[^+\d]/g, '')}" class="muted">${p.mobile}</a>` : ''}</li>`;
        })}</ul>
        <a class="btn btn-sm" href="#/day/${d}">See everyone on ${fmtDate(d, 'dm')}</a>`;
      who.dataset.loaded = '1';
    } catch (ex) {
      who.innerHTML = html`<p class="error">${ex.message}</p>`;
    }
  });

  const onChanged = (e) => {
    if (e.detail.type === 'roster' || e.detail.type === 'meta') {
      dayCache.clear();
      load();
    }
  };
  window.addEventListener('dp:changed', onChanged);
  await load();
  return () => window.removeEventListener('dp:changed', onChanged);
}
