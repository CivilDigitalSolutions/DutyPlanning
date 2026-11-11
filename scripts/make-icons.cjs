// Renders public/icons/icon.svg to the PNG sizes the manifest needs.
// Usage: node scripts/make-icons.cjs   (requires playwright)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'public', 'icons');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const shots = [
    ['icon-192.png', 192, 0, 'transparent'],
    ['icon-512.png', 512, 0, 'transparent'],
    ['apple-touch-icon.png', 180, 0, '#1f4e79'],
    ['icon-maskable-512.png', 512, 0.12, '#1f4e79'],
  ];
  for (const [file, size, pad, bg] of shots) {
    const inner = Math.round(size * (1 - pad * 2));
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<html><body style="margin:0;background:${bg};display:grid;place-items:center;width:${size}px;height:${size}px">` +
        `<div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body></html>`,
    );
    await page.screenshot({ path: path.join(dir, file), omitBackground: bg === 'transparent' });
  }
  await browser.close();
  console.log('icons written');
})();
