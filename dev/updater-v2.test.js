// Updater version 2 (shared module): an interrupted, cancelled, stalled or failed download never leaves a .part file.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadInstaller, sweepPartials } from '../src/updater.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tfb-upd-'));
const NAME = 'Ticker-Feed-Builder-Setup-26.10.11.exe';
const payload = Buffer.alloc(300_000, 7);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// a fake GitHub: the sums file, and the installer in chunks (optionally failing, slow or never ending)
function fakeFetch({ body = payload, sums = `${sha(payload)}  ${NAME}\n`, failAfter = null, hang = false, status = 200 } = {}) {
  return async (url, { signal } = {}) => {
    if (url.endsWith('SHA256SUMS.txt')) return new Response(sums);
    let sent = 0;
    const stream = new ReadableStream({
      async pull(c) {
        if (signal?.aborted) return c.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (hang && sent > 0) {
          await new Promise((_, rej) => signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
        }
        if (failAfter !== null && sent >= failAfter) return c.error(new Error('network down'));
        if (sent >= body.length) return c.close();
        c.enqueue(body.subarray(sent, sent + 50_000));
        sent += 50_000;
      }
    });
    return new Response(stream, { status, headers: { 'content-length': String(body.length) } });
  };
}
const info = { installer: { name: NAME, url: `https://github.com/djgragra/ticker-feed-builder/releases/download/v26.10.11/${NAME}`, size: payload.length }, sumsUrl: 'https://github.com/djgragra/ticker-feed-builder/releases/download/v26.10.11/SHA256SUMS.txt' };
const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.part'));

// ---- download and the .part file ----------------------------------------------------------------------

test('a good download is verified and gets its real name; no .part is left', async () => {
  const dir = tmp();
  const file = await downloadInstaller({ info, dir, fetchFn: fakeFetch(), current: '26.10.2' });
  assert.equal(path.basename(file), NAME);
  assert.equal(sha(fs.readFileSync(file)), sha(payload));
  assert.deepEqual(leftovers(dir), []);
});

test('a checksum that does not match deletes the file', async () => {
  const dir = tmp();
  await assert.rejects(downloadInstaller({ info, dir, fetchFn: fakeFetch({ sums: `${'0'.repeat(64)}  ${NAME}\n` }), current: '26.10.2' }), /checksum-mismatch/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('an interrupted download (network error half way) leaves no .part', async () => {
  const dir = tmp();
  await assert.rejects(downloadInstaller({ info, dir, fetchFn: fakeFetch({ failAfter: 100_000 }), current: '26.10.2' }), /network down/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('cancelling removes the .part and says "cancelled"', async () => {
  const dir = tmp();
  const ctl = new AbortController();
  const p = downloadInstaller({ info, dir, fetchFn: fakeFetch({ hang: true }), current: '26.10.2', signal: ctl.signal, onProgress: () => {} });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(leftovers(dir).length, 1, 'the .part exists while downloading');
  ctl.abort();
  await assert.rejects(p, (e) => e.message === 'cancelled' && e.cancelled === true);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a download that stalls is given up and cleaned', async () => {
  const dir = tmp();
  await assert.rejects(downloadInstaller({ info, dir, fetchFn: fakeFetch({ hang: true }), current: '26.10.2', stallMs: 120 }), /stalled/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a failed rename (a folder with the final name) still removes the .part', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, NAME)); // renaming a file onto a folder fails
  await assert.rejects(downloadInstaller({ info, dir, fetchFn: fakeFetch(), current: '26.10.2' }));
  assert.deepEqual(leftovers(dir), []);
});

test('HTTP error and missing checksums stop before anything is written', async () => {
  const dir = tmp();
  await assert.rejects(downloadInstaller({ info, dir, fetchFn: fakeFetch({ sums: 'nothing useful' }), current: '26.10.2' }), /no-checksums/);
  await assert.rejects(downloadInstaller({ info: { ...info, sumsUrl: null }, dir, fetchFn: fakeFetch(), current: '26.10.2' }), /no-checksums/);
  await assert.rejects(downloadInstaller({ info: { sumsUrl: info.sumsUrl }, dir, fetchFn: fakeFetch(), current: '26.10.2' }), /no-installer/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('sweepPartials removes Ticker Feed Builder .part files an earlier run left, and nothing else', () => {
  const dir = tmp();
  for (const n of [`${NAME}.part`, 'Ticker-Feed-Builder-26.10.10-arm64.dmg.part', 'Other-App-1.0.exe.part', NAME, 'notes.txt']) fs.writeFileSync(path.join(dir, n), 'x');
  assert.deepEqual(sweepPartials(dir).sort(), [`${NAME}.part`, 'Ticker-Feed-Builder-26.10.10-arm64.dmg.part'].sort());
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Other-App-1.0.exe.part', NAME, 'notes.txt'].sort());
  assert.deepEqual(sweepPartials(path.join(dir, 'missing')), []);
});
