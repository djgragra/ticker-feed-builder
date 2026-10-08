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
import { scheduleState } from '../src/schedule-rules.js';
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
  const run = async () => { rt.engine.clearCaches(); rt.scheduler.runNow(prof.id); await settle(); };
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
