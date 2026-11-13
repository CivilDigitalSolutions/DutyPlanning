// The planning grid: teams grouped down the side, dates across the top.
import { get, put, post, download } from '../api.js';
import { state, isPlanner, loadRoster, codeInfo, onDuty, accStatus } from '../state.js';
import { $, $$, esc, html, toast, dialog, addDays, eachDate, startOfWeek, todayIso, fmtDate, dayNum, isWeekend, contrast, debounce, store, daysBetween } from '../util.js';

const SPANS = [
  [7, '1 week'],
  [14, '2 weeks'],
  [28, '4 weeks'],
  [56, '8 weeks'],
  [91, '13 weeks'],
];

export async function render(root) {
  const planner = isPlanner();
  const today = todayIso();
  const saved = store.get('plan', {});
  const v = {
    start: startOfWeek(today),
    span: saved.span ?? (innerWidth < 700 ? 14 : 28),
    teams: saved.teams ?? [],
    q: '',
    acc: '',
    showAcc: saved.showAcc ?? false,
    showStaff: saved.showStaff ?? innerWidth > 900,
    showVacant: saved.showVacant ?? true,
    layer: saved.layer === 'postings' ? 'postings' : 'duties', // what the grid shows and edits
  };
  const persist = () => store.set('plan', { span: v.span, teams: v.teams, showAcc: v.showAcc, showStaff: v.showStaff, showVacant: v.showVacant, layer: v.layer });

  let data = null;
  let dates = [];
  let personRows = []; // people in display order (selection row index)
  let cellEls = []; // flat list of td.c, index r * dates.length + c
  let sel = null; // {r0,c0,r1,c1}
  let dragging = false;
  let extendMode = false;
  let typed = '';
  let drawnGroups = [];
  let postingAt = new Map(); // "personId|date" -> daily posting
  let postingTypes = null;
  let postEditTeams = new Set(); // teams whose postings this user may change
  let postVisTeams = new Set(); // teams whose postings this user may see
  const isPostings = () => v.layer === 'postings';
  // Who can edit what's on screen: the duty plan is planners' only; a team's postings are its
  // team leader's and supervisors' (and planners').
  const canEditLayer = () => (isPostings() ? postEditTeams.size > 0 : planner);
  const canEditRow = (p) => (isPostings() ? postEditTeams.has(p.teamId) : planner);
  let rowOf = new Map();
  let colOf = new Map();
  let totalEls = [];
  const undo = [];
  const myId = state.user.person?.id;

  root.innerHTML = html`
    <section class="plan">
      <div class="toolbar">
        <div class="group">
          <button class="btn icon-btn" data-act="prev" aria-label="Previous period">‹</button>
          <button class="btn" data-act="today">Today</button>
          <button class="btn icon-btn" data-act="next" aria-label="Next period">›</button>
          <input type="date" class="date-jump" aria-label="Jump to date" />
          <span class="range-label"></span>
        </div>
        <div class="group">
          <div class="seg" role="group" aria-label="Show">
            <button class="btn" data-layer="duties">Duties</button><button class="btn" data-layer="postings">Postings</button>
          </div>
        </div>
        <div class="group">
          <select data-f="span" aria-label="Period length">${SPANS.map(([d, l]) => html`<option value="${d}">${l}</option>`)}</select>
          <details class="dropdown team-filter">
            <summary class="btn">Teams</summary>
            <div class="dropdown-pop"></div>
          </details>
          <input type="search" placeholder="Search name / no." data-f="q" aria-label="Search people" />
          <select data-f="acc" aria-label="Filter by accreditation"><option value="">Any accreditation</option></select>
          <details class="dropdown">
            <summary class="btn">View</summary>
            <div class="dropdown-pop">
              <label class="check"><input type="checkbox" data-f="showStaff" /> Staff numbers</label>
              <label class="check"><input type="checkbox" data-f="showAcc" /> Accreditations</label>
              <label class="check"><input type="checkbox" data-f="showVacant" /> Vacant posts</label>
            </div>
          </details>
          <button class="btn" data-act="legend">Key</button>
          ${planner
            ? html`<button class="btn" data-act="rota">Apply rota…</button><button class="btn" data-act="export">Export</button>`
            : ''}
        </div>
      </div>
      <div class="grid-wrap" tabindex="0" aria-label="Duty plan grid"><table class="grid"></table></div>
      <div class="sheet" hidden></div>
    </section>`;

  const wrap = $('.grid-wrap', root);
  const table = $('.grid', root);
  const sheet = $('.sheet', root);

  // ---- toolbar wiring ----
  $('[data-f=span]', root).value = String(v.span);
  for (const k of ['showStaff', 'showAcc', 'showVacant']) $(`[data-f=${k}]`, root).checked = v[k];
  $('[data-f=acc]', root).insertAdjacentHTML(
    'beforeend',
    state.meta.accreditations.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join(''),
  );
  const renderTeamFilter = () => {
    $('.team-filter .dropdown-pop', root).innerHTML = html`
      <label class="check"><input type="checkbox" value="" ${v.teams.length ? '' : 'checked'} /> All teams</label>
      ${state.meta.teams.map((t) => html`<label class="check"><input type="checkbox" value="${t.id}" ${v.teams.includes(t.id) ? 'checked' : ''} /> ${t.name}</label>`)}`;
    $('.team-filter summary', root).textContent = v.teams.length ? `Teams (${v.teams.length})` : 'All teams';
  };
  renderTeamFilter();
  $('.team-filter', root).addEventListener('change', (e) => {
    const val = e.target.value;
    if (!val) v.teams = [];
    else {
      const id = Number(val);
      v.teams = e.target.checked ? [...new Set([...v.teams, id])] : v.teams.filter((x) => x !== id);
    }
    renderTeamFilter();
    persist();
    draw();
  });

  root.addEventListener('change', (e) => {
    const f = e.target.dataset.f;
    if (!f) return;
    if (f === 'span') {
      v.span = Number(e.target.value);
      persist();
      load();
    } else if (f === 'acc') {
      v.acc = e.target.value;
      draw();
    } else if (f.startsWith('show')) {
      v[f] = e.target.checked;
      persist();
      draw();
    }
  });
  $('[data-f=q]', root).addEventListener(
    'input',
    debounce((e) => {
      v.q = e.target.value.trim().toLowerCase();
      draw();
    }, 150),
  );
  $('.date-jump', root).addEventListener('change', (e) => {
    if (e.target.value) {
      v.start = startOfWeek(e.target.value);
      load();
    }
  });
  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'prev') shift(-1);
    else if (act === 'next') shift(1);
    else if (act === 'today') {
      v.start = startOfWeek(today);
      load().then(() => scrollToToday());
    } else if (act === 'legend') showLegend();
    else if (act === 'rota') showRota();
    else if (act === 'export') showExport();
  });
  const shift = (dir) => {
    v.start = addDays(v.start, dir * (v.span >= 28 ? 28 : v.span));
    load();
  };

  // ---- data ----
  async function load({ quiet = false } = {}) {
    const from = v.start;
    const to = addDays(v.start, v.span - 1);
    if (!quiet) table.innerHTML = '<tbody><tr><td class="loading">Loading…</td></tr></tbody>';
    try {
      const [roster, pd, pt] = await Promise.all([loadRoster(from, to), get(`/postings?from=${from}&to=${to}`).catch(() => ({ postings: [] })), postingTypes ? null : get('/posting-types').catch(() => ({ types: [] }))]);
      data = roster;
      if (pt) postingTypes = new Map(pt.types.map((t) => [t.id, t]));
      postEditTeams = new Set(pd.editableTeams || []);
      postVisTeams = new Set(pd.visibleTeams || []);
      postingAt = new Map(pd.postings.map((x) => [`${x.personId}|${x.date}`, x]));
      dates = eachDate(from, to);
      $('.range-label', root).textContent = `${fmtDate(from, 'dm')} – ${fmtDate(to, 'dmy')}`;
      $('.date-jump', root).value = from;
      draw({ keepSel: quiet });
    } catch (e) {
      table.innerHTML = html`<tbody><tr><td class="empty">${e.message}</td></tr></tbody>`;
    }
  }

  // Precomputed cell style per code.
  const styleCache = new Map();
  const cellStyle = (code) => {
    let st = styleCache.get(code);
    if (!st) {
      const info = codeInfo(code);
      st = `background:${info.color};color:${contrast(info.color)}`;
      styleCache.set(code, st);
    }
    return st;
  };

  function matches(p) {
    if (v.q && !`${p.name} ${p.initials || ''} ${p.staffNumber}`.toLowerCase().includes(v.q)) return false;
    if (v.acc && !p.acc[v.acc]) return false;
    return true;
  }

  function groups() {
    // In the postings view only teams whose postings you may see are shown.
    const teams = data.teams.filter((t) => (!v.teams.length || v.teams.includes(t.id)) && (!isPostings() || postVisTeams.has(t.id)));
    const known = new Set(data.teams.map((t) => t.id));
    const out = teams.map((t) => {
      const all = byRole(data.people.filter((p) => p.teamId === t.id));
      // Team leader and supervisors may come from other teams (someone can supervise several).
      const leads = data.people
        .map((p) => ({ p, role: (p.positions || []).find((x) => x.teamId === t.id)?.role }))
        .filter((x) => x.role);
      const guests = leads.filter((x) => x.p.teamId !== t.id && matches(x.p)).sort((a, b) => (ROLE_RANK[a.role] ?? 2) - (ROLE_RANK[b.role] ?? 2));
      return { team: t, people: all.filter(matches), members: all, leads, guests, vacancies: Math.max(0, t.establishment - all.length) };
    });
    if (!v.teams.length && !isPostings()) {
      const orphans = data.people.filter((p) => !known.has(p.teamId)).filter(matches);
      if (orphans.length) out.push({ team: { id: 0, name: 'No team', establishment: 0 }, people: orphans, vacancies: 0 });
    }
    const filtered = v.q || v.acc;
    return out.filter((g) => !filtered || g.people.length);
  }

  // Team leader first, then supervisors, then everyone else (keeping their order).
  const ROLE_RANK = { leader: 0, supervisor: 1 };
  const byRole = (list) => [...list].sort((a, b) => (ROLE_RANK[a.teamRole] ?? 2) - (ROLE_RANK[b.teamRole] ?? 2));
  const otherPositions = (p) =>
    (p.positions || [])
      .filter((x) => x.teamId !== p.teamId)
      .map((x) => `${x.role === 'leader' ? 'Team leader' : 'Supervisor'} of ${state.teamMap.get(x.teamId)?.name || 'another team'}`);
  // Short label for a team on badges: "Team 2" -> "T2", "Response Unit" -> "RU".
  const teamAbbr = (teamId) => {
    const name = state.teamMap.get(teamId)?.name || '';
    const m = name.match(/^team\s*(\w+)$/i);
    if (m) return `T${m[1]}`.slice(0, 4);
    return (name.split(/\s+/).filter(Boolean).map((w) => w[0]).join('') || '?').toUpperCase().slice(0, 3);
  };
  const roleBadge = (p) => {
    let out = '';
    if (p.teamRole === 'leader') out += `<span class="role role-leader" title="Team leader">TL</span>`;
    else if (p.teamRole === 'supervisor') out += `<span class="role role-sup" title="Supervisor">SUP</span>`;
    // One badge per position held in another team, e.g. "SUP·T2".
    for (const x of (p.positions || []).filter((x) => x.teamId !== p.teamId)) {
      const what = x.role === 'leader' ? 'TL' : 'SUP';
      const title = `${x.role === 'leader' ? 'Team leader' : 'Supervisor'} of ${state.teamMap.get(x.teamId)?.name || 'another team'}`;
      out += `<span class="role ${x.role === 'leader' ? 'role-leader' : 'role-sup'} role-other" title="${esc(title)}">${what}·${esc(teamAbbr(x.teamId))}</span>`;
    }
    return out;
  };
  /** A team's leader/supervisors from other teams, shown as linked rows in this team (view only). */
  const guestRowHtml = (p, role, fixed) => {
    let row = `<tr class="person guest"><th class="name" scope="row"><button class="linkish" data-person="${p.id}" title="${esc(`${role === 'leader' ? 'Team leader' : 'Supervisor'} of this team, from ${state.teamMap.get(p.teamId)?.name || 'another team'} - edit their duties in their own team`)}"><span class="ini">${esc(p.initials || '')}</span><span class="nm">${esc(p.name)}</span><span class="role ${role === 'leader' ? 'role-leader' : 'role-sup'}">${role === 'leader' ? 'TL' : 'SUP'}</span><small class="guest-from">${esc(teamAbbr(p.teamId))}</small></button></th>`;
    if (fixed > 1) row += `<td class="fx" colspan="${fixed - 1}"></td>`;
    for (const d of dates) row += guestCellHtml(p, d);
    return row + '</tr>';
  };
  const guestCellHtml = (p, d) =>
    cellHtml(p, d, 0, 0)
      .replace(/^<td class="c/, '<td class="c guest')
      .replace(/ data-r="\d+" data-c="\d+"/, ` data-gp="${p.id}" data-d="${d}"`);
  /** On-duty count for a team on a date, and whether its team leader / a supervisor is on duty. */
  function teamDay(g, d) {
    let n = 0;
    let leader = false;
    let sups = 0;
    for (const p of g.people) if (onDuty(data.cells.get(`${p.id}|${d}`)?.c ?? '')) n++;
    for (const { p, role } of g.leads || []) {
      if (!onDuty(data.cells.get(`${p.id}|${d}`)?.c ?? '')) continue;
      if (role === 'leader') leader = true;
      else sups++;
    }
    const hasRoles = (g.leads || []).length > 0;
    return { n, leader, sups, noSupervision: hasRoles && n > 0 && !leader && !sups };
  }
  const countTitle = (t, x, locked) =>
    [
      `${x.n} on duty${t.minStrength != null ? ` (minimum ${t.minStrength})` : ''}`,
      x.leader ? 'Team leader on duty' : null,
      x.sups ? `${x.sups} supervisor${x.sups > 1 ? 's' : ''} on duty` : null,
      x.noSupervision ? 'No team leader or supervisor on duty' : null,
      locked ? 'Leave lockdown for this team' : null,
    ]
      .filter(Boolean)
      .join(' · ');

  const onShift = (a) => !!a && a.c !== '*' && codeInfo(a.c).category === 'duty';
  const postStyleCache = new Map();
  const postStyle = (t) => {
    if (!postStyleCache.has(t.id)) postStyleCache.set(t.id, `background:${t.color};color:${contrast(t.color)}`);
    return postStyleCache.get(t.id);
  };
  const postLabel = (ps) => (ps.typeId != null ? postingTypes?.get(ps.typeId)?.short || '?' : '•');
  const postTitle = (ps) => [postingTypes?.get(ps.typeId)?.name || 'Posting', ps.time, ps.detail].filter(Boolean).join(' · ');

  // Postings view: the posting's short code in its colour; working but not posted shows the duty
  // code faintly; days off are greyed out.
  function postCellHtml(p, d, r, c) {
    const a = data.cells.get(`${p.id}|${d}`);
    const ps = postingAt.get(`${p.id}|${d}`);
    let cls = 'c pc';
    if (isWeekend(d)) cls += ' we';
    if (data.publicHolidays?.[d]) cls += ' ph';
    if (d === today) cls += ' td';
    const duty = onShift(a);
    if (ps) {
      const t = postingTypes?.get(ps.typeId);
      const label = postLabel(ps);
      if (label.length > 3) cls += ' long';
      if (ps.time || ps.detail) cls += ' note';
      if (!duty) cls += ' offwarn';
      const title = `${postTitle(ps)}${duty ? '' : '\nNot on duty this day'}`;
      return `<td class="${cls}" data-r="${r}" data-c="${c}"${t ? ` style="${postStyle(t)}"` : ''} title="${esc(title)}">${esc(label)}</td>`;
    }
    if (duty) return `<td class="${cls} unposted" data-r="${r}" data-c="${c}" title="${esc(codeInfo(a.c).label)} - not posted">${esc(a.c)}</td>`;
    const label = a ? (a.c === '*' ? '–' : a.c) : '';
    return `<td class="${cls} off" data-r="${r}" data-c="${c}"${a ? ` title="${esc(a.c === '*' ? 'Unavailable' : codeInfo(a.c).label)}"` : ''}>${esc(label)}</td>`;
  }
  /** Postings view count: people posted / people on duty. */
  function postCount(people, d) {
    let on = 0;
    let posted = 0;
    for (const p of people) {
      const a = data.cells.get(`${p.id}|${d}`);
      if (!onShift(a)) continue;
      on++;
      if (postingAt.has(`${p.id}|${d}`)) posted++;
    }
    return { on, posted };
  }

  function cellHtml(p, d, r, c) {
    if (isPostings()) return postCellHtml(p, d, r, c);
    const a = data.cells.get(`${p.id}|${d}`);
    let cls = 'c';
    if (isWeekend(d)) cls += ' we';
    if (data.publicHolidays?.[d]) cls += ' ph';
    if (d === today) cls += ' td';
    if (!a) return `<td class="${cls}" data-r="${r}" data-c="${c}"></td>`;
    if (a.n) cls += ' note';
    if (a.c.length > 3) cls += ' long';
    if (a.c === '*') cls += ' masked';
    const info = codeInfo(a.c);
    const ps = postingAt.get(`${p.id}|${d}`);
    if (ps) cls += ' posted';
    const title = `${info.label}${a.n ? ' - ' + a.n : ''}${ps ? `\nPosting: ${[postingTypes?.get(ps.typeId)?.name, ps.time, ps.detail].filter(Boolean).join(' · ')}` : ''}`;
    return `<td class="${cls}" data-r="${r}" data-c="${c}" style="${cellStyle(a.c)}" title="${esc(title)}">${a.c === '*' ? '–' : esc(a.c)}</td>`;
  }

  function draw({ keepSel = false } = {}) {
    if (!data) return;
    if (!keepSel) setSel(null);
    const accs = v.showAcc ? state.meta.accreditations : [];
    const fixed = 1 + (v.showStaff ? 1 : 0) + accs.length;
    let h = '<thead><tr><th class="name corner" rowspan="2">Name</th>';
    if (v.showStaff) h += '<th class="fx" rowspan="2">Staff no</th>';
    for (const a of accs) h += `<th class="fx acc-h" rowspan="2" title="${esc(a.name)}"><span>${esc(a.code)}</span></th>`;
    // Month band
    let i = 0;
    while (i < dates.length) {
      const m = dates[i].slice(0, 7);
      let n = 0;
      while (i + n < dates.length && dates[i + n].slice(0, 7) === m) n++;
      h += `<th class="month" colspan="${n}"><span>${esc(fmtDate(dates[i], 'my'))}</span></th>`;
      i += n;
    }
    h += '</tr><tr>';
    // Lockdowns that apply to the teams on screen (all-team lockdowns, or one of the visible teams).
    const shownTeams = v.teams.length ? v.teams : data.teams.map((t) => t.id);
    const locksOn = (d, teamId) =>
      (data.lockdowns || []).filter((l) => l.start <= d && l.end >= d && (l.teamId == null || (teamId != null ? l.teamId === teamId : shownTeams.includes(l.teamId))));
    for (const d of dates) {
      const hol = data.publicHolidays?.[d];
      const locks = locksOn(d);
      const title = [hol, ...locks.map((l) => `Leave lockdown: ${l.name}`)].filter(Boolean).join(' · ');
      h += `<th class="d${isWeekend(d) ? ' we' : ''}${d === today ? ' td' : ''}${hol ? ' ph' : ''}${locks.length ? ' lock' : ''}" data-date="${d}"${
        title ? ` title="${esc(title)}"` : ''
      }><span>${hol ? 'Hol' : esc(fmtDate(d, 'dow').slice(0, 2))}</span><b>${dayNum(d)}</b></th>`;
    }
    h += '</tr></thead>';

    personRows = [];
    drawnGroups = [];
    const totals = new Array(dates.length).fill(0);
    const postTotals = dates.map(() => ({ on: 0, posted: 0 }));
    let body = '';
    for (const g of groups()) {
      drawnGroups.push(g);
      const t = g.team;
      const days = dates.map((d) => teamDay(g, d));
      const counts = days.map((x) => x.n);
      counts.forEach((n, ci) => (totals[ci] += n));
      const leader = (g.leads || []).find((x) => x.role === 'leader')?.p;
      const sups = (g.leads || []).filter((x) => x.role === 'supervisor').map((x) => x.p);
      const roleLine = [leader ? `TL ${leader.initials || leader.name}` : null, sups.length ? `${sups.length} SUP` : null].filter(Boolean).join(' · ');
      const roleTitle = [leader ? `Team leader: ${leader.name}` : 'No team leader set', sups.length ? `Supervisors: ${sups.map((p) => p.name).join(', ')}` : 'No supervisors set'].join('\n');
      const allMembers = data.people.filter((p) => p.teamId === t.id).length;
      body += `<tbody class="team"><tr class="team-row"><th class="name" scope="rowgroup"><div class="team-name" title="${esc(roleTitle)}">${esc(t.name)}</div><div class="team-meta">${allMembers}${t.establishment ? `/${t.establishment}` : ''}${g.vacancies ? ` · <span class="vac">${g.vacancies} vacant</span>` : ''}${roleLine ? ` · <span class="team-roles">${esc(roleLine)}</span>` : ''}</div></th>`;
      if (fixed > 1) body += `<td class="fx" colspan="${fixed - 1}"></td>`;
      if (isPostings()) {
        dates.forEach((d, ci) => {
          const x = postCount(g.people, d);
          postTotals[ci].on += x.on;
          postTotals[ci].posted += x.posted;
          body += `<td class="cnt${isWeekend(d) ? ' we' : ''}${x.posted < x.on ? ' unposted-cnt' : ''}" title="${x.posted} of ${x.on} on duty posted">${x.on ? `${x.posted}/${x.on}` : ''}</td>`;
        });
      } else counts.forEach((n, ci) => {
        const low = t.minStrength != null && n < t.minStrength;
        const teamLocked = (data.lockdowns || []).some((l) => l.teamId === t.id && l.start <= dates[ci] && l.end >= dates[ci]);
        body += `<td class="cnt${low ? ' low' : ''}${isWeekend(dates[ci]) ? ' we' : ''}${teamLocked ? ' lock' : ''}${days[ci].noSupervision ? ' nosup' : ''}" title="${esc(countTitle(t, days[ci], teamLocked))}">${n}</td>`;
      });
      body += '</tr>';
      for (const { p, role } of g.guests || []) body += guestRowHtml(p, role, fixed);
      for (const p of g.people) {
        const r = personRows.length;
        personRows.push(p);
        body += `<tr class="person${p.id === myId ? ' me' : ''}${p.teamRole ? ` r-${p.teamRole}` : ''}"><th class="name" scope="row" data-pid="${p.id}"><button class="linkish" data-person="${p.id}"><span class="ini">${esc(p.initials || '')}</span><span class="nm">${esc(p.name)}</span>${roleBadge(p)}</button></th>`;
        if (v.showStaff) body += `<td class="fx">${esc(p.staffNumber)}</td>`;
        for (const a of accs) {
          const st = accStatus(p.acc[a.id], today);
          body += `<td class="fx acc ${st || ''}" title="${esc(a.name)}${p.acc[a.id]?.e ? ' - expires ' + p.acc[a.id].e : ''}">${st ? (st === 'expired' ? '✗' : '✓') : ''}</td>`;
        }
        dates.forEach((d, c) => (body += cellHtml(p, d, r, c)));
        body += '</tr>';
      }
      if (v.showVacant && !(v.q || v.acc))
        for (let k = 0; k < g.vacancies; k++) {
          body += `<tr class="vacant"><th class="name" scope="row">Vacant</th>${fixed > 1 ? `<td class="fx" colspan="${fixed - 1}"></td>` : ''}`;
          for (const d of dates) body += `<td class="v${isWeekend(d) ? ' we' : ''}"></td>`;
          body += '</tr>';
        }
      body += '</tbody>';
    }
    if (!personRows.length && !body) body = `<tbody><tr><td class="empty" colspan="${fixed + dates.length}">No people match the current filters.</td></tr></tbody>`;
    let foot = `<tfoot><tr><th class="name">${isPostings() ? 'Posted / on duty' : 'On duty'}</th>${fixed > 1 ? `<td class="fx" colspan="${fixed - 1}"></td>` : ''}`;
    if (isPostings()) postTotals.forEach((x, ci) => (foot += `<td class="cnt${isWeekend(dates[ci]) ? ' we' : ''}${x.posted < x.on ? ' unposted-cnt' : ''}">${x.on ? `${x.posted}/${x.on}` : ''}</td>`));
    else totals.forEach((n, ci) => (foot += `<td class="cnt${isWeekend(dates[ci]) ? ' we' : ''}">${n}</td>`));
    foot += '</tr></tfoot>';
    if (isPostings() && !drawnGroups.length)
      body = `<tbody><tr><td class="empty" colspan="${fixed + dates.length}">Postings are private to each team - there are no teams here whose postings you can see.</td></tr></tbody>`;
    table.innerHTML = h + body + foot;
    table.classList.toggle('editable', canEditLayer());
    table.classList.toggle('postings', isPostings());
    for (const b of root.querySelectorAll('[data-layer]')) b.classList.toggle('btn-primary', b.dataset.layer === v.layer);
    cellEls = $$('td.c:not(.guest)', table);
    rowOf = new Map(personRows.map((p, i) => [p.id, i]));
    colOf = new Map(dates.map((d, i) => [d, i]));
    const teamCnt = $$('tbody.team', table).map((tb) => $$('tr.team-row td.cnt', tb));
    drawnGroups.forEach((g, i) => (g.cntEls = teamCnt[i]));
    totalEls = $$('tfoot td.cnt', table);
    if (keepSel && sel) setSel(clampSel(sel));
  }

  // Update just the changed cells and the strength counts (fast path for edits).
  function patchCells(list) {
    const cols = new Set();
    for (const ch of list) {
      const r = rowOf.get(ch.personId),
        c = colOf.get(ch.date);
      if (r == null || c == null) continue;
      const idx = r * dates.length + c;
      const old = cellEls[idx];
      const tmp = document.createElement('tbody');
      tmp.innerHTML = `<tr>${cellHtml(personRows[r], ch.date, r, c)}</tr>`;
      const el = tmp.firstChild.firstChild;
      if (old.classList.contains('sel')) {
        el.classList.add('sel');
        selected[selected.indexOf(old)] = el;
      }
      old.replaceWith(el);
      cellEls[idx] = el;
      cols.add(c);
      for (const g of table.querySelectorAll(`td.guest[data-gp="${ch.personId}"][data-d="${ch.date}"]`)) g.outerHTML = guestCellHtml(personRows[r], ch.date);
    }
    if (isPostings()) {
      for (const c of cols) {
        const tot = { on: 0, posted: 0 };
        for (const g of drawnGroups) {
          const x = postCount(g.people, dates[c]);
          tot.on += x.on;
          tot.posted += x.posted;
          const el = g.cntEls?.[c];
          if (el) {
            el.textContent = x.on ? `${x.posted}/${x.on}` : '';
            el.classList.toggle('unposted-cnt', x.posted < x.on);
            el.title = `${x.posted} of ${x.on} on duty posted`;
          }
        }
        if (totalEls[c]) {
          totalEls[c].textContent = tot.on ? `${tot.posted}/${tot.on}` : '';
          totalEls[c].classList.toggle('unposted-cnt', tot.posted < tot.on);
        }
      }
      return;
    }
    for (const c of cols) {
      let total = 0;
      for (const g of drawnGroups) {
        const x = teamDay(g, dates[c]);
        const n = x.n;
        total += n;
        const el = g.cntEls?.[c];
        if (el) {
          el.textContent = n;
          el.classList.toggle('low', g.team.minStrength != null && n < g.team.minStrength);
          el.classList.toggle('nosup', x.noSupervision);
          el.title = countTitle(g.team, x, el.classList.contains('lock'));
        }
      }
      if (totalEls[c]) totalEls[c].textContent = total;
    }
  }

  const clampSel = (s) => {
    if (!personRows.length) return null;
    const R = personRows.length - 1,
      C = dates.length - 1;
    const f = (x, m) => Math.max(0, Math.min(m, x));
    return { r0: f(s.r0, R), c0: f(s.c0, C), r1: f(s.r1, R), c1: f(s.c1, C) };
  };

  function scrollToToday() {
    const th = $(`th.d[data-date="${today}"]`, table);
    if (th) wrap.scrollLeft = Math.max(0, th.offsetLeft - $('th.corner', table).offsetWidth - 40);
  }

  // ---- selection ----
  const rect = (s) => ({ r0: Math.min(s.r0, s.r1), r1: Math.max(s.r0, s.r1), c0: Math.min(s.c0, s.c1), c1: Math.max(s.c0, s.c1) });
  let selected = [];
  function setSel(s) {
    for (const el of selected) el.classList.remove('sel');
    selected = [];
    sel = s;
    if (s) {
      const { r0, r1, c0, c1 } = rect(s);
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++) {
          const el = cellEls[r * dates.length + c];
          if (el) {
            el.classList.add('sel');
            selected.push(el);
          }
        }
    }
    typed = '';
    renderSheet();
  }
  const selCells = () => {
    if (!sel) return [];
    const { r0, r1, c0, c1 } = rect(sel);
    const out = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push({ p: personRows[r], d: dates[c], r, c });
    return out;
  };

  table.addEventListener('pointerdown', (e) => {
    const td = e.target.closest('td.c');
    if (td?.classList.contains('guest')) {
      toast(`${data.peopleById.get(Number(td.dataset.gp))?.name || 'This person'} is from another team - change their ${isPostings() ? 'postings' : 'duties'} in their own team's rows`, 'info', 4000);
      return;
    }
    if (!td || e.button > 0) return;
    const r = Number(td.dataset.r),
      c = Number(td.dataset.c);
    if (!canEditLayer()) {
      setSel({ r0: r, c0: c, r1: r, c1: c });
      return;
    }
    if ((e.shiftKey || extendMode) && sel) {
      setSel({ ...sel, r1: r, c1: c });
      extendMode = false;
      renderSheet();
    } else {
      setSel({ r0: r, c0: c, r1: r, c1: c });
      if (e.pointerType === 'mouse') {
        dragging = true;
        e.preventDefault();
      }
    }
    wrap.focus({ preventScroll: true });
  });
  table.addEventListener('pointerover', (e) => {
    if (!dragging) return;
    const td = e.target.closest('td.c:not(.guest)');
    if (td && sel) {
      const r = Number(td.dataset.r),
        c = Number(td.dataset.c);
      if (r !== sel.r1 || c !== sel.c1) setSel({ ...sel, r1: r, c1: c });
    }
  });
  const stopDrag = () => (dragging = false);
  window.addEventListener('pointerup', stopDrag);

  table.addEventListener('click', (e) => {
    const b = e.target.closest('[data-person]');
    if (b) showPerson(Number(b.dataset.person));
  });

  // ---- bottom sheet (cell info / edit palette) ----
  function renderSheet() {
    if (!sel) {
      sheet.hidden = true;
      return;
    }
    const cells = selCells();
    sheet.hidden = false;
    if (isPostings()) return renderPostingSheet(cells);
    if (!planner || !cells.length) {
      const { p, d } = cells[0] || {};
      if (!p) return (sheet.hidden = true);
      const a = data.cells.get(`${p.id}|${d}`);
      const info = a ? codeInfo(a.c) : null;
      sheet.innerHTML = html`<div class="sheet-row">
        <div><strong>${p.name}</strong><div class="muted">${fmtDate(d, 'long')}</div></div>
        ${info ? html`<span class="chip" style="${cellStyle(a.c)}">${a.c === '*' ? '–' : a.c}</span><span>${info.label}</span>` : html`<span class="muted">Nothing planned</span>`}
        ${a?.n ? html`<span class="note-text">${a.n}</span>` : ''}
        <div class="spacer"></div><button class="btn icon-btn" data-sheet="close" aria-label="Close">✕</button></div>`;
      return;
    }
    const { r0, r1, c0, c1 } = rect(sel);
    const n = cells.length;
    const desc =
      n === 1
        ? `${cells[0].p.name} · ${fmtDate(cells[0].d, 'dow')} ${fmtDate(cells[0].d, 'dm')}`
        : `${r1 - r0 + 1} ${r1 > r0 ? 'people' : 'person'} × ${c1 - c0 + 1} day${c1 > c0 ? 's' : ''}`;
    const single = n === 1 ? data.cells.get(`${cells[0].p.id}|${cells[0].d}`) : null;
    sheet.innerHTML = html`
      <div class="sheet-row">
        <strong>${desc}</strong>
        ${single?.n ? html`<span class="note-text">📝 ${single.n}</span>` : ''}
        ${typed ? html`<span class="typed">Code: <b>${typed}</b> ⏎</span>` : ''}
        <div class="spacer"></div>
        <button class="btn btn-sm ${extendMode ? 'btn-primary' : ''}" data-sheet="extend" title="Tap another cell to extend the selection">Extend</button>
        <button class="btn btn-sm" data-sheet="note">Note</button>
        <button class="btn btn-sm" data-sheet="copy">Copy</button>
        <button class="btn btn-sm" data-sheet="paste">Paste</button>
        <button class="btn btn-sm" data-sheet="undo" ${undo.length ? '' : 'disabled'}>Undo</button>
        <button class="btn icon-btn" data-sheet="close" aria-label="Close">✕</button>
      </div>
      <div class="codes">
        ${state.meta.dutyCodes.map((c) => html`<button class="code-btn" data-code="${c.code}" style="${cellStyle(c.code)}" title="${c.label}">${c.code}</button>`)}
        <button class="code-btn clear" data-code="" title="Clear">Clear</button>
      </div>`;
  }

  sheet.addEventListener('click', async (e) => {
    const postBtn = e.target.closest('[data-post]');
    if (postBtn) return applyPosting(postBtn.dataset.post ? Number(postBtn.dataset.post) : null);
    const codeBtn = e.target.closest('[data-code]');
    if (codeBtn) return applyCode(codeBtn.dataset.code || null);
    const act = e.target.closest('[data-sheet]')?.dataset.sheet;
    if (act === 'close') setSel(null);
    else if (act === 'extend') {
      extendMode = !extendMode;
      renderSheet();
    } else if (act === 'note') (isPostings() ? editPostingDetail() : editNote());
    else if (act === 'undo') doUndo();
    else if (act === 'copy') {
      try {
        await navigator.clipboard.writeText(selectionTsv());
        toast('Copied');
      } catch {
        toast('Copy not available - use Ctrl+C', 'warn');
      }
    } else if (act === 'paste') {
      try {
        pasteText(await navigator.clipboard.readText());
      } catch {
        toast('Paste not available - use Ctrl+V', 'warn');
      }
    }
  });

  // ---- editing ----
  async function commit(changes, { record = true, moveRight = false } = {}) {
    if (!changes.length) return;
    if (document.body.classList.contains('is-offline')) return toast('You are offline - changes cannot be saved', 'error');
    const prev = changes.map((ch) => {
      const cur = data.cells.get(`${ch.personId}|${ch.date}`);
      return { personId: ch.personId, date: ch.date, code: cur?.c ?? null, note: cur?.n ?? null };
    });
    const applyLocal = (list) => {
      for (const ch of list) {
        const k = `${ch.personId}|${ch.date}`;
        if (ch.code) data.cells.set(k, ch.note ? { c: ch.code, n: ch.note } : { c: ch.code });
        else data.cells.delete(k);
      }
      patchCells(list);
      renderSheet();
    };
    applyLocal(changes);
    if (moveRight && sel && sel.r0 === sel.r1 && sel.c0 === sel.c1 && sel.c0 < dates.length - 1) setSel({ r0: sel.r0, r1: sel.r0, c0: sel.c0 + 1, c1: sel.c0 + 1 });
    try {
      await put('/assignments', { changes });
      if (record) {
        undo.push({ kind: 'duties', list: prev });
        if (undo.length > 50) undo.shift();
        renderSheet();
      }
    } catch (e) {
      applyLocal(prev);
      toast(e.message, 'error');
    }
  }

  function applyCode(code, opts) {
    const changes = selCells().map(({ p, d }) => ({
      personId: p.id,
      date: d,
      code,
      note: code ? data.cells.get(`${p.id}|${d}`)?.n ?? null : null,
    }));
    commit(changes, opts);
  }

  function doUndo() {
    const last = undo.pop();
    if (!last) return toast('Nothing to undo');
    if (last.kind === 'postings') commitPostings(last.list, { record: false }).then(renderSheet);
    else commit(last.list, { record: false }).then(renderSheet);
  }

  async function editNote() {
    const cells = selCells().filter(({ p, d }) => data.cells.get(`${p.id}|${d}`));
    if (!cells.length) return toast('Add a duty code before adding a note', 'warn');
    const first = data.cells.get(`${cells[0].p.id}|${cells[0].d}`);
    const d = dialog('Note', html`<label>Note for ${cells.length} cell${cells.length > 1 ? 's' : ''}<textarea name="note" rows="3" maxlength="500">${first.n || ''}</textarea></label>`, {
      actions: '<button value="cancel" class="btn" formnovalidate>Cancel</button><button value="ok" class="btn btn-primary">Save</button>',
    });
    const ta = $('textarea', d);
    ta.focus();
    if ((await d.closed) !== 'ok') return;
    const note = ta.value.trim() || null;
    commit(cells.map(({ p, d: date }) => ({ personId: p.id, date, code: data.cells.get(`${p.id}|${date}`).c, note })));
  }

  function selectionTsv() {
    if (!sel) return '';
    const { r0, r1, c0, c1 } = rect(sel);
    const lines = [];
    for (let r = r0; r <= r1; r++) {
      const row = [];
      for (let c = c0; c <= c1; c++) {
        if (isPostings()) {
          const ps = postingAt.get(`${personRows[r].id}|${dates[c]}`);
          row.push(ps ? postingTypes?.get(ps.typeId)?.short ?? '' : '');
        } else row.push(data.cells.get(`${personRows[r].id}|${dates[c]}`)?.c ?? '');
      }
      lines.push(row.join('\t'));
    }
    return lines.join('\n');
  }

  function pasteText(text) {
    if (!sel || !text) return;
    if (isPostings()) return pastePostings(text);
    const grid = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map((l) => l.split('\t').map((x) => x.trim()));
    const bad = new Set();
    const norm = grid.map((row) =>
      row.map((x) => {
        if (!x) return null;
        const info = state.codeMap.get(x.toLowerCase());
        if (!info) bad.add(x);
        return info?.code ?? null;
      }),
    );
    if (bad.size) return toast(`Unknown codes: ${[...bad].slice(0, 5).join(', ')}`, 'error');
    const { r0, r1, c0, c1 } = rect(sel);
    const gh = norm.length,
      gw = Math.max(...norm.map((r) => r.length));
    const single = r0 === r1 && c0 === c1;
    const rows = single ? gh : r1 - r0 + 1;
    const cols = single ? gw : c1 - c0 + 1;
    const changes = [];
    for (let i = 0; i < rows && r0 + i < personRows.length; i++)
      for (let j = 0; j < cols && c0 + j < dates.length; j++) {
        const code = norm[i % gh][j % gw] ?? null;
        const p = personRows[r0 + i];
        changes.push({ personId: p.id, date: dates[c0 + j], code, note: code ? data.cells.get(`${p.id}|${dates[c0 + j]}`)?.n ?? null : null });
      }
    setSel({ r0, c0, r1: Math.min(personRows.length - 1, r0 + rows - 1), c1: Math.min(dates.length - 1, c0 + cols - 1) });
    commit(changes);
  }

  // ---- postings view: editing ----
  function renderPostingSheet(cells) {
    const editable = cells.filter((x) => canEditRow(x.p));
    if (!editable.length) {
      const { p, d } = cells[0] || {};
      if (!p) return (sheet.hidden = true);
      const ps = postingAt.get(`${p.id}|${d}`);
      const a = data.cells.get(`${p.id}|${d}`);
      sheet.innerHTML = html`<div class="sheet-row">
        <div><strong>${p.name}</strong><div class="muted">${fmtDate(d, 'long')}${a ? ` · ${a.c === '*' ? 'Unavailable' : codeInfo(a.c).label}` : ''}</div></div>
        ${ps ? html`<span class="posting-tag" style="${postingTypes?.get(ps.typeId) ? postStyle(postingTypes.get(ps.typeId)) : ''}">${postingTypes?.get(ps.typeId)?.name || 'Posting'}</span>${ps.time ? html` <b>${ps.time}</b>` : ''}${ps.detail ? html` <span class="note-text">${ps.detail}</span>` : ''}` : html`<span class="muted">No posting</span>`}
        <div class="spacer"></div><button class="btn icon-btn" data-sheet="close" aria-label="Close">✕</button></div>`;
      return;
    }
    const { r0, r1, c0, c1 } = rect(sel);
    const n = cells.length;
    const one = n === 1 ? postingAt.get(`${cells[0].p.id}|${cells[0].d}`) : null;
    const desc =
      n === 1
        ? `${cells[0].p.name} · ${fmtDate(cells[0].d, 'dow')} ${fmtDate(cells[0].d, 'dm')}`
        : `${r1 - r0 + 1} ${r1 > r0 ? 'people' : 'person'} × ${c1 - c0 + 1} day${c1 > c0 ? 's' : ''}`;
    const types = [...(postingTypes?.values() || [])].filter((t) => t.active).sort((a, b) => a.sortOrder - b.sortOrder);
    sheet.innerHTML = html`
      <div class="sheet-row">
        <strong>${desc}</strong>
        ${one ? html`<span class="note-text">${postTitle(one)}</span>` : ''}
        ${editable.length < n ? html`<span class="muted small">${n - editable.length} cell${n - editable.length > 1 ? 's' : ''} in teams you can't post</span>` : ''}
        ${typed ? html`<span class="typed">Posting: <b>${typed}</b> ⏎</span>` : ''}
        <div class="spacer"></div>
        <button class="btn btn-sm ${extendMode ? 'btn-primary' : ''}" data-sheet="extend" title="Tap another cell to extend the selection">Extend</button>
        <button class="btn btn-sm" data-sheet="note">Time &amp; detail</button>
        <button class="btn btn-sm" data-sheet="copy">Copy</button>
        <button class="btn btn-sm" data-sheet="paste">Paste</button>
        <button class="btn btn-sm" data-sheet="undo" ${undo.length ? '' : 'disabled'}>Undo</button>
        <button class="btn icon-btn" data-sheet="close" aria-label="Close">✕</button>
      </div>
      <div class="codes">
        ${types.map((t) => html`<button class="code-btn" data-post="${t.id}" style="${postStyle(t)}" title="${t.name}">${t.short}</button>`)}
        <button class="code-btn clear" data-post="" title="Clear posting">Clear</button>
      </div>`;
  }

  async function commitPostings(changes, { record = true, moveRight = false } = {}) {
    if (!changes.length) return;
    if (document.body.classList.contains('is-offline')) return toast('You are offline - changes cannot be saved', 'error');
    const prev = changes.map((ch) => {
      const cur = postingAt.get(`${ch.personId}|${ch.date}`);
      return { personId: ch.personId, date: ch.date, typeId: cur?.typeId ?? null, time: cur?.time ?? null, detail: cur?.detail ?? null };
    });
    const applyLocal = (list) => {
      for (const ch of list) {
        const k = `${ch.personId}|${ch.date}`;
        if (ch.typeId == null && !ch.time && !ch.detail) postingAt.delete(k);
        else postingAt.set(k, { personId: ch.personId, date: ch.date, typeId: ch.typeId, time: ch.time || null, detail: ch.detail || null });
      }
      patchCells(list);
      renderSheet();
    };
    applyLocal(changes);
    if (moveRight && sel && sel.r0 === sel.r1 && sel.c0 === sel.c1 && sel.c0 < dates.length - 1) setSel({ r0: sel.r0, r1: sel.r0, c0: sel.c0 + 1, c1: sel.c0 + 1 });
    try {
      await put('/postings', { changes });
      if (record) {
        undo.push({ kind: 'postings', list: prev });
        if (undo.length > 50) undo.shift();
        renderSheet();
      }
    } catch (e) {
      applyLocal(prev);
      toast(e.message, 'error');
    }
  }

  /** Give the selected cells a posting type (null clears). Only people on duty get a posting. */
  function applyPosting(typeId, opts) {
    let skippedTeam = 0;
    let skippedOff = 0;
    const changes = [];
    for (const { p, d } of selCells()) {
      if (!canEditRow(p)) {
        skippedTeam++;
        continue;
      }
      const cur = postingAt.get(`${p.id}|${d}`);
      if (typeId == null) {
        if (cur) changes.push({ personId: p.id, date: d, typeId: null, time: null, detail: null });
        continue;
      }
      if (!onShift(data.cells.get(`${p.id}|${d}`))) {
        skippedOff++;
        continue;
      }
      // Changing the type keeps any time/detail already set.
      changes.push({ personId: p.id, date: d, typeId, time: cur?.time ?? null, detail: cur?.detail ?? null });
    }
    const notes = [skippedOff && `${skippedOff} not on duty`, skippedTeam && `${skippedTeam} in teams you can't post`].filter(Boolean);
    if (notes.length) toast(`Skipped ${notes.join(' and ')}`, 'warn');
    commitPostings(changes, opts);
  }

  async function editPostingDetail() {
    const cells = selCells().filter(({ p, d }) => canEditRow(p) && (postingAt.has(`${p.id}|${d}`) || onShift(data.cells.get(`${p.id}|${d}`))));
    if (!cells.length) return toast('Select cells for people on duty in a team you can post', 'warn');
    const first = postingAt.get(`${cells[0].p.id}|${cells[0].d}`) || {};
    const d = dialog(
      'Time and detail',
      html`<div class="form-grid">
        <label>Time <small class="muted">(optional)</small><input type="time" name="time" value="${first.time || ''}" /></label>
        <span></span>
        <label class="span2">Detail <small class="muted">(optional)</small><input name="detail" maxlength="200" value="${first.detail || ''}" placeholder="e.g. Statement - 4 Example Road" /></label>
        <p class="span2 muted small">Applies to ${cells.length} cell${cells.length > 1 ? 's' : ''}; their posting types stay as they are.</p>
      </div>`,
      { actions: '<button value="cancel" class="btn" formnovalidate>Cancel</button><button value="ok" class="btn btn-primary">Save</button>' },
    );
    const f = $('form', d);
    f.detail.focus();
    if ((await d.closed) !== 'ok') return;
    commitPostings(
      cells.map(({ p, d: date }) => ({ personId: p.id, date, typeId: postingAt.get(`${p.id}|${date}`)?.typeId ?? null, time: f.time.value || null, detail: f.detail.value.trim() || null })),
    );
  }

  const typeByShort = (x) => {
    const k = String(x).trim().toLowerCase();
    return [...(postingTypes?.values() || [])].find((t) => t.short.toLowerCase() === k || t.name.toLowerCase() === k);
  };
  function pastePostings(text) {
    const grid = text.replace(/\r/g, '').replace(/\n$/, '').split('\n').map((l) => l.split('\t').map((x) => x.trim()));
    const bad = new Set();
    const norm = grid.map((row) => row.map((x) => (x ? typeByShort(x)?.id ?? (bad.add(x), null) : null)));
    if (bad.size) return toast(`Unknown postings: ${[...bad].slice(0, 5).join(', ')}`, 'error');
    const { r0, r1, c0, c1 } = rect(sel);
    const gh = norm.length,
      gw = Math.max(...norm.map((r) => r.length));
    const single = r0 === r1 && c0 === c1;
    const rows = single ? gh : r1 - r0 + 1;
    const cols = single ? gw : c1 - c0 + 1;
    const changes = [];
    let skipped = 0;
    for (let i = 0; i < rows && r0 + i < personRows.length; i++)
      for (let j = 0; j < cols && c0 + j < dates.length; j++) {
        const p = personRows[r0 + i];
        const d = dates[c0 + j];
        const typeId = norm[i % gh][j % gw] ?? null;
        if (!canEditRow(p) || (typeId != null && !onShift(data.cells.get(`${p.id}|${d}`)))) {
          skipped++;
          continue;
        }
        const cur = postingAt.get(`${p.id}|${d}`);
        changes.push({ personId: p.id, date: d, typeId, time: typeId == null ? null : cur?.time ?? null, detail: typeId == null ? null : cur?.detail ?? null });
      }
    if (skipped) toast(`Skipped ${skipped} cell${skipped > 1 ? 's' : ''} (not on duty, or a team you can't post)`, 'warn');
    setSel({ r0, c0, r1: Math.min(personRows.length - 1, r0 + rows - 1), c1: Math.min(dates.length - 1, c0 + cols - 1) });
    commitPostings(changes);
  }

  // Typing a posting's short code (e.g. "drv") applies it, like duty codes in the duties view.
  function postingKey(e) {
    if (e.key === 'Delete' || (e.key === 'Backspace' && !typed)) {
      e.preventDefault();
      return applyPosting(null);
    }
    if (e.key === 'Backspace') {
      typed = typed.slice(0, -1);
      return renderSheet();
    }
    const shorts = [...(postingTypes?.values() || [])].filter((t) => t.active).map((t) => t.short.toLowerCase());
    if (e.key === 'Enter' && typed) {
      e.preventDefault();
      const t = typeByShort(typed);
      if (t) applyPosting(t.id, { moveRight: true });
      else toast(`Unknown posting "${typed}"`, 'error');
      typed = '';
      return renderSheet();
    }
    if (/^[\w/-]$/.test(e.key)) {
      e.preventDefault();
      typed += e.key;
      const k = typed.toLowerCase();
      const exact = shorts.includes(k);
      const longer = shorts.some((x) => x.startsWith(k) && x !== k);
      if (exact && !longer) {
        const t = typeByShort(k);
        typed = '';
        applyPosting(t.id, { moveRight: true });
      } else renderSheet();
    }
  }

  root.addEventListener('click', (e) => {
    const layer = e.target.closest('[data-layer]')?.dataset.layer;
    if (!layer || layer === v.layer) return;
    v.layer = layer;
    typed = '';
    persist();
    draw();
  });

  const inField = (e) => e.target.closest('input, textarea, select, dialog, [contenteditable]');
  const onKey = (e) => {
    if (inField(e) || !sel || !data) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && canEditLayer()) {
      e.preventDefault();
      return doUndo();
    }
    if (mod) return;
    const R = personRows.length - 1,
      C = dates.length - 1;
    const mv = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
    if (mv) {
      e.preventDefault();
      const r = Math.max(0, Math.min(R, sel.r1 + mv[0]));
      const c = Math.max(0, Math.min(C, sel.c1 + mv[1]));
      setSel(e.shiftKey && canEditLayer() ? { ...sel, r1: r, c1: c } : { r0: r, c0: c, r1: r, c1: c });
      cellEls[r * dates.length + c]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return;
    }
    if (e.key === 'Escape') return setSel(null);
    if (!canEditLayer()) return;
    if (isPostings()) return postingKey(e);
    if (e.key === 'Delete' || (e.key === 'Backspace' && !typed)) {
      e.preventDefault();
      return applyCode(null);
    }
    if (e.key === 'Backspace') {
      typed = typed.slice(0, -1);
      return renderSheet();
    }
    if (e.key === 'Enter' && typed) {
      e.preventDefault();
      const info = state.codeMap.get(typed.toLowerCase());
      if (info) applyCode(info.code, { moveRight: true });
      else toast(`Unknown code "${typed}"`, 'error');
      typed = '';
      return renderSheet();
    }
    if (/^[\w/-]$/.test(e.key)) {
      e.preventDefault();
      typed += e.key;
      const t = typed.toLowerCase();
      const exact = state.codeMap.get(t);
      const longer = state.meta.dutyCodes.some((c) => c.code.toLowerCase().startsWith(t) && c.code.toLowerCase() !== t);
      if (exact && !longer) {
        typed = '';
        applyCode(exact.code, { moveRight: true });
      } else renderSheet();
    }
  };
  const onCopy = (e) => {
    if (inField(e) || !sel) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', selectionTsv());
    toast('Copied');
  };
  const onPaste = (e) => {
    if (inField(e) || !sel || !canEditLayer()) return;
    e.preventDefault();
    pasteText(e.clipboardData.getData('text/plain'));
  };
  document.addEventListener('keydown', onKey);
  document.addEventListener('copy', onCopy);
  document.addEventListener('paste', onPaste);

  // ---- dialogs ----
  function showLegend() {
    const groups = {};
    for (const c of state.meta.dutyCodes) (groups[c.category] ??= []).push(c);
    dialog(
      'Key',
      html`<div class="legend">
        ${Object.entries(groups).map(
          ([cat, codes]) => html`<h3>${cat[0].toUpperCase() + cat.slice(1)}</h3>
            <ul>${codes.map((c) => html`<li><span class="chip" style="${cellStyle(c.code)}">${c.code}</span> ${c.label}${c.private ? html` <small class="muted">(private)</small>` : ''}</li>`)}</ul>`,
        )}
        <h3>Team positions</h3><p class="muted"><span class="role role-leader">TL</span> team leader · <span class="role role-sup">SUP</span> supervisor ·
          a count with an amber underline means no team leader or supervisor is on duty that day.</p>
        <h3>Daily postings</h3><p class="muted">In the <b>Duties</b> view, a small blue corner on a cell means that person has a daily posting that day - hover to see it.
          Switch to <b>Postings</b> (top of the plan) to see and edit postings in the grid: short codes show each posting, faint codes are people on duty but not posted,
          greyed cells are days off, and team rows show posted / on duty. Team leaders and supervisors can edit their own teams; postings are private to each team.</p>
        ${postingTypes ? html`<ul>${[...postingTypes.values()].filter((t) => t.active).map((t) => html`<li><span class="chip" style="${postStyle(t)}">${t.short}</span> ${t.name}</li>`)}</ul>` : ''}
        <h3>Dates</h3><p class="muted"><span class="holiday-tag">Hol</span> public holiday · <span class="legend-lock"></span> leave lockdown (hover a date for its name)</p>
        <h3>Counts</h3><p class="muted">Numbers on team rows show how many people are on a duty (not rest, leave or training) each day. Red means below the team's minimum.</p>
      </div>`,
    );
  }

  function showPerson(id) {
    const p = data.peopleById.get(id);
    if (!p) return;
    const team = state.teamMap.get(p.teamId);
    const upcoming = dates.filter((d) => d >= today).slice(0, 14);
    dialog(
      p.name,
      html`<dl class="kv">
          <dt>Staff no</dt><dd>${p.staffNumber}</dd>
          <dt>Initials</dt><dd>${p.initials || '–'}</dd>
          <dt>Team</dt><dd>${team?.name || '–'}${p.teamRole === 'leader' ? ' · Team leader' : p.teamRole === 'supervisor' ? ' · Supervisor' : ''}</dd>
          ${p.jobTitle ? html`<dt>Job title</dt><dd>${p.jobTitle}</dd>` : ''}
          ${p.email ? html`<dt>Email</dt><dd>${p.email}</dd>` : ''}
          ${p.mobile ? html`<dt>Mobile</dt><dd><a href="tel:${p.mobile.replace(/[^+\d]/g, '')}">${p.mobile}</a></dd>` : ''}
        </dl>
        <h3>Accreditations</h3>
        ${state.meta.accreditations.some((a) => p.acc[a.id])
          ? html`<ul class="acc-list">${state.meta.accreditations
              .filter((a) => p.acc[a.id])
              .map((a) => {
                const st = accStatus(p.acc[a.id], today);
                return html`<li class="${st}">${a.name}${p.acc[a.id].e ? html` <small>${st === 'expired' ? 'expired' : 'expires'} ${fmtDate(p.acc[a.id].e)}</small>` : ''}</li>`;
              })}</ul>`
          : html`<p class="muted">None recorded</p>`}
        ${upcoming.length
          ? html`<h3>Coming up</h3><div class="mini-days">${upcoming.map((d) => {
              const a = data.cells.get(`${p.id}|${d}`);
              return html`<div class="mini-day"><small>${fmtDate(d, 'dow')}</small><b>${dayNum(d)}</b>${a ? html`<span class="chip" style="${cellStyle(a.c)}">${a.c === '*' ? '–' : a.c}</span>` : html`<span class="chip empty">·</span>`}</div>`;
            })}</div>`
          : ''}`,
      { actions: planner ? html`<a class="btn" href="#/admin/people/${p.id}">Edit person</a>` : '' },
    );
  }

  function showRota() {
    const selRows = sel ? [...new Set(selCells().map((x) => x.p.id))] : [];
    const from = sel ? dates[rect(sel).c0] : v.start;
    const d = dialog(
      'Apply a rota pattern',
      html`<div class="form-grid">
        <label class="span2">Who
          <select name="who">
            ${selRows.length ? html`<option value="sel">Selected rows (${selRows.length} people)</option>` : ''}
            ${state.meta.teams.map((t) => html`<option value="t${t.id}">${t.name} (everyone)</option>`)}
          </select></label>
        <label>From<input type="date" name="from" value="${from}" required /></label>
        <label>To<input type="date" name="to" value="${addDays(from, 83)}" required /></label>
        <label class="span2">Pattern <small class="muted">codes separated by spaces or commas; use - for blank</small>
          <input name="pattern" placeholder="e.g. T1 T1 T1 T1 RD RD RD RD" required /></label>
        <label>Pattern day 1 falls on<input type="date" name="anchor" value="${from}" required /></label>
        <label>Stagger each person by (days)<input type="number" name="stagger" value="0" min="0" max="366" /></label>
        <label class="check span2"><input type="checkbox" name="overwrite" checked /> Overwrite existing entries (including leave and courses)</label>
        <div class="span2 preview muted"></div>
      </div>`,
      { wide: true, actions: '<button value="cancel" class="btn" formnovalidate>Cancel</button><button value="ok" class="btn btn-primary">Apply</button>' },
    );
    const f = $('form', d);
    const parse = () => f.pattern.value.split(/[\s,]+/).filter(Boolean).map((x) => (x === '-' ? '' : x));
    const preview = () => {
      const pat = parse();
      const bad = pat.filter((x) => x && !state.codeMap.has(x.toLowerCase()));
      $('.preview', d).innerHTML = bad.length
        ? html`<span class="error">Unknown codes: ${bad.join(', ')}</span>`
        : pat.length
          ? html`${pat.length}-day cycle: ${pat.map((x) => (x ? html`<span class="chip" style="${cellStyle(x)}">${x}</span>` : html`<span class="chip empty">·</span>`))}`
          : '';
    };
    f.pattern.addEventListener('input', preview);
    f.addEventListener('submit', async (e) => {
      if (e.submitter?.value !== 'ok') return;
      e.preventDefault();
      const pattern = parse();
      if (!pattern.length) return toast('Enter a pattern', 'error');
      const who = f.who.value;
      const personIds = who === 'sel' ? selRows : data.people.filter((p) => `t${p.teamId}` === who).map((p) => p.id);
      if (!personIds.length) return toast('No people to apply to', 'error');
      const stagger = Number(f.stagger.value) || 0;
      const offsets = Object.fromEntries(personIds.map((id, i) => [id, -i * stagger]));
      try {
        const r = await post('/assignments/pattern', { personIds, from: f.from.value, to: f.to.value, anchor: f.anchor.value, pattern, offsets, overwrite: f.overwrite.checked });
        toast(`Rota applied (${r.count} days)`, 'success');
        d.close();
        load({ quiet: true });
      } catch (ex) {
        toast(ex.message, 'error');
      }
    });
  }

  function showExport() {
    const to = addDays(v.start, v.span - 1);
    const d = dialog(
      'Export to Excel',
      html`<div class="form-grid">
        <label>From<input type="date" name="from" value="${v.start}" required /></label>
        <label>To<input type="date" name="to" value="${to}" required /></label>
        <p class="span2 muted">Exports ${v.teams.length ? 'the selected teams' : 'all teams'} in the same layout used for import, including vacant posts and accreditations.</p>
      </div>`,
      { actions: '<button value="cancel" class="btn" formnovalidate>Cancel</button><button value="ok" class="btn btn-primary">Download</button>' },
    );
    $('form', d).addEventListener('submit', (e) => {
      if (e.submitter?.value !== 'ok') return;
      const f = e.target;
      if (daysBetween(f.from.value, f.to.value) > 400) {
        e.preventDefault();
        return toast('Export is limited to 400 days', 'error');
      }
      download(`/export.xlsx?from=${f.from.value}&to=${f.to.value}${v.teams.length ? `&teams=${v.teams.join(',')}` : ''}`);
    });
  }

  // ---- live updates ----
  const onChanged = (e) => {
    const ev = e.detail;
    const to = addDays(v.start, v.span - 1);
    if (ev.type === 'meta') {
      styleCache.clear();
      renderTeamFilter();
      load({ quiet: true });
    } else if ((ev.type === 'roster' || ev.type === 'postings') && (!ev.from || !(ev.to < v.start || ev.from > to))) {
      if (ev.type === 'postings' && !ev.from) {
        postingTypes = null;
        postStyleCache.clear();
      }
      const sl = wrap.scrollLeft,
        st = wrap.scrollTop;
      load({ quiet: true }).then(() => {
        wrap.scrollLeft = sl;
        wrap.scrollTop = st;
      });
    }
  };
  window.addEventListener('dp:changed', onChanged);

  await load();
  scrollToToday();

  return () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('copy', onCopy);
    document.removeEventListener('paste', onPaste);
    window.removeEventListener('pointerup', stopDrag);
    window.removeEventListener('dp:changed', onChanged);
  };
}

