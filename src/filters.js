// Choosing which stories of a feed go to the ticker: words to require / exclude, duplicates, order.
// filters = { include: [words], exclude: [words], scope: 'title' | 'both', sort: 'feed' | 'newest', dedupe: bool,
//             maxAgeHours: 0 = off, undated: 'keep' | 'drop' }
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); // case and accents do not matter

export const titleKey = (it) => norm(it.title).replace(/[^\p{L}\p{N} ]/gu, '').trim();

export const hasFilters = (f) => !!f && (f.include?.length > 0 || f.exclude?.length > 0 || f.dedupe || f.sort === 'newest' || f.maxAgeHours > 0);

// -> { items, removed } (removed = how many stories the filters left out); `seen` = titles already used by earlier feeds (optional, shared)
// A story older than maxAgeHours is left out; one without a date is kept or left out as `undated` says; one dated in the future is kept.
export function applyFilters(items, f, seen = null, nowMs = Date.now()) {
  const oldest = f?.maxAgeHours > 0 ? nowMs - f.maxAgeHours * 3_600_000 : null;
  const inc = (f?.include || []).map(norm).filter(Boolean);
  const exc = (f?.exclude || []).map(norm).filter(Boolean);
  const both = f?.scope !== 'title';
  const own = new Set();
  const out = [];
  for (const it of items) {
    if (oldest !== null && (Number.isFinite(it.date) ? it.date < oldest : f.undated === 'drop')) continue;
    const text = norm(both ? `${it.title} ${it.description}` : it.title);
    if (inc.length && !inc.some((w) => text.includes(w))) continue;
    if (exc.length && exc.some((w) => text.includes(w))) continue;
    const key = titleKey(it);
    if (key && ((f?.dedupe && own.has(key)) || (seen && seen.has(key)))) continue;
    if (key) own.add(key);
    out.push(it);
  }
  if (f?.sort === 'newest') sortNewest(out);
  return { items: out, removed: items.length - out.length };
}

// newest first; stories without a date stay after the dated ones, in feed order
export function sortNewest(items) {
  const idx = new Map(items.map((it, i) => [it, i]));
  items.sort((a, b) => (b.date ?? -Infinity) - (a.date ?? -Infinity) || idx.get(a) - idx.get(b));
  return items;
}
