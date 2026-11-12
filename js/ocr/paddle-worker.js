// Module Web Worker of js/ocr/PaddlePool.js: runs the PaddleOCR steps of js/ocr/PaddleEngine.js off the main thread,
// with its own single-threaded onnxruntime-web (js/platform/onnx.js). Messages, answered in order, one at a time
// (an ORT session runs one inference at a time):
//   { id, op: 'init', files, rec?, webgpu? }          → { webgpu }               loads the recogniser (model bytes
//                                                                                given, else fetched); webgpu: running
//                                                                                on WebGPU
//   { id, op: 'detect', rgba, width, height }        → { boxes }                detector (loaded on first use): the text
//                                                                                boxes (the page builds each box's input
//                                                                                when a worker is free for it)
//   { id, op: 'rec', data, dims, gap? }               → { best, prob, frames,    the recogniser output's bestPath()
//                                                          gap? }               (all the page uses of it; transferred);
//                                                                                gap: also the closest call (Task A5)
//   { id, op: 'warm' }                                → {}                       loads the detector now (warm-up)
// A failure is answered as { id, error }.
import { createSession, run, setWebGpu, webGpuActive } from '../platform/onnx.js';
import { openAsset } from '../platform/assets.js';
import { detInput, detBoxes, bestPath } from './PaddleEngine.js';

let files = null, rec = null, det = null;
const session = path => openAsset(path).then(bytes => createSession(bytes));
const output = async (s, data, dims) => { const m = await s; return Object.values(await run(m, { [m.inputNames[0]]: { type: 'float32', data, dims } }))[0]; };

async function handle(m) {
  if (m.op === 'init') { files = m.files; if (m.webgpu) setWebGpu(true); rec = m.rec != null ? createSession(m.rec) : session(files.rec); await rec; return [{ webgpu: webGpuActive() }]; }
  if (m.op === 'warm') { if (det == null) det = session(files.det).catch(e => { det = null; throw e; }); await det; return [{}]; }
  if (m.op === 'detect') {
    if (det == null) det = session(files.det).catch(e => { det = null; throw e; });
    const input = detInput(m.rgba, m.width, m.height); const out = await output(det, input.data, input.dims);
    return [{ boxes: detBoxes(out.data, out.dims, m.width, m.height) }];
  }
  if (m.op === 'rec') { const out = await output(rec, m.data, m.dims); const p = bestPath(out.data, out.dims[1], out.dims[2], m.gap === true); return [p, [p.best.buffer, p.prob.buffer]]; }
  throw new Error('unknown op ' + m.op);
}
let queue = Promise.resolve();
self.onmessage = e => {
  const m = e.data;
  queue = queue.then(() => handle(m)).then(([reply, transfer = []]) => self.postMessage({ id: m.id, ...reply }, transfer),
    err => self.postMessage({ id: m.id, error: String(err?.message ?? err) }));
};
