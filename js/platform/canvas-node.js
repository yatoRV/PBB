// Node-only 2D canvas factory backed by @napi-rs/canvas (dev dependency). Imported by tests/tools only —
// importing this module installs the factory for js/platform/bitmap.js.
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { setCanvasFactory } from './bitmap.js';

const FORMATS = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' };

export const nodeCanvasFactory = {
  createCanvas: (w, h) => createCanvas(Math.max(1, w), Math.max(1, h)),
  /** Decodes PNG/JPEG/WebP/GIF bytes to a drawable image (EXIF orientation is stripped by the caller). */
  async loadImage(bytes) {
    const img = await loadImage(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return { image: img, width: img.width, height: img.height, close() {} };
  },
  async encodeImage(rgba, w, h, mime, quality) {
    const c = createCanvas(w, h), ctx = c.getContext('2d'), id = ctx.createImageData(w, h);
    id.data.set(rgba); ctx.putImageData(id, 0, 0);
    const fmt = FORMATS[mime]; if (!fmt) throw new Error('unsupported mime ' + mime);
    const buf = fmt === 'png' ? await c.encode('png') : await c.encode(fmt, Math.round(quality * 100));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  },
};
setCanvasFactory(nodeCanvasFactory);
