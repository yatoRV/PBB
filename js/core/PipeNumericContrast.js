// Port of vn.lichdilam.PipeNumericContrast (APK 4.5). int[] → Int32Array (signed ARGB).
import { idiv } from '../platform/java.js';
import { CellInk } from './CellInk.js';

const f = Math.fround;
function percentile(histogram, count, fraction) { const rank = Math.max(1, Math.ceil(f(count * fraction)) | 0); let sum = 0; for (let i = 0; i < histogram.length; i++) { sum += histogram[i]; if (sum >= rank) return i; } return 255; }
function gray(pixel) { return idiv(((pixel >> 16) & 255) * 30 + ((pixel >> 8) & 255) * 59 + (pixel & 255) * 11, 100); }

/** A raw additional view of sparse digits on gray paper. Every source pixel stays in place.
 * Do not run a second general percentile stretch over this result: paper grain can become ink. */
export class PipeNumericContrast {
  static stretch(pixels, width, height) {
    if (pixels == null || pixels.length !== width * height || width < 24 || height < 12 || CellInk.clearlyBlank(pixels, width, height)) return null;
    const insetX = Math.max(1, idiv(width, 7)), insetY = Math.max(1, idiv(height, 5)); let count = 0; const histogram = new Int32Array(256);
    for (let y = insetY; y < height - insetY; y++) for (let x = insetX; x < width - insetX; x++) { histogram[gray(pixels[y * width + x])]++; count++; }
    // A two-digit position can occupy less than 10% of its cell. Its dark endpoint must come
    // from the sparse strokes, while a narrow paper/noise range must not be amplified.
    const low = percentile(histogram, count, f(.01)), paper = percentile(histogram, count, f(.80));
    if (paper - low < 32) return null;
    const out = new Int32Array(pixels.length); for (let i = 0; i < out.length; i++) { const value = Math.max(0, Math.min(255, idiv((gray(pixels[i]) - low) * 255, paper - low))); out[i] = 0xff000000 | value << 16 | value << 8 | value; }
    return out;
  }
}
