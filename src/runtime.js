// Everything that runs the feeds, shared by the desktop app and the headless mode (cli.js): engine, scheduler,
// alerts, daily summary, what is remembered between restarts. No Electron here.
import fs from 'node:fs';
import path from 'node:path';
import { createEngine } from './engine.js';
import { createScheduler, effectiveProfile } from './scheduler.js';
import { createAlerter } from './notify.js';
import { msg } from './messages.js';
import { buildDigest, staleHoursOf } from './digest.js';

const HISTORY_MAX = 24;
const pad = (n) => String(n).padStart(2, '0');

export function createRuntime({ getSettings, log = () => {}, notifyDesktop = () => {}, stateFile = null, builtinPlaceholder, onStatus = () => {}, now = Date.now, deps = {} }) {
  const engine = createEngine({ log, builtinPlaceholder, now, ...(deps.engine || {}) });
  const alerter = createAlerter({ getSettings, notifyDesktop, log, deps: deps.notify });
  const status = {}; // profileId -> { lastRunAt, feeds: { feedId: result }, history: { feedId: [{ at, ok, changed }] } }
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
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, engine: engine.exportState(), alerts: alerter.exportState(), digestSent, updateNotified }), { mode: 0o600 });
      fs.renameSync(tmp, stateFile);
    } catch (err) {
      log('warn', `state not saved: ${err.message}`);
    }
  }
  const saveStateSoon = () => { if (!saveTimer) saveTimer = setTimeout(saveStateNow, 3000); };

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
      // the last checks of this feed (since the app started): the dashboard draws them as a small strip
      const hist = ((st.history ||= {})[feed.id] ||= []);
      hist.push({ at: r.at || now(), ok: !!r.ok, changed: !!r.changed });
      if (hist.length > HISTORY_MAX) hist.splice(0, hist.length - HISTORY_MAX);
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
