// Port of vn.lichdilam.GridVision (APK 4.5). Synchronous like the Java (all Bitmap work goes through the
// js/platform/bitmap.js shim). float[] → Float32Array, int[] → Int32Array, boolean[] → Uint8Array, List<Integer> →
// array; Java float math via Math.fround, int division with idiv / |0, (int) casts with d2i, Math.round with roundF.
import { JavaException, IllegalArgumentException, FLOAT_MAX, Float, idiv, roundF, d2i, javaFloatToString, floatRoundPlan } from '../platform/java.js';
import { Bitmap, Canvas, Color, Matrix, Paint, RectF } from '../platform/bitmap.js';
import { BuildConfig } from '../platform/android.js';
import { Log } from '../platform/log.js';
import { TableLines } from './TableLines.js';
import { DayColumns } from './DayColumns.js';
import { WorkColumns } from './WorkColumns.js';
import { ColumnShift } from './ColumnShift.js';
import { CellInk } from './CellInk.js';
import { PipeGeometry } from './PipeGeometry.js';
import { PipeHeaders } from './PipeHeaders.js';

const f = Math.fround;
const ARGB_8888 = Bitmap.Config.ARGB_8888;

function gray(c) { return ((Color.red(c) * 30 + Color.green(c) * 59 + Color.blue(c) * 11) / 100) | 0; }
function distance(p, a, b) { return f(Math.hypot(f(p[a] - p[b]), f(p[a + 1] - p[b + 1]))); }
const listText = l => '[' + l.join(', ') + ']';
const floatsText = a => '[' + Array.from(a, javaFloatToString).join(', ') + ']';

/** Geometry is measured from ruled lines; OCR never decides which day a cell belongs to. */
class Grid {
  constructor(table, x, y, rowSlopes) {
    this.table = table; this.x = x; this.y = y; this.rowSlopes = rowSlopes;
    const w = table.getWidth(), h = table.getHeight(); const grayPixels = new Int32Array(w * h); table.getPixels(grayPixels, 0, w, 0, 0, w, h); for (let i = 0; i < grayPixels.length; i++) grayPixels[i] = gray(grayPixels[i]);
    this.grayPixels = grayPixels;
    this.source = null; this.sourceToTable = null; this.normalizedCorners = null; this.pipeGeometry = null;
    /** Row rules followed along the printed black lines (TableLines.follow), y at x = k·traceStep; a null rule
     *  (or no traces at all) is the straight rule y + slope·(x − centre). */
    this.traces = null; this.traceStep = 0;
    /** Work roster: the month day (0-based) of the first day column, set by RosterReader; -1 = not known yet. */
    this.firstDay = -1;
    this.bandShift = null;
  }
  dayColumns() { return this.x.length - 3; }
  ruleY(rule, at) {
    const t = this.traces == null ? null : this.traces[rule]; if (t == null) return f(this.y[rule] + f(this.rowSlopes[rule] * f(at - f(this.table.getWidth() / 2))));
    const k = Math.max(0, Math.min(t.length - 1, f(at / this.traceStep))); const i = Math.min(t.length - 2, d2i(k)); return f(t[i] + f(f(k - i) * f(t[i + 1] - t[i])));
  }
  /** private float refine(int col, int row, float radius) */
  refine(col, row, radius) {
    const x = this.x, y = this.y, width = this.table.getWidth(), height = this.table.getHeight(), half = f(width / 2), g = this.grayPixels;
    const l = col < 2 ? x[0] : x[Math.max(2, col - 1)], r = col < 2 ? x[2] : x[Math.min(x.length - 1, col + 2)];
    let best = FLOAT_MAX, bestDelta = 0; const reach = d2i(radius), right = f(r - 2);
    for (let delta = -reach; delta <= reach; delta++) {
      let sum = 0, n = 0;
      for (let xx = d2i(l) + 2; xx < right; xx += 2) { const yy = roundF(f(f(y[row] + f(this.rowSlopes[row] * f(xx - half))) + delta)); if (yy < 0 || yy >= height) continue; sum = f(sum + g[yy * width + xx]); n++; }
      const score = f(f(sum / Math.max(1, n)) + f(3 * delta * delta / Math.max(1, f(radius * radius))));
      if (n > 0 && score < best) { best = score; bestDelta = delta; }
    }
    return bestDelta;
  }
  /** Per-band offset of each day rule from the table-wide column position (ColumnShift), cached per row. */
  bandOffset(boundary, row) {
    const y = this.y;
    if (this.bandShift == null) this.bandShift = new Array(y.length).fill(null);
    if (this.bandShift[row] == null) { const h = this.table.getHeight(); this.bandShift[row] = ColumnShift.offsets(this.grayPixels, this.table.getWidth(), h, this.x, Math.max(0, d2i(y[Math.max(0, row - 1)])), Math.min(h, d2i(y[Math.min(y.length - 1, row + 2)]))); }
    return this.bandShift[row][boundary];
  }
  columnBorder(boundary, row) {
    const x = this.x, y = this.y, g = this.grayPixels;
    if (boundary < 2) return x[boundary];
    const w = this.table.getWidth(), h = this.table.getHeight();
    const spacing = boundary === x.length - 1 ? f(x[boundary] - x[boundary - 1]) : f(x[boundary + 1] - x[boundary]);
    const radius = Math.max(2, roundF(f(spacing * f(.22))));
    const top = Math.max(0, d2i(y[Math.max(0, row - 2)])), bottom = Math.min(h, d2i(y[Math.min(y.length - 1, row + 3)]));
    const center = f(x[boundary] + this.bandOffset(boundary, Math.min(row, y.length - 2)));
    // The table's right edge has no day beyond it: at the bottom of a bent page it bows outwards (25/10, rows
    // 42–51: day 31 "S10" cut to "S1"), so it is searched up to 60 % of a cell to the right.
    const reach = boundary === x.length - 1 ? Math.max(radius, roundF(f(spacing * f(.6)))) : radius;
    let best = FLOAT_MAX, result = center;
    for (let dx = -radius; dx <= reach; dx++) {
      const xx = roundF(center) + dx; if (xx < 0 || xx >= w) continue;
      let sum = 0, n = 0;
      for (let yy = top; yy < bottom; yy++) { sum = f(sum + g[yy * w + xx]); n++; }
      const scale = dx > 0 ? reach : radius; const score = f(f(sum / Math.max(1, n)) + f(12 * dx * dx / f(scale * scale)));
      if (score < best) { best = score; result = xx; }
    }
    return result;
  }
  cell(col, row) { return this.cellFrom(col, row, this.source); }
  cellFrom(col, row, input) {
    const x = this.x, y = this.y, rowSlopes = this.rowSlopes;
    if (this.pipeGeometry != null) return this.pipeCell(col, row, input);
    const padX = col < 2 ? 2 : f(.5), padY = Math.max(1, f(f(y[row + 1] - y[row]) * f(.07)));
    const left = f(this.columnBorder(col, row) + padX); let right = f(this.columnBorder(col + 1, row) - padX); const mid = f(this.table.getWidth() / 2);
    // The last day: at the bottom of a tilted photo the table outline's right side runs inside the printed
    // border (25/10, rows 42–51: day 31 "S10" cut to "S1"). Half a cell more is taken from the photo itself;
    // beyond the border there is only paper.
    const extra = col + 1 === x.length - 1 && this.sourceToTable != null ? f(f(x[col + 1] - x[col]) * f(.5)) : 0; right = f(right + extra);
    // STT and name cells: at the top of a bent page the ruling under a name can sit half a row from the table-wide
    // line (25/10: row 2's name cut to its lower half, 13 px). Searched within ±50 % of the row — never as far
    // as the next ruling. Day cells keep ±30 %.
    let tl, tr, bl, br;
    if (this.traces != null) {
      // The cell is cut along the printed rules as followed on the page (a bent or re-shot photo).
      tl = f(this.ruleY(row, left) + padY); tr = f(this.ruleY(row, right) + padY); bl = f(this.ruleY(row + 1, left) - padY); br = f(this.ruleY(row + 1, right) - padY);
    } else {
      const radius = f(f(y[row + 1] - y[row]) * (col < 2 ? f(.5) : f(.30))), topAdjust = this.refine(col, row, radius), bottomAdjust = this.refine(col, row + 1, radius);
      tl = f(f(f(y[row] + topAdjust) + padY) + f(rowSlopes[row] * f(left - mid))); tr = f(f(f(y[row] + topAdjust) + padY) + f(rowSlopes[row] * f(right - mid)));
      bl = f(f(f(y[row + 1] + bottomAdjust) - padY) + f(rowSlopes[row + 1] * f(left - mid))); br = f(f(f(y[row + 1] + bottomAdjust) - padY) + f(rowSlopes[row + 1] * f(right - mid)));
    }
    const width = Math.max(1, roundF(f(right - left))), height = Math.max(1, roundF(f(f(f(f(bl + br) - tl) - tr) / 2)));
    const cell = Bitmap.createBitmap(width, height, ARGB_8888); const canvas = new Canvas(cell); canvas.drawColor(Color.WHITE);
    const matrix = new Matrix(); matrix.setPolyToPoly(Float32Array.of(left, tl, right, tr, right, br, left, bl), 0, Float32Array.of(0, 0, width, 0, width, height, 0, height), 0, 4);
    if (this.sourceToTable != null) {
      const direct = new Matrix(); let transform = this.sourceToTable;
      if (input !== this.source) { transform = tableTransform(input, this.normalizedCorners, this.table.getWidth(), this.table.getHeight()); }
      direct.setConcat(matrix, transform); canvas.drawBitmap(input, direct, new Paint(Paint.FILTER_BITMAP_FLAG));
      if (extra > 0) return GridVision.cutAtBorder(cell, roundF(f(f(right - extra) - left)));
    } else canvas.drawBitmap(this.table, matrix, new Paint(Paint.FILTER_BITMAP_FLAG)); return cell;
  }
  /** Columns from..to (exclusive) of one row as a single cell: a pipe cell split by a stray rule (team T5). */
  cellSpan(from, to, row) { return this.pipeGeometry != null ? this.pipeCell(from, to, row, this.source) : this.cellFrom(from, row, this.source); }
  /** Java's private pipeCell overloads: (col, row, input) | (col, end, row, input[, verticalExpansion[, leftExpansion]]). */
  pipeCell(...a) {
    if (a.length === 3) return this.pipeCell(a[0], a[0] + 1, a[1], a[2]);
    const [col, end, row, input, verticalExpansion = 0, leftExpansion = 0] = a;
    const pg = this.pipeGeometry, source = this.source, table = this.table;
    const tl = pg.corner(col, row), tr = pg.corner(end, row), br = pg.corner(end, row + 1), bl = pg.corner(col, row + 1);
    const q = Grid.contextNameQuad(tl, tr, br, bl, verticalExpansion, leftExpansion);
    // Keep the working scan's resolution when extracting cells, instead of
    // shrinking tiny letters back to the 1600 px geometry preview.
    const scale = Math.max(1, f(source.getWidth() / table.getWidth()));
    const w = Math.max(1, roundF(f(f(f(distance(q, 0, 2) + distance(q, 6, 4)) * scale) / 2))), h = Math.max(1, roundF(f(f(f(distance(q, 0, 6) + distance(q, 2, 4)) * scale) / 2)));
    const cell = Bitmap.createBitmap(w, h, ARGB_8888); const canvas = new Canvas(cell); canvas.drawColor(Color.WHITE); const local = new Matrix(); local.setPolyToPoly(q, 0, Float32Array.of(0, 0, w, 0, w, h, 0, h), 0, 4); const direct = new Matrix(); direct.setConcat(local, input === source ? this.sourceToTable : tableTransform(input, this.normalizedCorners, table.getWidth(), table.getHeight())); canvas.drawBitmap(input, direct, new Paint(Paint.FILTER_BITMAP_FLAG)); return cell;
  }
  /** One bounded alternate view for an unresolved name; the day/pipe cells keep their original crop. */
  expandedNameCell(row) { return this.pipeCell(1, 2, row, this.source, f(.25)); }
  /** A second unresolved-name view can recover initials lost at a bowed left boundary. */
  leftContextNameCell(row) { return this.pipeCell(1, 2, row, this.source, f(.25), f(.25)); }
  static expandedNameQuad(tl, tr, br, bl, expansion) {
    const fraction = Number.isFinite(expansion) ? Math.max(0, Math.min(f(.25), expansion)) : 0;
    const left = f(Math.max(0, f(bl[1] - tl[1])) * fraction), right = f(Math.max(0, f(br[1] - tr[1])) * fraction);
    return Float32Array.of(f(tl[0] + 2), f(f(tl[1] + 2) - left), f(tr[0] - 2), f(f(tr[1] + 2) - right), f(br[0] - 2), f(f(br[1] - 2) + right), f(bl[0] + 2), f(f(bl[1] - 2) + left));
  }
  static contextNameQuad(tl, tr, br, bl, vertical, horizontal) {
    const q = Grid.expandedNameQuad(tl, tr, br, bl, vertical);
    const fraction = Number.isFinite(horizontal) ? Math.max(0, Math.min(f(.4), horizontal)) : 0;
    // Extrapolate along the measured top/bottom edges; the right edge stays inside the name column.
    q[0] -= f(f(tr[0] - tl[0]) * fraction); q[1] -= f(f(tr[1] - tl[1]) * fraction);
    q[6] -= f(f(br[0] - bl[0]) * fraction); q[7] -= f(f(br[1] - bl[1]) * fraction); return q;
  }
  /** Table corners as fractions of the source image (x0,y0,x1,y1,x2,y2,x3,y3), or null. */
  corners() { return this.normalizedCorners == null ? null : this.normalizedCorners.slice(); }
  headerY(x, y) { return this.pipeGeometry == null ? y : this.pipeGeometry.headerY(x, y); }
  headerX(x, y) { return this.pipeGeometry == null ? x : this.pipeGeometry.headerX(x, y); }
  /** Flattens a curved merged header without cutting characters at subcolumn edges. */
  headerStrip(row) {
    const x = this.x, y = this.y, pg = this.pipeGeometry;
    const width = this.table.getWidth() * 2, height = Math.max(48, roundF(f(f(y[row + 1] - y[row]) * 2)));
    const strip = Bitmap.createBitmap(width, height, ARGB_8888); const canvas = new Canvas(strip); canvas.drawColor(Color.WHITE);
    for (let col = 1; col < x.length - 1; col++) {
      const tl = pg.corner(col, row), tr = pg.corner(col + 1, row), br = pg.corner(col + 1, row + 1), bl = pg.corner(col, row + 1);
      const left = f(x[col] * 2), right = f(x[col + 1] * 2); const local = new Matrix(), direct = new Matrix();
      local.setPolyToPoly(Float32Array.of(tl[0], tl[1], tr[0], tr[1], br[0], br[1], bl[0], bl[1]), 0, Float32Array.of(left, 0, right, 0, right, height, left, height), 0, 4); direct.setConcat(local, this.sourceToTable);
      canvas.save(); canvas.clipRect(left, 0, right, height); canvas.drawBitmap(this.source, direct, new Paint(Paint.FILTER_BITMAP_FLAG)); canvas.restore();
    }
    return strip;
  }
  /** Read a merged day as one quadrilateral; splitting it at internal
   * subcolumns can cut/distort digits sitting directly on that boundary. */
  headerCell(start, end, row) {
    const pg = this.pipeGeometry;
    const tl = pg.corner(start, row), tr = pg.corner(end, row), br = pg.corner(end, row + 1), bl = pg.corner(start, row + 1);
    const from = Float32Array.of(f(tl[0] + 2), f(tl[1] + 2), f(tr[0] - 2), f(tr[1] + 2), f(br[0] - 2), f(br[1] - 2), f(bl[0] + 2), f(bl[1] - 2));
    const width = Math.max(1, roundF(f(distance(from, 0, 2) + distance(from, 6, 4)))), height = Math.max(1, roundF(f(distance(from, 0, 6) + distance(from, 2, 4))));
    const cell = Bitmap.createBitmap(width, height, ARGB_8888); const canvas = new Canvas(cell); canvas.drawColor(Color.WHITE); const local = new Matrix(), direct = new Matrix(); local.setPolyToPoly(from, 0, Float32Array.of(0, 0, width, 0, width, height, 0, height), 0, 4); direct.setConcat(local, this.sourceToTable); canvas.drawBitmap(this.source, direct, new Paint(Paint.FILTER_BITMAP_FLAG)); return cell;
  }
  headerSpans(strip) { return PipeHeaders.spans(this.borderStrengths(strip)); }
  /** All column segments between full-height header borders, including irregular widths. */
  headerSegments(strip) { return PipeHeaders.segments(this.borderStrengths(strip)); }
  borderStrengths(strip) {
    const x = this.x;
    const w = strip.getWidth(), h = strip.getHeight(); const pixels = new Int32Array(w * h); strip.getPixels(pixels, 0, w, 0, 0, w, h); const strengths = new Float32Array(x.length);
    const from = Math.max(2, roundF(f(h * f(.14)))), to = f(h * f(.87)), gapTop = f(h * f(.32)), gapBottom = f(h * f(.68));
    for (let c = 2; c < x.length - 1; c++) {
      const mid = roundF(f(x[c] * 2)); let hits = 0, total = 0;
      for (let yy = from; yy < to; yy++) {
        if (yy > gapTop && yy < gapBottom) continue;
        let darkest = 255; for (let dx = -3; dx <= 3; dx++) { const xx = Math.max(0, Math.min(w - 1, mid + dx)); darkest = Math.min(darkest, gray(pixels[yy * w + xx])); }
        const left = gray(pixels[yy * w + Math.max(0, mid - 8)]), right = gray(pixels[yy * w + Math.min(w - 1, mid + 8)]);
        if (((left + right) >> 1) - darkest > 30) hits++; total++;
      }
      strengths[c] = f(hits / Math.max(1, total));
    }
    return strengths;
  }
  headerBottom(row) { return Math.min(this.table.getHeight(), d2i(Math.ceil(this.pipeGeometry == null ? this.y[row] : f(this.pipeGeometry.maxY(row) + 2)))); }
}

function tableTransform(image, corners, w, h) {
  const from = new Float32Array(8); for (let i = 0; i < 8; i++) from[i] = f(corners[i] * (i % 2 === 0 ? image.getWidth() : image.getHeight()));
  const transform = new Matrix(); transform.setPolyToPoly(from, 0, Float32Array.of(2, 2, w - 3, 2, w - 3, h - 3, 2, h - 3), 0, 4); return transform;
}
/** Too few straight rulings (a bowed page, or a table that does not fill the photo): the table's own ruled region
 *  when found (26/10, the user's T5 and Tô Hoài photos), then the default outline and the same reaching 98.5 % of
 *  the height — the 90 % one cut the last two rows of the 25/10 T.T. Vinh sheet. */
function withRegion(region) {
  const defaults = [Float32Array.of(.015, .075, .985, .075, .985, .9, .015, .9), Float32Array.of(.015, .075, .985, .075, .985, .985, .015, .985)];
  return region == null ? defaults : [region, defaults[0], defaults[1]];
}
/** The outline from straight rulings across the photo, or null with fewer than 10 of them. */
function outlinesFromRules(g, w, h) {
  const stride = 2;
  const scores = new Float32Array(h), slopes = new Float32Array(h);
  // Speed-ups with the same results: slope·(x − w/2f) is computed once per slope and x (the float values Java
  // computes each time), the rounded row comes from floatRoundPlan, the dark test is stored per sampled x, and the
  // counts of one slope are summed for all y at once; the scores are then compared in Java's order (y, slope).
  const xs = []; for (let x = d2i(w * .035); x < w * .965; x += stride) xs.push(x);
  const n = xs.length, half = f(w / 2), slopeList = [], shifts = [];
  for (let slope = f(-.075); slope <= f(.0751); slope = f(slope + f(.003))) { slopeList.push(slope); const s = new Float32Array(n); for (let k = 0; k < n; k++) s[k] = f(slope * f(xs[k] - half)); shifts.push(s); }
  const dark = new Uint8Array(n * h); for (let k = 0; k < n; k++) for (let yy = 0; yy < h; yy++) dark[k * h + yy] = g[yy * w + xs[k]] < 145 ? 1 : 0;
  const hits = new Int32Array(h), total = new Int32Array(h);
  for (let si = 0; si < slopeList.length; si++) {
    const shift = shifts[si], { offset, careful } = floatRoundPlan(shift, h); hits.fill(0); total.fill(0);
    for (let k = 0; k < n; k++) {
      const base = k * h;
      if (careful[k]) { for (let y = 2; y < h - 2; y++) { const yy = roundF(f(y + shift[k])); if (yy < 0 || yy >= h) continue; hits[y] += dark[base + yy]; total[y]++; } continue; }
      const off = offset[k], from = Math.max(2, -off), to = Math.min(h - 2, h - off);
      for (let y = from; y < to; y++) { hits[y] += dark[base + y + off]; total[y]++; }
    }
    for (let y = 2; y < h - 2; y++) { const score = f(hits[y] / Math.max(1, total[y])); if (score > scores[y]) { scores[y] = score; slopes[y] = slopeList[si]; } }
  }
  const rows = TableLines.peaks(scores, f(.57), 3);
  // Too few straight rulings: the caller falls back to the ruled region and the default outlines (withRegion).
  if (rows.length < 10) return null;
  const top = rows[0], bottom = rows[rows.length - 1];
  let left = f(w * f(.015)), right = f(w * f(.985)), leftSlope = 0, rightSlope = 0; const mid = f((top + bottom) / 2);
  // Long vertical borders, independent of text and row shading.
  for (let side = 0; side < 2; side++) {
    const vertical = new Float32Array(w), angles = new Float32Array(w);
    for (let x = side === 0 ? 0 : d2i(w * .88); x < (side === 0 ? w * .09 : w); x++) {
      for (let slope = f(-.04); slope <= f(.0401); slope = f(slope + f(.002))) {
        let hits = 0, total = 0;
        for (let y = top + 2; y < bottom - 2; y += 2) { const xx = roundF(f(x + f(slope * f(y - mid)))); if (xx < 0 || xx >= w) continue; if (g[y * w + xx] < 145) hits++; total++; }
        const score = f(hits / Math.max(1, total));
        if (score > vertical[x]) { vertical[x] = score; angles[x] = slope; }
      }
    }
    const borders = TableLines.peaks(vertical, f(.54), 2);
    // On a darker re-shot photo the cell text beside the rules also scores over .54, so neighbouring rules
    // ran together into one peak and the outer rule was lost (25/10 work roster re-shot: day 31 cut off).
    // A rule standing out from the cells on both sides counts too; on the 4 original photos nothing changes.
    for (const x of GridVision.prominentPeaks(vertical, side === 0 ? 0 : d2i(w * .88), side === 0 ? f(w * f(.09)) : w)) if (!borders.includes(x)) borders.push(x);
    borders.sort((a, b) => a - b);
    if (borders.length > 0) { const chosen = side === 0 ? borders[0] : borders[borders.length - 1]; if (side === 0) { left = chosen; leftSlope = angles[chosen]; } else { right = chosen; rightSlope = angles[chosen]; } }
  }
  const centers = [left, right, right, left], vs = [leftSlope, rightSlope, rightSlope, leftSlope];
  const result = new Float32Array(8);
  for (let i = 0; i < 4; i++) { const y0 = i < 2 ? top : bottom, hs = slopes[y0]; const yy = f(f(y0 + f(hs * f(f(centers[i] - f(vs[i] * mid)) - half))) / f(1 - f(hs * vs[i]))); const xx = f(centers[i] + f(vs[i] * f(yy - mid))); result[2 * i] = f(xx / w); result[2 * i + 1] = f(yy / h); }
  const band = GridVision.separateRuleBand(rows, slopes, g, w, h);
  return band == null ? [result] : [band, result];
}
function index(line, along, w, horizontal) { return horizontal ? line * w + along : along * w + line; }
/** Pixels of a thin-rule mask kept only in runs of 6 or more along rows (horizontal) or columns, a single missing
 *  pixel not breaking the run. */
function runsOf(m, w, h, horizontal) {
  const out = new Uint8Array(w * h); const lines = horizontal ? h : w, len = horizontal ? w : h;
  for (let line = 0; line < lines; line++) {
    let j = 0;
    while (j < len) {
      if (!m[index(line, j, w, horizontal)]) { j++; continue; } let k = j, last = j;
      while (k < len && (m[index(line, k, w, horizontal)] || k + 1 < len && m[index(line, k + 1, w, horizontal)])) { if (m[index(line, k, w, horizontal)]) last = k; k++; }
      if (last - j + 1 >= 6) for (let t = j; t <= last; t++) out[index(line, t, w, horizontal)] = 1;
      j = k + 1;
    }
  }
  return out;
}
/** Share of 120 points on segment a–b, shifted by (dx, dy), that fall on the mask. */
function stripDensity(m, w, h, a, b, dx, dy) {
  let hits = 0, total = 0;
  for (let i = 0; i < 120; i++) {
    const t = f(i / 119); const x = roundF(f(f(a[0] + f(f(b[0] - a[0]) * t)) + dx)), y = roundF(f(f(a[1] + f(f(b[1] - a[1]) * t)) + dy));
    if (x < 0 || x >= w || y < 0 || y >= h) continue; total++; if (m[y * w + x]) hits++;
  }
  return total === 0 ? 0 : f(hits / total);
}
/** d = c0 + c1·t by least squares, refitted up to 4 times without points over max(1.5, 2.5 × median residual). */
function robustLine(points) {
  let p = points.slice(); let c0 = 0, c1 = 0;
  for (let round = 0; round < 4; round++) {
    let st = 0, sd = 0, stt = 0, std = 0; const n = p.length; for (const v of p) { st += v[0]; sd += v[1]; stt += f(v[0] * v[0]); std += f(v[0] * v[1]); }
    const den = n * stt - st * st; c1 = den === 0 ? 0 : f((n * std - st * sd) / den); c0 = f((sd - c1 * st) / n);
    const r = new Float32Array(n); for (let i = 0; i < n; i++) r[i] = Math.abs(f(p[i][1] - f(c0 + f(c1 * p[i][0])))); const sorted = r.slice().sort();
    const limit = Math.max(f(1.5), f(sorted[n >> 1] * f(2.5))); const keep = []; for (let i = 0; i < n; i++) if (r[i] <= limit) keep.push(p[i]);
    if (keep.length === n || keep.length < 6) break; p = keep;
  }
  return [c0, c1];
}
/** The crossing point of two lines, each given by two points. */
function meet(e1, e2) {
  const dx1 = f(e1[1][0] - e1[0][0]), dy1 = f(e1[1][1] - e1[0][1]), dx2 = f(e2[1][0] - e2[0][0]), dy2 = f(e2[1][1] - e2[0][1]); const den = f(f(dx1 * dy2) - f(dy1 * dx2));
  if (Math.abs(den) < f(1e-6)) return e1[0].slice();
  const t = f(f(f(f(e2[0][0] - e1[0][0]) * dy2) - f(f(e2[0][1] - e1[0][1]) * dx2)) / den); return Float32Array.of(f(e1[0][0] + f(dx1 * t)), f(e1[0][1] + f(dy1 * t)));
}
/** The four unit-free side vectors of an outline: u along the top/bottom, v along the left/right (Java's inline sums). */
const across = q => [f(f(f(f(q[1][0] - q[0][0]) + q[2][0]) - q[3][0]) / 2), f(f(f(f(q[1][1] - q[0][1]) + q[2][1]) - q[3][1]) / 2)];
const down = q => [f(f(f(f(q[3][0] - q[0][0]) + q[2][0]) - q[1][0]) / 2), f(f(f(f(q[3][1] - q[0][1]) + q[2][1]) - q[1][1]) / 2)];
const unit = ([x, y]) => { const n = f(Math.hypot(x, y)); return [f(x / n), f(y / n)]; };
/** Moving the sides outwards keeps their angle, so a side could cut across the table (26/10 night: on the T5 photo
 *  the top side ran a row low on the right and cut off the dates 12–16). Each side is moved onto the outermost
 *  rule found within 18 px of it at 46 points along it — thin horizontal rules for top and bottom, vertical ones
 *  for left and right — and those offsets are fitted as a straight line, dropping points 2.5× the median residual
 *  away (at least 1.5 px). A side with fewer than 8 points stays where it is. */
function refineSides(q, H, V, w, h) {
  const [ux, uy] = unit(across(q)), [vx, vy] = unit(down(q));
  const sides = [[0, 1], [1, 2], [3, 2], [0, 3]], out = [[-vx, -vy], [ux, uy], [vx, vy], [-ux, -uy]], masks = [H, V, H, V];
  const edges = new Array(4);
  for (let s = 0; s < 4; s++) {
    const a = q[sides[s][0]], b = q[sides[s][1]]; const points = [];
    for (let k = 0; k < 46; k++) {
      const t = f(f(.04) + f(f(k * f(.92)) / 45)), px = f(a[0] + f(f(b[0] - a[0]) * t)), py = f(a[1] + f(f(b[1] - a[1]) * t));
      for (let d = 18; d >= -18; d--) { const x = roundF(f(px + f(out[s][0] * d))), y = roundF(f(py + f(out[s][1] * d))); if (x >= 0 && x < w && y >= 0 && y < h && masks[s][y * w + x]) { points.push([t, d]); break; } }
    }
    let c0 = 0, c1 = 0; if (points.length >= 8) { const fit = robustLine(points); c0 = fit[0]; c1 = fit[1]; }
    const c01 = f(c0 + c1);
    edges[s] = [[f(a[0] + f(out[s][0] * c0)), f(a[1] + f(out[s][1] * c0))], [f(b[0] + f(out[s][0] * c01)), f(b[1] + f(out[s][1] * c01))]];
  }
  return [meet(edges[3], edges[0]), meet(edges[1], edges[0]), meet(edges[1], edges[2]), meet(edges[3], edges[2])];
}
/** ruledRegion(g, w, h, rectangle): the rectangle preserves the extrema of a bent table before fitting its four
 *  sides. It is an independent pipe candidate: a straight fitted right side can clip the last printed date. */
function ruledRegion(g, w, h, rectangle) {
  const hor = new Uint8Array(w * h), ver = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = g[y * w + x];
    const up = y >= 3 ? g[(y - 3) * w + x] : 255, dn = y + 3 < h ? g[(y + 3) * w + x] : 255, lf = x >= 3 ? g[y * w + x - 3] : 255, rt = x + 3 < w ? g[y * w + x + 3] : 255;
    hor[y * w + x] = v < up - 18 && v < dn - 18 ? 1 : 0; ver[y * w + x] = v < lf - 18 && v < rt - 18 ? 1 : 0;
  }
  const H = runsOf(hor, w, h, true), V = runsOf(ver, w, h, false);
  const hm = new Uint8Array(w * h), vm = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; hm[i] = H[i] || y > 0 && H[i - w] ? 1 : 0; vm[i] = V[i] || x > 0 && V[i - 1] ? 1 : 0; }
  const bw = idiv(w, 8) + 1, bh = idiv(h, 8) + 1; const blocks = new Int32Array(bw * bh); const crossX = [], crossY = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if ((H[i] || H[i - w] || H[i + w]) && (V[i] || V[i - 1] || V[i + 1])) { crossX.push(x); crossY.push(y); blocks[(y >> 3) * bw + (x >> 3)]++; }
  }
  const label = new Int32Array(blocks.length); let labels = 0, bestLabel = 0, bestCount = 0; const stack = [];
  for (let b = 0; b < blocks.length; b++) {
    if (blocks[b] === 0 || label[b] !== 0) continue; labels++; label[b] = labels; stack.push(b); let count = 0;
    while (stack.length > 0) {
      const c = stack.pop(); count += blocks[c]; const cy = (c / bw) | 0, cx = c % bw;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const ny = cy + dy, nx = cx + dx; if (ny < 0 || ny >= bh || nx < 0 || nx >= bw) continue; const n = ny * bw + nx;
        if (blocks[n] > 0 && label[n] === 0) { label[n] = labels; stack.push(n); }
      }
    }
    if (count > bestCount) { bestCount = count; bestLabel = labels; }
  }
  if (bestCount < 200) return null;
  let tl = null, tr = null, br = null, bl = null, minX = w, minY = h, maxX = 0, maxY = 0;
  for (let k = 0; k < crossX.length; k++) {
    const cx = crossX[k], cy = crossY[k];
    if (label[(cy >> 3) * bw + (cx >> 3)] !== bestLabel) continue; const s = cx + cy, d = cx - cy;
    minX = Math.min(minX, cx); maxX = Math.max(maxX, cx); minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
    if (tl == null || s < tl[0] + tl[1]) tl = Float32Array.of(cx, cy); if (br == null || s > br[0] + br[1]) br = Float32Array.of(cx, cy);
    if (tr == null || d > tr[0] - tr[1]) tr = Float32Array.of(cx, cy); if (bl == null || d < bl[0] - bl[1]) bl = Float32Array.of(cx, cy);
  }
  let q = [tl, tr, br, bl];
  for (let round = 0; round < 3; round++) {
    const [ux, uy] = unit(across(q)), [vx, vy] = unit(down(q));
    // left (q0,q3) and right (q1,q2) cross horizontal rules; top (q0,q1) and bottom (q3,q2) cross vertical ones
    const sides = [[0, 3], [1, 2], [0, 1], [3, 2]], out = [[-ux, -uy], [ux, uy], [-vx, -vy], [vx, vy]];
    for (let s = 0; s < 4; s++) {
      const a = q[sides[s][0]], b = q[sides[s][1]]; const m = s < 2 ? hm : vm; let best = 0, miss = 0;
      for (let k = 1; k <= 200 && miss < 8; k++) { if (stripDensity(m, w, h, a, b, f(out[s][0] * k), f(out[s][1] * k)) >= f(.06)) { best = k; miss = 0; } else miss++; }
      for (const p of sides[s]) { q[p] = Float32Array.of(f(q[p][0] + f(out[s][0] * best)), f(q[p][1] + f(out[s][1] * best))); }
    }
  }
  q = refineSides(q, H, V, w, h);
  // A bowed table is no quadrilateral: a fitted side cuts a bent top row (26/10 night, the Tô Hoài photo: the
  // dates of days 1 and 3 half cut off). The outline keeps a margin — 3 % of its height above, 1 % below and on
  // each side — and the table's own rules are found inside it as for any outline.
  {
    const [ux, uy] = across(q), [vx, vy] = down(q);
    const p01 = f(.01), p03 = f(.03), m01 = f(-.01);
    const move = [[f(f(m01 * ux) - f(p03 * vx)), f(f(m01 * uy) - f(p03 * vy))], [f(f(p01 * ux) - f(p03 * vx)), f(f(p01 * uy) - f(p03 * vy))], [f(f(p01 * ux) + f(p01 * vx)), f(f(p01 * uy) + f(p01 * vy))], [f(f(m01 * ux) + f(p01 * vx)), f(f(m01 * uy) + f(p01 * vy))]];
    for (let i = 0; i < 4; i++) q[i] = Float32Array.of(f(q[i][0] + move[i][0]), f(q[i][1] + move[i][1]));
  }
  if (rectangle) {
    let l = minX, r = maxX, t = minY, b = maxY; for (const point of q) { l = Math.min(l, point[0]); r = Math.max(r, point[0]); t = Math.min(t, point[1]); b = Math.max(b, point[1]); }
    const dx = f(f(r - l) * f(.02)), dy = f(f(b - t) * f(.03)); l = Math.max(0, f(f(l - dx) / w)); r = Math.min(1, f(f(r + dx) / w)); t = Math.max(0, f(f(t - dy) / h)); b = Math.min(1, f(f(b + dy) / h));
    return Float32Array.of(l, t, r, t, r, b, l, b);
  }
  const result = new Float32Array(8); for (let i = 0; i < 4; i++) { result[2 * i] = Math.max(0, Math.min(1, f(q[i][0] / w))); result[2 * i + 1] = Math.max(0, Math.min(1, f(q[i][1] / h))); }
  return result;
}

export class GridVision {
  static Grid = Grid;
  /** A separate 4K working image. Original pixels and their URI are never overwritten. */
  static prepareScan(original) {
    const scale = f(3840 / Math.max(original.getWidth(), original.getHeight()));
    const scaled = Bitmap.createScaledBitmap(original, Math.max(1, roundF(f(original.getWidth() * scale))), Math.max(1, roundF(f(original.getHeight() * scale))), true);
    const out = Bitmap.createBitmap(scaled.getWidth(), scaled.getHeight(), ARGB_8888);
    const w = scaled.getWidth(), h = scaled.getHeight(); const line = new Int32Array(w);
    // The grey of the three rows (y−1, y, y+1, clamped), each row read and converted once.
    const pixels = new Int32Array(w); const grayRow = r => { scaled.getPixels(pixels, 0, w, 0, r, w, 1); const g = new Int32Array(w); for (let x = 0; x < w; x++) g[x] = gray(pixels[x]); return g; };
    let above = grayRow(0), middle = above, below = grayRow(Math.min(h - 1, 1));
    for (let y = 0; y < h; y++) {
      if (y > 0) { above = middle; middle = below; below = y + 1 <= h - 1 ? grayRow(y + 1) : middle; }
      for (let x = 0; x < w; x++) {
        const center = middle[x], blur = ((above[x] + below[x] + middle[Math.max(0, x - 1)] + middle[Math.min(w - 1, x + 1)]) / 4) | 0;
        // Bounded unsharp mask strengthens existing strokes without synthesizing new letters.
        const value = Math.max(0, Math.min(255, center + Math.max(-24, Math.min(24, (center - blur) * 2))));
        line[x] = Color.rgb(value, value, value);
      }
      out.setPixels(line, 0, w, 0, y, w, 1);
    }
    if (scaled !== original) scaled.recycle(); return out;
  }
  /** The widened last-day crop ends just before the printed right border: the first column, from three quarters of
   *  the outlined width on, that is dark over 90 % of the cell height while the paper 3 px to its left is not (a
   *  letter is never that tall; an evenly dark fill has no such edge and is kept whole). Without the border inside,
   *  "S10" is no longer read as "S10i" and an empty day is blank again (25/10 rows 43, 61). */
  static cutAtBorder(cell, outlinedWidth) {
    const w = cell.getWidth(), h = cell.getHeight(); if (w < 8 || h < 8) return cell; const px = new Int32Array(w * h); cell.getPixels(px, 0, w, 0, 0, w, h);
    const top = roundF(f(h * f(.08))), bottom = roundF(f(h * f(.92))), need = roundF(f((bottom - top) * f(.9))); const dark = new Int32Array(w);
    for (let x = 0; x < w; x++) for (let y = top; y < bottom; y++) if (gray(px[y * w + x]) < 130) dark[x]++;
    for (let x = Math.max(3, roundF(f(outlinedWidth * f(.75)))); x < w; x++) if (dark[x] >= need && dark[x - 3] < f(need * f(.6))) {
      const cut = Bitmap.createBitmap(cell, 0, 0, x, h); cell.recycle(); return cut;
    }
    return cell;
  }
  /** A name cell that also holds the STT column (its dividing rule was not found, 25/10 T.T. Vinh sheet: "12 | Lê
   *  Văn Duy"): everything left of a rule that crosses the cell from its top edge to its bottom edge (90 % of
   *  2–98 % of the height, possibly leaning on a curved page) is cut away. A letter always leaves paper above or
   *  below it, so even the stem of a bold "T" does not qualify (checked on all 96 name cells of 25/10: 15/16 Vinh
   *  cells trimmed cleanly, no other cell touched). A cell without such a rule is returned unchanged. */
  static trimLeftRule(cell) {
    const w = cell.getWidth(), h = cell.getHeight(); if (w < 20 || h < 8) return cell; const px = new Int32Array(w * h); cell.getPixels(px, 0, w, 0, 0, w, h);
    const top = Math.max(0, roundF(f(h * f(.02)))), bottom = Math.min(h, roundF(f(h * f(.98)))), need = roundF(f((bottom - top) * f(.9))); let cut = -1; const mid = f((top + bottom) / 2);
    for (let x = Math.max(2, idiv(w, 12)); x < f(w * f(.65)); x++) for (let slope = f(-.4); slope <= f(.401); slope = f(slope + f(.05))) {
      let dark = 0, right = -1, inside = true;
      for (let y = top; y < bottom && inside; y++) { const xx = roundF(f(x + f(slope * f(y - mid)))); if (xx < 0 || xx >= w) { inside = false; break; } if (gray(px[y * w + xx]) < 130) dark++; right = Math.max(right, xx); }
      if (inside && dark >= need) cut = Math.max(cut, right);
    }
    if (cut < 0 || w - cut < idiv(w, 4)) return cell;
    const trimmed = Bitmap.createBitmap(cell, cut + 2, 0, w - cut - 2, h); cell.recycle(); return trimmed;
  }
  static corners(original) { return GridVision.cornerSet(original)[0]; }
  /** cornerSet(Bitmap original) | cornerSet(int[] g, int w, int h). Candidate table outlines: a staff band separated
   *  from a notes frame (3.7), the straight rulings, or the ruled region/default outlines on a bowed page. The pipe
   *  reader validates dates and identities. The (g, w, h) form takes the grey photo scaled to at most 760 px wide
   *  (the PC tests' entry). */
  static cornerSet(original, w, h) {
    if (arguments.length === 3) { const g = original; const rules = outlinesFromRules(g, w, h); return rules != null ? rules : withRegion(ruledRegion(g, w, h, false)); }
    const scale = Math.min(1, f(760 / original.getWidth()));
    const b = Bitmap.createScaledBitmap(original, roundF(f(original.getWidth() * scale)), roundF(f(original.getHeight() * scale)), true);
    w = b.getWidth(); h = b.getHeight(); const pixels = new Int32Array(w * h); b.getPixels(pixels, 0, w, 0, 0, w, h);
    const g = new Int32Array(pixels.length); for (let i = 0; i < g.length; i++) g[i] = gray(pixels[i]);
    const rules = outlinesFromRules(g, w, h); if (rules != null) return rules;
    // The ruled region is measured on an area average of the photo: Android's filtered scaling samples 2×2 pixels
    // and breaks the thin rules (26/10: on the emulator the T5 outline lost day 16).
    return withRegion(ruledRegion(GridVision.areaGray(original, w, h), w, h, false));
  }
  /** Pipe sheets can contain a bowed staff table above an unrelated notes paragraph. Straight rules
   *  from its upper rows must not suppress the independent intersection-based table outline. Keep
   *  every existing candidate as a fallback; dates and row identities still validate the result.
   *  Work-roster corners retain their existing selection policy. */
  static pipeCornerSet(original) {
    const existing = GridVision.cornerSet(original); const scale = Math.min(1, f(760 / original.getWidth()));
    const w = roundF(f(original.getWidth() * scale)), h = roundF(f(original.getHeight() * scale));
    const grayPixels = GridVision.areaGray(original, w, h); const box = ruledRegion(grayPixels, w, h, true), region = ruledRegion(grayPixels, w, h, false);
    // Preserve the first existing measured outline on the already supported sheets. New
    // curved-table candidates supplement it; they must not delay a complete old layout.
    const all = []; if (existing.length > 0) all.push(existing[0]);
    if (region != null) {
      const padded = region.slice(); const ux = f(f(f(f(region[2] - region[0]) + region[4]) - region[6]) * f(.025)), uy = f(f(f(f(region[3] - region[1]) + region[5]) - region[7]) * f(.025));
      for (let point = 0; point < 4; point++) { const sign = point === 0 || point === 3 ? -1 : 1; padded[point * 2] = Math.max(0, Math.min(1, f(padded[point * 2] + f(sign * ux)))); padded[point * 2 + 1] = Math.max(0, Math.min(1, f(padded[point * 2 + 1] + f(sign * uy)))); }
      all.push(padded); all.push(region);
    }
    if (box != null) all.push(box);
    all.push(...existing); const unique = [];
    for (const c of all) { let duplicate = false; for (const prior of unique) { let same = true; for (let i = 0; i < 8; i++) if (Math.abs(f(c[i] - prior[i])) > f(.003)) same = false; if (same) duplicate = true; } if (!duplicate) unique.push(c); }
    return unique;
  }
  /** Grey (R·30+G·59+B·11)/100 of the photo averaged over the source pixels of each of w×h cells. */
  static areaGray(src, w, h) {
    const sw = src.getWidth(), sh = src.getHeight(); const sum = new Float64Array(w * h); const count = new Int32Array(w * h), row = new Int32Array(sw), cellX = new Int32Array(sw);
    for (let x = 0; x < sw; x++) cellX[x] = Math.min(w - 1, Math.floor(x * w / sw));
    for (let y = 0; y < sh; y++) {
      src.getPixels(row, 0, sw, 0, y, sw, 1); const base = Math.min(h - 1, Math.floor(y * h / sh)) * w;
      for (let x = 0; x < sw; x++) { const c = row[x], i = base + cellX[x]; sum[i] += ((((c >> 16) & 255) * 30 + ((c >> 8) & 255) * 59 + (c & 255) * 11) / 100) | 0; count[i]++; }
    }
    const g = new Int32Array(w * h); for (let i = 0; i < g.length; i++) g[i] = Math.floor(sum[i] / Math.max(1, count[i])); return g;
  }
  /** 3.7: a notes box has long borders but no repeated staff columns. Keep the largest connected run of
   *  rulings as an additional candidate when an isolated border lies outside it. Leave space around
   *  the rules so neither the date header nor a clipped STT border is cut by rectification. The
   *  original outline remains available; headers and staff identities still validate the candidate. */
  static separateRuleBand(rows, slopes, grayPixels, w, h) {
    if (rows.length < 11) return null;
    const gaps = new Int32Array(rows.length - 1); for (let i = 0; i < gaps.length; i++) gaps[i] = rows[i + 1] - rows[i];
    const sorted = gaps.slice().sort(); const step = sorted[sorted.length >> 1];
    let begin = 0, bestBegin = 0, bestEnd = 0;
    const ts = []; for (let k = 0; k < 12; k++) ts.push(f(f(k + f(.5)) / 12));
    for (let i = 0; i < rows.length - 1; i++) {
      const top = rows[i], bottom = rows[i + 1]; const support = new Float32Array(w); const middle = f((top + bottom) / 2);
      // A staff band is crossed by many column rules. A paragraph frame has only two sides.
      // Check all the way between rows, so a missed faint horizontal rule cannot split the table.
      for (let x = 2; x < w - 2; x++) for (let tilt = f(-.04); tilt <= f(.0401); tilt = f(tilt + f(.02))) {
        let hits = 0;
        for (let k = 0; k < 12; k++) {
          const t = ts[k]; const yy = roundF(f(top + f((bottom - top) * t))), xx = roundF(f(x + f(tilt * f(yy - middle))));
          if (xx >= 0 && xx < w && yy >= 0 && yy < h && grayPixels[yy * w + xx] < 145) hits++;
        }
        support[x] = Math.max(support[x], f(hits / 12));
      }
      const staff = TableLines.peaks(support, f(.72), 2).length >= 8;
      if (!staff) { if (i + 1 - begin > bestEnd - bestBegin) { bestBegin = begin; bestEnd = i + 1; } begin = i + 1; }
    }
    if (rows.length - begin > bestEnd - bestBegin) { bestBegin = begin; bestEnd = rows.length; }
    if (bestEnd - bestBegin < 10 || bestEnd - bestBegin === rows.length) return null;
    const top = rows[bestBegin], bottom = rows[bestEnd - 1];
    const above = f(f(f(Math.abs(slopes[top]) * w) / 2) + f(step * f(.8))), below = f(f(f(Math.abs(slopes[bottom]) * w) / 2) + f(step * f(.8)));
    // Retain the heading when there is no separate frame above the table. Besides keeping
    // source context, its blank area prevents short text stems from imitating full column rules.
    const y0 = bestBegin === 0 ? 0 : Math.max(0, f(f(top - above) / h)), y1 = Math.min(1, f(f(bottom + below) / h));
    return Float32Array.of(0, y0, 1, y0, 1, y1, 0, y1);
  }
  static rectify(src, normalized) {
    const from = new Float32Array(8); for (let i = 0; i < 8; i++) from[i] = f(normalized[i] * (i % 2 === 0 ? src.getWidth() : src.getHeight()));
    const w = Math.min(1600, Math.max(1200, src.getWidth()));
    const sw = f(f(distance(from, 0, 2) + distance(from, 6, 4)) / 2), sh = f(f(distance(from, 0, 6) + distance(from, 2, 4)) / 2);
    const h = Math.min(5000, Math.max(400, roundF(f(f(w * sh) / Math.max(1, sw)))));
    const m = new Matrix(); m.setPolyToPoly(from, 0, Float32Array.of(2, 2, w - 3, 2, w - 3, h - 3, 2, h - 3), 0, 4);
    const out = Bitmap.createBitmap(w, h, ARGB_8888); const canvas = new Canvas(out); canvas.drawColor(Color.WHITE);
    canvas.drawBitmap(src, m, new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG)); return out;
  }
  /** The outline of a table that does not fill the photo (26/10, the user's T5 and Tô Hoài photos: the table is
   *  68–80 % of the width, with notes under it and other sheets beside it, its rules light grey and bowed). Thin
   *  rules are found locally — a pixel 18 levels darker than the pixels 3 px above and below (horizontal) or left
   *  and right (vertical), kept in runs of 6 px or more — and the table is the largest cluster of their crossings
   *  (8 px blocks joined across 2 blocks; text makes few crossings). Its extreme crossings give a first outline,
   *  whose sides are then moved outwards while the strip beside them still crosses rules (≥ 6 % of 120 samples,
   *  giving up after 8 px without): the wide name column joins the table, the gap before another sheet stops it.
   *  null when the cluster has fewer than 200 crossings. */
  static ruledRegion(g, w, h) { return ruledRegion(g, w, h, false); }
  /** Positions in [from, to) scoring at least .54 that are the highest within 2 px (the first of equals) and stand
   *  .12 above the lowest score within 6 px on each side (outside the array counts as 0). */
  static prominentPeaks(v, from, to) {
    const out = [];
    for (let x = from; x < to && x < v.length; x++) {
      if (v[x] < f(.54)) continue; let top = true;
      for (let k = Math.max(0, x - 2); k <= Math.min(v.length - 1, x + 2) && top; k++) if (k < x ? v[k] >= v[x] : v[k] > v[x]) top = false;
      if (!top) continue; let left = x > 0 ? FLOAT_MAX : 0, right = x < v.length - 1 ? FLOAT_MAX : 0;
      for (let k = Math.max(0, x - 6); k < x; k++) left = Math.min(left, v[k]);
      for (let k = x + 1; k <= Math.min(v.length - 1, x + 6); k++) right = Math.min(right, v[k]);
      if (f(v[x] - left) >= f(.12) && f(v[x] - right) >= f(.12)) out.push(x);
    }
    return out;
  }
  static analyze(image, corners, days) {
    const table = GridVision.rectify(image, corners); const w = table.getWidth(), h = table.getHeight();
    const pixels = new Int32Array(w * h); table.getPixels(pixels, 0, w, 0, 0, w, h);
    if (days === 0) {
      const g = new Int32Array(pixels.length); for (let i = 0; i < g.length; i++) g[i] = gray(pixels[i]); let geometry;
      // The uncropped photo (no table outline) keeps its straight columns; the curved retry is for an outline.
      // A full-width horizontal band only removes the notes/title; it has not straightened
      // the column perspective. Treat it like the whole photo rather than extending faint
      // vertical text strokes into extra curved day columns (3.7, full T5).
      const band = corners[0] === 0 && corners[2] === 1 && corners[4] === 1 && corners[6] === 0 && corners[1] === corners[3] && corners[5] === corners[7];
      const outline = !band;
      try { geometry = PipeGeometry.analyze(g, w, h, outline); } catch (e) { if (e instanceof IllegalArgumentException) table.recycle(); throw e; }
      const x = new Float32Array(geometry.columns.length), y = new Float32Array(geometry.rows.length); for (let i = 0; i < x.length; i++) x[i] = geometry.columns[i].center; for (let i = 0; i < y.length; i++) y[i] = geometry.rows[i].center;
      const grid = new Grid(table, x, y, new Float32Array(y.length)); grid.pipeGeometry = geometry; grid.source = image; grid.normalizedCorners = corners.slice(); grid.sourceToTable = tableTransform(image, corners, w, h); return grid;
    }
    // Grey of every pixel (the Java computes the same values per use and again below).
    const g = new Int32Array(pixels.length); for (let i = 0; i < pixels.length; i++) g[i] = gray(pixels[i]);
    const xs = new Float32Array(w), ys = new Float32Array(h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (g[y * w + x] < 150) { if (y > h * .03 && y < h * .97) xs[x]++; if (x > w * .02 && x < w * .98) ys[y]++; }
    }
    const xn = f(h * f(.94)), yn = f(w * f(.96));
    for (let x = 0; x < w; x++) xs[x] = f(xs[x] / xn);
    for (let y = 0; y < h; y++) ys[y] = f(ys[y] / yn);
    // Remove repeated vertical letter strokes: a border must continue through row whitespace.
    const window = Math.max(5, idiv(h, 100)); const solidNeed = f(window * f(.84));
    for (let x = 0; x < w; x++) {
      let dark = 0, solid = 0, total = 0;
      for (let y = 0; y < h; y++) {
        if (g[y * w + x] < 150) dark++;
        if (y >= window && g[(y - window) * w + x] < 150) dark--;
        if (y >= window && y > h * .03 && y < h * .97) { if (dark >= solidNeed) solid++; total++; }
      }
      xs[x] = f(solid / Math.max(1, total));
    }
    let xv = TableLines.peaks(xs, f(.35), Math.max(2, idiv(w, 800)));
    if (xv.length > 5) {
      const gaps = new Int32Array(xv.length - 1); for (let i = 0; i < gaps.length; i++) gaps[i] = xv[i + 1] - xv[i]; gaps.sort(); const minGap = f(gaps[gaps.length >> 1] * f(.5));
      xv.sort((a, b) => Float.compare(xs[b], xs[a])); const filtered = [];
      for (const candidate of xv) { let close = false; for (const selected of filtered) if (Math.abs(selected - candidate) < minGap) { close = true; break; } if (!close) filtered.push(candidate); }
      filtered.sort((a, b) => a - b); xv = filtered;
    }
    // A page can be slightly curved: each horizontal border gets its own angle. TableLines also finds the rules
    // of a darker re-shot photo, where shaded rows ran together with them.
    const found = TableLines.rows(g, w, h); const yv = found.lines; const rowAngles = found.slopes;
    if (BuildConfig.DEBUG && found.thin) Log.d('GridVision', 'rows found again as thin rules: ' + yv.length);
    if (xv.length < Math.min(idiv(days, 2) + 3, 10)) throw new JavaException('Chưa tách được đủ cột ngày trong ảnh này. Lịch đã lưu vẫn được giữ nguyên.');
    // Day columns after the wider name column; a missed rule is restored, unequal printed widths are fine.
    let x = DayColumns.select(xv, days, w);
    // A photo of part of the month (3.0): its own day columns; RosterReader reads which days they are.
    if (x == null) x = DayColumns.selectPartial(xv, days, w);
    if (x == null) {
      const thin = WorkColumns.rules(g, w, h);
      x = DayColumns.select(thin, days, w); if (x == null) x = DayColumns.selectPartial(thin, days, w);
      Log.d('GridVision', 'contrast work columns=' + listText(thin) + ' accepted=' + (x != null));
    }
    if (x == null) { Log.d('GridVision', 'x=' + listText(xv) + ' days=' + days); throw new JavaException('Các cột ngày trong ảnh chưa khớp ' + days + ' ngày của tháng đã chọn. Kiểm tra tháng/năm đã nhập. Lịch đã lưu vẫn được giữ nguyên.'); }
    if (yv.length < 5) throw new JavaException('Chưa tìm được các hàng nhân viên trong ảnh này. Lịch đã lưu vẫn được giữ nguyên.');
    const y = new Float32Array(yv.length), angles = new Float32Array(yv.length); for (let j = 0; j < y.length; j++) { y[j] = yv[j]; angles[j] = rowAngles[yv[j]]; }
    if (BuildConfig.DEBUG) Log.d('GridVision', 'selected x=' + floatsText(x) + ' y count=' + y.length);
    const grid = new Grid(table, x, y, angles); grid.source = image; grid.normalizedCorners = corners.slice(); grid.sourceToTable = tableTransform(image, corners, w, h);
    // Cells are cut along the rules as printed, also on the original photos (3.0, 26/10).
    grid.traceStep = TableLines.STEP; grid.traces = TableLines.follow(g, w, h, yv, rowAngles);
    if (BuildConfig.DEBUG) { let n = 0; for (const t of grid.traces) if (t != null) n++; Log.d('GridVision', 'rules followed along the page: ' + n + ' of ' + yv.length); }
    return grid;
  }
  /** Even shading without strokes; see CellInk.uniformTone for when it may count as blank. */
  static uniformTone(cell) { const w = cell.getWidth(), h = cell.getHeight(); const p = new Int32Array(w * h); cell.getPixels(p, 0, w, 0, 0, w, h); return CellInk.uniformTone(p, w, h); }
  /** A white or gray empty fill means rest; residual strokes remain uncertain for OCR. */
  static clearlyBlank(cell) {
    const w = cell.getWidth(), h = cell.getHeight(); const p = new Int32Array(w * h); cell.getPixels(p, 0, w, 0, 0, w, h);
    return CellInk.clearlyBlank(p, w, h);
  }
  static enhance(cell) {
    const w = cell.getWidth(), h = cell.getHeight(); const pixels = new Int32Array(w * h), histogram = new Int32Array(256); cell.getPixels(pixels, 0, w, 0, 0, w, h);
    for (const p of pixels) histogram[gray(p)]++;
    let low = 0, high = 255, sum = 0; for (let i = 0; i < 256; i++) { sum += histogram[i]; if (sum >= pixels.length * .10) { low = i; break; } }
    sum = 0; for (let i = 0; i < 256; i++) { sum += histogram[i]; if (sum >= pixels.length * .80) { high = i; break; } }
    if (high - low < 25) return cell;
    for (let i = 0; i < pixels.length; i++) { const g = Math.max(0, Math.min(255, idiv((gray(pixels[i]) - low) * 255, high - low))); pixels[i] = Color.rgb(g, g, g); }
    // Only remove a border if it spans almost the full cell height/width at its outer edge.
    for (let x = 0; x < w; x++) if (x < 2 || x >= w - 2) { let hits = 0; for (let y = 0; y < h; y++) if (gray(pixels[y * w + x]) < 110) hits++; if (hits > h * .75) for (let y = 0; y < h; y++) pixels[y * w + x] = Color.WHITE; }
    for (let y = 0; y < h; y++) if (y < 2 || y >= h - 2) { let hits = 0; for (let x = 0; x < w; x++) if (gray(pixels[y * w + x]) < 110) hits++; if (hits > w * .75) for (let x = 0; x < w; x++) pixels[y * w + x] = Color.WHITE; }
    return Bitmap.createBitmap(pixels, w, h, ARGB_8888);
  }
  static enlarge(cell, width, height) {
    const out = Bitmap.createBitmap(width, height, ARGB_8888); const c = new Canvas(out); c.drawColor(Color.WHITE);
    const scale = Math.min(f(f(width - 24) / cell.getWidth()), f(f(height - 20) / cell.getHeight()));
    const dw = f(cell.getWidth() * scale), dh = f(cell.getHeight() * scale);
    c.drawBitmap(cell, null, new RectF(f(f(width - dw) / 2), f(f(height - dh) / 2), f(f(width + dw) / 2), f(f(height + dh) / 2)), new Paint(Paint.FILTER_BITMAP_FLAG)); return out;
  }
  /** Remove cell rules, stretch contrast, then offer sharpened / thresholded OCR views. */
  static scanCell(source, mode) {
    // 27/10: two rules meeting at the fold of the August Tô Hoài photo cut a cell 1 px high, and the rule scan below
    // read past its pixels (index error, the photo lost). Such a sliver has nothing to read.
    if (source.getWidth() < 6 || source.getHeight() < 6) return source.copy(ARGB_8888, false);
    const contrast = GridVision.enhance(source); const w = contrast.getWidth(), h = contrast.getHeight();
    const p = new Int32Array(w * h); contrast.getPixels(p, 0, w, 0, 0, w, h);
    let left = 0, right = w, top = 0, bottom = h; const h6 = idiv(h, 6), edgeX = Math.max(2, idiv(w, 7)), edgeY = Math.max(2, h6);
    // A rule continues across most of the opposing dimension, unlike a letter.
    const tall = f((h - 2 * h6) * f(.82));
    for (let x = 0; x < edgeX; x++) { let dark = 0; for (let y = h6; y < h - h6; y++) if (gray(p[y * w + x]) < 130) dark++; if (dark > tall) left = x + 1; }
    for (let x = w - 1; x >= w - edgeX; x--) { let dark = 0; for (let y = h6; y < h - h6; y++) if (gray(p[y * w + x]) < 130) dark++; if (dark > tall) right = x; }
    for (let y = 0; y < edgeY; y++) { let dark = 0; for (let x = left; x < right; x++) if (gray(p[y * w + x]) < 130) dark++; if (dark > f((right - left) * f(.82))) top = y + 1; }
    for (let y = h - 1; y >= h - edgeY; y--) { let dark = 0; for (let x = left; x < right; x++) if (gray(p[y * w + x]) < 130) dark++; if (dark > f((right - left) * f(.82))) bottom = y; }
    const out = p.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let g = gray(p[y * w + x]);
      if (x < left || x >= right || y < top || y >= bottom) g = 255;
      else if (mode === 1 || mode === 2) g = g < (mode === 1 ? 115 : 155) ? 0 : 255;
      else if (mode === 3 && x > 0 && x < w - 1 && y > 0 && y < h - 1) {
        const avg = ((gray(p[(y - 1) * w + x]) + gray(p[(y + 1) * w + x]) + gray(p[y * w + x - 1]) + gray(p[y * w + x + 1])) / 4) | 0;
        g = Math.max(0, Math.min(255, g + (g - avg)));
      }
      out[y * w + x] = Color.rgb(g, g, g);
    }
    if (contrast !== source) contrast.recycle();
    return Bitmap.createBitmap(out, w, h, ARGB_8888);
  }
}
