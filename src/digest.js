// The daily summary: one text for the enabled channels (Telegram, email).
import { msg } from './messages.js';

const pad = (n) => String(n).padStart(2, '0');
export const stamp = (ms) => { const d = new Date(ms); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export function staleHoursOf(profile, feed) { return feed.staleHours || profile.staleHours || 0; }

// status = { profiles: { [id]: { feeds: { [feedId]: result } } } } (same shape the app shows)
export function buildDigest(settings, status, nowMs = Date.now()) {
  const lang = settings.language;
  const lines = [msg(lang, 'digestTitle', stamp(nowMs)), ''];
  let problems = 0;
  for (const p of settings.profiles) {
    const feeds = p.feeds.filter((f) => f.enabled);
    if (!p.enabled) { lines.push(`${p.name}: ${msg(lang, 'digestDisabled')}`); continue; }
    const st = status.profiles?.[p.id]?.feeds || {};
    const ok = feeds.filter((f) => st[f.id]?.ok).length;
    const last = Math.max(0, ...feeds.map((f) => st[f.id]?.changedAt || 0));
    lines.push(msg(lang, 'digestProfile', p.name, ok, feeds.length, last ? stamp(last) : ''));
    for (const f of feeds) {
      const r = st[f.id];
      if (r && !r.ok) { lines.push(msg(lang, 'digestProblem', f.folder, r.error)); problems++; continue; }
      const h = staleHoursOf(p, f);
      if (r?.ok && h && r.changedAt && nowMs - r.changedAt > h * 3_600_000) { lines.push(msg(lang, 'digestStale', f.folder, Math.floor((nowMs - r.changedAt) / 3_600_000))); problems++; }
    }
  }
  if (!problems) lines.push('', msg(lang, 'digestAllOk'));
  return { text: lines.join('\n'), problems };
}
