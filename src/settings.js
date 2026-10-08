// Settings (profiles, feeds, notifications) in one JSON file, written atomically.
// The Telegram bot token is sealed by the caller-supplied seal/open functions (the Electron main process
// passes OS-keystore based ones); tests pass none.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_FORMAT, safeName, sanitizeFormat } from './format.js';

export const MAX_PROFILES = 20;
export const MAX_FEEDS = 100;

// Public Italian news feeds the original scripts used: a starting point, the user edits or removes them.
export const STARTER_FEEDS = Object.freeze([
  { folder: 'Politica', url: 'https://www.adnkronos.com/RSS_Politica.xml', maxItems: 10, insecureTls: true },
  { folder: 'Cronaca', url: 'https://www.adnkronos.com/RSS_Cronaca.xml', maxItems: 10, insecureTls: true },
  { folder: 'Esteri', url: 'https://www.adnkronos.com/RSS_Esteri.xml', maxItems: 10, insecureTls: true },
  { folder: 'Sport', url: 'https://www.adnkronos.com/RSS_Sport.xml', maxItems: 10, insecureTls: true },
  { folder: 'Economia', url: 'https://www.adnkronos.com/RSS_Economia.xml', maxItems: 10, insecureTls: true },
  { folder: 'Sostenibilita', url: 'https://www.adnkronos.com/RSS_Sostenibilita.xml', maxItems: 5, insecureTls: true },
  { folder: 'Tecnologia', url: 'https://www.adnkronos.com/RSS_CyberNews.xml', maxItems: 5, insecureTls: true },
  { folder: 'AnsaTopNews', url: 'https://www.ansa.it/sito/notizie/topnews/topnews_gn_rss.xml', maxItems: 25, insecureTls: false }
]);

export const DEFAULT_SETTINGS = Object.freeze({
  language: 'en', // 'en' | 'it' | 'es' — the app always starts in English until the user changes it
  profiles: [],
  general: {
    startOnBoot: true,
    startMinimized: false,
    runOnLaunch: true, // start the schedules as soon as the app opens
    keepAwake: true, // do not let the computer sleep: a sleeping computer stops updating the ticker
    logRetentionDays: 30,
    checkUpdates: true
  },
  notifications: {
    desktop: true,
    failThreshold: 3, // alert after this many failed runs in a row
    telegram: { enabled: false, botToken: '', recipients: [] } // recipients: [{ chatId, note }]
  },
  closeHintShown: false
});

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

function sanitizeFeed(raw, ids, folders) {
  const r = isObj(raw) ? raw : {};
  let folder = safeName(r.folder, 'Feed');
  const base = folder;
  for (let n = 2; folders.has(folder.toLowerCase()); n++) folder = `${base}_${n}`;
  folders.add(folder.toLowerCase());
  return {
    id: id(r.id, ids),
    folder,
    url: sanitizeUrl(r.url),
    maxItems: clamp(r.maxItems, 1, 100, 10),
    intervalMin: clamp(r.intervalMin, 0, 1440, 0), // 0 = the profile's interval
    enabled: r.enabled !== false,
    insecureTls: !!r.insecureTls
  };
}

export function sanitizeProfile(raw, ids = new Set()) {
  const r = isObj(raw) ? raw : {};
  const feedIds = new Set();
  const folders = new Set();
  return {
    id: id(r.id, ids),
    name: String(r.name || '').trim().slice(0, 60) || 'Profile',
    enabled: r.enabled !== false,
    outputDir: String(r.outputDir || '').trim().slice(0, 1000),
    placeholderPath: String(r.placeholderPath || '').trim().slice(0, 1000),
    intervalMin: clamp(r.intervalMin, 1, 1440, 5),
    feeds: (Array.isArray(r.feeds) ? r.feeds : []).slice(0, MAX_FEEDS).map((f) => sanitizeFeed(f, feedIds, folders)),
    format: sanitizeFormat(r.format)
  };
}

export function sanitizeSettings(s) {
  const d = DEFAULT_SETTINGS;
  const out = deepMerge(structuredClone(d), isObj(s) ? s : {});
  if (!['en', 'it', 'es'].includes(out.language)) out.language = d.language;
  const ids = new Set();
  out.profiles = (Array.isArray(out.profiles) ? out.profiles : []).slice(0, MAX_PROFILES).map((p) => sanitizeProfile(p, ids));
  const g = out.general;
  for (const k of ['startOnBoot', 'startMinimized', 'runOnLaunch', 'keepAwake', 'checkUpdates']) g[k] = !!g[k];
  g.logRetentionDays = clamp(g.logRetentionDays, 1, 365, 30);
  const n = out.notifications;
  n.desktop = !!n.desktop;
  n.failThreshold = clamp(n.failThreshold, 1, 100, 3);
  n.telegram.enabled = !!n.telegram.enabled;
  n.telegram.botToken = String(n.telegram.botToken || '').trim().slice(0, 200);
  n.telegram.recipients = (Array.isArray(n.telegram.recipients) ? n.telegram.recipients : [])
    .map((x) => ({ chatId: String(x?.chatId ?? '').trim(), note: String(x?.note ?? '').trim().slice(0, 80) }))
    .filter((x) => x.chatId)
    .slice(0, 20);
  out.closeHintShown = !!out.closeHintShown;
  return out;
}

export function newProfile(name, withStarterFeeds = false) {
  return sanitizeProfile({
    name,
    feeds: withStarterFeeds ? STARTER_FEEDS.map((f) => ({ ...f })) : [],
    format: { ...DEFAULT_FORMAT }
  });
}

// Settings without secrets, for the JSON export / import
export function exportable(settings) {
  const s = structuredClone(settings);
  s.notifications.telegram.botToken = '';
  return s;
}

export function createStore({ file, seal = (v) => v, open = (v) => v, now = Date.now } = {}) {
  let data = load();
  let timer = null;

  function mapToken(settings, fn) {
    const s = structuredClone(settings);
    const t = s.notifications?.telegram;
    if (t && typeof t.botToken === 'string' && t.botToken) t.botToken = fn(t.botToken);
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
    deleteProfile(pid) {
      data.profiles = data.profiles.filter((p) => p.id !== pid);
      schedule();
    },
    flush: writeNow
  };
}
