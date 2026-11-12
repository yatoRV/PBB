// Port of vn.lichdilam.ColumnShift (APK 4.5). float[] → Float32Array, Java float math via Math.fround,
// the least-squares fit stays in double as in Java.
import { roundF, Float } from '../platform/java.js';

const f = Math.fround;
const NONE = n => new Float32Array(n);

/** Where the vertical rules of the day columns really are inside one band of rows (3.0). The column positions of
 *  the work roster are found once for the whole table; at the top of a bent or tilted page the printed rules can
 *  sit half a cell away from them (25/10 photo, rows 1–4: "HC" read as "cH", an "H" taken from the next day).
 *  Every rule of the band is searched within ±45 % of its cell width — never as far as a neighbouring rule — and
 *  one straight line (offset + slope across the row) is fitted through the rules that agree. Pure Java (grey
 *  pixels), so it is measured on the JVM. Returns 0 for every boundary when the band gives no clear evidence. */
export class ColumnShift {
  static REACH = f(.45); static OUTLIER = f(.15); static MIN_CONTRAST = 20; static MIN_GAIN = 6;
  static offsets(gray, width, height, x, top, bottom) {
    const n = x.length; const none = NONE(n); if (n < 8 || bottom - top < 4) return none;
    const spacing = new Float32Array(n); const all = [];
    for (let b = 2; b < n; b++) { spacing[b] = b < n - 1 ? f(x[b + 1] - x[b]) : f(x[b] - x[b - 1]); if (b > 2) spacing[b] = Math.min(spacing[b], f(x[b] - x[b - 1])); all.push(spacing[b]); }
    all.sort(Float.compare); const typical = all[all.length >> 1]; if (typical < 6) return none;
    const found = new Float32Array(n); const usable = new Array(n).fill(false); const profiles = new Array(n).fill(null); const reach = new Int32Array(n);
    for (let b = 2; b < n; b++) {
      const r = Math.max(2, roundF(f(spacing[b] * ColumnShift.REACH))); reach[b] = r; const p = new Float32Array(2 * r + 1);
      for (let dx = -r; dx <= r; dx++) { const xx = roundF(x[b]) + dx; if (xx < 0 || xx >= width) { p[dx + r] = 255; continue; } let sum = 0; for (let yy = top; yy < bottom; yy++) sum += gray[yy * width + xx]; p[dx + r] = f(f(sum) / (bottom - top)); }
      profiles[b] = p; let best = 0; for (let i = 1; i < p.length; i++) if (p[i] < p[best]) best = i;
      const sorted = p.slice().sort(); const median = sorted[sorted.length >> 1];
      usable[b] = f(median - p[best]) >= ColumnShift.MIN_CONTRAST; found[b] = best - r;
    }
    // Least squares offset = a + c·(x − mid), twice, dropping rules that disagree with the line.
    const mid = f(f(x[2] + x[n - 1]) / 2); let a = 0, c = 0; const inside = usable.slice();
    const limit = Math.max(f(1.5), f(typical * ColumnShift.OUTLIER));
    for (let pass = 0; pass < 3; pass++) {
      let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let b = 2; b < n; b++) if (inside[b]) { const u = f(x[b] - mid); sw++; sx += u; sy += found[b]; sxx += u * u; sxy += u * found[b]; }
      if (sw < Math.max(6, (n - 2) * .4)) return none; const det = sw * sxx - sx * sx;
      if (Math.abs(det) < 1e-6) { a = sy / sw; c = 0; } else { c = (sw * sxy - sx * sy) / det; a = (sy - c * sx) / sw; }
      for (let b = 2; b < n; b++) if (usable[b]) inside[b] = Math.abs(found[b] - (a + c * f(x[b] - mid))) <= limit;
    }
    const out = new Float32Array(n); let gain = 0, counted = 0;
    for (let b = 2; b < n; b++) {
      let o = f(a + c * f(x[b] - mid)); o = Math.max(-reach[b], Math.min(reach[b], o)); out[b] = o;
      if (inside[b]) { const r = reach[b]; gain += f(profiles[b][r] - profiles[b][roundF(o) + r]); counted++; }
    }
    // Move only when the rules at the fitted place are clearly darker than at the global place.
    if (counted === 0 || gain / counted < ColumnShift.MIN_GAIN) return none;
    return out;
  }
}
