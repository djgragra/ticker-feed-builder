// Text cleaning for ticker lines: strips markup, decodes entities, forces one single line.

const NAMED = {
  nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', copy: '©', reg: '®', deg: '°', euro: '€',
  hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', egrave: 'è', eacute: 'é', ecirc: 'ê',
  euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ',
  ouml: 'ö', ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü', ntilde: 'ñ', ccedil: 'ç', szlig: 'ß',
  Agrave: 'À', Aacute: 'Á', Egrave: 'È', Eacute: 'É', Igrave: 'Ì', Iacute: 'Í', Ograve: 'Ò', Oacute: 'Ó',
  Ugrave: 'Ù', Uacute: 'Ú', Ntilde: 'Ñ', Ccedil: 'Ç', middot: '·', bull: '•', pound: '£', yen: '¥', cent: '¢'
};

// control characters, line/paragraph separators and zero-width characters
const CONTROL_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200b-\\u200d\\ufeff]', 'g');

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,9});/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 32 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return ' ';
      return String.fromCodePoint(cp);
    }
    return Object.hasOwn(NAMED, e) ? NAMED[e] : m;
  });
}

// Removes tags, decodes entities, collapses every kind of white space (line breaks included).
export function cleanText(input, maxChars = 0) {
  if (input === null || input === undefined) return '';
  let s = String(input);
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, ' ');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  // a decoded entity may have produced new markup (double-escaped feeds): strip once more
  if (/<[a-z/][^>]*>/i.test(s)) s = s.replace(/<[^>]*>/g, '');
  s = s.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  return maxChars > 0 ? truncate(s, maxChars) : s;
}

// Cuts at a word boundary and adds an ellipsis; the result never exceeds maxChars.
export function truncate(s, maxChars) {
  const chars = [...s];
  if (chars.length <= maxChars) return s;
  const cut = chars.slice(0, Math.max(1, maxChars - 1)).join('');
  const sp = cut.lastIndexOf(' ');
  return (sp > cut.length * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-–—]+$/, '') + '…';
}
