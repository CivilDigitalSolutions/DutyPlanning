// The planning grid: teams grouped down the side, dates across the top.
import { put, post } from '../api.js';
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
  };
  const persist = () => store.set('plan', { span: v.span, teams: v.teams, showAcc: v.showAcc, showStaff: v.showStaff, showVacant: v.showVacant });

  let data = null;
  let dates = [];
  let personRows = []; // people in display order (selection row index)
  let cellEls = []; // flat list of td.c, index r * dates.length + c
  let sel = null; // {r0,c0,r1,c1}
  let dragging = false;
  let extendMode = false;
  let typed = '';
  let drawnGroups = [];
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
      data = await loadRoster(from, to);
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
    const teams = data.teams.filter((t) => !v.teams.length || v.teams.includes(t.id));
    const known = new Set(data.teams.map((t) => t.id));
    const out = teams.map((t) => {
      const all = data.people.filter((p) => p.teamId === t.id);
      return { team: t, people: all.filter(matches), vacancies: Math.max(0, t.establishment - all.length) };
    });
    if (!v.teams.length) {
      const orphans = data.people.filter((p) => !known.has(p.teamId)).filter(matches);
      if (orphans.length) out.push({ team: { id: 0, name: 'No team', establishment: 0 }, people: orphans, vacancies: 0 });
    }
    const filtered = v.q || v.acc;
    return out.filter((g) => !filtered || g.people.length);
  }

  function cellHtml(p, d, r, c) {
    const a = data.cells.get(`${p.id}|${d}`);
    let cls = 'c';
    if (isWeekend(d)) cls += ' we';
    if (d === today) cls += ' td';
    if (!a) return `<td class="${cls}" data-r="${r}" data-c="${c}"></td>`;
    if (a.n) cls += ' note';
    if (a.c === '*') cls += ' masked';
    const info = codeInfo(a.c);
    const title = `${info.label}${a.n ? ' - ' + a.n : ''}`;
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
    for (const d of dates)
      h += `<th class="d${isWeekend(d) ? ' we' : ''}${d === today ? ' td' : ''}" data-date="${d}"><span>${esc(fmtDate(d, 'dow').slice(0, 2))}</span><b>${dayNum(d)}</b></th>`;
    h += '</tr></thead>';

    personRows = [];
    drawnGroups = [];
    const totals = new Array(dates.length).fill(0);
    let body = '';
    for (const g of groups()) {
      drawnGroups.push(g);
      const t = g.team;
      const counts = dates.map((d) => g.people.reduce((n, p) => n + (onDuty(data.cells.get(`${p.id}|${d}`)?.c ?? '') ? 1 : 0), 0));
      counts.forEach((n, ci) => (totals[ci] += n));
      const allMembers = data.people.filter((p) => p.teamId === t.id).length;
      body += `<tbody class="team"><tr class="team-row"><th class="name" scope="rowgroup"><div class="team-name">${esc(t.name)}</div><div class="team-meta">${allMembers}${t.establishment ? `/${t.establishment}` : ''}${g.vacancies ? ` · <span class="vac">${g.vacancies} vacant</span>` : ''}</div></th>`;
      if (fixed > 1) body += `<td class="fx" colspan="${fixed - 1}"></td>`;
      counts.forEach((n, ci) => {
        const low = t.minStrength != null && n < t.minStrength;
        body += `<td class="cnt${low ? ' low' : ''}${isWeekend(dates[ci]) ? ' we' : ''}" title="${n} on duty${t.minStrength != null ? ` (minimum ${t.minStrength})` : ''}">${n}</td>`;
      });
      body += '</tr>';
      for (const p of g.people) {
        const r = personRows.length;
        personRows.push(p);
        body += `<tr class="person${p.id === myId ? ' me' : ''}"><th class="name" scope="row" data-pid="${p.id}"><button class="linkish" data-person="${p.id}"><span class="ini">${esc(p.initials || '')}</span>${esc(p.name)}</button></th>`;
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
    let foot = `<tfoot><tr><th class="name">On duty</th>${fixed > 1 ? `<td class="fx" colspan="${fixed - 1}"></td>` : ''}`;
    totals.forEach((n, ci) => (foot += `<td class="cnt${isWeekend(dates[ci]) ? ' we' : ''}">${n}</td>`));
    foot += '</tr></tfoot>';
    table.innerHTML = h + body + foot;
    table.classList.toggle('editable', planner);
    cellEls = $$('td.c', table);
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
    }
    for (const c of cols) {
      let total = 0;
      for (const g of drawnGroups) {
        const n = g.people.reduce((k, p) => k + (onDuty(data.cells.get(`${p.id}|${dates[c]}`)?.c ?? '') ? 1 : 0), 0);
        total += n;
        const el = g.cntEls?.[c];
        if (el) {
          el.textContent = n;
          el.classList.toggle('low', g.team.minStrength != null && n < g.team.minStrength);
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
    if (!td || e.button > 0) return;
    const r = Number(td.dataset.r),
      c = Number(td.dataset.c);
    if (!planner) {
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
    const td = e.target.closest('td.c');
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
    const codeBtn = e.target.closest('[data-code]');
    if (codeBtn) return applyCode(codeBtn.dataset.code || null);
    const act = e.target.closest('[data-sheet]')?.dataset.sheet;
    if (act === 'close') setSel(null);
    else if (act === 'extend') {
      extendMode = !extendMode;
      renderSheet();
    } else if (act === 'note') editNote();
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
        undo.push(prev);
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
    const prev = undo.pop();
    if (prev) commit(prev, { record: false }).then(renderSheet);
    else toast('Nothing to undo');
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
      for (let c = c0; c <= c1; c++) row.push(data.cells.get(`${personRows[r].id}|${dates[c]}`)?.c ?? '');
      lines.push(row.join('\t'));
    }
    return lines.join('\n');
  }

  function pasteText(text) {
    if (!sel || !text) return;
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

  const inField = (e) => e.target.closest('input, textarea, select, dialog, [contenteditable]');
  const onKey = (e) => {
    if (inField(e) || !sel || !data) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z' && planner) {
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
      setSel(e.shiftKey && planner ? { ...sel, r1: r, c1: c } : { r0: r, c0: c, r1: r, c1: c });
      cellEls[r * dates.length + c]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return;
    }
    if (e.key === 'Escape') return setSel(null);
    if (!planner) return;
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
    if (inField(e) || !sel || !planner) return;
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
          <dt>Team</dt><dd>${team?.name || '–'}</dd>
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
      location.href = `/api/export.xlsx?from=${f.from.value}&to=${f.to.value}${v.teams.length ? `&teams=${v.teams.join(',')}` : ''}`;
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
    } else if (ev.type === 'roster' && !(ev.to < v.start || ev.from > to)) {
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

