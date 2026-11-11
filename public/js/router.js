// Hash routing. The deployed app uses "#/view/param" URLs. The standalone demo
// build (window.DP_DEMO) keeps the full route in memory and mirrors only the
// view name into the hash ("#plan"), because some embedding hosts only carry
// plain "#name" fragments.
const DEMO = typeof window !== 'undefined' && !!window.DP_DEMO;
const listeners = new Set();
let memory = null;

function fromLocation() {
  const h = location.hash.replace(/^#\/?/, '');
  return h ? '#/' + h : '#/';
}

export function currentRoute() {
  return DEMO ? (memory ??= fromLocation()) : location.hash || '#/';
}

function mirror(hash) {
  const name = hash.replace(/^#\/?/, '').split('/')[0];
  try {
    history.replaceState(null, '', name ? '#' + name : location.pathname + location.search);
  } catch {
    /* ignore */
  }
}

/** Navigate to a route like "#/day/2026-11-11". */
export function go(hash) {
  if (DEMO) {
    memory = hash;
    mirror(hash);
    listeners.forEach((fn) => fn());
  } else if (location.hash === hash) listeners.forEach((fn) => fn());
  else location.hash = hash;
}

/** Change the current route without triggering navigation. */
export function replaceRoute(hash) {
  if (DEMO) {
    memory = hash;
    mirror(hash);
  } else history.replaceState(null, '', hash);
}

export function onRoute(fn) {
  listeners.add(fn);
}

if (!DEMO) window.addEventListener('hashchange', () => listeners.forEach((fn) => fn()));
else {
  // Intercept in-app links so they route in memory.
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href^="#/"]');
    if (!a || e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    go(a.getAttribute('href'));
  });
  window.addEventListener('hashchange', () => {
    const name = location.hash.replace(/^#\/?/, '').split('/')[0];
    if (name && name !== currentRoute().replace(/^#\/?/, '').split('/')[0]) go('#/' + name);
  });
}
