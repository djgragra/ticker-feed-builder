// garage-common: updater 2
// Guided update: asks GitHub for the latest release of the public repository, downloads the installer for
// this system on request, checks it against the release's SHA256SUMS.txt and says how to install it.
// Nothing is installed without a click. Electron-free: fetch and version are injected, so it can be tested.
//
// Version 2 (first in G-Clock 26.10.3) differs from version 1 in how an interrupted download is cleaned up: the
// "<name>.part" file is closed *before* it is deleted (Windows refuses to delete an open file, which left
// the .part behind), a cancelled, stalled or failed download always removes it, and `sweepPartials` removes
// the ones an earlier run left when the app was closed in the middle of a download.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const REPO = 'djgragra/ticker-feed-builder';
export const PRODUCT = 'Ticker-Feed-Builder';
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const DAY = 86_400_000;
const STALL_MS = 60_000; // no byte for this long: the download is given up and cleaned up

function parts(v) {
  return String(v || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
}

export function isNewer(latest, current) {
  const a = parts(latest);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// Only download URLs that belong to this repository's releases are ever followed.
function releaseAssets(repo, rel) {
  const prefix = `https://github.com/${repo}/releases/download/`;
  return (rel.assets || [])
    .filter((a) => typeof a.browser_download_url === 'string' && a.browser_download_url.startsWith(prefix))
    .map((a) => ({ name: String(a.name), url: a.browser_download_url, size: a.size || 0 }));
}

// Windows setup .exe, macOS .dmg for this processor (arm64, or Intel: "-x64" or no suffix, as 26.10.2 and
// older were named), Linux .AppImage (x64 only).
export function pickInstaller(assets, platform = process.platform, arch = process.arch) {
  const tests = {
    win32: (n) => new RegExp(`^${PRODUCT}-Setup-[\\d.]+\\.exe$`, 'i').test(n),
    darwin: (n) => new RegExp(`^${PRODUCT}-[\\d.]+${arch === 'arm64' ? '-arm64' : '(-x64)?'}\\.dmg$`, 'i').test(n),
    linux: (n) => arch === 'x64' && new RegExp(`^${PRODUCT}-[\\d.]+\\.AppImage$`, 'i').test(n)
  };
  const test = tests[platform];
  return (test && assets.find((a) => test(a.name))) || null;
}

// The first lines of the release notes, plain text, for the banner.
export function releaseNotesSummary(body, maxLines = 6, maxChars = 500) {
  const lines = String(body || '').split(/\r?\n/).map((l) => l.replace(/^[#>*\-\s]+/, '').replace(/[*_`]/g, '').trim()).filter(Boolean);
  const text = lines.slice(0, maxLines).join('\n');
  return text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text;
}

export async function checkForUpdate({ repo = REPO, current, fetchFn }) {
  if (!REPO_RE.test(repo || '')) return { ok: false, current, error: 'invalid-repo' };
  try {
    const res = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `${PRODUCT}/${current}` },
      signal: AbortSignal.timeout(15_000)
    });
    if (res.status === 404) return { ok: true, current, available: false, noRelease: true };
    if (!res.ok) return { ok: false, current, error: `GitHub HTTP ${res.status}` };
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    const assets = releaseAssets(repo, rel);
    return {
      ok: true,
      current,
      latest,
      available: isNewer(latest, current),
      // only ever this repository's release page, never a URL taken as-is from the response
      url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(rel.tag_name || '')}`,
      notes: releaseNotesSummary(rel.body),
      installer: pickInstaller(assets),
      sumsUrl: assets.find((a) => a.name === 'SHA256SUMS.txt')?.url || null
    };
  } catch (err) {
    return { ok: false, current, error: err.message };
  }
}

const PARTIAL_RE = new RegExp(`^${PRODUCT}-.+\\.part$`, 'i');

// Removes the "Ticker-Feed-Builder-….part" files left in `dir` by a download that was interrupted (app closed, power cut).
// Call it when the app starts and before a new download; never while a download of this process is running.
export function sweepPartials(dir) {
  const removed = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  for (const n of names) {
    if (!PARTIAL_RE.test(n)) continue;
    try {
      fs.rmSync(path.join(dir, n), { force: true });
      removed.push(n);
    } catch {
      /* in use by another process: left alone */
    }
  }
  return removed;
}

// Deletes a file, trying again a few times: on Windows a file that was just closed can stay locked for a moment
// (virus scanner, indexer).
async function removeFile(file, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try {
      fs.rmSync(file, { force: true });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
  return !fs.existsSync(file);
}

const closed = (stream) => new Promise((resolve) => {
  if (stream.closed) return resolve();
  stream.once('close', resolve);
  stream.destroy();
});

// Written as "<name>.part"; it gets its real name only when the checksum matches, otherwise it is deleted
// (checksum mismatch, network error, cancel, stall, a rename that fails): nothing named .part is left behind.
export async function downloadInstaller({ info, dir, fetchFn, current, onProgress, signal, stallMs = STALL_MS }) {
  if (!info?.installer) throw new Error('no-installer');
  if (!info.sumsUrl) throw new Error('no-checksums');
  const { name, url } = info.installer;
  const headers = { 'User-Agent': `${PRODUCT}/${current}` };
  const cancelled = () => Object.assign(new Error('cancelled'), { cancelled: true });
  const guard = (err) => (signal?.aborted ? cancelled() : err);

  let expected;
  try {
    const sumsRes = await fetchFn(info.sumsUrl, { headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
    if (!sumsRes.ok) throw new Error(`SHA256SUMS.txt: HTTP ${sumsRes.status}`);
    const line = (await sumsRes.text()).split('\n').map((l) => l.trim().split(/\s+\*?/)).find((p) => p[1] === name);
    if (!line || !/^[0-9a-f]{64}$/i.test(line[0])) throw new Error('no-checksums');
    expected = line[0].toLowerCase();
  } catch (err) {
    throw guard(err);
  }

  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, path.basename(name));
  const partial = `${file}.part`;
  const stall = new AbortController();
  const both = signal ? AbortSignal.any([signal, stall.signal]) : stall.signal;
  let timer = null;
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stall.abort(), stallMs);
  };
  let out = null;
  try {
    kick();
    const res = await fetchFn(url, { headers, signal: both });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || info.installer.size || 0;
    out = fs.createWriteStream(partial);
    let streamError = null;
    out.on('error', (e) => { streamError = e; }); // reported below, never an unhandled 'error' event
    const hash = crypto.createHash('sha256');
    let received = 0;
    let lastReport = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      kick();
      if (streamError) throw streamError;
      hash.update(value);
      received += value.length;
      if (!out.write(Buffer.from(value))) await new Promise((r, j) => { out.once('drain', r); out.once('error', j); });
      const now = Date.now();
      if (onProgress && now - lastReport > 250) {
        lastReport = now;
        onProgress(received, total);
      }
    }
    clearTimeout(timer);
    await new Promise((resolve, reject) => out.end((err) => (err || streamError ? reject(err || streamError) : resolve())));
    await closed(out);
    onProgress?.(received, total);
    if (hash.digest('hex') !== expected) throw new Error('checksum-mismatch');
    fs.renameSync(partial, file);
    return file;
  } catch (err) {
    clearTimeout(timer);
    if (out) await closed(out);
    await removeFile(partial);
    throw signal?.aborted ? cancelled() : stall.signal.aborted ? new Error('stalled') : err;
  }
}

// ---- what the user decided about a version ---------------------------------------------------------------
// state = { skipVersion, remindUntil } (kept apart from the settings). -> 'show' | 'skipped' | 'snoozed' | 'none'
export function bannerState(info, state, now = Date.now()) {
  if (!info?.ok || !info.available) return 'none';
  if (state?.skipVersion && state.skipVersion === info.latest) return 'skipped'; // until a newer one comes
  if ((state?.remindUntil || 0) > now) return 'snoozed';
  return 'show';
}
export const remindLaterState = (state, now = Date.now()) => ({ ...state, remindUntil: now + DAY });
export const skipVersionState = (state, version) => ({ ...state, skipVersion: String(version || ''), remindUntil: 0 });

// ---- before installing ----------------------------------------------------------------------------------
// A plain copy of the settings file (still as stored, so it opens only on this PC) in <dir>/pre-update-<version>.json; the last `keep` stay.
export function makeSafetyCopy({ file, dir, version, keep = 3 }) {
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(version || 'x').replace(/[^\w.-]/g, '_');
  const target = path.join(dir, `pre-update-${safe}.json`);
  fs.copyFileSync(file, target);
  fs.chmodSync(target, 0o600);
  const all = fs.readdirSync(dir).filter((n) => /^pre-update-.+\.json$/.test(n)).map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }));
  all.sort((a, b) => b.t - a.t || (a.n < b.n ? 1 : -1));
  for (const old of all.slice(keep)) fs.rmSync(path.join(dir, old.n), { force: true });
  return target;
}

// What "Close and install" does on each system. quit = the app really quits.
export function installPlan(platform, file) {
  if (platform === 'win32') return { kind: 'run-installer', file, quit: true };
  if (platform === 'darwin') return { kind: 'open-image', file, quit: false, hint: 'mac' };
  return { kind: 'reveal', file, quit: false, hint: 'linux' };
}

// ---- after the install -------------------------------------------------------------------------------------
// The bullets of one version from CHANGELOG.md ("## 26.10.3 — 2026-10-13"), or null.
export function whatsNew(changelog, version) {
  const text = String(changelog || '').replace(/\r/g, '');
  const head = new RegExp(`^##\\s+v?${String(version).replace(/\./g, '\\.')}\\b[^\\n]*$`, 'm').exec(text);
  if (!head) return null;
  const rest = text.slice(head.index + head[0].length);
  const next = rest.search(/^##\s/m);
  const body = next === -1 ? rest : rest.slice(0, next);
  const bullets = body.split('\n').filter((l) => /^\s*[-*]\s+/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, '').trim());
  const date = /—\s*(\d{4}-\d{2}-\d{2})/.exec(head[0])?.[1] || '';
  return bullets.length ? { version: String(version), date, bullets } : null;
}

// -> 'first' (a new installation: say nothing) | 'updated' | 'same'.
// hadSettings: a settings file existed before this start. An older version did not remember lastSeen, so without it
// the first start of this one counts as an update, not as a new installation.
export function startupKind(lastSeen, current, hadSettings = false) {
  if (!lastSeen) return hadSettings ? 'updated' : 'first';
  return isNewer(current, lastSeen) ? 'updated' : 'same';
}
