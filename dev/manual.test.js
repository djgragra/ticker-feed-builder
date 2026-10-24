import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const SOURCES = { en: 'docs/manual/manual.en.md', it: 'docs/manual/manual.it.md', es: 'docs/manual/manual.es.md' };
const count = (lang, re) => (read(SOURCES[lang]).match(re) || []).length;

test('the manual has the same chapters and the same structure in English, Italian and Spanish', () => {
  const chapters = count('en', /^## /gm);
  assert.ok(chapters >= 6);
  for (const lang of ['it', 'es']) {
    assert.equal(count(lang, /^## /gm), chapters, `${lang} chapters`);
    assert.equal(count(lang, /^### /gm), count('en', /^### /gm), `${lang} sections`);
    assert.equal(count(lang, /^\|---/gm), count('en', /^\|---/gm), `${lang} tables`);
  }
});

test('build.py makes the three PDFs with the standard names and the workflow attaches them to the release', () => {
  const build = read('docs/manual/build.py');
  assert.match(build, /NAME = "Ticker-Feed-Builder"/);
  assert.match(build, /\{NAME\}-Manual-\{lang\.upper\(\)\}-\{VER\}/);
  for (const f of Object.values(SOURCES)) assert.ok(fs.existsSync(new URL(`../${f}`, import.meta.url)), f);
  const wf = read('.github/workflows/build-installers.yml');
  assert.match(wf, /\n  manuals:\n/);
  assert.match(wf, /docs\/manual\/build\.py/);
  assert.match(wf, /manuals\]/);
});
