// End-to-end check of the real app: starts Electron with a debugging port, serves a small local feed,
// drives the window through the DevTools protocol (profile, run, files on disk) and saves screenshots.
// Run: node dev/e2e-electron.mjs [screenshotDir]   (needs `npm install`; opens a window for a few seconds)
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', '.bin', 'electron');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tfb-e2e-out-'));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tfb-e2e-ud-'));
const shots = process.argv[2] || null;
if (shots) fs.mkdirSync(shots, { recursive: true });

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const server = http.createServer((req, res) => {
  if (req.url === '/feed.xml') {
    res.setHeader('content-type', 'application/rss+xml');
    res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
      <item><title>Prima notizia</title><description>&lt;p&gt;Descrizione &lt;b&gt;uno&lt;/b&gt;&lt;/p&gt;</description><enclosure url="http://127.0.0.1:${server.address().port}/i.png" type="image/png"/></item>
      <item><title>Seconda
      notizia</title><description></description></item></channel></rss>`);
  } else if (req.url === '/i.png') { res.setHeader('content-type', 'image/png'); res.end(PNG); }
  else { res.statusCode = 404; res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const port = 9300 + Math.floor(Math.random() * 500);
const extra = (process.env.ELECTRON_EXTRA_ARGS || '').split(' ').filter(Boolean); // e.g. --no-sandbox when run as root
const child = spawn(electron, [root, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`, ...extra], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('renderer/index.html'));
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('window not found');
}

let ws, id = 0;
const pending = new Map();
const errors = [];
const cdp = (method, params = {}) => new Promise((resolve, reject) => { const my = ++id; pending.set(my, { resolve, reject }); ws.send(JSON.stringify({ id: my, method, params })); });
const ev = async (expr) => {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
async function shot(name) {
  if (!shots) return;
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(shots, name + '.png'), Buffer.from(r.data, 'base64'));
}

try {
  const page = await target();
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); }
    else if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
    else if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value || a.description).join(' '));
  };
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1240, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.reload'); // so that errors during start-up are seen
  await sleep(1200);
  assert.deepEqual(errors, [], 'start-up errors: ' + errors.join(' | '));

  assert.equal(await ev('document.documentElement.lang'), 'en', 'opens in English');
  await shot('01-empty');

  // create a profile through the real UI path
  await ev(`document.querySelector('#btnNewProfile').click()`);
  await ev(`document.querySelector('#newName').value = 'E2E'; document.querySelector('#newCreate').click()`);
  await sleep(500);
  const prof = await ev(`api.settings.get().then(s => s.profiles[0])`);
  assert.equal(prof.name, 'E2E');
  assert.equal(prof.feeds.length, 0); // a new profile starts empty
  assert.match(await ev(`document.querySelector('#main').textContent`), /Add your first feed/);

  const saved = await ev(`api.profiles.save(${JSON.stringify({ ...prof, outputDir: out, feeds: [{ id: 'f1', folder: 'News', url: base + '/feed.xml', maxItems: 5, enabled: true, insecureTls: false }] })})`);
  assert.equal(saved.outputDir, out);
  await cdp('Page.reload');
  await sleep(1500);
  console.log('feeds after reload:', await ev(`api.settings.get().then(s => s.profiles[0].feeds.length + ' ' + s.profiles[0].outputDir)`));
  await ev(`document.querySelectorAll('.profile-item')[0].click()`);
  await ev(`document.querySelector('#btnRun').click()`);
  for (let i = 0; i < 40 && !fs.existsSync(path.join(out, 'News_Title.Txt')); i++) await sleep(250);

  const titles = fs.readFileSync(path.join(out, 'News_Title.Txt'), 'utf8');
  const descs = fs.readFileSync(path.join(out, 'News_Description.Txt'), 'utf8');
  assert.equal(titles, 'Prima notizia\nSeconda notizia');
  assert.equal(descs, 'Descrizione uno\n-');
  assert.deepEqual(fs.readdirSync(path.join(out, 'News')).sort(), ['00001.JPG', '00002.JPG']);
  assert.ok(fs.readFileSync(path.join(out, 'News', '00001.JPG')).subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])));
  await sleep(600);
  await shot('02-feeds');
  assert.deepEqual(errors, [], 'errors: ' + errors.join(' | '));
  assert.match(await ev(`document.querySelector('td.st').textContent`), /2 items/);

  await ev(`document.querySelector('#btnDash').click()`); // dashboard
  await sleep(300);
  assert.match(await ev(`document.querySelector('#main').textContent`), /Feeds OK/);
  assert.match(await ev(`document.querySelector('#main').textContent`), /Upcoming checks/);
  await shot('02b-dashboard');
  // theme: light and back
  await ev(`(() => { const t = document.querySelector('#theme'); t.value = 'light'; t.dispatchEvent(new Event('change')); })()`);
  await sleep(300);
  assert.equal(await ev(`document.documentElement.dataset.theme`), 'light');
  await shot('02c-dashboard-light');
  await ev(`(() => { const t = document.querySelector('#theme'); t.value = 'dark'; t.dispatchEvent(new Event('change')); })()`);
  await sleep(200);
  await ev(`document.querySelectorAll('.profile-item')[0].click()`);
  await sleep(200);
  await ev(`document.querySelectorAll('.tab')[1].click()`); // schedule & options
  await sleep(200);
  assert.match(await ev(`document.querySelector('#main').textContent`), /Time windows/);
  await ev(`document.querySelector('.opts input[type=checkbox]').click()`); // switch the time windows on
  await sleep(500);
  await shot('03a-options');
  assert.equal(await ev(`api.settings.get().then(s => s.profiles[0].schedule.enabled)`), true);
  await ev(`document.querySelector('.opts input[type=checkbox]').click()`); // and off again
  await sleep(400);
  await ev(`document.querySelectorAll('.tab')[2].click()`); // output format
  await sleep(200);
  await shot('03-format');
  await ev(`document.querySelectorAll('.tab')[3].click()`);
  await sleep(200);
  await shot('04-log');
  await ev(`document.querySelectorAll('.tab')[0].click()`);
  await sleep(200);
  // feed options: exclude a word, check it is saved and used by the preview
  await ev(`document.querySelectorAll('td.st')[0].parentElement.querySelectorAll('.btn.small')[0].click()`);
  await sleep(300);
  await shot('04b-feed-options');
  await ev(`(() => { const ta = document.querySelectorAll('#feedBody textarea')[1]; ta.value = 'seconda'; ta.dispatchEvent(new Event('change')); })()`);
  await sleep(600);
  assert.deepEqual(await ev(`api.settings.get().then(s => s.profiles[0].feeds[0].filters.exclude)`), ['seconda']);
  await ev(`document.querySelector('#dlgFeed').close()`);
  await sleep(300);
  // add a merged feed
  await ev(`[...document.querySelectorAll('.toolbar .btn')].find(b => /merged|unito|combinado/i.test(b.textContent)).click()`);
  await sleep(600);
  assert.equal(await ev(`api.settings.get().then(s => s.profiles[0].feeds.length)`), 2);
  assert.equal(await ev(`api.settings.get().then(s => s.profiles[0].feeds[1].type)`), 'merge');
  await shot('04c-merged-feed');
  await ev(`document.querySelectorAll('td.st')[0].parentElement.querySelectorAll('.btn.small')[1].click()`);
  await sleep(1500);
  assert.match(await ev(`document.querySelector('#testBody').textContent`), /1 of 2 stories after the filters \(1 left out\)/);
  await shot('05-test');
  await ev(`document.querySelector('#dlgTest').close(); document.querySelector('#btnSettings').click()`);
  await sleep(300);
  // notifications as in the other apps: Telegram recipient rows, comma-separated email addresses
  await ev(`document.querySelector('#tAdd').click()`);
  await ev(`(() => { const [c, n] = document.querySelectorAll('#tRecipients .rec')[0].querySelectorAll('input'); c.value = '123456'; c.dispatchEvent(new Event('change')); n.value = 'Engineer'; n.dispatchEvent(new Event('change')); })()`);
  await ev(`(() => { const m = document.querySelector('#mTo'); m.value = 'a@x.org, b@y.it, bad'; m.dispatchEvent(new Event('change')); })()`);
  await sleep(600);
  assert.deepEqual(await ev(`api.settings.get().then(s => s.notifications.telegram.recipients)`), [{ chatId: '123456', note: 'Engineer' }]);
  assert.deepEqual(await ev(`api.settings.get().then(s => s.notifications.email.recipients)`), ['a@x.org', 'b@y.it']);
  assert.equal(await ev(`document.querySelector('#mTo').value`), 'a@x.org, b@y.it');
  await shot('06-settings');
  await ev(`document.querySelector('#settingsBody').scrollTop = 99999`);
  await sleep(200);
  await shot('06b-settings-email');
  await ev(`document.querySelector('#dlgSettings').close(); document.querySelector('#btnHelp').click()`);
  await sleep(300);
  await shot('07-help');

  // language switch persists
  await ev(`document.querySelector('#dlgHelp').close(); const s = document.querySelector('#lang'); s.value = 'it'; s.dispatchEvent(new Event('change'))`);
  await sleep(500);
  assert.equal(await ev('document.documentElement.lang'), 'it');
  await shot('08-italiano');
  assert.deepEqual(errors, [], 'no console errors: ' + errors.join(' | '));
  console.log('E2E OK');
} catch (err) {
  console.error('E2E FAILED:', err.message);
  process.exitCode = 1;
} finally {
  child.kill();
  server.close();
  await sleep(500);
  for (const d of [out, userData]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(process.exitCode || 0);
