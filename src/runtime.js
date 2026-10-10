// Everything that runs the feeds, shared by the desktop app and the headless mode (cli.js): engine, scheduler,
// alerts, daily summary, what is remembered between restarts. No Electron here.
import fs from 'node:fs';
import path from 'node:path';
import { createEngine } from './engine.js';
import { createScheduler, effectiveProfile } from './scheduler.js';
import { createAlerter } from './notify.js';
import { msg } from './messages.js';
import { buildDigest, staleHoursOf } from './digest.js';

// per feed, one bucket per clock hour for the last 24 hours: { h: start of the hour (ms), n: checks, c: with new stories, f: failed }
const HISTORY_HOURS = 24;
const hourStart = (ms) => { const d = new Date(ms); d.setMinutes(0, 0, 0); return d.getTime(); };
const pad = (n) => String(n).padStart(2, '0');

export function createRuntime({ getSettings, log = () => {}, notifyDesktop = () => {}, stateFile = null, builtinPlaceholder, onStatus = () => {}, now = Date.now, deps = {} }) {
  const engine = createEngine({ log, builtinPlaceholder, now, ...(deps.engine || {}) });
  const alerter = createAlerter({ getSettings, notifyDesktop, log, deps: deps.notify });
  const status = {}; // profileId -> { lastRunAt, feeds: { feedId: result }, history: { feedId: [hour buckets] } }
  let updateNotified = ''; // the newest version already announced on Telegram / email
  const digestSent = {}; // 'YYYY-MM-DD HH:MM' -> true (so a restart does not repeat the summary)
  let digestTimer = null;
  let saveTimer = null;

  // ---- what is remembered between restarts --------------------------------------------------------
  const remember = () => !!stateFile && getSettings().general.rememberState;

  function loadState() {
    if (!remember()) return;
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const n = engine.importState(raw.engine);
      alerter.importState(raw.alerts);
      Object.assign(digestSent, raw.digestSent || {});
      importHistory(raw.history);
      updateNotified = typeof raw.updateNotified === 'string' ? raw.updateNotified : '';
      log('info', `state restored (${n} feeds)`);
    } catch (err) {
      if (err.code !== 'ENOENT') log('warn', `state file ignored: ${err.message}`);
    }
  }

  function saveStateNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!remember()) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, engine: engine.exportState(), alerts: alerter.exportState(), digestSent, updateNotified, history: exportHistory() }), { mode: 0o600 });
      fs.renameSync(tmp, stateFile);
    } catch (err) {
      log('warn', `state not saved: ${err.message}`);
    }
  }
  const saveStateSoon = () => { if (!saveTimer) saveTimer = setTimeout(saveStateNow, 3000); };

  // ---- the last 24 hours of checks, for the dashboard (kept across restarts with the rest of the state) ----
  const historyCut = () => hourStart(now()) - (HISTORY_HOURS - 1) * 3_600_000;
  function recordCheck(st, feedId, r) {
    const list = ((st.history ||= {})[feedId] ||= []);
    const h = hourStart(r.at || now());
    let b = list.find((x) => x.h === h);
    if (!b) { b = { h, n: 0, c: 0, f: 0 }; list.push(b); list.sort((x, y) => x.h - y.h); }
    b.n++;
    if (!r.ok) b.f++;
    else if (r.changed) b.c++;
    const cut = historyCut();
    while (list.length && list[0].h < cut) list.shift();
  }
  // what goes to the state file: only profiles and feeds that still exist, only the last 24 hours
  function exportHistory() {
    const out = {};
    const cut = historyCut();
    for (const p of getSettings().profiles) {
      for (const f of p.feeds) {
        const list = (status[p.id]?.history?.[f.id] || []).filter((b) => b.h >= cut);
        if (list.length) (out[p.id] ||= {})[f.id] = list;
      }
    }
    return out;
  }
  // a damaged or hand-edited file must never break the start: bad entries are simply dropped
  function importHistory(raw) {
    if (!raw || typeof raw !== 'object') return;
    const cut = historyCut();
    const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
    for (const p of getSettings().profiles) {
      for (const f of p.feeds) {
        const list = (Array.isArray(raw[p.id]?.[f.id]) ? raw[p.id][f.id] : [])
          .map((b) => ({ h: num(b?.h), n: num(b?.n), c: num(b?.c), f: num(b?.f) }))
          .filter((b) => b.h !== null && b.n !== null && b.c !== null && b.f !== null && b.h >= cut)
          .sort((x, y) => x.h - y.h)
          .slice(-HISTORY_HOURS);
        if (list.length) ((status[p.id] ||= { feeds: {} }).history ||= {})[f.id] = list;
      }
    }
  }

  // ---- status ---------------------------------------------------------------------------------------
  function fullStatus() {
    const snap = scheduler.snapshot();
    const profiles = {};
    for (const p of getSettings().profiles) profiles[p.id] = { ...(status[p.id] || { feeds: {} }), ...(snap.profiles[p.id] || {}) };
    return { active: snap.active, profiles };
  }
  const emit = () => onStatus(fullStatus());

  // ---- one run of a profile -------------------------------------------------------------------------
  async function runProfile(profile, opts = {}) {
    const lang = getSettings().language;
    const st = (status[profile.id] ||= { feeds: {} });
    const eff = effectiveProfile(profile, new Date(now())).profile; // inside a time window with its own interval, that interval counts
    const results = await engine.runProfile(eff, (feed, r) => {
      st.feeds[feed.id] = r;
      st.lastRunAt = now();
      recordCheck(st, feed.id, r);
      emit();
    }, opts);
    const dirDown = Object.values(results).some((r) => r.code === 'output-missing');
    alerter.check(`dir:${profile.id}`, !dirDown, {
      downText: () => msg(lang, 'dir', profile.name, profile.outputDir),
      upText: () => msg(lang, 'dirUp', profile.name)
    });
    if (!dirDown) {
      for (const f of profile.feeds.filter((x) => x.enabled)) {
        const r = results[f.id];
        if (!r) continue; // not due in this run (own interval): nothing new to judge
        alerter.check(`feed:${f.id}`, !!r.ok, {
          downText: (n) => msg(lang, 'down', profile.name, f.folder, n, r.error || '?'),
          upText: () => msg(lang, 'up', profile.name, f.folder)
        });
      }
    }
    // a feed that answers but has had nothing new for too long (a ticker that looks fine but is frozen)
    for (const f of profile.feeds.filter((x) => x.enabled)) {
      const hours = staleHoursOf(profile, f);
      const r = st.feeds[f.id];
      if (!hours || !r?.ok || !r.changedAt) { alerter.check(`stale:${f.id}`, true, { downText: () => '', upText: () => '' }); continue; }
      const quiet = now() - r.changedAt;
      alerter.check(`stale:${f.id}`, quiet <= hours * 3_600_000, {
        downText: () => msg(lang, 'stale', profile.name, f.folder, Math.floor(quiet / 3_600_000)),
        upText: () => msg(lang, 'staleUp', profile.name, f.folder)
      });
    }
    for (const id of Object.keys(st.feeds)) if (!profile.feeds.some((f) => f.id === id)) delete st.feeds[id];
    for (const id of Object.keys(st.history || {})) if (!profile.feeds.some((f) => f.id === id)) delete st.history[id];
    emit();
    saveStateSoon();
  }

  const scheduler = createScheduler({ getProfiles: () => getSettings().profiles, run: runProfile, now, onState: emit });

  // ---- daily summary --------------------------------------------------------------------------------
  function digestNow() {
    const s = getSettings();
    const { text } = buildDigest(s, fullStatus(), now());
    alerter.broadcast(text, `[Ticker Feed Builder] ${text.split('\n')[0]}`);
    return text;
  }

  function digestTick() {
    const s = getSettings();
    if (!s.notifications.digest.enabled) return;
    const d = new Date(now());
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (!s.notifications.digest.times.includes(time)) return;
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
    if (digestSent[key]) return;
    digestSent[key] = true;
    for (const k of Object.keys(digestSent)) if (k < key.slice(0, 10)) delete digestSent[k]; // only today's marks are needed
    log('info', `daily summary at ${time}`);
    digestNow();
    saveStateSoon();
  }

  // a newer release exists: say so on Telegram / email, once per version (the desktop window has its own bar)
  function announceUpdate({ latest, current, url }) {
    const s = getSettings();
    const n = s.notifications;
    if (!n.updateAlert || (!n.telegram.enabled && !n.email.enabled) || !latest || updateNotified === latest) return false;
    updateNotified = latest;
    saveStateSoon();
    const text = msg(s.language, 'update', latest, current, url);
    alerter.broadcast(text, `[Ticker Feed Builder] ${text.split(/[:(]/)[0].trim()} ${latest}`);
    return true;
  }
  return {
    engine,
    scheduler,
    announceUpdate,
    alerter,
    fullStatus,
    loadState,
    saveStateNow,
    digestNow,
    // run every enabled profile once, in order (used by the headless --once mode)
    async runAll(opts = {}) {
      for (const p of getSettings().profiles.filter((x) => x.enabled)) await runProfile(p, opts);
      saveStateNow();
      return fullStatus();
    },
    start({ immediately = true } = {}) {
      scheduler.start({ immediately });
      if (!digestTimer) digestTimer = setInterval(digestTick, 20_000);
    },
    stop() {
      scheduler.stop();
    },
    // the settings changed: schedules follow, state of removed feeds is dropped
    refresh() {
      engine.pruneState(getSettings().profiles);
      scheduler.refresh();
    },
    dispose() {
      scheduler.stop();
      clearInterval(digestTimer);
      digestTimer = null;
      saveStateNow();
    }
  };
}
