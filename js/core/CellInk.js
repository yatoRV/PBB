// Port of vn.lichdilam.CellInk (APK 4.5). Java double math is JS number math; double[] → Float64Array,
// int[] pixels are signed ARGB ints (Int32Array or array).
import { idiv } from '../platform/java.js';

function gray(color) { return (((color >> 16) & 255) * 30 + ((color >> 8) & 255) * 59 + (color & 255) * 11) / 100.0; }

/** A photographed dark rule may have a thin bright halo inside the crop.
 * Require both the rule and halo across almost the full ORIGINAL cell height.
 * A short/faint character near the edge must remain uncertain. */
function verticalRuleHalo(pixels, width, height, column, edge) {
  const margin = Math.max(1, idiv(height, 12)); let count = 0, dark = 0, bright = 0;
  const center = new Float64Array(Math.max(1, idiv(width * 2, 3) - idiv(width, 3)));
  for (let y = margin; y < height - margin; y++) {
    for (let x = 0; x < center.length; x++) center[x] = gray(pixels[y * width + idiv(width, 3) + x]);
    center.sort(); const paper = center[center.length >> 1];
    if (paper - gray(pixels[y * width + edge]) >= 25) dark++;
    if (gray(pixels[y * width + column]) - paper >= 7) bright++;
    count++;
  }
  return dark >= count * .85 && bright >= count * .85;
}
function hasMark(values, w, h, background, light, contrast, faint, leftHalo, rightHalo) {
  const ink = new Uint8Array(values.length);
  for (let i = 0; i < ink.length; i++) ink[i] = (light ? values[i] - background : background - values[i]) >= contrast ? 1 : 0;
  const queue = new Int32Array(ink.length);
  const minArea = Math.max(3, Math.ceil(ink.length * (faint ? .007 : .002)) | 0);
  for (let i = 0; i < ink.length; i++) if (ink[i]) {
    let head = 0, tail = 1, minX = i % w, maxX = minX, minY = (i / w) | 0, maxY = minY;
    queue[0] = i; ink[i] = 0;
    while (head < tail) {
      const point = queue[head++], x = point % w, y = (point / w) | 0;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++)
        for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
          const neighbor = yy * w + xx;
          if (ink[neighbor]) { ink[neighbor] = 0; queue[tail++] = neighbor; }
        }
    }
    const extent = faint ? .40 : .12;
    if (light && ((leftHalo && minX === 0 && maxX <= 1) || (rightHalo && maxX === w - 1 && minX >= w - 2))) continue;
    if (tail >= minArea && (maxY - minY + 1 >= h * extent || maxX - minX + 1 >= w * extent)) return true;
  }
  return false;
}

/** Detects marks relative to the cell's paper/fill, independent of its absolute shade.
 * Pure pixel code so the same implementation can be checked without an Android device. */
export class CellInk {
  static clearlyBlank(pixels, width, height) {
    if (width < 8 || height < 8 || pixels.length !== width * height) return false;
    // Cell extraction already removes the rules. Exclude their remaining blurred edges.
    const insetX = Math.max(1, idiv(width, 7)), insetY = Math.max(1, idiv(height, 5));
    const w = width - 2 * insetX, h = height - 2 * insetY, size = w * h;
    const residual = new Float64Array(size);
    let sum = 0, xSum = 0, ySum = 0, xxSum = 0, yySum = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const color = pixels[(y + insetY) * width + x + insetX];
      const value = (((color >> 16) & 255) * 30 + ((color >> 8) & 255) * 59 + (color & 255) * 11) / 100.0;
      const dx = x - (w - 1) / 2.0, dy = y - (h - 1) / 2.0;
      residual[y * w + x] = value;
      sum += value; xSum += dx * value; ySum += dy * value;
      xxSum += dx * dx; yySum += dy * dy;
    }
    // Remove a smooth lighting gradient; do not stretch paper texture into apparent text.
    const mean = sum / size, xSlope = xSum / xxSum, ySlope = ySum / yySum;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
      residual[y * w + x] -= mean + xSlope * (x - (w - 1) / 2.0) + ySlope * (y - (h - 1) / 2.0);
    const sorted = residual.slice().sort();
    const lowBackground = sorted[idiv(size, 4)], highBackground = sorted[idiv(size * 3, 4)];
    const leftHalo = verticalRuleHalo(pixels, width, height, insetX, 0);
    const rightHalo = verticalRuleHalo(pixels, width, height, width - insetX - 1, width - 1);
    // Strong marks need little area; faint marks need a connected stroke rather than speckle.
    // Check both polarities, including light writing on a dark fill.
    return !hasMark(residual, w, h, highBackground, false, 14, false, leftHalo, rightHalo)
      && !hasMark(residual, w, h, lowBackground, true, 14, false, leftHalo, rightHalo)
      && !hasMark(residual, w, h, highBackground, false, 9, true, leftHalo, rightHalo)
      && !hasMark(residual, w, h, lowBackground, true, 9, true, leftHalo, rightHalo);
  }

  /** Not a blank decision on its own: faint letters can be this weak. The pipe reader combines it with
   *  every OCR pass (including contrast-stretched ones) having found no character in the cell. */
  static uniformTone(pixels, width, height) {
    if (width < 8 || height < CellInk.UNIFORM_MIN_HEIGHT || pixels.length !== width * height) return false;
    const insetX = Math.max(1, idiv(width, 7)), insetY = Math.max(1, idiv(height, 5)), w = width - 2 * insetX, h = height - 2 * insetY;
    const residual = new Float64Array(w * h); let sum = 0, xSum = 0, ySum = 0, xxSum = 0, yySum = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const value = gray(pixels[(y + insetY) * width + x + insetX]), dx = x - (w - 1) / 2.0, dy = y - (h - 1) / 2.0; residual[y * w + x] = value; sum += value; xSum += dx * value; ySum += dy * value; xxSum += dx * dx; yySum += dy * dy; }
    const mean = sum / (w * h), xSlope = xSum / xxSum, ySlope = ySum / yySum;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) residual[y * w + x] -= mean + xSlope * (x - (w - 1) / 2.0) + ySlope * (y - (h - 1) / 2.0);
    return CellInk._uniformTone(residual, w, h, height);
  }
  /** Java's private uniformTone(double[], …) overload. */
  static _uniformTone(residual, w, h, originalHeight) {
    if (originalHeight < CellInk.UNIFORM_MIN_HEIGHT || w < 6 || h < 6) return false;
    const r = originalHeight >= 80 ? 2 : 1; const blurred = new Float64Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let sum = 0, n = 0;
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) { sum += residual[yy * w + xx]; n++; }
      blurred[y * w + x] = sum / n;
    }
    const sorted = blurred.slice().sort(); const background = sorted[sorted.length >> 1];
    return background - sorted[0] < CellInk.UNIFORM_LIMIT && sorted[sorted.length - 1] - background < CellInk.UNIFORM_LIMIT;
  }
}
/** Shaded/textured paper (halftone gray fill) with no stroke anywhere. Only for cells tall enough that a
 *  small local average removes paper grain but keeps every printed stroke: measured on the real October
 *  photos, blank gray cells stay ≤ 29 levels from their background after the average, printed text ≥ 64. */
CellInk.UNIFORM_MIN_HEIGHT = 40;
CellInk.UNIFORM_LIMIT = 32;
