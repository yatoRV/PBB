// The base OCR engine of the web app (ML Kit's role on Android), chosen by measurement on the APK's own
// ground-truth photos: see docs/DO-OCR.md (Task 9). The engine module, its library and its model files load lazily,
// on the first recognition. Browser and Node.
//   import { installDefaultEngine } from './js/ocr/engine.js'; installDefaultEngine();   // once per page
import { TextRecognition, Text, checkedPixels } from './TextRecognizer.js';
import { checkpointed } from './checkpoint.js';

let workers = null, webgpu = 'off', recMemo = true;
/** OCR workers of the PaddleOCR engines in the browser: null = js/ocr/PaddlePool.js poolSize() (default), 0 = none
 *  (main thread, as before Task A1). For diagnostics and measurement; read when an engine is created. */
export function setOcrWorkers(n) { workers = n; }
/** Recognition memo of the PaddleOCR engines (js/ocr/PaddleEngine.js RecMemo, Task A3): on by default; off for
 *  measurement only. */
export function setOcrRecMemo(on) { recMemo = on !== false; }
/** WebGPU for the PaddleOCR engines (read when an engine is created). 'off' (default): WASM. 'auto' (Task A3): one
 *  worker on WebGPU after this device passed the self-check of js/ocr/webgpu-check.js (else WASM, as 'off'); off by
 *  default in the app since Task A5 (installDefaultEngine): a device opts in on bench.html (ldl.ocr.webgpu = 'auto'). true / 'on': WebGPU where available,
 *  without the check (js/platform/onnx.js setWebGpu; measurement only). */
export function setOcrWebGpu(mode) { webgpu = mode === true || mode === 'on' ? 'on' : mode === 'auto' ? 'auto' : 'off'; }
/** A PaddleOCR engine: on a pool of Web Workers where the page can run one, else on this thread (Node, old browsers). */
async function paddle(name, pick) {
  const m = await import('./PaddleEngine.js'); const files = pick(m);
  const memo = recMemo ? {} : { recMemo: false };
  if (workers !== 0) {
    const p = await import('./PaddlePool.js');
    if (p.poolSupported()) {
      const wasm = () => new p.PaddlePool({ name, files, webgpu: webgpu === 'on', ...memo, ...(workers != null ? { size: workers } : {}) });
      if (webgpu === 'auto') {
        // Task A5: the WASM workers detect and recognise as without WebGPU, and one more worker recognises on WebGPU;
        // its close calls go to WASM and a sample is compared on WASM (a difference keeps this device on WASM for good).
        const check = await import('./webgpu-check.js');
        // On iPhone / iPad the GPU worker takes the place of a WASM worker (memory: 2 workers there until measured).
        const size = workers ?? (p.appleMobile() ? Math.max(1, p.poolSize() - 1) : p.poolSize());
        const gpu = await check.webGpuEngine(() => new p.PaddlePool({ name, files, gpuRec: true, size, onGpuMismatch: stats => check.rememberMismatch(stats), ...memo }));
        if (gpu != null) return gpu;
      }
      return wasm();
    }
  }
  if (webgpu === 'on') (await import('../platform/onnx.js')).setWebGpu(true);
  return new m.PaddleEngine({ name, files, ...memo });
}
/** Measured engines (docs/DO-OCR.md); the default is the one with the fewest wrong cells, then the most right. */
export const ENGINES = Object.freeze({
  'paddle-v5-latin': () => paddle('paddle-v5-latin', m => m.PADDLE_LATIN_FILES),
  'paddle-v5-en': () => paddle('paddle-v5-en', m => m.PADDLE_FILES),
  'tesseract-eng': async () => new (await import('./TesseractEngine.js')).TesseractEngine({ langs: 'eng', psm: '3' }),
  'tesseract-eng-vie': async () => new (await import('./TesseractEngine.js')).TesseractEngine({ langs: 'eng+vie', psm: '3' }),
});
export const DEFAULT_ENGINE = 'paddle-v5-latin';

/** A copy of the pixels while the engine is still loading (the contract: copy before the first await; the reader
 *  may recycle). `owned` tells the engine it may use this array without copying it again. */
function snapshot(bitmap) {
  const data = new Uint8ClampedArray(checkedPixels(bitmap)), width = bitmap.getWidth(), height = bitmap.getHeight();
  return { data, width, height, owned: true, getWidth: () => width, getHeight: () => height, isRecycled: () => false };
}

/**
 * Same image, same result: the readers send some small images to OCR again (on the 25/10 sheets 67 of the 392
 * calls of pipe-tohoai repeat an earlier call within its last few calls). The last results of images up to 1 MB of
 * RGBA, 16 MB in all, are kept with a copy of their pixels and returned again (as a new object) when the pixels are
 * byte-for-byte the same; the engine is deterministic, so the result is the one it would return. Only plain results
 * ({ textBlocks }) are kept.
 */
export function memoized(engine, { maxBytes = 1 << 20, totalBytes = 16 << 20 } = {}) {
  const kept = []; let bytes = 0; // most recent last
  const hash = px => { // FNV-1a over 32-bit words (and the tail bytes)
    let h = 0x811c9dc5; const n = px.byteLength >> 2, words = px.byteOffset % 4 === 0 ? new Uint32Array(px.buffer, px.byteOffset, n) : null;
    if (words) for (let i = 0; i < n; i++) h = Math.imul(h ^ words[i], 16777619); else for (let i = 0; i < n * 4; i++) h = Math.imul(h ^ px[i], 16777619);
    for (let i = n * 4; i < px.byteLength; i++) h = Math.imul(h ^ px[i], 16777619);
    return h >>> 0;
  };
  const same = (a, b) => { if (a.byteLength !== b.byteLength) return false; for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false; return true; };
  return {
    name: engine.name,
    get inner() { return engine; },
    process(bitmap, options) {
      let px, width, height; try { px = checkedPixels(bitmap); width = bitmap.getWidth(); height = bitmap.getHeight(); } catch (e) { return Promise.reject(e); }
      if (px.byteLength > maxBytes) return engine.process(bitmap, options);
      const h = hash(px);
      for (let k = kept.length - 1; k >= 0; k--) {
        const e = kept[k];
        if (e.h === h && e.width === width && e.height === height && same(e.px, px)) { kept.splice(k, 1); kept.push(e); return Promise.resolve(JSON.parse(e.result)); }
      }
      // The copy is kept as the key and lent to the engine (engines only read the pixels).
      const copy = new Uint8ClampedArray(px);
      return engine.process({ data: copy, owned: true, getWidth: () => width, getHeight: () => height, isRecycled: () => false }, options).then(result => {
        if (result != null && Array.isArray(result.textBlocks) && !(result instanceof Text)) {
          kept.push({ h, width, height, px: copy, result: JSON.stringify(result) }); bytes += copy.byteLength;
          while (bytes > totalBytes && kept.length > 0) bytes -= kept.shift().px.byteLength;
        }
        return result;
      });
    },
    warm: () => engine.warm?.(),
    close: () => engine.close?.(),
  };
}

/** An engine that creates the named engine on its first process() call; a failed load is retried next time. */
export function createEngine(name = DEFAULT_ENGINE) {
  const factory = ENGINES[name]; if (factory == null) throw new Error('Unknown OCR engine: ' + name);
  let real = null, loaded = null;
  return {
    name,
    /** The loaded engine (null before the first call finished loading it); diagnostics. */
    get current() { return loaded; },
    process(bitmap, options) {
      // Loaded: the engine itself copies what it needs before its first await (one copy per call).
      if (loaded != null) return loaded.process(bitmap, options);
      let copy; try { copy = snapshot(bitmap); } catch (e) { return Promise.reject(e); }
      if (real == null) real = factory().then(e => (loaded = e)).catch(e => { real = null; throw e; });
      return real.then(e => e.process(copy, options));
    },
    /** Loads the engine and its models now, ahead of the first reading (js/ocr/warm-up.js); results are unchanged. */
    warm() {
      if (real == null) real = factory().then(e => (loaded = e)).catch(e => { real = null; throw e; });
      return real.then(e => e.warm?.());
    },
    async close() { const r = real; real = null; loaded = null; if (r != null) await (await r).close?.(); },
  };
}

/** What decides an engine's results besides the pixels (js/ocr/checkpoint.js keys): its model files. */
export const MODEL_VERSIONS = Object.freeze({
  'paddle-v5-latin': 'ch_PP-OCRv5_det_mobile+latin_PP-OCRv5_mobile_rec@89d3a50e;drop0.5',
  'paddle-v5-en': 'ch_PP-OCRv5_det_mobile+en_PP-OCRv5_rec_mobile;drop0.5',
  'tesseract-eng': 'tesseract.js@7.0.0;eng;psm3',
  'tesseract-eng-vie': 'tesseract.js@7.0.0;eng+vie;psm3',
});
let installed = null;
/** localStorage key of the per-device WebGPU switch (js/ocr/webgpu-check.js SWITCH_KEY): 'auto' turns it on. */
const GPU_SWITCH = 'ldl.ocr.webgpu';
/** Installs the default engine for every TextRecognizer client of the page; inside a reading job its calls are
 *  checkpointed (js/ocr/checkpoint.js: a restarted job gets the calls it already made back at once). */
export function installDefaultEngine(name = DEFAULT_ENGINE) {
  // Task A5: WASM by default again. With WebGPU on (Task A4) the OPPO Find X7 read the same pipe photos with one cell
  // different twice (a detection split "9HC" into "9" and "9HC", so a duty HC was lost); a device opts in on
  // bench.html (ldl.ocr.webgpu = 'auto'), which still runs the self-check first.
  let gpu = 'off'; try { if (globalThis.localStorage?.getItem(GPU_SWITCH) === 'auto') gpu = 'auto'; } catch { /* no storage: default */ }
  setOcrWebGpu(gpu);
  // WebGPU results may differ from WASM (Task A4: on a Mali GPU): checkpoints written with WebGPU possible are kept
  // apart from WASM-only ones, so a resumed read does not mix the two settings.
  const engine = checkpointed(memoized(createEngine(name)), { engineId: name, modelVersion: (MODEL_VERSIONS[name] ?? '') + (gpu === 'auto' ? ';webgpu-auto' : '') });
  TextRecognition.setEngine(engine); installed = engine; return engine;
}
/** What reads the text now, for the log (Task A4): { engine, setting ('off' | 'auto' | 'on'), mode ('workers:N',
 *  'workers:N+gpu', 'main-thread', … or 'not-loaded'), webgpu (the loaded pool reads on WebGPU now), gpu (Task A5:
 *  the WebGPU worker's counts since the page opened — boxes, read again on WASM, compared, different, largest
 *  probability difference — and why it stopped; null without one) }. */
export function ocrEngineInfo(engine = TextRecognition.getEngine()) {
  let e = engine; while (e?.inner != null) e = e.inner;
  const real = e?.current ?? null;
  return { engine: e?.name ?? null, setting: webgpu, mode: real == null ? 'not-loaded' : String(real.mode ?? real.constructor?.name ?? ''), webgpu: real?.webgpuActive === true,
    gpu: real?.gpuRec === true ? { ...real.gpuStats, error: real.gpuError ?? null } : null };
}
/** Starts the installed engine (workers, runtime, models) ahead of the first reading; never rejects. */
export function warmUpOcr() { return installed == null ? Promise.resolve(false) : Promise.resolve().then(() => installed.warm?.()).then(() => true, () => false); }
