// The download/convert/write cycle for one feed or one profile. No Electron here: everything that
// touches the outside world (network, image conversion, clock, log) is injected, so tests can fake it.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { httpGet, isPrivateHost } from './http.js';
import { parseFeed } from './feed.js';
import { toJpeg, MAX_IMAGE_BYTES } from './image.js';
import { truncate } from './text.js';
import { applyTemplate, encodeLines, imageName } from './format.js';
import { cleanTemp, removeOrphanImages, writeIfChanged } from './output.js';

const FEED_TTL_MS = 20_000; // two profiles with the same feed in one cycle download it once
const IMAGE_CACHE_MAX = 300;

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

export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'output-missing' | 'fetch' | 'parse' | 'no-items' | 'write'
  }
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

  async function fetchImage(url, feed, fmt, feedHost) {
    const key = `${url}|${fmt.jpegQuality}|${fmt.resize}|${fmt.width}x${fmt.height}`;
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
    const res = await get(url, { timeoutMs, insecure: !!feed.insecureTls, maxBytes: MAX_IMAGE_BYTES });
    const jpg = await convert(res.body, { quality: fmt.jpegQuality, resize: { mode: fmt.resize, width: fmt.width, height: fmt.height } });
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
    const key = `${stamp}|${fmt.jpegQuality}|${fmt.resize}|${fmt.width}x${fmt.height}`;
    if (placeholderCache.has(key)) return placeholderCache.get(key);
    const bytes = src ? await fs.readFile(src.file) : await builtinPlaceholder();
    const jpg = await convert(bytes, { quality: fmt.jpegQuality, resize: { mode: fmt.resize, width: fmt.width, height: fmt.height } });
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

  async function outputIntact(profile, feed, items) {
    const fmt = profile.format;
    const dir = path.join(profile.outputDir, applyTemplate(fmt.imageDir, feed.folder));
    return (
      (await exists(path.join(profile.outputDir, applyTemplate(fmt.titleFile, feed.folder)))) &&
      (await exists(path.join(profile.outputDir, applyTemplate(fmt.descFile, feed.folder)))) &&
      (await exists(path.join(dir, imageName(fmt, items - 1))))
    );
  }

  // Downloads one feed and writes its files. Existing files stay untouched when anything before the write fails.
  async function runFeed(profile, feed, { force = false } = {}) {
    const started = now();
    const key = `${profile.id}|${feed.id}`;
    const fmt = profile.format;
    const folder = feed.folder;
    try {
      if (!profile.outputDir) throw new EngineError('output-missing', 'No output folder set');
      await ensureOutputDir(profile);
      // Skip work when nothing can have changed: same settings as the last run, all output files still there and no
      // image that failed last time (it deserves a new try). A manual "Run now" (force) always rebuilds.
      const sig = JSON.stringify([profile.outputDir, profile.placeholderPath, fmt, folder, feed.maxItems, feed.url]);
      const prev = feedState.get(key);
      const smart = !force && prev && prev.sig === sig && prev.imageFailures === 0 && (await outputIntact(profile, feed, prev.items));
      const skipUnchanged = () => {
        lastCheck.set(key, now());
        log('info', `${folder}: no change`);
        return { ...prev.result, unchanged: true, changed: false, durationMs: now() - started, at: now() };
      };
      const res = await fetchFeed(feed, smart ? prev : null);
      if (res.notModified) return skipUnchanged();
      const hash = createHash('sha1').update(res.body).digest('hex');
      if (smart && hash === prev.hash) return skipUnchanged();
      let items;
      try {
        items = parseFeed(res.body, res.url);
      } catch (err) {
        throw new EngineError('parse', `Cannot read the feed: ${err.message}`);
      }
      if (!items.length) throw new EngineError('no-items', 'The feed has no items');
      items = items.slice(0, feed.maxItems);

      const placeholder = await loadPlaceholder(profile);
      const feedHost = new URL(res.url).hostname;
      const st = { withImage: 0, placeholders: 0, emptyTitles: 0, emptyDescs: 0, failed: 0 };

      const recs = await mapLimit(items, 4, async (it) => {
        let title = fmt.maxTitleChars ? truncate(it.title, fmt.maxTitleChars) : it.title;
        let desc = fmt.maxDescChars ? truncate(it.description, fmt.maxDescChars) : it.description;
        if (!title) { title = fmt.emptyValue; st.emptyTitles++; }
        if (!desc) { desc = fmt.emptyValue; st.emptyDescs++; }
        let jpg = null;
        if (it.image) {
          try {
            jpg = await fetchImage(it.image, feed, fmt, feedHost);
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
      const dir = path.join(profile.outputDir, applyTemplate(fmt.imageDir, folder));
      await fs.mkdir(dir, { recursive: true });
      await cleanTemp(dir);
      await cleanTemp(profile.outputDir);
      let written = 0, unchanged = 0;
      const tally = (changed) => (changed ? written++ : unchanged++);
      const keep = new Set();
      for (let i = 0; i < recs.length; i++) {
        const name = imageName(fmt, i);
        keep.add(name);
        tally(await writeIfChanged(path.join(dir, name), recs[i].jpg));
      }
      const removed = await removeOrphanImages(dir, keep, fmt.imageExt);
      tally(await writeIfChanged(path.join(profile.outputDir, applyTemplate(fmt.titleFile, folder)), encodeLines(recs.map((r) => r.title), fmt)));
      tally(await writeIfChanged(path.join(profile.outputDir, applyTemplate(fmt.descFile, folder)), encodeLines(recs.map((r) => r.desc), fmt)));

      const result = {
        ok: true,
        items: recs.length,
        imagesOriginal: st.withImage,
        placeholders: st.placeholders,
        emptyTitles: st.emptyTitles,
        emptyDescriptions: st.emptyDescs,
        filesWritten: written,
        filesUnchanged: unchanged,
        orphansRemoved: removed,
        imageFailures: st.failed,
        unchanged: false,
        changed: written > 0,
        changedAt: written > 0 ? now() : prev?.result?.changedAt ?? null,
        durationMs: now() - started,
        at: now()
      };
      const metaFile = path.join(profile.outputDir, `${folder}_metadata.json`);
      if (fmt.metadataFile && (written > 0 || !(await exists(metaFile)))) {
        const meta = { folder, url: feed.url, timestamp: new Date(now()).toISOString(), items_count: recs.length, images_count: recs.length, images_with_url: st.withImage, placeholder_logo_used: st.placeholders, titles_empty: st.emptyTitles, descriptions_empty: st.emptyDescs };
        await writeIfChanged(metaFile, Buffer.from(JSON.stringify(meta, null, 2), 'utf8')).catch(() => {});
      }
      feedState.set(key, { sig, hash, etag: res.headers?.etag || null, lastModified: res.headers?.['last-modified'] || null, items: recs.length, imageFailures: st.failed, result });
      lastCheck.set(key, now());
      log('info', `${folder}: ${result.items} items, ${result.imagesOriginal} images + ${result.placeholders} placeholder, ${written} files written, ${unchanged} unchanged`);
      return result;
    } catch (err) {
      const code = err instanceof EngineError ? err.code : 'write';
      log('error', `${folder}: ${err.message}`);
      return { ok: false, code, error: err.message, durationMs: now() - started, at: now() };
    }
  }

  // Runs the enabled feeds of a profile that are due, one after the other. A feed has its own interval
  // (feed.intervalMin) or the profile's; `force` (manual "Run now") ignores the intervals and rebuilds everything.
  async function runProfile(profile, onFeed = () => {}, { force = false } = {}) {
    const results = {};
    const due = profile.feeds.filter((f) => {
      if (!f.enabled) return false;
      const last = lastCheck.get(`${profile.id}|${f.id}`);
      const every = (f.intervalMin || profile.intervalMin) * 60_000;
      return force || last === undefined || now() - last >= every - 5000; // the scheduler ticks with a few seconds of jitter
    });
    log('info', `${profile.name}: run started (${due.length} feeds${force ? ', manual' : ''})`);
    for (const feed of due) {
      const r = await runFeed(profile, feed, { force });
      lastCheck.set(`${profile.id}|${feed.id}`, now());
      results[feed.id] = r;
      onFeed(feed, r);
    }
    const okCount = Object.values(results).filter((r) => r.ok).length;
    log('info', `${profile.name}: run finished, ${okCount}/${due.length} feeds ok`);
    return results;
  }

  const THUMB = { quality: 70, resize: { mode: 'cover', width: 240, height: 135 } };
  const dataUrl = (b) => 'data:image/jpeg;base64,' + b.toString('base64');

  // The profile's placeholder as the ticker will get it, as a small data: URL
  async function placeholderThumb(profile) {
    return dataUrl(await convert(await loadPlaceholder(profile), THUMB));
  }

  // Preview without writing anything: parsed items with a small thumbnail each (the placeholder where the real image is missing).
  async function previewFeed(feed, count = 6, profile = null) {
    const res = await fetchFeed({ ...feed, folder: 'preview' });
    if (res.notModified) throw new Error('not modified');
    const all = parseFeed(res.body, res.url);
    const items = all.slice(0, count);
    const feedHost = new URL(res.url).hostname;
    const fmt = { jpegQuality: THUMB.quality, resize: 'cover', width: 240, height: 135 };
    let ph = null;
    try {
      ph = await placeholderThumb(profile || { placeholderPath: '', format: { jpegQuality: 85, resize: 'none', width: 0, height: 0 } });
    } catch {
      ph = null;
    }
    return {
      total: all.length,
      items: await mapLimit(items, 4, async (it) => {
        let thumb = null;
        let failed = false;
        if (it.image) {
          try {
            thumb = dataUrl(await fetchImage(it.image, feed, fmt, feedHost));
          } catch {
            failed = true;
          }
        }
        return { title: it.title, description: it.description, hasImage: !!thumb, imageFailed: failed, thumb: thumb || ph };
      })
    };
  }

  return { runFeed, runProfile, previewFeed, placeholderThumb, ensureOutputDir, clearCaches: () => { feedCache.clear(); imageCache.clear(); placeholderCache.clear(); } };
}
