// Port of vn.lichdilam.PipeNumericEdge (APK 4.5). int[] → Int32Array (signed ARGB); Java float via Math.fround.
import { idiv, roundF } from '../platform/java.js';

const f = Math.fround;
function gray(pixel) { return idiv(((pixel >> 16) & 255) * 30 + ((pixel >> 8) & 255) * 59 + (pixel & 255) * 11, 100); }

/** A faint left border can survive a crop as an extra OCR digit. Remove only an outer, nearly
 * full-height gray bar separated from the text by paper; never erase a dark glyph or change the canvas. */
export class PipeNumericEdge {
  static clean(pixels, width, height) {
    if (pixels == null || pixels.length !== width * height || width < 24 || height < 12) return null;
    const reach = Math.min(roundF(f(width * f(.15))), Math.max(3, idiv(height, 4))), gap = Math.max(3, Math.min(6, idiv(height, 8))), band = Math.max(2, idiv(height, 6));
    for (let y = 0; y < height; y++) for (let x = 0; x < reach; x++) if (gray(pixels[y * width + x]) < 100) return null;
    for (let cut = reach; cut >= 2; cut--) {
      if (cut + gap >= width) continue; let active = 0, hits = 0, top = 0, bottom = 0, topActive = 0, bottomActive = 0, strength = 0, ink = false;
      for (let y = 0; y < height; y++) {
        let low = 255, high = 0, sum = 0; for (let x = cut; x < cut + gap; x++) { const g = gray(pixels[y * width + x]); low = Math.min(low, g); high = Math.max(high, g); sum += g; }
        let edge = 255; for (let x = 0; x < cut; x++) { const g = gray(pixels[y * width + x]); if (g < 100) ink = true; if (x < 2) edge = Math.min(edge, g); }
        const paper = idiv(sum, gap); if (paper >= 248 && edge >= 245) continue;
        active++; if (y < band) topActive++; if (y >= height - band) bottomActive++;
        if (low >= 170 && high - low <= 32 && paper - edge >= 6) { hits++; strength += paper - edge; if (y < band) top++; if (y >= height - band) bottom++; }
      }
      if (ink || active < f(height * f(.8)) || hits < f(active * f(.9)) || strength < 12 * active || topActive < f(band * f(.75)) || bottomActive < f(band * f(.75)) || top < f(topActive * f(.8)) || bottom < f(bottomActive * f(.8))) continue;
      let body = false; for (let y = 0; y < height && !body; y++) for (let x = cut + gap; x < width; x++) if (gray(pixels[y * width + x]) < 100) { body = true; break; }
      if (!body) continue;
      const out = pixels.slice(); for (let y = 0; y < height; y++) { const paper = pixels[y * width + cut + idiv(gap, 2)]; for (let x = 0; x < cut; x++) out[y * width + x] = paper; } return out;
    }
    return null;
  }
}
