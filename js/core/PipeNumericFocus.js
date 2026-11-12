// Port of vn.lichdilam.PipeNumericFocus (APK 4.5). int[] → Int32Array (signed ARGB).
import { roundD } from '../platform/java.js';
import { PipeNumericContrast } from './PipeNumericContrast.js';

const f = Math.fround;
class View { constructor(width, height, pixels, bounds) { this.width = width; this.height = height; this.pixels = pixels; this.bounds = bounds; } }

/** Re-centers the complete observed dark-ink extent on white paper, without resizing source pixels. */
export class PipeNumericFocus {
  static View = View;
  static create(original, width, height) {
    const source = PipeNumericContrast.stretch(original, width, height); if (source == null) return null;
    let left = width, top = height, right = 0, bottom = 0;
    // Every dark component contributes, including separate numbers and suffix letters.
    // Never select only the largest component or an answer-shaped part of a numeral.
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if ((source[y * width + x] & 255) < 128) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1); }
    if (left >= right || top >= bottom || left < 1 || top < 1 || right >= width || bottom >= height) return null;
    const inkW = right - left, inkH = bottom - top; if (inkH >= f(height * f(.8)) || inkW >= f(width * f(.8))) return null;
    const h = Math.ceil(Math.max(inkH, inkW / 1.6) / .45) | 0, w = roundD(h * 1.6) | 0;
    if (w < inkW || h < inkH || w > width * 3 || h > height * 3) return null;
    const pixels = new Int32Array(w * h).fill(0xffffffff | 0); const offsetX = (w - inkW) >> 1, offsetY = (h - inkH) >> 1;
    for (let y = 0; y < inkH; y++) pixels.set(source.subarray((top + y) * width + left, (top + y) * width + left + inkW), (offsetY + y) * w + offsetX);
    return new View(w, h, pixels, Int32Array.of(left, top, right, bottom));
  }
}
