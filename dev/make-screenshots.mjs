// Screenshots of the real app for the site and the README. The content is invented (local demo feeds with made-up
// headlines and generated pictures): no publisher's text or images, no real paths.
// Run: node dev/make-screenshots.mjs [outputDir]      (opens the app for a few seconds)
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Jimp, JimpMime, loadFont, HorizontalAlign, VerticalAlign } from 'jimp';
import { SANS_64_WHITE, SANS_32_WHITE } from 'jimp/fonts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || path.join(root, 'docs', 'screenshots'));
fs.mkdirSync(outDir, { recursive: true });
const electron = path.join(root, 'node_modules', '.bin', 'electron');
const tickerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfb-shot-out-'));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tfb-shot-ud-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- demo content ----------------------------------------------------------------------------------------------
const NOW = Date.now();
const mins = (n) => new Date(NOW - n * 60_000).toUTCString();
const DEMO = {
  local: { label: 'LOCAL', colors: [[37, 99, 235], [30, 58, 138]], items: [
    ['City council approves new tram line to the harbour', 'Works are due to start in spring and finish in 2028, the council said on Tuesday.'],
    ['Road closures this weekend for the half marathon', 'Buses will be diverted from 7 am. Full list of streets on the city website.'],
    ['Library extends its opening hours until midnight', 'The change starts next month and will be reviewed after one semester.'],
    ['Lottery numbers drawn: no winner of the jackpot', 'The prize rolls over to the next draw.'],
    ['Farmers\' market moves to the old station square', 'More than forty stalls are expected every Saturday morning.'],
    ['Hospital opens new children\'s ward', 'The ward has twenty beds and a play area financed by local donations.'],
    ['Water cut planned in the north district on Thursday', 'Repair work on the main pipe, from 9 am to 3 pm.'],
    ['Local school wins national robotics prize', 'Twelve students built a robot that sorts recycling.']
  ] },
  sport: { label: 'SPORT', colors: [[22, 163, 74], [20, 83, 45]], items: [
    ['Home side wins derby with a late goal', 'A header in the 89th minute decided a tense match.'],
    ['Cyclist takes the mountain stage', 'A solo attack on the last climb gave the rider the lead.'],
    ['Basketball: playoffs start on Friday', 'The first round will be played over five games.'],
    ['Swimming championship opens with two records', 'Both marks were set in the first heats.'],
    ['Marathon entries close tonight', 'Organisers expect eight thousand runners.'],
    ['Youth tournament final moved to Sunday', 'Rain forced the change of date.']
  ], noImage: [4] },
  weather: { label: 'WEATHER', colors: [[234, 138, 36], [154, 52, 18]], items: [
    ['Sunny spells, 21 degrees', 'Light wind from the west, no rain expected.'],
    ['Clouds and showers tomorrow', 'Temperatures drop by five degrees after midday.'],
    ['Weekend: stable and mild', 'Highs around 19 degrees on both days.']
  ] },
  studio: { label: 'STUDIO', colors: [[124, 58, 237], [76, 29, 149]], items: [
    ['Morning show: guests and topics', 'Starts at 7:00 with the local news round-up.'],
    ['New podcast series on city history', 'Six episodes, available from Monday.'],
    ['Traffic update every fifteen minutes', 'Reports from the ring road and the harbour.'],
    ['Listeners\' choice: vote until Friday', 'The top ten will be played on Saturday night.'],
    ['Concert tickets giveaway', 'Call during the afternoon show to take part.'],
    ['Weekend programme highlights', 'Live music, interviews and a quiz.']
  ] },
  culture: { label: 'CULTURE', colors: [[219, 39, 119], [131, 24, 67]], items: [
    ['Museum opens an exhibition on early photography', 'More than two hundred prints are on show until January.'],
    ['Open-air cinema returns to the old harbour', 'Free entry, films start at sunset.'],
    ['Theatre season: first titles announced', 'Seven productions, three of them premieres.'],
    ['Young writers\' contest open for entries', 'Stories up to five thousand characters.'],
    ['Jazz festival adds two evenings', 'Tickets on sale from Monday.'],
    ['Restored fresco back on display', 'The work had been closed to visitors for a year.']
  ] }
};

const font64 = await loadFont(SANS_64_WHITE);
const font32 = await loadFont(SANS_32_WHITE);
async function picture(def, n) {
  const w = 640, h = 360;
  const [a, b] = def.colors;
  const img = new Jimp({ width: w, height: h, color: 0x000000ff });
  for (let y = 0; y < h; y++) {
    const t = Math.min(1, (y / h) * 0.85 + n * 0.03);
    const c = [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * t));
    const px = ((c[0] << 24) | (c[1] << 16) | (c[2] << 8) | 0xff) >>> 0;
    for (let x = 0; x < w; x++) img.setPixelColor(px, x, y);
  }
  img.print({ font: font64, x: 0, y: 110, maxWidth: w, text: { text: def.label, alignmentX: HorizontalAlign.CENTER } });
  img.print({ font: font32, x: 0, y: 220, maxWidth: w, text: { text: `#${n + 1}`, alignmentX: HorizontalAlign.CENTER } });
  return Buffer.from(await img.getBuffer(JimpMime.jpeg, { quality: 80 }));
}
const pictures = {};
for (const [k, def] of Object.entries(DEMO)) pictures[k] = await Promise.all(def.items.map((_, i) => picture(def, i)));

const server = http.createServer((req, res) => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const m = /^\/(\w+)\.xml$/.exec(req.url);
  if (m && DEMO[m[1]]) {
    const def = DEMO[m[1]];
    const items = def.items.map(([t, d], i) => `<item><title>${t.replace(/&/g, '&amp;')}</title><description>${d}</description><pubDate>${mins(i * 37 + (m[1] === 'sport' ? 11 : 0))}</pubDate>${def.noImage?.includes(i) ? '' : `<enclosure url="${base}/img/${m[1]}/${i}.jpg" type="image/jpeg"/>`}</item>`).join('');
    res.setHeader('content-type', 'application/rss+xml');
    return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>${m[1]}</title>${items}</channel></rss>`);
  }
  const im = /^\/img\/(\w+)\/(\d+)\.jpg$/.exec(req.url);
  if (im && pictures[im[1]]?.[Number(im[2])]) { res.setHeader('content-type', 'image/jpeg'); return res.end(pictures[im[1]][Number(im[2])]); }
  res.statusCode = 404; res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---- drive the real app ------------------------------------------------------------------------------------------
const port = 9800 + Math.floor(Math.random() * 300);
const extra = (process.env.ELECTRON_EXTRA_ARGS || '').split(' ').filter(Boolean); // e.g. --no-sandbox when run as root (containers, CI)
const child = spawn(electron, [root, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, ...extra], { stdio: 'ignore' });
let ws, id = 0;
const pending = new Map();
const cdp = (method, params = {}) => new Promise((resolve, reject) => { const my = ++id; pending.set(my, { resolve, reject }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
// shows neutral paths instead of the temporary folders (cosmetic, not saved)
const cosmetic = (names) => ev(`(() => {
  const by = ${JSON.stringify(names.__byName)};
  document.querySelectorAll('.dcard').forEach((c) => { const h3 = c.querySelector('h3'); const p = c.querySelector('.path'); if (p && h3 && by[h3.textContent]) p.textContent = by[h3.textContent]; });
  const inp = document.querySelector('.pathbox input'); const title = document.querySelector('.pname-input');
  if (inp && title && by[title.value]) inp.value = by[title.value];
  document.querySelectorAll('td.url input[type=url]').forEach((u) => { const m = /\\/(\\w+)\\.xml$/.exec(u.value); if (m) u.value = 'https://news.example.com/feeds/' + m[1] + '.xml'; });
})()`);
async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, name), Buffer.from(r.data, 'base64'));
  console.log('saved', name);
}

try {
  let page;
  for (let i = 0; i < 80 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page' && t.url.includes('renderer/index.html')); } catch { /* not up yet */ }
    await sleep(250);
  }
  if (!page) throw new Error('window not found');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); } };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1240, height: 800, deviceScaleFactor: 2, mobile: false });
  await sleep(800);

  const feed = (key, folder, extra = {}) => ({ id: `${key}-id`, folder, url: `${base}/${key}.xml`, maxItems: 10, ...extra });
  const profiles = [
    {
      name: 'Main newsroom screen', outputDir: path.join(tickerDir, 'Newsroom'), intervalMin: 5,
      schedule: { enabled: true, windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '06:00', to: '24:00', intervalMin: 0 }] },
      feeds: [
        feed('local', 'Local news', { maxItems: 8, filters: { include: [], exclude: ['lottery'], scope: 'both', sort: 'newest', dedupe: false } }),
        feed('sport', 'Sport', { maxItems: 6 }),
        feed('weather', 'Weather', { maxItems: 3, intervalMin: 15 }),
        { id: 'latest-id', type: 'merge', folder: 'Latest news', maxItems: 8, sources: ['local-id', 'sport-id'] }
      ]
    },
    { name: 'Studio ticker', outputDir: path.join(tickerDir, 'Studio'), intervalMin: 10, feeds: [feed('studio', 'Studio', { maxItems: 6 }), feed('culture', 'Culture', { maxItems: 6 })] }
  ];
  for (const p of profiles) fs.mkdirSync(p.outputDir, { recursive: true });
  const ids = [];
  for (const p of profiles) {
    const saved = await ev(`api.profiles.save(${JSON.stringify({ id: crypto.randomUUID(), ...p })}).then((s) => s.id)`);
    ids.push(saved);
  }
  await cdp('Page.reload');
  await sleep(1200);
  for (const pid of ids) await ev(`api.profiles.runNow(${JSON.stringify(pid)})`);
  for (let i = 0; i < 80 && !(fs.existsSync(path.join(tickerDir, 'Newsroom', 'Latest news_Title.Txt')) && fs.existsSync(path.join(tickerDir, 'Studio', 'Culture_Title.Txt'))); i++) await sleep(250);
  await sleep(1500);

  const names = ['/Volumes/Playout/Ticker/Newsroom', '/Volumes/Playout/Ticker/Studio'];
  names.__byName = { 'Main newsroom screen': names[0], 'Studio ticker': names[1] };

  // 1. dashboard
  await ev(`document.querySelector('#btnDash').click()`);
  await sleep(600);
  await cosmetic(names);
  await shot('01-dashboard.png');
  // 2. profile with its feeds
  await ev(`document.querySelectorAll('.profile-item')[0].click()`);
  await sleep(500);
  await ev(`document.querySelectorAll('.tab')[0].click()`);
  await sleep(400);
  await cosmetic(names);
  await shot('02-profile-feeds.png');
  // 3. preview: the stories as they would be written (the filter leaves the lottery story out)
  await ev(`document.querySelectorAll('td.st')[0].parentElement.querySelectorAll('.btn.small')[1].click()`);
  await sleep(2500);
  await cosmetic(names);
  await shot('03-preview.png');
  await ev(`document.querySelector('#dlgTest').close()`);
  // 4. schedule and options, light theme
  await ev(`(() => { const t = document.querySelector('#theme'); t.value = 'light'; t.dispatchEvent(new Event('change')); })()`);
  await sleep(400);
  await ev(`document.querySelectorAll('.tab')[1].click()`);
  await sleep(500);
  await ev(`document.querySelector('#main').scrollTop = 330`);
  await sleep(300);
  await cosmetic(names);
  await shot('04-schedule-light.png');
  console.log('done');
} catch (err) {
  console.error('FAILED:', err.message);
  process.exitCode = 1;
} finally {
  child.kill();
  server.close();
  await sleep(600);
  for (const d of [tickerDir, userData]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(process.exitCode || 0);
