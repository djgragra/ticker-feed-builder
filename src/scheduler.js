// One timer per profile. A profile never runs twice at once; the next run starts `intervalMin` after the
// previous one STARTED (or right away when the run took longer than the interval).
export function createScheduler({ getProfiles, run, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, onState = () => {} }) {
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

  async function tick(pid, manual = false) {
    timers.delete(pid);
    const p = getProfiles().find((x) => x.id === pid);
    if (!p || (!manual && (!active || !p.enabled))) return emit();
    if (running.has(pid)) return arm(p, 5000);
    const started = now();
    running.add(pid);
    emit();
    try {
      await run(p);
    } catch {
      /* the run reports its own errors */
    }
    running.delete(pid);
    const cur = getProfiles().find((x) => x.id === pid);
    if (active && cur && cur.enabled) arm(cur, Math.max(1000, cur.intervalMin * 60_000 - (now() - started)));
    emit();
  }

  return {
    start({ immediately = true } = {}) {
      active = true;
      for (const p of getProfiles()) if (p.enabled && !timers.has(p.id) && !running.has(p.id)) arm(p, immediately ? 0 : p.intervalMin * 60_000);
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
          const left = nextAt.has(p.id) ? nextAt.get(p.id) - now() : 0;
          arm(p, Math.min(Math.max(0, left), p.intervalMin * 60_000));
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
