// Port of vn.lichdilam.DayColumns (APK 4.5). List<Integer> rules → array of ints, List<Float> → array of
// float values, float[] result → Float32Array; Java float math via Math.fround.
import { FLOAT_MAX, Float } from '../platform/java.js';

const f = Math.fround;

/** Median width of up to two columns on each side of column d. */
function local(lines, d) {
  const w = [];
  for (let k = Math.max(0, d - 2); k <= Math.min(lines.length - 2, d + 2); k++) if (k !== d) w.push(f(lines[k + 1] - lines[k]));
  if (w.length === 0) return f(lines[d + 1] - lines[d]); w.sort(Float.compare);
  return w.length % 2 === 1 ? w[w.length >> 1] : f(f(w[(w.length >> 1) - 1] + w[w.length >> 1]) / 2);
}

/** Picks the day columns of a work roster from the vertical rules found in the rectified table.
 *  The printed sheet need not have equal columns (25/10/2026: days 1–15 ≈ 39 px, days 16–31 ≈ 48 px), and a
 *  faint rule can be missed: a gap that is the width of two neighbouring columns is split where the
 *  neighbours say, never invented elsewhere. Pure Java so the choice is tested on recorded rule positions. */
export class DayColumns {
  /** {stt left, name left, day 1 left, …, day N right} or null when no run of exactly N columns fits. */
  static select(rules, days, tableWidth) {
    let bestScore = FLOAT_MAX, best = null; const last = rules.length - 1;
    // As in 1.7.5 the run ends at the table's right border: a shorter month never takes a part of the columns.
    for (let i = 2; i < rules.length; i++) {
      const j = last;
      const lines = []; for (let k = i; k <= j; k++) lines.push(f(rules[k]));
      const inserted = DayColumns.repair(lines); if (inserted < 0 || lines.length !== days + 1) continue;
      // Fewer than 28 columns: a photo of part of the month (half sheet, days 1–15): its columns are wider.
      const span = days < 28 ? f(31 / days) : 1;
      const mean = f(f(lines[days] - lines[0]) / days); if (mean < f(f(tableWidth * f(.015)) * span) || mean > f(f(tableWidth * f(.045)) * span)) continue;
      // The name column is much wider than a day column.
      if (rules[i] - rules[i - 1] < f(mean * 2)) continue;
      let error = 0, regular = true;
      for (let d = 0; d < days; d++) { const w = f(lines[d + 1] - lines[d]), loc = local(lines, d); const r = f(w / loc); if (r < f(.7) || r > f(1.35)) regular = false; error = f(error + f(f(r - 1) * f(r - 1))); }
      if (!regular) continue;
      const score = f(f(error / days) + f(f(.05) * inserted));
      if (score < bestScore) { bestScore = score; best = new Float32Array(days + 3); best[0] = rules[i - 2]; best[1] = rules[i - 1]; for (let d = 0; d <= days; d++) best[d + 2] = lines[d]; }
    }
    return bestScore < f(.5) ? best : null;
  }
  /** A photo holding only part of the month (3.0, 26/10: the user's half sheet, days 1–15): all the day columns
   *  that follow the name column up to the table's right border, when they are fewer than the month's days (at
   *  least 7) and evenly spaced. Never a part of the columns, and never more columns than days. */
  static selectPartial(rules, days, tableWidth) {
    for (let count = days - 1; count >= 7; count--) { const x = DayColumns.select(rules, count, tableWidth); if (x != null) return x; }
    return null;
  }
  /** Splits gaps that are two (or three) neighbouring columns wide; returns how many rules were added, -1 when
   *  a gap fits no whole number of columns. */
  static repair(lines) {
    let added = 0;
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (let d = 0; d + 1 < lines.length; d++) {
        const w = f(lines[d + 1] - lines[d]), loc = local(lines, d), r = f(w / loc);
        if (r >= f(1.7) && r <= f(2.4)) {
          // Split in proportion to the columns on either side (the sheet changes width at day 16).
          const left = d > 0 ? f(lines[d] - lines[d - 1]) : loc, right = d + 2 < lines.length ? f(lines[d + 2] - lines[d + 1]) : loc;
          lines.splice(d + 1, 0, f(lines[d] + f(f(w * left) / f(left + right)))); added++; changed = true; break;
        }
        if (r > f(2.6) && r <= f(3.4)) { lines.splice(d + 1, 0, f(lines[d] + f(w / 3))); lines.splice(d + 2, 0, f(lines[d] + f(f(2 * w) / 3))); added += 2; changed = true; break; }
      }
      if (!changed) break;
    }
    return added;
  }
}
