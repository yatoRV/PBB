// PaddleOCR engine on a pool of Web Workers (js/ocr/paddle-worker.js), for the browser: the main thread stays free
// (progress, scrolling) and the recognition of one image's text boxes — about 90 % of the reading time — runs on
// several workers at once, each with its own single-threaded onnxruntime-web (GitHub Pages has no cross-origin
// isolation, so ORT's own threads are not available). Results are identical to PaddleEngine's: the same steps
// (detInput / detBoxes / recInput / lineBlock) on the same runtime, one box per inference, lines put back in box order.
//  - the least busy worker (worker 0 when idle) runs the detector and returns the boxes; every worker recognises boxes from one queue,
//    one at a time each. A box's input is built here only when a worker takes it and its output is decoded as soon
//    as it comes back, so at most one input and one output per worker exist at a time (memory, see docs/PERF.md);
//  - the engine contract of js/ocr/TextRecognizer.js holds: the pixels are copied before the first await; when the
//    reader stops waiting (60 s timeout, interrupt) the call's signal aborts it and its boxes not yet started are
//    dropped, so the next reading does not wait behind them;
//  - any error from a worker (it cannot start, crashes, runs out of memory, answers with an error, or does not answer
//    within the watchdog time, counted only while the page is visible) stops the pool for good and the image (and every later one) is read by a PaddleEngine
//    on the main thread instead, so a reading never fails because of the pool and no line is lost or doubled;
//  - gpuRec (Task A5, WebGPU opted in on bench.html): one more worker recognises boxes on WebGPU, next to the WASM
//    workers, which alone detect (on the OPPO Find X7 a GPU detection split "9HC" into two boxes). GPU arithmetic is
//    not WASM's (WGSL allows other rounding), so a GPU result is used only when every frame's most probable class leads
//    the second by at least GPU_GAP and its mean probability is that far from the drop score (farther than any
//    measured GPU error: 2e-5 on a desktop GPU), else the box is read again on WASM. Every checkEvery-th GPU box is
//    read on WASM as well and compared (WASM's result is used); one difference, or any GPU worker error, retires the
//    GPU worker (its box goes to WASM) and the WASM workers read on.
import { PaddleEngine, recInput, recShape, lineBlock, bestPath, pathScore, dictChars, abandoned, RecMemo } from './PaddleEngine.js';
import { checkedPixels } from './TextRecognizer.js';
import { openAsset } from '../platform/assets.js';

/** iPhone / iPad (iPadOS reports itself as a Mac with touch). */
export const appleMobile = (nav = globalThis.navigator) => !!nav && (/iP(hone|ad|od)/.test(nav.userAgent ?? '') || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1));
/** Workers for this device: one per core but one (the page), at least 2, and at most (each worker holds its own
 *  runtime and recogniser, about 90 MB): 2 on iPhone/iPad until measured on a device; 4 on Android and on computers
 *  that report less than 8 GB (navigator.deviceMemory); 8 on other computers (Task A3: on 16 P-core threads 6 / 8 / 11
 *  workers read 7 % / 9 % / 10 % faster than 4). */
export function poolSize(cores = globalThis.navigator?.hardwareConcurrency, mobile = appleMobile(), nav = globalThis.navigator) {
  const n = Number.isFinite(cores) && cores > 0 ? cores - 1 : 2;
  const android = /Android/.test(nav?.userAgent ?? ''), memory = nav?.deviceMemory;
  const cap = mobile ? 2 : android || (Number.isFinite(memory) && memory < 8) ? 4 : 8;
  return Math.min(cap, Math.max(2, n));
}
/** Watchdog (ms): a worker that has not answered a request in this time is taken as failed. One box takes about
 *  0.1–2 s and the largest detection a few seconds on a phone; init includes downloading the runtime. */
export const POOL_TIMEOUTS = Object.freeze({ init: 120000, detect: 60000, rec: 20000 });
/** Task A5: the closest call a WebGPU result may hold and still be used (top class over the second, per frame; the mean
 *  probability against the drop score). On 1,038 recognitions of a pipe photo 0.58 % had a frame closer than this and
 *  none closer than 1e-3; a desktop GPU differed from WASM by at most 2e-5. */
export const GPU_GAP = .01;
/** Task A5: every this-many-th WebGPU box (the first one included) is also read on WASM and compared. */
export const GPU_CHECK_EVERY = 25;
/** Milliseconds the page has been visible (performance.now() minus the time it was hidden). The watchdog counts only
 *  this: iOS suspends a hidden tab (app switch, screen lock) and the workers with it, so a request in flight then is
 *  not late, and a timer that fires as the page comes back must not retire the pool. */
export function visibleClock(doc = globalThis.document, now = () => performance.now()) {
  let hidden = 0, since = doc?.hidden === true ? now() : null;
  doc?.addEventListener?.('visibilitychange', () => {
    if (doc.hidden === true) { if (since == null) since = now(); } else if (since != null) { hidden += now() - since; since = null; }
  });
  return () => (since != null ? since : now()) - hidden;
}
let pageClock = null;
/** Whether this context can run the pool (module workers; not Node). */
export const poolSupported = () => typeof Worker === 'function' && typeof window !== 'undefined';

export class PaddlePool {
  /** options: files ({det, rec, dict}), name, size (workers, default poolSize()), dropScore (.5), load(path) →
   *  Uint8Array for the dictionary (default: the site's assets), timeouts ({init, detect, rec} ms, default
   *  POOL_TIMEOUTS, counted on clock()), clock() → visible ms (default visibleClock()), createWorker() → Worker (tests), fallback() → engine used when the pool cannot run (default: a
   *  PaddleEngine of the same files). gpuRec (Task A5): one more worker recognising on WebGPU (see above), with
   *  checkEvery (GPU_CHECK_EVERY; 0: never) and onGpuMismatch(stats) when a check differed. */
  constructor(options = {}) {
    this.options = options; this.files = options.files; this.name = options.name ?? 'paddle-pool'; this.dropScore = options.dropScore ?? .5;
    this.size = options.size ?? poolSize(); this.timeouts = { ...POOL_TIMEOUTS, ...options.timeouts }; this.mode = 'starting';
    this._clock = options.clock ?? (pageClock ??= visibleClock());
    this._ready = null; this._workers = []; this._queue = []; this._ids = 0; this._local = null; this._failed = null;
    this.gpuRec = options.gpuRec === true; this.checkEvery = options.checkEvery ?? GPU_CHECK_EVERY; this.webgpuActive = false;
    this.gpuStats = { recs: 0, retried: 0, checked: 0, mismatches: 0, maxDiff: 0 }; // GPU boxes, read again on WASM, compared, different
    this.recMemo = options.recMemo === false ? null : options.recMemo ?? new RecMemo({ maxBytes: appleMobile() ? 8 << 20 : 16 << 20 }); // boxes seen before (Task A3)
  }
  _spawn(gpu = false) {
    const w = this.options.createWorker ? this.options.createWorker({ gpu }) : new Worker(new URL('./paddle-worker.js', import.meta.url), { type: 'module' });
    const slot = { w, gpu, busy: false, ready: false, pending: new Map() };
    w.onmessage = e => {
      const p = slot.pending.get(e.data.id); if (p == null) return; slot.pending.delete(e.data.id); clearTimeout(p.timer);
      if (e.data.error != null) p.reject(new Error(e.data.error)); else p.resolve(e.data);
    };
    w.onerror = e => { e.preventDefault?.(); this._slotFailed(slot, new Error('OCR worker failed: ' + (e.message || 'error'))); };
    w.onmessageerror = () => this._slotFailed(slot, new Error('OCR worker message failed'));
    return slot;
  }
  /** One request to a worker; no answer within `ms` of visible time stops the pool (watchdog). A timer that fires
   *  while the page is hidden, or as it comes back from being suspended, is armed again for the visible time left. */
  _send(slot, msg, ms, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = ++this._ids, start = this._clock(), p = { resolve, reject, timer: null };
      const arm = left => setTimeout(() => {
        const used = this._clock() - start;
        if (used >= ms) this._slotFailed(slot, new Error('OCR worker did not answer ' + msg.op + ' in ' + ms + ' ms')); else p.timer = arm(ms - used);
      }, left);
      p.timer = arm(ms); slot.pending.set(id, p); slot.w.postMessage({ id, ...msg }, transfer);
    });
  }
  /** A worker failed: the GPU worker is retired alone (the WASM workers read on), any other stops the pool. */
  _slotFailed(slot, error) { if (slot.gpu) this._retireGpu(slot, error); else this._fail(error); }
  /** Stops the GPU worker for good (Task A5); its box in flight is read on WASM (see _pump). */
  _retireGpu(slot, error) {
    if (slot.retired) return; slot.retired = true; slot.ready = false; this.gpuError = String(error?.message ?? error);
    for (const p of slot.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    slot.pending.clear(); try { slot.w.terminate(); } catch { /* already gone */ }
    this._workers = this._workers.filter(x => x !== slot); this.webgpuActive = false; this._mode(); this._pump();
  }
  /** Stops every worker for good; pending requests and queued boxes reject with the error, and every call goes to
   *  the main-thread engine from now on. */
  _fail(error) {
    if (this._failed != null) return; this._failed = error; this.mode = 'main-thread';
    for (const s of this._workers) {
      for (const p of s.pending.values()) { clearTimeout(p.timer); p.reject(error); }
      s.pending.clear(); try { s.w.terminate(); } catch { /* already gone */ }
    }
    const queued = this._queue; this._queue = []; for (const job of queued) { job.memo?.(null); job.call.fail(error); }
  }
  /** Worker 0 first: it downloads the runtime (onnxruntime-web WASM) into the HTTP cache, so the others, started
   *  once it is ready, do not download it again; the recogniser model is fetched once here and given to each. A worker
   *  other than 0 that cannot start is left out. */
  _start() {
    if (this._ready == null) this._ready = (async () => {
      const load = this.options.load ?? openAsset; const webgpu = this.options.webgpu === true;
      const [rec, dict] = await Promise.all([load(this.files.rec), load(this.files.dict)]); this._dict = dictChars(dict);
      const first = this._spawn(); this._workers = [first];
      const started = await this._send(first, { op: 'init', files: this.files, rec, webgpu }, this.timeouts.init); first.ready = true;
      this.webgpuActive = started.webgpu === true; // asked for and running on WebGPU (else the worker's WASM)
      if (this._failed != null) throw this._failed; this._mode();
      for (let i = 1; i < this.size; i++) {
        const s = this._spawn(); this._workers.push(s);
        this._send(s, { op: 'init', files: this.files, rec, webgpu }, this.timeouts.init).then(() => { s.ready = true; this._mode(); this._pump(); },
          () => { if (this._failed != null) return; try { s.w.terminate(); } catch { /* gone */ } this._workers = this._workers.filter(x => x !== s); this._mode(); });
      }
      if (this.gpuRec) this._gpuStarted = this._startGpu(rec); // the WASM workers read meanwhile; warm() waits for it
    })().catch(e => { this._fail(e); throw e; });
    return this._ready;
  }
  /** Task A5: the WebGPU recognising worker; one that cannot start on WebGPU (no adapter in the worker) is left out. */
  async _startGpu(rec) {
    const s = this._spawn(true); this._workers.push(s);
    try {
      const r = await this._send(s, { op: 'init', files: this.files, rec, webgpu: true }, this.timeouts.init);
      if (s.retired || this._failed != null) return;
      if (r.webgpu !== true) { this._retireGpu(s, new Error('no WebGPU adapter in the worker')); return; }
      s.ready = true; this.webgpuActive = true; this._mode(); this._pump();
    } catch (e) { this._retireGpu(s, e); }
  }
  /** The ready worker with the fewest requests in flight, worker 0 on a tie (Task A4: the pipe reader reads several
   *  photos at once, and their detections no longer queue on worker 0 alone; one image alone is detected on worker 0
   *  as before). Every worker loads the detector on first use. */
  _detector() {
    let best = this._workers[0]; // a WASM worker: the GPU worker never detects (Task A5)
    for (const s of this._workers) if (s.ready && !s.gpu && s.pending.size < best.pending.size) best = s;
    return best;
  }
  _mode() { if (this._failed == null) this.mode = 'workers:' + this._workers.filter(s => s.ready && !s.gpu).length + (this._workers.some(s => s.ready && s.gpu) ? '+gpu' : ''); }
  /** Hands queued boxes to free workers: a box's input is built now and its output decoded on arrival. The GPU worker
   *  takes the first box not marked for WASM. */
  _pump() {
    for (const s of this._workers) {
      if (this._failed != null) return; if (s.busy || !s.ready) continue;
      const i = s.gpu ? this._queue.findIndex(j => !j.wasmOnly) : 0; if (i < 0 || i >= this._queue.length) continue;
      const job = this._queue.splice(i, 1)[0];
      let input; try { input = job.call.input(job.k); } catch (e) { job.memo?.(null); job.call.fail(e); continue; }
      s.busy = true;
      this._send(s, { op: 'rec', data: input.data, dims: input.dims, ...(s.gpu ? { gap: true } : {}) }, this.timeouts.rec, [input.data.buffer])
        .then(out => this._recognised(s, job, out.best != null ? out : bestPath(out.data, out.dims[1], out.dims[2], s.gpu)),
          e => { if (s.gpu && this._failed == null) { this._retireGpu(s, e); this._again(job); } else { job.memo?.(null); job.call.fail(e); } })
        .finally(() => { s.busy = false; this._pump(); });
    }
  }
  /** A box's recogniser output came back. A GPU result with a close call goes to WASM; a sampled one goes to WASM as
   *  well with the GPU result, to compare (Task A5). */
  _recognised(slot, job, path) {
    if (slot.gpu) {
      const st = this.gpuStats; st.recs++;
      if (!(path.gap >= GPU_GAP) || Math.abs(pathScore(path) - this.dropScore) < GPU_GAP) { st.retried++; this._again(job); return; }
      if (this.checkEvery > 0 && (st.recs - 1) % this.checkEvery === 0) { st.checked++; this._again({ ...job, gpuPath: path }); return; }
    } else if (job.gpuPath != null) this._compare(job.gpuPath, path);
    job.memo?.(path); job.call.done(job.k, path);
  }
  /** The box again, first in the queue, for a WASM worker. */
  _again(job) {
    if (job.call.isOver?.()) { job.memo?.(null); return; }
    if (this._failed != null) { job.memo?.(null); job.call.fail(this._failed); return; }
    this._queue.unshift({ ...job, wasmOnly: true }); this._pump();
  }
  /** A sampled GPU box against its WASM reading: the same class in every frame and the same drop decision, else the
   *  GPU worker is retired (and onGpuMismatch told); the largest probability difference is kept for the log. */
  _compare(gpu, wasm) {
    const st = this.gpuStats; let same = gpu.frames === wasm.frames, diff = 0;
    for (let t = 0; same && t < wasm.frames; t++) { if (gpu.best[t] !== wasm.best[t]) same = false; else diff = Math.max(diff, Math.abs(gpu.prob[t] - wasm.prob[t])); }
    if (same && (pathScore(gpu) < this.dropScore) !== (pathScore(wasm) < this.dropScore)) same = false;
    if (same) { if (diff > st.maxDiff) st.maxDiff = diff; return; }
    const g = this._workers.find(s => s.gpu); if (g == null) return; // retired by an earlier check still in flight
    st.mismatches++;
    try { this.options.onGpuMismatch?.({ ...st }); } catch { /* the caller's problem */ }
    this._retireGpu(g, new Error('WebGPU read a box differently from WASM'));
  }
  /** Warm-up before the first reading (js/ocr/warm-up.js): starts the workers and loads the detector in worker 0 (the
   *  recogniser is loaded by init). Best effort: a failure here leaves the pool as it is (the first reading meets the
   *  same failure and falls back as usual). */
  async warm() {
    if (this._failed != null) { await this._main().warm?.(); return; }
    await this._start();
    await this._gpuStarted; // Task A5: webgpuActive is known after warm() (js/ocr/webgpu-check.js)
    try { await this._send(this._workers[0], { op: 'warm' }, this.timeouts.init); } catch { /* the first detection loads it again */ }
  }
  _main() { return this._local ??= this.options.fallback ? this.options.fallback() : new PaddleEngine({ name: this.name, files: this.files, dropScore: this.dropScore }); }

  /** options.signal (AbortSignal from js/ocr/TextRecognizer.js): the reader stopped waiting — drop the rest. */
  process(bitmap, { signal } = {}) {
    let width, height, rgba;
    try { width = bitmap.getWidth(); height = bitmap.getHeight(); rgba = bitmap.owned === true ? checkedPixels(bitmap) : new Uint8ClampedArray(checkedPixels(bitmap)); } catch (e) { return Promise.reject(e); }
    const own = { data: rgba, owned: true, getWidth: () => width, getHeight: () => height, isRecycled: () => false };
    if (this._failed != null) return this._main().process(own, { signal });
    return this._read(rgba, width, height, signal).catch(e => {
      if (e?.abandoned === true) throw e;
      this._fail(e); // any error in the pool: stop it for good, read this image on the main thread
      return this._main().process(own, { signal });
    });
  }
  async _read(rgba, width, height, signal) {
    if (signal?.aborted) throw abandoned();
    await this._start();
    // The detecting worker gets a copy of the pixels (the main thread keeps its own to build the inputs and for lineBlock).
    const { boxes } = await this._send(this._detector(), { op: 'detect', rgba, width, height }, this.timeouts.detect);
    if (signal?.aborted) throw abandoned();
    const blocks = new Array(boxes.length);
    if (boxes.length > 0) await new Promise((resolve, reject) => {
      let left = boxes.length, over = false;
      const finish = () => { over = true; signal?.removeEventListener('abort', onAbort); };
      const call = {
        isOver: () => over,
        input: k => recInput(rgba, width, height, boxes[k]),
        done: (k, path) => {
          if (over) return;
          try { blocks[k] = lineBlock(rgba, width, height, boxes[k], recShape(boxes[k]), path, null, this._dict, this.dropScore); } catch (e) { call.fail(e); return; }
          if (--left === 0) { finish(); resolve(); }
        },
        fail: e => {
          if (over) return; finish();
          this._queue = this._queue.filter(j => { if (j.call !== call) return true; j.memo?.(null); return false; }); reject(e);
        },
      };
      const onAbort = () => call.fail(abandoned());
      signal?.addEventListener('abort', onAbort, { once: true });
      // A box whose pixels were recognised before is answered from the memo; one being recognised now is waited for.
      // A box queued after the pool failed (its run in another call failed with it) fails this call, which is then read
      // on the main thread like any other image of a failed pool.
      const keyOf = k => (this.recMemo == null ? null : RecMemo.key(rgba, width, height, boxes[k]));
      const queue = (k, key) => {
        if (this._failed != null) { call.fail(this._failed); return; }
        this._queue.push({ call, k, memo: key == null ? null : this.recMemo.begin(key) });
      };
      for (let k = 0; k < boxes.length && !over; k++) {
        const key = keyOf(k); const known = key == null ? null : this.recMemo.get(key);
        if (known?.path != null) call.done(k, known.path);
        else if (known?.pending != null) known.pending.then(p => { if (over) return; if (p != null) call.done(k, p); else { queue(k, keyOf(k)); this._pump(); } });
        else queue(k, key);
      }
      this._pump();
    });
    return { textBlocks: blocks.filter(b => b != null) };
  }
  close() { /* the workers stay for the page, like the sessions of PaddleEngine */ }
  /** Stops the workers for good (an engine that is not used after all, e.g. a WebGPU pool that failed its check). */
  terminate() { this._fail(Object.assign(new Error('OCR pool terminated'), { abandoned: true })); }
}
