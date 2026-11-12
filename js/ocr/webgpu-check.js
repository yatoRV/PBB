// WebGPU self-check (Task A3). WebGPU computes in another order and precision than the WASM runtime (on a desktop
// NVIDIA GPU the outputs differed by up to 2e-5 and every one of the 1,148 recorded calls still gave the same result;
// an Apple GPU is not verified). Before the app reads with WebGPU on a device, the synthetic images of
// js/ocr/synthetic.js (same pixels on every device) are read on WebGPU and every result (each word's text and box)
// must equal the stored WASM result below; any difference keeps that device on WASM for good (remembered in
// localStorage). On by default in the app (Task A5: the GPU only recognises, checked on WASM; js/ocr/engine.js
// installDefaultEngine); localStorage ldl.ocr.webgpu = 'off' (bench.html) turns it off for a device.
import { syntheticImages, syntheticBitmap, plainResult } from './synthetic.js';

/** Results of the synthetic set on the WASM / CPU runtime (onnxruntime-node 1.23.2; equal in Chromium and WebKit
 *  WASM): regenerate (and bump CHECK_ID) whenever the models, their pre/post-processing or the set change. */
export const EXPECTED = Object.freeze({
  "cell-code": "[[[27,5,81,44],[[[27,5,81,44],[[\"D5\",[39,5,66,44]]]]]]]",
  "cell-rules": "[[[47,7,100,49],[[[47,7,100,49],[[\"15\",[53,7,89,49]]]]]]]",
  "strip": "[[[4,7,80,45],[[[4,7,80,45],[[\"ONG\",[16,7,68,45]]]]]],[[87,8,142,44],[[[87,8,142,44],[[\"12\",[104,8,129,44]]]]]],[[204,10,301,44],[[[204,10,301,44],[[\"KIEM\",[215,10,284,44]]]]]],[[312,9,384,43],[[[312,9,384,43],[[\"TRA\",[323,9,375,43]]]]]],[[495,8,610,46],[[[495,8,610,46],[[\"25/10\",[507,8,596,46]]]]]]]",
  "grey-cell": "[[[22,8,102,48],[[[22,8,102,48],[[\"S10\",[35,8,89,48]]]]]]]",
  "noisy-cell": "[[[9,8,137,49],[[[9,8,137,49],[[\"MAU\",[22,8,71,49]],[\"3\",[118,8,126,49]]]]]]]",
  "thin-small": "[[[10,8,102,34],[[[10,8,102,34],[[\"CA\",[18,8,36,34]],[\"7/9\",[61,8,97,34]]]]]]]",
  "column": "[[[5,7,49,58],[[[5,7,49,58],[[\"1\",[13,7,22,58]]]]]],[[60,7,175,57],[[[60,7,175,57],[[\"TEST\",[76,7,152,57]]]]]],[[176,10,239,54],[[[176,10,239,54],[[\"AN\",[190,10,228,54]]]]]],[[0,69,46,125],[[[0,69,46,125],[[\"2\",[18,69,28,125]]]]]],[[59,73,149,121],[[[59,73,149,121],[[\"MAU\",[75,73,131,121]]]]]],[[151,73,263,120],[[[151,73,263,120],[[\"BINH\",[166,73,245,120]]]]]],[[2,133,46,188],[[[2,133,46,188],[[\"3\",[20,133,30,188]]]]]],[[58,136,137,185],[[[58,136,137,185],[[\"VI\",[74,136,107,185]]]]]],[[125,138,195,182],[[[125,138,195,182],[[\"DU\",[146,138,176,182]]]]]],[[200,138,334,184],[[[200,138,334,184],[[\"CUONG\",[215,138,323,184]]]]]],[[2,200,45,253],[[[2,200,45,253],[[\"4\",[19,200,29,253]]]]]],[[58,201,173,251],[[[58,201,173,251],[[\"KIEM\",[74,201,150,251]]]]]],[[178,201,271,249],[[[178,201,271,249],[[\"TRA\",[194,201,250,249]]]]]],[[268,200,382,250],[[[268,200,382,250],[[\"DUNG\",[284,200,368,250]]]]]],[[1,262,47,315],[[[1,262,47,315],[[\"5\",[18,262,28,315]]]]]],[[61,264,152,314],[[[61,264,152,314],[[\"THU\",[77,264,128,314]]]]]],[[128,264,217,316],[[[128,264,217,316],[[\"J\",[128,264,137,316]],[\"EM\",[170,264,197,316]]]]]]]",
  "digits": "[[[9,6,185,65],[[[9,6,185,65],[[\"1\",[28,6,39,65]],[\"2\",[87,6,97,65]],[\"3\",[155,6,166,65]]]]]],[[9,71,180,130],[[[9,71,180,130],[[\"45\",[28,71,68,130]],[\"67\",[116,71,166,130]]]]]],[[8,134,118,193],[[[8,134,118,193],[[\"890\",[27,134,96,193]]]]]]]",
});
/** What a verdict holds for: the set, the models and the runtime. A new id checks again. */
export const CHECK_ID = 'synthetic-1;paddle-v5-latin@89d3a50e;ort-web@1.23.2;gpu-rec-a5'; // Task A5: the hybrid pool is checked anew
/** localStorage keys: the switch ('auto' turns the WebGPU check on for this device) and the verdict. */
export const SWITCH_KEY = 'ldl.ocr.webgpu', VERDICT_KEY = 'ldl.ocr.webgpu.verdict';

/** Reads every synthetic image with `engine` and compares with EXPECTED: { ok, differ: [names], images, ms }. */
export async function selfCheck(engine) {
  const differ = []; const images = syntheticImages(); const t = performance.now();
  for (const im of images) { const r = plainResult(await engine.process(syntheticBitmap(im))); if (r !== EXPECTED[im.name]) differ.push(im.name); }
  return { ok: differ.length === 0, differ, images: images.length, ms: Math.round(performance.now() - t) };
}

const read = storage => { try { const v = JSON.parse(storage?.getItem(VERDICT_KEY) ?? 'null'); return v != null && typeof v === 'object' ? v : null; } catch { return null; } };
const write = (storage, v) => { try { storage?.setItem(VERDICT_KEY, JSON.stringify(v)); } catch { /* private mode: checked again next time */ } };
/** The stored verdict for this check (null: none yet, or for another set / model / runtime). */
export const savedVerdict = (storage = globalThis.localStorage) => { const v = read(storage); return v?.id === CHECK_ID ? v : null; };

/** Task A5: a box read on WebGPU differed from its WASM reading on a real photo (js/ocr/PaddlePool.js check): this
 *  device stays on WASM for good, as after a failed self-check. stats: the pool's gpuStats. */
export function rememberMismatch(stats, { storage = globalThis.localStorage, userAgent = globalThis.navigator?.userAgent ?? '' } = {}) {
  write(storage, { id: CHECK_ID, verdict: 'fail', ua: userAgent, at: Date.now(), differ: ['real-image'], stats });
}

/**
 * The WebGPU engine for this device, or null (stay on WASM). create() → an engine with process(), warm(), terminate()
 * and `webgpuActive` (js/ocr/PaddlePool.js with webgpu: true). A device that once gave a different result never uses
 * WebGPU again (same CHECK_ID); a device that passed is checked again when its browser changes (user agent). A
 * start-up error (no adapter in the worker, device lost) is not a verdict: WASM now, tried again on the next page.
 */
export async function webGpuEngine(create, { storage = globalThis.localStorage, userAgent = globalThis.navigator?.userAgent ?? '', gpu = globalThis.navigator?.gpu } = {}) {
  const saved = savedVerdict(storage);
  if (saved?.verdict === 'fail') return null;
  if (gpu == null) return null;
  try { if (!(await gpu.requestAdapter())) return null; } catch { return null; }
  let engine = null;
  try {
    engine = create(); await engine.warm();
    if (engine.webgpuActive !== true) { engine.terminate?.(); return null; }
    if (saved?.verdict === 'pass' && saved.ua === userAgent) return engine;
    const r = await selfCheck(engine);
    if (engine.webgpuActive !== true || engine.mode === 'main-thread') { engine.terminate?.(); return null; } // the GPU pool failed meanwhile
    write(storage, { id: CHECK_ID, verdict: r.ok ? 'pass' : 'fail', ua: userAgent, at: Date.now(), differ: r.differ, ms: r.ms });
    if (r.ok) return engine;
  } catch { /* not a verdict */ }
  engine?.terminate?.(); return null;
}
