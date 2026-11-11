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
