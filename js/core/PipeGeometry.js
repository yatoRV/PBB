// Port of vn.lichdilam.PipeGeometry (APK 4.5). int[] → Int32Array (plain arrays are accepted as input), float[]
// → Float32Array, List<Line> → array; Java float math via Math.fround, int division with idiv; stable sorts as in Java.
import { IllegalArgumentException, FLOAT_MAX, Float, idiv, roundF } from '../platform/java.js';

const f = Math.fround;
const NEIGHBORS = [-6, -5, -4, 4, 5, 6];
const INVALID = 'Chưa tách được đường kẻ bảng. Ảnh cần có số ngày và hàng tên nhân viên; không cần cột STT.';

/** java.util.Arrays.binarySearch(int[], key). */
function binarySearch(a, key) {
  let low = 0, high = a.length - 1;
  while (low <= high) { const mid = (low + high) >>> 1, v = a[mid]; if (v < key) low = mid + 1; else if (v > key) high = mid - 1; else return mid; }
  return -(low + 1);
}
const sortedInts = a => Int32Array.from(a).sort();
const byCenter = (a, b) => a.center - b.center;

class Line {
  constructor(center, quality, along, trace) { this.center = center; this.quality = f(quality); this.along = along; this.trace = trace; Object.freeze(this); }
  at(position) {
    const along = this.along, trace = this.trace;
    let i = binarySearch(along, roundF(position)); if (i >= 0) return trace[i]; i = -i - 1; if (i === 0) i = 1; if (i >= along.length) i = along.length - 1;
    return f(trace[i - 1] + f(f(f(position - along[i - 1]) * (trace[i] - trace[i - 1])) / (along[i] - along[i - 1])));
  }
}
/** value(g, w, h, across, along, vertical): the pixel at (across, along), clamped across the lines. */
function value(g, w, h, across, along, vertical) { return vertical ? g[along * w + Math.max(0, Math.min(w - 1, across))] : g[Math.max(0, Math.min(h - 1, across)) * w + along]; }
/** total over q in [lo, hi) of (outside/6 − inside/3) at position t, in Java float arithmetic. */
// The sums of whole grey levels are exact, so the clamped indices are computed once per position.
function response(g, w, h, t, lo, hi, vertical) {
  let total = 0;
  if (vertical) {
    const c = o => Math.max(0, Math.min(w - 1, t + o)), a0 = c(-6), a1 = c(-5), a2 = c(-4), a3 = c(4), a4 = c(5), a5 = c(6), b0 = c(-1), b1 = c(0), b2 = c(1);
    for (let q = lo; q < hi; q++) {
      const r = q * w, outside = g[r + a0] + g[r + a1] + g[r + a2] + g[r + a3] + g[r + a4] + g[r + a5], inside = g[r + b0] + g[r + b1] + g[r + b2];
      total = f(total + f(f(outside / 6) - f(inside / 3)));
    }
  } else {
    const c = o => Math.max(0, Math.min(h - 1, t + o)) * w, a0 = c(-6), a1 = c(-5), a2 = c(-4), a3 = c(4), a4 = c(5), a5 = c(6), b0 = c(-1), b1 = c(0), b2 = c(1);
    for (let q = lo; q < hi; q++) {
      const outside = g[a0 + q] + g[a1 + q] + g[a2 + q] + g[a3 + q] + g[a4 + q] + g[a5 + q], inside = g[b0 + q] + g[b1 + q] + g[b2 + q];
      total = f(total + f(f(outside / 6) - f(inside / 3)));
    }
  }
  return total;
}
function intersectionY(column, row) { let x = f(column.center), y = f(row.center); for (let i = 0; i < 4; i++) { x = column.at(y); y = row.at(x); } return y; }
/** outside/6 − inside/3 ≥ 5 at one pixel (the whitespace and crossing tests). */
function contrast(pixels, width, height, a, b, vertical) {
  let outside = 0, inside = 0; for (const offset of NEIGHBORS) outside += value(pixels, width, height, a + offset, b, vertical);
  for (let offset = -1; offset <= 1; offset++) inside += value(pixels, width, height, a + offset, b, vertical);
  return f(f(outside / 6) - f(inside / 3)) >= 5;
}
const FRACTIONS = [f(.18), f(.82)];

function whitespaceSupport(pixels, width, height, column, rows, from, to) {
  let hits = 0, samples = 0;
  for (let r = from; r < to; r++) {
    const top = intersectionY(column, rows[r]), bottom = intersectionY(column, rows[r + 1]); if (bottom <= top) continue;
    for (const fraction of FRACTIONS) {
      const y = roundF(f(top + f(f(bottom - top) * fraction))), x = roundF(column.at(y)); if (x < 6 || x >= width - 6 || y < 0 || y >= height) continue;
      samples++; if (contrast(pixels, width, height, x, y, true)) hits++;
    }
  }
  return samples < 12 ? 0 : f(hits / samples);
}
/** A parallel edge on an adjacent sheet must not become another column of this table. Staff
 * rulings must actually reach the track on at least one side (only the inside at an outer border). */
function crossingSupport(pixels, width, height, column, rows, from, to) {
  let left = 0, right = 0, samples = 0;
  for (let r = from + 2; r <= to; r++) {
    const row = rows[r]; const y = intersectionY(column, row), x = column.at(y); samples++;
    for (const side of [-1, 1]) {
      let hit = false;
      for (const shift of [8, 11]) { const xx = roundF(f(x + side * shift)), yy = roundF(row.at(xx)); if (xx < 0 || xx >= width || yy < 6 || yy >= height - 6) continue; if (contrast(pixels, width, height, yy, xx, false)) hit = true; }
      if (hit) { if (side < 0) left++; else right++; }
    }
  }
  return samples < 6 ? 0 : f(Math.max(left, right) / samples);
}
/** Sharpening can make a letter stroke look like an extra ruling inside a real cell. */
function removeSplitLines(input) {
  if (input.length < 6) return input;
  const gaps = new Int32Array(input.length - 1); for (let i = 0; i < gaps.length; i++) gaps[i] = input[i + 1].center - input[i].center; gaps.sort();
  const minimum = f(gaps[gaps.length >> 1] * f(.60)); const ranked = input.slice(); ranked.sort((a, b) => Float.compare(b.quality, a.quality)); const kept = [];
  for (const line of ranked) { let near = false; for (const other of kept) if (Math.abs(line.center - other.center) < minimum) { near = true; break; } if (!near) kept.push(line); }
  kept.sort(byCenter); return kept;
}
function layout(columns, rows, width, allowClippedNumber) {
  let name = -1, widest = 0;
  for (let i = allowClippedNumber ? 0 : 1; i < Math.min(8, columns.length - 1); i++) { const gap = columns[i + 1].center - columns[i].center; if (gap > widest) { widest = gap; name = i; } }
  if (name < 0 || widest < width * .08 || rows.length < 4 || columns.length - name < 4) throw new IllegalArgumentException(INVALID);
  if (name === 0) {
    // Only a compatibility slot for column indices. No employee number is read here.
    const first = columns[0]; const edge = new Int32Array(first.trace.length);
    for (let i = 0; i < edge.length; i++) edge[i] = Math.max(0, first.trace[i] - Math.max(12, idiv(width, 40)));
    columns = columns.slice(); columns.splice(0, 0, new Line(Math.max(0, first.center - Math.max(12, idiv(width, 40))), first.quality, first.along, edge)); name = 1;
  }
  return new PipeGeometry(columns.slice(name - 1), rows);
}
/** Short windows preserve steep local lines; direction continuity rejects letter strokes. */
function curvedLines(g, w, h, vertical, relativeThreshold = vertical ? f(.25) : f(.45)) {
  const across = vertical ? w : h, length = vertical ? h : w, step = Math.max(10, idiv(length, 70)), count = idiv(length - 2 * step - 1, step) + 1, window = Math.max(3, idiv(step, 2)), edge = 8;
  const positions = new Int32Array(count); const responses = [];
  for (let i = 0; i < count; i++) {
    const position = positions[i] = step + i * step, lo = Math.max(0, position - window), hi = Math.min(length, position + window);
    const r = new Float32Array(across); responses.push(r);
    for (let t = edge; t < across - edge; t++) r[t] = f(response(g, w, h, t, lo, hi, vertical) / (hi - lo));
  }
  const center = count >> 1; let last = -100, best = -1; const seeds = [];
  for (let t = edge; t < across - edge; t++) if (responses[center][t] >= 5) { if (t - last > 3 && best >= 0) { seeds.push(best); best = -1; } if (best < 0 || responses[center][t] > responses[center][best]) best = t; last = t; } if (best >= 0) seeds.push(best);
  let candidates = []; let strongest = 0;
  for (const seed of seeds) {
    const trace = new Int32Array(count); trace[center] = seed; const radius = Math.max(4, roundF(f(step * f(.45))));
    for (const direction of [-1, 1]) for (let i = center + direction; i >= 0 && i < count; i += direction) {
      const previous = trace[i - direction], velocity = Math.abs(i - center) > 1 ? previous - trace[i - 2 * direction] : 0, predicted = previous + velocity; let chosen = previous, score = -FLOAT_MAX;
      for (let t = Math.max(edge, previous - radius); t < Math.min(across - edge, previous + radius + 1); t++) {
        const candidate = f(f(responses[i][t] - f(f(f(.8) * (t - predicted)) * (t - predicted))) - f(f(f(.04) * (t - previous)) * (t - previous))); if (candidate > score) { score = candidate; chosen = t; }
      } trace[i] = chosen;
    }
    const quality = new Float32Array(count); let hits = 0; for (let i = 0; i < count; i++) { quality[i] = responses[i][trace[i]]; if (quality[i] > 5) hits++; } quality.sort(); const median = quality[count >> 1];
    if (f(hits / count) > f(.65) && median > 8) { candidates.push(new Line(seed, median, positions, trace)); strongest = Math.max(strongest, median); }
  }
  // Group separators can be much darker than thin internal columns on the same sheet.
  const threshold = Math.max(8, f(strongest * relativeThreshold));
  candidates = candidates.filter(line => !(line.quality < threshold || responses[center][line.center] < f(line.quality * f(.75))));
  candidates.sort((a, b) => Float.compare(responses[center][b.center], responses[center][a.center])); const unique = [];
  const distance = new Int32Array(count);
  for (const line of candidates) {
    let duplicate = false;
    for (const other of unique) { for (let i = 0; i < count; i++) distance[i] = Math.abs(line.trace[i] - other.trace[i]); distance.sort(); if (distance[count >> 1] < 4) { duplicate = true; break; } }
    if (!duplicate) unique.push(line);
  }
  unique.sort(byCenter); return unique;
}
function lines(g, w, h, vertical) {
  const across = vertical ? w : h, length = vertical ? h : w, step = Math.max(16, idiv(length, 40)), count = idiv(length - 2 * step - 1, step) + 1;
  const positions = new Int32Array(count); const responses = [];
  for (let i = 0; i < count; i++) {
    const position = positions[i] = step + i * step, lo = Math.max(0, position - step), hi = Math.min(length, position + step);
    const r = new Float32Array(across); responses.push(r);
    for (let t = 0; t < across; t++) r[t] = f(response(g, w, h, t, lo, hi, vertical) / (hi - lo));
  }
  const center = count >> 1; const seeds = []; let last = -100, best = -1;
  for (let t = 0; t < across; t++) if (responses[center][t] >= f(3.5)) { if (t - last > 3 && best >= 0) { seeds.push(best); best = -1; } if (best < 0 || responses[center][t] > responses[center][best]) best = t; last = t; } if (best >= 0) seeds.push(best);
  let candidates = []; let strongest = 0;
  for (const seed of seeds) {
    const trace = new Int32Array(count); trace[center] = seed; const radius = Math.max(3, roundF(f(step * f(.16))));
    for (const direction of [-1, 1]) for (let i = center + direction; i >= 0 && i < count; i += direction) {
      const previous = trace[i - direction]; let chosen = previous, score = -FLOAT_MAX;
      for (let t = Math.max(0, previous - radius); t < Math.min(across, previous + radius + 1); t++) { const candidate = f(responses[i][t] - f(f(f(.025) * (t - previous)) * (t - previous))); if (candidate > score) { score = candidate; chosen = t; } } trace[i] = chosen;
    }
    const qualities = new Float32Array(count); let hits = 0; for (let i = 0; i < count; i++) { qualities[i] = responses[i][trace[i]]; if (qualities[i] > f(3.5)) hits++; } qualities.sort(); const median = qualities[count >> 1];
    if (f(hits / count) > f(.70)) { candidates.push(new Line(seed, median, positions, trace)); strongest = Math.max(strongest, median); }
  }
  const threshold = Math.max(6, f(strongest * f(.45))); candidates = candidates.filter(line => !(line.quality < threshold)); candidates.sort(byCenter); return candidates;
}
/** Title/notes pixels must not make a steep outer ruling fail the whole-image continuation test.
 * Re-measure only the longest observed, regularly ruled staff band. Weak tracks need independent
 * support in row whitespace; no line is inserted from an expected count, date or assignment. */
function columnsInsideStaffBand(pixels, width, height, baseline) {
  const band = PipeGeometry.continuousBand(baseline.rows); if (band == null) return null;
  const top = Math.max(0, baseline.rows[band[0]].center), bottom = Math.min(height, baseline.rows[band[1]].center + 1);
  if (bottom - top < 60 || bottom - top < f(height * f(.35))) return null;
  const crop = pixels.slice(top * width, bottom * width); const detected = removeSplitLines(curvedLines(crop, width, bottom - top, true, 0));
  const mapped = []; for (const line of detected) { const along = Int32Array.from(line.along); for (let i = 0; i < along.length; i++) along[i] += top; mapped.push(new Line(line.center, line.quality, along, line.trace)); }
  const supported = []; for (const line of mapped) if (whitespaceSupport(pixels, width, height, line, baseline.rows, band[0], band[1]) >= f(.8) && crossingSupport(pixels, width, height, line, baseline.rows, band[0], band[1]) >= f(.8)) supported.push(line);
  try {
    const candidate = layout(supported, baseline.rows, width, true); if (candidate.columns.length <= baseline.columns.length || !PipeGeometry.evenDays(candidate.columns)) return null;
    const gaps = new Int32Array(candidate.columns.length - 3); for (let i = 2; i + 1 < candidate.columns.length; i++) gaps[i - 2] = candidate.columns[i + 1].center - candidate.columns[i].center; const median = sortedInts(gaps)[gaps.length >> 1];
    for (const gap of gaps) if (gap < f(median * f(.6)) || gap > f(median * f(1.6))) return null;
    const at = f((top + bottom) / 2), tolerance = Math.max(4, f(median * f(.25)));
    // Preserve the measured STT/name anchors and every accepted inner rule.
    for (let i = 0; i < Math.min(3, baseline.columns.length); i++) if (Math.abs(f(baseline.columns[i].at(at) - candidate.columns[i].at(at))) > tolerance) return null;
    for (const old of baseline.columns) { let match = false; for (const added of candidate.columns) if (Math.abs(f(old.at(at) - added.at(at))) <= tolerance) { match = true; break; } if (!match) return null; }
    const oldLast = baseline.columns[baseline.columns.length - 1].at(at), newLast = candidate.columns[candidate.columns.length - 1].at(at);
    if (PipeGeometry.evenDays(baseline.columns) && f(newLast - oldLast) < f(median * f(.6))) return null;
    return candidate;
  } catch (unsupported) { if (unsupported instanceof IllegalArgumentException) return null; throw unsupported; }
}
/** 26/10 night: the rows of a bowed table found as straight lines come in pairs — a ruling matched once along its
 *  left half and once along its right (the user's T5 photo: 38 straight rows for 19 rulings). When the straight
 *  rows are at least 1.4× the rulings followed as curves, and those are evenly spaced (every gap within 35 % of
 *  the median), the curved rows are used with the straight columns; the outer border lines, which the curves miss
 *  at the very edge, are taken from the straight ones. Every October table outline gives the same count both
 *  ways (11 saved tables), so nothing changes there. null = keep the straight rows. */
function curvedRowsInstead(pixels, width, height, columns, straightRows) {
  const curved = PipeGeometry.regularRows(removeSplitLines(curvedLines(pixels, width, height, false)));
  if (curved.length < 4 || straightRows.length < f(curved.length * f(1.4))) return null;
  const gaps = new Int32Array(curved.length - 1); for (let i = 0; i < gaps.length; i++) gaps[i] = curved[i + 1].center - curved[i].center;
  const median = sortedInts(gaps)[gaps.length >> 1];
  for (const gap of gaps) if (Math.abs(f(gap - median)) > f(median * f(.35))) return null;
  // Only the one straight line next to the curves is a border: more lines above (the "Ca: … / Ngày" title of the
  // August Tô Hoài sheet) are not rows, and taking them shifted every row down by one (27/10).
  const rows = []; let above = null, below = null; const first = curved[0].center, last = curved[curved.length - 1].center;
  for (const s of straightRows) {
    if (s.center < f(first - f(median * f(.6))) && s.center >= f(first - f(median * f(1.6))) && (above == null || s.center > above.center)) above = s;
    if (s.center > f(last + f(median * f(.6))) && s.center <= f(last + f(median * f(1.6))) && (below == null || s.center < below.center)) below = s;
  }
  if (above != null) rows.push(above); rows.push(...curved); if (below != null) rows.push(below);
  try { return layout(columns, rows, width, false); } catch (unsupported) { if (unsupported instanceof IllegalArgumentException) return null; throw unsupported; }
}
/** 26/10 night: on a bowed table the faint rules of the last days lean too far for the straight search (the
 *  user's T5 photo: no column after 82 % of the width, days 15 and 16 lost). When the straight columns stop
 *  before 90 % of the width, the rules followed as curves beyond the last straight column are added. Every
 *  October table outline whose straight columns are even reaches 95 % or more, so nothing changes there. */
function extendColumns(pixels, width, height, columns) {
  if (columns.length === 0 || columns[columns.length - 1].center >= f(width * f(.9))) return columns;
  const last = columns[columns.length - 1].center; const out = columns.slice();
  for (const c of removeSplitLines(curvedLines(pixels, width, height, true))) if (c.center > last + 12) out.push(c);
  return out.length === columns.length ? columns : out;
}
/** A letter stem can follow a real column for part of a bowed photo, then leave it inside another row.
 *  Real column rules continue through the whitespace near both ends of the staff cells. Check those
 *  observed pixels, retaining the outer boundaries whose contrast may be clipped by the photo edge.
 *  No row/column count, staff name, date or expected assignment supplies a missing line. */
function columnsThroughRowWhitespace(pixels, width, height, columns, rows) {
  if (columns.length < 6 || rows.length < 7) return columns;
  const gaps = new Int32Array(rows.length - 1); for (let i = 0; i < gaps.length; i++) gaps[i] = rows[i + 1].center - rows[i].center;
  const median = sortedInts(gaps)[gaps.length >> 1]; if (median <= 0) return columns;
  const bands = []; for (let i = 0; i < gaps.length; i++) if (gaps[i] >= f(median * f(.6)) && gaps[i] <= f(median * f(1.6))) bands.push(i);
  if (bands.length < 6) return columns;
  const kept = []; let changed = false;
  for (let c = 0; c < columns.length; c++) {
    const column = columns[c]; if (c === 0 || c === columns.length - 1) { kept.push(column); continue; }
    let samples = 0, hits = 0;
    for (const band of bands) {
      const top = intersectionY(column, rows[band]), bottom = intersectionY(column, rows[band + 1]); if (bottom <= top) continue;
      for (const fraction of FRACTIONS) {
        const y = roundF(f(top + f(f(bottom - top) * fraction))), x = roundF(column.at(y)); if (x < 0 || x >= width || y < 0 || y >= height) continue;
        samples++; if (contrast(pixels, width, height, x, y, true)) hits++;
      }
    }
    if (samples < 12 || f(hits / samples) >= f(.8)) kept.push(column); else changed = true;
  }
  // An intermittent trace is not enough to prove which subcolumn was real when the surviving grid
  // still has missing/uneven day rules. Keep the original detector's evidence in that case.
  if (!changed || kept.length < 6 || !PipeGeometry.evenDays(kept)) return columns;
  try { layout(kept, rows, width, true); return kept; } catch (unsupported) { if (unsupported instanceof IllegalArgumentException) return columns; throw unsupported; }
}
function analyzeExisting(pixels, width, height, curvedRetry) {
  try {
    const straightColumns = lines(pixels, width, height, true), straightRows = PipeGeometry.regularRows(lines(pixels, width, height, false));
    const straight = layout(straightColumns, straightRows, width, false);
    if (PipeGeometry.evenDays(straight.columns) || !curvedRetry) {
      if (curvedRetry) {
        const columns = extendColumns(pixels, width, height, straightColumns);
        const rows = curvedRowsInstead(pixels, width, height, columns, straightRows); if (rows != null) return rows;
        if (columns !== straightColumns) try { return layout(columns, straightRows, width, false); } catch (unsupported) { if (!(unsupported instanceof IllegalArgumentException)) throw unsupported; }
      }
      return straight;
    }
    // A blurred or low-contrast re-shot photo (25/10 T.T. Vinh sheet, random copy r101): the thin rules
    // between day columns fall under 45 % of the darkest group separator, whole days vanish and the name
    // column lands on days. The rules followed as curves (as for a bowed page) are used instead when their
    // day columns are evenly spaced; the 25/10 originals keep the straight lines.
    try { const curved = PipeGeometry.curved(pixels, width, height); if (PipeGeometry.evenDays(curved.columns)) return curved; }
    catch (stillUneven) { if (!(stillUneven instanceof IllegalArgumentException)) throw stillUneven; }
    return straight;
  } catch (unsupported) { if (unsupported instanceof IllegalArgumentException) return PipeGeometry.curved(pixels, width, height); throw unsupported; }
}

/** Follows local ruling contrast on a curved page. Pure pixel math, independent of OCR. */
export class PipeGeometry {
  static Line = Line;
  constructor(columns, rows) { this.columns = columns; this.rows = rows; }
  /** analyze(pixels, width, height[, curvedRetry = true]). curvedRetry: uneven straight day columns are tried
   *  again as curves — for a table outline only. On the whole uncropped 25/10 T.T. Vinh photo the retry tied with
   *  the outline the app read before and won, and one of its cells read a pipe wrong (Nguyễn Hải Ngọc day 30, a
   *  blurred "11" read "22"); so the whole photo keeps 1.7.5's straight columns and loses to the outline as before. */
  static analyze(pixels, width, height, curvedRetry = true) {
    const baseline = analyzeExisting(pixels, width, height, curvedRetry);
    if (curvedRetry && (!PipeGeometry.evenDays(baseline.columns) || baseline.columns[baseline.columns.length - 1].center < f(width * f(.94)))) {
      const recovered = columnsInsideStaffBand(pixels, width, height, baseline); if (recovered != null) return recovered;
    }
    return baseline;
  }
  static continuousBand(rows) {
    if (rows.length < 7) return null; const gaps = new Int32Array(rows.length - 1); for (let i = 0; i < gaps.length; i++) gaps[i] = rows[i + 1].center - rows[i].center; const median = sortedInts(gaps)[gaps.length >> 1]; if (median <= 0) return null;
    let start = 0, bestStart = 0, bestEnd = 0; for (let i = 0; i < gaps.length; i++) { if (gaps[i] < f(median * f(.55)) || gaps[i] > f(median * f(1.65))) { if (i - start > bestEnd - bestStart) { bestStart = start; bestEnd = i; } start = i + 1; } } if (rows.length - 1 - start > bestEnd - bestStart) { bestStart = start; bestEnd = rows.length - 1; } return bestEnd - bestStart >= 6 ? [bestStart, bestEnd] : null;
  }
  static curved(pixels, width, height) {
    const columns = removeSplitLines(curvedLines(pixels, width, height, true)), rows = PipeGeometry.regularRows(removeSplitLines(curvedLines(pixels, width, height, false)));
    return layout(columnsThroughRowWhitespace(pixels, width, height, columns, rows), rows, width, true);
  }
  /** Row rulings never cross, and the gap between two neighbouring rows changes only gradually along the
   *  page. Where a trace jumps (seen at the curved lower-left corner of a real photo, where it crossed two
   *  other rows and turned name cells upside down), it follows the row above at the gap measured just
   *  before the jump. Traces that are already consistent are returned unchanged. */
  static regularRows(rows) {
    if (rows.length < 3) return rows; const count = rows[0].trace.length;
    const same = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
    for (const row of rows) if (row.trace.length !== count || row.along !== rows[0].along && !same(row.along, rows[0].along)) return rows;
    const center = count >> 1; const t = []; for (let r = 0; r < rows.length; r++) t.push(Int32Array.from(rows[r].trace)); let changed = false;
    for (let r = 1; r < rows.length; r++) {
      const centerGap = t[r][center] - t[r - 1][center]; if (centerGap <= 2) continue;
      for (const direction of [-1, 1]) {
        let reference = centerGap;
        for (let i = center + direction; i >= 0 && i < count; i += direction) {
          const gap = t[r][i] - t[r - 1][i];
          if (gap <= 0 || Math.abs(gap - reference) > Math.max(4, f(reference * f(.35)))) { t[r][i] = t[r - 1][i] + reference; changed = true; }
          else reference = gap;
        }
      }
    }
    if (!changed) return rows;
    const result = []; for (let r = 0; r < rows.length; r++) { const row = rows[r]; result.push(new Line(row.center, row.quality, row.along, t[r])); }
    return result;
  }
  /** No day column (after STT and name) over 1.6 times the median one: a missed rule leaves a double column. */
  static evenDays(columns) {
    if (columns.length < 6) return false; const gaps = new Int32Array(columns.length - 3);
    for (let i = 2; i + 1 < columns.length; i++) gaps[i - 2] = columns[i + 1].center - columns[i].center;
    const median = sortedInts(gaps)[gaps.length >> 1];
    for (const g of gaps) if (g > f(median * f(1.6))) return false;
    return true;
  }
  corner(column, row) { let x = f(this.columns[column].center), y = f(this.rows[row].center); for (let i = 0; i < 4; i++) { x = this.columns[column].at(y); y = this.rows[row].at(x); } return Float32Array.of(x, y); }
  headerY(x, y) { for (let r = 0; r < this.rows.length - 1; r++) if (y > this.rows[r].at(x) && y < this.rows[r + 1].at(x)) return f((this.rows[r].center + this.rows[r + 1].center) / 2); return -1; }
  headerX(x, y) {
    for (let c = 1; c < this.columns.length - 1; c++) { const left = this.columns[c].at(y), right = this.columns[c + 1].at(y); if (x >= left && x <= right) return f(this.columns[c].center + f(f(f(x - left) / f(right - left)) * (this.columns[c + 1].center - this.columns[c].center))); }
    return x;
  }
  maxY(row) { let max = 0; for (const value of this.rows[row].trace) max = Math.max(max, value); return max; }
}
