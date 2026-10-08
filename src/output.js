// Writing the output files. Every file is written to a temporary name and renamed, so a player that
// reads the folder never sees a half-written file; a file whose content did not change is not touched
// (its modification time stays, so players that watch for changes do not reload for nothing).
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function writeIfChanged(file, data) {
  try {
    const cur = await fs.readFile(file);
    if (cur.equals(data)) return false;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const tmp = path.join(path.dirname(file), `.tfb-${randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(tmp, data);
  // On Windows a player holding the target open makes the rename fail for a moment: retry briefly.
  let last;
  for (let i = 0; i < 6; i++) {
    try {
      await fs.rename(tmp, file);
      return true;
    } catch (err) {
      last = err;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) break;
      await sleep(150 * (i + 1));
    }
  }
  await fs.rm(tmp, { force: true });
  throw last;
}

// Removes numbered images left over from a longer previous run (only files named like our images).
export async function removeOrphanImages(dir, keep, ext) {
  let removed = 0;
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  const re = new RegExp(`^\\d+\\.${ext.replace(/[^A-Za-z0-9]/g, '')}$`, 'i');
  for (const n of names) {
    if (re.test(n) && !keep.has(n)) {
      await fs.rm(path.join(dir, n), { force: true });
      removed++;
    }
  }
  return removed;
}

// Stale temp files of an interrupted run
export async function cleanTemp(dir) {
  try {
    for (const n of await fs.readdir(dir)) if (/^\.tfb-[0-9a-f]+\.tmp$/.test(n)) await fs.rm(path.join(dir, n), { force: true });
  } catch {
    /* folder missing: nothing to clean */
  }
}
