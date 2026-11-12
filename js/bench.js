// bench.html (Task A3): measures the OCR engine of the app on the visitor's device with synthetic images only
// (js/ocr/synthetic.js: drawn in code, same pixels on every device; no photo, no name, no sign-in, nothing sent).
// Three ways are measured one after another, each started, used and stopped before the next (memory on iPhone):
//   WASM on 2 Web Workers (the app's default on iPhone / iPad), WebGPU on 1 worker, 2 WASM workers + 1 WebGPU worker
//   recognising (Task A5: the app's 'auto' mode, its default; every GPU box of the sample set compared on WASM), WASM
//   on the main thread (as before Task A1; last, since its runtime cannot be unloaded).
// For each: start-up time, the time of one synthetic sheet page and per text box, and whether every result equals the
// stored WASM results (js/ocr/webgpu-check.js EXPECTED) and the WASM page. A short Vietnamese summary to screenshot.
// The recognition memo is off here (the page is read twice on WebGPU; the memo would answer the second time).
// ?quick=1: a small page (browser tests).
import { PaddleEngine, PADDLE_LATIN_FILES } from './ocr/PaddleEngine.js';
import { PaddlePool, poolSize, appleMobile, GPU_CHECK_EVERY } from './ocr/PaddlePool.js';
import { syntheticPage, syntheticBitmap, plainResult } from './ocr/synthetic.js';
import { selfCheck, SWITCH_KEY, savedVerdict } from './ocr/webgpu-check.js';
import { wasmSimdSupported, ORT_WEB_VERSION } from './platform/onnx.js';

const $ = id => document.getElementById(id);
const quick = new URLSearchParams(location.search).get('quick') === '1';
const nf = d => n => n.toLocaleString('vi-VN', { minimumFractionDigits: d, maximumFractionDigits: d });
const s1 = nf(1);
const sec = ms => s1(ms / 1000) + ' s';
const now = () => performance.now();
const store = () => { try { return globalThis.localStorage; } catch { return null; } };

/** Device facts relevant to speed. */
async function deviceInfo() {
  const ua = navigator.userAgent ?? '';
  const ios = ua.match(/(iPhone|iPad|iPod).*? OS (\d+)[_.](\d+)/), mac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  const safari = ua.match(/Version\/([\d.]+).*Safari/), chrome = ua.match(/(?:Chrome|CriOS)\/([\d.]+)/), firefox = ua.match(/(?:Firefox|FxiOS)\/([\d.]+)/);
  const system = ios ? ios[1] + ' · iOS ' + ios[2] + '.' + ios[3] : mac ? 'iPad (iPadOS, báo là Mac)' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : 'khác';
  const browser = /CriOS/.test(ua) ? 'Chrome (iOS) ' + chrome[1] : /FxiOS/.test(ua) ? 'Firefox (iOS) ' + firefox[1] : chrome ? 'Chrome/Chromium ' + chrome[1] : firefox ? 'Firefox ' + firefox[1] : safari ? 'Safari ' + safari[1] : 'không rõ';
  let gpu = 'không có (trình duyệt không có WebGPU)', adapter = null;
  if (navigator.gpu) {
    try { adapter = await navigator.gpu.requestAdapter(); } catch { adapter = null; }
    if (adapter) { const i = adapter.info ?? {}; gpu = 'có' + ([i.vendor, i.architecture, i.description].filter(Boolean).length ? ' (' + [i.vendor, i.architecture, i.description].filter(Boolean).join(', ') + ')' : ''); }
    else gpu = 'có WebGPU nhưng không có bộ GPU dùng được';
  }
  return { ua, system, browser, cores: navigator.hardwareConcurrency ?? null, memory: navigator.deviceMemory ?? null, simd: wasmSimdSupported(), gpu, adapter: adapter != null, appleMobile: appleMobile(), appWorkers: poolSize() };
}
function showDevice(d) {
  const facts = [['Hệ điều hành', d.system], ['Trình duyệt', d.browser], ['Số nhân (hardwareConcurrency)', d.cores ?? 'không báo'], ['Bộ nhớ (deviceMemory)', d.memory != null ? d.memory + ' GB' : 'không báo'],
    ['WASM SIMD', d.simd ? 'có' : 'không'], ['WebGPU', d.gpu], ['App dùng', d.appWorkers + ' worker'], ['Bộ chạy', 'onnxruntime-web ' + ORT_WEB_VERSION]];
  const dl = $('device'); dl.replaceChildren();
  for (const [k, v] of facts) { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = String(v); dl.append(dt, dd); }
  const dt = document.createElement('dt'); dt.textContent = 'User agent'; const dd = document.createElement('dd'); dd.className = 'small'; dd.textContent = d.ua; dl.append(dt, dd);
}

/** One way of running: start, the synthetic set (equality), then the page (twice on WebGPU: shaders are built on the
 *  first run). */
async function measure(label, make, page, { twice = false, checkAll = false } = {}) {
  const r = { label }; let engine = null;
  try {
    engine = make(); let t = now(); await engine.warm(); r.startMs = now() - t;
    if (engine.webgpuActive === false && label.includes('WebGPU')) throw new Error('WebGPU không chạy được trong worker');
    // checkAll (Task A5, the app's WebGPU way): every box the GPU reads in the sample set is also read on WASM and
    // compared (the largest difference and any different box are shown); the page is then timed as the app reads
    if (checkAll) engine.checkEvery = 1;
    r.set = await selfCheck(engine);
    if (checkAll) engine.checkEvery = GPU_CHECK_EVERY;
    t = now(); const res = await engine.process(syntheticBitmap(page)); r.pageMs = now() - t;
    if (twice) { r.firstPageMs = r.pageMs; t = now(); await engine.process(syntheticBitmap(page)); r.pageMs = now() - t; }
    r.boxes = res.textBlocks.length; r.page = plainResult(res); r.mode = engine.mode ?? 'main-thread';
    if (engine.gpuRec === true) r.gpu = { ...engine.gpuStats, error: engine.gpuError ?? null };
    if (engine.mode === 'main-thread' && engine instanceof PaddlePool) r.note = 'bộ worker lỗi, đã chạy trên luồng chính';
  } catch (e) { r.error = String(e?.message ?? e); }
  finally { engine?.terminate?.(); }
  return r;
}

function row(r, ref) {
  const tr = document.createElement('tr'); const same = r.error ? '—' : (r.set.ok && (ref == null || r.page === ref) && !(r.gpu?.mismatches > 0)) ? 'có' : 'KHÔNG'; // a GPU box that differed counts (Task A5)
  const cells = [r.label, r.error ? '—' : sec(r.startMs), r.skipped ? 'không có' : r.error ? 'lỗi' : sec(r.pageMs) + (r.firstPageMs != null ? ' (lần đầu ' + sec(r.firstPageMs) + ')' : ''), r.error ? '—' : Math.round(r.pageMs / Math.max(1, r.boxes)) + ' ms', same];
  cells.forEach((c, k) => { const td = document.createElement(k === 0 ? 'th' : 'td'); if (k === 0) td.scope = 'row'; td.textContent = c; tr.append(td); });
  if (r.error) tr.title = r.error;
  return tr;
}

async function run(device) {
  const start = $('start'); start.disabled = true; $('result').hidden = true;
  const page = quick ? syntheticPage(3, 3) : syntheticPage(14, 8);
  const status = t => { $('status').textContent = t; };
  const results = [];
  status('1/4 · WASM, 2 worker…');
  results.push(await measure('WASM, 2 worker', () => new PaddlePool({ name: 'bench', files: PADDLE_LATIN_FILES, size: 2, recMemo: false }), page));
  const noGpu = label => ({ label, error: 'máy/trình duyệt này không có WebGPU', skipped: true });
  if (device.adapter) {
    status('2/4 · WebGPU, 1 worker…');
    results.push(await measure('WebGPU, 1 worker', () => new PaddlePool({ name: 'bench', files: PADDLE_LATIN_FILES, size: 1, webgpu: true, recMemo: false }), page, { twice: true }));
    status('3/4 · WASM 2 worker + WebGPU đọc chữ…');
    results.push(await measure('WASM 2 worker + WebGPU đọc chữ', () => new PaddlePool({ name: 'bench', files: PADDLE_LATIN_FILES, size: 2, gpuRec: true, recMemo: false }), page, { twice: true, checkAll: true }));
  } else results.push(noGpu('WebGPU, 1 worker'), noGpu('WASM 2 worker + WebGPU đọc chữ'));
  status('4/4 · WASM, luồng chính…');
  results.push(await measure('WASM, luồng chính', () => new PaddleEngine({ name: 'bench', files: PADDLE_LATIN_FILES, recMemo: false }), page));
  status('Xong.');
  const ref = results.find(r => !r.error && !r.label.includes('WebGPU'))?.page ?? null;
  $('page-size').textContent = page.width + '×' + page.height + ' điểm ảnh, ' + (results.find(r => !r.error)?.boxes ?? '?') + ' ô chữ';
  const rows = $('rows'); rows.replaceChildren(...results.map(r => row(r, ref)));
  $('summary').textContent = summary(device, results, ref);
  $('detail').textContent = results.map(r => r.label + ': ' + (r.error ? 'lỗi — ' + r.error : 'ảnh mẫu giống WASM ' + (r.set.images - r.set.differ.length) + '/' + r.set.images + (r.set.differ.length ? ' (khác: ' + r.set.differ.join(', ') + ')' : '') + ', chạy ' + r.mode + (r.gpu ? ', ' + gpuText(r.gpu) : ''))).join(' · ');
  $('result').hidden = false; start.disabled = false; start.textContent = 'Đo lại';
  const app = results[2]; showSwitch(!app.error && app.set.ok && app.page === ref && !(app.gpu?.mismatches > 0)); // the way the app uses WebGPU (Task A5)
  $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Task A5: what the GPU worker did — boxes, close calls read again on WASM, boxes compared with WASM, how many
 *  differed and the largest probability difference among the equal ones. */
const gpuText = g => 'GPU đọc ' + g.recs + ' ô, đọc lại bằng chip ' + g.retried + ', so với chip ' + g.checked + ' ô, khác ' + g.mismatches + ', lệch lớn nhất ' + (g.maxDiff > 0 ? g.maxDiff.toExponential(1) : '0') + (g.error ? ' (GPU dừng: ' + g.error + ')' : '');
function summary(d, results, ref) {
  const [pool, gpu, hybrid, main] = results; const parts = [];
  parts.push(d.system + ', ' + d.browser + ', ' + (d.cores ?? '?') + ' nhân, WebGPU: ' + (d.adapter ? 'có' : 'không') + '.');
  const t = r => (r.skipped ? 'không có' : r.error ? 'lỗi' : sec(r.pageMs));
  parts.push('Một trang mẫu: WASM luồng chính ' + t(main) + ', WASM 2 worker ' + t(pool) + (gpu.skipped ? '' : ', WebGPU ' + t(gpu) + (gpu.firstPageMs != null ? ' (lần đầu ' + sec(gpu.firstPageMs) + ')' : '')) + '.');
  if (!main.error && !pool.error) parts.push('2 worker nhanh hơn luồng chính ' + s1(main.pageMs / pool.pageMs) + ' lần.');
  if (!gpu.error) {
    const same = gpu.set.ok && gpu.page === ref;
    parts.push('WebGPU ' + (pool.error ? '' : 'nhanh hơn 2 worker ' + s1(pool.pageMs / gpu.pageMs) + ' lần, ') + 'kết quả ' + (same ? 'GIỐNG HỆT WASM' : 'KHÁC WASM') + ' (' + (gpu.set.images - gpu.set.differ.length) + '/' + gpu.set.images + ' ảnh mẫu' + (gpu.page === ref ? ', trang mẫu giống' : ', trang mẫu khác') + ').');
  } else if (!gpu.skipped) parts.push('WebGPU: lỗi (' + gpu.error + ').');
  if (!hybrid.error) {
    const same = hybrid.set.ok && hybrid.page === ref && !(hybrid.gpu?.mismatches > 0);
    parts.push('Cách app dùng WebGPU (2 worker chip dò và đọc, GPU phụ đọc chữ): ' + t(hybrid) + (pool.error ? '' : ', nhanh hơn 2 worker ' + s1(pool.pageMs / hybrid.pageMs) + ' lần') + ', kết quả ' + (same ? 'GIỐNG HỆT WASM' : 'KHÁC WASM') + (hybrid.gpu ? '; ' + gpuText(hybrid.gpu) : '') + '.');
  } else if (!hybrid.skipped) parts.push('WASM + WebGPU đọc chữ: lỗi (' + hybrid.error + ').');
  return parts.join(' ');
}

/** The per-device switch, shown as soon as the page opens (Task A5; before, only after a measurement). passed: whether
 *  WebGPU gave the WASM results in this page's measurement (null: not measured yet). */
function showSwitch(passed = null) {
  // Task A5: WebGPU helps recognise by default in the app (checked on WASM); this switch turns it off on this device.
  const s = store(); if (s == null) return; // no storage: no per-device switch (the app then uses the default)
  let on = true; try { on = s.getItem(SWITCH_KEY) !== 'off'; } catch { /* no storage */ }
  const verdict = savedVerdict(s);
  $('switch').hidden = false;
  $('switch-text').textContent = on
    ? 'Đang bật (mặc định): chip dò chữ, GPU phụ đọc chữ; chữ GPU đọc sát ngưỡng thì chip đọc lại, cứ 25 ô có 1 ô được chip đối chiếu và chỉ cần khác 1 lần là GPU tự tắt trên máy này. Trước khi dùng, app tự kiểm tra WebGPU bằng ảnh mẫu' + (verdict ? ' (lần kiểm tra trước: ' + (verdict.verdict === 'pass' ? 'giống' : 'khác — app chỉ dùng chip') + ')' : passed === false ? '; trên máy này WebGPU không có hoặc cho kết quả khác, nên app chỉ dùng chip' : '') + '. Đóng hẳn app rồi mở lại để áp dụng.'
    : 'Đã tắt trên máy này: app chỉ dùng chip (WASM), chậm hơn nhưng giống hệt bản gốc. Đóng hẳn app rồi mở lại để áp dụng.';
  const b = $('switch-button'); b.textContent = on ? 'Tắt WebGPU trong app' : 'Bật lại WebGPU trong app';
  b.onclick = () => { try { if (on) s.setItem(SWITCH_KEY, 'off'); else s.removeItem(SWITCH_KEY); } catch { /* no storage */ } showSwitch(passed); };
}

const device = await deviceInfo(); showDevice(device); showSwitch();
const start = $('start'); start.disabled = false; start.addEventListener('click', () => run(device));
window.benchReady = true;
