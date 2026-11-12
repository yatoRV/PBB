// Port of vn.lichdilam.WorkColumns (APK 4.5). Java float math via Math.fround; best[] → Float32Array.
import { idiv, roundF, d2i, floatRoundPlan } from '../platform/java.js';

const f = Math.fround;

/** Fallback for work sheets where shaded columns and repeated letters imitate vertical rules. */
export class WorkColumns {
  static rules(gray, w, h) {
    const best = new Float32Array(w); const radius = Math.max(3, idiv(w, 267)), step = Math.max(2, idiv(h, 500)), top = d2i(f(h * f(.035))), bottom = d2i(f(h * f(.965)));
    // Speed-ups with the same results: (y − h/2f) and slope·(y − h/2f) are computed once (the float values Java
    // computes each time), the rounded column comes from floatRoundPlan, each sampled pixel's rule test is done once,
    // and the counts of one slope are summed for all x together (best[x] is a maximum, so the order does not matter).
    const ys = []; for (let y = top; y < bottom; y += step) ys.push(y);
    const n = ys.length, dys = new Float32Array(n); for (let k = 0; k < n; k++) dys[k] = f(ys[k] - f(h / 2));
    const rule = new Uint8Array(n * w);
    for (let k = 0; k < n; k++) { const y = ys[k], base = k * w; for (let xx = 0; xx < w; xx++) { const centre = gray[y * w + xx], left = xx - radius < 0 ? 255 : gray[y * w + xx - radius], right = xx + radius >= w ? 255 : gray[y * w + xx + radius]; rule[base + xx] = centre < 175 && centre + 14 < left && centre + 14 < right ? 1 : 0; } }
    const need = f(f(f(bottom - top) / step) * f(.8));
    const hits = new Int32Array(w), total = new Int32Array(w);
    for (let s = 0; s <= 54; s++) {
      const slope = f(f(-.04) + f(s * f(.0015)));
      const shift = new Float32Array(n); for (let k = 0; k < n; k++) shift[k] = f(slope * dys[k]);
      const { offset, careful } = floatRoundPlan(shift, w); hits.fill(0); total.fill(0);
      for (let k = 0; k < n; k++) {
        const base = k * w;
        if (careful[k]) { for (let x = 0; x < w; x++) { const xx = roundF(f(x + shift[k])); if (xx < 0 || xx >= w) continue; hits[x] += rule[base + xx]; total[x]++; } continue; }
        const off = offset[k], from = Math.max(0, -off), to = Math.min(w, w - off);
        for (let x = from; x < to; x++) { hits[x] += rule[base + x + off]; total[x]++; }
      }
      // A clipped slant along the outside is not a long observed rule.
      for (let x = 0; x < w; x++) if (total[x] >= need) best[x] = Math.max(best[x], f(hits[x] / Math.max(1, total[x])));
    }
    const peaks = [];
    for (let x = 0; x < w; x++) {
      if (best[x] < f(.62)) continue; let maximum = true;
      for (let k = Math.max(0, x - 4); k <= Math.min(w - 1, x + 4); k++) if (best[k] > best[x]) { maximum = false; break; }
      if (!maximum) continue;
      if (peaks.length > 0 && x - peaks[peaks.length - 1] < 8) { const last = peaks[peaks.length - 1]; if (best[x] > best[last]) peaks[peaks.length - 1] = x; }
      else peaks.push(x);
    }
    return peaks;
  }
}
