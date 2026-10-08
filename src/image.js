// Any image format -> JPEG. JPEG, PNG, GIF, BMP and TIFF with a pure-JavaScript library (jimp); WebP and AVIF
// with WebAssembly codecs (image-modern.js). No native modules, so it builds for every system.
import { Jimp, JimpMime } from 'jimp';
import { decodeModern, sniffModern } from './image-modern.js';

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

// resize: { mode: 'none' | 'cover' | 'contain', width, height }; modern: decode WebP/AVIF (off = such images fail -> placeholder)
export async function toJpeg(buffer, { quality = 85, resize = { mode: 'none' }, modern = true } = {}) {
  let img;
  const kind = sniffModern(buffer);
  if (kind) {
    if (!modern) throw new Error(`${kind.toUpperCase()} images are switched off`);
    const raw = await decodeModern(buffer);
    img = new Jimp({ data: Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength), width: raw.width, height: raw.height });
  } else {
    img = await Jimp.read(buffer);
  }
  const w = Math.round(resize.width), h = Math.round(resize.height);
  if (resize.mode !== 'none' && w > 0 && h > 0) {
    if (resize.mode === 'cover') img.cover({ w, h });
    else img.contain({ w, h }); // letterbox: the output has exactly the requested size, padding is flattened on white below
  }
  // JPEG has no transparency: flatten on white (the original script did the same)
  const flat = new Jimp({ width: img.width, height: img.height, color: 0xffffffff });
  flat.composite(img, 0, 0);
  return Buffer.from(await flat.getBuffer(JimpMime.jpeg, { quality: Math.round(Math.min(100, Math.max(1, quality))) }));
}

export const isJpegBytes = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
