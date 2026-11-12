// Synthetic text images (Task A3), drawn in code with a stroke font and plain arithmetic, so every device gets the very
// same pixels: no canvas, no system font, no real name or photo. Used by the WebGPU self-check (js/ocr/webgpu-check.js:
// the results of these images on WebGPU must equal the stored WASM results) and by the public speed page bench.html.
// Only + − × ÷, Math.sqrt / floor / round / min / max (correctly rounded in every JavaScript engine) are used.

/** Stroke glyphs on a 4 × 6 grid (x right, y down, cap height 6): polylines. */
const O = [[1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0]];
const P = [[0, 6], [0, 0], [3, 0], [4, 1], [4, 2.5], [3, 3.5], [0, 3.5]];
const GLYPHS = {
  0: [O, [[3.6, 1.2], [0.4, 4.8]]], 1: [[[1, 1.2], [2, 0], [2, 6]], [[1, 6], [3, 6]]], 2: [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [0, 6], [4, 6]]],
  3: [[[0, 0], [4, 0], [2, 2.5], [3, 2.5], [4, 3.5], [4, 5], [3, 6], [1, 6], [0, 5]]], 4: [[[3, 6], [3, 0], [0, 4], [4, 4]]],
  5: [[[4, 0], [0, 0], [0, 2.5], [3, 2.5], [4, 3.5], [4, 5], [3, 6], [0, 6]]], 6: [[[3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 3.5], [3, 2.5], [0, 2.5]]],
  7: [[[0, 0], [4, 0], [1.5, 6]]], 8: [[[1, 0], [3, 0], [4, 1], [4, 2], [3, 3], [1, 3], [0, 4], [0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3]], [[1, 3], [0, 2], [0, 1], [1, 0]]],
  9: [[[4, 3.5], [1, 3.5], [0, 2.5], [0, 1], [1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6]]],
  A: [[[0, 6], [2, 0], [4, 6]], [[0.7, 4], [3.3, 4]]], B: [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]], [[0, 0], [3, 0], [4, 1], [4, 2], [3, 3]]],
  C: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5]]], D: [[[0, 0], [0, 6], [2.5, 6], [4, 4.5], [4, 1.5], [2.5, 0], [0, 0]]],
  E: [[[4, 0], [0, 0], [0, 6], [4, 6]], [[0, 3], [3, 3]]], F: [[[4, 0], [0, 0], [0, 6]], [[0, 3], [3, 3]]],
  G: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 3.5], [2.5, 3.5]]], H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
  I: [[[1, 0], [3, 0]], [[2, 0], [2, 6]], [[1, 6], [3, 6]]], J: [[[4, 0], [4, 5], [3, 6], [1, 6], [0, 5]]],
  K: [[[0, 0], [0, 6]], [[4, 0], [0, 3.5]], [[1.3, 2.7], [4, 6]]], L: [[[0, 0], [0, 6], [4, 6]]],
  M: [[[0, 6], [0, 0], [2, 3.5], [4, 0], [4, 6]]], N: [[[0, 6], [0, 0], [4, 6], [4, 0]]], O: [O],
  P: [P], Q: [O, [[2.5, 4.5], [4.2, 6.2]]], R: [P, [[2, 3.5], [4, 6]]],
  S: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 2], [1, 3], [3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]]], T: [[[0, 0], [4, 0]], [[2, 0], [2, 6]]],
  U: [[[0, 0], [0, 5], [1, 6], [3, 6], [4, 5], [4, 0]]], V: [[[0, 0], [2, 6], [4, 0]]], W: [[[0, 0], [1, 6], [2, 2.5], [3, 6], [4, 0]]],
  X: [[[0, 0], [4, 6]], [[4, 0], [0, 6]]], Y: [[[0, 0], [2, 3], [4, 0]], [[2, 3], [2, 6]]], Z: [[[0, 0], [4, 0], [0, 6], [4, 6]]],
  '/': [[[3.5, 0], [0.5, 6]]], '-': [[[1, 3.2], [3, 3.2]]], '.': [[[1.8, 5.7], [2.2, 5.7]]], ':': [[[2, 1.8], [2, 2.2]], [[2, 4.8], [2, 5.2]]],
};

/** A canvas of RGBA pixels with a background, drawn into by strokes (anti-aliased by distance) and rules. */
export class SyntheticImage {
  constructor(width, height, background = 255) {
    this.width = width; this.height = height; this.bg = background;
    this.ink = new Float64Array(width * height); // coverage 0..1 → darkness
    this.tone = new Float64Array(width * height).fill(background);
  }
  /** A thick segment (half width hw px) of darkness `color` (0 = black). */
  segment(x0, y0, x1, y1, hw, color = 0) {
    const minX = Math.max(0, Math.floor(Math.min(x0, x1) - hw - 1)), maxX = Math.min(this.width - 1, Math.floor(Math.max(x0, x1) + hw + 1));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1) - hw - 1)), maxY = Math.min(this.height - 1, Math.floor(Math.max(y0, y1) + hw + 1));
    const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const px = x + .5, py = y + .5; let t = len2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / len2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - (x0 + t * dx), ey = py - (y0 + t * dy); const d = Math.sqrt(ex * ex + ey * ey);
      const c = Math.min(1, Math.max(0, hw + .5 - d)); const i = y * this.width + x;
      if (c > this.ink[i]) { this.ink[i] = c; this.tone[i] = this.bg - c * (this.bg - color); }
    }
  }
  /** Text in stroke glyphs: left/top of the first glyph, cap height h px; returns the right edge. */
  text(s, left, top, h, { color = 0, weight = .09, spacing = 1.5 } = {}) {
    const u = h / 6, hw = Math.max(.6, weight * h); let x = left;
    for (const ch of s) {
      for (const line of GLYPHS[ch] ?? []) for (let k = 1; k < line.length; k++) this.segment(x + line[k - 1][0] * u, top + line[k - 1][1] * u, x + line[k][0] * u, top + line[k][1] * u, hw, color);
      x += (4 + spacing) * u;
    }
    return x;
  }
  /** A filled rectangle of tone v (a grey cell band), under what is drawn later. */
  fill(x0, y0, x1, y1, v) { for (let y = Math.max(0, y0); y < Math.min(this.height, y1); y++) for (let x = Math.max(0, x0); x < Math.min(this.width, x1); x++) { const i = y * this.width + x; this.tone[i] = v; } }
  /** Deterministic noise of amplitude ±a (linear congruential generator). */
  noise(a, seed = 1) { let s = seed >>> 0; for (let i = 0; i < this.tone.length; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; this.tone[i] += (((s >>> 16) & 255) / 255 - .5) * 2 * a; } }
  rgba() {
    const out = new Uint8ClampedArray(this.width * this.height * 4);
    for (let i = 0; i < this.tone.length; i++) { const v = Math.round(this.tone[i]); out[4 * i] = v; out[4 * i + 1] = v; out[4 * i + 2] = v; out[4 * i + 3] = 255; }
    return out;
  }
}

const draw = (w, h, fn, bg = 255) => { const img = new SyntheticImage(w, h, bg); fn(img); return img; };
const rules = (img, xs, ys, color = 40) => { for (const x of xs) img.segment(x, 0, x, img.height, 1, color); for (const y of ys) img.segment(0, y, img.width, y, 1, color); };

/** The self-check set: shapes of the readers' calls (one cell, a cell with its rules, a strip, a grey or noisy cell,
 *  a column montage), made-up words only. */
export const SYNTHETIC_SET = Object.freeze([
  ['cell-code', () => draw(120, 52, i => i.text('D5', 34, 12, 26))],
  ['cell-rules', () => draw(150, 56, i => { rules(i, [3, 146], [2, 53]); i.text('15', 52, 14, 26); })],
  ['strip', () => draw(660, 56, i => { i.text('ONG 12', 10, 15, 24); i.text('KIEM TRA', 210, 15, 24); i.text('25/10', 500, 15, 24); })],
  ['grey-cell', () => draw(140, 56, i => { i.fill(0, 0, 140, 56, 205); i.text('S10', 30, 14, 26, { color: 60 }); }, 205)],
  ['noisy-cell', () => draw(180, 60, i => { i.text('MAU 3', 16, 16, 26); i.noise(22, 7); })],
  ['thin-small', () => draw(220, 40, i => i.text('CA 7/9', 14, 12, 16, { weight: .07 }))],
  ['column', () => draw(420, 330, i => { const w = ['TEST AN', 'MAU BINH', 'VI DU CUONG', 'KIEM TRA DUNG', 'THU EM']; w.forEach((s, k) => { i.text(String(k + 1), 14, 18 + k * 64, 26); i.text(s, 70, 18 + k * 64, 26); }); rules(i, [55], [0, 64, 128, 192, 256, 320]); })],
  ['digits', () => draw(330, 210, i => { ['1 2 3', '45 67', '890'].forEach((s, k) => i.text(s, 20, 20 + k * 64, 34)); })],
]);
/** The images of the set: [{ name, width, height, data }]. */
export function syntheticImages() { return SYNTHETIC_SET.map(([name, make]) => { const img = make(); return { name, width: img.width, height: img.height, data: img.rgba() }; }); }

/** A synthetic sheet page (bench.html, per-page time): a ruled table of `rows` × `cols` cells with codes and numbers. */
export function syntheticPage(rows = 18, cols = 8) {
  const cw = 130, ch = 50, img = new SyntheticImage(cols * cw + 4, rows * ch + 4);
  const codes = ['D5', 'S10', 'H', 'OFF', '12', '7/9', 'TEST', 'CA 3', '25/10', 'MAU'];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) img.text(codes[(r * 7 + c * 3) % codes.length], c * cw + 18, r * ch + 15, 20);
  const xs = [], ys = []; for (let c = 0; c <= cols; c++) xs.push(2 + c * cw); for (let r = 0; r <= rows; r++) ys.push(2 + r * ch); rules(img, xs, ys, 60);
  return { name: 'page', width: img.width, height: img.height, data: img.rgba() };
}
/** A bitmap of the readers' shape (js/ocr/TextRecognizer.js contract) for an image of syntheticImages(). */
export const syntheticBitmap = im => ({ data: im.data, getWidth: () => im.width, getHeight: () => im.height, isRecycled: () => false });
/** The plain form of a result compared by the self-check: every word's text and box (as tools/eval/replay compares). */
export function plainResult(r) {
  const box = b => b == null ? null : [b.left, b.top, b.right, b.bottom];
  return JSON.stringify(r.textBlocks.map(b => [box(b.boundingBox), b.lines.map(l => [box(l.boundingBox), l.elements.map(e => [e.text, box(e.boundingBox)])])]));
}
