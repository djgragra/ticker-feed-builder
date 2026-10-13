// garage-common: backup 1
// Configuration backup: build the file, read it back, say what must be typed again.
// Electron-free and file-free (the main process asks for the file and applies the plan), so it can
// be tested. Settings here are the plain ones; sealed values (enc:v1:) never come out of a file.
import { sanitizeSettings, MAX_PROFILES } from './settings.js';
import { SEALED_PREFIX, secretSlots, stripSecrets, withoutUserInfo, hasUserInfo, feedSlotId } from './secrets.js';

export const BACKUP_APP = 'ticker-feed-builder';
export const BACKUP_VERSION = 1;
export const MAX_BACKUP_BYTES = 2_000_000;
// kept on this PC, not part of the file: what the user was told once, the update memory, the window
const RUNTIME_KEYS = ['closeHintShown', 'lastSeenVersion', 'updateState', 'window'];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const dateStamp = (ms) => new Date(ms).toISOString().slice(0, 10);

export const backupFileName = (now = Date.now()) => `${BACKUP_APP}-backup-${dateStamp(now)}.json`;

// settings: the plain settings of the app. Returns the object to write as JSON.
export function buildExport(settings, { includeSecrets = false, now = Date.now() } = {}) {
  let s = structuredClone(settings);
  let emptied = [];
  if (!includeSecrets) ({ settings: s, emptied } = stripSecrets(s));
  for (const k of RUNTIME_KEYS) delete s[k];
  const profiles = Array.isArray(s.profiles) ? s.profiles : [];
  delete s.profiles;
  const file = { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: new Date(now).toISOString(), includesSecrets: !!includeSecrets, settings: s, profiles };
  if (emptied.length) file.emptiedSecrets = emptied; // which secrets had a value and were left out
  return file;
}

const feedName = (f) => f.folder || '';

// What the user has to type again in `settings`: secrets that are needed and empty.
// `emptied` (ids from the file or from sealed values dropped) marks feed addresses that lost their credentials.
export function missingSecrets(settings, emptied = [], { onlyProfileIds = null } = {}) {
  const out = [];
  if (!onlyProfileIds) {
    const em = settings.notifications?.email || {};
    if ((em.enabled || em.host) && em.user && !em.pass) out.push({ id: 'email.pass', kind: 'email.pass' });
    const tg = settings.notifications?.telegram || {};
    if ((tg.enabled || (tg.recipients || []).length) && !tg.botToken) out.push({ id: 'telegram.botToken', kind: 'telegram.botToken' });
  }
  for (const p of settings.profiles || []) {
    if (onlyProfileIds && !onlyProfileIds.has(p.id)) continue;
    for (const f of p.feeds || []) {
      if (emptied.includes(feedSlotId(p.id, f.id)) && !hasUserInfo(f.url)) out.push({ id: feedSlotId(p.id, f.id), kind: 'feed', name: `${p.name} / ${feedName(f)}` });
    }
  }
  return out;
}

// raw: the text or the parsed object of the file. current: the plain settings now in use.
// mode: 'replace' (settings and profiles from the file) | 'add' (only profiles this PC does not have).
// Returns { ok, settings, missing, added } or { ok:false, error }.
export function prepareImport(raw, current, { mode = 'replace' } = {}) {
  let file = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_BACKUP_BYTES) return { ok: false, error: 'too-big' };
    try {
      file = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'invalid' };
    }
  }
  if (!isObj(file) || !isObj(file.settings)) return { ok: false, error: 'invalid' };
  if (file.app !== BACKUP_APP) return { ok: false, error: 'wrong-app' };

  // older files kept the profiles inside `settings`
  const fromFile = structuredClone({ ...file.settings, profiles: Array.isArray(file.profiles) ? file.profiles : file.settings.profiles });
  const emptied = new Set(Array.isArray(file.emptiedSecrets) ? file.emptiedSecrets.filter((x) => typeof x === 'string') : []);
  // a sealed value cannot be opened on another PC or account: drop it
  for (const slot of secretSlots(fromFile)) {
    const v = slot.get();
    if (typeof v === 'string' && v.startsWith(SEALED_PREFIX)) {
      slot.set('');
      emptied.add(slot.id);
    }
  }
  for (const k of RUNTIME_KEYS) delete fromFile[k];
  const incoming = sanitizeSettings(fromFile);

  // a secret the file does not carry is kept from this PC, only for the same server and user
  const e = incoming.notifications.email;
  const ce = current.notifications.email;
  if (!e.pass && ce.pass && e.host && e.host.toLowerCase() === ce.host.toLowerCase() && e.user === ce.user) e.pass = ce.pass;
  if (!incoming.notifications.telegram.botToken) incoming.notifications.telegram.botToken = current.notifications.telegram.botToken;
  for (const p of incoming.profiles) {
    const cp = current.profiles.find((x) => x.id === p.id);
    for (const f of p.feeds) {
      const cf = cp?.feeds.find((x) => x.id === f.id);
      if (cf && !hasUserInfo(f.url) && hasUserInfo(cf.url) && withoutUserInfo(cf.url) === f.url) f.url = cf.url;
    }
  }

  let result;
  let addedIds = null;
  if (mode === 'add') {
    const have = new Set(current.profiles.map((p) => p.id));
    const extra = incoming.profiles.filter((p) => !have.has(p.id)).slice(0, Math.max(0, MAX_PROFILES - current.profiles.length));
    result = sanitizeSettings({ ...structuredClone(current), profiles: [...structuredClone(current.profiles), ...extra] });
    addedIds = new Set(extra.map((p) => p.id).filter((id) => result.profiles.some((r) => r.id === id)));
  } else {
    result = incoming;
    for (const k of RUNTIME_KEYS) result[k] = current[k];
  }
  const missing = missingSecrets(result, [...emptied], { onlyProfileIds: addedIds });
  return { ok: true, settings: result, missing: mode === 'add' ? missing.filter((m) => m.kind === 'feed') : missing, added: addedIds ? addedIds.size : null, mode };
}
