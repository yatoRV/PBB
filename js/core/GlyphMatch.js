// Port of vn.lichdilam.GlyphMatch (APK 4.5). float[] → Float32Array; Java float arithmetic is reproduced
// with Math.fround wherever a float feeds a comparison or the output; int division with idiv.
import { idiv, roundF } from '../platform/java.js';

const f = Math.fround;
const W = 40, H = 20;

function otsu(hist, n) {
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i]; let sumB = 0, best = -1; let wB = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (wB === 0) continue; const wF = n - wB; if (wF === 0) break; sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; t = i; }
  }
  return t;
}
function percentile(hist, n, p) { let k = 0; const limit = f(n * p); for (let i = 0; i < 256; i++) { k += hist[i]; if (f(k) >= limit) return i; } return 255; }

class Result { constructor(value, best, second) { this.value = value; this.best = best; this.second = second; } }

/** Compares the printed text of one cell with cells of the same photo whose value OCR already confirmed.
 *  The same typeface, size, blur and lighting make those cells the best possible templates for a value that
 *  OCR could not read (a thin "11" or a lone "9"). Pure Java on grey pixels, so it is measured on the JVM. */
export class GlyphMatch {
  static W = W; static H = H;
  static Result = Result;
  /** Normalised ink image of a cell (W×H, ink = 1), or null when the cell holds no ink. */
  static signature(argb, width, height) {
    if (width < 8 || height < 8) return null;
    const g = new Int32Array(width * height); for (let i = 0; i < g.length; i++) { const c = argb[i]; g[i] = idiv(((c >> 16) & 255) * 30 + ((c >> 8) & 255) * 59 + (c & 255) * 11, 100); }
    // Ignore the outer band where ruling lines of the table remain.
    const mx = Math.max(1, idiv(width * 8, 100)), my = Math.max(1, idiv(height * 12, 100));
    const hist = new Int32Array(256); let n = 0; for (let y = my; y < height - my; y++) for (let x = mx; x < width - mx; x++) { hist[g[y * width + x]]++; n++; }
    let t = otsu(hist, n); const paper = percentile(hist, n, f(0.75)); if (paper - t < 25) t = paper - 25;
    let x0 = width, x1 = -1, y0 = height, y1 = -1;
    for (let y = my; y < height - my; y++) for (let x = mx; x < width - mx; x++) if (g[y * width + x] <= t) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    if (x1 < 0) return null; const bw = x1 - x0 + 1, bh = y1 - y0 + 1; if (bh < idiv(height, 6) || bw * bh < 12) return null;
    const scale = f(H / bh); const sw = Math.min(W, Math.max(1, roundF(f(bw * scale)))), off = idiv(W - sw, 2); const out = new Float32Array(W * H);
    const denom = f(Math.max(1, paper - Math.min(t, paper - 1)));
    for (let y = 0; y < H; y++) for (let x = 0; x < sw; x++) {
      const sx = f(f(x0 + f(f(x + f(0.5)) / scale)) - f(0.5)), sy = f(f(y0 + f(f(y + f(0.5)) / scale)) - f(0.5));
      const ix = Math.max(x0, Math.min(x1, roundF(sx))), iy = Math.max(y0, Math.min(y1, roundF(sy)));
      const ink = f((paper - g[iy * width + ix]) / denom); out[y * W + off + x] = Math.max(0, Math.min(1, ink));
    }
    return out;
  }
  /** Pearson correlation of two signatures, in [-1,1]. */
  static similarity(a, b) {
    let ma = 0, mb = 0; for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; } ma /= a.length; mb /= b.length; let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; } return da <= 0 || db <= 0 ? 0 : f(num / Math.sqrt(da * db));
  }
  /** Best value among the confirmed examples (value → signatures): the mean of each value's top three
   *  similarities. Accepted only with a high score and a clear margin over every other value, else null.
   *  examples: a Map or JavaHashMap (iteration order decides ties, as in Java). */
  static classify(cell, examples, minScore, minMargin) {
    if (cell == null) return null; let bestValue = null; let best = -2, second = -2;
    for (const [key, list] of examples) {
      if (list.length < 2) continue;
      const s = []; for (const x of list) s.push(GlyphMatch.similarity(cell, x)); s.sort((p, q) => q - p);
      let score = 0; const k = Math.min(3, s.length); for (let i = 0; i < k; i++) score = f(score + s[i]); score = f(score / k);
      if (score > best) { second = best; best = score; bestValue = key; } else if (score > second) second = score;
    }
    return bestValue != null && best >= minScore && f(best - second) >= minMargin ? new Result(bestValue, best, second) : null;
  }
}
