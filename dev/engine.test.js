import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanText, truncate, decodeEntities } from '../src/text.js';
import { parseFeed } from '../src/feed.js';
import { createEngine } from '../src/engine.js';
import { newProfile, sanitizeSettings, sanitizeProfile } from '../src/settings.js';
import { DEFAULT_FORMAT, sanitizeFormat, encodeLines, imageName } from '../src/format.js';
import { toJpeg } from '../src/image.js';
import { createScheduler } from '../src/scheduler.js';
import { createAlerter } from '../src/notify.js';

const RSS = (items) => `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>t</title>${items}</channel></rss>`;
const item = (t, d, img) => `<item><title>${t}</title><description>${d}</description>${img ? `<enclosure url="${img}" type="image/jpeg"/>` : ''}</item>`;

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'tfb-')); }
// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('cleanText: tags, entities, line breaks, double escaping', () => {
  assert.equal(cleanText('<p>Caff&egrave; &amp; <b>latte</b></p>\n<p>due</p>'), 'Caffè & latte due');
  assert.equal(cleanText('a\r\nb c\t d'), 'a b c d');
  assert.equal(cleanText('&lt;p&gt;x&lt;/p&gt; y'), 'x y');
  assert.equal(cleanText(null), '');
  assert.equal(decodeEntities('&#8364; &#x20AC; &unknown;'), '€ € &unknown;');
});

test('truncate: word boundary, never longer than the limit', () => {
  const s = 'uno due tre quattro cinque';
  const t = truncate(s, 14);
  assert.ok([...t].length <= 14);
  assert.ok(t.endsWith('…'));
  assert.equal(truncate('corto', 50), 'corto');
});

test('parseFeed: RSS enclosure, media, html img fallback, Atom', () => {
  const rss = RSS(
    item('A', 'a', 'https://x/a.jpg') +
      '<item><title>B</title><media:content url="https://x/b.png" medium="image"/></item>' +
      '<item><title>C</title><description><![CDATA[<p><img src="/c.jpg"> testo</p>]]></description></item>' +
      '<item><title>D</title></item>'
  );
  const r = parseFeed(rss, 'https://site.test/feed.xml');
  assert.equal(r.length, 4);
  assert.deepEqual(r.map((x) => x.image), ['https://x/a.jpg', 'https://x/b.png', 'https://site.test/c.jpg', null]);
  assert.equal(r[2].description, 'testo');
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>E</title><summary>s</summary><link rel="enclosure" type="image/jpeg" href="https://x/e.jpg"/></entry></feed>`;
  const a = parseFeed(atom, 'https://a.test/');
  assert.equal(a[0].title, 'E');
  assert.equal(a[0].image, 'https://x/e.jpg');
});

test('sanitizeFormat: defaults, bad templates, resize needs a size', () => {
  const f = sanitizeFormat({ titleFile: '../evil', imageDir: 'a/b', resize: 'cover', width: 0, imagePad: 99, encoding: 'x' });
  assert.equal(f.titleFile, DEFAULT_FORMAT.titleFile);
  assert.equal(f.imageDir, DEFAULT_FORMAT.imageDir);
  assert.equal(f.resize, 'none');
  assert.equal(f.imagePad, 8);
  assert.equal(f.encoding, 'utf8');
  assert.equal(imageName(DEFAULT_FORMAT, 0), '00001.JPG');
});

test('encodeLines: default is byte-identical to the original (LF, no BOM, no trailing newline)', () => {
  assert.equal(encodeLines(['a', 'è'], DEFAULT_FORMAT).toString('hex'), Buffer.from('a\nè').toString('hex'));
  assert.deepEqual([...encodeLines(['a'], sanitizeFormat({ encoding: 'utf8-bom' })).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(encodeLines(['a', 'b'], sanitizeFormat({ lineEnding: 'crlf', trailingNewline: true })).toString(), 'a\r\nb\r\n');
  assert.equal(encodeLines(['è€'], sanitizeFormat({ encoding: 'windows-1252' })).toString('hex'), 'e880');
});

test('toJpeg converts PNG to JPEG and honours resize', async () => {
  const j = await toJpeg(PNG, { quality: 80, resize: { mode: 'cover', width: 32, height: 18 } });
  assert.deepEqual([...j.subarray(0, 3)], [0xff, 0xd8, 0xff]);
});

function engineWith({ feeds, images = {} }) {
  const logs = [];
  const gets = [];
  const get = async (url) => {
    gets.push(url);
    if (feeds[url] instanceof Error) throw feeds[url];
    if (feeds[url]) return { status: 200, body: Buffer.from(feeds[url]), url, headers: {} };
    if (images[url]) return { status: 200, body: images[url], url, headers: {} };
    throw new Error('HTTP 404');
  };
  const engine = createEngine({ log: (l, m) => logs.push([l, m]), get, builtinPlaceholder: async () => PNG, retryDelayMs: 1, retries: 2 });
  return { engine, logs, gets };
}

test('runFeed: N items = N images = N title lines = N description lines; empty -> "-"; failed image -> placeholder', async () => {
  const out = await tmp();
  const p = sanitizeProfile({ ...newProfile('P'), outputDir: out });
  const feed = { id: 'f1', folder: 'News', url: 'https://f.test/a.xml', maxItems: 3, enabled: true, insecureTls: false };
  const xml = RSS(item('Uno', 'd1', 'https://i.test/1.png') + item('', 'd2', 'https://i.test/missing.png') + item('Tre\nsu due righe', '', null) + item('Quattro', 'x'));
  const { engine } = engineWith({ feeds: { [feed.url]: xml }, images: { 'https://i.test/1.png': PNG } });
  const r = await engine.runFeed(p, feed);
  assert.equal(r.ok, true);
  assert.equal(r.items, 3);
  assert.equal(r.imagesOriginal, 1);
  assert.equal(r.placeholders, 2);
  const titles = (await fs.readFile(path.join(out, 'News_Title.Txt'), 'utf8')).split('\n');
  const descs = (await fs.readFile(path.join(out, 'News_Description.Txt'), 'utf8')).split('\n');
  const imgs = (await fs.readdir(path.join(out, 'News'))).sort();
  assert.deepEqual(titles, ['Uno', '-', 'Tre su due righe']);
  assert.deepEqual(descs, ['d1', 'd2', '-']);
  assert.deepEqual(imgs, ['00001.JPG', '00002.JPG', '00003.JPG']);
  assert.ok((await fs.readFile(path.join(out, 'News_metadata.json'), 'utf8')).includes('"items_count": 3'));
});

test('runFeed: unchanged content is not rewritten; fewer items remove orphan images', async () => {
  const out = await tmp();
  const p = sanitizeProfile({ ...newProfile('P'), outputDir: out });
  const feed = { id: 'f1', folder: 'News', url: 'https://f.test/a.xml', maxItems: 5, enabled: true, insecureTls: false };
  const six = RSS([1, 2, 3, 4, 5].map((n) => item(`T${n}`, `D${n}`)).join(''));
  const h = engineWith({ feeds: { [feed.url]: six } });
  const r1 = await h.engine.runFeed(p, feed);
  assert.equal(r1.ok, true);
  const r2 = await h.engine.runFeed(p, feed, { force: true }); // forced: rebuilds, but writes nothing that is identical
  assert.equal(r2.filesWritten, 0);
  assert.equal(r2.filesUnchanged, 5 + 2);
  const two = RSS([1, 2].map((n) => item(`T${n}`, `D${n}`)).join(''));
  const h2 = engineWith({ feeds: { [feed.url]: two } });
  const r3 = await h2.engine.runFeed(p, feed, { force: true });
  assert.equal(r3.orphansRemoved, 3);
  assert.deepEqual((await fs.readdir(path.join(out, 'News'))).sort(), ['00001.JPG', '00002.JPG']);
});

test('runFeed: download failure leaves existing files untouched; missing output folder is reported, not created', async () => {
  const out = await tmp();
  const p = sanitizeProfile({ ...newProfile('P'), outputDir: out });
  const feed = { id: 'f1', folder: 'News', url: 'https://f.test/a.xml', maxItems: 2, enabled: true, insecureTls: false };
  const ok = engineWith({ feeds: { [feed.url]: RSS(item('A', 'a')) } });
  await ok.engine.runFeed(p, feed);
  const before = await fs.readFile(path.join(out, 'News_Title.Txt'), 'utf8');
  const bad = engineWith({ feeds: { [feed.url]: new Error('timeout') } });
  const r = await bad.engine.runFeed(p, feed);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'fetch');
  assert.equal(await fs.readFile(path.join(out, 'News_Title.Txt'), 'utf8'), before);
  const gone = { ...p, outputDir: path.join(out, 'not-there') };
  const r2 = await ok.engine.runFeed(gone, feed);
  assert.equal(r2.code, 'output-missing');
  await assert.rejects(fs.stat(gone.outputDir));
});

test('runFeed: image on a private address is skipped for a public feed', async () => {
  const out = await tmp();
  const p = sanitizeProfile({ ...newProfile('P'), outputDir: out });
  const feed = { id: 'f1', folder: 'News', url: 'https://f.test/a.xml', maxItems: 1, enabled: true, insecureTls: false };
  const h = engineWith({ feeds: { [feed.url]: RSS(item('A', 'a', 'http://192.168.1.5/x.jpg')) }, images: { 'http://192.168.1.5/x.jpg': PNG } });
  const r = await h.engine.runFeed(p, feed);
  assert.equal(r.placeholders, 1);
  assert.ok(!h.gets.includes('http://192.168.1.5/x.jpg'));
});

test('settings: duplicate folders renamed, bad URLs cleared, unsafe folder names fixed', () => {
  const s = sanitizeSettings({ profiles: [{ name: 'X', feeds: [{ folder: 'A', url: 'ftp://x' }, { folder: 'a', url: 'https://ok.test/f' }, { folder: '../x' }] }] });
  const f = s.profiles[0].feeds;
  assert.equal(f[0].url, '');
  assert.notEqual(f[0].folder.toLowerCase(), f[1].folder.toLowerCase());
  assert.ok(!f[2].folder.includes('/'));
  assert.equal(s.language, 'en');
});

test('scheduler: runs at once, repeats by interval, never overlaps, pause stops', async () => {
  let t = 0;
  const timers = [];
  const setTimer = (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; };
  const clearTimer = (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); };
  const profiles = [{ id: 'p', enabled: true, intervalMin: 5, feeds: [] }];
  const calls = [];
  let release;
  const s = createScheduler({ getProfiles: () => profiles, run: (p) => new Promise((r) => { calls.push(t); release = r; }), now: () => t, setTimer, clearTimer });
  s.start();
  timers.shift().fn();
  assert.equal(calls.length, 1);
  assert.equal(s.runNow('p'), false); // already running
  t = 1000;
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(timers.length, 1);
  assert.equal(timers[0].at, 5 * 60_000); // fixed rate: 5 min after the START of the previous run
  s.stop();
  assert.equal(timers.length, 0);
});

test('alerter: alerts at the threshold once, then once on recovery', () => {
  const sent = [];
  const settings = { language: 'en', notifications: { desktop: true, failThreshold: 3, telegram: { enabled: false } } };
  const a = createAlerter({ getSettings: () => settings, notifyDesktop: (t) => sent.push(t) });
  const texts = { downText: (n) => `down ${n}`, upText: () => 'up' };
  a.check('feed:1', false, texts);
  a.check('feed:1', false, texts);
  assert.equal(sent.length, 0);
  a.check('feed:1', false, texts);
  a.check('feed:1', false, texts);
  assert.deepEqual(sent, ['down 3']);
  a.check('feed:1', true, texts);
  a.check('feed:1', true, texts);
  assert.deepEqual(sent, ['down 3', 'up']);
  a.check('dir:p', false, texts); // output folder: immediate
  assert.equal(sent.length, 3);
});

test('change detection: unchanged feed is skipped (hash), 304 skips, deleted output or edited settings rebuild', async () => {
  const out = await tmp();
  const p = sanitizeProfile({ ...newProfile('P'), outputDir: out });
  const feed = { id: 'f1', folder: 'News', url: 'https://f.test/a.xml', maxItems: 3, enabled: true, insecureTls: false };
  let mode = 'full';
  const calls = [];
  const xml = RSS(item('A', 'a', 'https://i.test/1.png') + item('B', 'b', 'https://i.test/1.png'));
  const get = async (url, opts) => {
    calls.push({ url, h: opts.headers });
    if (url === feed.url) {
      if (mode === '304' && opts.headers['If-None-Match']) throw Object.assign(new Error('HTTP 304'), { status: 304 });
      return { status: 200, body: Buffer.from(xml), url, headers: { etag: '"v1"', 'last-modified': 'Wed, 01 Oct 2026 10:00:00 GMT' } };
    }
    return { status: 200, body: PNG, url, headers: {} };
  };
  const engine = createEngine({ get, builtinPlaceholder: async () => PNG, retryDelayMs: 1, now: (() => { let t = 1000; return () => (t += 1000); })() });
  const r1 = await engine.runFeed(p, feed);
  assert.equal(r1.unchanged, false);
  assert.equal(r1.changed, true);
  // same content: no image download, nothing written
  engine.clearCaches();
  calls.length = 0;
  const r2 = await engine.runFeed(p, feed);
  assert.equal(r2.unchanged, true);
  assert.equal(calls.filter((c) => c.url !== feed.url).length, 0);
  assert.equal(calls[0].h['If-None-Match'], '"v1"'); // asked the server "changed?"
  // server answers 304: not even the body is read
  engine.clearCaches();
  mode = '304';
  assert.equal((await engine.runFeed(p, feed)).unchanged, true);
  // an output file was deleted: rebuilt
  await fs.rm(path.join(out, 'News', '00002.JPG'));
  engine.clearCaches();
  const r3 = await engine.runFeed(p, feed);
  assert.equal(r3.unchanged, false);
  assert.ok((await fs.readdir(path.join(out, 'News'))).includes('00002.JPG'));
  // maxItems edited: rebuilt even though the feed did not change
  engine.clearCaches();
  const r4 = await engine.runFeed(p, { ...feed, maxItems: 1 });
  assert.equal(r4.unchanged, false);
  assert.equal(r4.items, 1);
});

test('change detection: a failed image is retried even if the feed did not change', async () => {
  const out = await tmp();
  const p = sanitizeProfile({ ...newProfile('P'), outputDir: out });
  const feed = { id: 'f1', folder: 'News', url: 'https://f.test/a.xml', maxItems: 3, enabled: true, insecureTls: false };
  const xml = RSS(item('A', 'a', 'https://i.test/1.png'));
  let imageUp = false;
  const get = async (url) => {
    if (url === feed.url) return { status: 200, body: Buffer.from(xml), url, headers: {} };
    if (!imageUp) throw new Error('HTTP 500');
    return { status: 200, body: PNG, url, headers: {} };
  };
  const engine = createEngine({ get, builtinPlaceholder: async () => PNG, retryDelayMs: 1 });
  const r1 = await engine.runFeed(p, feed);
  assert.equal(r1.placeholders, 1);
  imageUp = true;
  engine.clearCaches();
  const r2 = await engine.runFeed(p, feed);
  assert.equal(r2.unchanged, false);
  assert.equal(r2.imagesOriginal, 1);
});

test('runProfile: per-feed interval; force ignores it', async () => {
  const out = await tmp();
  let t = 0;
  const get = async (url) => ({ status: 200, body: Buffer.from(RSS(item('A', 'a'))), url, headers: {} });
  const engine = createEngine({ get, builtinPlaceholder: async () => PNG, now: () => t });
  const p = sanitizeProfile({ ...newProfile('P'), outputDir: out, intervalMin: 5, feeds: [
    { id: 'fast', folder: 'Fast', url: 'https://f.test/1.xml', intervalMin: 0 },
    { id: 'slow', folder: 'Slow', url: 'https://f.test/2.xml', intervalMin: 30 }
  ] });
  assert.deepEqual(Object.keys(await engine.runProfile(p)).sort(), ['fast', 'slow']);
  t = 5 * 60_000;
  assert.deepEqual(Object.keys(await engine.runProfile(p)), ['fast']);
  t = 30 * 60_000;
  assert.deepEqual(Object.keys(await engine.runProfile(p)).sort(), ['fast', 'slow']);
  assert.deepEqual(Object.keys(await engine.runProfile(p, () => {}, { force: true })).sort(), ['fast', 'slow']);
});
