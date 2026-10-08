// WebP and AVIF decoding with WebAssembly codecs (@jsquash, Apache-2.0): no native module, so it builds for every
// system and also runs without Electron (headless mode). Loaded on first use.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function sniffModern(b) {
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp' && /^(avif|avis)$/.test(b.toString('latin1', 8, 12))) return 'avif';
  return null;
}

const codecs = {};

// The codecs fetch their .wasm file by URL, which Node cannot do for local files: read it and hand it over compiled.
async function codec(kind, part) {
  const key = `${kind}:${part}`;
  if (!codecs[key]) {
    codecs[key] = (async () => {
      const dir = path.dirname(fileURLToPath(import.meta.resolve(`@jsquash/${kind}`)));
      const wasmFile = path.join(dir, 'codec', part === 'dec' ? 'dec' : 'enc', `${kind}_${part}.wasm`);
      const mod = await import(`@jsquash/${kind}/${part === 'dec' ? 'decode' : 'encode'}.js`);
      await mod.init(await WebAssembly.compile(fs.readFileSync(wasmFile)));
      return mod.default;
    })();
  }
  return codecs[key];
}

// -> { data: Uint8ClampedArray (RGBA), width, height }
export async function decodeModern(buffer) {
  const kind = sniffModern(buffer);
  if (!kind) throw new Error('not a WebP/AVIF image');
  const decode = await codec(kind, 'dec');
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const img = await decode(ab);
  if (!img?.width || !img?.height) throw new Error(`${kind.toUpperCase()} decoding failed`);
  return img;
}

// used by the tests to build fixtures
export async function encodeModern(kind, imageData) {
  return Buffer.from(await (await codec(kind, 'enc'))(imageData));
}
