// Warm-up before the first reading (Task A3, web only; the readers and their results are unchanged). The first OCR
// call of a page used to pay for everything at once: starting the Web Workers, downloading and compiling the
// onnxruntime-web WASM in each, loading the recogniser and the detector, and on the main thread the readers' own
// models (cell codes, pipe numbers, VietOCR names). Here this starts earlier:
//  - when a "Thêm ảnh…" choice opens (warmUpReading): the OCR engine and the models of that reader, on every device
//    (the user is about to pick a photo; the photo picker covers the start-up);
//  - after sign-in, once the page is idle (warmUpAfterSignIn): the OCR engine on devices with memory to spare
//    (not iPhone / iPad, deviceMemory at least 4 GB where reported); on iPhone / iPad only the files are fetched
//    into the HTTP cache (no runtime started, so no memory held). Nothing with Save-Data on.
// Every step is best effort: a failure here is met again, and handled as before, by the first reading.
import { warmUpOcr } from './engine.js';

const started = new Set();
/** Browsers only (Node tests mount the screens too, and must not load the models). */
const browser = () => typeof window !== 'undefined' && typeof document !== 'undefined';
/** Once per page and key. */
const once = (key, fn) => { if (started.has(key)) return; started.add(key); Promise.resolve().then(fn).catch(() => { started.delete(key); }); };

/** The OCR engine and the models the reader of `kind` ('work', 'pipe', or null: not chosen yet) loads on its first
 *  photo. Web-only addition to the "Thêm ảnh…" handlers of js/ui/MainActivity.js. */
export function warmUpReading(context, kind) {
  if (!browser()) return;
  once('ocr', () => warmUpOcr());
  if (context == null || kind == null) return; // the readers' models load on the main thread (≈ 0.2–0.3 s blocked): only once a reader is chosen
  once('names', async () => { const { NameReader } = await import('../core/NameReader.js'); await NameReader.open(context); });
  const dirs = kind === 'work' ? ['cells'] : kind === 'pipe' ? ['pipes', 'pipes-t5'] : [];
  for (const dir of dirs) once('cells:' + dir, async () => { const { CellReader } = await import('../core/CellReader.js'); await CellReader.open(context, dir); });
}

/** Whether this device starts the engine after sign-in (else it only prefetches the files). */
export function warmsAfterSignIn(nav = globalThis.navigator, mobile = null) {
  if (nav == null || nav.connection?.saveData === true) return 'none';
  const apple = mobile ?? (/iP(hone|ad|od)/.test(nav.userAgent ?? '') || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1));
  if (apple || (Number.isFinite(nav.deviceMemory) && nav.deviceMemory < 4)) return 'prefetch';
  return 'engine';
}

/** The runtime and model files of the default engine, fetched into the HTTP cache (bodies dropped). */
export async function prefetchOcrFiles() {
  const { ortWebBuild, wasmSimdSupported } = await import('../platform/onnx.js');
  const { PADDLE_LATIN_FILES } = await import('./PaddleEngine.js'); const { assetUrl } = await import('../platform/assets.js');
  const build = ortWebBuild(wasmSimdSupported());
  const urls = [build.module, build.wasmPaths + (build.simd ? 'ort-wasm-simd-threaded.wasm' : 'ort-wasm.wasm'),
    ...[PADDLE_LATIN_FILES.det, PADDLE_LATIN_FILES.rec, PADDLE_LATIN_FILES.dict].map(p => assetUrl(p).href)];
  for (const url of urls) { try { const r = await fetch(url); await r.arrayBuffer(); } catch { /* the reading fetches it */ } }
}

/** After sign-in: waits `delay` ms and an idle moment, then warms the engine or prefetches its files (see above). */
export function warmUpAfterSignIn({ nav = globalThis.navigator, delay = 3000, win = globalThis } = {}) {
  const how = browser() ? warmsAfterSignIn(nav) : 'none'; if (how === 'none') return how;
  const idle = fn => (typeof win.requestIdleCallback === 'function' ? win.requestIdleCallback(fn, { timeout: 5000 }) : win.setTimeout(fn, 0));
  win.setTimeout(() => idle(() => { if (how === 'engine') once('ocr', () => warmUpOcr()); else once('prefetch', prefetchOcrFiles); }), delay);
  return how;
}
