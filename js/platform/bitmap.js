// android.graphics emulation for the OCR / vision code: Bitmap (ARGB_8888 as non-premultiplied RGBA bytes),
// Canvas, Paint, Typeface, Matrix, Rect, RectF, Color, BitmapFactory and ExifInterface (androidx).
//
// Pixel operations that are integer-exact on Android are exact here: crop, getPixels/setPixels, copy, and any
// drawBitmap whose matrix maps pixel centres onto pixel centres (translations, 90° rotations, flips) — the
// "sprite" path. Scaled / rotated / perspective drawBitmap, createScaledBitmap and createBitmap(..., matrix,
// filter) are resampled in JS by inverse mapping with Skia's conventions (pixel centres, clamp-to-edge,
// bilinear when FILTER_BITMAP_FLAG, nearest otherwise, 4x4 supersampled edge coverage for ANTI_ALIAS). The same
// code runs in every browser and in Node, so results do not depend on the browser's image smoothing. Exact
// pixel equality with Skia is not promised for these resampling paths.
//
// Text, lines and stroked/anti-aliased rects are rasterised with the pluggable 2D canvas factory
// (setCanvasFactory; browser default = <canvas>, Node = js/platform/canvas-node.js) and composited in.
// Image decode/encode (BitmapFactory, compress) also use the factory and are async. Decoding draws the image in
// tiles of at most 4096x4096 (iOS Safari refuses canvases above 16,777,216 px) and applies inSampleSize per tile,
// so a 48 MP photo never needs a full-size canvas, and a subsampled decode never holds a full-size RGBA copy.
//
// Port notes: Java float[] point arrays passed to Matrix.mapPoints / setPolyToPoly / getValues should be
// Float32Array (stored results are then rounded to float like Java); Java int[] pixel arrays -> Int32Array.
import { IllegalArgumentException, IllegalStateException, ArrayIndexOutOfBoundsException, RuntimeException, NullPointerException, UnsupportedOperationException, roundF } from './java.js';
import { File, FileInputStream, InputStream } from './files.js';

const fr = Math.fround;

// ------------------------------------------------------------------ canvas factory
let factory = null;
/**
 * Installs the 2D canvas factory: { createCanvas(w, h), loadImage(bytes) -> Promise<{image, width, height, close()}>
 * (image: anything ctx.drawImage accepts, not EXIF-rotated), encodeImage(rgba, w, h, mime, quality) ->
 * Promise<Uint8Array> }. Node tests import js/platform/canvas-node.js.
 */
export function setCanvasFactory(f) { factory = f; }
export function getCanvasFactory() {
  if (!factory && typeof document !== 'undefined') factory = browserFactory();
  if (!factory) throw new IllegalStateException('No 2D canvas factory installed (Node: import js/platform/canvas-node.js)');
  return factory;
}
/** iOS Safari's maximum canvas area; decoding never creates a larger canvas. */
export const MAX_CANVAS_PIXELS = 16777216;
const DECODE_TILE = 4096;
/** Releases a transient canvas (iPhone memory). */
function release(canvas) { canvas.width = 0; canvas.height = 0; }
function browserFactory() {
  return {
    createCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; },
    async loadImage(bytes) {
      const blob = new Blob([bytes]);
      if (typeof createImageBitmap === 'function') {
        try { const bmp = await createImageBitmap(blob); return { image: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() }; } catch { /* fall back to <img> */ }
      }
      const url = URL.createObjectURL(blob), img = new Image(); img.src = url;
      try { await img.decode(); } catch (e) { URL.revokeObjectURL(url); throw e; }
      return { image: img, width: img.naturalWidth, height: img.naturalHeight, close: () => { URL.revokeObjectURL(url); img.removeAttribute('src'); } };
    },
    async encodeImage(rgba, w, h, mime, quality) {
      if (w * h > MAX_CANVAS_PIXELS) throw new RuntimeException('bitmap too large to encode: ' + w + 'x' + h);
      const c = this.createCanvas(w, h); c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
      const blob = await new Promise(res => c.toBlob(res, mime, quality)); release(c);
      if (!blob) throw new RuntimeException('encode failed'); return new Uint8Array(await blob.arrayBuffer());
    },
  };
}
/**
 * Decodes through the factory in tiles <= 4096x4096 and applies inSampleSize `s` while copying:
 * JPEG = block average with ceil size (libjpeg scaling), others = point sampling at s/2 with floor size.
 * The decoded source is closed as soon as the last tile is read.
 */
async function rasterize(fac, bytes, s, jpeg) {
  const src = await fac.loadImage(bytes);
  try {
    const w = src.width, h = src.height; if (!(w > 0 && h > 0)) return null;
    const dim = n => (s === 1 ? n : jpeg ? Math.ceil(n / s) : s > n ? 1 : Math.floor(n / s));
    const nw = dim(w), nh = dim(h), out = new Uint8ClampedArray(nw * nh * 4), half = s >> 1;
    const sums = s > 1 && jpeg ? new Uint32Array(nw * nh * 4) : null, counts = sums ? new Uint32Array(nw * nh) : null;
    for (let ty = 0; ty < h; ty += DECODE_TILE) for (let tx = 0; tx < w; tx += DECODE_TILE) {
      const tw = Math.min(DECODE_TILE, w - tx), th = Math.min(DECODE_TILE, h - ty);
      const c = fac.createCanvas(tw, th);
      try {
        const ctx = c.getContext('2d', { willReadFrequently: true }); if (!ctx) throw new RuntimeException('2D canvas unavailable');
        ctx.drawImage(src.image, tx, ty, tw, th, 0, 0, tw, th);
        const d = ctx.getImageData(0, 0, tw, th).data;
        if (s === 1) { for (let y = 0; y < th; y++) out.set(d.subarray(y * tw * 4, (y + 1) * tw * 4), ((ty + y) * w + tx) * 4); }
        else if (sums) {
          for (let y = 0; y < th; y++) {
            const row = Math.floor((ty + y) / s) * nw;
            for (let x = 0, i = y * tw * 4; x < tw; x++, i += 4) { const o = row + Math.floor((tx + x) / s), k = o * 4; sums[k] += d[i]; sums[k + 1] += d[i + 1]; sums[k + 2] += d[i + 2]; sums[k + 3] += d[i + 3]; counts[o]++; }
          }
        } else {
          for (let oy = 0; oy < nh; oy++) {
            const sy = Math.min(h - 1, oy * s + half); if (sy < ty || sy >= ty + th) continue;
            for (let ox = 0; ox < nw; ox++) { const sx = Math.min(w - 1, ox * s + half); if (sx < tx || sx >= tx + tw) continue; const i = ((sy - ty) * tw + (sx - tx)) * 4, o = (oy * nw + ox) * 4; out[o] = d[i]; out[o + 1] = d[i + 1]; out[o + 2] = d[i + 2]; out[o + 3] = d[i + 3]; }
          }
        }
      } finally { release(c); }
    }
    if (sums) for (let o = 0; o < counts.length; o++) { const n = counts[o], k = o * 4; out[k] = Math.round(sums[k] / n); out[k + 1] = Math.round(sums[k + 1] / n); out[k + 2] = Math.round(sums[k + 2] / n); out[k + 3] = Math.round(sums[k + 3] / n); }
    return { width: nw, height: nh, data: out };
  } finally { if (src.close) src.close(); }
}

// ------------------------------------------------------------------ Color
const argbOf = (a, r, g, b) => ((a << 24) | (r << 16) | (g << 8) | b) | 0;
const NAMED = { black: 0xFF000000, darkgray: 0xFF444444, gray: 0xFF888888, lightgray: 0xFFCCCCCC, white: 0xFFFFFFFF, red: 0xFFFF0000, green: 0xFF00FF00, blue: 0xFF0000FF, yellow: 0xFFFFFF00, cyan: 0xFF00FFFF, magenta: 0xFFFF00FF, aqua: 0xFF00FFFF, fuchsia: 0xFFFF00FF, darkgrey: 0xFF444444, grey: 0xFF888888, lightgrey: 0xFFCCCCCC, lime: 0xFF00FF00, maroon: 0xFF800000, navy: 0xFF000080, olive: 0xFF808000, purple: 0xFF800080, silver: 0xFFC0C0C0, teal: 0xFF008080 };
export const Color = {
  BLACK: 0xFF000000 | 0, DKGRAY: 0xFF444444 | 0, GRAY: 0xFF888888 | 0, LTGRAY: 0xFFCCCCCC | 0, WHITE: -1, RED: 0xFFFF0000 | 0, GREEN: 0xFF00FF00 | 0, BLUE: 0xFF0000FF | 0, YELLOW: 0xFFFFFF00 | 0, CYAN: 0xFF00FFFF | 0, MAGENTA: 0xFFFF00FF | 0, TRANSPARENT: 0,
  alpha: c => c >>> 24, red: c => (c >> 16) & 0xFF, green: c => (c >> 8) & 0xFF, blue: c => c & 0xFF,
  rgb: (r, g, b) => argbOf(0xFF, r & 0xFF, g & 0xFF, b & 0xFF),
  argb: (a, r, g, b) => argbOf(a & 0xFF, r & 0xFF, g & 0xFF, b & 0xFF),
  /** #RRGGBB, #AARRGGBB or a colour name. */
  parseColor(s) {
    if (s.charAt(0) === '#') {
      if (!/^#[0-9a-fA-F]+$/.test(s) || (s.length !== 7 && s.length !== 9)) throw new IllegalArgumentException('Unknown color');
      let c = parseInt(s.substring(1), 16); if (s.length === 7) c |= 0xFF000000; return c | 0;
    }
    const v = NAMED[s.toLowerCase()]; if (v !== undefined) return v | 0;
    throw new IllegalArgumentException('Unknown color');
  },
  /** Skia SkRGBToHSV (float math). */
  colorToHSV(color, hsv) {
    const r = (color >> 16) & 0xFF, g = (color >> 8) & 0xFF, b = color & 0xFF;
    const min = Math.min(r, g, b), max = Math.max(r, g, b), delta = max - min, v = fr(max / 255);
    if (delta === 0) { hsv[0] = 0; hsv[1] = 0; hsv[2] = v; return; }
    const s = fr(delta / max); let h;
    if (r === max) h = fr((g - b) / delta); else if (g === max) h = fr(2 + fr((b - r) / delta)); else h = fr(4 + fr((r - g) / delta));
    h = fr(h * 60); if (h < 0) h = fr(h + 360);
    hsv[0] = h; hsv[1] = s; hsv[2] = v;
  },
  /** Skia SkHSVToColor. */
  HSVToColor(a, hsv) {
    if (hsv === undefined) { hsv = a; a = 0xFF; }
    if (hsv.length < 3) throw new RuntimeException('3 components required for hsv');
    const round = x => Math.floor(fr(x + 0.5));
    const s = fr(Math.min(1, Math.max(0, hsv[1]))), v = fr(Math.min(1, Math.max(0, hsv[2]))), vb = round(fr(v * 255));
    if (Math.abs(s) <= 1 / 4096) return argbOf(a & 0xFF, vb, vb, vb);
    const hx = hsv[0] < 0 || hsv[0] >= 360 ? 0 : fr(hsv[0] / 60), w = Math.floor(hx), f = fr(hx - w);
    const p = round(fr(fr(fr(1 - s) * v) * 255)), q = round(fr(fr(fr(1 - fr(s * f)) * v) * 255)), t = round(fr(fr(fr(1 - fr(s * fr(1 - f))) * v) * 255));
    const [r, g, b] = [[vb, t, p], [q, vb, p], [p, vb, t], [p, q, vb], [t, p, vb], [vb, p, q]][Math.min(w, 5)];
    return argbOf(a & 0xFF, r, g, b);
  },
};

// ------------------------------------------------------------------ Rect / RectF / Point
export class Rect {
  constructor(l = 0, t = 0, r = 0, b = 0) { if (l instanceof Rect) { this.set(l); return; } this.left = l | 0; this.top = t | 0; this.right = r | 0; this.bottom = b | 0; }
  set(l, t, r, b) { if (l instanceof Rect) { ({ left: l, top: t, right: r, bottom: b } = l); } this.left = l | 0; this.top = t | 0; this.right = r | 0; this.bottom = b | 0; }
  width() { return (this.right - this.left) | 0; }
  height() { return (this.bottom - this.top) | 0; }
  centerX() { return (this.left + this.right) >> 1; }
  centerY() { return (this.top + this.bottom) >> 1; }
  exactCenterX() { return fr((this.left + this.right) * 0.5); }
  exactCenterY() { return fr((this.top + this.bottom) * 0.5); }
  isEmpty() { return this.left >= this.right || this.top >= this.bottom; }
  setEmpty() { this.left = this.top = this.right = this.bottom = 0; }
  contains(x, y) { return this.left < this.right && this.top < this.bottom && x >= this.left && x < this.right && y >= this.top && y < this.bottom; }
  offset(dx, dy) { this.left += dx; this.right += dx; this.top += dy; this.bottom += dy; }
  inset(dx, dy) { this.left += dx; this.top += dy; this.right -= dx; this.bottom -= dy; }
  intersect(l, t, r, b) { if (l instanceof Rect) ({ left: l, top: t, right: r, bottom: b } = l); if (this.left < r && l < this.right && this.top < b && t < this.bottom) { this.left = Math.max(this.left, l); this.top = Math.max(this.top, t); this.right = Math.min(this.right, r); this.bottom = Math.min(this.bottom, b); return true; } return false; }
  union(l, t, r, b) { if (l instanceof Rect) ({ left: l, top: t, right: r, bottom: b } = l); if (l >= r || t >= b) return; if (this.left < this.right && this.top < this.bottom) { this.left = Math.min(this.left, l); this.top = Math.min(this.top, t); this.right = Math.max(this.right, r); this.bottom = Math.max(this.bottom, b); } else this.set(l, t, r, b); }
  equals(o) { return o instanceof Rect && o.left === this.left && o.top === this.top && o.right === this.right && o.bottom === this.bottom; }
  toString() { return 'Rect(' + this.left + ', ' + this.top + ' - ' + this.right + ', ' + this.bottom + ')'; }
}
export class RectF {
  constructor(l = 0, t = 0, r = 0, b = 0) { if (l instanceof Rect || l instanceof RectF) { this.set(l); return; } this.left = fr(l); this.top = fr(t); this.right = fr(r); this.bottom = fr(b); }
  set(l, t, r, b) { if (l instanceof Rect || l instanceof RectF) ({ left: l, top: t, right: r, bottom: b } = l); this.left = fr(l); this.top = fr(t); this.right = fr(r); this.bottom = fr(b); }
  width() { return fr(this.right - this.left); }
  height() { return fr(this.bottom - this.top); }
  centerX() { return fr((this.left + this.right) * 0.5); }
  centerY() { return fr((this.top + this.bottom) * 0.5); }
  isEmpty() { return !(this.left < this.right && this.top < this.bottom); }
  setEmpty() { this.left = this.top = this.right = this.bottom = 0; }
  contains(x, y) { return this.left < this.right && this.top < this.bottom && x >= this.left && x < this.right && y >= this.top && y < this.bottom; }
  offset(dx, dy) { this.set(this.left + dx, this.top + dy, this.right + dx, this.bottom + dy); }
  inset(dx, dy) { this.set(this.left + dx, this.top + dy, this.right - dx, this.bottom - dy); }
  intersect(l, t, r, b) { if (l instanceof RectF || l instanceof Rect) ({ left: l, top: t, right: r, bottom: b } = l); if (this.left < r && l < this.right && this.top < b && t < this.bottom) { this.set(Math.max(this.left, l), Math.max(this.top, t), Math.min(this.right, r), Math.min(this.bottom, b)); return true; } return false; }
  /** round(Rect dst): each edge Math.round. */
  round(dst) { dst.set(roundF(this.left), roundF(this.top), roundF(this.right), roundF(this.bottom)); }
  roundOut(dst) { dst.set(Math.floor(this.left), Math.floor(this.top), Math.ceil(this.right), Math.ceil(this.bottom)); }
  equals(o) { return o instanceof RectF && o.left === this.left && o.top === this.top && o.right === this.right && o.bottom === this.bottom; }
  toString() { return 'RectF(' + this.left + ', ' + this.top + ', ' + this.right + ', ' + this.bottom + ')'; }
}

// ------------------------------------------------------------------ Matrix
const NEARLY_ZERO = 1 / 4096;
const snapZero = v => (Math.abs(v) <= NEARLY_ZERO ? 0 : v);
/** android.graphics.Matrix (3x3, float values; index order MSCALE_X, MSKEW_X, MTRANS_X, MSKEW_Y, MSCALE_Y, MTRANS_Y, MPERSP_0..2). */
export class Matrix {
  static MSCALE_X = 0; static MSKEW_X = 1; static MTRANS_X = 2; static MSKEW_Y = 3; static MSCALE_Y = 4; static MTRANS_Y = 5; static MPERSP_0 = 6; static MPERSP_1 = 7; static MPERSP_2 = 8;
  static ScaleToFit = { FILL: 'FILL', START: 'START', CENTER: 'CENTER', END: 'END' };
  constructor(src) { this.v = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]); if (src) this.set(src); }
  _setAll(a) { for (let i = 0; i < 9; i++) this.v[i] = a[i]; return this; }
  set(src) { if (src == null) this.reset(); else this.v.set(src.v); }
  reset() { this._setAll([1, 0, 0, 0, 1, 0, 0, 0, 1]); }
  isIdentity() { const v = this.v; return v[0] === 1 && v[1] === 0 && v[2] === 0 && v[3] === 0 && v[4] === 1 && v[5] === 0 && v[6] === 0 && v[7] === 0 && v[8] === 1; }
  isAffine() { return this.v[6] === 0 && this.v[7] === 0 && this.v[8] === 1; }
  _isTranslate() { const v = this.v; return v[0] === 1 && v[1] === 0 && v[3] === 0 && v[4] === 1 && this.isAffine(); }
  rectStaysRect() { const v = this.v; if (!this.isAffine()) return false; return (v[0] !== 0 && v[4] !== 0 && v[1] === 0 && v[3] === 0) || (v[0] === 0 && v[4] === 0 && v[1] !== 0 && v[3] !== 0); }
  getValues(out) { if (out.length < 9) throw new ArrayIndexOutOfBoundsException(); for (let i = 0; i < 9; i++) out[i] = this.v[i]; }
  setValues(vals) { if (vals.length < 9) throw new ArrayIndexOutOfBoundsException(); this._setAll(vals); }
  setTranslate(dx, dy) { this._setAll([1, 0, dx, 0, 1, dy, 0, 0, 1]); }
  setScale(sx, sy, px, py) { if (px === undefined) this._setAll([sx, 0, 0, 0, sy, 0, 0, 0, 1]); else this._setAll([sx, 0, px - sx * px, 0, sy, py - sy * py, 0, 0, 1]); }
  setSinCos(s, c, px, py) { if (px === undefined) this._setAll([c, -s, 0, s, c, 0, 0, 0, 1]); else this._setAll([c, -s, s * py + (1 - c) * px, s, c, -s * px + (1 - c) * py, 0, 0, 1]); }
  setRotate(degrees, px, py) { const r = fr(degrees) * Math.PI / 180; this.setSinCos(snapZero(fr(Math.sin(r))), snapZero(fr(Math.cos(r))), px, py); }
  setSkew(kx, ky, px, py) { if (px === undefined) this._setAll([1, kx, 0, ky, 1, 0, 0, 0, 1]); else this._setAll([1, kx, -kx * py, ky, 1, -ky * px, 0, 0, 1]); }
  /** this = a × b (b applied first). */
  setConcat(a, b) { this._setAll(mul(a.v, b.v)); return true; }
  preConcat(o) { this._setAll(mul(this.v, o.v)); return true; }
  postConcat(o) { this._setAll(mul(o.v, this.v)); return true; }
  preTranslate(dx, dy) { const m = new Matrix(); m.setTranslate(dx, dy); return this.preConcat(m); }
  postTranslate(dx, dy) { const m = new Matrix(); m.setTranslate(dx, dy); return this.postConcat(m); }
  preScale(sx, sy, px, py) { const m = new Matrix(); m.setScale(sx, sy, px, py); return this.preConcat(m); }
  postScale(sx, sy, px, py) { const m = new Matrix(); m.setScale(sx, sy, px, py); return this.postConcat(m); }
  preRotate(d, px, py) { const m = new Matrix(); m.setRotate(d, px, py); return this.preConcat(m); }
  postRotate(d, px, py) { const m = new Matrix(); m.setRotate(d, px, py); return this.postConcat(m); }
  preSkew(kx, ky, px, py) { const m = new Matrix(); m.setSkew(kx, ky, px, py); return this.preConcat(m); }
  postSkew(kx, ky, px, py) { const m = new Matrix(); m.setSkew(kx, ky, px, py); return this.postConcat(m); }
  /** invert(Matrix inverse) -> false when singular. */
  invert(inverse) { const r = inv(this.v); if (!r) return false; if (inverse) inverse._setAll(r); return true; }
  /** mapPoints(pts) in place | mapPoints(dst, src) | mapPoints(dst, dstIndex, src, srcIndex, pointCount). */
  mapPoints(dst, a, b, c, d) {
    let dstIndex = 0, src = dst, srcIndex = 0, count;
    if (a === undefined) count = dst.length >> 1;
    else if (b === undefined) { src = a; count = src.length >> 1; }
    else { dstIndex = a; src = b; srcIndex = c; count = d; }
    const v = this.v, tmp = new Float64Array(count * 2);
    for (let i = 0; i < count; i++) { const x = src[srcIndex + 2 * i], y = src[srcIndex + 2 * i + 1]; const w = v[6] * x + v[7] * y + v[8], iw = w !== 0 ? 1 / w : 0; tmp[2 * i] = (v[0] * x + v[1] * y + v[2]) * iw; tmp[2 * i + 1] = (v[3] * x + v[4] * y + v[5]) * iw; }
    for (let i = 0; i < count * 2; i++) dst[dstIndex + i] = tmp[i];
  }
  mapVectors(dst, src = dst) { const v = this.v; const n = src.length >> 1; const out = []; for (let i = 0; i < n; i++) { const x = src[2 * i], y = src[2 * i + 1]; out.push(v[0] * x + v[1] * y, v[3] * x + v[4] * y); } for (let i = 0; i < out.length; i++) dst[i] = out[i]; }
  /** mapRect(rect) in place | mapRect(dst, src); returns rectStaysRect(). */
  mapRect(dst, src = dst) {
    const p = [src.left, src.top, src.right, src.top, src.right, src.bottom, src.left, src.bottom]; this.mapPoints(p);
    dst.set(Math.min(p[0], p[2], p[4], p[6]), Math.min(p[1], p[3], p[5], p[7]), Math.max(p[0], p[2], p[4], p[6]), Math.max(p[1], p[3], p[5], p[7]));
    return this.rectStaysRect();
  }
  mapRadius(r) { const p = [r, 0, 0, r]; this.mapVectors(p); return fr(Math.sqrt(Math.hypot(p[0], p[1]) * Math.hypot(p[2], p[3]))); }
  setRectToRect(src, dst, stf) {
    if (src.isEmpty()) { this.reset(); return false; }
    if (dst.isEmpty()) { this._setAll([0, 0, 0, 0, 0, 0, 0, 0, 1]); return true; }
    let sx = dst.width() / src.width(), sy = dst.height() / src.height(), tx = 0, ty = 0;
    if (stf !== 'FILL') { const s = Math.min(sx, sy); sx = sy = s; const dx = dst.width() - src.width() * s, dy = dst.height() - src.height() * s; if (stf === 'CENTER') { tx = dx / 2; ty = dy / 2; } else if (stf === 'END') { tx = dx; ty = dy; } }
    this._setAll([sx, 0, dst.left - src.left * sx + tx, 0, sy, dst.top - src.top * sy + ty, 0, 0, 1]); return true;
  }
  /** setPolyToPoly(src, srcIndex, dst, dstIndex, pointCount 0..4); 4 points give a perspective matrix. */
  setPolyToPoly(src, srcIndex, dst, dstIndex, pointCount) {
    if (pointCount > 4) throw new IllegalArgumentException();
    if (srcIndex < 0 || dstIndex < 0 || srcIndex + pointCount * 2 > src.length || dstIndex + pointCount * 2 > dst.length) throw new ArrayIndexOutOfBoundsException();
    const s = i => [src[srcIndex + 2 * i], src[srcIndex + 2 * i + 1]], d = i => [dst[dstIndex + 2 * i], dst[dstIndex + 2 * i + 1]];
    if (pointCount === 0) { this.reset(); return true; }
    if (pointCount === 1) { const [x, y] = s(0), [X, Y] = d(0); this.setTranslate(X - x, Y - y); return true; }
    const basis = pointCount === 2 ? poly2 : pointCount === 3 ? poly3 : poly4;
    const a = basis([...Array(pointCount)].map((_, i) => s(i))), b = basis([...Array(pointCount)].map((_, i) => d(i)));
    if (!a || !b) return false;
    const ai = inv(a); if (!ai) return false;
    this._setAll(mul(b, ai)); return true;
  }
  equals(o) { return o instanceof Matrix && this.v.every((x, i) => x === o.v[i]); }
  toString() { return 'Matrix{[' + [0, 3, 6].map(r => [...this.v.slice(r, r + 3)].join(', ')).join('][') + ']}'; }
  toShortString() { return this.toString(); }
}
function mul(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}
function inv(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) <= NEARLY_ZERO * NEARLY_ZERO * NEARLY_ZERO) return null;
  const k = 1 / det;
  const r = [A * k, (c * h - b * i) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, (c * d - a * f) * k, C * k, (b * g - a * h) * k, (a * e - b * d) * k];
  if (g === 0 && h === 0 && i === 1) { r[6] = 0; r[7] = 0; r[8] = 1; }
  return r;
}
// Basis maps (unit points -> polygon) as in SkMatrix::setPolyToPoly.
function poly2([p0, p1]) { return [p1[1] - p0[1], p1[0] - p0[0], p0[0], p0[0] - p1[0], p1[1] - p0[1], p0[1], 0, 0, 1]; }
function poly3([p0, p1, p2]) { return [p2[0] - p0[0], p1[0] - p0[0], p0[0], p2[1] - p0[1], p1[1] - p0[1], p0[1], 0, 0, 1]; }
function poly4([p0, p1, p2, p3]) { // unit square (0,0),(0,1),(1,1),(1,0) -> p0,p1,p2,p3 (Skia's Poly4Proc)
  const x0 = p2[0] - p0[0], y0 = p2[1] - p0[1], x1 = p2[0] - p1[0], y1 = p2[1] - p1[1], x2 = p2[0] - p3[0], y2 = p2[1] - p3[1];
  const D = x1 * y2 - x2 * y1; // solves a1*x1 + a2*x2 = x0 - x1 - x2 (and the same for y)
  if (Math.abs(D) <= NEARLY_ZERO * NEARLY_ZERO) return null;
  const a1 = (x0 * y2 - x2 * y0) / D - 1, a2 = (x1 * y0 - x0 * y1) / D - 1;
  return [a2 * p3[0] + p3[0] - p0[0], a1 * p1[0] + p1[0] - p0[0], p0[0], a2 * p3[1] + p3[1] - p0[1], a1 * p1[1] + p1[1] - p0[1], p0[1], a2, a1, 1];
}

// ------------------------------------------------------------------ Typeface / Paint
export class Typeface {
  static NORMAL = 0; static BOLD = 1; static ITALIC = 2; static BOLD_ITALIC = 3;
  constructor(family, style) { this.family = family; this.style = style; Object.freeze(this); }
  getStyle() { return this.style; }
  isBold() { return (this.style & 1) !== 0; }
  isItalic() { return (this.style & 2) !== 0; }
  /** create(familyName|Typeface|null, style). */
  static create(family, style) { const f = family instanceof Typeface ? family.family : family == null ? 'sans-serif' : String(family); return new Typeface(f, style & 3); }
  static defaultFromStyle(style) { return new Typeface('sans-serif', style & 3); }
  equals(o) { return o instanceof Typeface && o.family === this.family && o.style === this.style; }
}
Typeface.DEFAULT = new Typeface('sans-serif', 0); Typeface.DEFAULT_BOLD = new Typeface('sans-serif', 1);
Typeface.SANS_SERIF = new Typeface('sans-serif', 0); Typeface.SERIF = new Typeface('serif', 0); Typeface.MONOSPACE = new Typeface('monospace', 0);
// Android font metrics (ascent/descent per 1px of text size): Roboto for sans-serif, Noto Serif, Droid Sans Mono.
const METRICS = { 'sans-serif': [-1900 / 2048, 500 / 2048], serif: [-1069 / 1000, 293 / 1000], monospace: [-1901 / 2048, 483 / 2048] };

export class Paint {
  static ANTI_ALIAS_FLAG = 1; static FILTER_BITMAP_FLAG = 2; static DITHER_FLAG = 4; static UNDERLINE_TEXT_FLAG = 8; static STRIKE_THRU_TEXT_FLAG = 16; static FAKE_BOLD_TEXT_FLAG = 32; static LINEAR_TEXT_FLAG = 64; static SUBPIXEL_TEXT_FLAG = 128; static DEV_KERN_TEXT_FLAG = 256; static EMBEDDED_BITMAP_TEXT_FLAG = 1024;
  static Style = { FILL: 'FILL', STROKE: 'STROKE', FILL_AND_STROKE: 'FILL_AND_STROKE' };
  static Cap = { BUTT: 'butt', ROUND: 'round', SQUARE: 'square' };
  static Join = { MITER: 'miter', ROUND: 'round', BEVEL: 'bevel' };
  static Align = { LEFT: 'left', CENTER: 'center', RIGHT: 'right' };
  /** new Paint() | new Paint(flags) | new Paint(Paint). API 28+ adds DEV_KERN, EMBEDDED_BITMAP_TEXT and FILTER_BITMAP by default. */
  constructor(arg = 0) {
    if (arg instanceof Paint) { Object.assign(this, arg); return; }
    this.flags = arg | 256 | 1024 | 2; this.color = Color.BLACK; this.style = 'FILL'; this.strokeWidth = 0; this.strokeCap = 'butt'; this.strokeJoin = 'miter';
    this.textSize = 12; this.typeface = null; this.textAlign = 'left'; this.letterSpacing = 0; this.shader = null;
  }
  set(src) { Object.assign(this, src); }
  reset() { Object.assign(this, new Paint()); }
  getFlags() { return this.flags; }
  setFlags(f) { this.flags = f; }
  isAntiAlias() { return (this.flags & 1) !== 0; }
  setAntiAlias(b) { this.flags = b ? this.flags | 1 : this.flags & ~1; }
  isFilterBitmap() { return (this.flags & 2) !== 0; }
  setFilterBitmap(b) { this.flags = b ? this.flags | 2 : this.flags & ~2; }
  setDither(b) { this.flags = b ? this.flags | 4 : this.flags & ~4; }
  isFakeBoldText() { return (this.flags & 32) !== 0; }
  setFakeBoldText(b) { this.flags = b ? this.flags | 32 : this.flags & ~32; }
  getColor() { return this.color; }
  setColor(c) { this.color = c | 0; }
  getAlpha() { return this.color >>> 24; }
  setAlpha(a) { this.color = ((this.color & 0xFFFFFF) | ((a & 0xFF) << 24)) | 0; }
  setARGB(a, r, g, b) { this.color = Color.argb(a, r, g, b); }
  getStyle() { return this.style; }
  setStyle(s) { this.style = s; }
  getStrokeWidth() { return this.strokeWidth; }
  setStrokeWidth(w) { this.strokeWidth = fr(w); }
  getStrokeCap() { return this.strokeCap; }
  setStrokeCap(c) { this.strokeCap = c; }
  getStrokeJoin() { return this.strokeJoin; }
  setStrokeJoin(j) { this.strokeJoin = j; }
  getTextSize() { return this.textSize; }
  setTextSize(s) { if (s > 0) this.textSize = fr(s); }
  getTypeface() { return this.typeface; }
  setTypeface(t) { this.typeface = t; return t; }
  getTextAlign() { return this.textAlign; }
  setTextAlign(a) { this.textAlign = a; }
  getLetterSpacing() { return this.letterSpacing; }
  setLetterSpacing(s) { this.letterSpacing = fr(s); }
  _family() { return (this.typeface ?? Typeface.DEFAULT).family; }
  _css() { const t = this.typeface ?? Typeface.DEFAULT; return (t.isItalic() ? 'italic ' : '') + (t.isBold() || this.isFakeBoldText() ? 'bold ' : '') + this.textSize + 'px ' + t.family; }
  getShader() { return this.shader; }
  setShader(shader) { this.shader = shader ?? null; return shader; }
  /** Applies the colour, or the shader modulated by the paint alpha, as the 2D context fill/stroke style. */
  _apply(ctx, stroke) {
    let style = this._rgba();
    if (this.shader) { style = this.shader._canvasStyle(ctx); ctx.globalAlpha = this.getAlpha() / 255; } else ctx.globalAlpha = 1;
    if (stroke) { ctx.strokeStyle = style; ctx.lineWidth = this.strokeWidth || 1; ctx.lineCap = this.strokeCap; ctx.lineJoin = this.strokeJoin; } else ctx.fillStyle = style;
  }
  _rgba() { const c = this.color; return 'rgba(' + ((c >> 16) & 255) + ',' + ((c >> 8) & 255) + ',' + (c & 255) + ',' + ((c >>> 24) / 255) + ')'; }
  _metrics() { return METRICS[this._family()] ?? METRICS['sans-serif']; }
  ascent() { return fr(this._metrics()[0] * this.textSize); }
  descent() { return fr(this._metrics()[1] * this.textSize); }
  getFontSpacing() { return fr(this.descent() - this.ascent()); }
  /** Width of text as rendered by the canvas factory's font. */
  measureText(text, start, end) { const s = start === undefined ? String(text) : String(text).substring(start, end); return withContext(1, 1, ctx => { ctx.font = this._css(); return fr(ctx.measureText(s).width); }); }
  /** getTextBounds(text, start, end, Rect bounds): ink bounds relative to (0, baseline), rounded out. */
  getTextBounds(text, start, end, bounds) {
    const s = String(text).substring(start, end);
    withContext(1, 1, ctx => {
      ctx.font = this._css(); const m = ctx.measureText(s);
      bounds.set(Math.floor(-(m.actualBoundingBoxLeft ?? 0)), Math.floor(-(m.actualBoundingBoxAscent ?? -this.ascent())), Math.ceil(m.actualBoundingBoxRight ?? m.width), Math.ceil(m.actualBoundingBoxDescent ?? this.descent()));
    });
  }
}
/** Runs fn(ctx) on a transient canvas and releases it. */
function withContext(w, h, fn) { const c = getCanvasFactory().createCanvas(w, h); try { return fn(c.getContext('2d')); } finally { release(c); } }

/** android.graphics.Shader (only TileMode.CLAMP gradients are emulated). */
export class Shader {
  static TileMode = { CLAMP: 'CLAMP', REPEAT: 'REPEAT', MIRROR: 'MIRROR', DECAL: 'DECAL' };
}
const cssColor = c => 'rgba(' + ((c >> 16) & 255) + ',' + ((c >> 8) & 255) + ',' + (c & 255) + ',' + ((c >>> 24) / 255) + ')';
/** LinearGradient(x0, y0, x1, y1, color0, color1, tile) | (x0, y0, x1, y1, int[] colors, float[] positions|null, tile); local canvas coordinates. */
export class LinearGradient extends Shader {
  constructor(x0, y0, x1, y1, a, b, tile) {
    super();
    if (tile !== Shader.TileMode.CLAMP) throw new UnsupportedOperationException('Only Shader.TileMode.CLAMP is emulated: ' + tile);
    const colors = typeof a === 'number' ? [a, b] : [...a], pos = typeof a === 'number' ? null : b;
    if (colors.length < 2) throw new IllegalArgumentException('needs >= 2 number of colors');
    if (pos != null && pos.length !== colors.length) throw new IllegalArgumentException('color and position arrays must be of equal length');
    Object.assign(this, { x0: fr(x0), y0: fr(y0), x1: fr(x1), y1: fr(y1), colors, positions: pos == null ? null : [...pos], tile });
  }
  _canvasStyle(ctx) {
    const g = ctx.createLinearGradient(this.x0, this.y0, this.x1, this.y1), n = this.colors.length;
    this.colors.forEach((c, i) => g.addColorStop(Math.min(1, Math.max(0, this.positions ? this.positions[i] : i / (n - 1))), cssColor(c)));
    return g;
  }
}

// ------------------------------------------------------------------ Bitmap
export const Config = { ARGB_8888: 'ARGB_8888', RGB_565: 'RGB_565', ALPHA_8: 'ALPHA_8', ARGB_4444: 'ARGB_4444', RGBA_F16: 'RGBA_F16', HARDWARE: 'HARDWARE' };
export const CompressFormat = { PNG: 'PNG', JPEG: 'JPEG', WEBP: 'WEBP', WEBP_LOSSY: 'WEBP_LOSSY', WEBP_LOSSLESS: 'WEBP_LOSSLESS' };
const MIME = { PNG: 'image/png', JPEG: 'image/jpeg', WEBP: 'image/webp', WEBP_LOSSY: 'image/webp', WEBP_LOSSLESS: 'image/webp' };
function checkConfig(c) { if (c != null && c !== Config.ARGB_8888) throw new UnsupportedOperationException('Only Bitmap.Config.ARGB_8888 is emulated: ' + c); }
/** Premultiplied storage round trip of Android for alpha < 255 (alpha 0 loses the colour). */
function storeColor(d, i, c) {
  const a = c >>> 24; let r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  if (a !== 255) {
    if (a === 0) r = g = b = 0;
    else { const pm = x => Math.round(x * a / 255), um = x => Math.min(255, Math.round(x * 255 / a)); r = um(pm(r)); g = um(pm(g)); b = um(pm(b)); }
  }
  d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
}
function checkPixelsAccess(bmp, x, y, width, height, offset, stride, pixels) {
  if (x < 0) throw new IllegalArgumentException('x must be >= 0');
  if (y < 0) throw new IllegalArgumentException('y must be >= 0');
  if (x + width > bmp.width) throw new IllegalArgumentException('x + width must be <= bitmap.width()');
  if (y + height > bmp.height) throw new IllegalArgumentException('y + height must be <= bitmap.height()');
  if (Math.abs(stride) < width) throw new IllegalArgumentException('abs(stride) must be >= width');
  const last = offset + (height - 1) * stride, len = pixels.length;
  if (offset < 0 || offset + width > len || last < 0 || last + width > len) throw new ArrayIndexOutOfBoundsException();
}

export class Bitmap {
  static Config = Config;
  static CompressFormat = CompressFormat;
  constructor(width, height, data, mutable) { this.width = width; this.height = height; this.data = data ?? new Uint8ClampedArray(width * height * 4); this.mutable = mutable; this.recycled = false; this.alpha = true; this.density = 0; }
  _check(what) { if (this.recycled) throw new IllegalStateException("Can't call " + what + '() on a recycled bitmap'); }
  getWidth() { return this.width; }
  getHeight() { return this.height; }
  getConfig() { return Config.ARGB_8888; }
  isMutable() { return this.mutable; }
  isRecycled() { return this.recycled; }
  /** Frees the pixel buffer immediately (important on iPhone). */
  recycle() { if (!this.recycled) { this.recycled = true; this.data = null; } }
  hasAlpha() { return this.alpha; }
  setHasAlpha(b) { this.alpha = !!b; }
  getByteCount() { return this.width * this.height * 4; }
  getAllocationByteCount() { return this.recycled ? 0 : this.getByteCount(); }
  getRowBytes() { return this.width * 4; }
  getDensity() { return this.density; }
  setDensity(d) { this.density = d; }
  /** Signed ARGB int. */
  getPixel(x, y) {
    this._check('getPixel');
    if (x < 0) throw new IllegalArgumentException('x must be >= 0'); if (y < 0) throw new IllegalArgumentException('y must be >= 0');
    if (x >= this.width) throw new IllegalArgumentException('x must be < bitmap.width()'); if (y >= this.height) throw new IllegalArgumentException('y must be < bitmap.height()');
    const d = this.data, i = (y * this.width + x) * 4; return argbOf(d[i + 3], d[i], d[i + 1], d[i + 2]);
  }
  /** getPixels(int[] pixels, offset, stride, x, y, width, height): signed ARGB ints (Int32Array or array). */
  getPixels(pixels, offset, stride, x, y, width, height) {
    this._check('getPixels'); checkPixelsAccess(this, x, y, width, height, offset, stride, pixels);
    if (width === 0 || height === 0) return;
    const d = this.data, W = this.width;
    for (let row = 0; row < height; row++) {
      let o = offset + row * stride, i = ((y + row) * W + x) * 4;
      for (let col = 0; col < width; col++, i += 4) pixels[o++] = (d[i + 3] << 24) | (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    }
  }
  setPixel(x, y, color) {
    this._check('setPixel'); if (!this.mutable) throw new IllegalStateException();
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) throw new IllegalArgumentException(x < 0 || x >= this.width ? 'x must be < bitmap.width()' : 'y must be < bitmap.height()');
    storeColor(this.data, (y * this.width + x) * 4, color);
  }
  setPixels(pixels, offset, stride, x, y, width, height) {
    this._check('setPixels'); if (!this.mutable) throw new IllegalStateException();
    checkPixelsAccess(this, x, y, width, height, offset, stride, pixels);
    if (width === 0 || height === 0) return;
    const d = this.data, W = this.width;
    for (let row = 0; row < height; row++) { let o = offset + row * stride, i = ((y + row) * W + x) * 4; for (let col = 0; col < width; col++, i += 4) storeColor(d, i, pixels[o++]); }
  }
  eraseColor(c) { this._check('eraseColor'); if (!this.mutable) throw new IllegalStateException('cannot erase immutable bitmaps'); const d = this.data; storeColor(d, 0, c); for (let i = 4; i < d.length; i += 4) { d[i] = d[0]; d[i + 1] = d[1]; d[i + 2] = d[2]; d[i + 3] = d[3]; } }
  copy(config, isMutable) { this._check('copy'); checkConfig(config); const b = new Bitmap(this.width, this.height, this.data.slice(), !!isMutable); b.alpha = this.alpha; b.density = this.density; return b; }
  sameAs(other) { if (this === other) return true; if (!other || other.width !== this.width || other.height !== this.height || this.recycled || other.recycled) return false; const a = this.data, b = other.data; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
  /** async compress(format, quality, OutputStream) -> Promise<boolean>. */
  async compress(format, quality, stream) {
    if (this.recycled) throw new IllegalStateException("Can't compress a recycled bitmap");
    if (stream == null) throw new NullPointerException(); if (quality < 0 || quality > 100) throw new IllegalArgumentException('quality must be 0..100');
    const mime = MIME[format]; if (!mime) throw new IllegalArgumentException('format ' + format);
    const bytes = await getCanvasFactory().encodeImage(this.data, this.width, this.height, mime, quality / 100);
    stream.write(bytes, 0, bytes.length); stream.flush(); return true;
  }

  /**
   * createBitmap(width, height, config) | (int[] colors, width, height, config) | (int[] colors, offset, stride,
   * width, height, config) | (src) | (src, x, y, width, height) | (src, x, y, width, height, Matrix m, boolean filter).
   */
  static createBitmap(a, ...r) {
    if (typeof a === 'number') { const [h, config] = r; checkConfig(config); if (a <= 0 || h <= 0) throw new IllegalArgumentException('width and height must be > 0'); return new Bitmap(a, h, null, true); }
    if (a instanceof Bitmap) { if (r.length === 0) return Bitmap.createBitmap(a, 0, 0, a.width, a.height); const [x, y, w, h, m = null, filter = false] = r; return createFromSource(a, x, y, w, h, m, filter); }
    if (a == null) throw new NullPointerException();
    let offset = 0, stride, w, h, config;
    if (r.length >= 5) [offset, stride, w, h, config] = r; else { [w, h, config] = r; stride = w; }
    checkConfig(config);
    if (w <= 0 || h <= 0) throw new IllegalArgumentException('width and height must be > 0');
    if (Math.abs(stride) < w) throw new IllegalArgumentException('abs(stride) must be >= width');
    const last = offset + (h - 1) * stride, len = a.length;
    if (offset < 0 || offset + w > len || last < 0 || last + w > len) throw new ArrayIndexOutOfBoundsException();
    const b = new Bitmap(w, h, null, true); b.setPixels(a, offset, stride, 0, 0, w, h); b.mutable = false; return b;
  }
  static createScaledBitmap(src, dstWidth, dstHeight, filter) {
    const m = new Matrix(), w = src.getWidth(), h = src.getHeight();
    if (w !== dstWidth || h !== dstHeight) m.setScale(fr(dstWidth / fr(w)), fr(dstHeight / fr(h)));
    return Bitmap.createBitmap(src, 0, 0, w, h, m, filter);
  }
}
/** Bitmap.createBitmap(source, x, y, width, height, m, filter) following Android's implementation. */
function createFromSource(source, x, y, width, height, m, filter) {
  if (x < 0) throw new IllegalArgumentException('x must be >= 0'); if (y < 0) throw new IllegalArgumentException('y must be >= 0');
  if (width <= 0) throw new IllegalArgumentException('width must be > 0'); if (height <= 0) throw new IllegalArgumentException('height must be > 0');
  if (x + width > source.getWidth()) throw new IllegalArgumentException('x + width must be <= bitmap.width()');
  if (y + height > source.getHeight()) throw new IllegalArgumentException('y + height must be <= bitmap.height()');
  if (source.isRecycled()) throw new IllegalArgumentException('cannot use a recycled source in createBitmap');
  if (!source.isMutable() && x === 0 && y === 0 && width === source.getWidth() && height === source.getHeight() && (m == null || m.isIdentity())) return source;
  const srcR = new Rect(x, y, x + width, y + height), dstR = new RectF(0, 0, width, height), deviceR = new RectF();
  let bitmap, paint = null;
  if (m == null || m.isIdentity()) bitmap = new Bitmap(width, height, null, true);
  else {
    const transformed = !m.rectStaysRect(); m.mapRect(deviceR, dstR);
    const neww = roundF(deviceR.width()), newh = roundF(deviceR.height());
    if (neww <= 0 || newh <= 0) throw new IllegalArgumentException('width and height must be > 0');
    bitmap = new Bitmap(neww, newh, null, true);
    paint = new Paint(); paint.setFilterBitmap(filter); if (transformed) paint.setAntiAlias(true);
  }
  bitmap.density = source.density; bitmap.alpha = source.alpha;
  const canvas = new Canvas(bitmap); canvas.translate(-deviceR.left, -deviceR.top); if (m) canvas.concat(m);
  canvas.drawBitmap(source, srcR, dstR, paint);
  return bitmap;
}

// ------------------------------------------------------------------ Canvas
export const PorterDuff = { Mode: { CLEAR: 'CLEAR', SRC: 'SRC', SRC_OVER: 'SRC_OVER' } };
/** android.graphics.Canvas drawing into a mutable Bitmap. */
export class Canvas {
  constructor(bitmap) {
    if (bitmap == null) throw new NullPointerException();
    if (!bitmap.isMutable()) throw new IllegalStateException('Immutable bitmap passed to Canvas constructor');
    if (bitmap.isRecycled()) throw new RuntimeException('Canvas: trying to use a recycled bitmap ' + bitmap);
    this.bitmap = bitmap; this.m = new Matrix(); this.clip = [0, 0, bitmap.width, bitmap.height]; this.stack = [];
  }
  getWidth() { return this.bitmap.width; }
  getHeight() { return this.bitmap.height; }
  save() { this.stack.push([new Matrix(this.m), [...this.clip]]); return this.stack.length; }
  restore() { if (!this.stack.length) throw new IllegalStateException('Underflow in restore - more restores than saves'); [this.m, this.clip] = this.stack.pop(); }
  getSaveCount() { return this.stack.length + 1; }
  restoreToCount(n) { if (n < 1) throw new IllegalArgumentException('Underflow in restoreToCount - more restores than saves'); while (this.stack.length >= n) this.restore(); }
  translate(dx, dy) { if (dx !== 0 || dy !== 0) this.m.preTranslate(dx, dy); }
  scale(sx, sy, px, py) { this.m.preScale(sx, sy, px, py); }
  rotate(d, px, py) { this.m.preRotate(d, px, py); }
  skew(kx, ky) { this.m.preSkew(kx, ky); }
  concat(matrix) { if (matrix) this.m.preConcat(matrix); }
  setMatrix(matrix) { if (matrix) this.m.set(matrix); else this.m.reset(); }
  getMatrix(out) { if (out) { out.set(this.m); return; } return new Matrix(this.m); }
  /** clipRect(l, t, r, b) | clipRect(Rect|RectF): intersects the device clip (non-AA, edges rounded). */
  clipRect(l, t, r, b) {
    if (typeof l === 'object') ({ left: l, top: t, right: r, bottom: b } = l);
    const dev = new RectF(l, t, r, b); this.m.mapRect(dev);
    const R = v => Math.floor(v + 0.5);
    const c = this.clip; this.clip = [Math.max(c[0], R(dev.left)), Math.max(c[1], R(dev.top)), Math.min(c[2], R(dev.right)), Math.min(c[3], R(dev.bottom))];
    return this.clip[0] < this.clip[2] && this.clip[1] < this.clip[3];
  }
  getClipBounds(out) { const r = out ?? new Rect(); const inv = new Matrix(); const dev = new RectF(...this.clip); if (this.m.invert(inv)) inv.mapRect(dev); dev.roundOut(r); return out ? !r.isEmpty() : r; }
  /** drawColor(color[, PorterDuff.Mode]) over the clip. */
  drawColor(color, mode = 'SRC_OVER') {
    const [x0, y0, x1, y1] = this.clip; if (x0 >= x1 || y0 >= y1) return;
    const d = this.bitmap.data, W = this.bitmap.width; const a = color >>> 24, r = (color >> 16) & 255, g = (color >> 8) & 255, b = color & 255;
    for (let y = y0; y < y1; y++) for (let x = x0, i = (y * W + x0) * 4; x < x1; x++, i += 4) {
      if (mode === 'CLEAR') { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; }
      else if (mode === 'SRC' || a === 255) storeColor(d, i, color);
      else blendPixel(d, i, r * a / 255, g * a / 255, b * a / 255, a / 255);
    }
  }
  drawARGB(a, r, g, b) { this.drawColor(Color.argb(a, r, g, b)); }
  drawRGB(r, g, b) { this.drawColor(Color.rgb(r, g, b)); }
  drawPaint(paint) { this.drawColor(paint.getColor()); }
  /** drawBitmap(bmp, left, top, paint) | (bmp, Rect src|null, Rect|RectF dst, paint) | (bmp, Matrix, paint). */
  drawBitmap(bmp, a, b, c) {
    if (bmp.isRecycled()) throw new RuntimeException('Canvas: trying to use a recycled bitmap ' + bmp);
    let m, domain, paint;
    if (a instanceof Matrix) { m = new Matrix(this.m); m.preConcat(a); domain = [0, 0, bmp.width, bmp.height]; paint = b; }
    else if (typeof a === 'number') { m = new Matrix(this.m); m.preTranslate(a, b); domain = [0, 0, bmp.width, bmp.height]; paint = c; }
    else {
      const src = a ?? new Rect(0, 0, bmp.width, bmp.height), dst = b; paint = c;
      if (dst == null) throw new NullPointerException();
      const sw = src.right - src.left, sh = src.bottom - src.top; if (sw <= 0 || sh <= 0 || dst.right <= dst.left || dst.bottom <= dst.top) return;
      const sx = (dst.right - dst.left) / sw, sy = (dst.bottom - dst.top) / sh;
      const r = new Matrix(); r._setAll([sx, 0, dst.left - src.left * sx, 0, sy, dst.top - src.top * sy, 0, 0, 1]);
      m = new Matrix(this.m); m.preConcat(r); domain = [src.left, src.top, src.right, src.bottom];
    }
    drawMapped(this, bmp, m, domain, paint ?? null);
  }
  /** drawRect(l, t, r, b, paint) | drawRect(Rect|RectF, paint). */
  drawRect(l, t, r, b, paint) {
    if (typeof l === 'object') { paint = t; ({ left: l, top: t, right: r, bottom: b } = l); }
    if (paint.style === 'FILL' && !paint.isAntiAlias() && !paint.shader && this.m._isTranslate()) {
      const R = v => Math.floor(v + 0.5), v = this.m.v;
      const x0 = Math.max(this.clip[0], R(Math.min(l, r) + v[2])), x1 = Math.min(this.clip[2], R(Math.max(l, r) + v[2])), y0 = Math.max(this.clip[1], R(Math.min(t, b) + v[5])), y1 = Math.min(this.clip[3], R(Math.max(t, b) + v[5]));
      this.save(); this.clip = [x0, y0, x1, y1]; this.drawColor(paint.getColor()); this.restore(); return;
    }
    this._shape(paint, [Math.min(l, r), Math.min(t, b), Math.max(l, r), Math.max(t, b)], ctx => ctx.rect(l, t, r - l, b - t));
  }
  /** drawRoundRect(l, t, r, b, rx, ry, paint) | drawRoundRect(RectF, rx, ry, paint); radii scaled down to fit like Skia. */
  drawRoundRect(l, t, r, b, rx, ry, paint) {
    if (typeof l === 'object') { paint = r; ry = b; rx = t; ({ left: l, top: t, right: r, bottom: b } = l); }
    if (r < l) [l, r] = [r, l];
    if (b < t) [t, b] = [b, t];
    rx = Math.max(0, rx); ry = Math.max(0, ry);
    const k = Math.min(1, rx > 0 ? (r - l) / (2 * rx) : 1, ry > 0 ? (b - t) / (2 * ry) : 1); rx *= k; ry *= k;
    this._shape(paint, [l, t, r, b], ctx => {
      if (rx <= 0 || ry <= 0) { ctx.rect(l, t, r - l, b - t); return; }
      const P = Math.PI;
      ctx.moveTo(l + rx, t); ctx.lineTo(r - rx, t); ctx.ellipse(r - rx, t + ry, rx, ry, 0, -P / 2, 0);
      ctx.lineTo(r, b - ry); ctx.ellipse(r - rx, b - ry, rx, ry, 0, 0, P / 2);
      ctx.lineTo(l + rx, b); ctx.ellipse(l + rx, b - ry, rx, ry, 0, P / 2, P);
      ctx.lineTo(l, t + ry); ctx.ellipse(l + rx, t + ry, rx, ry, 0, P, 1.5 * P); ctx.closePath();
    });
  }
  /** drawArc(RectF oval, startAngle, sweepAngle, useCenter, paint) | (l, t, r, b, start, sweep, useCenter, paint); degrees clockwise from 3 o'clock. */
  drawArc(l, t, r, b, start, sweep, useCenter, paint) {
    if (typeof l === 'object') { paint = start; useCenter = b; sweep = r; start = t; ({ left: l, top: t, right: r, bottom: b } = l); }
    if (r <= l || b <= t || sweep === 0) return;
    const cx = (l + r) / 2, cy = (t + b) / 2, rx = (r - l) / 2, ry = (b - t) / 2, rad = Math.PI / 180;
    const full = Math.abs(sweep) >= 360, a0 = start * rad, a1 = full ? a0 + Math.sign(sweep) * 2 * Math.PI : (start + sweep) * rad;
    this._shape(paint, [l, t, r, b], ctx => {
      if (useCenter && !full) ctx.moveTo(cx, cy);
      ctx.ellipse(cx, cy, rx, ry, 0, a0, a1, sweep < 0);
      if (useCenter && !full) ctx.closePath();
    });
  }
  drawOval(l, t, r, b, paint) { if (typeof l === 'object') { paint = t; ({ left: l, top: t, right: r, bottom: b } = l); } this.drawArc(l, t, r, b, 0, 360, false, paint); }
  /** Fills and/or strokes the path built by `build(ctx)` according to paint.style. */
  _shape(paint, bounds, build) {
    const sw = paint.style === 'FILL' ? 0 : Math.max(paint.strokeWidth, 1);
    this._vector([bounds[0] - sw, bounds[1] - sw, bounds[2] + sw, bounds[3] + sw], ctx => {
      ctx.beginPath(); build(ctx);
      if (paint.style !== 'STROKE') { paint._apply(ctx, false); ctx.fill(); }
      if (paint.style !== 'FILL') { paint._apply(ctx, true); ctx.stroke(); }
    });
  }
  drawLine(x0, y0, x1, y1, paint) {
    const w = paint.strokeWidth || 1;
    this._vector([Math.min(x0, x1) - w, Math.min(y0, y1) - w, Math.max(x0, x1) + w, Math.max(y0, y1) + w], ctx => {
      paint._apply(ctx, true); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    });
  }
  drawLines(pts, paint) { for (let i = 0; i + 3 < pts.length; i += 4) this.drawLine(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], paint); }
  drawCircle(cx, cy, radius, paint) { if (radius > 0) this._shape(paint, [cx - radius, cy - radius, cx + radius, cy + radius], ctx => ctx.arc(cx, cy, radius, 0, Math.PI * 2)); }
  /** drawText(text, x, y, paint) | drawText(text, start, end, x, y, paint); y is the baseline. */
  drawText(text, a, b, c, d, e) {
    let s = String(text), x, y, paint;
    if (e !== undefined) { s = s.substring(a, b); x = c; y = d; paint = e; } else { x = a; y = b; paint = c; }
    if (!s.length) return;
    const size = paint.textSize, width = paint.measureText(s), ox = paint.textAlign === 'center' ? width / 2 : paint.textAlign === 'right' ? width : 0;
    this._vector([x - ox - size, y - size * 1.6, x - ox + width + size, y + size * 0.8], ctx => {
      ctx.font = paint._css(); paint._apply(ctx, false); ctx.textBaseline = 'alphabetic'; ctx.textAlign = paint.textAlign; ctx.fillText(s, x, y);
    });
  }
  /** Rasterises vector drawing (local coords) with the canvas factory on a transient canvas and composites it. */
  _vector(localBounds, draw) {
    const dev = new RectF(...localBounds); this.m.mapRect(dev);
    const x0 = Math.max(this.clip[0], Math.floor(dev.left)), y0 = Math.max(this.clip[1], Math.floor(dev.top)), x1 = Math.min(this.clip[2], Math.ceil(dev.right)), y1 = Math.min(this.clip[3], Math.ceil(dev.bottom));
    if (x0 >= x1 || y0 >= y1) return;
    if (!this.m.isAffine()) throw new UnsupportedOperationException('vector drawing with a perspective canvas matrix');
    // iOS Safari refuses canvases above MAX_CANVAS_PIXELS (16.7 MP; a 48 MP photo would fail): only then the drawing
    // is rasterised in tiles of at most VECTOR_TILE² pixels (anti-aliased edges may differ by a few levels from
    // one canvas). Up to the limit it is one canvas, exactly as before.
    if ((x1 - x0) * (y1 - y0) <= MAX_CANVAS_PIXELS) { this._vectorTile(x0, y0, x1, y1, draw); return; }
    for (let ty = y0; ty < y1; ty += VECTOR_TILE) for (let tx = x0; tx < x1; tx += VECTOR_TILE) this._vectorTile(tx, ty, Math.min(x1, tx + VECTOR_TILE), Math.min(y1, ty + VECTOR_TILE), draw);
  }
  _vectorTile(x0, y0, x1, y1, draw) {
    const w = x1 - x0, h = y1 - y0, cv = getCanvasFactory().createCanvas(w, h);
    try {
      const ctx = cv.getContext('2d'), v = this.m.v;
      ctx.setTransform(v[0], v[3], v[1], v[4], v[2] - x0, v[5] - y0); draw(ctx);
      const src = ctx.getImageData(0, 0, w, h).data, d = this.bitmap.data, W = this.bitmap.width;
      for (let yy = 0; yy < h; yy++) for (let xx = 0, si = yy * w * 4, di = ((y0 + yy) * W + x0) * 4; xx < w; xx++, si += 4, di += 4) {
        const sa = src[si + 3]; if (sa === 0) continue;
        const a = sa / 255; blendPixel(d, di, src[si] * a, src[si + 1] * a, src[si + 2] * a, a);
      }
    } finally { release(cv); }
  }
}
/** Largest side of one vector-drawing tile when a drawing exceeds MAX_CANVAS_PIXELS (2048² = 4.2 MP). */
let VECTOR_TILE = 2048;
/** Tests: another tile side (null restores 2048). */
export function setVectorTileForTesting(n) { VECTOR_TILE = n ?? 2048; }
/** src-over of a premultiplied source (pr, pg, pb in 0..255 scale, pa in 0..1) onto a stored pixel. */
function blendPixel(d, i, pr, pg, pb, pa) {
  if (pa >= 1) { d[i] = Math.round(pr); d[i + 1] = Math.round(pg); d[i + 2] = Math.round(pb); d[i + 3] = 255; return; }
  const da = d[i + 3] / 255, k = 1 - pa, oa = pa + da * k;
  if (oa <= 0) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; return; }
  d[i] = Math.round((pr + d[i] * da * k) / oa); d[i + 1] = Math.round((pg + d[i + 1] * da * k) / oa); d[i + 2] = Math.round((pb + d[i + 2] * da * k) / oa); d[i + 3] = Math.round(oa * 255);
}
/**
 * Draws `bmp` restricted to `domain` [x0,y0,x1,y1] (bitmap coords) through matrix `m` into the canvas.
 * Translate-only matrices are blitted exactly at the rounded offset (Skia's sprite path for non-AA paints).
 */
function drawMapped(canvas, bmp, m, domain, paint) {
  const v = m.v, aa = paint ? paint.isAntiAlias() : false, filter = paint ? paint.isFilterBitmap() : false, alpha = paint ? paint.getAlpha() / 255 : 1;
  const dst = canvas.bitmap.data, W = canvas.bitmap.width, S = bmp.data, sw = bmp.width, sh = bmp.height;
  const [cx0, cy0, cx1, cy1] = canvas.clip; if (cx0 >= cx1 || cy0 >= cy1) return;
  const [dx0, dy0, dx1, dy1] = domain;
  if (m._isTranslate()) {
    const tx = v[2], ty = v[5], fx = tx - Math.floor(tx + 0.5), fy = ty - Math.floor(ty + 0.5);
    if (!aa || (Math.abs(fx) < 1 / 32 && Math.abs(fy) < 1 / 32)) {
      const ix = Math.floor(tx + 0.5), iy = Math.floor(ty + 0.5);
      const X0 = Math.max(cx0, dx0 + ix), Y0 = Math.max(cy0, dy0 + iy), X1 = Math.min(cx1, dx1 + ix), Y1 = Math.min(cy1, dy1 + iy);
      for (let y = Y0; y < Y1; y++) {
        let si = ((y - iy) * sw + (X0 - ix)) * 4, di = (y * W + X0) * 4;
        if (alpha === 1) for (let x = X0; x < X1; x++, si += 4, di += 4) { const a = S[si + 3]; if (a === 255) { dst[di] = S[si]; dst[di + 1] = S[si + 1]; dst[di + 2] = S[si + 2]; dst[di + 3] = 255; } else if (a !== 0) { const f = a / 255; blendPixel(dst, di, S[si] * f, S[si + 1] * f, S[si + 2] * f, f); } }
        else for (let x = X0; x < X1; x++, si += 4, di += 4) { const f = S[si + 3] / 255 * alpha; if (f > 0) blendPixel(dst, di, S[si] * f, S[si + 1] * f, S[si + 2] * f, f); }
      }
      return;
    }
  }
  const inverse = new Matrix(); if (!m.invert(inverse)) return;
  const iv = Float64Array.from(inverse.v);
  const corners = [dx0, dy0, dx1, dy0, dx1, dy1, dx0, dy1];
  // A perspective whose w changes sign inside the drawn domain (its horizon crosses the bitmap: a cell matrix of a
  // tilted photo composed with the whole-photo transform) has no finite image of the domain's corners; the whole
  // clip is then searched and a pixel is kept only when its inverse lands inside the domain on the visible side of the
  // horizon: the inverse's homogeneous w is 1 / the forward w, and Skia clips perspective drawing to forward w > 0.
  let wPos = 0, wNeg = 0; for (let i = 0; i < 8; i += 2) { const w = v[6] * corners[i] + v[7] * corners[i + 1] + v[8]; if (w > 0) wPos++; else wNeg++; }
  m.mapPoints(corners); const horizon = wPos > 0 && wNeg > 0;
  const bx0 = horizon ? cx0 : Math.max(cx0, Math.floor(Math.min(corners[0], corners[2], corners[4], corners[6]))), by0 = horizon ? cy0 : Math.max(cy0, Math.floor(Math.min(corners[1], corners[3], corners[5], corners[7])));
  const bx1 = horizon ? cx1 : Math.min(cx1, Math.ceil(Math.max(corners[0], corners[2], corners[4], corners[6]))), by1 = horizon ? cy1 : Math.min(cy1, Math.ceil(Math.max(corners[1], corners[3], corners[5], corners[7])));
  if (bx0 >= bx1 || by0 >= by1) return;
  const inside = (X, Y) => { const w = iv[6] * X + iv[7] * Y + iv[8]; if (horizon && !(w > 0)) return false; const u = (iv[0] * X + iv[1] * Y + iv[2]) / w, t = (iv[3] * X + iv[4] * Y + iv[5]) / w; return u >= dx0 && u < dx1 && t >= dy0 && t < dy1; };
  const gw = bx1 - bx0 + 1; let grid = null;
  if (aa) { grid = new Uint8Array(gw * (by1 - by0 + 1)); for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) grid[(y - by0) * gw + (x - bx0)] = inside(x, y) ? 1 : 0; }
  const px = new Float64Array(4);
  for (let y = by0; y < by1; y++) {
    const Y = y + 0.5;
    for (let x = bx0; x < bx1; x++) {
      const X = x + 0.5, w = iv[6] * X + iv[7] * Y + iv[8];
      const u = (iv[0] * X + iv[1] * Y + iv[2]) / w, t = (iv[3] * X + iv[4] * Y + iv[5]) / w;
      let cov; const centre = (!horizon || w > 0) && u >= dx0 && u < dx1 && t >= dy0 && t < dy1;
      if (aa) {
        const g = (y - by0) * gw + (x - bx0), s = grid[g] + grid[g + 1] + grid[g + gw] + grid[g + gw + 1];
        if (s === 4 && centre) cov = 1; else if (s === 0 && !centre) cov = 0;
        else { let n = 0; for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) if (inside(x + (k + 0.5) / 4, y + (j + 0.5) / 4)) n++; cov = n / 16; }
      } else cov = centre ? 1 : 0;
      if (cov === 0) continue;
      if (filter) {
        const fu = u - 0.5, fv = t - 0.5, ix = Math.floor(fu), iy = Math.floor(fv), ax = fu - ix, ay = fv - iy;
        const x0 = ix < 0 ? 0 : ix >= sw ? sw - 1 : ix, x1 = ix + 1 < 0 ? 0 : ix + 1 >= sw ? sw - 1 : ix + 1;
        const y0 = iy < 0 ? 0 : iy >= sh ? sh - 1 : iy, y1 = iy + 1 < 0 ? 0 : iy + 1 >= sh ? sh - 1 : iy + 1;
        const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
        const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
        const a00 = S[i00 + 3] / 255, a10 = S[i10 + 3] / 255, a01 = S[i01 + 3] / 255, a11 = S[i11 + 3] / 255;
        px[3] = w00 * a00 + w10 * a10 + w01 * a01 + w11 * a11;
        for (let ch = 0; ch < 3; ch++) px[ch] = w00 * S[i00 + ch] * a00 + w10 * S[i10 + ch] * a10 + w01 * S[i01 + ch] * a01 + w11 * S[i11 + ch] * a11;
      } else {
        let ix = Math.floor(u), iy = Math.floor(t); ix = ix < 0 ? 0 : ix >= sw ? sw - 1 : ix; iy = iy < 0 ? 0 : iy >= sh ? sh - 1 : iy;
        const i = (iy * sw + ix) * 4, a = S[i + 3] / 255; px[0] = S[i] * a; px[1] = S[i + 1] * a; px[2] = S[i + 2] * a; px[3] = a;
      }
      const k = cov * alpha; if (px[3] * k <= 0) continue;
      const di = (y * W + x) * 4;
      if (k === 1 && px[3] >= 0.9999995) { dst[di] = Math.round(px[0]); dst[di + 1] = Math.round(px[1]); dst[di + 2] = Math.round(px[2]); dst[di + 3] = 255; }
      else blendPixel(dst, di, px[0] * k, px[1] * k, px[2] * k, px[3] * k);
    }
  }
}

// ------------------------------------------------------------------ EXIF (androidx.exifinterface subset)
/** Locates the Orientation entry of a JPEG's Exif APP1 segment: {pos, little} of the SHORT value, or null. */
function findOrientation(b) {
  if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null;
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xFF) return null;
    const marker = b[p + 1]; if (marker === 0xD9 || marker === 0xDA) return null;
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0xFF) { p += marker === 0xFF ? 1 : 2; continue; }
    const len = (b[p + 2] << 8) | b[p + 3]; const seg = p + 4;
    if (marker === 0xE1 && len >= 8 && b[seg] === 0x45 && b[seg + 1] === 0x78 && b[seg + 2] === 0x69 && b[seg + 3] === 0x66 && b[seg + 4] === 0 && b[seg + 5] === 0) {
      const t = seg + 6, end = p + 2 + len; const little = b[t] === 0x49 && b[t + 1] === 0x49; if (!little && !(b[t] === 0x4D && b[t + 1] === 0x4D)) return null;
      const u16 = o => (o + 2 > end ? -1 : little ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
      const u32 = o => (o + 4 > end ? -1 : little ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
      if (u16(t + 2) !== 42) return null;
      const ifd = t + u32(t + 4), n = u16(ifd); if (n < 0) return null;
      for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (e + 12 > end) return null; if (u16(e) === 0x0112) return u16(e + 2) === 3 ? { pos: e + 8, little, value: u16(e + 8) } : null; }
      return null;
    }
    p += 2 + len;
  }
  return null;
}
/** Copy of the JPEG bytes with Orientation forced to 1, so browsers decode raw pixels like BitmapFactory. */
export function stripExifOrientation(bytes) {
  const o = findOrientation(bytes); if (!o || o.value === 1) return bytes;
  const c = bytes.slice(); if (o.little) { c[o.pos] = 1; c[o.pos + 1] = 0; } else { c[o.pos] = 0; c[o.pos + 1] = 1; } return c;
}
/** androidx.exifinterface.media.ExifInterface (Orientation of JPEG files). Accepts File, path, InputStream or bytes. */
export class ExifInterface {
  static TAG_ORIENTATION = 'Orientation';
  static ORIENTATION_UNDEFINED = 0; static ORIENTATION_NORMAL = 1; static ORIENTATION_FLIP_HORIZONTAL = 2; static ORIENTATION_ROTATE_180 = 3; static ORIENTATION_FLIP_VERTICAL = 4; static ORIENTATION_TRANSPOSE = 5; static ORIENTATION_ROTATE_90 = 6; static ORIENTATION_TRANSVERSE = 7; static ORIENTATION_ROTATE_270 = 8;
  constructor(src) {
    if (src == null) throw new NullPointerException();
    const bytes = src instanceof Uint8Array ? src : src instanceof InputStream ? src.readAllBytes() : new FileInputStream(src instanceof File ? src : new File(String(src))).readAllBytes();
    const o = findOrientation(bytes); this.orientation = o ? o.value : null;
  }
  getAttribute(tag) { return tag === 'Orientation' && this.orientation != null ? String(this.orientation) : null; }
  getAttributeInt(tag, defaultValue) { return tag === 'Orientation' && this.orientation != null ? this.orientation : defaultValue; }
  getRotationDegrees() { switch (this.getAttributeInt('Orientation', 1)) { case 6: case 7: return 90; case 3: case 4: return 180; case 8: case 5: return 270; default: return 0; } }
  isFlipped() { const o = this.getAttributeInt('Orientation', 1); return o === 2 || o === 7 || o === 4 || o === 5; }
}

// ------------------------------------------------------------------ BitmapFactory
class Options {
  constructor() { this.inJustDecodeBounds = false; this.inSampleSize = 1; this.inMutable = false; this.inPreferredConfig = Config.ARGB_8888; this.outWidth = 0; this.outHeight = 0; this.outMimeType = null; }
}
/** Image size and MIME type from the file header (PNG, JPEG, GIF, BMP, WebP), or null. */
function sniff(b) {
  const be16 = o => (b[o] << 8) | b[o + 1], be32 = o => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0, le16 = o => b[o] | (b[o + 1] << 8), le32 = o => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24));
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return { w: be32(16), h: be32(20), mime: 'image/png' };
  if (b.length >= 4 && b[0] === 0xFF && b[1] === 0xD8) {
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xFF) return null; const m = b[p + 1];
      if (m === 0xFF) { p++; continue; } if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { p += 2; continue; }
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { w: be16(p + 7), h: be16(p + 5), mime: 'image/jpeg' };
      if (m === 0xD9 || m === 0xDA) return null; p += 2 + be16(p + 2);
    }
    return null;
  }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { w: le16(6), h: le16(8), mime: 'image/gif' };
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4D) return { w: Math.abs(le32(18)), h: Math.abs(le32(22)), mime: 'image/bmp' };
  if (b.length >= 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === 'VP8 ') return { w: le16(26) & 0x3FFF, h: le16(28) & 0x3FFF, mime: 'image/webp' };
    if (kind === 'VP8L') { const v = le32(21); return { w: (v & 0x3FFF) + 1, h: ((v >> 14) & 0x3FFF) + 1, mime: 'image/webp' }; }
    if (kind === 'VP8X') return { w: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1, h: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1, mime: 'image/webp' };
  }
  return null;
}
async function decodeBytes(bytes, opts) {
  if (opts) { opts.outWidth = -1; opts.outHeight = -1; opts.outMimeType = null; }
  const head = sniff(bytes);
  if (opts && opts.inJustDecodeBounds) {
    if (head) { opts.outWidth = head.w; opts.outHeight = head.h; opts.outMimeType = head.mime; return null; }
    try { const src = await getCanvasFactory().loadImage(bytes); opts.outWidth = src.width; opts.outHeight = src.height; if (src.close) src.close(); } catch { /* undecodable */ }
    return null;
  }
  const jpeg = head?.mime === 'image/jpeg';
  let s = opts ? opts.inSampleSize | 0 : 1; s = s > 1 ? 1 << (31 - Math.clz32(s)) : 1;
  let img;
  try { img = await rasterize(getCanvasFactory(), jpeg ? stripExifOrientation(bytes) : bytes, s, jpeg); } catch { return null; }
  if (!img) return null;
  if (opts) { opts.outWidth = img.width; opts.outHeight = img.height; opts.outMimeType = head?.mime ?? null; }
  return new Bitmap(img.width, img.height, img.data, !!(opts && opts.inMutable));
}
/** android.graphics.BitmapFactory; every decode is async and resolves to a Bitmap or null (like Android). */
export const BitmapFactory = {
  Options,
  async decodeFile(pathName, opts) {
    let bytes; try { bytes = new FileInputStream(pathName instanceof File ? pathName : new File(String(pathName))).readAllBytes(); } catch { if (opts) { opts.outWidth = -1; opts.outHeight = -1; } return null; }
    return decodeBytes(bytes, opts);
  },
  async decodeByteArray(data, offset = 0, length = data.length - offset, opts) {
    if ((offset | length) < 0 || data.length < offset + length) throw new ArrayIndexOutOfBoundsException();
    return decodeBytes(data.subarray(offset, offset + length), opts);
  },
  async decodeStream(input, outPadding, opts) { if (input == null) return null; return decodeBytes(input.readAllBytes(), opts); },
};
