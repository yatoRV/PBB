// Port of vn.lichdilam.NameReader (APK 4.5). ONNX runs through js/platform/onnx.js, so open/read/readViews are async;
// resize() and the pick rules stay synchronous. float[] → Float32Array; resize() keeps Java's double arithmetic.
// Web: Android copies the two graphs to getNoBackupFilesDir() once per installed APK because ORT opened them from a
// file path; the web creates the sessions straight from the asset bytes, once per page, shared by every reader
// (iPhone memory) — close() therefore leaves them loaded.
import { javaThrowableToString, split, trim, utf8Decode } from '../platform/java.js';
import { Bitmap, Canvas, Color } from '../platform/bitmap.js';
import { Log } from '../platform/log.js';
import { createSession, run } from '../platform/onnx.js';
import { Personnel } from './Personnel.js';
import { Schedule } from './Schedule.js';
import { OcrCodes } from './OcrCodes.js';

const DIR = 'vietocr';
const HEIGHT = 32, MIN_WIDTH = 32, MAX_WIDTH = 512, GO = 1, EOS = 2, FIRST_CHAR = 4, MAX_STEPS = 40;
/** Promise of { encoder, decoder, vocab }, once per page (a failed load is forgotten so a later open retries). */
let loaded = null;

function readAll(input) { try { return input.readAllBytes(); } finally { input.close(); } }
async function load(context) {
  const vocab = new TextDecoder('utf-8', { ignoreBOM: true }).decode(readAll(await context.getAssets().open(DIR + '/vocab.txt')));
  const encoder = await createSession(readAll(await context.getAssets().open(DIR + '/encoder.onnx')), { graphOptimizationLevel: 'all' });
  const decoder = await createSession(readAll(await context.getAssets().open(DIR + '/decoder.onnx')), { graphOptimizationLevel: 'all' });
  return { encoder, decoder, vocab };
}
/** Java String.trim().replaceAll("\\s+"," ") (\s is ASCII whitespace in Java). */
const collapse = s => trim(s).replace(/[ \t\n\x0B\f\r]+/g, ' ');
const pipeNameText = text => OcrCodes.vietnameseName(text == null ? '' : trim(text.replace(/\n/g, ' ')));
/** The person a reading names, also through a leading or trailing run of at least two words: the decoder sometimes
 *  adds words after the name ("Châu Minh Uy Trong Thuy Thuy…") or reads a mark before it ("Saute Tô Hoài"). */
function named(text, staff) {
  text = text == null ? '' : trim(text); if (text === '') return null; if (staff.unique(text, Personnel.Source.PRINTED) != null) return text;
  const w = split(text, / /);
  for (let k = w.length - 1; k >= 2; k--) for (const part of [w.slice(0, k).join(' '), w.slice(w.length - k, w.length).join(' ')])
    if (staff.unique(part, Personnel.Source.PRINTED) != null) return part;
  return null;
}
const exactKey = s => s.normalize('NFC').replace(/[ \t\n\x0B\f\r.,]/g, '').toLowerCase();

/** Second reader for the printed name column (3.0, phase 3): VietOCR vgg_seq2seq (official weights, Apache-2.0
 *  code), exported to ONNX and quantized to INT8. It reads Vietnamese accents that ML Kit drops; its text is still
 *  only evidence for the staff list (A=B=C=D), never a name on its own. Unavailable → null, and ML Kit alone decides. */
export class NameReader {
  constructor(encoder, decoder, vocab) { this._encoder = encoder; this._decoder = decoder; this._vocab = vocab; }

  /** Opens the models of the app's assets, or resolves to null if the device cannot run them. */
  static async open(context) {
    try {
      let model = loaded; if (model == null) { model = load(context); loaded = model; }
      try { const m = await model; return new NameReader(m.encoder, m.decoder, m.vocab); } catch (failed) { if (loaded === model) loaded = null; throw failed; }
    } catch (unavailable) { Log.w('NameReader', 'VietOCR unavailable: ' + javaThrowableToString(unavailable)); return null; }
  }

  /** Greedy reading of one name cell; "" when nothing was read. */
  async read(cell) {
    const w = cell.getWidth(), h = cell.getHeight(); if (w < 4 || h < 4) return '';
    let width = Math.ceil(Math.trunc(HEIGHT * w / h) / 10.0) * 10; width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));
    const image = NameReader.resize(cell, width, HEIGHT); let out = '';
    const encoded = await run(this._encoder, { image: { type: 'float32', data: image, dims: [1, 3, HEIGHT, width] } });
    const memory = encoded.memory; let hidden = encoded.hidden; let token = GO;
    for (let step = 0; step < MAX_STEPS; step++) {
      const r = await run(this._decoder, { token: { type: 'int64', data: BigInt64Array.of(BigInt(token)), dims: [1] }, hidden: { type: 'float32', data: hidden.data, dims: hidden.dims }, memory });
      const logprob = r.logprob.data.subarray(0, r.logprob.dims[1]); hidden = r.next;
      let best = 0; for (let i = 1; i < logprob.length; i++) if (logprob[i] > logprob[best]) best = i;
      if (best === EOS) break; token = best; if (best >= FIRST_CHAR && best - FIRST_CHAR < this._vocab.length) out += this._vocab.charAt(best - FIRST_CHAR);
    }
    return collapse(out);
  }
  /** RGB planes in [0,1] at the model's size, area-averaged like the reference (PIL) resize when shrinking. */
  static resize(cell, width, height) {
    const w = cell.getWidth(), h = cell.getHeight(); const px = new Int32Array(w * h); cell.getPixels(px, 0, w, 0, 0, w, h);
    const out = new Float32Array(3 * width * height); const sx = w / width, sy = h / height;
    for (let y = 0; y < height; y++) {
      const y0 = y * sy, y1 = y0 + Math.max(1, sy);
      for (let x = 0; x < width; x++) {
        const x0 = x * sx, x1 = x0 + Math.max(1, sx); let r = 0, g = 0, b = 0, area = 0;
        for (let yy = Math.trunc(y0); yy < Math.min(h, Math.ceil(y1)); yy++) {
          const wy = Math.min(y1, yy + 1) - Math.max(y0, yy); if (wy <= 0) continue;
          for (let xx = Math.trunc(x0); xx < Math.min(w, Math.ceil(x1)); xx++) {
            const wx = Math.min(x1, xx + 1) - Math.max(x0, xx); if (wx <= 0) continue;
            const c = px[yy * w + xx]; const a = wx * wy; r += a * ((c >> 16) & 255); g += a * ((c >> 8) & 255); b += a * (c & 255); area += a;
          }
        }
        const i = y * width + x; if (area <= 0) area = 1; out[i] = r / area / 255.0; out[width * height + i] = g / area / 255.0; out[2 * width * height + i] = b / area / 255.0;
      }
    }
    return out;
  }
  /** Two views of one name cell: as cut, and with white margins (half the height left/right, a sixth above/below).
   *  Measured on the 25/10 crops: the margins remove words the decoder adds after a name and recover "Nguyễn H
   *  Minh"; on a few other cells they make it worse, so each view is only a vote (see pick). */
  async readViews(cell) {
    const w = cell.getWidth(), h = cell.getHeight(), mx = (h / 2) | 0, my = Math.max(1, (h / 6) | 0);
    const padded = Bitmap.createBitmap(w + 2 * mx, h + 2 * my, Bitmap.Config.ARGB_8888); const c = new Canvas(padded); c.drawColor(Color.WHITE); c.drawBitmap(cell, mx, my, null);
    try { return [await this.read(cell), await this.read(padded)]; } finally { padded.recycle(); }
  }
  /** pick(mlKit, vietOcr: string, staff) | pick(mlKit, vietOcr: string[], staff).
   *  The reading to use for a row: every reading that names a person (ML Kit and each VietOCR view) must name the
   *  same one, else "" (never guess between two people). Without any staff match the first VietOCR text is kept,
   *  since it keeps the accents. */
  static pick(mlKit, vietOcr, staff) {
    if (!Array.isArray(vietOcr)) return NameReader.pick(mlKit, [vietOcr], staff);
    // Java tests `text==mlKit` by reference: true only while text is still the ML Kit string (OCR strings are
    // distinct objects, so a VietOCR view equal to it does not count); fromMl tracks exactly that.
    mlKit = mlKit == null ? '' : trim(mlKit); let person = staff.unique(mlKit, Personnel.Source.PRINTED); let text = person != null ? mlKit : null; let fromMl = person != null; let first = '';
    for (const v of vietOcr) {
      if (v == null || trim(v) === '') continue; if (first === '') first = trim(v); const part = named(v, staff); if (part == null) continue;
      const p = staff.unique(part, Personnel.Source.PRINTED); if (person != null && p !== person) return '';
      // 3.0 (26/10): views naming the same person may differ in one accent (re-shot r101: "Nguyễn Ng Hung" as
      // cut, "Nguyễn Ng Hưng" with margins); the view written exactly as one of that person's forms is kept.
      if (person == null || fromMl || !NameReader.exact(text, p) && NameReader.exact(part, p)) { person = p; text = part; fromMl = false; }
    }
    if (text != null) return text;
    return Schedule.normalizeName(first).length >= 3 ? first : mlKit;
  }
  /** Both ML Kit views belong to the same pipe-name cell. A recognized enhanced view must be usable for
   *  every row, not only for the person requested by the import screen. Recognized views must still agree;
   *  a conflicting identity is never replaced by a majority or by the requested name. The work reader's
   *  existing pick() policy is unchanged. */
  static pickPipe(originalMl, enhancedMl, vietViews, staff) {
    const original = pipeNameText(originalMl), enhanced = pipeNameText(enhancedMl);
    const first = staff.unique(original, Personnel.Source.PRINTED), second = staff.unique(enhanced, Personnel.Source.PRINTED);
    if (first != null && second != null && first !== second) return '';
    const ml = first != null ? original : second != null ? enhanced : Schedule.normalizeName(original).length >= 3 ? original : enhanced;
    return OcrCodes.vietnameseName(NameReader.pick(ml, vietViews == null ? [] : vietViews, staff));
  }
  /** A second source-crop view can rescue an unresolved name, but cannot erase a recognized identity
   *  conflict in any original or alternate reading. No new recognized evidence leaves the original result. */
  static pickPipeRecovery(originalMl, enhancedMl, originalViet, alternateMl, alternateEnhanced, alternateViet, staff) {
    const original = NameReader.pickPipe(originalMl, enhancedMl, originalViet, staff); if (staff.unique(original, Personnel.Source.PRINTED) != null) return original;
    let person = null;
    for (const value of [originalMl, enhancedMl, alternateMl, alternateEnhanced]) { const p = staff.unique(pipeNameText(value), Personnel.Source.PRINTED); if (p != null) { if (person != null && person !== p) return ''; person = p; } }
    const views = []; if (originalViet != null) views.push(...originalViet); if (alternateViet != null) views.push(...alternateViet);
    for (const value of views) { const part = named(value, staff); const p = part == null ? null : staff.unique(part, Personnel.Source.PRINTED); if (p != null) { if (person != null && person !== p) return ''; person = p; } }
    if (person == null) return original;
    const recovered = NameReader.pickPipe(alternateMl, alternateEnhanced, views, staff); return staff.unique(recovered, Personnel.Source.PRINTED) === person ? recovered : original;
  }
  /** All source-crop attempts remain evidence. A later, wider view must never erase a recognized
   *  conflict from an earlier crop. Unknown text contributes no invented identity. */
  static pickPipeEvidence(mlViews, vietViews, fallback, staff) {
    let person = null, chosen = null;
    if (mlViews != null) for (const value of mlViews) {
      const text = pipeNameText(value); const p = staff.unique(text, Personnel.Source.PRINTED);
      if (p != null) { if (person != null && person !== p) return ''; person = p; if (chosen == null || !NameReader.exact(chosen, p) && NameReader.exact(text, p)) chosen = text; }
    }
    if (vietViews != null) for (const value of vietViews) {
      const text = named(value, staff); const p = text == null ? null : staff.unique(text, Personnel.Source.PRINTED);
      if (p != null) { if (person != null && person !== p) return ''; person = p; if (chosen == null || !NameReader.exact(chosen, p) || NameReader.exact(text, p)) chosen = text; }
    }
    return chosen == null ? fallback : chosen;
  }
  /** The text is one of the person's forms letter for letter, accents included (spaces, dots and case aside). */
  static exact(text, person) {
    const t = exactKey(text);
    for (const form of person.forms()) if (exactKey(form) === t) return true;
    return false;
  }
  close() { /* the shared sessions stay loaded for the next reader (see the file header) */ }
}
