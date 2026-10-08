// The download/convert/write cycle for one feed or one profile. No Electron here: everything that
// touches the outside world (network, image conversion, clock, log) is injected, so tests can fake it.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { httpGet, isPrivateHost } from './http.js';
import { parseFeed } from './feed.js';
import { toJpeg, MAX_IMAGE_BYTES, isJpegBytes } from './image.js';
import { truncate } from './text.js';
import { applyTemplate, encodeLines, imageName } from './format.js';
import { applyFilters, sortNewest, titleKey } from './filters.js';
import { cleanTemp, removeOrphanImages, writeIfChanged } from './output.js';

const FEED_TTL_MS = 20_000; // two profiles with the same feed in one cycle download it once
const IMAGE_CACHE_MAX = 300;
const POOL_MAX = 40; // stories kept per feed for the merged feeds (and across restarts)

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await fn(list[i], i);
      }
    })
  );
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (x) => createHash('sha1').update(x).digest('hex');

export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'output-missing' | 'fetch' | 'parse' | 'no-items' | 'write' | 'locked' | 'verify'
  }
}

// A player holding a file open makes Windows refuse the replacement: say so instead of a bare "EPERM".
export function classify(err) {
  if (err instanceof EngineError) return err;
  if (['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
    const e = new EngineError('locked', `A file is locked or not writable${err.path ? ` (${path.basename(err.path)})` : ''}: ${err.code}. Is a player holding it open?`);
    return e;
  }
  return new EngineError('write', err.message);
}

export function createEngine({ log = () => {}, get = httpGet, convert = toJpeg, builtinPlaceholder, now = Date.now, retryDelayMs = 2000, timeoutMs = 10000, retries = 2 } = {}) {
  const feedCache = new Map();
  const imageCache = new Map(); // key -> jpeg Buffer (insertion order = age)
  const placeholderCache = new Map();
  // per profile+feed: what the last successful run saw, so that a later run can skip work that cannot change anything
  const feedState = new Map();
  const lastCheck = new Map();

  const cacheImage = (k, v) => {
    imageCache.delete(k);
    imageCache.set(k, v);
    if (imageCache.size > IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
  };
  const convertOpts = (fmt) => ({ quality: fmt.jpegQuality, resize: { mode: fmt.resize, width: fmt.width, height: fmt.height }, modern: fmt.modernImages !== false });
  const optKey = (fmt) => `${fmt.jpegQuality}|${fmt.resize}|${fmt.width}x${fmt.height}|${fmt.modernImages !== false ? 'm' : 'n'}`;

  // validators = { etag, lastModified } of the last run: the server may answer 304 "not modified" without sending the feed.
  async function fetchFeed(feed, validators = null) {
    const key = `${feed.url}|${feed.insecureTls ? 1 : 0}`;
    const hit = feedCache.get(key);
    if (hit && now() - hit.t < FEED_TTL_MS) return hit.res;
    const headers = {};
    if (validators?.etag) headers['If-None-Match'] = validators.etag;
    if (validators?.lastModified) headers['If-Modified-Since'] = validators.lastModified;
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await get(feed.url, { timeoutMs, insecure: !!feed.insecureTls, headers });
        feedCache.set(key, { t: now(), res });
        return res;
      } catch (err) {
        if (err.status === 304) return { notModified: true };
        lastErr = err;
        log('warn', `${feed.folder}: download failed (attempt ${attempt}/${retries}): ${err.message}`);
        if (attempt < retries) await sleep(retryDelayMs);
      }
    }
    throw new EngineError('fetch', lastErr?.message || 'download failed');
  }

  async function fetchImage(url, source, fmt, feedHost) {
    const key = `${url}|${optKey(fmt)}`;
    const hit = imageCache.get(key);
    if (hit) {
      cacheImage(key, hit);
      return hit;
    }
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      throw new Error('invalid image URL');
    }
    // a public feed must not make this computer call into the local network
    if (isPrivateHost(host) && !isPrivateHost(feedHost)) throw new Error('image on a private address, skipped');
    const res = await get(url, { timeoutMs, insecure: !!source.insecureTls, maxBytes: MAX_IMAGE_BYTES });
    const jpg = await convert(res.body, convertOpts(fmt));
    cacheImage(key, jpg);
    return jpg;
  }

  async function loadPlaceholder(profile) {
    const fmt = profile.format;
    let src = null;
    let stamp = 'builtin';
    if (profile.placeholderPath) {
      try {
        const st = await fs.stat(profile.placeholderPath);
        stamp = `${profile.placeholderPath}|${st.mtimeMs}|${st.size}`;
        src = { file: profile.placeholderPath };
      } catch {
        log('warn', `${profile.name}: placeholder not found (${profile.placeholderPath}), using the built-in one`);
      }
    }
    const key = `${stamp}|${optKey(fmt)}`;
    if (placeholderCache.has(key)) return placeholderCache.get(key);
    const bytes = src ? await fs.readFile(src.file) : await builtinPlaceholder();
    const jpg = await convert(bytes, convertOpts(fmt));
    placeholderCache.clear();
    placeholderCache.set(key, jpg);
    return jpg;
  }

  async function ensureOutputDir(profile) {
    try {
      const st = await fs.stat(profile.outputDir);
      if (!st.isDirectory()) throw new Error('not a folder');
    } catch {
      // Never created on purpose: an unplugged drive or network share must not turn into a local folder.
      throw new EngineError('output-missing', `Output folder not found: ${profile.outputDir}`);
    }
  }

  const exists = (f) => fs.access(f).then(() => true, () => false);
  const paths = (profile, feed) => {
    const fmt = profile.format;
    return {
      dir: path.join(profile.outputDir, applyTemplate(fmt.imageDir, feed.folder)),
      title: path.join(profile.outputDir, applyTemplate(fmt.titleFile, feed.folder)),
      desc: path.join(profile.outputDir, applyTemplate(fmt.descFile, feed.folder)),
      meta: path.join(profile.outputDir, `${feed.folder}_metadata.json`)
    };
  };

  async function outputIntact(profile, feed, items) {
    const p = paths(profile, feed);
    return (await exists(p.title)) && (await exists(p.desc)) && (await exists(path.join(p.dir, imageName(profile.format, items - 1))));
  }

  // Reads the files back and checks that they agree: N lines, N lines, N real JPEG images.
  async function verifyOutput(profile, feed, n) {
    const fmt = profile.format;
    const p = paths(profile, feed);
    const problems = [];
    const lines = async (file, label) => {
      try {
        const parts = (await fs.readFile(file)).toString('latin1').split('\n');
        if (fmt.trailingNewline && parts[parts.length - 1] === '') parts.pop();
        if (parts.length !== n) problems.push(`${label} has ${parts.length} lines, expected ${n}`);
      } catch (err) {
        problems.push(`${label} cannot be read (${err.code || err.message})`);
      }
    };
    await lines(p.title, 'title file');
    await lines(p.desc, 'description file');
    for (let i = 0; i < n && problems.length < 5; i++) {
      const name = imageName(fmt, i);
      try {
        const b = await fs.readFile(path.join(p.dir, name));
        if (!isJpegBytes(b)) problems.push(`${name} is not a valid JPEG`);
      } catch (err) {
        problems.push(`${name} is missing (${err.code || err.message})`);
      }
    }
    return problems;
  }

  // Filters, duplicates, order, then the first maxItems. `seen` (titles of the earlier feeds of the profile) is optional.
  function selectItems(profile, feed, items, seen) {
    const { items: filtered, removed } = applyFilters(items, feed.filters, profile.dedupeAcrossFeeds ? seen : null);
    return { pool: filtered.slice(0, POOL_MAX), selected: filtered.slice(0, feed.maxItems), removed };
  }

  // Images, text lines, files, check, state. `items` are the stories already chosen (and ordered).
  async function build(profile, feed, items, ctx) {
    const { key, prev, started, sig, hash, validators, pool, removed = 0, kind = 'feed' } = ctx;
    const fmt = profile.format;
    const folder = feed.folder;
    const placeholder = await loadPlaceholder(profile);
    const st = { withImage: 0, placeholders: 0, emptyTitles: 0, emptyDescs: 0, failed: 0 };

    const recs = await mapLimit(items, 4, async (it) => {
      let title = fmt.maxTitleChars ? truncate(it.title, fmt.maxTitleChars) : it.title;
      let desc = fmt.maxDescChars ? truncate(it.description, fmt.maxDescChars) : it.description;
      if (!title) { title = fmt.emptyValue; st.emptyTitles++; }
      if (!desc) { desc = fmt.emptyValue; st.emptyDescs++; }
      let jpg = null;
      if (it.image) {
        try {
          jpg = await fetchImage(it.image, { insecureTls: it._insecure ?? feed.insecureTls }, fmt, it._host);
          st.withImage++;
        } catch (err) {
          st.failed++;
          log('warn', `${folder}: image skipped (${it.image}): ${err.message}`);
        }
      }
      if (!jpg) { jpg = placeholder; st.placeholders++; }
      return { title, desc, jpg };
    });

    // ---- write: images, then text, then metadata. Item i always gets image i, line i, line i. ----
    const p = paths(profile, feed);
    await fs.mkdir(p.dir, { recursive: true });
    await cleanTemp(p.dir);
    await cleanTemp(profile.outputDir);
    let written = 0, same = 0;
    const tally = (changed) => (changed ? written++ : same++);
    const keep = new Set();
    for (let i = 0; i < recs.length; i++) {
      const name = imageName(fmt, i);
      keep.add(name);
      tally(await writeIfChanged(path.join(p.dir, name), recs[i].jpg));
    }
    const orphans = await removeOrphanImages(p.dir, keep, fmt.imageExt);
    tally(await writeIfChanged(p.title, encodeLines(recs.map((r) => r.title), fmt)));
    tally(await writeIfChanged(p.desc, encodeLines(recs.map((r) => r.desc), fmt)));

    if (profile.verifyOutput && (written > 0 || orphans > 0)) {
      const problems = await verifyOutput(profile, feed, recs.length);
      if (problems.length) throw new EngineError('verify', `Output check failed: ${problems.join('; ')}`);
    }

    const result = {
      ok: true,
      kind,
      items: recs.length,
      imagesOriginal: st.withImage,
      placeholders: st.placeholders,
      emptyTitles: st.emptyTitles,
      emptyDescriptions: st.emptyDescs,
      filteredOut: removed,
      filesWritten: written,
      filesUnchanged: same,
      orphansRemoved: orphans,
      imageFailures: st.failed,
      verified: !!profile.verifyOutput && (written > 0 || orphans > 0),
      unchanged: false,
      changed: written > 0,
      changedAt: written > 0 ? now() : prev?.result?.changedAt ?? now(),
      durationMs: now() - started,
      at: now()
    };
    if (fmt.metadataFile && (written > 0 || !(await exists(p.meta)))) {
      const meta = { folder, url: feed.url || '', timestamp: new Date(now()).toISOString(), items_count: recs.length, images_count: recs.length, images_with_url: st.withImage, placeholder_logo_used: st.placeholders, titles_empty: st.emptyTitles, descriptions_empty: st.emptyDescs };
      await writeIfChanged(p.meta, Buffer.from(JSON.stringify(meta, null, 2), 'utf8')).catch(() => {});
    }
    feedState.set(key, { sig, hash, etag: validators?.etag || null, lastModified: validators?.lastModified || null, items: recs.length, imageFailures: st.failed, result, pool: pool ?? prev?.pool ?? [] });
    lastCheck.set(key, now());
    log('info', `${folder}: ${result.items} items, ${result.imagesOriginal} images + ${result.placeholders} placeholder, ${written} files written, ${same} unchanged${removed ? `, ${removed} left out by filters` : ''}`);
    return result;
  }

  const fail = (folder, started, err) => {
    const e = classify(err);
    log('error', `${folder}: ${e.message}`);
    return { ok: false, code: e.code, error: e.message, durationMs: now() - started, at: now() };
  };

  // Downloads one feed and writes its files. Existing files stay untouched when anything before the write fails.
  // ctx: { force, seen (shared titles of the profile), fresh (Map feedId -> stories, for the merged feeds) }
  async function runFeed(profile, feed, { force = false, seen = null, fresh = null } = {}) {
    const started = now();
    const key = `${profile.id}|${feed.id}`;
    const fmt = profile.format;
    const folder = feed.folder;
    try {
      if (!profile.outputDir) throw new EngineError('output-missing', 'No output folder set');
      await ensureOutputDir(profile);
      // Skip work when nothing can have changed: same settings as the last run, all output files still there and no
      // image that failed last time (it deserves a new try). A manual "Run now" (force) always rebuilds.
      // With duplicates removed across the feeds of the profile the result of one feed depends on the others: no skipping then.
      const sig = JSON.stringify([profile.outputDir, profile.placeholderPath, fmt, folder, feed.maxItems, feed.url, feed.filters, profile.dedupeAcrossFeeds, profile.verifyOutput]);
      const prev = feedState.get(key);
      const smart = !force && !profile.dedupeAcrossFeeds && prev && prev.sig === sig && prev.imageFailures === 0 && (await outputIntact(profile, feed, prev.items));
      const skipUnchanged = () => {
        lastCheck.set(key, now());
        log('info', `${folder}: no change`);
        return { ...prev.result, unchanged: true, changed: false, durationMs: now() - started, at: now() };
      };
      const res = await fetchFeed(feed, smart ? prev : null);
      if (res.notModified) return skipUnchanged();
      const hash = sha1(res.body);
      if (smart && hash === prev.hash) return skipUnchanged();
      let all;
      try {
        all = parseFeed(res.body, res.url);
      } catch (err) {
        throw new EngineError('parse', `Cannot read the feed: ${err.message}`);
      }
      if (!all.length) throw new EngineError('no-items', 'The feed has no items');
      const host = new URL(res.url).hostname;
      for (const it of all) { it._host = host; it._insecure = !!feed.insecureTls; }
      const { pool, selected, removed } = selectItems(profile, feed, all, seen);
      if (!selected.length) throw new EngineError('no-items', 'No story is left after the filters');
      fresh?.set(feed.id, pool);
      const out = await build(profile, feed, selected, { key, prev, started, sig, hash, validators: { etag: res.headers?.etag, lastModified: res.headers?.['last-modified'] }, pool, removed });
      if (seen) for (const it of selected) { const k = titleKey(it); if (k) seen.add(k); }
      return out;
    } catch (err) {
      return fail(folder, started, err);
    }
  }

  // A merged feed: the latest stories of several other feeds of the profile in one folder (newest first, no duplicates).
  async function runMerge(profile, feed, { force = false, fresh = null } = {}) {
    const started = now();
    const key = `${profile.id}|${feed.id}`;
    const folder = feed.folder;
    try {
      if (!profile.outputDir) throw new EngineError('output-missing', 'No output folder set');
      await ensureOutputDir(profile);
      const pools = feed.sources.map((sid) => fresh?.get(sid) ?? feedState.get(`${profile.id}|${sid}`)?.pool ?? []);
      const merged = sortNewest(applyFilters(pools.flat(), { ...feed.filters, dedupe: true, sort: 'feed' }).items);
      const { selected, removed } = selectItems(profile, { ...feed, filters: { ...feed.filters, dedupe: true, sort: 'feed' } }, merged, null);
      if (!selected.length) throw new EngineError('no-items', 'The source feeds have no stories yet');
      const hash = sha1(JSON.stringify(selected.map((s) => [s.title, s.description, s.image])));
      const sig = JSON.stringify([profile.outputDir, profile.placeholderPath, profile.format, folder, feed.maxItems, feed.sources, feed.filters, profile.verifyOutput]);
      const prev = feedState.get(key);
      if (!force && prev && prev.sig === sig && prev.hash === hash && prev.imageFailures === 0 && (await outputIntact(profile, feed, prev.items))) {
        lastCheck.set(key, now());
        log('info', `${folder}: no change`);
        return { ...prev.result, unchanged: true, changed: false, durationMs: now() - started, at: now() };
      }
      return await build(profile, feed, selected, { key, prev, started, sig, hash, validators: null, pool: [], removed, kind: 'merge' });
    } catch (err) {
      return fail(folder, started, err);
    }
  }

  // Runs the enabled feeds of a profile that are due, one after the other, then the merged feeds. A feed has its own
  // interval (feed.intervalMin) or the profile's; `force` (manual "Run now") ignores the intervals and rebuilds everything.
  async function runProfile(profile, onFeed = () => {}, { force = false } = {}) {
    const results = {};
    const dueAt = (f) => {
      const last = lastCheck.get(`${profile.id}|${f.id}`);
      const every = (f.intervalMin || profile.intervalMin) * 60_000;
      return force || last === undefined || now() - last >= every - 5000; // the scheduler ticks with a few seconds of jitter
    };
    const normal = profile.feeds.filter((f) => f.enabled && f.type !== 'merge' && dueAt(f));
    const merges = profile.feeds.filter((f) => f.enabled && f.type === 'merge');
    log('info', `${profile.name}: run started (${normal.length} feeds${force ? ', manual' : ''})`);
    const seen = profile.dedupeAcrossFeeds ? new Set() : null;
    const fresh = new Map();
    // with duplicates removed across feeds every feed is needed in order, so all of them take part
    const list = profile.dedupeAcrossFeeds ? profile.feeds.filter((f) => f.enabled && f.type !== 'merge') : normal;
    for (const feed of list) {
      const r = await runFeed(profile, feed, { force, seen, fresh });
      lastCheck.set(`${profile.id}|${feed.id}`, now());
      results[feed.id] = r;
      onFeed(feed, r);
    }
    for (const feed of merges) {
      const anyChanged = feed.sources.some((sid) => results[sid] && (results[sid].changed || !results[sid].ok));
      if (!force && lastCheck.has(`${profile.id}|${feed.id}`) && !anyChanged) continue;
      const r = await runMerge(profile, feed, { force, fresh });
      lastCheck.set(`${profile.id}|${feed.id}`, now());
      results[feed.id] = r;
      onFeed(feed, r);
    }
    const okCount = Object.values(results).filter((r) => r.ok).length;
    log('info', `${profile.name}: run finished, ${okCount}/${Object.keys(results).length} feeds ok`);
    return results;
  }

  const THUMB = { quality: 70, resize: { mode: 'cover', width: 240, height: 135 } };
  const dataUrl = (b) => 'data:image/jpeg;base64,' + b.toString('base64');

  // The profile's placeholder as the ticker will get it, as a small data: URL
  async function placeholderThumb(profile) {
    return dataUrl(await convert(await loadPlaceholder(profile), { ...THUMB, modern: true }));
  }

  // Preview without writing anything: the stories as they WOULD be written (filters, order, length limits, empty values,
  // file names), each with a small thumbnail (the placeholder where the real image is missing). raw = the feed as it is.
  async function previewFeed(feed, count = 8, profile = null, { raw = false } = {}) {
    const prof = profile || { placeholderPath: '', name: 'preview', dedupeAcrossFeeds: false, format: { jpegQuality: 85, resize: 'none', width: 0, height: 0, modernImages: true, maxTitleChars: 0, maxDescChars: 0, emptyValue: '-', imageStart: 1, imagePad: 5, imageExt: 'JPG' }, feeds: [] };
    const fmt = prof.format;
    let all;
    let total;
    if (feed.type === 'merge') {
      const pools = (feed.sources || []).map((sid) => feedState.get(`${prof.id}|${sid}`)?.pool ?? []);
      all = sortNewest(applyFilters(pools.flat(), { ...feed.filters, dedupe: true, sort: 'feed' }).items);
      total = all.length;
    } else {
      const res = await fetchFeed({ ...feed, folder: 'preview' });
      if (res.notModified) throw new Error('not modified');
      all = parseFeed(res.body, res.url);
      const host = new URL(res.url).hostname;
      for (const it of all) { it._host = host; it._insecure = !!feed.insecureTls; }
      total = all.length;
    }
    const sel = raw && feed.type !== 'merge' ? { selected: all.slice(0, feed.maxItems ?? 10), removed: 0 } : selectItems(prof, feed, all, null);
    const shown = sel.selected.slice(0, count);
    let ph = null;
    try {
      ph = await placeholderThumb(prof);
    } catch {
      ph = null;
    }
    const tfmt = { jpegQuality: THUMB.quality, resize: 'cover', width: 240, height: 135, modernImages: fmt.modernImages !== false };
    return {
      total,
      selected: sel.selected.length,
      removed: sel.removed,
      items: await mapLimit(shown, 4, async (it, i) => {
        let thumb = null;
        let failed = false;
        if (it.image) {
          try {
            thumb = dataUrl(await fetchImage(it.image, { insecureTls: it._insecure ?? feed.insecureTls }, tfmt, it._host));
          } catch {
            failed = true;
          }
        }
        const title = fmt.maxTitleChars ? truncate(it.title, fmt.maxTitleChars) : it.title;
        const desc = fmt.maxDescChars ? truncate(it.description, fmt.maxDescChars) : it.description;
        return {
          n: i + 1,
          imageFile: imageName({ imageStart: fmt.imageStart ?? 1, imagePad: fmt.imagePad ?? 5, imageExt: fmt.imageExt ?? 'JPG' }, i),
          title: it.title,
          description: it.description,
          titleLine: title || fmt.emptyValue,
          descLine: desc || fmt.emptyValue,
          date: it.date ?? null,
          hasImage: !!thumb,
          imageFailed: failed,
          thumb: thumb || ph
        };
      })
    };
  }

  // What the engine remembers between runs, so that it can be saved and restored across restarts.
  function exportState() {
    const feeds = {};
    for (const [k, v] of feedState) feeds[k] = { ...v, pool: (v.pool || []).slice(0, POOL_MAX).map(({ title, description, image, date, _host, _insecure }) => ({ title, description, image, date, _host, _insecure })) };
    return { version: 1, feeds };
  }
  function importState(obj) {
    if (!obj || obj.version !== 1 || typeof obj.feeds !== 'object') return 0;
    let n = 0;
    for (const [k, v] of Object.entries(obj.feeds)) {
      if (!/^[\w-]+\|[\w-]+$/.test(k) || !v || typeof v.sig !== 'string' || !v.result) continue;
      feedState.set(k, { ...v, pool: Array.isArray(v.pool) ? v.pool : [] });
      n++;
    }
    return n;
  }
  // forget the state of profiles/feeds that no longer exist
  function pruneState(profiles) {
    const valid = new Set(profiles.flatMap((p) => p.feeds.map((f) => `${p.id}|${f.id}`)));
    for (const k of [...feedState.keys()]) if (!valid.has(k)) { feedState.delete(k); lastCheck.delete(k); }
  }

  return {
    runFeed, runMerge, runProfile, previewFeed, placeholderThumb, ensureOutputDir, exportState, importState, pruneState,
    clearCaches: () => { feedCache.clear(); imageCache.clear(); placeholderCache.clear(); }
  };
}
