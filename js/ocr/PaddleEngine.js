// PaddleOCR (PP-OCRv5 mobile) engine for js/ocr/TextRecognizer.js: text detection (DB) + recognition (CTC) ONNX
// models run through js/platform/onnx.js. Measured against Tesseract.js in docs/DO-OCR.md (Task 9).
// Models (Apache-2.0, RapidOCR's ONNX exports of the official PaddleOCR weights, pinned by SHA-256 in docs/DO-OCR.md):
//   ch_PP-OCRv5_det_mobile.onnx, en_PP-OCRv5_rec_mobile.onnx + ppocrv5_en_dict.txt; the default recognizer is the official
//   latin_PP-OCRv5_mobile_rec ONNX export (PaddlePaddle on Hugging Face) whose dictionary is in its inference.yml.
// Pre/post-processing follows PaddleOCR's predict_det / predict_rec defaults:
//  - detection: BGR, mean (.485,.456,.406) / std (.229,.224,.225); the shorter side is raised to at least 64 and the
//    longer side kept at most 4000, both rounded to multiples of 32; DB map threshold .3, box score (mean of the map
//    in the box, "fast") ≥ .6, unclip ratio 1.5, boxes smaller than 3 px (5 after unclipping) dropped; boxes sorted
//    top to bottom then left to right (rows within 10 px);
//  - recognition: crop height 48, width 48·w/h (at least 320 of padded input), (x/255 − .5)/.5, greedy CTC decode,
//    lines with a mean character probability under .5 dropped (PaddleOCR 2.x drop_score).
// Differences, all because these sheets hold only horizontal, axis-aligned text: boxes are the axis-aligned bounds of
// each connected region of the DB map (not minAreaRect polygons), and tall crops are not rotated by 90°.
// ML Kit returns words; PP-OCR returns lines. Each recognised line is split at its space characters and every word's
// box spans the CTC frames of its characters, so a word lands in the tile it was printed in.
import { createSession, run } from '../platform/onnx.js';
import { openAsset } from '../platform/assets.js';
import { checkedPixels } from './TextRecognizer.js';

export const PADDLE_FILES = Object.freeze({ det: 'ocr/paddle/ch_PP-OCRv5_det_mobile.onnx', rec: 'ocr/paddle/en_PP-OCRv5_rec_mobile.onnx', dict: 'ocr/paddle/ppocrv5_en_dict.txt' });
/** The Latin recognizer (official PaddlePaddle ONNX export, 836 characters incl. ă â đ ê ô ơ ư — not every Vietnamese
 *  tone letter): same detector. */
export const PADDLE_LATIN_FILES = Object.freeze({ det: PADDLE_FILES.det, rec: 'ocr/paddle/latin_PP-OCRv5_mobile_rec.onnx', dict: 'ocr/paddle/latin_PP-OCRv5_mobile_rec.yml' });

/** RGBA (non-premultiplied) composited over white → three Float32 planes in BGR order, resized bilinearly
 *  (OpenCV INTER_LINEAR convention: half-pixel centres, no antialiasing) from the source rect (sx, sy, sw, sh).
 *  norm(v, c) → (v / 255 − mean[c]) / std[c]. The sampling positions and weights are computed once per column and row
 *  and opaque pixels are read directly; the arithmetic (and so every value) is that of the per-pixel version. */
export function planes(rgba, width, height, sx, sy, sw, sh, dw, dh, outW, mean, std) {
  const out = new Float32Array(3 * dh * outW); const plane = dh * outW; const fx = sw / dw, fy = sh / dh;
  const cx0 = new Int32Array(dw), cx1 = new Int32Array(dw), wxs = new Float64Array(dw);
  for (let x = 0; x < dw; x++) {
    let sxf = sx + (x + .5) * fx - .5; if (sxf < sx) sxf = sx; const x0 = Math.floor(sxf);
    wxs[x] = sxf - x0; cx0[x] = (x0 < 0 ? 0 : x0 >= width ? width - 1 : x0) * 4; cx1[x] = (x0 + 1 < 0 ? 0 : x0 + 1 >= width ? width - 1 : x0 + 1) * 4;
  }
  // Opaque source rows (the usual case) are read without compositing; a = 255 gives the same value either way.
  let opaque = true;
  for (let y = Math.max(0, Math.floor(sy)); opaque && y < Math.min(height, Math.ceil(sy + sh) + 1); y++) for (let i = y * width * 4 + 3, e = (y + 1) * width * 4; i < e; i += 4) if (rgba[i] !== 255) { opaque = false; break; }
  const at = opaque ? (i, ch) => rgba[i + ch] : (i, ch) => { const a = rgba[i + 3]; return a === 255 ? rgba[i + ch] : (rgba[i + ch] * a + 255 * (255 - a)) / 255; };
  const m0 = mean[0], m1 = mean[1], m2 = mean[2], s0 = std[0], s1 = std[1], s2 = std[2];
  for (let y = 0; y < dh; y++) {
    let syf = sy + (y + .5) * fy - .5; if (syf < sy) syf = sy; const y0 = Math.floor(syf), wy = syf - y0;
    const r0 = (y0 < 0 ? 0 : y0 >= height ? height - 1 : y0) * width * 4, r1 = (y0 + 1 < 0 ? 0 : y0 + 1 >= height ? height - 1 : y0 + 1) * width * 4;
    const row = y * outW;
    for (let x = 0; x < dw; x++) {
      const wx = wxs[x], a0 = r0 + cx0[x], a1 = r0 + cx1[x], b0 = r1 + cx0[x], b1 = r1 + cx1[x];
      // c: 0 = B, 1 = G, 2 = R (RGBA channel 2 − c)
      let v = (at(a0, 2) * (1 - wx) + at(a1, 2) * wx) * (1 - wy) + (at(b0, 2) * (1 - wx) + at(b1, 2) * wx) * wy;
      out[row + x] = (v / 255 - m0) / s0;
      v = (at(a0, 1) * (1 - wx) + at(a1, 1) * wx) * (1 - wy) + (at(b0, 1) * (1 - wx) + at(b1, 1) * wx) * wy;
      out[plane + row + x] = (v / 255 - m1) / s1;
      v = (at(a0, 0) * (1 - wx) + at(a1, 0) * wx) * (1 - wy) + (at(b0, 0) * (1 - wx) + at(b1, 0) * wx) * wy;
      out[2 * plane + row + x] = (v / 255 - m2) / s2;
    }
  }
  return out;
}
const DET_MEAN = [.485, .456, .406], DET_STD = [.229, .224, .225], REC_MEAN = [.5, .5, .5], REC_STD = [.5, .5, .5];

/** DB post-processing on the probability map (mw × mh): boxes in map pixels {x0, y0, x1, y1} and their scores. */
export function dbBoxes(map, mw, mh, { thresh = .3, boxThresh = .6, unclipRatio = 1.5, minSize = 3, maxCandidates = 1000 } = {}) {
  const seen = new Uint8Array(mw * mh); const boxes = []; const stack = new Int32Array(mw * mh);
  for (let start = 0; start < mw * mh && boxes.length < maxCandidates; start++) {
    if (seen[start] || !(map[start] > thresh)) continue;
    let n = 0, x0 = mw, y0 = mh, x1 = -1, y1 = -1; stack[n++] = start; seen[start] = 1;
    while (n > 0) { // 8-connected region, as cv2.findContours sees a foreground blob
      const p = stack[--n], px = p % mw, py = (p - px) / mw;
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const qx = px + dx, qy = py + dy; if (qx < 0 || qy < 0 || qx >= mw || qy >= mh) continue;
        const q = qy * mw + qx; if (!seen[q] && map[q] > thresh) { seen[q] = 1; stack[n++] = q; }
      }
    }
    const w = x1 - x0, h = y1 - y0; if (Math.min(w, h) < minSize) continue;
    let sum = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) sum += map[y * mw + x];
    const score = sum / ((w + 1) * (h + 1)); if (score < boxThresh) continue;
    const d = w * h * unclipRatio / (2 * (w + h)); // pyclipper offset distance: area · ratio / perimeter
    const bx0 = x0 - d, by0 = y0 - d, bx1 = x1 + d, by1 = y1 + d;
    if (Math.min(bx1 - bx0, by1 - by0) < minSize + 2) continue;
    boxes.push({ x0: bx0, y0: by0, x1: bx1, y1: by1, score });
  }
  return boxes;
}
/** PaddleOCR sorted_boxes: by top then left; neighbours less than 10 px apart vertically are ordered left to right. */
export function sortBoxes(boxes) {
  const b = boxes.slice().sort((p, q) => p.top - q.top || p.left - q.left);
  for (let i = 0; i < b.length - 1; i++) for (let j = i; j >= 0; j--) {
    if (Math.abs(b[j + 1].top - b[j].top) < 10 && b[j + 1].left < b[j].left) { const t = b[j]; b[j] = b[j + 1]; b[j + 1] = t; } else break;
  }
  return b;
}
/** The recogniser's output as greedy CTC reads it: per frame the most probable class (the first one on a tie) and its
 *  probability. All that lineBlock uses of an output (and all that the recognition memo keeps). withGap (Task A5,
 *  WebGPU results): also `gap`, the smallest difference over the frames between the most and the second most probable
 *  class — how far a computation error must go to change which class a frame reads. */
export function bestPath(probs, frames, classes, withGap = false) {
  const best = new Int32Array(frames), prob = new Float32Array(frames); let gap = Infinity;
  for (let t = 0; t < frames; t++) {
    let b = 0, p = probs[t * classes], q = -Infinity;
    for (let k = 1; k < classes; k++) { const v = probs[t * classes + k]; if (v > p) { q = p; p = v; b = k; } else if (v > q) q = v; }
    best[t] = b; prob[t] = p; if (p - q < gap) gap = p - q;
  }
  return withGap ? { best, prob, frames, gap } : { best, prob, frames };
}
/** decodePath()'s score of a bestPath() without its characters: the mean probability of the first frame of each run
 *  of a non-blank class (what is compared with the drop score). */
export function pathScore(path) {
  let prev = -1, total = 0, n = 0;
  for (let t = 0; t < path.frames; t++) { const b = path.best[t]; if (b !== 0 && b !== prev) { total += path.prob[t]; n++; } prev = b; }
  return n ? total / n : 0;
}
/** Greedy CTC decode with frame spans: [{char, from, to}] (blank = index 0, dictionary from index 1). */
export function ctcDecode(probs, frames, classes, dict) { return decodePath(bestPath(probs, frames, classes), dict); }
/** ctcDecode of a bestPath(). */
export function decodePath(path, dict) {
  const chars = []; let prev = -1, total = 0;
  for (let t = 0; t < path.frames; t++) {
    const best = path.best[t], p = path.prob[t];
    if (best !== 0 && best === prev) chars[chars.length - 1].to = t;
    else if (best !== 0) chars.push({ char: dict[best - 1] ?? '', from: t, to: t, prob: p });
    prev = best;
  }
  // PaddleOCR's CTCLabelDecode keeps the probability of the first frame of each run of a character.
  for (const c of chars) total += c.prob;
  return { chars, score: chars.length ? total / chars.length : 0 };
}

/** Recognition dictionary: a PaddleOCR *_dict.txt (one character per line) or the `character_dict` list of a
 *  PaddleX inference.yml (official ONNX repositories); the space class is appended by the caller (use_space_char). */
export function parseDict(text) {
  const lines = text.split(/\r?\n/), at = lines.indexOf('  character_dict:');
  if (at < 0) { if (lines[lines.length - 1] === '') lines.pop(); return lines; }
  const chars = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith('  - ')) break; const v = line.slice(4);
    chars.push(v.startsWith("'") ? v.slice(1, -1).replace(/''/g, "'") : v.startsWith('"') ? JSON.parse(v) : v);
  }
  return chars;
}

/** Characters a table rule can be read as. */
const RULE_LIKE = new Set(['1', 'l', 'I', 'i', '|', '!', 'j', 'J', 't']);
/**
 * ML Kit reads the ruling line of a cell that a crop takes along ("5 |" in an STT cell) as "|", "[", "]" or a trailing
 * I/l, which the readers drop (RosterRows.serial); PP-OCR often reads it as the digit "1" ("51"). The first or last
 * rule-like character of a line is returned as "|" only when it sits over the first/last of at least two ink groups
 * (runs of inked columns) and that group is a line running past the text, which a digit of the same line is not:
 *  - long: at least 1.25 × the tallest other ink group (a cell rule spans the cell; printed text fills about 60–70 % of
 *    it, so a rule is about 1.4–1.6 × the text, a digit of the same line about 1.0 ×);
 *  - crossing: it starts above the other groups' top and ends below their bottom, each by at least
 *    max(2 px, 4 % of its length) (groups
 *    under a quarter of the tallest one are specks and do not count);
 *  - thin: its median row at most max(3 px, 20 % of its length) wide;
 *  - anchored: it runs on into a horizontal border of the cell or out of the box at one end at least (a free-standing
 *    "1" ends in blank rows; seen on a real "19" whose faint "9" made the "1" look 1.3 × longer).
 * A rule touching a digit forms one ink group with it and is left alone (the reading stays as recognised).
 * Ink is darker than 35 % of the way from the box's 5th to its 95th luminance percentile (a grey cell background stays
 * paper); rows dark across half the box are the cell's horizontal borders and break every run.
 * Returns the indexes.
 */
export function ruleIndexes(rgba, width, height, box, chars, toX) {
  const real = []; chars.forEach((c, k) => { if (c.char !== ' ') real.push(k); });
  if (real.length < 2) return [];
  const first = real[0], last = real[real.length - 1];
  if (!RULE_LIKE.has(chars[first].char) && !RULE_LIKE.has(chars[last].char)) return [];
  const w = box.right - box.left, h = box.bottom - box.top; if (w < 3 || h < 8) return [];
  const dark = new Uint8Array(w * h), lum = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((box.top + y) * width + box.left + x) * 4, a = rgba[i + 3] / 255, over = c => rgba[i + c] * a + 255 * (1 - a);
    lum[y * w + x] = .299 * over(0) + .587 * over(1) + .114 * over(2);
  }
  const sorted = Float32Array.from(lum).sort(), lo = sorted[Math.floor(sorted.length * .05)], hi = sorted[Math.floor(sorted.length * .95)];
  if (hi - lo < 40) return [];
  const threshold = lo + .35 * (hi - lo); for (let i = 0; i < w * h; i++) dark[i] = lum[i] < threshold ? 1 : 0;
  const border = new Uint8Array(h);
  for (let y = 0; y < h; y++) { let n = 0; for (let x = 0; x < w; x++) n += dark[y * w + x]; border[y] = n * 2 >= w ? 1 : 0; }
  // Ink groups: runs of columns with ink outside the border rows.
  const groups = []; let open = null;
  for (let x = 0; x < w; x++) {
    let ink = false; for (let y = 0; y < h && !ink; y++) ink = !border[y] && dark[y * w + x] === 1;
    if (ink) { if (open == null) { open = { x0: x, x1: x }; groups.push(open); } else open.x1 = x; } else open = null;
  }
  if (groups.length < 2) return [];
  const rowWidth = (g, y) => { let n = 0; for (let x = g.x0; x <= g.x1; x++) n += dark[y * w + x]; return n; };
  /** Longest run of rows where the group has ink; border rows break a run (a glyph touching a cell border or a grey
   *  band's edge is not lengthened by it). */
  const run = g => {
    let best = [0, 0], start = -1;
    for (let y = 0; y <= h; y++) {
      const ink = y < h && !border[y] && rowWidth(g, y) > 0;
      if (ink && start < 0) start = y; else if (!ink && start >= 0) { if (y - start > best[1] - best[0]) best = [start, y]; start = -1; }
    }
    return best;
  };
  const isRule = (g, others) => {
    const [r0, r1] = run(g), length = r1 - r0; if (length < 4) return false;
    const widths = []; for (let y = r0; y < r1; y++) if (!border[y]) widths.push(rowWidth(g, y));
    if (widths.length < 4) return false; widths.sort((p, q) => p - q);
    if (widths[widths.length >> 1] > Math.max(3, .2 * length)) return false;
    const runs = others.map(o => run(o)); let tallest = 0; for (const [o0, o1] of runs) tallest = Math.max(tallest, o1 - o0);
    let top = h, bottom = 0; // specks (under a quarter of the tallest group) are not text
    for (const [o0, o1] of runs) if (o1 - o0 >= .25 * tallest && o1 > o0) { top = Math.min(top, o0); bottom = Math.max(bottom, o1); }
    const margin = Math.max(2, .04 * length);
    // Anchored: a cell rule runs on into a horizontal border (or out of the box); a glyph ends in blank rows.
    const anchored = r0 === 0 || r1 === h || (border[r0 - 1] && rowWidth(g, r0 - 1) > 0) || (border[r1] && rowWidth(g, r1) > 0);
    return anchored && tallest > 0 && length >= 1.25 * tallest && r0 <= top - margin && r1 >= bottom + margin;
  };
  const centre = k => toX((chars[k].from + chars[k].to + 1) / 2) - box.left;
  const out = [];
  // The first/last character must sit over the first/last group (nearer to it than to the next group).
  if (RULE_LIKE.has(chars[first].char) && centre(first) <= (groups[0].x1 + groups[1].x0) / 2 && isRule(groups[0], groups.slice(1))) out.push(first);
  const g = groups.length;
  if (last !== first && RULE_LIKE.has(chars[last].char) && centre(last) >= (groups[g - 2].x1 + groups[g - 1].x0) / 2 && isRule(groups[g - 1], groups.slice(0, g - 1))) out.push(last);
  return out;
}

// The steps of one recognition, shared by PaddleEngine (one thread) and js/ocr/PaddlePool.js (Web Workers).
/** Detection input: the image resized to multiples of 32 (shorter side at least 64, longer at most 4000), normalised. */
export function detInput(rgba, width, height) {
  let ratio = 1; if (Math.min(width, height) < 64) ratio = 64 / Math.min(width, height);
  if (Math.max(width, height) * ratio > 4000) ratio = 4000 / Math.max(width, height);
  const rw = Math.max(Math.round(width * ratio / 32) * 32, 32), rh = Math.max(Math.round(height * ratio / 32) * 32, 32);
  return { data: planes(rgba, width, height, 0, 0, width, height, rw, rh, rw, DET_MEAN, DET_STD), dims: [1, 3, rh, rw] };
}
/** Text boxes in image pixels ({left, top, right, bottom}, PaddleOCR order) from the detector's map ([1, 1, mh, mw]). */
export function detBoxes(map, dims, width, height) {
  const [, , mh, mw] = dims;
  return sortBoxes(dbBoxes(map, mw, mh).map(b => {
    const left = Math.min(Math.max(Math.round(b.x0 / mw * width), 0), width), right = Math.min(Math.max(Math.round(b.x1 / mw * width), 0), width);
    const top = Math.min(Math.max(Math.round(b.y0 / mh * height), 0), height), bottom = Math.min(Math.max(Math.round(b.y1 / mh * height), 0), height);
    return { left, top, right, bottom };
  }).filter(b => b.right - b.left > 3 && b.bottom - b.top > 3));
}
let recMinWidth = 320;
/** EXPERIMENT (Task A3, off): the padded minimum width of a recognition input (PaddleOCR: 320). A smaller one is
 *  faster for short boxes but CHANGES what is read (docs/PERF.md); the default 320 is what every score was measured
 *  with. Set before the first reading. */
export function setRecMinWidth(w) { recMinWidth = Number.isFinite(w) && w >= 32 ? Math.trunc(w) : 320; }
/** Shape of a box's recognition input: height 48, width 48·w/h padded with 0 to at least 320. */
export function recShape(b) {
  const cw = b.right - b.left, chh = b.bottom - b.top; const imgH = 48;
  const imgW = Math.trunc(imgH * Math.max(recMinWidth / 48, cw / chh)); return { dims: [1, 3, imgH, imgW], resizedW: Math.min(imgW, Math.ceil(imgH * cw / chh)) };
}
/** Recognition input of one box: height 48, width 48·w/h padded with 0 to at least 320 (batch of one, as before). */
export function recInput(rgba, width, height, b) {
  const { dims, resizedW } = recShape(b);
  return { data: planes(rgba, width, height, b.left, b.top, b.right - b.left, b.bottom - b.top, resizedW, dims[2], dims[3], REC_MEAN, REC_STD), dims, resizedW }; // padding stays 0
}

/**
 * Same box pixels, same recognition (Task A3): about 13 % of the recognitions of a work roster or pipe sheet get an
 * input already recognised (the readers crop the same cell again; docs/PERF.md). recInput reads only the RGBA bytes of
 * columns left..min(right, width - 1) and rows top..min(bottom, height - 1); which of them it reads for each output
 * pixel and with which weights (computed from the box in floating point, exactly as planes() does) decide the rest.
 * The key holds both, so two boxes with the same key get the very same input tensor. The memo keeps, for the most recent
 * boxes (up to maxBytes of kept pixels), a copy of those bytes and the output's bestPath(); a box is answered from it
 * only when its bytes are byte-for-byte the same. A box being recognised meanwhile is waited for, not run twice.
 */
export class RecMemo {
  constructor({ maxBytes = 16 << 20 } = {}) { this.maxBytes = maxBytes; this._map = new Map(); this._bytes = 0; this.hits = 0; this.misses = 0; }
  /** The key of a box: the sampling of recInput (for every output column and row: the source column / row pair it
   *  reads, relative to the box, and its weight; the output size), then a copy of the pixels it reads; and a hash. */
  static key(rgba, width, height, b) {
    const sx = b.left, sy = b.top, sw = b.right - b.left, sh = b.bottom - b.top, { dims, resizedW: dw } = recShape(b), dh = dims[2];
    const fx = sw / dw, fy = sh / dh; const sig = new Float64Array(3 + 3 * dw + 3 * dh); let n = 0;
    sig[n++] = dw; sig[n++] = dh; sig[n++] = dims[3];
    for (let x = 0; x < dw; x++) { // as planes()
      let sxf = sx + (x + .5) * fx - .5; if (sxf < sx) sxf = sx; const x0 = Math.floor(sxf);
      sig[n++] = sxf - x0; sig[n++] = (x0 < 0 ? 0 : x0 >= width ? width - 1 : x0) - sx; sig[n++] = (x0 + 1 < 0 ? 0 : x0 + 1 >= width ? width - 1 : x0 + 1) - sx;
    }
    for (let y = 0; y < dh; y++) {
      let syf = sy + (y + .5) * fy - .5; if (syf < sy) syf = sy; const y0 = Math.floor(syf);
      sig[n++] = syf - y0; sig[n++] = (y0 < 0 ? 0 : y0 >= height ? height - 1 : y0) - sy; sig[n++] = (y0 + 1 < 0 ? 0 : y0 + 1 >= height ? height - 1 : y0 + 1) - sy;
    }
    const x1 = Math.min(b.right, width - 1), y1 = Math.min(b.bottom, height - 1), rowBytes = (x1 - b.left + 1) * 4;
    const px = new Uint8Array(sig.byteLength + rowBytes * (y1 - b.top + 1)); px.set(new Uint8Array(sig.buffer));
    for (let y = b.top, o = sig.byteLength; y <= y1; y++, o += rowBytes) { const i = (y * width + b.left) * 4; px.set(rgba.subarray(i, i + rowBytes), o); }
    let h = 0x811c9dc5; const words = new Uint32Array(px.buffer, 0, px.length >> 2);
    for (let i = 0; i < words.length; i++) h = Math.imul(h ^ words[i], 16777619);
    return { px, id: (h >>> 0).toString(36) + ':' + px.length };
  }
  _find(key) {
    const list = this._map.get(key.id); if (list == null) return null;
    for (const e of list) {
      const a = e.px, c = key.px; if (a.length !== c.length) continue;
      if (sameBytes(a, c)) return e;
    }
    return null;
  }
  /** A known box: { path } (a copy) or { pending } (a promise of a copy of the path, or of null if that run failed);
   *  else null. */
  get(key) {
    const e = this._find(key); if (e == null) { this.misses++; return null; }
    this.hits++;
    if (e.path == null) return { pending: e.pending.then(p => (p == null ? null : copyPath(p))) };
    this._touch(key.id); return { path: copyPath(e.path) };
  }
  /** The box is being recognised now: returns done(path | null), called when its output is in (null: the run failed
   *  or was dropped). */
  begin(key) {
    let resolve; const e = { px: key.px, path: null, pending: new Promise(r => { resolve = r; }) };
    const list = this._map.get(key.id) ?? []; list.push(e); this._map.set(key.id, list);
    let over = false;
    return path => {
      if (over) return; over = true;
      if (path == null) { const l = (this._map.get(key.id) ?? []).filter(x => x !== e); if (l.length) this._map.set(key.id, l); else this._map.delete(key.id); resolve(null); return; }
      e.path = copyPath(path); e.pending = null; this._bytes += e.px.length; this._touch(key.id); resolve(e.path);
      for (const [id, l] of this._map) { // least recently used first
        if (this._bytes <= this.maxBytes) break;
        const kept = l.filter(x => { if (x.path == null) return true; this._bytes -= x.px.length; return false; });
        if (kept.length) this._map.set(id, kept); else this._map.delete(id);
      }
    };
  }
  _touch(id) { const l = this._map.get(id); if (l == null) return; this._map.delete(id); this._map.set(id, l); } // most recent last
  /** Bytes of pixels kept (diagnostics). */
  get bytes() { return this._bytes; }
}
/** Byte-for-byte equality of two Uint8Arrays of the same length (32 bits at a time where both are aligned). */
function sameBytes(a, c) {
  let i = 0;
  if (a.byteOffset % 4 === 0 && c.byteOffset % 4 === 0) {
    const n = a.length >> 2, wa = new Uint32Array(a.buffer, a.byteOffset, n), wc = new Uint32Array(c.buffer, c.byteOffset, n);
    for (let k = 0; k < n; k++) if (wa[k] !== wc[k]) return false;
    i = n << 2;
  }
  for (; i < a.length; i++) if (a[i] !== c[i]) return false;
  return true;
}
const copyPath = p => ({ best: new Int32Array(p.best), prob: new Float32Array(p.prob), frames: p.frames });
/** The text block of one box from the recogniser's output ([1, frames, classes]; or its bestPath(), outDims then
 *  unused), or null (nothing read, or a mean character probability under dropScore). input: { dims, resizedW } of the
 *  box's recInput (recShape). onRule(before, after): see PaddleEngine. */
export function lineBlock(rgba, width, height, b, input, out, outDims, dict, dropScore, onRule) {
  const cw = b.right - b.left, imgW = input.dims[3], resizedW = input.resizedW;
  const path = out.best instanceof Int32Array ? out : bestPath(out, outDims[1], outDims[2]); const frames = path.frames;
  const { chars, score } = decodePath(path, dict);
  if (chars.length === 0 || score < dropScore) return null;
  const step = imgW / frames, toX = f => b.left + f * step * cw / resizedW; const elements = [];
  const rules = ruleIndexes(rgba, width, height, b, chars, toX);
  if (rules.length > 0) { const before = chars.map(c => c.char).join(''); for (const k of rules) chars[k].char = '|'; onRule?.(before, chars.map(c => c.char).join('')); }
  let word = null;
  for (const c of chars) {
    if (c.char === ' ') { word = null; continue; }
    if (word == null) { word = { text: '', from: c.from, to: c.to }; elements.push(word); }
    word.text += c.char; word.to = c.to;
  }
  const words = elements.map(w => ({ text: w.text, boundingBox: { left: Math.max(b.left, Math.floor(toX(w.from))), top: b.top, right: Math.min(b.right, Math.ceil(toX(w.to + 1))), bottom: b.bottom } }));
  return words.length > 0 ? { boundingBox: b, lines: [{ boundingBox: b, elements: words }] } : null;
}
/** The error of a call whose reader stopped waiting (js/ocr/TextRecognizer.js aborts its signal). */
export function abandoned() { const e = new Error('OCR call abandoned by its reader'); e.name = 'AbortError'; e.abandoned = true; return e; }
/** The recognition dictionary (dictionary file bytes): its characters plus the space class (use_space_char). */
export function dictChars(bytes) { const chars = parseDict(new TextDecoder('utf-8').decode(bytes)); chars.push(' '); return chars; }

export class PaddleEngine {
  /** options: load(path) → Uint8Array (default: the site's assets), files ({det, rec, dict}), dropScore (.5),
   *  onRule(before, after) (evaluation only: each line in which a cell rule was returned as "|"), recMemo (a RecMemo,
   *  or false for none; default a new one). */
  constructor(options = {}) {
    this.options = options; this.files = options.files ?? PADDLE_FILES; this.dropScore = options.dropScore ?? .5;
    this.name = options.name ?? 'paddle-v5-en'; this._ready = null;
    this.recMemo = options.recMemo === false ? null : options.recMemo ?? new RecMemo();
  }
  async _load() {
    const load = this.options.load ?? openAsset;
    const [det, rec, dict] = await Promise.all([load(this.files.det), load(this.files.rec), load(this.files.dict)]);
    return { det: await createSession(det), rec: await createSession(rec), dict: dictChars(dict) };
  }
  _models() { if (this._ready == null) this._ready = this._load().catch(e => { this._ready = null; throw e; }); return this._ready; }
  /** Loads the models now (warm-up before the first reading). */
  async warm() { await this._models(); }

  /** The pixels are copied before the first await (contract); a snapshot made by js/ocr/engine.js (`owned`) is used
   *  as it is, so a call copies the RGBA once. options.signal: the reader stopped waiting — stop between boxes. */
  async process(bitmap, { signal } = {}) {
    const width = bitmap.getWidth(), height = bitmap.getHeight(); const rgba = bitmap.owned === true ? checkedPixels(bitmap) : new Uint8ClampedArray(checkedPixels(bitmap));
    const m = await this._models();
    const input = detInput(rgba, width, height);
    const detOut = Object.values(await run(m.det, { [m.det.inputNames[0]]: { type: 'float32', data: input.data, dims: input.dims } }))[0];
    const blocks = [];
    for (const b of detBoxes(detOut.data, detOut.dims, width, height)) {
      if (signal?.aborted) throw abandoned();
      const key = this.recMemo == null ? null : RecMemo.key(rgba, width, height, b); const known = key == null ? null : this.recMemo.get(key);
      let path = known == null ? null : known.path ?? await known.pending;
      if (path == null) {
        const done = key == null ? null : this.recMemo.begin(key);
        try {
          const x = recInput(rgba, width, height, b);
          const out = Object.values(await run(m.rec, { [m.rec.inputNames[0]]: { type: 'float32', data: x.data, dims: x.dims } }))[0];
          path = bestPath(out.data, out.dims[1], out.dims[2]);
        } catch (e) { done?.(null); throw e; }
        done?.(path);
      }
      const block = lineBlock(rgba, width, height, b, recShape(b), path, null, m.dict, this.dropScore, this.options.onRule);
      if (block != null) blocks.push(block);
    }
    return { textBlocks: blocks };
  }
  close() { /* sessions stay loaded for the page, like the readers' ONNX sessions */ }
}
