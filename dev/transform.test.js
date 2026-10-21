// 26.10.12: text changes per feed (src/transform.js), the ad-hoc signature hook, the clickable tip jar.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { transformText, lineFor, parseRules, formatRules, sanitizeTransform, hasTransform, defaultTransform } from '../src/transform.js';
import { createEngine } from '../src/engine.js';
import { newProfile, sanitizeProfile } from '../src/settings.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const RSS = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items}</channel></rss>`;
const item = (t, d = '') => `<item><title>${t}</title><description>${d}</description></item>`;

test('rules: "search → replace" per line, also -> and =>; plain text, in order, empty replacement deletes', () => {
  const rules = parseRules('&amp; → &\nfoo -> bar\nx=>y\nno arrow here\n → nothing\ndelete me →');
  assert.deepEqual(rules, [{ from: '&amp;', to: '&' }, { from: 'foo', to: 'bar' }, { from: 'x', to: 'y' }, { from: 'delete me', to: '' }]);
  assert.equal(formatRules(rules.slice(0, 2)), '&amp; → &\nfoo → bar');
  // characters that mean something in patterns are just characters
  assert.equal(transformText('a.b (c) a.b', { replace: [{ from: 'a.b', to: '$&' }, { from: '(c)', to: '[c]' }] }), '$& [c] $&');
  assert.equal(transformText('Foo foo', { replace: [{ from: 'foo', to: 'x' }] }), 'Foo x'); // case sensitive
  assert.equal(transformText('a b', { replace: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] }), 'c c'); // in the order of the list
  assert.equal(transformText('keep  this', { replace: [{ from: 'keep ', to: '' }] }), 'this');
});

test('case: upper, lower, sentence (first letter only capital)', () => {
  assert.equal(transformText('Il Roma ha vinto', { case: 'upper' }), 'IL ROMA HA VINTO');
  assert.equal(transformText('Il Roma ha VINTO', { case: 'lower' }), 'il roma ha vinto');
  assert.equal(transformText('IL ROMA HA VINTO', { case: 'sentence' }), 'Il roma ha vinto');
  assert.equal(transformText('«ciao» ÈRA', { case: 'sentence' }), '«Ciao» èra');
  assert.equal(transformText('123 ABC', { case: 'sentence' }), '123 Abc');
  assert.equal(transformText('Così', { case: 'none' }), 'Così');
});

test('prefix and suffix go on the title only, after the case change; an empty text stays empty', () => {
  const tr = { case: 'upper', prefix: 'ANSA – ', suffix: ' (1)' };
  assert.equal(transformText('notizia', tr, 'title'), 'ANSA – NOTIZIA (1)');
  assert.equal(transformText('descrizione', tr, 'desc'), 'DESCRIZIONE');
  assert.equal(transformText('', tr, 'title'), '');
  assert.equal(transformText('', tr, 'desc'), '');
});

test('length limit comes after the changes; the feed limit wins over the profile limit, 0 = the profile limit', () => {
  const tr = { prefix: 'ANSA – ', maxTitleChars: 0 };
  assert.equal(lineFor('Una notizia molto lunga davvero', tr, 'title', 20), 'ANSA – Una notizia…');
  assert.equal(lineFor('Una notizia molto lunga davvero', { ...tr, maxTitleChars: 14 }, 'title', 20), 'ANSA – Una…');
  assert.equal(lineFor('abc', null, 'title', 0), 'abc');
  assert.equal(lineFor('Tom &amp; Jerry', { replace: [{ from: '&amp;', to: '&' }] }, 'title', 0), 'Tom & Jerry');
  assert.equal(lineFor('x'.repeat(50), { maxDescChars: 10 }, 'desc', 0).length, 10);
});

test('sanitizeTransform: defaults, limits, one line, bad input', () => {
  assert.deepEqual(sanitizeTransform(undefined), defaultTransform());
  assert.deepEqual(sanitizeTransform('x'), defaultTransform());
  const s = sanitizeTransform({ replace: [{ from: 'a\nb', to: 'c' }, { from: '', to: 'z' }, { from: 'x'.repeat(100), to: 'y' }, null, 'q'], case: 'weird', prefix: 'p\nq', suffix: 's'.repeat(99), maxTitleChars: -4, maxDescChars: '12.4' });
  assert.deepEqual(s.replace.map((r) => r.from.length), [3, 60]);
  assert.equal(s.replace[0].from, 'a b');
  assert.equal(s.case, 'none');
  assert.equal(s.prefix, 'p q');
  assert.equal(s.suffix.length, 40);
  assert.equal(s.maxTitleChars, 0);
  assert.equal(s.maxDescChars, 12);
  assert.equal(sanitizeTransform({ replace: Array.from({ length: 50 }, (_, i) => ({ from: `a${i}`, to: '' })) }).replace.length, 30);
  assert.equal(hasTransform(defaultTransform()), false);
  assert.equal(hasTransform({ ...defaultTransform(), prefix: 'x' }), true);
});

test('settings: an old feed without "transform" gets the default; a saved one is kept', () => {
  const p = sanitizeProfile({ ...newProfile('P'), feeds: [{ id: 'a', folder: 'A', url: 'https://f.test/a.xml' }, { id: 'b', folder: 'B', url: 'https://f.test/b.xml', transform: { case: 'upper', replace: [{ from: 'x', to: 'y' }] } }] });
  assert.deepEqual(p.feeds[0].transform, defaultTransform());
  assert.equal(p.feeds[1].transform.case, 'upper');
  assert.deepEqual(p.feeds[1].transform.replace, [{ from: 'x', to: 'y' }]);
});

test('engine: files and preview use the changes; a change of the rules rewrites the files even when the feed did not change', async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'tfb-t-'));
  const url = 'https://f.test/a.xml';
  const xml = RSS(item('Tom &amp;amp; Jerry', 'una descrizione') + item('Seconda notizia', ''));
  const get = async () => ({ status: 200, headers: {}, body: Buffer.from(xml), url });
  const eng = createEngine({ get, builtinPlaceholder: async () => PNG, retryDelayMs: 1 });
  const base = { id: 'f1', type: 'feed', folder: 'News', url, maxItems: 5, enabled: true };
  const p0 = sanitizeProfile({ ...newProfile('P'), outputDir: out, feeds: [base] });
  assert.equal((await eng.runFeed(p0, p0.feeds[0])).ok, true);
  assert.equal(await fs.readFile(path.join(out, 'News_Title.Txt'), 'utf8'), 'Tom & Jerry\nSeconda notizia');
  const tr = { replace: [{ from: '&', to: 'e' }], case: 'upper', prefix: 'ANSA – ', maxDescChars: 8 };
  const p1 = sanitizeProfile({ ...newProfile('P'), outputDir: out, feeds: [{ ...base, transform: tr }] });
  const r = await eng.runFeed(p1, p1.feeds[0]);
  assert.equal(r.ok, true);
  assert.notEqual(r.unchanged, true);
  assert.equal(await fs.readFile(path.join(out, 'News_Title.Txt'), 'utf8'), 'ANSA – TOM E JERRY\nANSA – SECONDA NOTIZIA');
  assert.equal((await fs.readFile(path.join(out, 'News_Description.Txt'), 'utf8')).split('\n')[0], 'UNA DES…');
  const pv = await eng.previewFeed(p1.feeds[0], 8, p1);
  assert.equal(pv.items[0].titleLine, 'ANSA – TOM E JERRY');
  assert.equal(pv.items[0].title, 'Tom & Jerry'); // the story as it is stays available
  const raw = await eng.previewFeed(p1.feeds[0], 8, p1, { raw: true });
  assert.equal(raw.items[0].titleLine, 'Tom & Jerry');
});

test('macOS: the ad-hoc signature hook is wired into the build and only acts on a Mac app', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.build.afterPack, 'dev/sign-adhoc.cjs');
  await fs.access(path.join(root, pkg.build.afterPack));
  assert.ok(pkg.build.files.every((f) => !f.includes('dev')), 'the hook is not packaged into the app');
  const hook = createRequire(import.meta.url)('./sign-adhoc.cjs').default;
  assert.equal(await hook({ electronPlatformName: 'win32' }), undefined);
  assert.equal(await hook({ electronPlatformName: 'linux' }), undefined);
  const wf = await fs.readFile(path.join(root, '.github/workflows/build-installers.yml'), 'utf8');
  assert.match(wf, /codesign --verify --deep --strict/, 'the workflow checks the apps inside the disk images');
  assert.match(wf, /npx electron-builder --mac --x64 --arm64|dist:mac/);
});

test('first-start text names the app path in the three languages and the Terminal command', async () => {
  const src = await fs.readFile(path.join(root, 'renderer/i18n.js'), 'utf8');
  const T = new Function(`${src}; return TEXTS;`)();
  for (const l of ['en', 'it', 'es']) {
    assert.match(T[l]['ab.unsigned'], /xattr -cr "\/Applications\/Ticker Feed Builder\.app" && codesign --force --deep -s - "\/Applications\/Ticker Feed Builder\.app"/);
    assert.match(T[l]['ab.unsigned'], /26\.10\.11/);
  }
});

test('the tip jar picture is a link like the button: same URL, keyboard reachable, one opener', async () => {
  const app = await fs.readFile(path.join(root, 'renderer/app.js'), 'utf8');
  const box = app.slice(app.indexOf('function tipBox()'), app.indexOf('function tipBox()') + 900);
  assert.match(box, /class: 'tip-jar-link', href: '#'[^]*onclick: open/);
  assert.match(box, /class: 'tip-btn', href: '#'[^]*onclick: open/);
  assert.equal((box.match(/api\.openExternal\(t\('tip\.url'\)\)/g) || []).length, 1);
  assert.match(box, /h\('img', \{ class: 'tip-jar'/); // the picture is inside the link
});

test('the renderer rules parser gives the same result as src/transform.js', async () => {
  const app = await fs.readFile(path.join(root, 'renderer/app.js'), 'utf8');
  const m = app.match(/const parseRules = [^\n]+\nconst formatRules = [^\n]+/);
  assert.ok(m);
  const { parseRules: rp, formatRules: rf } = new Function(`${m[0]}; return { parseRules, formatRules };`)();
  const text = '&amp; → &\nfoo -> bar\nx=>y\nnothing\ngone →\n → bad';
  assert.deepEqual(rp(text), parseRules(text));
  assert.equal(rf(rp(text)), formatRules(parseRules(text)));
});
