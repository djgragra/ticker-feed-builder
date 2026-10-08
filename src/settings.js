// Settings (profiles, feeds, notifications) in one JSON file, written atomically.
// The Telegram bot token is sealed by the caller-supplied seal/open functions (the Electron main process
// passes OS-keystore based ones); tests pass none.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_FORMAT, safeName, sanitizeFormat } from './format.js';
import { isTime } from './schedule-rules.js';

export const MAX_PROFILES = 20;
export const MAX_FEEDS = 100;

export const DEFAULT_SETTINGS = Object.freeze({
  language: 'en', // 'en' | 'it' | 'es' — the app always starts in English until the user changes it
  profiles: [],
  general: {
    startOnBoot: true,
    startMinimized: false,
    runOnLaunch: true, // start the schedules as soon as the app opens
    keepAwake: true, // do not let the computer sleep: a sleeping computer stops updating the ticker
    logRetentionDays: 30,
    checkUpdates: true,
    rememberState: true // keep what each feed looked like across restarts (no needless downloads after a restart)
  },
  notifications: {
    desktop: true,
    failThreshold: 3, // alert after this many failed runs in a row
    digest: { enabled: false, times: ['08:00'] }, // a daily summary on the enabled channels (Telegram, email)
    telegram: { enabled: false, botToken: '', recipients: [] }, // recipients: [{ chatId, note }]
    email: { enabled: false, host: '', port: 587, secure: false, user: '', pass: '', from: '', recipients: [] } // recipients: [address]
  },
  theme: 'dark', // 'dark' | 'light' | 'auto' (follow the system)
  closeHintShown: false
});

export const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function deepMerge(base, patch) {
  if (!isObj(base) || !isObj(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const k of Object.keys(patch)) out[k] = isObj(base[k]) && isObj(patch[k]) ? deepMerge(base[k], patch[k]) : patch[k];
  return out;
}

const clamp = (v, lo, hi, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const id = (v, used) => {
  let s = String(v || '');
  if (!/^[\w-]{1,64}$/.test(s) || used.has(s)) s = randomUUID();
  used.add(s);
  return s;
};

export function sanitizeUrl(u) {
  try {
    const x = new URL(String(u || '').trim());
    return x.protocol === 'http:' || x.protocol === 'https:' ? x.toString() : '';
  } catch {
    return '';
  }
}

const words = (v) => {
  const list = Array.isArray(v) ? v : String(v || '').split(/[\n,;]+/);
  const seen = new Set();
  return list.map((x) => String(x || '').trim().slice(0, 60)).filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase())).slice(0, 50);
};

export function sanitizeFilters(f) {
  const r = isObj(f) ? f : {};
  return {
    include: words(r.include),
    exclude: words(r.exclude),
    scope: r.scope === 'title' ? 'title' : 'both',
    sort: r.sort === 'newest' ? 'newest' : 'feed',
    dedupe: !!r.dedupe
  };
}

function sanitizeFeed(raw, ids, folders) {
  const r = isObj(raw) ? raw : {};
  let folder = safeName(r.folder, 'Feed');
  const base = folder;
  for (let n = 2; folders.has(folder.toLowerCase()); n++) folder = `${base}_${n}`;
  folders.add(folder.toLowerCase());
  const type = r.type === 'merge' ? 'merge' : 'feed';
  return {
    id: id(r.id, ids),
    type, // 'feed' = downloads a URL; 'merge' = the latest stories of several other feeds of this profile in one folder
    folder,
    url: type === 'merge' ? '' : sanitizeUrl(r.url),
    sources: type === 'merge' ? [...new Set((Array.isArray(r.sources) ? r.sources : []).map(String))].slice(0, MAX_FEEDS) : [],
    maxItems: clamp(r.maxItems, 1, 100, 10),
    intervalMin: clamp(r.intervalMin, 0, 1440, 0), // 0 = the profile's interval
    staleHours: clamp(r.staleHours, 0, 720, 0), // 0 = the profile's value; alert when no new stories for that long
    filters: sanitizeFilters(r.filters),
    enabled: r.enabled !== false,
    insecureTls: !!r.insecureTls
  };
}

const DAYS_ALL = [0, 1, 2, 3, 4, 5, 6];
export function sanitizeSchedule(raw) {
  const r = isObj(raw) ? raw : {};
  const windows = (Array.isArray(r.windows) ? r.windows : []).slice(0, 12).map((w) => {
    const days = [...new Set((Array.isArray(w?.days) ? w.days : DAYS_ALL).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    return {
      days: days.length ? days : DAYS_ALL,
      from: isTime(w?.from) ? String(w.from).padStart(5, '0') : '06:00',
      to: isTime(w?.to) ? String(w.to).padStart(5, '0') : '24:00',
      intervalMin: clamp(w?.intervalMin, 0, 1440, 0) // 0 = the profile's interval
    };
  });
  return { enabled: !!r.enabled, windows };
}

export function sanitizeProfile(raw, ids = new Set()) {
  const r = isObj(raw) ? raw : {};
  const feedIds = new Set();
  const folders = new Set();
  const feeds = (Array.isArray(r.feeds) ? r.feeds : []).slice(0, MAX_FEEDS).map((f) => sanitizeFeed(f, feedIds, folders));
  // a merged feed can only use ordinary feeds of the same profile
  const normal = new Set(feeds.filter((f) => f.type === 'feed').map((f) => f.id));
  for (const f of feeds) f.sources = f.sources.filter((sid) => normal.has(sid));
  return {
    id: id(r.id, ids),
    name: String(r.name || '').trim().slice(0, 60) || 'Profile',
    enabled: r.enabled !== false,
    outputDir: String(r.outputDir || '').trim().slice(0, 1000),
    placeholderPath: String(r.placeholderPath || '').trim().slice(0, 1000),
    intervalMin: clamp(r.intervalMin, 1, 1440, 5),
    staleHours: clamp(r.staleHours, 0, 720, 0), // 0 = off
    dedupeAcrossFeeds: !!r.dedupeAcrossFeeds, // a story already used by an earlier feed of the profile is left out of the later ones
    verifyOutput: r.verifyOutput !== false, // read the files back after writing and check they agree
    schedule: sanitizeSchedule(r.schedule),
    feeds,
    format: sanitizeFormat(r.format)
  };
}

export function sanitizeSettings(s) {
  const d = DEFAULT_SETTINGS;
  const out = deepMerge(structuredClone(d), isObj(s) ? s : {});
  if (!['en', 'it', 'es'].includes(out.language)) out.language = d.language;
  if (!['dark', 'light', 'auto'].includes(out.theme)) out.theme = d.theme;
  const ids = new Set();
  out.profiles = (Array.isArray(out.profiles) ? out.profiles : []).slice(0, MAX_PROFILES).map((p) => sanitizeProfile(p, ids));
  const g = out.general;
  for (const k of ['startOnBoot', 'startMinimized', 'runOnLaunch', 'keepAwake', 'checkUpdates', 'rememberState']) g[k] = !!g[k];
  g.logRetentionDays = clamp(g.logRetentionDays, 1, 365, 30);
  const n = out.notifications;
  n.desktop = !!n.desktop;
  n.failThreshold = clamp(n.failThreshold, 1, 100, 3);
  const dg = isObj(n.digest) ? n.digest : {};
  const times = [...new Set((Array.isArray(dg.times) ? dg.times : String(dg.times || '').split(/[\s,;]+/)).map((x) => String(x).trim()).filter((x) => isTime(x) && x !== '24:00').map((x) => x.padStart(5, '0')))].sort().slice(0, 6);
  n.digest = { enabled: !!dg.enabled, times: times.length ? times : ['08:00'] };
  n.telegram.enabled = !!n.telegram.enabled;
  n.telegram.botToken = String(n.telegram.botToken || '').trim().slice(0, 200);
  n.telegram.recipients = (Array.isArray(n.telegram.recipients) ? n.telegram.recipients : [])
    .map((x) => ({ chatId: String(x?.chatId ?? '').trim(), note: String(x?.note ?? '').trim().slice(0, 80) }))
    .filter((x) => x.chatId)
    .slice(0, 20);
  const em = n.email;
  em.enabled = !!em.enabled;
  em.host = String(em.host || '').trim().slice(0, 200);
  em.port = clamp(em.port, 1, 65535, 587);
  em.secure = !!em.secure;
  em.user = String(em.user || '').trim().slice(0, 200);
  em.pass = String(em.pass || '').slice(0, 300);
  em.from = String(em.from || '').trim().slice(0, 200);
  const raw = Array.isArray(em.recipients) ? em.recipients : String(em.recipients || '').split(/[\s,;]+/);
  const seen = new Set();
  em.recipients = raw.map((x) => String(x || '').trim()).filter((x) => EMAIL_RE.test(x) && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase())).slice(0, 20);
  out.closeHintShown = !!out.closeHintShown;
  return out;
}

// A new profile starts with no feed: the user adds the feeds he or she is entitled to use.
export function newProfile(name) {
  return sanitizeProfile({ name, feeds: [], format: { ...DEFAULT_FORMAT } });
}

// Settings without secrets, for the JSON export / import
export function exportable(settings) {
  const s = structuredClone(settings);
  s.notifications.telegram.botToken = '';
  s.notifications.email.pass = '';
  return s;
}

export function createStore({ file, seal = (v) => v, open = (v) => v, now = Date.now } = {}) {
  let data = load();
  let timer = null;

  function mapToken(settings, fn) {
    const s = structuredClone(settings);
    const t = s.notifications?.telegram;
    if (t && typeof t.botToken === 'string' && t.botToken) t.botToken = fn(t.botToken);
    const e = s.notifications?.email;
    if (e && typeof e.pass === 'string' && e.pass) e.pass = fn(e.pass);
    return s;
  }

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return sanitizeSettings(mapToken(raw.settings || {}, open));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // unreadable or corrupt: keep the file for inspection instead of silently overwriting it
        try {
          fs.renameSync(file, `${file}.corrupt-${now()}`);
        } catch {
          /* ignore */
        }
      }
      return sanitizeSettings({});
    }
  }

  function writeNow() {
    clearTimeout(timer);
    timer = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, settings: mapToken(data, seal) }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  const schedule = () => {
    if (!timer) timer = setTimeout(writeNow, 300);
  };

  return {
    get: () => structuredClone(data),
    update(patch) {
      data = sanitizeSettings(deepMerge(data, patch));
      schedule();
      return structuredClone(data);
    },
    replace(settings) {
      data = sanitizeSettings(settings);
      schedule();
      return structuredClone(data);
    },
    saveProfile(profile) {
      const ids = new Set(data.profiles.filter((p) => p.id !== profile.id).map((p) => p.id));
      const clean = sanitizeProfile(profile, ids);
      const i = data.profiles.findIndex((p) => p.id === profile.id);
      if (i >= 0) data.profiles[i] = clean;
      else if (data.profiles.length < MAX_PROFILES) data.profiles.push(clean);
      schedule();
      return structuredClone(clean);
    },
    // New order of the profiles (also the order of the dashboard). Unknown ids are ignored; profiles not listed keep their place at the end.
    reorderProfiles(ids) {
      const list = Array.isArray(ids) ? ids.map(String) : [];
      const byId = new Map(data.profiles.map((p) => [p.id, p]));
      const next = [...new Set(list)].filter((id) => byId.has(id)).map((id) => byId.get(id));
      for (const p of data.profiles) if (!next.includes(p)) next.push(p);
      data.profiles = next;
      schedule();
      return data.profiles.map((p) => p.id);
    },
    deleteProfile(pid) {
      data.profiles = data.profiles.filter((p) => p.id !== pid);
      schedule();
    },
    flush: writeNow
  };
}
