#!/usr/bin/env node
// Builds every icon from the two SVG sources in assets/: logo.svg (app icon) and tray.svg (macOS menu bar glyph).
// Writes icon.png, icon-mac.png, icon.ico, icon.icns, linux-icons/*.png, tray.png, trayTemplate.png, trayTemplate@2x.png.
// Needs Playwright with a Chromium (only to draw the SVG; nothing is shipped):
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs CHROMIUM=/path/to/chromium node dev/make-icons.mjs
// Works on any system (no sips / iconutil).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const svgText = (f) => fs.readFileSync(path.join(root, f), 'utf8');

async function render(svg, size) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  const buf = await page.screenshot({ omitBackground: true });
  await page.close();
  return buf;
}

const logo = svgText('logo.svg');
const cache = new Map();
const logoPng = async (s) => { if (!cache.has(s)) cache.set(s, await render(logo, s)); return cache.get(s); };
const write = (f, buf) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), buf); };

write('icon.png', await logoPng(1024));
write('icon-mac.png', await logoPng(1024));
for (const s of [16, 32, 48, 64, 128, 256, 512]) write(`linux-icons/${s}x${s}.png`, await logoPng(s));

// .ico: PNG images inside the container
const icoSizes = [16, 32, 48, 64, 128, 256];
const icoImgs = await Promise.all(icoSizes.map(logoPng));
{
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(icoSizes.length, 4);
  let offset = 6 + 16 * icoSizes.length;
  const entries = icoSizes.map((s, i) => {
    const e = Buffer.alloc(16);
    e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(icoImgs[i].length, 8); e.writeUInt32LE(offset, 12); offset += icoImgs[i].length;
    return e;
  });
  write('icon.ico', Buffer.concat([head, ...entries, ...icoImgs]));
}

// .icns: PNG entries (ic07 128, ic08 256, ic09 512, ic10 1024, ic11 32@2x... as listed)
{
  const types = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]];
  const parts = [];
  for (const [type, s] of types) {
    const data = await logoPng(s);
    const h = Buffer.alloc(8); h.write(type, 0, 'ascii'); h.writeUInt32BE(data.length + 8, 4);
    parts.push(h, data);
  }
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8); h.write('icns', 0, 'ascii'); h.writeUInt32BE(body.length + 8, 4);
  write('icon.icns', Buffer.concat([h, body]));
}

write('trayTemplate.png', await render(svgText('tray.svg'), 22));      // macOS menu bar (template image)
write('trayTemplate@2x.png', await render(svgText('tray.svg'), 44));
write('tray.png', await logoPng(32));                                  // Windows / Linux tray
fs.copyFileSync(path.join(root, 'logo.svg'), path.join(root, '..', 'renderer', 'logo.svg'));
await browser.close();
console.log('icons written');
