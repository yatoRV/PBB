// ONNX Runtime wrapper replacing ai.onnxruntime (OrtEnvironment / OrtSession / OnnxTensor).
// Browser: onnxruntime-web from jsDelivr, single-threaded WASM (GitHub Pages has no cross-origin isolation).
// 1.23.2 ships only SIMD WASM (Safari >= 16.4); without WASM SIMD the 1.18.0 build with its non-SIMD
// ort-wasm.wasm is loaded instead. Node (tests): onnxruntime-node 1.23.2. All calls are async.
export const ORT_WEB_VERSION = '1.23.2';
export const ORT_WEB_FALLBACK_VERSION = '1.18.0';
const CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@';
const isNode = typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined';

/** Minimal module using i8x16.splat / i8x16.popcnt: validates only when WASM SIMD is supported. */
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
/** WASM SIMD support; `validate` is injectable for tests (defaults to WebAssembly.validate). */
export function wasmSimdSupported(validate = globalThis.WebAssembly && globalThis.WebAssembly.validate.bind(globalThis.WebAssembly)) {
  try { return typeof validate === 'function' && validate(SIMD_PROBE) === true; } catch { return false; }
}
/** Which onnxruntime-web build to load: module URL, wasmPaths and whether it uses SIMD. */
export function ortWebBuild(simd) {
  if (simd) { const dist = CDN + ORT_WEB_VERSION + '/dist/'; return { version: ORT_WEB_VERSION, module: dist + 'ort.wasm.min.mjs', wasmPaths: dist, simd: true }; }
  const dist = CDN + ORT_WEB_FALLBACK_VERSION + '/dist/'; // dist/esm/ort.wasm.min.js loads dist/ort-wasm.wasm (no SIMD, no threads)
  return { version: ORT_WEB_FALLBACK_VERSION, module: dist + 'esm/ort.wasm.min.js', wasmPaths: dist, simd: false };
}
let simdOverride = null, webgpu = false;
/** Experimental (Task A1, measured, not the default): sessions on WebGPU (onnxruntime-web's ort.webgpu build, WASM
 *  as the fallback provider) when the browser offers a WebGPU adapter. Set before the first loadOrt(). */
export function setWebGpu(on) { webgpu = on === true; }
/** Whether the sessions run on WebGPU (asked for, and an adapter was found); known once loadOrt() resolved. */
export const webGpuActive = () => webgpu && ortPromise != null;
let gpuReady = null;
const gpuAvailable = () => (gpuReady ??= (async () => { try { return !!(await globalThis.navigator?.gpu?.requestAdapter()); } catch { return false; } })());
/** Forces the SIMD decision (true/false) before the first loadOrt(); null = detect. For tests/diagnostics. */
export function setWasmSimdOverride(v) { simdOverride = v; }

let ortPromise = null;
/** Loads the runtime module once (ort namespace with InferenceSession, Tensor, env). */
export function loadOrt() {
  if (!ortPromise) ortPromise = (async () => {
    if (isNode) { const m = await import('onnxruntime-node'); return m.default ?? m; }
    const build = ortWebBuild(simdOverride ?? wasmSimdSupported());
    if (webgpu && build.simd && await gpuAvailable()) build.module = build.wasmPaths + 'ort.webgpu.min.mjs'; else webgpu = false;
    const ort = await import(build.module);
    ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; ort.env.wasm.wasmPaths = build.wasmPaths;
    ort.env.logLevel = 'error'; // no start-up / graph-cleanup warnings in the browser console
    if (!build.simd) ort.env.wasm.simd = false;
    return ort;
  })();
  return ortPromise;
}

/**
 * OrtSession from model bytes. options.graphOptimizationLevel: 'disabled' | 'basic' | 'extended' | 'all'
 * (ORT's default and Java's OptLevel.ALL_OPT are both 'all').
 */
export async function createSession(bytes, options = {}) {
  const ort = await loadOrt();
  return ort.InferenceSession.create(bytes, {
    executionProviders: isNode ? ['cpu'] : webgpu ? ['webgpu', 'wasm'] : ['wasm'],
    graphOptimizationLevel: options.graphOptimizationLevel ?? 'all',
    intraOpNumThreads: 1,
    ...(isNode ? {} : { logSeverityLevel: 3 }), // browser: errors only in the console
  });
}

/** OnnxTensor.createTensor: type 'float32' (Float32Array) or 'int64' (BigInt64Array). */
export async function tensor(type, data, dims) { const ort = await loadOrt(); return new ort.Tensor(type, data, dims); }

/**
 * session.run(feeds): feeds maps input name -> runtime Tensor, previous output tensor, or {type, data, dims}.
 * Resolves to {outputName: Tensor} where Tensor has .data (typed array), .dims and .type.
 */
export async function run(session, feeds) {
  const ort = await loadOrt(); const f = {};
  for (const [name, v] of Object.entries(feeds)) f[name] = v instanceof ort.Tensor || (v && typeof v.dispose === 'function' && v.dims && v.type) ? v : new ort.Tensor(v.type ?? 'float32', v.data, v.dims);
  return session.run(f);
}

/** Frees native/WASM memory of a session (OrtSession.close). */
export async function closeSession(session) { if (session && typeof session.release === 'function') await session.release(); }
