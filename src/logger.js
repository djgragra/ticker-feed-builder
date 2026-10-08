// Log: a ring buffer for the UI plus one file per day (logs/ticker-feed-builder_dd-mm-yyyy.log).
import fs from 'node:fs';
import path from 'node:path';

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const dayName = (d) => `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
export const LOG_FILE_RE = /^ticker-feed-builder_(\d{2})-(\d{2})-(\d{4})\.log$/;

export function createLogger({ dir, retentionDays = 30, ringSize = 500, onEntry = () => {}, now = () => new Date() }) {
  const ring = [];
  let chain = Promise.resolve();
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
    chain = chain.then(() => fs.promises.appendFile(path.join(dir, `ticker-feed-builder_${dayName(d)}.log`), line).catch(() => {}));
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
