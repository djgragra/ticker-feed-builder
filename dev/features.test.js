import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEngine, classify } from '../src/engine.js';
import { createRuntime } from '../src/runtime.js';
import { createScheduler } from '../src/scheduler.js';
import { scheduleState, nextAligned, nextTime, lastTime } from '../src/schedule-rules.js';
import { applyFilters } from '../src/filters.js';
import { buildDigest } from '../src/digest.js';
import { toJpeg, isJpegBytes } from '../src/image.js';
import { encodeModern } from '../src/image-modern.js';
import { newProfile, sanitizeProfile, sanitizeSettings } from '../src/settings.js';
import { loadSettingsFile } from '../src/cli.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'tfb-f-'));
const RSS = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items}</channel></rss>`;
const item = (t, d = '', img = '', date = '') => `<item><title>${t}</title><description>${d}</description>${date ? `<pubDate>${date}</pubDate>` : ''}${img ? `<enclosure url="${img}" type="image/png"/>` : ''}</item>`;
const fakeGet = (feeds, images = {}, calls = []) => async (url) => {
  calls.push(url);
  if (feeds[url]) return { status: 200, body: Buffer.from(typeof feeds[url] === 'function' ? feeds[url]() : feeds[url]), url, headers: {} };
  if (images[url]) return { status: 200, body: images[url], url, headers: {} };
  throw new Error('HTTP 404');
};
const mkFeed = (o) => ({ id: 'f1', type: 'feed', folder: 'News', url: 'https://f.test/a.xml', maxItems: 5, enabled: true, insecureTls: false, intervalMin: 0, staleHours: 0, filters: { include: [], exclude: [], scope: 'both', sort: 'feed', dedupe: false }, sources: [], ...o });

test('WebP and AVIF are decoded to JPEG; switched off they are refused', async () => {
  const img = { data: new Uint8ClampedArray(16 * 8 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 9) % 256)), width: 16, height: 8, colorSpace: 'srgb' };
  for (const kind of ['webp', 'avif']) {
    const bytes = await encodeModern(kind, img);
    const jpg = await toJpeg(bytes, { quality: 80, resize: { mode: 'cover', width: 32, height: 18 }, modern: true });
    assert.ok(isJpegBytes(jpg), kind);
    await assert.rejects(toJpeg(bytes, { modern: false }), /switched off/);
  }
});

test('time windows: inside, outside, days, wrap past midnight, own interval, next start', () => {
  const p = { schedule: { enabled: true, windows: [{ days: [1, 2, 3, 4, 5], from: '06:00', to: '24:00', intervalMin: 2 }] } };
  const at = (day, h, m = 0) => new Date(2026, 9, 4 + day, h, m); // 4 Oct 2026 is a Sunday
  assert.deepEqual(scheduleState(p, at(1, 7)), { active: true, intervalMin: 2, untilStartMs: 0 }); // Monday 07:00
  const night = scheduleState(p, at(1, 3)); // Monday 03:00 -> opens at 06:00
  assert.equal(night.active, false);
  assert.equal(night.untilStartMs, 3 * 3600_000);
  const sun = scheduleState(p, at(0, 12)); // Sunday noon -> Monday 06:00
  assert.equal(sun.active, false);
  assert.equal(sun.untilStartMs, 18 * 3600_000);
  const wrap = { schedule: { enabled: true, windows: [{ days: [], from: '22:00', to: '02:00', intervalMin: 0 }] } };
  assert.equal(scheduleState(wrap, at(1, 23)).active, true);
  assert.equal(scheduleState(wrap, at(2, 1)).active, true);
  assert.equal(scheduleState(wrap, at(2, 12)).active, false);
  assert.equal(scheduleState({ schedule: { enabled: false, windows: [] } }, at(1, 3)).active, true); // switched off = always
  assert.equal(scheduleState({ schedule: { enabled: true, windows: [] } }, at(1, 3)).active, true); // no window = always (never silently stops)
});

test('scheduler: outside the time windows it sleeps until the window opens', () => {
  const t = new Date(2026, 9, 5, 3, 0).getTime(); // Monday 03:00
  const timers = [];
  const profiles = [{ id: 'p', enabled: true, intervalMin: 5, feeds: [], schedule: { enabled: true, windows: [{ days: [], from: '06:00', to: '24:00', intervalMin: 0 }] } }];
  const runs = [];
  const s = createScheduler({ getProfiles: () => profiles, run: async () => runs.push(t), now: () => t, setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; }, clearTimer: (h) => timers.splice(timers.indexOf(h), 1) });
  s.start();
  timers.shift().fn(); // first tick: closed
  assert.equal(runs.length, 0);
  assert.equal(timers[0].ms, 3 * 3600_000);
});

test('filters: words (case and accents ignored), scope, duplicates, order, duplicates across feeds', () => {
  const items = [
    { title: 'Calcio: Roma vince', description: 'sport', date: 1000 },
    { title: 'Politica estera', description: 'Elezioni', date: 3000 },
    { title: 'Roma vince', description: 'sport', date: 2000 },
    { title: 'CALCIO: roma vince!', description: 'doppione', date: 500 }
  ];
  assert.equal(applyFilters(items, { include: ['calcio'], exclude: [] }).items.length, 2);
  assert.equal(applyFilters(items, { exclude: ['ELEZIONI'], scope: 'both' }).items.some((i) => i.title === 'Politica estera'), false);
  assert.equal(applyFilters(items, { exclude: ['elezioni'], scope: 'title' }).items.length, 4); // scope title: the word is only in a description
  assert.equal(applyFilters(items, { dedupe: true }).items.length, 3); // "Calcio: Roma vince" and "CALCIO: roma vince!" are the same story
  assert.deepEqual(applyFilters(items, { sort: 'newest' }).items.map((i) => i.date), [3000, 2000, 1000, 500]);
  const seen = new Set(['politica estera']);
  assert.equal(applyFilters(items, {}, seen).items.some((i) => i.title === 'Politica estera'), false);
  assert.equal(applyFilters(items, {}).removed, 0);
});

test('settings: schedule, filters, merged feed, digest are cleaned', () => {
  const p = sanitizeProfile({
    schedule: { enabled: true, windows: [{ days: [9, 1, 1], from: '6:30', to: 'xx', intervalMin: -4 }] },
    feeds: [
      { id: 'a', folder: 'A', url: 'https://x.test/a', filters: { include: 'calcio, Roma\nroma', exclude: [], sort: 'newest' } },
      { id: 'm', type: 'merge', folder: 'All', url: 'https://ignored', sources: ['a', 'a', 'nope', 'm'] }
    ]
  });
  assert.deepEqual(p.schedule.windows[0].days, [1]);
  assert.equal(p.schedule.windows[0].from, '06:30');
  assert.equal(p.schedule.windows[0].to, '24:00');
  assert.equal(p.schedule.windows[0].intervalMin, 0);
  assert.deepEqual(p.feeds[0].filters.include, ['calcio', 'Roma']);
  assert.equal(p.feeds[0].filters.sort, 'newest');
  assert.equal(p.feeds[1].url, '');
  assert.deepEqual(p.feeds[1].sources, ['a']); // only ordinary feeds of the profile, once
  const s = sanitizeSettings({ notifications: { digest: { enabled: true, times: ['8:05', '25:00', '08:05', '18:30'] } } });
  assert.deepEqual(s.notifications.digest.times, ['08:05', '18:30']);
});

function engineFor(feeds, images = {}, calls = []) {
  return createEngine({ get: fakeGet(feeds, images, calls), builtinPlaceholder: async () => PNG, retryDelayMs: 1 });
}

test('runFeed: filters apply before maxItems, newest-first order, left-out count reported', async () => {
  const out = await tmp();
  const p = sanitizeProfile({ ...newProfile('P'), outputDir: out });
  const feed = mkFeed({ maxItems: 2, filters: { include: [], exclude: ['sorteggio'], scope: 'both', sort: 'newest', dedupe: false } });
  const xml = RSS(item('Vecchia', 'a', '', 'Mon, 05 Oct 2026 08:00:00 GMT') + item('Sorteggio lotto', 'x', '', 'Mon, 05 Oct 2026 12:00:00 GMT') + item('Recente', 'b', '', 'Mon, 05 Oct 2026 11:00:00 GMT') + item('Media', 'c', '', 'Mon, 05 Oct 2026 09:00:00 GMT'));
  const r = await engineFor({ [feed.url]: xml }).runFeed(p, feed);
  assert.equal(r.ok, true);
  assert.equal(r.items, 2);
  assert.equal(r.filteredOut, 1);
  assert.equal(await fs.readFile(path.join(out, 'News_Title.Txt'), 'utf8'), 'Recente\nMedia');
});

test('dedupe across feeds of a profile: a story already used by an earlier feed is left out of the later ones', async () => {
  const out = await tmp();
  const a = mkFeed({ id: 'a', folder: 'A', url: 'https://f.test/a.xml', maxItems: 2 });
  const b = mkFeed({ id: 'b', folder: 'B', url: 'https://f.test/b.xml', maxItems: 2 });
  const p = sanitizeProfile({ ...newProfile('P'), outputDir: out, dedupeAcrossFeeds: true, feeds: [a, b] });
  const e = engineFor({ [a.url]: RSS(item('Uno', 'x') + item('Due', 'x')), [b.url]: RSS(item('Uno', 'x') + item('Tre', 'x') + item('Quattro', 'x')) });
  await e.runProfile(p);
  assert.equal(await fs.readFile(path.join(out, 'A_Title.Txt'), 'utf8'), 'Uno\nDue');
  assert.equal(await fs.readFile(path.join(out, 'B_Title.Txt'), 'utf8'), 'Tre\nQuattro'); // "Uno" skipped, still two stories
});

test('merged feed: newest first from several feeds, no duplicates, rebuilt only when a source changed', async () => {
  const out = await tmp();
  const a = mkFeed({ id: 'a', folder: 'A', url: 'https://f.test/a.xml', maxItems: 5 });
  const b = mkFeed({ id: 'b', folder: 'B', url: 'https://f.test/b.xml', maxItems: 5 });
  const m = mkFeed({ id: 'm', type: 'merge', folder: 'Latest', url: '', maxItems: 3, sources: ['a', 'b'] });
  const p = sanitizeProfile({ ...newProfile('P'), outputDir: out, feeds: [a, b, m] });
  let aXml = RSS(item('A1', 'x', '', 'Mon, 05 Oct 2026 10:00:00 GMT') + item('Comune', 'x', '', 'Mon, 05 Oct 2026 07:00:00 GMT'));
  const bXml = RSS(item('B1', 'x', '', 'Mon, 05 Oct 2026 11:00:00 GMT') + item('Comune', 'x', '', 'Mon, 05 Oct 2026 07:00:00 GMT') + item('B2', 'x', '', 'Mon, 05 Oct 2026 06:00:00 GMT'));
  const e = engineFor({ [a.url]: () => aXml, [b.url]: () => bXml });
  const mergeId = p.feeds[2].id;
  const r1 = await e.runProfile(p);
  assert.equal(r1[mergeId].ok, true);
  assert.equal(await fs.readFile(path.join(out, 'Latest_Title.Txt'), 'utf8'), 'B1\nA1\nComune');
  assert.equal((await fs.readdir(path.join(out, 'Latest'))).length, 3);
  // nothing changed at the sources and they are not due again: the merged feed is not even evaluated
  e.clearCaches();
  const r2 = await e.runProfile(p);
  assert.equal(r2[mergeId], undefined);
  // a source gets a newer story
  aXml = RSS(item('A2', 'x', '', 'Mon, 05 Oct 2026 12:00:00 GMT') + item('A1', 'x', '', 'Mon, 05 Oct 2026 10:00:00 GMT'));
  e.clearCaches();
  const r3 = await e.runProfile(p, () => {}, { force: true });
  assert.equal(r3[mergeId].changed, true);
  assert.equal(await fs.readFile(path.join(out, 'Latest_Title.Txt'), 'utf8'), 'A2\nB1\nA1');
});

test('output check: a corrupt image is caught after writing; locked-file errors are named', async () => {
  const out = await tmp();
  const p = sanitizeProfile({ ...newProfile('P'), outputDir: out });
  const feed = mkFeed();
  const bad = createEngine({ get: fakeGet({ [feed.url]: RSS(item('A', 'a')) }), convert: async () => Buffer.from('not a jpeg'), builtinPlaceholder: async () => PNG });
  const r = await bad.runFeed(p, feed);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'verify');
  assert.match(r.error, /not a valid JPEG/);
  const off = sanitizeProfile({ ...newProfile('P'), outputDir: out, verifyOutput: false });
  assert.equal((await bad.runFeed(off, feed)).ok, true); // switched off: no check
  assert.equal(classify(Object.assign(new Error('x'), { code: 'EBUSY', path: '/a/b/News_Title.Txt' })).code, 'locked');
  assert.match(classify(Object.assign(new Error('x'), { code: 'EPERM', path: '/a/b/News_Title.Txt' })).message, /News_Title\.Txt/);
});

test('remembered state: after a restart an unchanged feed is not rebuilt and no image is downloaded', async () => {
  const out = await tmp();
  const p = sanitizeProfile({ ...newProfile('P'), outputDir: out });
  const feed = mkFeed();
  const xml = RSS(item('A', 'a', 'https://i.test/1.png'));
  const calls1 = [];
  const e1 = engineFor({ [feed.url]: xml }, { 'https://i.test/1.png': PNG }, calls1);
  await e1.runFeed(p, feed);
  const saved = JSON.parse(JSON.stringify(e1.exportState()));
  const calls2 = [];
  const e2 = engineFor({ [feed.url]: xml }, { 'https://i.test/1.png': PNG }, calls2);
  assert.equal(e2.importState(saved), 1);
  const r = await e2.runFeed(p, feed);
  assert.equal(r.unchanged, true);
  assert.deepEqual(calls2, [feed.url]); // only the feed itself, no image
  assert.equal(e2.importState({ version: 9 }), 0);
});

test('runtime: stale feed alert once, recovery once; daily summary goes to the enabled channels', async () => {
  const out = await tmp();
  let t = new Date(2026, 9, 5, 9, 0).getTime();
  const feed = mkFeed({ id: 'f1' });
  const profile = sanitizeProfile({ ...newProfile('Radio'), outputDir: out, staleHours: 2, feeds: [feed] });
  let xml = RSS(item('A', 'a'));
  const desktop = [];
  const tg = [];
  const settings = sanitizeSettings({ profiles: [profile], notifications: { desktop: true, telegram: { enabled: true, botToken: 'x', recipients: [{ chatId: '1' }] } } });
  const rt = createRuntime({
    getSettings: () => settings,
    notifyDesktop: (x) => desktop.push(x),
    builtinPlaceholder: async () => PNG,
    now: () => t,
    deps: { engine: { get: async (url) => ({ status: 200, body: Buffer.from(xml), url, headers: {} }), retryDelayMs: 1 }, notify: { sendTelegram: async (c, text) => tg.push(text) } }
  });
  const prof = settings.profiles[0];
  const settle = () => new Promise((r) => setTimeout(r, 120));
  // wait for the run to really finish (a fixed pause is too short on a slow CI runner), then let the alerts go out
  const idle = async () => { for (let i = 0; i < 1000 && rt.scheduler.isRunning(prof.id); i++) await new Promise((r) => setTimeout(r, 10)); };
  const run = async () => { rt.engine.clearCaches(); rt.scheduler.runNow(prof.id); await idle(); await settle(); };
  await run();
  assert.equal(desktop.length, 0);
  t += 3 * 3600_000; // three hours later: same content
  await run();
  assert.equal(desktop.length, 1);
  assert.match(desktop[0], /no new stories for 3 hours/);
  t += 600_000;
  await run();
  assert.equal(desktop.length, 1); // not repeated while it stays quiet
  xml = RSS(item('B', 'b'));
  t += 600_000;
  await run();
  assert.match(desktop[1], /new stories again/);
  const text = rt.digestNow();
  await settle();
  assert.match(text, /Daily summary/);
  assert.match(text, /Radio: 1\/1 feeds OK/);
  assert.ok(tg.some((x) => x.includes('Daily summary')));
  assert.ok(!desktop.some((x) => x.includes('Daily summary'))); // the summary is not a desktop notification
  const d = buildDigest(settings, { profiles: { [prof.id]: { feeds: { f1: { ok: false, error: 'timeout' } } } } }, t);
  assert.match(d.text, /✗ News: timeout/);
  assert.equal(d.problems, 1);
  rt.dispose();
});

test('headless CLI: --once writes the files and exits 0; unusable settings exit 2; secrets come from the environment', async () => {
  const out = await tmp();
  const data = await tmp();
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/rss+xml'); res.end(RSS(item('Uno', 'd1') + item('Due', 'd2'))); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/f.xml`;
  const profile = sanitizeProfile({ ...newProfile('CLI'), outputDir: out, feeds: [mkFeed({ id: 'c1', folder: 'Cli', url })] });
  const file = path.join(data, 'settings.json');
  await fs.writeFile(file, JSON.stringify({ app: 'ticker-feed-builder', version: 1, settings: sanitizeSettings({ profiles: [profile] }) }));
  const run = (args, env = {}) => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(root, 'src', 'cli.js'), ...args], { env: { ...process.env, ...env } });
    let outp = '';
    c.stdout.on('data', (d) => (outp += d));
    c.stderr.on('data', (d) => (outp += d));
    c.on('close', (code) => resolve({ code, outp }));
  });
  const ok = await run(['--once', '--settings', file, '--data', path.join(data, 'd')]);
  assert.equal(ok.code, 0, ok.outp);
  assert.equal(await fs.readFile(path.join(out, 'Cli_Title.Txt'), 'utf8'), 'Uno\nDue');
  assert.ok(fsSync.existsSync(path.join(data, 'd', 'state.json')));
  const bad = await run(['--once', '--settings', path.join(data, 'missing.json')]);
  assert.equal(bad.code, 2);
  const s = loadSettingsFile(file, { TFB_TELEGRAM_TOKEN: 'tok', TFB_SMTP_PASS: 'pw' });
  assert.equal(s.notifications.telegram.botToken, 'tok');
  assert.equal(s.notifications.email.pass, 'pw');
  assert.equal(s.notifications.desktop, false);
  server.close();
});

test('new version alert: once per version, only when a channel is on and the option is on', async () => {
  const mk = (n) => {
    const sent = [];
    const settings = sanitizeSettings({ language: 'it', notifications: n });
    const rt = createRuntime({ getSettings: () => settings, builtinPlaceholder: async () => PNG, deps: { notify: { sendTelegram: async (c, text) => sent.push(text), sendEmail: async (c, subject, text) => sent.push(subject + ' | ' + text) } } });
    return { rt, sent };
  };
  const rel = { latest: '26.10.9', current: '26.10.8', url: 'https://github.com/djgragra/ticker-feed-builder/releases/tag/v26.10.9' };
  const settle = () => new Promise((r) => setTimeout(r, 60));

  const off = mk({}); // no channel switched on: nothing to say it on
  assert.equal(off.rt.announceUpdate(rel), false);

  const optionOff = mk({ updateAlert: false, telegram: { enabled: true, botToken: 'x', recipients: [{ chatId: '1' }] } });
  assert.equal(optionOff.rt.announceUpdate(rel), false);

  const on = mk({ telegram: { enabled: true, botToken: 'x', recipients: [{ chatId: '1' }] }, email: { enabled: true, host: 'h', recipients: ['a@x.org'], from: 'f@x.org' } });
  assert.equal(on.rt.announceUpdate(rel), true);
  await settle();
  assert.equal(on.sent.length, 2); // Telegram and email
  assert.ok(on.sent.every((x) => x.includes('26.10.9')));
  assert.match(on.sent[0], /nuova versione/); // in the language of the app
  assert.equal(on.rt.announceUpdate(rel), false); // the same version is never announced twice
  assert.equal(on.rt.announceUpdate({ ...rel, latest: '26.10.10' }), true); // a newer one is
  on.rt.dispose();
});

test('dashboard history: one bucket per clock hour for the last 24 hours, kept across a restart', async () => {
  const out = await tmp();
  const stateFile = path.join(await tmp(), 'state.json');
  const feed = mkFeed({ id: 'f1' });
  const profile = sanitizeProfile({ ...newProfile('Radio'), outputDir: out, feeds: [feed] });
  const settings = sanitizeSettings({ profiles: [profile] });
  let t = new Date(2026, 9, 10, 8, 10).getTime();
  let n = 0, fail = false;
  const mk = () => createRuntime({
    getSettings: () => settings, stateFile, builtinPlaceholder: async () => PNG, now: () => t,
    deps: { engine: { get: async (url) => { if (fail) throw new Error('HTTP 503'); return { status: 200, body: Buffer.from(RSS(item('A' + (n++), 'a'))), url, headers: {} }; }, retryDelayMs: 1 } }
  });
  const prof = settings.profiles[0];
  const rt = mk();
  const idle = async () => { for (let i = 0; i < 1000 && rt.scheduler.isRunning(prof.id); i++) await new Promise((r) => setTimeout(r, 10)); };
  const run = async () => { rt.engine.clearCaches(); rt.scheduler.runNow(prof.id); await idle(); };
  await run(); t += 600_000; await run(); // two checks in the 08:00 hour, both with new stories
  fail = true; t += 3_600_000; await run(); // 09:00 hour: one failed check
  const hist = rt.fullStatus().profiles[prof.id].history.f1;
  assert.equal(hist.length, 2);
  assert.deepEqual(hist.map((b) => [b.n, b.c, b.f]), [[2, 2, 0], [1, 0, 1]]);
  assert.ok(hist[0].h < hist[1].h);
  assert.equal(new Date(hist[0].h).getMinutes(), 0);
  rt.dispose(); // writes the state file

  // a restart: the strip is still there
  const rt2 = mk();
  rt2.loadState();
  assert.deepEqual(rt2.fullStatus().profiles[prof.id].history.f1, hist);

  // 30 hours later the old hours are gone; at most 24 buckets
  t += 30 * 3_600_000; fail = false;
  const rt3 = mk();
  rt3.loadState();
  assert.equal(rt3.fullStatus().profiles[prof.id].history?.f1, undefined);
  rt2.dispose(); rt3.dispose();
});

test('dashboard history: a state file without it, or with damaged entries, still loads', async () => {
  const out = await tmp();
  const dir = await tmp();
  const feed = mkFeed({ id: 'f1' });
  const profile = sanitizeProfile({ ...newProfile('Radio'), outputDir: out, feeds: [feed] });
  const settings = sanitizeSettings({ profiles: [profile] });
  const prof = settings.profiles[0];
  const stateFile = path.join(dir, 'state.json');
  const load = async (content) => {
    await fs.writeFile(stateFile, JSON.stringify(content));
    const rt = createRuntime({ getSettings: () => settings, stateFile, builtinPlaceholder: async () => PNG });
    rt.loadState();
    const h = rt.fullStatus().profiles[prof.id].history?.f1;
    rt.dispose();
    return h;
  };
  assert.equal(await load({ version: 1, engine: {}, alerts: {}, digestSent: {} }), undefined); // written by 26.10.8
  const hourNow = new Date(); hourNow.setMinutes(0, 0, 0);
  const good = { h: hourNow.getTime(), n: 3, c: 1, f: 0 };
  const h = await load({ version: 1, history: { [prof.id]: { f1: [good, { h: 'x', n: 1, c: 0, f: 0 }, null, { h: hourNow.getTime() - 1000, n: -4, c: 0, f: 0 }], gone: [good] }, other: { f1: [good] } } });
  assert.deepEqual(h, [good]); // only the valid entry, only for existing profile and feed
});

test('texts: English, Italian and Spanish have exactly the same keys', async () => {
  const src = await fs.readFile(new URL('../renderer/i18n.js', import.meta.url), 'utf8');
  const T = new Function(`${src}; return TEXTS;`)();
  const keys = (l) => new Set(Object.keys(T[l]));
  for (const l of ['it', 'es']) {
    assert.deepEqual([...keys('en')].filter((k) => !keys(l).has(k)), [], `missing in ${l}`);
    assert.deepEqual([...keys(l)].filter((k) => !keys('en').has(k)), [], `extra in ${l}`);
  }
});

test('icons: the SVG sources exist and every icon file is a real image of the right size', async () => {
  const dir = new URL('../assets/', import.meta.url);
  for (const f of ['logo.svg', 'tray.svg']) assert.match(await fs.readFile(new URL(f, dir), 'utf8'), /^<svg /);
  assert.equal(await fs.readFile(new URL('../renderer/logo.svg', import.meta.url), 'utf8'), await fs.readFile(new URL('logo.svg', dir), 'utf8')); // header logo = app icon
  const png = async (f) => { const b = await fs.readFile(new URL(f, dir)); assert.equal(b.subarray(1, 4).toString(), 'PNG'); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
  assert.deepEqual(await png('icon.png'), [1024, 1024]);
  for (const s of [16, 32, 48, 64, 128, 256, 512]) assert.deepEqual(await png(`linux-icons/${s}x${s}.png`), [s, s]);
  assert.deepEqual(await png('trayTemplate.png'), [22, 22]);
  assert.deepEqual(await png('trayTemplate@2x.png'), [44, 44]);
  const ico = await fs.readFile(new URL('icon.ico', dir));
  assert.equal(ico.readUInt16LE(2), 1); // icon resource
  assert.ok(ico.readUInt16LE(4) >= 6); // 16 … 256
  const icns = await fs.readFile(new URL('icon.icns', dir));
  assert.equal(icns.subarray(0, 4).toString(), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
});

const D = (h, m = 0, s0 = 0, day = 5) => new Date(2026, 9, day, h, m, s0).getTime(); // 2026-10-05 is a Monday
const fakeTimers = () => { const timers = []; return { timers, setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; }, clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); } }; };

test('plan: clock-aligned slots, fixed times and the last missed time', () => {
  // every 15 minutes on the clock
  assert.equal(nextAligned(D(10, 7), 15), D(10, 15));
  assert.equal(nextAligned(D(10, 15), 15), D(10, 30)); // strictly after
  assert.equal(nextAligned(D(23, 50), 15), D(24, 0)); // into the next day
  assert.equal(nextAligned(D(10, 7), 60), D(11, 0));
  assert.equal(nextAligned(D(10, 7), 30, 150_000), D(10, 32, 30)); // moved by 2:30
  assert.equal(nextAligned(D(23, 55), 7), D(24, 0)); // 7 does not divide the day: the grid restarts at midnight
  // fixed times, on the chosen days (Monday to Friday)
  const plan = { mode: 'times', times: ['06:30', '18:45'], days: [1, 2, 3, 4, 5] };
  assert.equal(nextTime(D(5), plan), D(6, 30));
  assert.equal(nextTime(D(7), plan), D(18, 45));
  assert.equal(nextTime(D(19), plan), D(6, 30, 0, 6)); // tomorrow
  assert.equal(nextTime(D(19, 0, 0, 9), plan), D(6, 30, 0, 12)); // Friday evening: next Monday
  assert.equal(lastTime(D(7), plan), D(6, 30));
  assert.equal(lastTime(D(5), plan), D(18, 45, 0, 2)); // before the first time of the day: yesterday's last one (Friday 2 Oct)
  assert.equal(nextTime(D(7), { times: ['xx'], days: [1] }), null);
});

test('scheduler: every N minutes on the clock waits for the next slot and keeps to it', async () => {
  let t = D(10, 7);
  const { timers, setTimer, clearTimer } = fakeTimers();
  const runs = [];
  const profiles = [{ id: 'p', enabled: true, intervalMin: 15, feeds: [], plan: { mode: 'aligned' } }];
  const s = createScheduler({ getProfiles: () => profiles, run: async (p, o) => { runs.push([t, o]); }, now: () => t, setTimer, clearTimer });
  s.start({ immediately: false });
  assert.equal(timers[0].ms, 8 * 60_000); // 10:07 -> 10:15
  t = D(10, 15);
  await timers.shift().fn();
  assert.equal(runs.length, 1);
  assert.equal(timers[0].ms, 15 * 60_000); // 10:15 -> 10:30
  s.stop();
});

test('scheduler: fixed times, missed time made up at start-up only when the last check is older, all feeds due', async () => {
  const profiles = [{ id: 'p', enabled: true, intervalMin: 5, feeds: [], plan: { mode: 'times', times: ['06:30', '18:45'], days: [0, 1, 2, 3, 4, 5, 6] } }];
  const runOf = async (last, immediately = true) => {
    const t = D(19, 0); // after 18:45
    const { timers, setTimer, clearTimer } = fakeTimers();
    const runs = [];
    const s = createScheduler({ getProfiles: () => profiles, run: async (p, o) => runs.push(o), now: () => t, setTimer, clearTimer, getLastCheck: () => last });
    s.start({ immediately });
    const first = timers[0].ms;
    await timers[0].fn();
    s.stop();
    return { first, runs };
  };
  const missed = await runOf(D(18, 0)); // last check before 18:45: made up now
  assert.equal(missed.first, 0);
  assert.deepEqual(missed.runs, [{ force: false, all: true }]);
  const fresh = await runOf(D(18, 50)); // already checked after 18:45: wait for tomorrow 06:30
  assert.equal(fresh.first, 11.5 * 3600_000);
  const never = await runOf(0, false); // "run at launch" off: no make-up
  assert.equal(never.first, 11.5 * 3600_000);
});

test('scheduler: clock-based plans skip a slot outside the time windows', async () => {
  let t = D(3, 0, 0);
  const { timers, setTimer, clearTimer } = fakeTimers();
  const runs = [];
  const profiles = [{ id: 'p', enabled: true, intervalMin: 30, feeds: [], plan: { mode: 'aligned' }, schedule: { enabled: true, windows: [{ days: [], from: '06:00', to: '24:00', intervalMin: 0 }] } }];
  const s = createScheduler({ getProfiles: () => profiles, run: async () => runs.push(t), now: () => t, setTimer, clearTimer });
  s.start({ immediately: true });
  await timers.shift().fn(); // 03:00, window closed: nothing runs
  assert.equal(runs.length, 0);
  assert.equal(timers[0].ms, 30 * 60_000); // simply the next slot, not "when the window opens"
  s.stop();
});

test('stagger: profiles sharing an interval are spread inside it, in list order; off by default', () => {
  const mk = (stagger) => {
    const t = D(10, 0);
    const { timers, setTimer, clearTimer } = fakeTimers();
    const profiles = [1, 2, 3].map((i) => ({ id: 'p' + i, enabled: true, intervalMin: 5, feeds: [], plan: { mode: 'interval' } }));
    profiles.push({ id: 'other', enabled: true, intervalMin: 10, feeds: [], plan: { mode: 'interval' } }); // alone in its group
    const s = createScheduler({ getProfiles: () => profiles, run: async () => {}, now: () => t, setTimer, clearTimer, getStagger: () => stagger });
    s.start({ immediately: true });
    return timers.map((x) => x.ms);
  };
  assert.deepEqual(mk(false), [0, 0, 0, 0]); // the old behaviour: everything at once
  assert.deepEqual(mk(true), [0, 100_000, 200_000, 0]); // 5 min / 3 = 1:40 apart
  // clock-aligned plans keep the shift at every slot
  const t = D(10, 0, 1);
  const { timers, setTimer, clearTimer } = fakeTimers();
  const profiles = [1, 2].map((i) => ({ id: 'a' + i, enabled: true, intervalMin: 5, feeds: [], plan: { mode: 'aligned' } }));
  const s = createScheduler({ getProfiles: () => profiles, run: async () => {}, now: () => t, setTimer, clearTimer, getStagger: () => true });
  s.start({ immediately: false });
  assert.equal(timers[0].ms, 299_000); // 10:05:00
  assert.equal(timers[1].ms, 149_000); // 10:02:30
  s.stop();
});

test('settings: the plan and the stagger option are cleaned; old settings get the old behaviour', () => {
  const old = sanitizeSettings({ profiles: [{ name: 'A', intervalMin: 5 }] });
  assert.equal(old.profiles[0].plan.mode, 'interval');
  assert.equal(old.general.staggerProfiles, false);
  const p = sanitizeProfile({ name: 'B', plan: { mode: 'times', times: '6:30, 18:45; 25:00, x, 06:30', days: [1, 9, 3] } });
  assert.deepEqual(p.plan, { mode: 'times', times: ['06:30', '18:45'], days: [1, 3] });
  assert.equal(sanitizeProfile({ name: 'C', plan: { mode: 'nonsense' } }).plan.mode, 'interval');
  assert.deepEqual(sanitizeProfile({ name: 'D', plan: { mode: 'times', times: [], days: [] } }).plan, { mode: 'times', times: ['08:00'], days: [0, 1, 2, 3, 4, 5, 6] });
});

test('fixed times: every enabled feed is checked (own intervals ignored); last check known after a restart', async () => {
  const out = await tmp();
  const stateFile = path.join(await tmp(), 'state.json');
  const calls = [];
  const feed = mkFeed({ id: 'f1', intervalMin: 60 }); // would normally be checked once an hour
  const profile = sanitizeProfile({ ...newProfile('Radio'), outputDir: out, feeds: [feed], plan: { mode: 'times', times: ['06:30'], days: [] } });
  const settings = sanitizeSettings({ profiles: [profile] });
  const prof = settings.profiles[0];
  let t = D(7, 0);
  const mk = () => createRuntime({ getSettings: () => settings, stateFile, builtinPlaceholder: async () => PNG, now: () => t, deps: { engine: { get: async (url) => { calls.push(url); return { status: 200, body: Buffer.from(RSS(item('A', 'a'))), url, headers: {} }; }, retryDelayMs: 1 } } });
  const rt = mk();
  assert.equal(rt.engine.lastCheckAt(prof.id), 0);
  await rt.engine.runProfile(prof, () => {});
  assert.equal(calls.length, 1);
  t += 600_000; // ten minutes later: not due for its hourly interval...
  await rt.engine.runProfile(prof, () => {});
  assert.equal(calls.length, 1);
  await rt.engine.runProfile(prof, () => {}, { all: true }); // ...but a fixed time checks it anyway
  assert.equal(calls.length, 2);
  assert.ok(rt.engine.lastCheckAt(prof.id) >= D(7, 10));
  rt.dispose();
  const rt2 = mk(); // restart: the remembered state still says when the profile was last checked
  rt2.loadState();
  assert.ok(rt2.engine.lastCheckAt(prof.id) > 0);
  rt2.dispose();
});
