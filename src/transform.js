// Changes to the text of the stories of one feed, applied just before the length limits:
// transform = { replace: [{ from, to }], case: 'none' | 'upper' | 'lower' | 'sentence', prefix, suffix, maxTitleChars, maxDescChars }
// Replacements are plain text (no patterns), case sensitive, applied in the order of the list, to title and description.
// Prefix and suffix are added to the title only, after the case change. A title or description that is empty stays empty.
import { truncate } from './text.js';

export const MAX_RULES = 30;
export const MAX_RULE_CHARS = 60;
export const MAX_AFFIX_CHARS = 40;

export const defaultTransform = () => ({ replace: [], case: 'none', prefix: '', suffix: '', maxTitleChars: 0, maxDescChars: 0 });

export const hasTransform = (tr) => !!tr && (tr.replace?.length > 0 || (tr.case && tr.case !== 'none') || !!tr.prefix || !!tr.suffix || tr.maxTitleChars > 0 || tr.maxDescChars > 0);

const ONE_LINE_RE = new RegExp('[\\r\\n\\u2028\\u2029\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]+', 'g');
const oneLine = (s) => String(s ?? '').replace(ONE_LINE_RE, ' ');

function changeCase(s, mode) {
  if (mode === 'upper') return s.toUpperCase();
  if (mode === 'lower') return s.toLowerCase();
  if (mode === 'sentence') {
    const low = s.toLowerCase();
    const chars = [...low];
    const i = chars.findIndex((c) => c.toUpperCase() !== c.toLowerCase());
    if (i < 0) return low;
    chars[i] = chars[i].toUpperCase();
    return chars.join('');
  }
  return s;
}

// kind: 'title' | 'desc'
export function transformText(text, tr, kind = 'title') {
  let s = String(text ?? '');
  if (!s || !tr) return s;
  for (const r of tr.replace || []) if (r.from) s = s.split(r.from).join(r.to ?? '');
  s = changeCase(s, tr.case);
  if (kind === 'title' && s) s = `${tr.prefix || ''}${s}${tr.suffix || ''}`;
  return s.replace(/\s+/g, ' ').trim();
}

// The final line of a story: transformation first, then the length limit (the feed's own limit, or the profile's when it is 0).
export function lineFor(text, tr, kind, profileMax) {
  const s = transformText(text, tr, kind);
  const max = (kind === 'title' ? tr?.maxTitleChars : tr?.maxDescChars) || profileMax;
  return max ? truncate(s, max) : s;
}

// "from → to" lines (also "->" and "=>"), one per line; a line without an arrow is ignored.
export function parseRules(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^(.*?)\s*(?:→|->|=>)\s?(.*)$/.exec(line);
    if (!m || !m[1]) continue;
    out.push({ from: m[1], to: m[2] });
  }
  return out;
}

export const formatRules = (rules) => (rules || []).map((r) => `${r.from} → ${r.to}`).join('\n');

export function sanitizeTransform(t) {
  const r = t && typeof t === 'object' && !Array.isArray(t) ? t : {};
  const rules = (Array.isArray(r.replace) ? r.replace : [])
    .map((x) => ({ from: oneLine(x?.from).slice(0, MAX_RULE_CHARS), to: oneLine(x?.to).slice(0, MAX_RULE_CHARS) }))
    .filter((x) => x.from.length > 0)
    .slice(0, MAX_RULES);
  const n = (v) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.min(2000, Math.max(0, x)) : 0; };
  return {
    replace: rules,
    case: ['upper', 'lower', 'sentence'].includes(r.case) ? r.case : 'none',
    prefix: oneLine(r.prefix).slice(0, MAX_AFFIX_CHARS),
    suffix: oneLine(r.suffix).slice(0, MAX_AFFIX_CHARS),
    maxTitleChars: n(r.maxTitleChars),
    maxDescChars: n(r.maxDescChars)
  };
}
