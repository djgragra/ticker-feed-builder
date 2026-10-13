// Log: a ring buffer for the UI plus one file per day (logs/ticker-feed-builder_dd-mm-yyyy.log).
import fs from 'node:fs';
import path from 'node:path';

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const dayName = (d) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
export const LOG_FILE_RE = /^ticker-feed-builder_(\d{2})-(\d{2})-(\d{4})(?:_(\d+))?\.log$/;
export const MAX_LOG_BYTES = 5 * 1024 * 1024; // a file that reaches this is closed and a new one starts (…_dd-mm-yyyy_1.log)
const MAX_ROTATED_PER_DAY = 3; // with the open file, at most 4 files of 5 MB for one day

export function createLogger({ dir, retentionDays = 7, maxBytes = MAX_LOG_BYTES, ringSize = 500, onEntry = () => {}, now = () => new Date() }) {
  const ring = [];
  let chain = Promise.resolve();
  const sizes = new Map(); // file -> bytes written so far (read once from disk)
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* logging must never stop the app */
  }

  function log(level, message, scope = '') {
    const d = now();
    const entry = { t: d.getTime(), level, scope, message: String(message) };
    ring.push(entry);
    if (ring.length > ringSize) ring.shift();
    onEntry(entry);
    const line = `${stamp(d)} | ${level.toUpperCase().padEnd(5)} | ${scope ? scope + ' | ' : ''}${entry.message}\n`;
    chain = chain.then(() => write(dayName(d), line)).catch(() => {});
  }

  async function write(day, line) {
    const file = path.join(dir, `ticker-feed-builder_${day}.log`);
    let size = sizes.get(file);
    if (size === undefined) size = await fs.promises.stat(file).then((s) => s.size, () => 0);
    if (size + Buffer.byteLength(line) > maxBytes && size > 0) {
      await rotate(day, file);
      size = 0;
    }
    await fs.promises.appendFile(file, line);
    sizes.set(file, size + Buffer.byteLength(line));
  }

  // the full file becomes …_1.log, the next …_2.log and so on; beyond MAX_ROTATED_PER_DAY the oldest is dropped
  async function rotate(day, file) {
    const names = fs.readdirSync(dir).map((n) => ({ n, m: n.match(LOG_FILE_RE) })).filter((x) => x.m && `${x.m[1]}-${x.m[2]}-${x.m[3]}` === day && x.m[4]);
    const next = Math.max(0, ...names.map((x) => Number(x.m[4]))) + 1;
    await fs.promises.rename(file, path.join(dir, `ticker-feed-builder_${day}_${next}.log`));
    const all = [...names, { n: `ticker-feed-builder_${day}_${next}.log`, m: [0, 0, 0, 0, String(next)] }].sort((a, b) => Number(a.m[4]) - Number(b.m[4]));
    for (const old of all.slice(0, Math.max(0, all.length - MAX_ROTATED_PER_DAY))) await fs.promises.rm(path.join(dir, old.n), { force: true });
    sizes.delete(file);
  }

  function prune() {
    const cutoff = now().getTime() - retentionDays * 86_400_000;
    let removed = 0;
    try {
      for (const n of fs.readdirSync(dir)) {
        const m = n.match(LOG_FILE_RE);
        if (m && new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).getTime() < cutoff) {
          fs.rmSync(path.join(dir, n), { force: true });
          removed++;
        }
      }
    } catch {
      /* nothing to prune */
    }
    return removed;
  }

  return { log, prune, entries: () => ring.slice(), setRetention: (d) => { retentionDays = d; }, flush: () => chain };
}
