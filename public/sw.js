// Service worker: app shell caching + network-first API with offline fallback.
const VERSION = 'v1';
const SHELL = `dp-shell-${VERSION}`;
const DATA = 'dp-data';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/app.js',
  '/js/api.js',
  '/js/state.js',
  '/js/util.js',
  '/js/views/login.js',
  '/js/views/plan.js',
  '/js/views/mine.js',
  '/js/views/day.js',
  '/js/views/admin.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
];
const NO_CACHE_API = ['/api/events', '/api/export.xlsx', '/api/my.ics', '/api/audit'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(SHELL_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('dp-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirstApi(request) {
  const cache = await caches.open(DATA);
  try {
    const res = await fetch(request);
    if (res.ok) {
      const headers = new Headers(res.headers);
      headers.set('X-Cached-At', new Date().toISOString());
      const body = await res.clone().arrayBuffer();
      await cache.put(request, new Response(body, { status: res.status, statusText: res.statusText, headers }));
    } else if (res.status === 401) {
      // Signed out: drop any cached personal data.
      await caches.delete(DATA);
    }
    return res;
  } catch (err) {
    const cached = await cache.match(request);
    if (!cached) throw err;
    const headers = new Headers(cached.headers);
    headers.set('X-From-Cache', '1');
    return new Response(await cached.arrayBuffer(), { status: cached.status, headers });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || network;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    if (NO_CACHE_API.some((p) => url.pathname.startsWith(p))) return;
    event.respondWith(networkFirstApi(req));
    return;
  }
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html')),
    );
    return;
  }
  event.respondWith(staleWhileRevalidate(req));
});
