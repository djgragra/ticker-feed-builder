// RSS 2.0, RSS 1.0 (RDF) and Atom parsing. Only what a ticker needs: title, description, one image.
import { XMLParser } from 'fast-xml-parser';
import { cleanText, decodeEntities } from './text.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  isArray: (name) => ['item', 'entry', 'enclosure', 'media:content', 'media:thumbnail', 'media:group', 'link', 'image'].includes(name)
});

const arr = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const text = (v) => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return text(v['#text']);
  return String(v);
};
const IMG_EXT = /\.(jpe?g|png|gif|webp|bmp|avif|tiff?)(\?|#|$)/i;
const isImageType = (type, url) => (type ? /^image\//i.test(type) : IMG_EXT.test(url || ''));
const clean = (u) => decodeEntities(String(u || '')).trim();

function pickImage(it) {
  for (const e of arr(it.enclosure)) {
    const url = clean(e['@_url']);
    if (url && isImageType(e['@_type'], url)) return url;
  }
  const media = [...arr(it['media:content']), ...arr(it['media:group']).flatMap((g) => arr(g['media:content']))];
  for (const m of media) {
    const url = clean(m['@_url']);
    const medium = String(m['@_medium'] || '').toLowerCase();
    if (url && (medium === 'image' || isImageType(m['@_type'], url))) return url;
  }
  for (const t of [...arr(it['media:thumbnail']), ...arr(it['media:group']).flatMap((g) => arr(g['media:thumbnail']))]) {
    const url = clean(t['@_url']);
    if (url) return url;
  }
  for (const l of arr(it.link)) {
    if (l && typeof l === 'object' && l['@_rel'] === 'enclosure' && clean(l['@_href']) && isImageType(l['@_type'], l['@_href'])) return clean(l['@_href']);
  }
  for (const im of arr(it.image)) {
    const url = clean(typeof im === 'object' ? im.url ?? im['@_href'] ?? im['#text'] : im);
    if (url) return url;
  }
  // last resort: first <img> in the HTML of the description
  const html = text(it.description) + text(it['content:encoded']) + text(it.content) + text(it.summary);
  const m = html.match(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/i);
  return m ? clean(m[1]) : null;
}

export function parseFeed(xml, baseUrl) {
  const root = parser.parse(Buffer.isBuffer(xml) ? xml.toString('utf8') : String(xml));
  const nodes = arr(root?.rss?.channel?.item).length
    ? arr(root.rss.channel.item)
    : arr(root?.['rdf:RDF']?.item).length
      ? arr(root['rdf:RDF'].item)
      : arr(root?.feed?.entry);
  const items = [];
  for (const it of nodes) {
    let image = pickImage(it);
    if (image && baseUrl) {
      try {
        image = new URL(image, baseUrl).toString();
      } catch {
        image = null;
      }
    }
    const description = text(it.description) || text(it['content:encoded']) || text(it.summary) || text(it.content);
    items.push({ title: cleanText(text(it.title)), description: cleanText(description), image });
  }
  return items;
}
