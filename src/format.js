// Output format of a profile. The defaults reproduce, byte for byte, what the original
// RSS Ticker Downloader scripts wrote for NeMedia Morpheus:
//   <out>/<Folder>/00001.JPG ...   <out>/<Folder>_Title.Txt   <out>/<Folder>_Description.Txt
// Every part can be changed because the layout a given playout/ticker system wants is not documented here.
import iconv from 'iconv-lite';

export const ENCODINGS = ['utf8', 'utf8-bom', 'windows-1252'];

export const DEFAULT_FORMAT = Object.freeze({
  encoding: 'utf8',
  lineEnding: 'lf', // 'lf' | 'crlf'
  trailingNewline: false,
  emptyValue: '-', // written for an empty title or description, so line N always matches image N
  maxTitleChars: 0, // 0 = no limit
  maxDescChars: 0,
  titleFile: '{folder}_Title.Txt',
  descFile: '{folder}_Description.Txt',
  imageDir: '{folder}',
  imageStart: 1,
  imagePad: 5,
  imageExt: 'JPG',
  jpegQuality: 85,
  resize: 'none', // 'none' | 'cover' | 'contain'
  width: 0,
  height: 0,
  metadataFile: true // <Folder>_metadata.json with counters, like the original
});

const clamp = (v, lo, hi, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

// A file or folder name: no separators, no "..", nothing Windows refuses (also valid on Mac/Linux).
export function isPlainName(n) {
  return typeof n === 'string' && n.length > 0 && n.length <= 200 && !/[<>:"/\\|?*\u0000-\u001f]/.test(n) && n !== '.' && n !== '..' && !/[ .]$/.test(n) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(n);
}

export function safeName(s, fallback = 'feed') {
  const n = String(s ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[ .]+$/, '').trim().slice(0, 100);
  return isPlainName(n) ? n : fallback;
}

export function sanitizeFormat(f) {
  const d = DEFAULT_FORMAT;
  const o = { ...d, ...(f && typeof f === 'object' ? f : {}) };
  const out = {
    encoding: ENCODINGS.includes(o.encoding) ? o.encoding : d.encoding,
    lineEnding: o.lineEnding === 'crlf' ? 'crlf' : 'lf',
    trailingNewline: !!o.trailingNewline,
    emptyValue: String(o.emptyValue ?? d.emptyValue).replace(/[\r\n]+/g, ' ').slice(0, 40),
    maxTitleChars: clamp(o.maxTitleChars, 0, 2000, 0),
    maxDescChars: clamp(o.maxDescChars, 0, 5000, 0),
    titleFile: String(o.titleFile),
    descFile: String(o.descFile),
    imageDir: String(o.imageDir),
    imageStart: clamp(o.imageStart, 0, 99999, 1),
    imagePad: clamp(o.imagePad, 1, 8, 5),
    imageExt: /^[A-Za-z0-9]{1,5}$/.test(String(o.imageExt)) ? String(o.imageExt) : d.imageExt,
    jpegQuality: clamp(o.jpegQuality, 30, 100, 85),
    resize: ['none', 'cover', 'contain'].includes(o.resize) ? o.resize : 'none',
    width: clamp(o.width, 0, 8000, 0),
    height: clamp(o.height, 0, 8000, 0),
    metadataFile: o.metadataFile !== false
  };
  // an empty value would break the line/image sync, so it falls back to the default
  if (!out.emptyValue.trim()) out.emptyValue = d.emptyValue;
  for (const k of ['titleFile', 'descFile', 'imageDir']) if (!isPlainName(applyTemplate(out[k], 'x'))) out[k] = d[k];
  if (out.resize !== 'none' && (!out.width || !out.height)) out.resize = 'none';
  return out;
}

export const applyTemplate = (tpl, folder) => String(tpl).replaceAll('{folder}', folder);

export const imageName = (f, i) => `${String(f.imageStart + i).padStart(f.imagePad, '0')}.${f.imageExt}`;

// Lines -> bytes in the configured encoding / line ending.
export function encodeLines(lines, f) {
  const nl = f.lineEnding === 'crlf' ? '\r\n' : '\n';
  const body = lines.join(nl) + (f.trailingNewline && lines.length ? nl : '');
  if (f.encoding === 'windows-1252') return iconv.encode(body, 'windows-1252');
  const buf = Buffer.from(body, 'utf8');
  return f.encoding === 'utf8-bom' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]) : buf;
}
