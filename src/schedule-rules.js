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
