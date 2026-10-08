// Any image format -> JPEG. Pure JavaScript (jimp), so the app builds for every system without native modules.
import { Jimp, JimpMime } from 'jimp';

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

// resize: { mode: 'none' | 'cover' | 'contain', width, height }
export async function toJpeg(buffer, { quality = 85, resize = { mode: 'none' } } = {}) {
  const src = await Jimp.read(buffer);
  let img = src;
  const w = Math.round(resize.width), h = Math.round(resize.height);
  if (resize.mode !== 'none' && w > 0 && h > 0) {
    if (resize.mode === 'cover') img.cover({ w, h });
    else {
      // contain: letterbox on white so the output has exactly the requested size
      img.contain({ w, h });
    }
  }
  // JPEG has no transparency: flatten on white (the original script did the same)
  const flat = new Jimp({ width: img.width, height: img.height, color: 0xffffffff });
  flat.composite(img, 0, 0);
  return Buffer.from(await flat.getBuffer(JimpMime.jpeg, { quality: Math.round(Math.min(100, Math.max(1, quality))) }));
}

export const isJpegBytes = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
