// Time windows of a profile: "check only between 06:00 and 24:00", "every 2 minutes during the evening news".
// schedule = { enabled, windows: [{ days: [0..6] (0 = Sunday), from: 'HH:MM', to: 'HH:MM' ('24:00' allowed), intervalMin: 0 = profile's }] }
// A window with from > to wraps past midnight (22:00-02:00); from = to means the whole day.

const toMin = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v <= 1440 && Number(m[2]) < 60 ? v : null;
};
export const isTime = (s) => toMin(s) !== null;
export const toMinutes = toMin;

function covers(w, day, minute) {
  const from = toMin(w.from), to = toMin(w.to);
  if (from === null || to === null) return false;
  const days = w.days?.length ? w.days : [0, 1, 2, 3, 4, 5, 6];
  if (from === to) return days.includes(day);
  if (from < to) return days.includes(day) && minute >= from && minute < to;
  return (days.includes(day) && minute >= from) || (days.includes((day + 6) % 7) && minute < to); // wraps midnight
}

// -> { active, intervalMin (window override or null), untilStartMs (when inactive: time to the next window start) }
export function scheduleState(profile, date = new Date()) {
  const sch = profile.schedule;
  const valid = (sch?.windows || []).filter((w) => toMin(w.from) !== null && toMin(w.to) !== null);
  if (!sch?.enabled || !valid.length) return { active: true, intervalMin: null, untilStartMs: 0 };
  const day = date.getDay();
  const minute = date.getHours() * 60 + date.getMinutes();
  const hit = valid.find((w) => covers(w, day, minute));
  if (hit) return { active: true, intervalMin: hit.intervalMin > 0 ? hit.intervalMin : null, untilStartMs: 0 };
  let best = Infinity;
  for (let k = 0; k <= 7; k++) {
    const d = (day + k) % 7;
    for (const w of valid) {
      const days = w.days?.length ? w.days : [0, 1, 2, 3, 4, 5, 6];
      if (!days.includes(d)) continue;
      const start = new Date(date);
      start.setDate(start.getDate() + k);
      const fm = toMin(w.from);
      start.setHours(Math.floor((fm === 1440 ? 0 : fm) / 60), fm % 60, 0, 0);
      if (fm === 1440) start.setDate(start.getDate() + 1);
      const ms = start - date;
      if (ms > 0 && ms < best) best = ms;
    }
  }
  return { active: false, intervalMin: null, untilStartMs: Number.isFinite(best) ? best : 60 * 60_000 };
}

// ---- how often a profile is checked: the "plan" -------------------------------------------------------------------
// plan = { mode: 'interval' | 'aligned' | 'times', times: ['HH:MM', ...], days: [0..6] (0 = Sunday; used by 'times') }
//   interval: every N minutes after the previous check started (N = the profile's intervalMin)
//   aligned:  every N minutes on the clock, counted from local midnight (15 = :00 :15 :30 :45)
//   times:    at fixed times of the day, on the chosen days
export const PLAN_MODES = ['interval', 'aligned', 'times'];
const MIN = 60_000;
const dayStart = (ms, plusDays = 0) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + plusDays); return d.getTime(); };

// the first clock-aligned slot strictly after `ms`: every `n` minutes from local midnight, moved by `offsetMs`
// (the grid restarts at every midnight, so an `n` that does not divide the day still gives the same times every day)
export function nextAligned(ms, n, offsetMs = 0) {
  const step = Math.max(1, n) * MIN;
  const off = ((offsetMs % step) + step) % step;
  const mid = dayStart(ms);
  const k = Math.floor((ms - mid - off) / step) + 1;
  const t = mid + off + Math.max(0, k) * step;
  const tomorrow = dayStart(ms, 1) + off;
  return t < tomorrow ? t : tomorrow;
}

function planSlots(plan) {
  const times = [...new Set((plan?.times || []).map(toMin).filter((m) => m !== null && m < 1440))].sort((a, b) => a - b);
  const days = plan?.days?.length ? plan.days : [0, 1, 2, 3, 4, 5, 6];
  return { times, days };
}
const slotAt = (ms, plusDays, minute) => { const d = new Date(dayStart(ms, plusDays)); d.setHours(Math.floor(minute / 60), minute % 60, 0, 0); return d.getTime(); };

// the first fixed time strictly after `ms` (null when the plan has no valid time)
export function nextTime(ms, plan) {
  const { times, days } = planSlots(plan);
  if (!times.length) return null;
  for (let k = 0; k <= 8; k++) {
    if (!days.includes(new Date(dayStart(ms, k)).getDay())) continue;
    for (const m of times) { const t = slotAt(ms, k, m); if (t > ms) return t; }
  }
  return null;
}

// the latest fixed time at or before `ms` (null when there is none in the last week)
export function lastTime(ms, plan) {
  const { times, days } = planSlots(plan);
  if (!times.length) return null;
  for (let k = 0; k >= -8; k--) {
    if (!days.includes(new Date(dayStart(ms, k)).getDay())) continue;
    for (const m of [...times].reverse()) { const t = slotAt(ms, k, m); if (t <= ms) return t; }
  }
  return null;
}
