// One timer per profile. A profile never runs twice at once. How often it runs is its plan (schedule-rules.js):
//   interval: the next run starts `intervalMin` after the previous one STARTED (or right away when the run took longer);
//   aligned:  every `intervalMin` minutes on the clock (15 = :00 :15 :30 :45);
//   times:    at fixed times of the day, on the chosen days; a time missed while the app was closed is made up at start-up.
// With "stagger profiles" on, profiles that share an interval are spread evenly inside it (two profiles every 5 minutes:
// the second one runs 2:30 after the first), in the order of the profile list.
import { scheduleState, nextAligned, nextTime, lastTime } from './schedule-rules.js';

// The profile wakes up as often as its most frequent feed needs; runProfile skips the feeds that are not due yet.
export const tickMinutes = (p) => Math.min(p.intervalMin, ...p.feeds.filter((f) => f.enabled && f.intervalMin > 0).map((f) => f.intervalMin));

// The profile as it is right now: inside a time window with its own interval, that interval replaces the profile's.
export function effectiveProfile(p, date = new Date()) {
  const sch = scheduleState(p, date);
  return { profile: sch.intervalMin ? { ...p, intervalMin: sch.intervalMin } : p, ...sch };
}

export const modeOf = (p) => p.plan?.mode || 'interval';

export function createScheduler({ getProfiles, run, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, onState = () => {}, getStagger = () => false, getLastCheck = () => 0 }) {
  const timers = new Map(); // profileId -> handle
  const nextAt = new Map(); // profileId -> ms
  const running = new Set();
  let active = false;

  const emit = () => onState(snapshot());

  function snapshot() {
    const out = {};
    for (const p of getProfiles()) out[p.id] = { running: running.has(p.id), nextRunAt: active && p.enabled ? nextAt.get(p.id) ?? null : null };
    return { active, profiles: out };
  }

  function arm(p, delay) {
    clearTimer(timers.get(p.id));
    nextAt.set(p.id, now() + delay);
    timers.set(p.id, setTimer(() => tick(p.id), Math.max(0, delay)));
  }

  const tickMs = (p, at) => tickMinutes(effectiveProfile(p, new Date(at)).profile) * 60_000;
  const STEP_FIXED = 10_000; // profiles with fixed times that made up a missed time start 10 s apart (stagger on)

  // how far into its interval a profile runs: profiles with the same interval share the interval evenly
  function staggerOffset(p, at) {
    if (!getStagger()) return 0;
    const mine = tickMs(p, at);
    const group = getProfiles().filter((x) => x.enabled && modeOf(x) !== 'times' && tickMs(x, at) === mine);
    const idx = group.findIndex((x) => x.id === p.id);
    return idx <= 0 ? 0 : Math.round((idx * mine) / group.length);
  }

  // when the profile runs next after `from` (ms); `started` is when the run that just ended began (interval mode)
  function nextDelay(p, from, started = null) {
    const mode = modeOf(p);
    if (mode === 'times') {
      const t = nextTime(from, p.plan);
      return t === null ? 3600_000 : Math.max(1000, t - from);
    }
    if (mode === 'aligned') return Math.max(1000, nextAligned(from, tickMs(p, from) / 60_000, staggerOffset(p, from)) - from);
    return Math.max(1000, tickMs(p, from) - (started === null ? 0 : from - started));
  }

  async function tick(pid, manual = false) {
    timers.delete(pid);
    const p = getProfiles().find((x) => x.id === pid);
    if (!p || (!manual && (!active || !p.enabled))) return emit();
    if (!manual) {
      // outside the time windows of the profile: sleep until the next one starts
      const w = effectiveProfile(p, new Date(now()));
      if (!w.active) {
        // clock-based plans just wait for their next slot; the interval plan wakes up when the window opens
        arm(p, modeOf(p) === 'interval' ? Math.max(1000, Math.min(w.untilStartMs, 6 * 3600_000)) : nextDelay(p, now()));
        return emit();
      }
    }
    if (running.has(pid)) return arm(p, 5000);
    const started = now();
    running.add(pid);
    emit();
    try {
      await run(p, { force: manual, all: modeOf(p) === 'times' }); // at a fixed time every enabled feed is checked, whatever its own interval
    } catch {
      /* the run reports its own errors */
    }
    running.delete(pid);
    const cur = getProfiles().find((x) => x.id === pid);
    if (active && cur && cur.enabled) arm(cur, nextDelay(cur, now(), started));
    emit();
  }

  return {
    start({ immediately = true } = {}) {
      active = true;
      const t0 = now();
      getProfiles().forEach((p, i) => {
        if (!p.enabled || timers.has(p.id) || running.has(p.id)) return;
        const mode = modeOf(p);
        if (mode === 'times') {
          // a fixed time that passed while the app was closed is made up once, when the schedules start at launch
          const slot = lastTime(t0, p.plan);
          const missed = immediately && slot !== null && getLastCheck(p.id) < slot;
          arm(p, missed ? (getStagger() ? i * STEP_FIXED : 0) : nextDelay(p, t0));
        } else if (mode === 'aligned') {
          arm(p, immediately ? staggerOffset(p, t0) : nextDelay(p, t0));
        } else {
          arm(p, (immediately ? 0 : tickMs(p, t0)) + staggerOffset(p, t0));
        }
      });
      emit();
    },
    stop() {
      active = false;
      for (const h of timers.values()) clearTimer(h);
      timers.clear();
      nextAt.clear();
      emit();
    },
    // settings changed: new/enabled profiles start, removed/disabled ones stop, new intervals apply
    refresh() {
      if (!active) return emit();
      const ids = new Set(getProfiles().map((p) => p.id));
      for (const [pid, h] of timers) if (!ids.has(pid)) { clearTimer(h); timers.delete(pid); nextAt.delete(pid); }
      for (const p of getProfiles()) {
        if (!p.enabled) { clearTimer(timers.get(p.id)); timers.delete(p.id); nextAt.delete(p.id); continue; }
        if (!running.has(p.id)) {
          if (modeOf(p) !== 'interval') { arm(p, nextDelay(p, now())); continue; } // clock-based: the next slot is always computable
          const left = nextAt.has(p.id) ? nextAt.get(p.id) - now() : 0;
          arm(p, Math.min(Math.max(0, left), tickMs(p, now())));
        }
      }
      emit();
    },
    runNow(pid) {
      const p = getProfiles().find((x) => x.id === pid);
      if (!p || running.has(pid)) return false;
      clearTimer(timers.get(pid)); // a manual run works while paused too; it re-arms the timer only if running
      timers.delete(pid);
      tick(pid, true);
      return true;
    },
    isActive: () => active,
    isRunning: (pid) => running.has(pid),
    snapshot
  };
}
