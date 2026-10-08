// The download/convert/write cycle for one feed or one profile. No Electron here: everything that
// touches the outside world (network, image conversion, clock, log) is injected, so tests can fake it.
import fs from 'node:fs/promises';
import path from 'node:path';
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

  const cacheImage = (k, v) => {
    imageCache.delete(k);
    imageCache.set(k, v);
    if (imageCache.size > IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
  };

  async function fetchFeed(feed) {
    const key = `${feed.url}|${feed.insecureTls ? 1 : 0}`;
    const hit = feedCache.get(key);
    if (hit && now() - hit.t < FEED_TTL_MS) return hit.res;
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await get(feed.url, { timeoutMs, insecure: !!feed.insecureTls });
        feedCache.set(key, { t: now(), res });
        return res;
      } catch (err) {
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

  // Downloads one feed and writes its files. Existing files stay untouched when anything before the write fails.
  async function runFeed(profile, feed) {
    const started = now();
    const fmt = profile.format;
    const folder = feed.folder;
    try {
      if (!profile.outputDir) throw new EngineError('output-missing', 'No output folder set');
      await ensureOutputDir(profile);
      const res = await fetchFeed(feed);
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
      const st = { withImage: 0, placeholders: 0, emptyTitles: 0, emptyDescs: 0 };

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
        durationMs: now() - started,
        at: now()
      };
      if (fmt.metadataFile) {
        const meta = { folder, url: feed.url, timestamp: new Date(now()).toISOString(), items_count: recs.length, images_count: recs.length, images_with_url: st.withImage, placeholder_logo_used: st.placeholders, titles_empty: st.emptyTitles, descriptions_empty: st.emptyDescs };
        await writeIfChanged(path.join(profile.outputDir, `${folder}_metadata.json`), Buffer.from(JSON.stringify(meta, null, 2), 'utf8')).catch(() => {});
      }
      log('info', `${folder}: ${result.items} items, ${result.imagesOriginal} images + ${result.placeholders} placeholder, ${written} files written, ${unchanged} unchanged`);
      return result;
    } catch (err) {
      const code = err instanceof EngineError ? err.code : 'write';
      log('error', `${folder}: ${err.message}`);
      return { ok: false, code, error: err.message, durationMs: now() - started, at: now() };
    }
  }

  // Runs every enabled feed of a profile, one after the other. onFeed is called after each one.
  async function runProfile(profile, onFeed = () => {}) {
    const results = {};
    const feeds = profile.feeds.filter((f) => f.enabled);
    log('info', `${profile.name}: run started (${feeds.length} feeds)`);
    for (const feed of feeds) {
      const r = await runFeed(profile, feed);
      results[feed.id] = r;
      onFeed(feed, r);
    }
    const okCount = Object.values(results).filter((r) => r.ok).length;
    log('info', `${profile.name}: run finished, ${okCount}/${feeds.length} feeds ok`);
    return results;
  }

  // Preview without writing anything: parsed items with a small thumbnail each.
  async function previewFeed(feed, count = 6) {
    const res = await fetchFeed({ ...feed, folder: 'preview' });
    const all = parseFeed(res.body, res.url);
    const items = all.slice(0, count);
    const feedHost = new URL(res.url).hostname;
    const fmt = { jpegQuality: 70, resize: 'cover', width: 240, height: 135 };
    return {
      total: all.length,
      items: await mapLimit(items, 4, async (it) => {
        let thumb = null;
        if (it.image) {
          try {
            thumb = 'data:image/jpeg;base64,' + (await fetchImage(it.image, feed, fmt, feedHost)).toString('base64');
          } catch {
            thumb = null;
          }
        }
        return { title: it.title, description: it.description, hasImage: !!it.image, thumb };
      })
    };
  }

  return { runFeed, runProfile, previewFeed, ensureOutputDir, clearCaches: () => { feedCache.clear(); imageCache.clear(); placeholderCache.clear(); } };
}
