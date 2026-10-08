// Generates assets/placeholder.jpg: a neutral dark 1280x720 card with a thin accent bar.
import { Jimp, JimpMime } from 'jimp';
import fs from 'node:fs';
const w = 1280, h = 720;
const img = new Jimp({ width: w, height: h, color: 0x14161aff });
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const g = 0x14 + Math.round((y / h) * 14);
  img.setPixelColor(((g << 24) | ((g + 2) << 16) | ((g + 6) << 8) | 0xff) >>> 0, x, y);
}
for (let y = h - 14; y < h; y++) for (let x = 0; x < w; x++) img.setPixelColor(0xf08a24ff, x, y);
fs.writeFileSync(new URL('../assets/placeholder.jpg', import.meta.url), Buffer.from(await img.getBuffer(JimpMime.jpeg, { quality: 85 })));
