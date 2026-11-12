// Tesseract.js engine for js/ocr/TextRecognizer.js (the web replacement of ML Kit's base OCR; Task 9 measures it in
// docs/DO-OCR.md). Browser: tesseract.js 7.0.0 and tesseract.js-core 7.0.0 from jsDelivr, language data
// (4.0.0_best_int *.traineddata.gz, Apache-2.0) from WEB/assets/ocr/tesseract/. Node (evaluation/tests): the
// tesseract.js devDependency. One worker per engine, created on the first process() call.
//
// Result shape as ML Kit: Tesseract blocks → TextBlock, all lines of a block → Line, words → Element with the word's
// pixel box. Blocks and lines are put top to bottom and the words of a line left to right (stable sorts), the order
// the TextRecognizer contract requires. Words that are empty after trimming are dropped; nothing else is filtered.
import { checkedPixels } from './TextRecognizer.js';
export const TESSERACT_VERSION = '7.0.0';
export const TESSERACT_CORE_VERSION = '7.0.0';
const CDN = 'https://cdn.jsdelivr.net/npm/';
const isNode = typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined';

/** Binary PPM (P6) of the RGBA pixels composited over white: Leptonica reads it without an image codec. */
export function toPpm(data, width, height) {
  const header = new TextEncoder().encode('P6\n' + width + ' ' + height + '\n255\n');
  const out = new Uint8Array(header.length + width * height * 3); out.set(header, 0);
  for (let i = 0, o = header.length, n = width * height; i < n; i++, o += 3) {
    const a = data[i * 4 + 3];
    if (a === 255) { out[o] = data[i * 4]; out[o + 1] = data[i * 4 + 1]; out[o + 2] = data[i * 4 + 2]; }
    else for (let c = 0; c < 3; c++) out[o + c] = Math.round((data[i * 4 + c] * a + 255 * (255 - a)) / 255);
  }
  return out;
}

const box = b => ({ left: Math.trunc(b.x0), top: Math.trunc(b.y0), right: Math.trunc(b.x1), bottom: Math.trunc(b.y1) });
const byTop = (a, b) => a.boundingBox.top - b.boundingBox.top;
/** tesseract.js `blocks` output → plain TextRecognizer result. */
export function tesseractBlocksToText(blocks) {
  const out = [];
  for (const block of blocks ?? []) {
    const lines = [];
    for (const paragraph of block.paragraphs ?? []) for (const line of paragraph.lines ?? []) {
      const elements = [];
      for (const word of line.words ?? []) { const text = String(word.text ?? '').trim(); if (text !== '') elements.push({ text, boundingBox: box(word.bbox) }); }
      if (elements.length > 0) { elements.sort((a, b) => a.boundingBox.left - b.boundingBox.left); lines.push({ boundingBox: box(line.bbox), elements }); }
    }
    if (lines.length > 0) { lines.sort(byTop); out.push({ boundingBox: box(block.bbox), lines }); }
  }
  out.sort(byTop);
  return { textBlocks: out };
}

export class TesseractEngine {
  /**
   * options: langs ('eng' or 'eng+vie'), psm (Tesseract page segmentation mode, default '3' = automatic),
   * langPath (folder or URL holding <lang>.traineddata.gz; default WEB/assets/ocr/tesseract/), corePath, workerPath.
   */
  constructor(options = {}) {
    this.langs = options.langs ?? 'eng'; this.psm = String(options.psm ?? '3'); this.options = options;
    this._worker = null; this.name = 'tesseract-' + this.langs.replace('+', '-') + '-psm' + this.psm;
  }
  async _create() {
    let Tesseract, extra;
    const base = new URL('../../assets/ocr/tesseract/', import.meta.url);
    const langPath = this.options.langPath ?? (isNode ? (await import('node:url')).fileURLToPath(base) : base.href);
    if (isNode) { const m = await import('tesseract.js'); Tesseract = m.default ?? m; extra = {}; }
    else {
      const m = await import(CDN + 'tesseract.js@' + TESSERACT_VERSION + '/dist/tesseract.esm.min.js'); Tesseract = m.default ?? m;
      extra = { workerPath: this.options.workerPath ?? CDN + 'tesseract.js@' + TESSERACT_VERSION + '/dist/worker.min.js', corePath: this.options.corePath ?? CDN + 'tesseract.js-core@' + TESSERACT_CORE_VERSION };
    }
    const worker = await Tesseract.createWorker(this.langs, Tesseract.OEM.LSTM_ONLY, { langPath: String(langPath).replace(/\/$/, ''), cacheMethod: 'none', gzip: true, ...extra });
    await worker.setParameters({ tessedit_pageseg_mode: this.psm });
    return worker;
  }
  /** The bitmap is read synchronously (copied into a PPM) before the first await, as the contract requires. */
  async process(bitmap) {
    const image = toPpm(checkedPixels(bitmap), bitmap.getWidth(), bitmap.getHeight());
    if (this._worker == null) this._worker = this._create().catch(e => { this._worker = null; throw e; });
    const worker = await this._worker;
    const { data } = await worker.recognize(image, {}, { blocks: true, text: false });
    return tesseractBlocksToText(data.blocks);
  }
  async close() { const w = this._worker; this._worker = null; if (w != null) await (await w).terminate(); }
}
