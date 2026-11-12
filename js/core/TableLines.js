// Port of vn.lichdilam.TableLines (APK 4.5). List<Integer> → array of ints, float[] → Float32Array, Java float
// math via Math.fround (the slope loops accumulate in float exactly as in Java).
import { idiv, roundF, d2i, FLOAT_MAX, Float, floatRoundPlan } from '../platform/java.js';

const f = Math.fround;

class Rows {
  constructor(lines, slopes, thin) { this.lines = lines; this.slopes = slopes; this.thin = thin; }
}

/** A thin-rule pixel: darker than 150 and by 30 than the pixels 5 px above and below. */
function thin(gray, w, h, x, y) {
  const g = gray[y * w + x]; return g < 150 && g <= Math.min(y >= 5 ? gray[(y - 5) * w + x] : 255, y + 5 < h ? gray[(y + 5) * w + x] : 255) - 30;
}
/** Per y the best score over slopes lo…hi (about x = center) and that slope: the share of sampled points (x from
 *  xFrom below xTo, every 3 px) on the line that are dark (thin: and darker by 30 than the pixels 5 px above and
 *  below). */
function scores(gray, w, h, thinOnly, xFrom, xTo, lo, hi, center) {
  const ys = new Float32Array(h), slopes = new Float32Array(h);
  const xs = []; for (let x = xFrom; x < xTo; x += 3) xs.push(x);
  const dx = new Float32Array(xs.length); for (let k = 0; k < xs.length; k++) dx[k] = f(xs[k] - center);
  // Speed-ups with the same results: slope·(x − center) is computed once per slope and x (the float values Java
  // computes each time), the rounded row comes from floatRoundPlan, and each pixel's dark / thin test is done once.
  const slopeList = [], shifts = [], plans = [];
  for (let slope = lo; slope <= hi; slope = f(slope + f(.001))) { slopeList.push(slope); const s = new Float32Array(xs.length); for (let k = 0; k < xs.length; k++) s[k] = f(slope * dx[k]); shifts.push(s); plans.push(floatRoundPlan(s, h)); }
  // The dark / thin test of every sampled pixel, stored per sampled x (column-major) for sequential reads. The
  // counts of one slope are summed for all y at once; the scores are then compared in Java's order (y, slope).
  const n = xs.length, dark = new Uint8Array(n * h);
  for (let k = 0; k < n; k++) { const x = xs[k], base = k * h; for (let yy = 0; yy < h; yy++) { const g = gray[yy * w + x]; dark[base + yy] = g < 150 && (!thinOnly || g <= Math.min(yy >= 5 ? gray[(yy - 5) * w + x] : 255, yy + 5 < h ? gray[(yy + 5) * w + x] : 255) - 30) ? 1 : 0; } }
  const hits = new Int32Array(h), total = new Int32Array(h);
  for (let si = 0; si < slopeList.length; si++) {
    const shift = shifts[si], offset = plans[si].offset, careful = plans[si].careful; hits.fill(0); total.fill(0);
    for (let k = 0; k < n; k++) {
      const base = k * h;
      if (careful[k]) { for (let y = 0; y < h; y++) { const yy = roundF(f(y + shift[k])); if (yy < 0 || yy >= h) continue; hits[y] += dark[base + yy]; total[y]++; } continue; }
      const off = offset[k], from = Math.max(0, -off), to = Math.min(h, h - off);
      for (let y = from; y < to; y++) { hits[y] += dark[base + y + off]; total[y]++; }
    }
    const slope = slopeList[si];
    for (let y = 0; y < h; y++) { const score = f(hits[y] / Math.max(1, total[y])); if (score > ys[y]) { ys[y] = score; slopes[y] = slope; } }
  }
  return [ys, slopes];
}
function select(ys, threshold, h) {
  let yv = TableLines.peaks(ys, threshold, Math.max(2, idiv(h, 1000)));
  if (yv.length > 5) {
    const gaps = new Int32Array(yv.length - 1); for (let i = 0; i < gaps.length; i++) gaps[i] = yv[i + 1] - yv[i]; gaps.sort(); const minGap = f(gaps[gaps.length >> 1] * f(.62));
    yv.sort((a, b) => Float.compare(ys[b], ys[a])); const filtered = [];
    for (const candidate of yv) { let close = false; for (const selected of filtered) if (Math.abs(selected - candidate) <= minGap) { close = true; break; } if (!close) filtered.push(candidate); }
    filtered.sort((a, b) => a - b); yv = filtered;
  }
  return yv;
}
const median = gaps => { const sorted = Int32Array.from(gaps).sort(); return sorted[sorted.length >> 1]; };

/** The horizontal rules of a rectified work roster (gray = (R·30+G·59+B·11)/100 per pixel). Pure Java, so the
 *  finding is replayed on the PC on the tables the device dumps (Audit30DeviceTest#gridDump, TableLinesTest).
 *  First as in 1.7.5: a rule is a line of pixels darker than 150. On a darker or blurred re-shot photo a row with
 *  shaded cells is dark over its whole height too, so rules ran together with it (25/10 re-shot work roster: rows 1
 *  and 2 merged, other rows split in two). When those lines are not evenly spaced, the rules are found again as
 *  thin lines: pixels darker than the paper or fill 5 px above and below them, which an evenly shaded row is not.
 *  The thin lines replace the first ones only when they are evenly spaced themselves; on the 25/10 photos
 *  (originals) the first lines are even and nothing changes. */
export class TableLines {
  static Rows = Rows;
  static STEP = 16;
  static rows(gray, w, h) {
    const dark = scores(gray, w, h, false, d2i(w * .02), f(w * f(.98)), f(-.025), f(.0251), f(w / 2)); const first = select(dark[0], f(.58), h);
    if (TableLines.even(first)) return new Rows(first, dark[1], false);
    const thinScores = scores(gray, w, h, true, d2i(w * .02), f(w * f(.98)), f(-.025), f(.0251), f(w / 2)); const second = select(thinScores[0], f(.46), h);
    if (TableLines.even(second)) return new Rows(second, thinScores[1], true);
    // A real wider header/total row can make both complete lists uneven. Restore a missing
    // interior rule only where a double-height gap contains a strong observed thin line.
    const repaired = first.slice(); const angles = dark[1].slice(); let added = false;
    if (first.length >= 6) {
      const gaps = new Int32Array(first.length - 1); for (let i = 0; i < gaps.length; i++) gaps[i] = first[i + 1] - first[i]; const med = median(gaps);
      for (let i = 0; i < gaps.length; i++) if (gaps[i] >= f(med * f(1.75)) && gaps[i] <= f(med * f(2.25))) {
        const a = first[i], b = first[i + 1]; let best = -1, score = f(.70);
        for (let y = Math.max(a + 1, roundF(f(a + f(med * f(.8))))); y < Math.min(b, roundF(f(a + f(med * f(1.2))))); y++) if (thinScores[0][y] > score) { best = y; score = thinScores[0][y]; }
        if (best >= 0 && b - best >= f(med * f(.75)) && b - best <= f(med * f(1.25))) { repaired.push(best); angles[best] = thinScores[1][best]; added = true; }
      }
    }
    if (added) { repaired.sort((a, b) => a - b); return new Rows(repaired, angles, true); }
    return new Rows(first, dark[1], false);
  }
  /** Each rule followed along the page as it is printed (the user's idea, 26/10: "kẻ theo đường viền đen trong
   *  ảnh"), by dynamic programming: at x = 0, 16, 32 … the rule sits at an offset d from its straight line
   *  (|d| ≤ 0.8 row, changing at most 3 px per 16 px); the path taken is the one covering the most thin-rule
   *  pixels (a 16 px window at each point) less 0.5 per squared px of change. Under a dark fill where no rule
   *  shows, the path simply goes on, it does not wander. Two rules closer than half a row anywhere are not used
   *  (null: the straight rule stays). On the 25/10 original the old cut put the bottom of row 1's name on the
   *  underline of row 2's text; the followed rule sits on the printed line. Returns y at x = k·STEP. */
  static follow(gray, w, h, lines, slopes) {
    const STEP = TableLines.STEP;
    const n = idiv(w + STEP - 1, STEP); const out = new Array(lines.length).fill(null);
    const gaps = new Int32Array(Math.max(1, lines.length - 1)); for (let i = 0; i + 1 < lines.length; i++) gaps[i] = lines[i + 1] - lines[i];
    const row = median(gaps); const range = d2i(f(row * f(.8))), m = 2 * range + 1;
    const half = f(w / 2);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]; const slope = slopes[line]; const score = []; for (let k = 0; k < n; k++) score.push(new Float32Array(m));
      for (let k = 0; k < n; k++) {
        const xk = k * STEP;
        for (let x = Math.max(0, xk - (STEP >> 1)); x < Math.min(w, xk + (STEP >> 1)); x += 2) {
          const base = f(line + f(slope * f(x - half)));
          for (let d = 0; d < m; d++) { const y = roundF(f(f(base + d) - range)); if (y >= 0 && y < h && thin(gray, w, h, x, y)) score[k][d]++; }
        }
      }
      let value = score[0].slice(); const back = []; for (let k = 0; k < n; k++) back.push(new Int32Array(m));
      for (let k = 1; k < n; k++) {
        const next = new Float32Array(m).fill(-FLOAT_MAX);
        for (let dd = -3; dd <= 3; dd++) for (let d = 0; d < m; d++) { const j = d - dd; if (j < 0 || j >= m) continue; const v = f(value[j] - f(f(f(.5) * dd) * dd)); if (v > next[d]) { next[d] = v; back[k][d] = j; } }
        for (let d = 0; d < m; d++) next[d] = f(next[d] + score[k][d]); value = next;
      }
      let d = 0; for (let j = 1; j < m; j++) if (value[j] > value[d]) d = j;
      const t = new Float32Array(n); for (let k = n - 1; k >= 0; k--) { t[k] = f(f(f(line + f(slope * f(k * STEP - half))) + d) - range); d = back[k][d]; }
      out[i] = t;
    }
    for (let i = 0; i + 1 < out.length; i++) if (out[i] != null && out[i + 1] != null) for (let k = 0; k < n; k++) if (f(out[i + 1][k] - out[i][k]) < f(row * f(.5))) { out[i] = null; out[i + 1] = null; break; }
    return out;
  }
  /** No row is under 0.6 or over 1.6 times the median row (a missed rule doubles a row, a split halves it). */
  static even(lines) {
    if (lines.length < 6) return false;
    const gaps = new Int32Array(lines.length - 1); for (let i = 0; i < gaps.length; i++) gaps[i] = lines[i + 1] - lines[i];
    const med = median(gaps);
    for (const g of gaps) if (g < f(med * f(.6)) || g > f(med * f(1.6))) return false;
    return true;
  }
  static peaks(scores, threshold, gap) {
    const out = []; let best = -1, max = 0, last = -100;
    for (let i = 0; i < scores.length; i++) {
      if (scores[i] >= threshold) {
        if (i - last > gap && best >= 0) { out.push(best); best = -1; max = 0; }
        if (scores[i] > max) { max = scores[i]; best = i; } last = i;
      }
    }
    if (best >= 0) out.push(best); return out;
  }
}
