// 26.10.10: backup with secrets, guided update, signature (installation name, logs), maximum age of the stories.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../src/engine.js';
import { applyFilters } from '../src/filters.js';
import { newProfile, sanitizeProfile, sanitizeSettings, createStore } from '../src/settings.js';
import { SEALED_PREFIX, secretSlots, stripSecrets, mapSecrets, hasUserInfo, withoutUserInfo } from '../src/secrets.js';
import { buildExport, prepareImport, missingSecrets, backupFileName } from '../src/backup.js';
import { checkForUpdate, downloadInstaller, pickInstaller, isNewer, bannerState, remindLaterState, skipVersionState, makeSafetyCopy, installPlan, whatsNew, startupKind, releaseNotesSummary } from '../src/updater.js';
import { createLogger, LOG_FILE_RE } from '../src/logger.js';
import { alertPrefix } from '../src/notify.js';
import { loadSettingsFile } from '../src/cli.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'tfb-g-'));

// ---- backup ------------------------------------------------------------------------------------------

function sample() {
  const feed = { id: 'f1', type: 'feed', folder: 'ANSA', url: 'https://user:pw@feeds.test/a.xml', maxItems: 5 };
  const open = { id: 'f2', type: 'feed', folder: 'Open', url: 'https://feeds.test/b.xml', maxItems: 5 };
  const s = sanitizeSettings({
    language: 'it',
    installationName: 'Studio 2',
    lastSeenVersion: '26.10.9',
    updateState: { skipVersion: '26.10.10', remindUntil: 5, lastCheck: null },
    window: { x: 1, y: 2, width: 900, height: 700 },
    notifications: {
      telegram: { enabled: true, botToken: '123:SECRET', recipients: [{ chatId: '1', note: '' }] },
      email: { enabled: true, host: 'smtp.test', user: 'me', pass: 'hunter22', from: 'a@b.it', recipients: ['x@y.it'] }
    },
    profiles: [{ id: 'p1', name: 'Main', outputDir: '/o', feeds: [feed, open] }]
  });
  return s;
}

test('secrets: one list of slots (email password, Telegram token, feed addresses with credentials)', () => {
  const s = sample();
  assert.deepEqual(secretSlots(s).map((x) => x.id), ['email.pass', 'telegram.botToken', 'feed:p1:f1', 'feed:p1:f2']);
  assert.equal(hasUserInfo('https://user:pw@h.test/x'), true);
  assert.equal(withoutUserInfo('https://user:pw@h.test/x?y=1'), 'https://h.test/x?y=1');
  const { settings, emptied } = stripSecrets(s);
  assert.deepEqual(emptied, ['email.pass', 'telegram.botToken', 'feed:p1:f1']); // an address without credentials is not a secret
  assert.equal(settings.profiles[0].feeds[0].url, 'https://feeds.test/a.xml');
  assert.equal(settings.profiles[0].feeds[1].url, 'https://feeds.test/b.xml');
  // at rest: only what is secret is sealed
  const sealed = mapSecrets(s, (v) => SEALED_PREFIX + v);
  assert.equal(sealed.profiles[0].feeds[0].url, SEALED_PREFIX + 'https://user:pw@feeds.test/a.xml');
  assert.equal(sealed.profiles[0].feeds[1].url, 'https://feeds.test/b.xml');
});

test('store: feed credentials are sealed on disk and come back', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'settings.json');
  const seal = (v) => 'enc:v1:' + Buffer.from(v).toString('base64');
  const open = (v) => (v.startsWith('enc:v1:') ? Buffer.from(v.slice(7), 'base64').toString() : v);
  const store = createStore({ file, seal, open });
  store.replace(sample());
  store.flush();
  const raw = await fs.readFile(file, 'utf8');
  for (const secret of ['hunter22', '123:SECRET', 'user:pw@']) assert.ok(!raw.includes(secret), secret);
  const again = createStore({ file, seal, open }).get();
  assert.equal(again.profiles[0].feeds[0].url, 'https://user:pw@feeds.test/a.xml');
  assert.equal(again.notifications.email.pass, 'hunter22');
});

test('backup: without the box no secret is in the file; with it they are plain', () => {
  const s = sample();
  const off = buildExport(s, { now: Date.UTC(2026, 9, 13) });
  const text = JSON.stringify(off);
  for (const secret of ['hunter22', '123:SECRET', 'user:pw@']) assert.ok(!text.includes(secret), secret);
  assert.equal(off.app, 'ticker-feed-builder');
  assert.equal(off.includesSecrets, false);
  assert.equal(off.exportedAt, '2026-10-13T00:00:00.000Z');
  assert.deepEqual(off.emptiedSecrets, ['email.pass', 'telegram.botToken', 'feed:p1:f1']);
  assert.equal(backupFileName(Date.UTC(2026, 9, 13)), 'ticker-feed-builder-backup-2026-10-13.json');
  for (const k of ['lastSeenVersion', 'updateState', 'window', 'closeHintShown']) assert.ok(!(k in off.settings), k); // what stays on this PC
  assert.equal(off.profiles.length, 1);
  const on = buildExport(s, { includeSecrets: true });
  assert.equal(on.includesSecrets, true);
  assert.equal(on.emptiedSecrets, undefined);
  assert.equal(on.settings.notifications.email.pass, 'hunter22');
  assert.equal(on.profiles[0].feeds[0].url, 'https://user:pw@feeds.test/a.xml');
});

test('backup import: replace keeps the secrets of the same server and user, lists what to type again', () => {
  const cur = sample();
  const file = buildExport(cur);
  const r = prepareImport(JSON.stringify(file), cur);
  assert.equal(r.ok, true);
  assert.equal(r.settings.notifications.email.pass, 'hunter22'); // same host and user: kept
  assert.equal(r.settings.notifications.telegram.botToken, '123:SECRET');
  assert.equal(r.settings.profiles[0].feeds[0].url, 'https://user:pw@feeds.test/a.xml'); // same address without credentials: kept
  assert.deepEqual(r.missing, []);
  assert.equal(r.settings.lastSeenVersion, '26.10.9'); // this PC's own memory, not the file's
  assert.equal(r.settings.window.width, 900);
  // another PC: nothing is known, everything is listed
  const blank = sanitizeSettings({});
  const r2 = prepareImport(file, blank);
  assert.deepEqual(r2.missing.map((m) => m.kind), ['email.pass', 'telegram.botToken', 'feed']);
  assert.match(r2.missing[2].name, /Main \/ ANSA/);
  // a different user does not get the old password
  const other = structuredClone(cur);
  other.notifications.email.user = 'someone-else';
  assert.equal(prepareImport(file, other).settings.notifications.email.pass, '');
});

test('backup import: sealed values are dropped, other app and broken files are refused, an old file imports', () => {
  const cur = sample();
  const file = buildExport(cur, { includeSecrets: true });
  file.settings.notifications.email.pass = 'enc:v1:abcd';
  file.profiles[0].feeds[0].url = 'enc:v1:zzzz';
  const r = prepareImport(file, sanitizeSettings({}));
  assert.equal(r.settings.notifications.email.pass, '');
  assert.deepEqual(r.missing.map((m) => m.kind), ['email.pass', 'feed']);
  assert.equal(prepareImport({ app: 'g-clock', settings: {} }, cur).error, 'wrong-app');
  assert.equal(prepareImport('{nope', cur).error, 'invalid');
  assert.equal(prepareImport('x'.repeat(2_100_000), cur).error, 'too-big');
  // the first format of the app: profiles inside `settings`, no exportedAt
  const old = { app: 'ticker-feed-builder', version: 1, settings: { language: 'es', profiles: [{ id: 'old', name: 'Old', feeds: [] }] } };
  const r3 = prepareImport(old, cur);
  assert.equal(r3.ok, true);
  assert.equal(r3.settings.profiles[0].name, 'Old');
  assert.equal(r3.settings.language, 'es');
});

test('backup import: add-only keeps the settings and adds the profiles this PC does not have', () => {
  const cur = sample();
  const file = buildExport(cur, { includeSecrets: false });
  file.profiles.push({ id: 'p2', name: 'Second', outputDir: '/x', feeds: [{ id: 'g1', type: 'feed', folder: 'Credz', url: 'https://u:p@z.test/r.xml' }] });
  file.emptiedSecrets = [...file.emptiedSecrets, 'feed:p2:g1'];
  file.profiles[1].feeds[0].url = 'https://z.test/r.xml';
  const r = prepareImport(file, cur, { mode: 'add' });
  assert.equal(r.added, 1);
  assert.deepEqual(r.settings.profiles.map((p) => p.id), ['p1', 'p2']);
  assert.equal(r.settings.language, 'it'); // settings untouched
  assert.deepEqual(r.missing.map((m) => m.id), ['feed:p2:g1']);
  assert.equal(prepareImport(file, r.settings, { mode: 'add' }).added, 0); // nothing new the second time
});

test('headless: the program reads a backup file (profiles next to the settings)', async () => {
  const dir = await tmp();
  const f = path.join(dir, 'b.json');
  await fs.writeFile(f, JSON.stringify(buildExport(sample())));
  const s = loadSettingsFile(f, { TFB_SMTP_PASS: 'envpass' });
  assert.equal(s.profiles.length, 1);
  assert.equal(s.notifications.email.pass, 'envpass');
});

test('missingSecrets: email and Telegram are asked only when they are in use', () => {
  const s = sanitizeSettings({ notifications: { email: { enabled: true, host: 'h', user: 'u' } } });
  assert.deepEqual(missingSecrets(s).map((m) => m.id), ['email.pass']);
  assert.deepEqual(missingSecrets(sanitizeSettings({})).length, 0);
});

// ---- guided update -------------------------------------------------------------------------------------

const asset = (name, size = 3) => ({ name, size, browser_download_url: `https://github.com/djgragra/ticker-feed-builder/releases/download/v26.10.10/${name}` });
function releaseFetch({ body = 'payload', sums, status = 200 } = {}) {
  const bytes = Buffer.from(body);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (url.includes('api.github.com')) {
      return { ok: status === 200, status, json: async () => ({ tag_name: 'v26.10.10', body: '## What\n- one\n- two', assets: [asset('Ticker-Feed-Builder-Setup-26.10.10.exe'), asset('Ticker-Feed-Builder-26.10.10-arm64.dmg'), asset('Ticker-Feed-Builder-26.10.10-x64.dmg'), asset('Ticker-Feed-Builder-26.10.10.AppImage'), asset('SHA256SUMS.txt'), { name: 'evil.exe', browser_download_url: 'https://evil.test/evil.exe' }] }) };
    }
    if (url.endsWith('SHA256SUMS.txt')) return { ok: true, status: 200, text: async () => `${sums ?? sha}  Ticker-Feed-Builder-Setup-26.10.10.exe\n` };
    return { ok: true, status: 200, headers: new Map([['content-length', String(bytes.length)]]), body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) };
  };
  return { fn, calls };
}
const Hdr = Map; // headers.get()

test('updater: finds the release, the installer of this system and never follows foreign URLs', async () => {
  const { fn } = releaseFetch();
  const info = await checkForUpdate({ current: '26.10.9', fetchFn: fn });
  assert.equal(info.ok, true);
  assert.equal(info.available, true);
  assert.equal(info.latest, '26.10.10');
  assert.equal(info.notes, 'What\none\ntwo');
  assert.equal(info.url, 'https://github.com/djgragra/ticker-feed-builder/releases/tag/v26.10.10');
  const here = pickInstaller([asset('Ticker-Feed-Builder-Setup-26.10.10.exe'), asset('Ticker-Feed-Builder-26.10.10-arm64.dmg'), asset('Ticker-Feed-Builder-26.10.10-x64.dmg'), asset('Ticker-Feed-Builder-26.10.10.AppImage')]);
  assert.equal(info.installer?.name, here?.name); // the one of the system running the test
  assert.equal(pickInstaller([asset('Ticker-Feed-Builder-Setup-26.10.10.exe')], 'win32', 'x64').name, 'Ticker-Feed-Builder-Setup-26.10.10.exe');
  assert.equal(pickInstaller([asset('Ticker-Feed-Builder-26.10.10-arm64.dmg'), asset('Ticker-Feed-Builder-26.10.10-x64.dmg')], 'darwin', 'arm64').name, 'Ticker-Feed-Builder-26.10.10-arm64.dmg');
  assert.equal(pickInstaller([asset('Ticker-Feed-Builder-26.10.10.AppImage')], 'linux', 'arm64'), null);
  assert.equal((await checkForUpdate({ current: '26.10.10', fetchFn: fn })).available, false); // equal
  assert.equal((await checkForUpdate({ current: '26.11.1', fetchFn: fn })).available, false); // older
  assert.equal(isNewer('26.10.10', '26.10.9'), true);
  assert.equal((await checkForUpdate({ repo: 'not a repo', current: '1', fetchFn: fn })).error, 'invalid-repo');
  assert.equal((await checkForUpdate({ current: '1', fetchFn: async () => ({ ok: false, status: 404 }) })).noRelease, true);
});

test('updater: the download is checked against SHA256SUMS.txt; a wrong hash deletes the file', async () => {
  const dir = await tmp();
  const ok = releaseFetch();
  const info = { installer: { name: 'Ticker-Feed-Builder-Setup-26.10.10.exe', url: 'https://github.com/djgragra/ticker-feed-builder/releases/download/v26.10.10/Ticker-Feed-Builder-Setup-26.10.10.exe', size: 7 }, sumsUrl: 'https://github.com/x/SHA256SUMS.txt' };
  const seen = [];
  const file = await downloadInstaller({ info, dir, fetchFn: ok.fn, current: '1', onProgress: (a, b) => seen.push([a, b]) });
  assert.equal(await fs.readFile(file, 'utf8'), 'payload');
  assert.deepEqual(seen.at(-1), [7, 7]);
  const bad = releaseFetch({ sums: 'a'.repeat(64) });
  await assert.rejects(downloadInstaller({ info, dir: path.join(dir, 'b'), fetchFn: bad.fn, current: '1' }), /checksum-mismatch/);
  assert.deepEqual(await fs.readdir(path.join(dir, 'b')), []); // no .part and no installer left
  await assert.rejects(downloadInstaller({ info: { installer: info.installer }, dir, fetchFn: ok.fn, current: '1' }), /no-checksums/);
  // interrupted: the partial file is removed
  const broken = async (url) => (url.endsWith('SHA256SUMS.txt') ? ok.fn(url) : { ok: true, status: 200, headers: new Hdr(), body: new ReadableStream({ start(c) { c.enqueue(Buffer.from('ab')); c.error(new Error('connection lost')); } }) });
  await assert.rejects(downloadInstaller({ info, dir: path.join(dir, 'c'), fetchFn: broken, current: '1' }), /connection lost/);
  assert.deepEqual(await fs.readdir(path.join(dir, 'c')), []);
});

test('updater: remind later (24 h), skip this version (until a newer one), nothing when equal', () => {
  const info = { ok: true, available: true, latest: '26.10.10' };
  const t0 = 1_000_000;
  assert.equal(bannerState(info, {}, t0), 'show');
  const later = remindLaterState({}, t0);
  assert.equal(bannerState(info, later, t0 + 3_600_000), 'snoozed');
  assert.equal(bannerState(info, later, t0 + 86_400_001), 'show');
  const skipped = skipVersionState({}, '26.10.10');
  assert.equal(bannerState(info, skipped, t0), 'skipped');
  assert.equal(bannerState({ ...info, latest: '26.10.11' }, skipped, t0), 'show');
  assert.equal(bannerState({ ok: true, available: false }, {}, t0), 'none');
  assert.equal(bannerState({ ok: false }, {}, t0), 'none');
});

test('safety copy before the install: a plain copy of the settings file, the last 3 are kept', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'settings.json');
  await fs.writeFile(file, '{"version":1}');
  const out = path.join(dir, 'backups');
  for (const v of ['26.10.6', '26.10.7', '26.10.8', '26.10.9']) {
    const target = makeSafetyCopy({ file, dir: out, version: v });
    assert.equal(await fs.readFile(target, 'utf8'), '{"version":1}');
    await fs.utimes(target, new Date(Date.UTC(2026, 9, Number(v.split('.')[2]))), new Date(Date.UTC(2026, 9, Number(v.split('.')[2]))));
  }
  assert.deepEqual((await fs.readdir(out)).sort(), ['pre-update-26.10.7.json', 'pre-update-26.10.8.json', 'pre-update-26.10.9.json']);
  assert.equal(makeSafetyCopy({ file: path.join(dir, 'missing.json'), dir: out, version: 'x' }), null);
});

test('install plan per system, what\'s new from the changelog, first start after an update', async () => {
  assert.deepEqual(installPlan('win32', 'C:\\x\\a.exe'), { kind: 'run-installer', file: 'C:\\x\\a.exe', quit: true });
  assert.equal(installPlan('darwin', '/a.dmg').kind, 'open-image');
  assert.equal(installPlan('linux', '/a.AppImage').kind, 'reveal');
  const log = '# Changelog\n\n## 26.10.10 — 2026-10-13\n\n- **A**: first.\n- B second.\n\n## 26.10.9 — 2026-10-10\n\n- old\n';
  assert.deepEqual(whatsNew(log, '26.10.10'), { version: '26.10.10', date: '2026-10-13', bullets: ['**A**: first.', 'B second.'] });
  assert.equal(whatsNew(log, '26.10.11'), null);
  assert.equal(startupKind('', '26.10.10', false), 'first');
  assert.equal(startupKind('', '26.10.10', true), 'updated'); // the previous version did not remember anything
  assert.equal(startupKind('26.10.9', '26.10.10'), 'updated');
  assert.equal(startupKind('26.10.10', '26.10.10'), 'same');
  assert.equal(releaseNotesSummary('# T\n\n- a\n- b', 1), 'T');
  // the bundled CHANGELOG has the text of the version in package.json, and it is packaged with the app
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const real = whatsNew(await fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8'), pkg.version);
  assert.ok(real && real.bullets.length > 0, `CHANGELOG.md has no entry for ${pkg.version}`);
  assert.ok(pkg.build.files.includes('CHANGELOG.md'));
});

// ---- signature -----------------------------------------------------------------------------------------

test('alerts start with [App · installation]; the computer name is used when no name is set', () => {
  assert.equal(alertPrefix({ installationName: 'Studio 2' }), '[Ticker Feed Builder · Studio 2]');
  assert.equal(alertPrefix({ installationName: '' }), `[Ticker Feed Builder · ${os.hostname()}]`);
  assert.equal(sanitizeSettings({ installationName: '  Regia  ' }).installationName, 'Regia');
});

test('logs: one file per day, a file that reaches the limit is closed and a new one starts, old days are removed', async () => {
  const dir = await tmp();
  let day = new Date(2026, 9, 13, 12, 0, 0);
  const log = createLogger({ dir, retentionDays: 7, maxBytes: 200, now: () => day });
  for (let i = 0; i < 12; i++) log.log('info', `line number ${i} ${'x'.repeat(40)}`);
  await log.flush();
  const names = (await fs.readdir(dir)).sort();
  assert.ok(names.every((n) => LOG_FILE_RE.test(n)), names.join());
  assert.ok(names.includes('ticker-feed-builder_13-10-2026.log'));
  assert.ok(names.length >= 2 && names.length <= 4, `${names.length} files for one day`); // never more than 4
  for (const n of names) assert.ok((await fs.stat(path.join(dir, n))).size <= 400, n);
  // a day more than 7 days old goes away
  day = new Date(2026, 9, 25, 12, 0, 0);
  assert.ok(log.prune() >= 1);
  assert.deepEqual(await fs.readdir(dir), []);
});

// ---- maximum age of the stories ------------------------------------------------------------------------

const H = 3_600_000;
test('filters: stories older than the limit are left out; no date follows the choice; the future is kept', () => {
  const now = Date.UTC(2026, 9, 13, 12);
  const items = [
    { title: 'Fresh', description: '', date: now - 2 * H },
    { title: 'Old', description: '', date: now - 30 * H },
    { title: 'Undated', description: '', date: null },
    { title: 'Future', description: '', date: now + 5 * H }
  ];
  const keep = applyFilters(items, { maxAgeHours: 24, undated: 'keep' }, null, now);
  assert.deepEqual(keep.items.map((i) => i.title), ['Fresh', 'Undated', 'Future']);
  assert.equal(keep.removed, 1);
  assert.deepEqual(applyFilters(items, { maxAgeHours: 24, undated: 'drop' }, null, now).items.map((i) => i.title), ['Fresh', 'Future']);
  assert.equal(applyFilters(items, { maxAgeHours: 0, undated: 'drop' }, null, now).items.length, 4); // off
  assert.equal(sanitizeProfile({ feeds: [{ id: 'a', url: 'https://x.test/', filters: { maxAgeHours: 99999, undated: 'zzz' } }] }).feeds[0].filters.maxAgeHours, 8760);
  assert.equal(sanitizeProfile({ feeds: [{ id: 'a', url: 'https://x.test/' }] }).feeds[0].filters.undated, 'keep');
});

test('runFeed with a maximum age: a story that grows too old leaves the files even if the feed does not change', async () => {
  const out = await tmp();
  let t = Date.UTC(2026, 9, 13, 8);
  const fresh = new Date(t - 1 * H).toUTCString();
  const mid = new Date(t - 20 * H).toUTCString();
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title><item><title>New</title><description>a</description><pubDate>${fresh}</pubDate></item><item><title>Older</title><description>b</description><pubDate>${mid}</pubDate></item></channel></rss>`;
  const calls = [];
  const get = async (url, opts) => { calls.push([url, opts]); return { status: 200, body: Buffer.from(xml), url, headers: {} }; };
  const e = createEngine({ get, builtinPlaceholder: async () => PNG, retryDelayMs: 1, now: () => t });
  const feed = { id: 'f1', type: 'feed', folder: 'News', url: 'https://f.test/a.xml', maxItems: 5, enabled: true, insecureTls: false, intervalMin: 0, staleHours: 0, filters: { include: [], exclude: [], scope: 'both', sort: 'feed', dedupe: false, maxAgeHours: 24, undated: 'keep' }, sources: [] };
  const p = sanitizeProfile({ ...newProfile('P'), outputDir: out, feeds: [feed] });
  const r1 = await e.runFeed(p, p.feeds[0]);
  assert.equal(r1.ok, true);
  assert.equal(await fs.readFile(path.join(out, 'News_Title.Txt'), 'utf8'), 'New\nOlder');
  const r2 = await e.runFeed(p, p.feeds[0]);
  assert.equal(r2.unchanged, true); // same stories chosen: nothing is rewritten
  t += 6 * H; // "Older" is now 26 h old, the feed itself has not changed
  const r3 = await e.runFeed(p, p.feeds[0]);
  assert.equal(r3.ok, true);
  assert.equal(r3.unchanged, false);
  assert.equal(r3.filteredOut, 1);
  assert.equal(await fs.readFile(path.join(out, 'News_Title.Txt'), 'utf8'), 'New');
  assert.ok(calls.every(([, o]) => !o?.etag && !o?.ifNoneMatch), 'no conditional request while the age filter is on');
  t += 30 * H; // everything is too old: the check fails, the files stay
  const r4 = await e.runFeed(p, p.feeds[0]);
  assert.equal(r4.ok, false);
  assert.equal(await fs.readFile(path.join(out, 'News_Title.Txt'), 'utf8'), 'New');
});

// ---- the repository points to the hub ------------------------------------------------------------------

test('CLAUDE.md points to the hub and is not ignored by git', async () => {
  const text = await fs.readFile(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.match(text, /djgragra\/garage-hub/);
  assert.ok(!/^CLAUDE\.md$/m.test(await fs.readFile(path.join(root, '.gitignore'), 'utf8')));
});
