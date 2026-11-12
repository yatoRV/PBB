// Port of vn.lichdilam.CellReader (APK 4.5). ONNX runs through js/platform/onnx.js, so open/read/probabilities are
// async; prepare() stays synchronous. float[] → Float32Array; Java float math via Math.fround, double where Java
// uses double. Web: the ONNX session of each model folder is created once per page and shared by every reader
// opened on it (iPhone memory); close() therefore leaves the shared session loaded.
import { Float, javaThrowableToString, split, trim, utf8Decode } from '../platform/java.js';
import { Log } from '../platform/log.js';
import { createSession, run } from '../platform/onnx.js';

const f = Math.fround;
const H = 32, W = 48, DIR = 'cells';
/** Model folder → Promise of { session, labels, threshold } (a failed load is forgotten so a later open retries). */
const loaded = new Map();

function readAll(input) { try { return input.readAllBytes(); } finally { input.close(); } }
async function load(context, dir) {
  const model = await readAll(await context.getAssets().open(dir + '/cells.onnx'));
  // One label per line; a file saved on Windows ends its lines with \r\n ("C23\r" must still be C23).
  const labels = []; for (const l of split(utf8Decode(await readAll(await context.getAssets().open(dir + '/labels.txt'))), /\r?\n/)) if (trim(l) !== '') labels.push(trim(l));
  const threshold = Float.parseFloat(trim(utf8Decode(await readAll(await context.getAssets().open(dir + '/threshold.txt')))));
  return { session: await createSession(model), labels: Object.freeze(labels), threshold };
}

/** Cell reader trained on the user's work roster (3.0, phase 2): a small CNN that names the code of one day cell.
 *  It only answers for cells every OCR pass left unread, and only above the threshold at which it made no wrong
 *  answer for people it had never seen (scripts/cells/train_cells.py); otherwise the cell stays "?".
 *  The preprocessing is the training script's, step for step. Unavailable → null, as before. */
export class CellReader {
  static H = H; static W = W;
  constructor(session, labels, threshold) { this._session = session; this.labels = labels; this.threshold = threshold; }
  /** open(context[, dir]) — dir: "cells" (work-roster shift codes) or "pipes" (pipe numbers of the pipe sheets,
   *  3.0 phase 3). Resolves to null when the model cannot be loaded. */
  static async open(context, dir = DIR) {
    try {
      let model = loaded.get(dir); if (model == null) { model = load(context, dir); loaded.set(dir, model); }
      try { const m = await model; return new CellReader(m.session, m.labels, m.threshold); } catch (failed) { if (loaded.get(dir) === model) loaded.delete(dir); throw failed; }
    } catch (unavailable) { Log.w('CellReader', 'cell reader unavailable: ' + javaThrowableToString(unavailable)); return null; }
  }
  /** The cell's code ("" for OFF) when the model is sure enough, else null. */
  async read(cell) {
    const p = await this.probabilities(cell); if (p == null) return null; let best = 0; for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
    if (p[best] < this.threshold) return null; const label = this.labels[best]; return label === 'OFF' ? '' : label;
  }
  /** Softmax over the labels, or null for a cell too small to read. */
  async probabilities(cell) {
    const x = CellReader.prepare(cell); if (x == null) return null;
    const r = await run(this._session, { cell: { type: 'float32', data: x, dims: [1, 1, H, W] } });
    const logits = r[this._session.outputNames[0]].data; let max = -Infinity; for (const v of logits) max = Math.max(max, v);
    let sum = 0; for (const v of logits) sum += Math.exp(f(v - max)); const p = new Float32Array(logits.length); for (let i = 0; i < p.length; i++) p[i] = Math.exp(f(logits[i] - max)) / sum; return p;
  }
  /** Grey (R·30+G·59+B·11)/100, bilinear at pixel centres to 48×32, then (v − mean) / (std + 8). A cell more than
   *  twice as wide as high (a photo of half the month: 15 wide day columns, 26/10) is first cut to its middle
   *  1.6 heights, the shape of a full month's cell, so the code is not squeezed; same as train_cells.py. */
  static prepare(cell) {
    const w = cell.getWidth(), h = cell.getHeight(); if (w < 4 || h < 4) return null; const px = new Int32Array(w * h); cell.getPixels(px, 0, w, 0, 0, w, h);
    const g = new Float32Array(w * h); for (let i = 0; i < g.length; i++) { const c = px[i]; g[i] = (((c >> 16) & 255) * 30 + ((c >> 8) & 255) * 59 + (c & 255) * 11) / 100; }
    let cw = w, left = 0; if (w > 2 * h) { cw = ((16 * h + 5) / 10) | 0; left = ((w - cw) / 2) | 0; }
    const v = new Float32Array(H * W); let sum = 0;
    for (let y = 0; y < H; y++) {
      const sy = Math.max(0, Math.min(h - 1, f(f(f(f(y + f(.5)) * h) / H) - f(.5)))); const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, h - 1); const fy = f(sy - y0);
      for (let x = 0; x < W; x++) {
        const sx = Math.max(0, Math.min(cw - 1, f(f(f(f(x + f(.5)) * cw) / W) - f(.5)))); let x0 = Math.floor(sx), x1 = Math.min(x0 + 1, cw - 1); const fx = f(sx - x0); x0 += left; x1 += left;
        const a = f(1 - fy), b = f(1 - fx);
        const val = f(f(f(f(f(g[y0 * w + x0] * a) * b) + f(f(g[y0 * w + x1] * a) * fx)) + f(f(g[y1 * w + x0] * fy) * b)) + f(f(g[y1 * w + x1] * fy) * fx)); v[y * W + x] = val; sum += val;
      }
    }
    const mean = sum / v.length; let variance = 0; for (const val of v) variance += (val - mean) * (val - mean); const std = Math.sqrt(variance / v.length);
    for (let i = 0; i < v.length; i++) v[i] = (v[i] - mean) / (std + 8);
    return v;
  }
  close() { /* the shared session stays loaded for the next reader (see the file header) */ }
}
