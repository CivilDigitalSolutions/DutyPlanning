import { get, post, onApiEvent } from './api.js';
import { state, loadMeta, isPlanner } from './state.js';
import { $, $$, html, toast, fmtDate, store } from './util.js';
import { renderLogin, renderChangePassword } from './views/login.js';

const views = {
  plan: () => import('./views/plan.js'),
  me: () => import('./views/mine.js'),
  day: () => import('./views/day.js'),
  admin: () => import('./views/admin.js'),
};

let cleanup = null;
let routeToken = 0;

function parseRoute() {
  const [name, ...params] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { name: name || null, params };
}

export function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function defaultRoute() {
  return isPlanner() || !state.user?.person ? '#/plan' : '#/me';
}

async function route() {
  const token = ++routeToken;
  const view = $('#view');
  if (cleanup) {
    try {
      cleanup();
    } catch {
      /* ignore */
    }
    cleanup = null;
  }
  if (!state.user) return;
  if (state.user.mustChangePassword) {
    renderChangePassword(view, { forced: true, onDone: boot });
    return;
  }
  let { name, params } = parseRoute();
  if (!views[name] || (name === 'admin' && !isPlanner())) {
    history.replaceState(null, '', defaultRoute());
    ({ name, params } = parseRoute());
  }
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
  document.body.dataset.view = name;
  view.innerHTML = '<div class="loading" aria-busy="true">Loading…</div>';
  try {
    const mod = await views[name]();
    if (token !== routeToken) return;
    view.innerHTML = '';
    cleanup = (await mod.render(view, params)) || null;
  } catch (e) {
    if (token !== routeToken) return;
    view.innerHTML = '';
    view.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: e.message }));
  }
}

function renderShell() {
  const u = state.user;
  const nav = [
    ['plan', '#/plan', 'Plan', '▦'],
    ...(u.person ? [['me', '#/me', 'My duties', '◉']] : []),
    ['day', '#/day', 'Day', '☀'],
    ...(isPlanner() ? [['admin', '#/admin', 'Manage', '⚙']] : []),
  ];
  $('#app').innerHTML = html`
    <header class="topbar">
      <a class="brand" href="#/" aria-label="Home"><img src="/icons/icon.svg" alt="" width="28" height="28" /><span>${state.meta.orgName}</span></a>
      <nav class="tabs" aria-label="Main">
        ${nav.map(([k, h, label]) => html`<a href="${h}" data-nav="${k}">${label}</a>`)}
      </nav>
      <div class="spacer"></div>
      <span id="conn" class="conn" hidden></span>
      <details class="menu">
        <summary class="btn btn-ghost" aria-label="Account menu"><span class="avatar">${(u.person?.initials || u.username).slice(0, 3)}</span></summary>
        <div class="menu-pop">
          <div class="menu-head"><strong>${u.person?.name || u.username}</strong><small>${u.username} · ${u.role}</small></div>
          <button class="menu-item" data-act="theme">Toggle dark mode</button>
          <button class="menu-item" data-act="password">Change password</button>
          <button class="menu-item" data-act="logout">Sign out</button>
        </div>
      </details>
    </header>
    <div id="banner" class="banner" hidden></div>
    <main id="view" tabindex="-1"></main>
    <nav class="bottom-nav" aria-label="Main">
      ${nav.map(([k, h, label, icon]) => html`<a href="${h}" data-nav="${k}"><span aria-hidden="true">${icon}</span>${label}</a>`)}
    </nav>`;

  $('.menu').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    $('.menu').open = false;
    if (act === 'logout') {
      await post('/auth/logout').catch(() => {});
      await clearDataCaches();
      location.hash = '';
      location.reload();
    } else if (act === 'password') {
      if (cleanup) cleanup();
      cleanup = null;
      renderChangePassword($('#view'), { onDone: () => route() });
    } else if (act === 'theme') {
      const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      store.set('theme', next);
    }
  });
  document.addEventListener('click', (e) => {
    const m = $('.menu');
    if (m?.open && !m.contains(e.target)) m.open = false;
  });
}

async function clearDataCaches() {
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('dp-data')).map((k) => caches.delete(k)));
  }
}

// ---- Live updates via Server-Sent Events ----
let es = null;
function connectEvents() {
  if (es || !('EventSource' in window)) return;
  es = new EventSource('/api/events');
  es.onmessage = async (msg) => {
    let ev;
    try {
      ev = JSON.parse(msg.data);
    } catch {
      return;
    }
    if (ev.type === 'meta') await loadMeta().catch(() => {});
    window.dispatchEvent(new CustomEvent('dp:changed', { detail: ev }));
  };
}

function setBanner(text) {
  const b = $('#banner');
  if (!b) return;
  b.hidden = !text;
  b.textContent = text || '';
}

onApiEvent((e) => {
  if (e.type === 'unauthorized' && state.user) {
    state.user = null;
    boot();
  } else if (e.type === 'password-change' && state.user) {
    state.user.mustChangePassword = true;
    route();
  } else if (e.type === 'stale') {
    const when = e.at ? new Date(e.at) : null;
    setBanner(`Offline - showing saved copy${when ? ` from ${fmtDate(when.toISOString().slice(0, 10), 'dm')} ${when.toTimeString().slice(0, 5)}` : ''}. Changes can't be made until you reconnect.`);
    document.body.classList.add('is-offline');
  } else if (e.type === 'offline') {
    setBanner('You are offline.');
    document.body.classList.add('is-offline');
  } else if (e.type === 'online') {
    setBanner('');
    document.body.classList.remove('is-offline');
  }
});
window.addEventListener('online', () => route());

async function boot() {
  try {
    const { user } = await get('/auth/me');
    state.user = user;
  } catch (e) {
    state.user = null;
    if (e.status === 0) {
      // Offline with no cached session info.
      $('#app').innerHTML = '<div class="empty">You are offline. Connect to the network and try again.</div>';
      return;
    }
  }
  if (!state.user) {
    if (es) {
      es.close();
      es = null;
    }
    renderLogin($('#app'), { onDone: boot });
    return;
  }
  if (state.user.mustChangePassword) {
    $('#app').innerHTML = '<main id="view"></main>';
    renderChangePassword($('#view'), { forced: true, onDone: boot });
    return;
  }
  try {
    await loadMeta();
  } catch (e) {
    $('#app').innerHTML = html`<div class="empty">${e.message}</div>`;
    return;
  }
  renderShell();
  connectEvents();
  if (!location.hash || location.hash === '#/') history.replaceState(null, '', defaultRoute());
  route();
}

window.addEventListener('hashchange', route);

const theme = store.get('theme');
if (theme) document.documentElement.dataset.theme = theme;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) toast('A new version is available - reload to update', 'info', 8000);
      });
    });
  });
}

boot();
