// Builds a single self-contained HTML file of the app that runs entirely in the
// browser with sample data (no server). Used for previews and demos.
// Usage: npm run build:demo   ->  dist/duty-planning-demo.html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mock = path.join(root, 'demo', 'mock-api.js');

const result = await esbuild.build({
  entryPoints: [path.join(root, 'public/js/app.js')],
  bundle: true,
  format: 'iife',
  target: 'es2021',
  minify: true,
  write: false,
  banner: { js: 'window.DP_DEMO=true;' },
  plugins: [
    {
      name: 'mock-api',
      setup(build) {
        // Swap the real fetch-based API client for the in-browser mock.
        build.onResolve({ filter: /(^|\/)api\.js$/ }, (args) => (args.importer.includes(`${path.sep}public${path.sep}`) ? { path: mock } : undefined));
      },
    },
  ],
});

const icon = 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(root, 'public/icons/icon.svg')).toString('base64');
const js = result.outputFiles[0].text.replaceAll('/icons/icon.svg', icon).replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync(path.join(root, 'public/css/app.css'), 'utf8').replaceAll('/icons/icon.svg', icon);

const html = `<title>Duty Planning</title>
<meta name="description" content="Team duty plan: shifts, rest days, leave and training.">
<link rel="icon" href="${icon}">
<style>
${css}
</style>
<div id="app"><div class="loading" aria-busy="true">Loading…</div></div>
<script>
${js}
</script>
`;
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'duty-planning-demo.html');
fs.writeFileSync(out, html);
console.log(`Wrote ${path.relative(root, out)} (${(html.length / 1024).toFixed(0)} KB)`);

// ---- Static website for GitHub Pages (or any static host): dist/pages/ ----
// A complete, installable page: same app and sample data, plus a web app manifest,
// home-screen icons and a small service worker so it opens offline after the first visit.
// All paths are relative, so it works from https://<org>.github.io/<repo>/.
const pages = path.join(root, 'dist', 'pages');
fs.rmSync(pages, { recursive: true, force: true });
fs.mkdirSync(path.join(pages, 'icons'), { recursive: true });
for (const f of ['icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'])
  fs.copyFileSync(path.join(root, 'public/icons', f), path.join(pages, 'icons', f));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public/manifest.webmanifest'), 'utf8'));
manifest.name = 'Duty Planning (demo)';
manifest.id = './';
manifest.start_url = './';
manifest.scope = './';
manifest.icons = manifest.icons.map((i) => ({ ...i, src: i.src.replace(/^\//, '') }));
manifest.shortcuts = [];
fs.writeFileSync(path.join(pages, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(
  path.join(pages, 'sw.js'),
  `// Network-first cache of the single-page demo so it also opens offline.
const CACHE = 'dp-demo-${Date.now()}';
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', 'manifest.webmanifest', 'icons/icon-192.png'])).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((n) => n !== CACHE).map((n) => caches.delete(n)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./'))));
});
`,
);
fs.writeFileSync(path.join(pages, '.nojekyll'), '');
fs.writeFileSync(
  path.join(pages, 'index.html'),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1f4e79">
<meta name="robots" content="noindex">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Duty Planning">
${html.replace('<div id="app">', '</head>\n<body>\n<div id="app">')}<script>
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
</script>
</body>
</html>
`,
);
console.log(`Wrote ${path.relative(root, pages)}/ (GitHub Pages site)`);
