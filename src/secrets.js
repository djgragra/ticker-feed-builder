// garage-common: secrets 1
// The one list of every place that holds a secret. Sealing at rest, opening, the backup and the
// "type it again" list all use it, so a new secret cannot be forgotten in one of them.
// Settings here are the plain ones (as the app uses them), never the sealed ones on disk.

export const SEALED_PREFIX = 'enc:v1:';

// Fixed slots: id and path inside the settings. Feed addresses are slots too (one per feed).
export const SECRET_PATHS = [
  { id: 'email.pass', path: ['notifications', 'email', 'pass'] },
  { id: 'telegram.botToken', path: ['notifications', 'telegram', 'botToken'] }
];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// "user:password@" in a feed address is a secret; the rest of the address is not.
export function splitUserInfo(url) {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*@)?(.*)$/i.exec(String(url || ''));
  return m ? { head: m[1], userInfo: m[2] ? m[2].slice(0, -1) : '', rest: m[3] } : { head: '', userInfo: '', rest: String(url || '') };
}
export const withoutUserInfo = (url) => {
  const p = splitUserInfo(url);
  return p.head + p.rest;
};
export const hasUserInfo = (url) => !!splitUserInfo(url).userInfo;

const getAt = (obj, path) => path.reduce((o, k) => (isObj(o) ? o[k] : undefined), obj);
function setAt(obj, path, value) {
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (!isObj(o[path[i]])) return;
    o = o[path[i]];
  }
  o[path.at(-1)] = value;
}

export const feedSlotId = (profileId, feedId) => `feed:${profileId}:${feedId}`;

// Every slot that currently exists: { id, kind, get(), set(v) } on the given settings object.
export function secretSlots(settings) {
  const slots = SECRET_PATHS.map(({ id, path }) => ({ id, kind: id, get: () => getAt(settings, path), set: (v) => setAt(settings, path, v) }));
  for (const p of Array.isArray(settings?.profiles) ? settings.profiles : []) {
    if (!isObj(p)) continue;
    for (const f of Array.isArray(p.feeds) ? p.feeds : []) {
      if (isObj(f) && f.type !== 'merge') slots.push({ id: feedSlotId(p.id, f.id), kind: 'feed', profile: p, feed: f, get: () => f.url, set: (v) => (f.url = v) });
    }
  }
  return slots;
}

// A feed address counts as secret only when it carries credentials; the other secrets always.
export const isSecretValue = (slot, value) => typeof value === 'string' && !!value && (slot.kind !== 'feed' || hasUserInfo(value));

// Copy of the settings with fn applied to every secret that has a value (seal) or is already sealed (open).
// For a feed address the whole text is the secret (it holds credentials).
export function mapSecrets(settings, fn) {
  const s = structuredClone(settings);
  for (const slot of secretSlots(s)) {
    const v = slot.get();
    if (typeof v === 'string' && v && (isSecretValue(slot, v) || v.startsWith(SEALED_PREFIX))) slot.set(fn(v));
  }
  return s;
}

// Copy without any secret, plus the ids of the slots that had one ("to type again").
export function stripSecrets(settings) {
  const s = structuredClone(settings);
  const emptied = [];
  for (const slot of secretSlots(s)) {
    const v = slot.get();
    if (!isSecretValue(slot, v)) continue;
    emptied.push(slot.id);
    slot.set(slot.kind === 'feed' ? withoutUserInfo(v) : '');
  }
  return { settings: s, emptied };
}
