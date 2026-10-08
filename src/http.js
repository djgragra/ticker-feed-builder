// Minimal HTTP(S) GET with redirects, timeout, size limit and an opt-in "do not verify certificate".
// Written on node:http/https (not fetch) because fetch cannot relax certificate checks per request.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

const UA = 'Mozilla/5.0 (compatible; TickerFeedBuilder)';

export class HttpError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

export function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '::') return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return /^(fc|fd|fe80)/.test(h) && h.includes(':');
}

export function httpGet(url, { timeoutMs = 10000, insecure = false, maxBytes = 10 * 1024 * 1024, maxRedirects = 5, headers = {}, _hops = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new HttpError('invalid URL'));
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new HttpError('only http and https URLs are allowed'));
    const lib = u.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn(v);
    };
    const req = lib.request(
      u,
      {
        method: 'GET',
        headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate, br', 'Cache-Control': 'no-cache', Pragma: 'no-cache', ...headers },
        ...(u.protocol === 'https:' && insecure ? { rejectUnauthorized: false } : {})
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (_hops >= maxRedirects) return done(reject, new HttpError('too many redirects'));
          let next;
          try {
            next = new URL(res.headers.location, u).toString();
          } catch {
            return done(reject, new HttpError('bad redirect'));
          }
          return httpGet(next, { timeoutMs, insecure, maxBytes, maxRedirects, headers, _hops: _hops + 1 }).then(
            (r) => done(resolve, r),
            (e) => done(reject, e)
          );
        }
        if (status < 200 || status >= 300) {
          res.resume();
          return done(reject, new HttpError(`HTTP ${status}`, status));
        }
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        let stream = res;
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        const chunks = [];
        let size = 0;
        stream.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            done(reject, new HttpError('response too large'));
          } else chunks.push(c);
        });
        stream.on('end', () => done(resolve, { status, headers: res.headers, body: Buffer.concat(chunks), url: u.toString() }));
        stream.on('error', (e) => done(reject, new HttpError(e.message)));
      }
    );
    // one overall deadline: a server that trickles bytes must not hold a run forever
    const deadline = setTimeout(() => {
      req.destroy();
      done(reject, new HttpError('timeout'));
    }, timeoutMs);
    req.on('error', (e) => done(reject, new HttpError(e.code === 'CERT_HAS_EXPIRED' || /certificate|self.signed|unable to verify/i.test(e.message) ? `certificate error (${e.code || e.message})` : e.message)));
    req.end();
  });
}
