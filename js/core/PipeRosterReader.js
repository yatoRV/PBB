// Port of vn.lichdilam.PipeRosterReader (APK 4.5). Every method that waits for OCR, ONNX or a PNG encode is async
// (read, the grid/header/name/cell readers, evidence); the pure rules (evenRows, completeGrid, plausiblePrintedName,
// withoutFaintLeftRule, thick, the focused-number checks…) stay synchronous and static. ML Kit →
// js/ocr/TextRecognizer.js with the same Text/TextBlock/Line/Element walk; Tasks.await keeps its 60 s timeout.
// Java float math via Math.fround, int division with |0 (truncation), Math.round(float) with roundF. HashMap whose
// order reaches GlyphMatch.classify → JavaHashMap; LinkedHashMap → Map; HashSet used only for membership → Set.
// Java's `catch (Exception)` also catches JS errors (Java's NullPointerException and the like); `catch
// (RuntimeException)` catches RuntimeException and JS TypeError/RangeError. Run as a job of an ExecutorService
// (js/platform/java.js), Future.cancel(true) / shutdownNow() interrupt it: the Thread.isInterrupted() checks and
// Tasks.await then throw InterruptedException exactly where the Java does.
import { IllegalArgumentException, IOException, InterruptedException, RuntimeException, JavaHashMap, UUID, Thread, Integer, format, javaFloatToString, roundF, split, trim } from '../platform/java.js';
import { JSONObject, JSONArray, jfloat } from '../platform/json.js';
import { File, FileOutputStream } from '../platform/files.js';
import { Bitmap, Canvas, Color, Matrix, Paint, Typeface } from '../platform/bitmap.js';
import { BuildConfig, Uri } from '../platform/android.js';
import { Log } from '../platform/log.js';
import { TextRecognition, TextRecognizerOptions, InputImage, Tasks, TimeUnit } from '../ocr/TextRecognizer.js';
import { ocrEngineInfo } from '../ocr/engine.js';
import { OcrCheckpoint } from '../ocr/checkpoint.js';
import { AppLog } from './AppLog.js';
import { GridVision } from './GridVision.js';
import { PipeHeaders } from './PipeHeaders.js';
import { PipeBook } from './PipeBook.js';
import { PipeDay } from './PipeDay.js';
import { PipeRules } from './PipeRules.js';
import { PipeFieldVotes } from './PipeFieldVotes.js';
import { PipeSourceCache } from './PipeSourceCache.js';
import { PipeNumericEdge } from './PipeNumericEdge.js';
import { PipeNumericContrast } from './PipeNumericContrast.js';
import { PipeNumericFocus } from './PipeNumericFocus.js';
import { GlyphMatch } from './GlyphMatch.js';
import { ErrorLedger } from './ErrorLedger.js';
import { ImageFiles } from './ImageFiles.js';
import { Personnel } from './Personnel.js';
import { RosterRows } from './RosterRows.js';
import { Schedule } from './Schedule.js';
import { OcrCodes } from './OcrCodes.js';
import { NameReader } from './NameReader.js';
import { CellReader } from './CellReader.js';

const f = Math.fround;
const ARGB_8888 = Bitmap.Config.ARGB_8888;
/** Java's `.` (any char but a line terminator), for String.matches(".*x.*"). */
const DOT = '[^\\n\\r\\u0085\\u2028\\u2029]';
const DIGIT_ANYWHERE = new RegExp('^' + DOT + '*[0-9]' + DOT + '*$');
const NOT_NAME_CHAR = new RegExp('^' + DOT + '*[^\\p{L}\\p{M} \\t\\n\\x0B\\f\\r.,\'’|_-]' + DOT + '*$', 'u');
const VOWEL_ANYWHERE = new RegExp('^' + DOT + '*[aeiouy]' + DOT + '*$');
const HEADER_CODE_LABEL = /^(?:VT|0H|OH|QT|TC|HC|TC1|TC2|TC3|S10|S17|S26|D5|D6|D23|C23)$/;
const runtime = e => e instanceof RuntimeException || e instanceof TypeError || e instanceof RangeError;
const interrupted = e => e instanceof InterruptedException;
/** java.util.Arrays.toString / deepToString of String / float arrays (debug logs only). */
const arrayText = a => (a == null ? 'null' : '[' + Array.from(a, v => (v != null && typeof v === 'object' ? arrayText(v) : typeof v === 'number' ? javaFloatToString(v) : String(v))).join(', ') + ']');
/** Map.get / Map.put for a JS Map (LinkedHashMap) or a JavaTreeMap (PipeBook.Employee.days). */
const mapGet = (m, k) => { const v = m.get(k); return v === undefined ? null : v; };
const mapPut = (m, k, v) => { if (m instanceof Map) m.set(k, v); else m.put(k, v); };
const mapEmpty = m => (m instanceof Map ? m.size === 0 : m.isEmpty());
const baseName = file => new File(file).getName().replace(/\.png$/, '');

class Source {
  /** new Source(uri[, primary]) — uri: an android.js Uri (or a picked File/Blob) the ContentResolver can open. */
  constructor(uri, primary = false) { this.uri = uri; this.primary = primary; Object.freeze(this); }
}
/** Shared geometry/header selection, before names or field OCR; no schedule/cache writes. */
class GridSelection {
  constructor(grid, layout, sawGrid) { this.grid = grid; this.layout = layout; this.sawGrid = sawGrid; }
  close() { if (this.grid != null && !this.grid.table.isRecycled()) this.grid.table.recycle(); }
}
/** The position cell of one day of one row, with the place its reading is stored. */
class Glyph { constructor(map, key, signature) { this.map = map; this.key = key; this.signature = signature; } }

/** A day of a person whose name is printed on two rows of one photo: unknown, its readings kept for the record. */
function unknownRepeated(v) { return new PipeDay(null, null, null, (v == null ? '' : v.raw) + ' · tên lặp lại trên ảnh', v == null ? '' : v.evidence); }
function headerCodeLabel(text) { return HEADER_CODE_LABEL.test(trim(text).toUpperCase()); }
// eslint-disable-next-line no-unused-vars
function hasText(s) { return s.replace(/[ \t\n\x0B\f\r|_[\]]/g, '') !== ''; }
function withoutFaintLeftRuleBitmap(cell) {
  const w = cell.getWidth(), h = cell.getHeight(); const pixels = new Int32Array(w * h); cell.getPixels(pixels, 0, w, 0, 0, w, h);
  const cleaned = PipeRosterReader.withoutFaintLeftRule(pixels, w, h); return cleaned == null ? null : Bitmap.createBitmap(cleaned, w, h, ARGB_8888);
}
function sharedGray(pixel) { return ((((pixel >> 16) & 255) * 30 + ((pixel >> 8) & 255) * 59 + (pixel & 255) * 11) / 100) | 0; }
/** Java Matcher semantics of `$` (end of input, or before a final line terminator) for the trailing "WK". */
const TRAILING_WK = /WK(?=(?:\r\n|[\n\r\u0085\u2028\u2029])?$)/gi;

/** OCRs each page into dated records for all readable employees, then merges by identity/date. */
/** Pipe photos read at the same time (Task A4): 3, or 2 on iPhone / iPad (memory: each photo holds a 4K scan) and on
 *  devices that report under 4 GB. Measured on the recorded calls of three photos (Chromium, docs/PERF.md A4). */
/** Task A5: a GPU count of this read (the pool counts since the page opened; null without a GPU worker). */
const gpuDelta = (now, before, key) => (now == null ? null : now[key] - (before?.[key] ?? 0));
export function pipePagesAtOnce(nav = globalThis.navigator) {
  const ua = nav?.userAgent ?? '', apple = /iP(hone|ad|od)/.test(ua) || (nav?.platform === 'MacIntel' && nav?.maxTouchPoints > 1);
  return apple || (Number.isFinite(nav?.deviceMemory) && nav.deviceMemory < 4) ? 2 : 3;
}
export class PipeRosterReader {
  static Source = Source;
  static GridSelection = GridSelection;
  static _Glyph = Glyph;
  /** Audit only: also save each part of every day cell (set by Audit30DeviceTest before an import). */
  static saveCellParts = false;
  static TEMPLATE_SCORE = f(.75); static TEMPLATE_MARGIN = f(.10);
  static HEADER_VIEWS = 6;

  constructor(context) {
    this._recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
    /** Debug builds: the candidate being read (page, angle, bound), naming the header dumps. */
    this._debugTag = '';
    /** The page being read is team T5's (dates read by their printed numbers): its one-cell pipe and duty is not what the
     *  pipe-number reader learnt, so it never vetoes a pipe there. */
    this._numberedSheet = false;
    /** OCR time limit of one call (s): the APK's 60, times the photos read at once (Task A4). */
    this._ocrWaitSeconds = 60;
    /** Photos read at the same time (null: pipePagesAtOnce(); 1: one after another, as the APK). */
    this.pagesAtOnce = null;
    this._context = context;
    /** Audit hooks (3.0 name training): read only the name column, and keep every name reading per row
     *  {page, row, ML Kit, ML Kit enhanced, VietOCR views…, chosen text}. Off in the app. */
    this.namesOnly = false; this.nameLog = [];
    /** Explicit re-read of the selected saved sources; normal imports may still reuse their cached result. */
    this.forceRefresh = false;
    /** Last accepted orientation, exposed to device diagnostics. */
    this.selectedAngle = -1;
    this._ledger = null;
    this._vietOcr = null; this._pipeReader = null; this._pipeReaderT5 = null; this._loading = null; // opened once, see _once
    /** This reader; a lane (a view per photo, Task A4) inherits it, so shared state is written here. */
    this._self = this;
    this._directory = new File(context.getFilesDir(), 'pipe-scans/' + UUID.randomUUID()); if (!this._directory.mkdirs()) throw new IOException('Không tạo được thư mục bản quét.');
  }
  directory() { return this._directory; }
  async _text(b) {
    const result = await Tasks.await(this._recognizer.process(InputImage.fromBitmap(b, 0)), this._ocrWaitSeconds, TimeUnit.SECONDS);
    AppLog.event('ocr.raw', AppLog.data('reader', 'pipe', 'width', b.getWidth(), 'height', b.getHeight(), 'text', result.getText())); return result;
  }
  async read(sources, month, requestedName, progress) {
    const selected = []; for (const source of sources) selected.push(AppLog.data('uri', source.uri.toString(), 'primary', source.primary));
    AppLog.event('ocr.pipe.begin', AppLog.data('sources', selected, 'month', month.toString(), 'name', requestedName, 'forceRefresh', this.forceRefresh));
    const started = Date.now(), gpuBefore = ocrEngineInfo().gpu; // Task A5: the GPU counts of this read
    try { const book = await this._readInternal(sources, month, requestedName, { update: message => { AppLog.message('ocr.pipe', message); progress.update(message); } }); AppLog.event('ocr.pipe.complete', new JSONObject(book.toJson())); return book; }
    catch (failure) { AppLog.failure('ocr.pipe', failure); throw failure; }
    finally { // web (Task A4): how the photos were read, for the log
      const info = ocrEngineInfo(); AppLog.event('ocr.pipe.engine', AppLog.data('engine', info.engine, 'webgpuSetting', info.setting, 'mode', info.mode, 'webgpu', info.webgpu, 'photos', sources.length, 'atOnce', Math.max(1, Math.min(sources.length, this.pagesAtOnce ?? pipePagesAtOnce())), 'elapsedMs', Date.now() - started,
        // Task A5 (WebGPU opted in): the GPU worker's boxes since the page opened, read again on WASM, compared, different
        'gpuBoxes', gpuDelta(info.gpu, gpuBefore, 'recs'), 'gpuRetried', gpuDelta(info.gpu, gpuBefore, 'retried'), 'gpuChecked', gpuDelta(info.gpu, gpuBefore, 'checked'),
        'gpuDiffer', gpuDelta(info.gpu, gpuBefore, 'mismatches'), 'gpuMaxDiff', info.gpu?.maxDiff ?? null, 'gpuError', info.gpu?.error ?? null));
    }
  }
  async _readInternal(sources, month, requestedName, progress) {
    if (sources.length === 0 || sources.length > 3) throw new IllegalArgumentException('Chọn từ 1 đến 3 ảnh Lịch ống.'); let book = new PipeBook(month);
    let primary = -1; for (let i = 0; i < sources.length; i++) if (sources[i].primary) { if (primary >= 0) throw new IllegalArgumentException('Chỉ chọn một ảnh phân ống chính.'); primary = i; }
    if (primary < 0 && sources.length === 1) primary = 0;
    if (primary < 0) throw new IllegalArgumentException('Chọn ảnh phân ống chính có hàng tên của bạn. Các ảnh khác dùng để tìm người đổi ca.');
    const cache = new PipeSourceCache(this._context.getFilesDir());
    // Web (Task A4): the photos are read at the same time (pipePagesAtOnce), each by its own view of this reader
    // (lane) so per-page state does not mix; their OCR calls share the worker pool, which then stays busy. Every page
    // is read exactly as alone, and pages, paths, name log and orientation are put back in photo order, so the book
    // is the one the one-by-one read gives. A call may wait behind the other photos' calls: its OCR time limit grows
    // with the photos in flight (a timeout would change what is read).
    const atOnce = Math.max(1, Math.min(sources.length, this.pagesAtOnce ?? pipePagesAtOnce()));
    const lanes = []; this._ocrWaitSeconds = 60 * atOnce; OcrCheckpoint.readerWait(this._ocrWaitSeconds); // a reading job then flags only real timeouts as slow
    const readPage = async page => {
      const lane = lanes[page] = Object.create(this); lane.nameLog = []; lane._debugTag = '';
      progress.update('Ảnh ' + (page + 1) + ' / ' + sources.length + ' · tự cân kích thước và làm rõ bản sao 4K…'); const source = sources[page]; let original = null, scan = null;
      try {
        const image = cache.copy(await this._context.getContentResolver().openInputStream(source.uri)); AppLog.source('pipe', image); let pageBook = PipeRosterReader.loadCached(cache, image, month, this.forceRefresh || this.namesOnly); AppLog.event('ocr.pipe.page', AppLog.data('page', page + 1, 'source', image.getAbsolutePath(), 'cached', pageBook != null, 'primary', page === primary));
        if (pageBook == null) { original = await ImageFiles.load(this._context, Uri.fromFile(image), 3840); scan = GridVision.prepareScan(original); original.recycle(); original = null; pageBook = new PipeBook(month); await lane._readAutomatically(pageBook, scan, page, requestedName, progress); pageBook.applyConfirmedPrintedAliases(); if (pageBook.employees.length === 0) throw new IllegalArgumentException('Ảnh ' + (page + 1) + ': chưa đọc được hàng tên nào; chưa lưu kết quả OCR.'); if (!this.namesOnly) cache.save(image, pageBook); }
        else progress.update('Ảnh ' + (page + 1) + ' · dùng dữ liệu đã lưu, không quét lại…');
        return { pageBook, path: image.getAbsolutePath() };
      }
      finally { if (scan != null) scan.recycle(); if (original != null) original.recycle(); }
    };
    let read;
    try { read = await PipeRosterReader.inParallel(sources.length, atOnce, readPage); }
    finally {
      this._ocrWaitSeconds = 60; OcrCheckpoint.readerWait(60);
      for (const lane of lanes) if (lane != null) {
        this.nameLog.push(...lane.nameLog);
        if (Object.hasOwn(lane, 'selectedAngle')) this.selectedAngle = lane.selectedAngle;
        if (Object.hasOwn(lane, '_numberedSheet')) this._numberedSheet = lane._numberedSheet;
      }
    }
    const pages = read.map(r => r.pageBook), paths = read.map(r => r.path);
    book = PipeBook.fromPages(pages, paths, primary);
    if (book.employees.length === 0) throw new IllegalArgumentException('Chưa đọc được tên trong ảnh này. Lịch đã lưu vẫn được giữ nguyên.'); return book;
  }
  /** Runs read(0 … n−1), at most `limit` at once, starting them in order (Task A4); a failure starts no further page
   *  (as the one-by-one read stops there), the pages already running finish (their results are cached), then the
   *  failure of the first page in photo order is thrown — the one the one-by-one read meets. An interrupt (Hủy) seen by
   *  one page is passed to the others, so they stop at their next check point instead of reading on. */
  static async inParallel(n, limit, read) {
    const out = new Array(n), failed = new Array(n).fill(false), errors = new Array(n); let next = 0, stop = false;
    const lane = async () => {
      while (!stop && next < n) {
        const k = next++;
        try { out[k] = await read(k); }
        catch (e) { failed[k] = true; errors[k] = e; stop = true; if (e instanceof InterruptedException) Thread.currentThread().interrupt(); }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, n)) }, lane));
    const k = failed.indexOf(true);
    if (k >= 0) { if (errors[k] instanceof InterruptedException) Thread.interrupted(); throw errors[k]; }
    return out;
  }
  static loadCached(cache, image, month, forceRefresh) { const book = forceRefresh ? null : cache.load(image, month); if (book != null) book.applyConfirmedPrintedAliases(); return book; }
  async selectGridForOrientation(oriented, month, page, angle, progress) {
    let foundGrid = false; let selected = null; let selectedLayout = null; let selectedRegular = false, selectedContinuous = false;
    try {
      progress.update('Ảnh ' + (page + 1) + ' · tự tìm chiều chữ, viền bảng và cột ngày…');
      const found = GridVision.pipeCornerSet(oriented), bounds = [...found, Float32Array.of(0, 0, 1, 0, 1, 1, 0, 1)]; if (BuildConfig.DEBUG) Log.d('PipeGrid', 'outlines ' + arrayText(found));
      for (let bound = 0; bound < bounds.length; bound++) {
        const corners = bounds[bound]; let candidate = null; try {
          candidate = GridVision.analyze(oriented, corners, 0); foundGrid = true;
          progress.update('Ảnh ' + (page + 1) + ' · đã tìm thấy bảng, đang làm thẳng hàng ngày để đọc đúng cột…');
          if (BuildConfig.DEBUG) { this._debugTag = page + '-a' + angle + '-b' + bound; await this._debugGrid(candidate, this._debugTag + '-pre'); }
          const layout = await this._headers(candidate, month.lengthOfMonth()); const groups = layout.groups;
          // A valid partial header must not prevent trying the measured
          // table boundary: a curved photo can expose only its last day
          // when treated as an uncropped rectangle.
          const employeeRows = candidate.y.length - groups[0].headerRow - 3;
          if (BuildConfig.DEBUG) { await this._debugGrid(candidate, page + '-a' + angle + '-b' + bound); Log.d('PipeGrid', 'page ' + page + ' angle ' + angle + ' bounds ' + bound + ': groups ' + groups.length + ' open ' + layout.open.length + ' rows ' + candidate.y.length + ' employeeRows ' + employeeRows); }
          const selectedRows = selected == null ? -1 : selected.y.length - selectedLayout.groups[0].headerRow - 3;
          // 27/10: a grid whose staff rows are unevenly spaced (a bowed page read with straight and curved rules
          // mixed: the August Tô Hoài photo had title lines taken as rows and 48 values put on the wrong person)
          // never wins over an evenly spaced one, however many dates it reads.
          const regular = PipeRosterReader.evenRows(candidate.y, groups[0].headerRow), continuous = PipeRosterReader.continuousRows(candidate.y, groups[0].headerRow);
          const dates = []; for (const g of groups) dates.push(g.day);
          AppLog.event('ocr.pipe.grid.candidate', AppLog.data('page', page + 1, 'angle', angle, 'candidate', bound, 'corners', new JSONArray(corners), 'rows', new JSONArray(candidate.y), 'columns', new JSONArray(candidate.x), 'dates', dates, 'open', layout.open.length, 'regularRows', regular));
          if (BuildConfig.DEBUG) Log.d('PipeGrid', 'page ' + page + ' angle ' + angle + ' bounds ' + bound + ' rows even: ' + regular);
          if (selectedLayout == null || continuous && !selectedContinuous || continuous === selectedContinuous && (regular && !selectedRegular || regular === selectedRegular && PipeRosterReader.preferHeaderLayout(layout, employeeRows, selectedLayout, selectedRows))) {
            if (selected != null) selected.table.recycle();
            selected = candidate; selectedLayout = layout; selectedRegular = regular; selectedContinuous = continuous; candidate = null;
          }
          // A complete, evenly ruled table already covers all columns and staff rows.
          // Further outlines often turn its text into false columns and spend minutes
          // retrying non-date rows (3.7, the three-photo import). Partial/uneven grids
          // still try every outline, as on bowed or clipped photos.
          if (selectedContinuous && PipeRosterReader.completeGrid(selected.x, selected.y, selected.table.getWidth(), selectedLayout)) break;
        } catch (e) {
          if (e instanceof IllegalArgumentException) { if (BuildConfig.DEBUG) Log.d('PipeGrid', 'page ' + page + ' angle ' + angle + ' bounds ' + bound + ' rejected: ' + e.getMessage()); }
          else if (interrupted(e)) throw e;
          else { if (BuildConfig.DEBUG) Log.d('PipeGrid', 'page ' + page + ' angle ' + angle + ' bounds ' + bound + ' failed: ' + e); if (Thread.currentThread().isInterrupted()) throw new InterruptedException(); }
        } finally { if (candidate != null) candidate.table.recycle(); }
      }
      if (selected != null) {
        const dates = []; for (const g of selectedLayout.groups) dates.push(g.day);
        AppLog.event('ocr.pipe.grid.selected', AppLog.data('page', page + 1, 'angle', angle, 'corners', new JSONArray(selected.corners()), 'rows', new JSONArray(selected.y), 'columns', new JSONArray(selected.x), 'dates', dates, 'open', selectedLayout.open.length));
      }
      return new GridSelection(selected, selectedLayout, foundGrid);
    } catch (failure) { if (selected != null) selected.table.recycle(); throw failure; }
  }
  async _readAutomatically(book, scan, page, requestedName, progress) {
    let foundGrid = false;
    for (const angle of [0, 90, 270, 180]) {
      if (Thread.currentThread().isInterrupted()) throw new InterruptedException(); let oriented = scan;
      if (angle !== 0) { const rotation = new Matrix(); rotation.postRotate(angle); oriented = Bitmap.createBitmap(scan, 0, 0, scan.getWidth(), scan.getHeight(), rotation, true); }
      let selected = null; let selectedLayout = null;
      try {
        const selection = await this.selectGridForOrientation(oriented, book.month, page, angle, progress); foundGrid = foundGrid || selection.sawGrid; selected = selection.grid; selectedLayout = selection.layout;
        if (selected != null) {
          // A few sideways digits can imitate a date header. Do not commit that orientation until
          // its name column identifies staff; otherwise try the remaining orientations from scratch.
          const attempt = new PipeBook(book.month); const logStart = this.nameLog.length;
          await this._readPage(attempt, selected, selectedLayout, page, requestedName, progress);
          if (!PipeRosterReader.hasPlausiblePersonnel(attempt, Personnel.current())) {
            this.nameLog.length = logStart;
            if (BuildConfig.DEBUG) Log.d('PipeGrid', 'page ' + page + ' angle ' + angle + ' rejected: no plausible staff identities');
            continue;
          }
          book.employees.push(...attempt.employees); book.layout.push(...attempt.layout); book._openColumns.push(...attempt._openColumns); this.selectedAngle = angle;
          if (book._openColumns.length !== 0) try { await this._readPrintedPeriod(book, oriented, selected); } catch (fault) { if (!runtime(fault)) throw fault; if (BuildConfig.DEBUG) Log.d('PipeImport', 'printed period failed', fault); }
          return;
        }
      } finally { if (selected != null) selected.table.recycle(); if (oriented !== scan) oriented.recycle(); }
    }
    throw new IllegalArgumentException('Ảnh ' + (page + 1) + (foundGrid ? ': chưa đọc được số ngày trên đầu cột.' : ': chưa xác định được đường kẻ và cột tên trong ảnh.') + ' Lịch đã lưu được giữ nguyên.');
  }
  /** The staff rows below the date row are evenly spaced: at most 20 % of the gaps between row lines differ from
   *  their median by more than 40 % (the total row and a bottom margin are one or two such gaps). */
  static evenRows(y, headerRow) {
    const from = Math.max(0, headerRow + 1); if (y.length - from < 4) return true; const gaps = new Float32Array(y.length - from - 1);
    for (let i = 0; i < gaps.length; i++) gaps[i] = y[from + i + 1] - y[from + i]; const sorted = gaps.slice().sort(); const median = sorted[sorted.length >> 1];
    let odd = 0; for (const g of gaps) if (Math.abs(f(g - median)) > f(median * f(.4))) odd++; return odd <= f(gaps.length * f(.2));
  }
  /** Prefer a table without merged body rows. A missing rule creates a gap near twice the median;
   * the tolerant evenRows check alone accepts several such gaps on a short staff sheet. */
  static continuousRows(y, headerRow) {
    const from = Math.max(0, headerRow + 2), to = y.length - 1; if (to - from < 4) return false;
    const gaps = new Float32Array(to - from); for (let i = 0; i < gaps.length; i++) gaps[i] = y[from + i + 1] - y[from + i];
    const sorted = gaps.slice().sort(); const median = sorted[sorted.length >> 1];
    for (const gap of gaps) if (gap < f(median * f(.55)) || gap > f(median * f(1.65))) return false; return true;
  }
  /** A recognized outer date must not disappear just because a smaller lattice has no unknown groups.
   * Credit only physically structured 2/3-column groups in a mostly recognized header. */
  static representedDays(layout) {
    let count = layout.groups.length; for (const open of layout.open) if (open.structured && (open.end - open.start === 2 || open.end - open.start === 3)) count++;
    return layout.groups.length * 4 >= count * 3 ? count : layout.groups.length;
  }
  static preferHeaderLayout(candidate, candidateRows, selected, selectedRows) {
    const coverage = PipeRosterReader.representedDays(candidate), oldCoverage = PipeRosterReader.representedDays(selected); if (coverage !== oldCoverage) return coverage > oldCoverage;
    if (candidate.groups.length !== selected.groups.length) return candidate.groups.length > selected.groups.length;
    if (candidate.open.length !== selected.open.length) return candidate.open.length < selected.open.length; return candidateRows > selectedRows;
  }
  static completeGrid(x, y, width, layout) {
    if (layout == null || layout.open.length !== 0 || layout.groups.length < 8 || x.length < 19 || x[0] > f(width * f(.06)) || x[x.length - 1] < f(width * f(.94))) return false;
    const header = layout.groups[0].headerRow; if (header > 1 || y.length - header - 3 < 10 || !PipeRosterReader.evenRows(y, header)) return false;
    let next = 2; for (const g of layout.groups) { if (g.headerRow !== header || g.start !== next || g.end - g.start < 2 || g.end - g.start > 3) return false; next = g.end; }
    if (next !== x.length - 1) return false;
    const gaps = new Float32Array(x.length - 3); for (let i = 2; i < x.length - 1; i++) gaps[i - 2] = x[i + 1] - x[i]; const sorted = gaps.slice().sort(); const median = sorted[sorted.length >> 1];
    for (const gap of gaps) if (gap < f(median * f(.65)) || gap > f(median * f(1.35))) return false;
    return true;
  }
  /** A row may use initials or a name outside the bundled list, but isolated letters, shift codes and
   *  paragraph-length OCR are not a person's printed name. */
  static plausiblePrintedName(name) {
    const raw = name == null ? '' : trim(name);
    if (raw.length > 96 || DIGIT_ANYWHERE.test(raw) || NOT_NAME_CHAR.test(raw) || RosterRows.header(raw) || RosterRows.summary('', raw)) return false;
    const words = Personnel.words(raw); if (words.length === 0 || words.length > 8) return false;
    const last = Personnel.fold(words[words.length - 1]); if (last.length < 2 || !VOWEL_ANYWHERE.test(last)) return false;
    const letters = Personnel.fold(raw).replace(/ /g, ''); if (letters.length < 3) return false;
    return new Set(letters.split('')).size > 1;
  }
  /** One known identity anchors a sheet without excluding its other, previously unseen names. If the
   *  sheet contains only new people, at least two plausible numbered rows must corroborate its structure.
   *  Numbers here have already passed RosterRows.sheetNumbers' printed-sequence checks. */
  static hasPlausiblePersonnel(book, staff) {
    const numbered = new Set();
    for (const e of book.employees) {
      if (!PipeRosterReader.plausiblePrintedName(e.name)) continue;
      if (staff != null && staff.unique(e.name, Personnel.Source.PRINTED) != null) return true;
      if (e.number > 0) numbered.add(e.number);
    }
    return numbered.size >= 2;
  }
  /** Debug builds only: the rectified table with the found row and column lines, for checking the grid. */
  async _debugGrid(grid, tag) {
    try {
      const copy = grid.table.copy(ARGB_8888, true); const c = new Canvas(copy); const p = new Paint(); p.setStrokeWidth(2);
      p.setColor(Color.RED); for (const y of grid.y) c.drawLine(0, y, copy.getWidth(), y, p); p.setColor(Color.BLUE); for (const x of grid.x) c.drawLine(x, 0, x, copy.getHeight(), p);
      const out = new FileOutputStream(new File(this._directory, 'p' + tag + '-grid.png')); try { await copy.compress(Bitmap.CompressFormat.PNG, 100, out); } finally { try { out.close(); } finally { copy.recycle(); } }
    } catch (ignored) { /* debug only */ }
  }
  /** Team T5 prints a border between every subcolumn of the date row and the date sits in the first subcolumn
   *  of a day: a day runs from a numbered header cell to the next one (2–3 subcolumns). The day columns follow
   *  the printed numbers, never a guessed pairing. */
  async _numberedSpans(grid, segments, row) {
    const narrow = [], spans = []; for (const s of segments) if (s[1] - s[0] === 1) narrow.push(s);
    if (narrow.length < 6 || narrow.length < segments.length * 0.7) return spans;
    const numbered = new Array(narrow.length).fill(false);
    for (let i = 0; i < narrow.length; i++) {
      const cell = grid.headerCell(narrow[i][0], narrow[i][1], row), clear = GridVision.enhance(cell);
      try { if (!GridVision.clearlyBlank(cell)) numbered[i] = PipeHeaders.numbers([await this._readHeaderNumber(cell, 300, 160), await this._readHeaderNumber(clear, 360, 180)], 31).length !== 0; }
      finally { if (clear !== cell) clear.recycle(); cell.recycle(); }
    }
    for (let i = 0; i < narrow.length; i++) {
      if (!numbered[i]) continue; let j = i + 1; while (j < narrow.length && !numbered[j]) j++;
      const start = narrow[i][0], end = j < narrow.length ? narrow[j][0] : narrow[narrow.length - 1][1];
      if (end - start === 2 || end - start === 3) spans.push([start, end]);
    }
    return spans;
  }
  /** Negative evidence only: a staff name by itself never disqualifies a possible date heading. */
  static nonDateHeader(codeLabels, plainDays, knownStaff) { return codeLabels >= 3 && plainDays < 2 || codeLabels >= 2 && knownStaff; }
  async _headers(grid, maxDay) {
    const headerRows = Math.min(3, grid.y.length - 1); const blocked = new Array(headerRows).fill(false); let rejected = 0;
    const stripTokens = [];
    // One broad reading can recognize a shift/pipe body before dozens of isolated cell retries turn
    // its assignments into false date candidates. Unclear readings keep every existing retry path.
    for (let row = 0; row < headerRows; row++) {
      const observed = []; stripTokens.push(observed); let labels = 0, days = 0; let staff = null; const strip = grid.headerStrip(row);
      try {
        for (const block of (await this._text(strip)).getTextBlocks()) for (const line of block.getLines()) for (const element of line.getElements()) {
          const box = element.getBoundingBox(); if (box == null || box.exactCenterX() < f(2 * grid.x[2])) continue; const token = trim(element.getText());
          observed.push(new PipeHeaders.Token(token, f(box.exactCenterX() / 2), f(f(grid.y[row] + grid.y[row + 1]) / 2)));
          if (headerCodeLabel(token)) labels++;
          if (/^[0-9]{1,2}$/.test(token)) { const number = Integer.parseInt(token); if (number >= 1 && number <= maxDay) days++; }
        }
        if (labels >= 2 && !PipeRosterReader.nonDateHeader(labels, days, false)) {
          const name = GridVision.trimLeftRule(grid.cell(1, row));
          try { const reading = await this._readTiles([name], 650, 90); staff = Personnel.current().unique(OcrCodes.vietnameseName(trim(reading[0].replace(/\n/g, ' '))), Personnel.Source.PRINTED); }
          finally { name.recycle(); }
        }
        blocked[row] = PipeRosterReader.nonDateHeader(labels, days, staff != null); if (blocked[row]) rejected++;
        AppLog.event('ocr.pipe.header.precheck', AppLog.data('row', row, 'codeLabels', labels, 'plainDays', days, 'recognizedStaff', staff == null ? null : staff.name, 'rejected', blocked[row], 'reason', blocked[row] ? (labels >= 3 && days < 2 ? 'code_row_without_date_numbers' : 'staff_row_with_shift_labels') : 'uncertain_or_possible_date_row'));
      } catch (unreadable) { if (interrupted(unreadable)) throw unreadable; AppLog.failure('ocr.pipe.header.precheck', unreadable); if (Thread.currentThread().isInterrupted()) throw new InterruptedException(); }
      finally { strip.recycle(); }
    }
    if (headerRows > 0 && rejected === headerRows) throw new IllegalArgumentException('Đầu bảng đang là mã ca hoặc hàng nhân viên; chưa thấy hàng số ngày.');
    // Read merged day cells separately. Do not let adjacent labels such as BT 12 become a date.
    for (let row = 0; row < headerRows; row++) {
      if (blocked[row]) continue;
      const strip = grid.headerStrip(row); const cells = [], enhanced = [];
      try {
        const segments = PipeHeaders.repairSplitSegments(grid.headerSegments(strip)); let spans = [];
        for (const s of segments) { const w = s[1] - s[0]; if (w === 2 || w === 3) spans.push(s); else if (w === 4) { spans.push([s[0], s[0] + 2]); spans.push([s[0] + 2, s[1]]); } }
        // Team T5 prints a border between every subcolumn of the date row: mostly single subcolumns, a missing
        // border at most making a few double ones (26/10 night, the user's T5 photo: one double segment made it a
        // merged-date row and nothing was read). Such a row is read by its printed numbers.
        let narrow = 0; for (const s of segments) if (s[1] - s[0] === 1) narrow++; let numberedRow = false;
        if (spans.length === 0 || narrow >= 6 && narrow >= f(segments.length * f(.7))) { const numbered = await this._numberedSpans(grid, segments, row); if (numbered.length !== 0 || spans.length === 0) { spans = numbered; numberedRow = numbered.length !== 0; } }
        if (BuildConfig.DEBUG) {
          let widths = ''; for (const seg of segments) widths += (seg[1] - seg[0]) + ' '; Log.d('PipeHeader', this._debugTag + ' row ' + row + ' segments ' + segments.length + ' widths ' + widths + 'spans ' + spans.length);
          try { const out = new FileOutputStream(new File(this._directory, 'p' + this._debugTag + '-hrow' + row + '.png')); try { await strip.compress(Bitmap.CompressFormat.PNG, 100, out); } finally { out.close(); } } catch (ignored) { /* debug only */ }
        }
        if (spans.length === 0) continue;
        for (const span of spans) { const cell = grid.headerCell(span[0], span[1], row); cells.push(cell); enhanced.push(GridVision.enhance(cell)); }
        const first = await this._readTiles(cells, 260, 130), second = await this._readTiles(enhanced, 300, 160); const days = [], readings = [];
        const isolated = []; let agreed = 0, numbered = 0;
        for (let i = 0; i < spans.length; i++) {
          // Whole-strip/montage OCR confuses small digits with neighbouring cells, so an isolated
          // reading must agree.
          const montage = [first[i], second[i]], alone = [];
          alone.push(await this._readHeaderNumber(cells[i], 300, 160)); alone.push(await this._readHeaderNumber(enhanced[i], 360, 180));
          const day = PipeHeaders.vote(alone, montage, maxDay); isolated.push(alone); days.push(day);
          if (day != null) agreed++; const all = [...alone, ...montage]; if (PipeHeaders.numbers(all, maxDay).length !== 0) numbered++;
        }
        // Unclear date cells get more independent views, but only in a row of dates (labels and
        // employee rows are not retried: that only costs time).
        const dateRow = agreed > 0 || numbered >= 2;
        for (let i = 0; i < spans.length; i++) {
          const montage = [first[i], second[i]], alone = isolated[i];
          for (let view = 0; dateRow && days[i] == null && view < PipeRosterReader.HEADER_VIEWS; view++) { alone.push(await this._readHeaderView(cells[i], view)); days[i] = PipeHeaders.vote(alone, montage, maxDay); }
          const all = [...alone, ...montage]; readings.push(PipeHeaders.numbers(all, maxDay));
        }
        if (BuildConfig.DEBUG) Log.d('PipeHeader', this._debugTag + ' row ' + row + ' days ' + arrayText(days) + ' montage ' + arrayText(first) + ' / ' + arrayText(second) + ' alone ' + arrayText(isolated));
        if (dateRow) PipeHeaders.fillBetween(days, isolated, maxDay);
        const groups = PipeHeaders.confirmed(spans, days, row, maxDay);
        if (groups.length !== 0) {
          // Every other printed column is kept as an open column instead of disappearing.
          const open = [];
          for (let i = 0; i < spans.length; i++) { const s = spans[i]; let dated = false; for (const g of groups) if (g.start === s[0] && g.end === s[1]) dated = true; if (!dated) open.push(new PipeHeaders.Open(s[0], s[1], row, true, readings[i])); }
          for (const s of segments) {
            const w = s[1] - s[0]; let covered = false; for (const sp of spans) if (s[0] >= sp[0] && s[1] <= sp[1]) covered = true;
            if (!covered && w !== 2 && w !== 3 && w !== 4) open.push(new PipeHeaders.Open(s[0], s[1], row, false, []));
          }
          return new PipeHeaders.Layout(groups, open, numberedRow);
        }
      } catch (unclear) { if (!(unclear instanceof IllegalArgumentException)) throw unclear; }
      finally { strip.recycle(); for (const b of cells) b.recycle(); for (const b of enhanced) b.recycle(); }
    }
    for (let row = 0; row < headerRows; row++) {
      if (blocked[row]) continue; const straight = stripTokens[row];
      try { const groups = PipeHeaders.parse(straight, grid.x, grid.y, maxDay); return new PipeHeaders.Layout(groups, PipeHeaders.uncovered(groups, 2, grid.x.length - 1, groups[0].headerRow)); } catch (unreadableHeader) { if (!(unreadableHeader instanceof IllegalArgumentException)) throw unreadableHeader; }
    }
    const headerHeight = grid.headerBottom(Math.min(3, grid.y.length - 1));
    const header = Bitmap.createBitmap(grid.table, 0, 0, grid.table.getWidth(), Math.max(1, headerHeight)); const tokens = [];
    try {
      for (const block of (await this._text(header)).getTextBlocks()) for (const line of block.getLines()) for (const element of line.getElements()) {
        const bounds = element.getBoundingBox();
        if (bounds != null) {
          const y = grid.headerY(bounds.exactCenterX(), bounds.exactCenterY()); let skip = false; for (let row = 0; row < headerRows; row++) if (blocked[row] && y > grid.y[row] && y < grid.y[row + 1]) skip = true;
          if (!skip) tokens.push(new PipeHeaders.Token(trim(element.getText()), grid.headerX(bounds.exactCenterX(), bounds.exactCenterY()), y));
        }
      }
    } finally { header.recycle(); }
    const groups = PipeHeaders.parse(tokens, grid.x, grid.y, maxDay);
    return new PipeHeaders.Layout(groups, PipeHeaders.uncovered(groups, 2, grid.x.length - 1, groups[0].headerRow));
  }
  /** Extra independent views of a header cell: black-and-white at two thresholds, sharpened, rules removed,
   *  thickened strokes and a larger rendering. Each is one more vote, never a decision on its own. */
  async _readHeaderView(cell, view) {
    if (view === 5) return this._readHeaderNumber(cell, 460, 230);
    const processed = view === 0 ? GridVision.scanCell(cell, 1) : view === 1 ? GridVision.scanCell(cell, 2) : view === 2 ? GridVision.scanCell(cell, 3) : view === 3 ? GridVision.scanCell(cell, 0) : PipeRosterReader.thick(cell);
    try { return await this._readHeaderNumber(processed, 360, 180); } finally { processed.recycle(); }
  }
  /** Upright non-data label prevents isolated 18/29 being rotated by OCR. */
  async _readHeaderNumber(cell, width, height) {
    const large = GridVision.enlarge(cell, width, height), input = Bitmap.createBitmap(width, height + 60, ARGB_8888);
    const canvas = new Canvas(input); canvas.drawColor(Color.WHITE); const label = new Paint(Paint.ANTI_ALIAS_FLAG); label.setColor(Color.BLACK); label.setTextSize(24); canvas.drawText('DAY', 20, 30, label); canvas.drawBitmap(large, 0, 60, null); let value = '';
    try {
      for (const block of (await this._text(input)).getTextBlocks()) for (const line of block.getLines()) for (const element of line.getElements()) {
        const bounds = element.getBoundingBox(); if (bounds != null && bounds.top >= 60) { if (value.length > 0) value += ' '; value += element.getText(); }
      }
      return value;
    } finally { input.recycle(); large.recycle(); }
  }
  async _readPage(book, grid, layout, page, requestedName, progress) { // eslint-disable-line no-unused-vars
    this._numberedSheet = layout.numbered;
    const groups = layout.groups; const structured = [], unstructured = [];
    for (const o of layout.open) (o.structured ? structured : unstructured).push(o);
    const columns = new Map(); const inked = new Array(layout.open.length).fill(false);
    for (const o of layout.open) columns.set(o, new PipeBook.DayColumn(o.start, o.end, o.headerRow, o.structured, o.readings, await this._headerEvidence(grid, o, page)));
    const nameCells = []; const count = grid.y.length - 1; const glyphs = [];
    for (let row = 0; row < count; row++) nameCells.push(GridVision.trimLeftRule(grid.cell(1, row)));
    const names = await this._readTiles(nameCells, 650, 90); const enhancedNames = []; let retryNames;
    try { for (const cell of nameCells) enhancedNames.push(GridVision.scanCell(cell, 0)); retryNames = await this._readTiles(enhancedNames, 700, 110); } finally { for (const b of enhancedNames) b.recycle(); }
    // VietOCR reads the same name cells as a second, independent reader (3.0); the staff list decides between them.
    const below = groups[0].headerRow + 1; const vietNames = Array.from({ length: count }, () => []); const viet = await this._vietOcrReader();
    if (viet != null) for (let row = below; row < count; row++) try { vietNames[row] = await viet.readViews(nameCells[row]); } catch (unreadable) { /* ML Kit alone */ }
    if (BuildConfig.DEBUG) Log.d('PipeNames', 'mlkit=' + arrayText(names) + ' retry=' + arrayText(retryNames) + ' vietocr=' + arrayText(vietNames));
    const bestNames = new Array(count).fill(null);
    for (let row = 0; row < count; row++) bestNames[row] = NameReader.pickPipe(names[row], retryNames[row], vietNames[row], Personnel.current());
    // A ruling may follow a letter instead of the border near one name, clipping the text. Only
    // unresolved rows get a bounded vertical crop, then left context only if still unresolved.
    for (let row = below; row < count; row++) if (Personnel.current().unique(bestNames[row], Personnel.Source.PRINTED) == null) {
      const initial = bestNames[row]; const mlEvidence = [names[row], retryNames[row]], vietEvidence = [...vietNames[row]];
      for (let attempt = 0; attempt < 2; attempt++) {
        let alternate = null, enhanced = null;
        try {
          alternate = GridVision.trimLeftRule(attempt === 0 ? grid.expandedNameCell(row) : grid.leftContextNameCell(row)); enhanced = GridVision.scanCell(alternate, 0);
          const ml = (await this._readTiles([alternate], 650, 90))[0], clear = (await this._readTiles([enhanced], 700, 110))[0]; mlEvidence.push(ml); mlEvidence.push(clear);
          const views = viet == null ? [] : await viet.readViews(alternate); vietEvidence.push(...views);
          const recovered = attempt === 0 ? NameReader.pickPipeRecovery(names[row], retryNames[row], vietNames[row], ml, clear, views, Personnel.current()) : NameReader.pickPipeEvidence([...mlEvidence], [...vietEvidence], bestNames[row], Personnel.current());
          const identified = Personnel.current().unique(recovered, Personnel.Source.PRINTED); let initialEvidence = '';
          if (identified != null) { const previous = nameCells[row]; initialEvidence = await this._evidence([previous], 'p' + page + '-r' + row + '-name-initial'); nameCells[row] = alternate; alternate = null; previous.recycle(); }
          AppLog.event('ocr.pipe.name.alternate', AppLog.data('page', page + 1, 'row', row, 'verticalExpansion', jfloat(f(.25)), 'leftExpansion', jfloat(attempt === 0 ? 0 : f(.25)), 'initial', initial, 'initialEvidence', initialEvidence, 'evidenceCrop', identified == null ? 'initial' : 'recognized_alternate', 'originalMl', ml, 'enhancedMl', clear, 'vietViews', [...views], 'chosen', recovered, 'canonical', identified == null ? null : identified.name));
          if (identified != null || recovered === '') bestNames[row] = recovered;
          if (identified != null) break;
        } catch (unreadable) { if (interrupted(unreadable)) throw unreadable; AppLog.failure('ocr.pipe.name.alternate', unreadable); if (Thread.currentThread().isInterrupted()) throw new InterruptedException(); }
        finally { if (alternate != null) alternate.recycle(); if (enhanced != null) enhanced.recycle(); }
      }
    }
    let stt = null;
    if (grid.x.length > 2) try {
      const sttCells = []; for (let row = 0; row < count; row++) sttCells.push(grid.cell(0, row));
      try { stt = await this._readTiles(sttCells, 200, 90); } finally { for (const b of sttCells) b.recycle(); }
    } catch (unreadable) { stt = null; /* no STT: lookup by name */ }
    // Most sheets print a second header row (shift / position / duty) under the dates; team T5's sheet starts its
    // staff right below the dates (25/10: "1 Phạm Quang Hải"). That row is staff when it is a known person or STT 1.
    let firstRow = below + 1;
    if (below < count && (Personnel.current().unique(bestNames[below], Personnel.Source.PRINTED) != null || stt != null && RosterRows.serial(stt[below]) === 1)) firstRow = below;
    // The sheet's own STT column (3.0): kept only when it agrees with the staff list or counts by one.
    let numbers = new Array(count).fill(0);
    if (stt != null) try { numbers = RosterRows.sheetNumbers(stt, bestNames, firstRow, Personnel.current()); } catch (unreadable) { if (!runtime(unreadable)) throw unreadable; numbers = new Array(count).fill(0); }
    try {
      const pageNames = new Set(), repeated = new Set();
      for (let row = firstRow; row < count; row++) {
        const name = bestNames[row];
        this.nameLog.push([String(page), String(row), names[row], retryNames[row], ...vietNames[row], name]);
        const identified = Personnel.current().unique(name, Personnel.Source.PRINTED);
        AppLog.event('ocr.pipe.name', AppLog.data('page', page + 1, 'row', row, 'original', names[row], 'enhanced', retryNames[row], 'vietViews', [...vietNames[row]], 'chosen', name, 'canonical', identified == null ? null : identified.name, 'plausible', PipeRosterReader.plausiblePrintedName(name)));
        if (!PipeRosterReader.plausiblePrintedName(name)) continue;
        if (this.namesOnly) { await this._evidence([nameCells[row]], 'p' + page + '-r' + row + '-name'); book.add(numbers[row], name, ''); continue; }
        // Count rows ("Tổng số 18h-06h+") and header rows are not staff (3.0: skipped, never read as a person).
        if (RosterRows.summary('', name) || RosterRows.header(name)) continue;
        const key = Schedule.normalizeName(name); if (pageNames.has(key)) { repeated.add(key); continue; } pageNames.add(key);
        progress.update('Ảnh ' + (page + 1) + ' · ' + name + ' · đang đọc từng cột ca và phân ống…');
        const identity = await this._evidence([nameCells[row]], 'p' + page + '-r' + row + '-name');
        const employee = book.addByName(numbers[row], name, identity);
        // Columns whose printed date is still open are read exactly like dated ones and kept aside.
        const spans = []; for (const g of groups) spans.push([g.start, g.end]); for (const o of structured) spans.push([o.start, o.end]);
        const cells = [], enhanced = [];
        const sizes = new Int32Array(spans.length);
        for (let k = 0; k < spans.length; k++) {
          const span = spans[k];
          // Team T5: a day is two subcolumns, so a third one is either a rule that split the pipe cell (26/10 night,
          // the user's T5 photo: "1 | 1") — its two pieces are cut and read as one cell — or, when it is blank, the
          // margin beyond the last day (October T5, day 31), which is left out.
          if (layout.numbered && span[1] - span[0] === 3) {
            const code = grid.cell(span[0], row), third = grid.cell(span[0] + 2, row); const margin = GridVision.clearlyBlank(third); third.recycle();
            const rest = margin ? grid.cell(span[0] + 1, row) : grid.cellSpan(span[0] + 1, span[1], row);
            cells.push(code); enhanced.push(GridVision.scanCell(code, 0)); cells.push(rest); enhanced.push(GridVision.scanCell(rest, 0)); sizes[k] = 2;
          } else { for (let column = span[0]; column < span[1]; column++) { const cell = grid.cell(column, row); cells.push(cell); enhanced.push(GridVision.scanCell(cell, 0)); } sizes[k] = span[1] - span[0]; }
        }
        try {
          // Only a separately printed position field receives numeric-edge cleanup. Shared T5
          // pipe/duty fields, all names, dates, shift and duty cells keep their original path.
          let start = 0; for (let k = 0; k < sizes.length; k++) {
            if (sizes[k] === 3) {
              const original = cells[start + 1], cleaned = PipeRosterReader.cleanNumericEdge(original);
              if (cleaned != null) {
                const originalPath = await this._evidence([original], 'p' + page + '-r' + row + (k < groups.length ? '-d' + groups[k].day : '-c' + spans[k][0]) + '-position-initial');
                cells[start + 1] = cleaned; original.recycle(); enhanced[start + 1].recycle(); enhanced[start + 1] = GridVision.scanCell(cleaned, 0);
                AppLog.event('ocr.pipe.position.edge', AppLog.data('page', page + 1, 'row', row, 'column', spans[k][0] + 1, 'originalEvidence', originalPath));
              }
            }
            start += sizes[k];
          }
          const raw = await this._readTiles(cells, 190, 100), retry = await this._readTiles(enhanced, 220, 120); let offset = 0;
          for (let i = 0; i < spans.length; i++) {
            const size = sizes[i]; const group = i < groups.length ? groups[i] : null;
            const file = await this._evidence(cells.slice(offset, offset + size), 'p' + page + '-r' + row + (group != null ? '-d' + group.day : '-c' + spans[i][0]));
            // Audit (3.0 cell training): each part of the day (code | position | duty) as its own image.
            if (PipeRosterReader.saveCellParts && group != null) for (let part = 0; part < size; part++) await this._evidence([cells[offset + part]], 'p' + page + '-r' + row + '-d' + group.day + '-part' + part);
            const value = await this.readCells(cells.slice(offset, offset + size), raw.slice(offset, offset + size), retry.slice(offset, offset + size), file);
            const pipeCell = cells[offset + 1]; const pw = pipeCell.getWidth(), ph = pipeCell.getHeight(); const pixels = new Int32Array(pw * ph); pipeCell.getPixels(pixels, 0, pw, 0, 0, pw, ph); const signature = GlyphMatch.signature(pixels, pw, ph);
            if (group != null) { employee.days.put(group.day, PipeDay.merge(employee.days.get(group.day), value)); glyphs.push(new Glyph(employee.days, group.day, signature)); }
            else { const column = columns.get(structured[i - groups.length]); column.values.set(employee.name, value); glyphs.push(new Glyph(column.values, employee.name, signature)); }
            offset += size;
          }
        } finally { for (const b of cells) b.recycle(); for (const b of enhanced) b.recycle(); }
        for (let i = 0; i < layout.open.length; i++) {
          const o = layout.open[i]; if (o.structured || inked[i]) continue;
          for (let column = o.start; column < o.end && !inked[i]; column++) { const cell = grid.cell(column, row); try { inked[i] = !GridVision.clearlyBlank(cell); } finally { cell.recycle(); } }
        }
      }
      // 26/10 night (the user: no notice or warning): a name read on two rows of one photo (the August Tô Hoài
      // sheet prints "Sinh Nhật" twice) no longer discards the whole photo. The repeated row is not read and that
      // person's days are unknown ("?"): which row is theirs cannot be told, and "?" is never a wrong value.
      if (repeated.size !== 0) {
        for (const e of book.employees) if (repeated.has(Schedule.normalizeName(e.name))) for (const [day, v] of e.days) e.days.put(day, unknownRepeated(v));
        for (const c of columns.values()) for (const [k, v] of c.values) if (repeated.has(Schedule.normalizeName(k))) c.values.set(k, unknownRepeated(v));
      }
    } finally { for (const b of nameCells) b.recycle(); }
    // 26/10 night: steps after the cells are read only refine them; a fault in one of them (an index error after
    // 42 min on the August Tô Hoài photo) must not throw away every cell already read.
    progress.update('Ảnh ' + (page + 1) + ' · so mẫu chữ cho các ô số ống chưa đọc rõ…');
    try { PipeRosterReader._resolveByTemplates(glyphs, this._ledgerTemplates()); } catch (fault) { if (!runtime(fault)) throw fault; if (BuildConfig.DEBUG) Log.d('PipeImport', 'templates failed', fault); }
    for (const g of groups) book.layout.push([g.start, g.end, g.day]);
    try {
      for (let i = 0; i < layout.open.length; i++) {
        const o = layout.open[i]; const c = columns.get(o);
        let before = false, after = false; for (const g of groups) { if (g.end <= o.start) before = true; if (g.start >= o.end) after = true; }
        let codes = 0; let marks = false; for (const v of c.values.values()) { if (v.code != null && v.code !== '') codes++; if (v.code !== '' || v.pipe !== '') marks = true; }
        // Between two printed dates a column is certainly printed: keep it if anything is written in it.
        // Beyond the first or last printed date it may be the page border or background: it needs a number
        // read in its date cell or real shift codes in at least two rows.
        const printed = before && after ? o.readings.length !== 0 || inked[i] || marks : o.readings.length !== 0 || codes >= 2;
        if (printed) book._openColumns.push(c);
      }
      book.settleColumns();
    } catch (fault) { if (!runtime(fault)) throw fault; if (BuildConfig.DEBUG) Log.d('PipeImport', 'open columns failed', fault); }
  }
  /** Position cells the user confirmed on earlier scans (error ledger), loaded once per reading. */
  _ledgerTemplates() { const root = this._self; if (root._ledger == null) try { root._ledger = new ErrorLedger(this._context).pipeTemplates(); } catch (unreadable) { if (!runtime(unreadable)) throw unreadable; root._ledger = new JavaHashMap(); } return root._ledger; }
  /** Position cells OCR left unread are compared with cells of the same photo whose position OCR confirmed
   *  (same typeface, size and blur). Measured on the real October cells: 139 leave-one-out decisions, 0 wrong
   *  at these thresholds; a margin of 0.05 already produced one wrong value, so it stays at 0.10. A cell that
   *  may print two positions, a conflict between photos or a day off is never decided this way. */
  static _resolveByTemplates(glyphs, confirmedBefore) {
    const examples = new JavaHashMap();
    for (const g of glyphs) { const v = mapGet(g.map, g.key); if (v != null && !v.conflict && v.pipe != null && v.pipe !== '' && g.signature != null) examples.computeIfAbsent(v.pipe, () => []).push(g.signature); }
    for (const g of glyphs) {
      const v = mapGet(g.map, g.key);
      if (v == null || v.conflict || v.code == null || Schedule.dayOff(v.code) || v.pipe != null || g.signature == null) continue;
      const fields = split(v.raw, / \| /, -1); if (fields.length > 1 && PipeFieldVotes.twoNumbers(fields[1])) continue;
      let r = GlyphMatch.classify(g.signature, examples, PipeRosterReader.TEMPLATE_SCORE, PipeRosterReader.TEMPLATE_MARGIN);
      // A template is one reading: D5/S10 with 19 or 21 needs two (PipeRules.needsSecondReading), so it stays "?".
      if (r != null && (OcrCodes.pipeCandidate(r.value) == null || PipeRules.needsSecondReading(v.code, r.value))) r = null;
      // 3.0: cells the user confirmed on another photo, with the stricter cross-photo thresholds.
      if (r == null && !mapEmpty(confirmedBefore)) {
        r = GlyphMatch.classify(g.signature, confirmedBefore, ErrorLedger.TEMPLATE_SCORE, ErrorLedger.TEMPLATE_MARGIN);
        if (r != null && (OcrCodes.pipeCandidate(r.value) == null || PipeRules.contradicts(v.code, r.value) || PipeRules.needsSecondReading(v.code, r.value))) r = null;
        if (r != null) { mapPut(g.map, g.key, new PipeDay(v.code, r.value, v.duty, v.raw + format(' | mẫu sổ lỗi %s %.2f/%.2f', r.value, r.best, r.second), v.evidence)); continue; }
      }
      if (r != null) mapPut(g.map, g.key, new PipeDay(v.code, r.value, v.duty, v.raw + format(' | mẫu %s %.2f/%.2f', r.value, r.best, r.second), v.evidence));
    }
  }
  /** Bounds open columns by the period printed in the sheet title, then re-checks forced dates. */
  async _readPrintedPeriod(book, scan, grid) {
    const period = PipeHeaders.printedPeriod(await this.periodText(scan, grid), book.month);
    if (period != null) { book.printedFrom = period[0]; book.printedTo = period[1]; book.settleColumns(); }
  }
  /** Text of the title band above the table (full resolution, then contrast-stretched) and of the whole
   *  page, each also joined into one line so a range split by OCR into two lines is still found. */
  async periodText(scan, grid) {
    let all = '';
    const c = grid == null ? null : grid.corners(); const top = c == null ? 0 : Math.min(c[1], c[3]);
    const bandHeight = Math.max(1, Math.min(scan.getHeight(), roundF(top < f(0.03) ? f(scan.getHeight() * f(0.30)) : f(f(top + f(0.05)) * scan.getHeight()))));
    const views = [];
    try {
      const band = Bitmap.createBitmap(scan, 0, 0, scan.getWidth(), bandHeight); views.push(band); views.push(GridVision.enhance(band));
      const scale = Math.min(1, f(2200 / Math.max(scan.getWidth(), scan.getHeight()))); views.push(Bitmap.createScaledBitmap(scan, Math.max(1, roundF(f(scan.getWidth() * scale))), Math.max(1, roundF(f(scan.getHeight() * scale))), true));
      for (const view of views) try { const t = (await this._text(view)).getText(); all += t + '\n' + t.replace(/\n/g, ' ') + '\n'; } catch (unreadable) { /* next view */ }
    } catch (unavailable) { /* no title text */ }
    finally { for (const b of views) if (b !== scan) b.recycle(); }
    return all;
  }
  /** The unread date cell together with the sub-header row below it, for the user to read. */
  async _headerEvidence(grid, o, page) {
    const parts = [];
    try {
      for (let row = o.headerRow; row <= Math.min(o.headerRow + 1, grid.y.length - 2); row++) parts.push(grid.headerCell(o.start, o.end, row));
      let width = 0, height = 0; for (const b of parts) { width = Math.max(width, b.getWidth()); height += b.getHeight() + 4; }
      const joined = Bitmap.createBitmap(Math.max(1, width), Math.max(1, height), ARGB_8888); const c = new Canvas(joined); c.drawColor(Color.WHITE); let y = 0;
      for (const b of parts) { c.drawBitmap(b, f((width - b.getWidth()) / 2), y, null); y += b.getHeight() + 4; }
      const file = new File(this._directory, 'p' + page + '-header-c' + o.start + '.png');
      const out = new FileOutputStream(file); try { await joined.compress(Bitmap.CompressFormat.PNG, 100, out); } finally { try { out.close(); } finally { joined.recycle(); } }
      return file.getAbsolutePath();
    } catch (unavailable) { return ''; }
    finally { for (const b of parts) b.recycle(); }
  }
  /** Keep the three printed fields together, with a non-data orientation label. */
  async _readGroup(cells, enhance) {
    let width = 0, height = 0; const boundaries = new Int32Array(cells.length + 1);
    for (let i = 0; i < cells.length; i++) { width += cells[i].getWidth(); boundaries[i + 1] = width; height = Math.max(height, cells[i].getHeight()); }
    const joined = Bitmap.createBitmap(width, height, ARGB_8888); const source = new Canvas(joined); source.drawColor(Color.WHITE);
    for (let i = 0; i < cells.length; i++) source.drawBitmap(cells[i], boundaries[i], 0, null);
    const processed = enhance ? GridVision.scanCell(joined, 0) : joined, large = GridVision.enlarge(processed, 600, 160), input = Bitmap.createBitmap(600, 220, ARGB_8888);
    const canvas = new Canvas(input); canvas.drawColor(Color.WHITE); const label = new Paint(Paint.ANTI_ALIAS_FLAG); label.setColor(Color.BLACK); label.setTextSize(24); canvas.drawText('SHIFT    POSITION    DUTY', 24, 30, label); canvas.drawBitmap(large, 0, 60, null);
    const scale = Math.min(f(576 / width), f(140 / height)), left = f(f(600 - f(width * scale)) / 2); const values = new Array(cells.length).fill('');
    try {
      for (const block of (await this._text(input)).getTextBlocks()) for (const line of block.getLines()) for (const element of line.getElements()) {
        const b = element.getBoundingBox(); if (b == null || b.top < 60) continue; const x = f(f(b.exactCenterX() - left) / scale);
        for (let i = 0; i < cells.length; i++) if (x >= boundaries[i] && x < boundaries[i + 1]) {
          if (f(f(b.left - left) / scale) >= boundaries[i] - 2 && f(f(b.right - left) / scale) <= boundaries[i + 1] + 2) values[i] += (values[i] === '' ? '' : ' ') + element.getText(); break;
        }
      }
    } finally { input.recycle(); large.recycle(); if (processed !== joined) processed.recycle(); joined.recycle(); }
    return values;
  }
  /** Keep successful readings; retry unresolved fields independently with an upright label. */
  async readCells(cells, first, second, file) {
    const size = cells.length; const votes = new Array(size); const blank = new Array(size).fill(false);
    for (let i = 0; i < size; i++) {
      votes[i] = new PipeFieldVotes(PipeFieldVotes.Field.values()[i]); votes[i].add(first[i]); votes[i].add(second[i]);
      blank[i] = GridVision.clearlyBlank(cells[i]) && !votes[i].hasText();
    }
    let retryGroup = false; for (let i = 0; i < size; i++) if (!blank[i] && votes[i].value() == null) retryGroup = true;
    if (retryGroup) { const grouped = await this._readGroup(cells, false); for (let i = 0; i < size; i++) { votes[i].add(grouped[i]); blank[i] = blank[i] && !votes[i].hasText(); } }
    for (let i = 0; i < size; i++) {
      // A third, unused column cannot create an error on a non-D5 shift.
      if (i === 2 && votes[0].value() != null && votes[0].value() !== 'D5') continue;
      if (blank[i] || votes[i].value() != null || i === 1 && size === 2 && PipeRules.confirmedMergedVote(votes[i].all()) != null) continue;
      // Individual padded cells prevent OCR joining neighbouring columns, and
      // the label prevents an isolated 9 being read upside-down as 6.
      for (const mode of [-1, -2, -3, 0, 3, 1]) {
        votes[i].add(await this._readField(cells[i], mode));
        if (votes[i].value() != null || i === 1 && size === 2 && PipeRules.confirmedMergedVote(votes[i].all()) != null) break;
      }
      // Two more independent views for thin or single glyphs (11, 9) that OCR tends to skip entirely.
      // Measured on real October crops: they add correct readings but are only votes; disagreement stays '?'.
      // Skipped for evenly shaded cells with no text so far: thickening would turn paper grain into marks.
      if (votes[i].value() == null && !GridVision.clearlyBlank(cells[i]) && (votes[i].hasText() || !GridVision.uniformTone(cells[i]))) { votes[i].add(await this._readAnchored(cells[i])); if (votes[i].value() == null) votes[i].add(await this._readThick(cells[i])); }
      // Sparse digits on a gray fill occupy less than the general enhancer's 10% dark
      // percentile. Add whole-cell contrast views only for an unresolved separate
      // position field; anchor/thick views retry a still-unread number. Every original
      // observation remains a vote, including every conflict.
      if (i === 1 && size === 3 && votes[i].value() == null && !blank[i]) {
        const numeric = PipeRosterReader.contrastNumeric(cells[i]); if (numeric != null) try {
          const firstNumeric = await this._readField(numeric, -2), secondNumeric = await this._readField(numeric, -3); votes[i].add(firstNumeric); votes[i].add(secondNumeric);
          let anchoredNumeric = null, thickNumeric = null;
          if (votes[i].value() == null) { anchoredNumeric = await this._readAnchored(numeric); votes[i].add(anchoredNumeric); }
          if (votes[i].value() == null) { thickNumeric = await this._readThick(numeric); votes[i].add(thickNumeric); }
          const numericPath = await this._evidence([numeric], baseName(file) + '-numeric-contrast');
          AppLog.event('ocr.pipe.position.contrast', AppLog.data('sourceEvidence', file, 'contrastEvidence', numericPath, 'first', firstNumeric, 'second', secondNumeric, 'anchored', anchoredNumeric, 'thick', thickNumeric, 'resolved', votes[i].value()));
        } finally { numeric.recycle(); }
      }
      blank[i] = GridVision.clearlyBlank(cells[i]) && !votes[i].hasText();
      // Gray halftone fills defeat the strict pixel test. When no OCR pass, including the contrast-
      // stretched ones, found any character and the shading is even, the printed cell is empty.
      if (!blank[i] && !votes[i].hasText() && votes[i].readings() >= 6 && GridVision.uniformTone(cells[i])) blank[i] = true;
    }
    // A shared T5 field may settle its number before its duty is verified. On the smaller 28/10 photo,
    // Uan's day 20 read "22 / I22 / 22": the left rule supplied I, the number was settled, and no isolated
    // view was tried. Verify the COMPLETE shared field in three agreeing isolated views before calling
    // its duty empty. A suffix, different number or malformed text still leaves the duty unread.
    let verifiedBarePipe = null; const settledPipe = votes[1].value();
    if (PipeRosterReader.needsSharedDutyVerification(size, votes[0].value(), blank[1], settledPipe, votes[1].all())) {
      const whole = cells[1], cleaned = withoutFaintLeftRuleBitmap(whole); const isolated = [];
      try {
        if (cleaned != null && BuildConfig.DEBUG) await this._evidence([cleaned], baseName(file) + '-left-rule');
        // The pale rule on Uan's crop survives scanCell's dark-pixel threshold and is read I/T/-. A
        // measured paper gap permits removing only that rule; keep the complete field, including suffixes.
        for (const mode of cleaned == null ? [0, 3, 1, -2] : [-1, -2, -3, 0]) {
          const reading = await this._readField(cleaned == null ? whole : cleaned, mode); isolated.push(reading); votes[1].add(reading);
          if (PipeRosterReader.verifiedBareSharedPipe(settledPipe, votes[1].all(), isolated)) { verifiedBarePipe = settledPipe; break; }
        }
      } finally { if (cleaned != null) cleaned.recycle(); }
    }
    // An empty (white or gray) shift cell is a day off only together with an empty position cell; see PipeDay.fromCells.
    const code = blank[0] ? '' : votes[0].value(); let pipe = votes[1].value(), duty = size === 3 ? votes[2].value() : '';
    // 26/10 night: a column rule split the pipe number on the user's T5 photo ("1 | 1", "| 9") and the part beside it
    // fell into the duty column: S10 · 1 and S10 · (empty) were stored, wrong values. A duty column that reads a
    // bare number (a duty is HC, TC, TC1…, never digits alone) means the cells are cut off the printed ones: the pipe (and the D5
    // duty) stay "?", and the pipe-number reader is not asked about a piece of a number. A grey-shaded empty duty
    // cell (no digits) changes nothing.
    let misCut = false;
    if (size === 3 && !blank[2] && code != null && code !== '') {
      for (const r of votes[2].all()) if (r != null && /^[0-9]{1,3}$/.test(r.replace(/[ \t\n\x0B\f\r|.,:;'[\]()]/g, ''))) misCut = true;
      if (misCut) { pipe = null; if (code === 'D5') duty = null; }
    }
    // 3.0 (26/10, phase 3): a pipe number no OCR pass settled (25/10 T.T. Vinh day 30: a blurred "11") is asked of
    // the pipe reader trained on the sheets' own pipe cells — only where the pipe cell holds a number alone: a day
    // of three cells (one per field), or an S10 day (S10 never has a duty, so even team T5's shared pipe/duty cell
    // holds just the number; blind on T5's 57 S10 pipe cells: 3 answered, all right) — only where the cell has
    // ink, and only at its threshold; "empty" or no answer leaves it "?".
    let fromReader = null; let fieldReader = null;
    if (pipe == null && !misCut && (size === 3 || code === 'S10') && !blank[1] && (fieldReader = await this._pipeReaderFor()) != null) try {
      const p = await fieldReader.read(cells[1]); if (p != null && p !== '') { pipe = p; fromReader = p; }
      if (BuildConfig.DEBUG) Log.d('PipeReader', file + ' asked: ' + p);
    } catch (unreadable) { if (BuildConfig.DEBUG) Log.d('PipeReader', file + ' failed: ' + unreadable); }
    else if (BuildConfig.DEBUG && pipe == null) Log.d('PipeReader', file + ' not asked: size ' + size + ' blank ' + blank[1] + ' reader ' + ((await this._pipeReaderFor()) != null));
    // A tiny gray numeral may remain below the original reader's unchanged confidence threshold.
    // Retry only a separate, still-unread numeric field, preserving its complete observed ink extent.
    if (pipe == null && size === 3 && !misCut && !blank[1] && fieldReader != null && !PipeFieldVotes.twoNumbers(votes[1].raw())) {
      const focus = PipeRosterReader.focusedNumericPixels(cells[1]);
      if (focus != null) {
        const focused = Bitmap.createBitmap(focus.pixels, focus.width, focus.height, ARGB_8888);
        try {
          const prediction = await fieldReader.read(focused); const probabilities = await fieldReader.probabilities(focused); let best = -1; if (probabilities != null) for (let k = 0; k < probabilities.length; k++) if (best < 0 || probabilities[k] > probabilities[best]) best = k;
          const originalProbabilities = await fieldReader.probabilities(cells[1]); let originalBest = -1; if (originalProbabilities != null) for (let k = 0; k < originalProbabilities.length; k++) if (originalBest < 0 || originalProbabilities[k] > originalProbabilities[originalBest]) originalBest = k;
          const originalLabel = originalBest < 0 ? null : fieldReader.labels[originalBest]; const originalProbability = originalBest < 0 ? 0 : originalProbabilities[originalBest];
          const accepted = PipeRosterReader.focusedModelAgreement(prediction, votes[1].all(), originalLabel, originalProbability); const focusedPath = await this._evidence([focused], baseName(file) + '-numeric-focus');
          AppLog.event('ocr.pipe.position.focus', AppLog.data('sourceEvidence', file, 'focusedEvidence', focusedPath, 'bounds', new JSONArray(focus.bounds), 'threshold', jfloat(fieldReader.threshold), 'best', best < 0 ? null : fieldReader.labels[best], 'probability', best < 0 ? null : jfloat(probabilities[best]), 'originalBest', originalLabel, 'originalProbability', jfloat(originalProbability), 'read', prediction, 'accepted', accepted));
          if (accepted) { pipe = prediction; fromReader = prediction; }
        } catch (unreadable) { if (BuildConfig.DEBUG) Log.d('PipeReader', file + ' focused retry failed: ' + unreadable); } finally { focused.recycle(); }
      }
    }
    // Two columns per day (team T5) hold pipe and duty in ONE cell: reading only "13" there does not show that the
    // duty is empty (25/10: "13TC1" read as "13TC:" made 13 with no duty, a wrong value). The duty stays unknown.
    // A blank shared cell (Phạm Quang Hải: "D5" with nothing beside it) is an empty position AND an empty duty.
    let emptyDuty = size === 3 ? blank[2] : code !== 'D5' || blank[1] || pipe != null && pipe === verifiedBarePipe; let raw = votes[0].raw() + ' | ' + votes[1].raw() + (fromReader != null ? ' · bộ đọc ống: ' + fromReader : '') + (size === 3 ? ' | ' + votes[2].raw() : '');
    // A word in the shift cell ("LỘC") is kept as printed: merged with the work roster it is "Khác Ca".
    const word = code == null && !blank[0] ? PipeRules.wordVote(votes[0].all()) : null;
    // Team T5 prints pipe and duty in one cell ("12TC2", "9HC", "TC").
    const merged = size === 2 && pipe == null && !blank[1] ? PipeRules.confirmedMergedVote(votes[1].all()) : null;
    if (merged != null) { pipe = merged[0]; duty = merged[1]; emptyDuty = false; }
    // 27/10: on a blurred re-shot photo the OCR read "11" as "22" four times and "10" as "20" twice (T.T. Vinh r101) —
    // votes cannot catch a misreading they all share. When the pipe-number reader prefers another number (≥ 0.4) and
    // gives the OCR's number under 0.2, the pipe stays "?". Checked on every OCR-settled pipe of the October T.T.
    // Vinh and Tô Hoài sheets and the August Tô Hoài photo: it vetoes none of them. Not on team T5's sheets (14 right
    // values of 52 would be vetoed there).
    if (pipe != null && /^[0-9]+$/.test(pipe) && fromReader == null && !misCut && !this._numberedSheet && (size === 3 || code === 'S10') && !blank[1] && (await this._pipeReaderFor()) != null) try {
      const p = await this._pipeReader.probabilities(cells[1]);
      if (p != null) {
        let best = 0; for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i; const own = this._pipeReader.labels.indexOf(pipe); const mine = own < 0 ? 0 : p[own];
        if (this._pipeReader.labels[best] !== pipe && p[best] >= f(.4) && mine < f(.2)) { raw += format(' · bộ đọc ống không đồng ý: %s %.2f', this._pipeReader.labels[best], p[best]); pipe = null; }
      }
    } catch (unreadable) { if (BuildConfig.DEBUG) Log.d('PipeReader', file + ' veto failed: ' + unreadable); }
    // 26/10 (user, "cách A"): D5/S10 with 19 or 21 needs a second reading — three OCR readings all giving it, the
    // pipe-number reader agreeing with the OCR, or (when the number came from the reader) one OCR reading agreeing.
    // Otherwise a blurred 11 read as 21 (Vinh, Hải Ngọc day 30) would be stored; the pipe stays "?" instead.
    if (PipeRules.needsSecondReading(code, pipe)) {
      let confirmed;
      if (fromReader != null) confirmed = PipeRules.anyReading(votes[1].all(), pipe);
      else {
        confirmed = PipeRules.unanimous(votes[1].all(), pipe);
        if (!confirmed && (size === 3 || code === 'S10') && !blank[1]) try { const confirmingReader = await this._pipeReaderFor(); confirmed = confirmingReader != null && pipe === (await confirmingReader.read(cells[1])); } catch (unreadable) { confirmed = false; }
      }
      if (!confirmed) { raw += ' · ' + pipe + ' chưa có lần đọc thứ hai'; pipe = null; }
    }
    // A code and a pipe that cannot go together leave the pipe unread instead of storing a wrong pair.
    if (PipeRules.contradicts(word != null ? word : code, pipe)) pipe = null;
    let value;
    if (word != null) value = new PipeDay(word, pipe == null ? null : pipe, '', raw, file);
    else if (merged != null && pipe != null && pipe === '' && code != null) value = new PipeDay(code, '', duty, raw, file);
    else value = PipeDay.fromRecognition(code, pipe, duty, blank[1] && !misCut, emptyDuty && !misCut, file);
    // D5 whose duty cell has ink but no reading: the default duty of that pipe, marked as not read.
    if (value.code === 'D5' && value.pipe != null && value.duty == null && size === 3 && !blank[2]) { const d = PipeRules.defaultDuty(value.pipe); if (d != null && d !== '') value = new PipeDay(value.code, value.pipe, d + PipeRules.DEFAULT_MARK, raw, file); }
    // One-cell pipe+duty: the default duty when the table has one (marked *); "no duty" only when every reading
    // is a bare number AND the user's table also has no duty for that pipe (12 excluded: often printed 12TC2).
    if (value.code === 'D5' && value.pipe != null && value.pipe !== '' && value.duty == null && size === 2 && merged == null) {
      const d = PipeRules.defaultDuty(value.pipe);
      if (d != null && d !== '') value = new PipeDay(value.code, value.pipe, d + PipeRules.DEFAULT_MARK, raw, file);
      else if (d != null && value.pipe !== '12' && PipeRules.bareNumbers(votes[1].all())) value = new PipeDay(value.code, value.pipe, '', raw, file);
    }
    return PipeRules.confirmedPrintedDay(new PipeDay(value.code, value.pipe, value.duty, raw, file));
  }
  /** Retry only a settled D5 number whose shared field has not established a duty. The existing table must
   *  allow no duty; 12 is excluded because the same cell often prints 12TC2. */
  static needsSharedDutyVerification(fields, code, blank, pipe, readings) {
    return fields === 2 && code === 'D5' && !blank && pipe != null && /^[0-9]+$/.test(pipe) && pipe !== '12'
      && PipeRules.defaultDuty(pipe) === '' && PipeRules.mergedVote(readings) == null && !PipeRules.bareNumbers(readings);
  }
  /** Three fresh, whole-cell readings must give exactly the settled number. Every other reading must be
   *  that same number, or that number preceded by one upright rule glyph (I/l/|/!); neither a suffix nor
   *  another numeric reading can be discarded. Any observed duty suffix remains evidence against an empty duty. */
  static verifiedBareSharedPipe(pipe, readings, isolated) {
    if (pipe == null || !/^[0-9]+$/.test(pipe) || pipe === '12' || PipeRules.defaultDuty(pipe) !== '') return false;
    const prefixed = new RegExp('^[Il|!][ \\t\\n\\x0B\\f\\r]*' + pipe + '$');
    for (const reading of readings) {
      const s = reading == null ? '' : trim(reading); if (s === '' || s === pipe) continue;
      if (!prefixed.test(s)) return false;
    }
    let agreed = 0; for (const reading of isolated) { const s = reading == null ? '' : trim(reading); if (s === pipe) agreed++; }
    return agreed >= 3;
  }
  /** A faint edge rule can sit below the global dark threshold. Remove at most four outer columns only
   *  when the line crosses the top and bottom margins, a uniform paper strip separates it from the text,
   *  and no dark letter stroke would be erased. Canvas size and every pixel beyond the rule stay unchanged.
   *  (int[] pixels form; the Bitmap form of the Java is private to this module.) */
  static withoutFaintLeftRule(pixels, w, h) {
    if (w < 24 || h < 12 || pixels == null || pixels.length !== w * h) return null;
    const gap = Math.max(3, Math.min(6, (h / 8) | 0)), band = Math.max(2, (h / 6) | 0);
    for (let core = 0; core <= 1; core++) {
      const end = core + 3; let low = 255, high = 0, hits = 0, top = 0, bottom = 0; let darkStroke = false, bodyInk = false;
      for (let y = 0; y < h; y++) {
        let sum = 0; for (let x = end; x < end + gap; x++) { const g = sharedGray(pixels[y * w + x]); low = Math.min(low, g); high = Math.max(high, g); sum += g; }
        for (let x = 0; x < end; x++) if (sharedGray(pixels[y * w + x]) < 100) darkStroke = true;
        if (((sum / gap) | 0) - sharedGray(pixels[y * w + core]) >= 18) { hits++; if (y < band) top++; if (y >= h - band) bottom++; }
        for (let x = end + gap; x < w; x++) if (sharedGray(pixels[y * w + x]) < 100) bodyInk = true;
      }
      if (darkStroke || !bodyInk || low < 170 || high - low > 32 || hits < f(h * f(.9)) || top < f(band * f(.8)) || bottom < f(band * f(.8))) continue;
      const cleaned = pixels.slice(); for (let y = 0; y < h; y++) for (let x = 0; x < end; x++) cleaned[y * w + x] = pixels[y * w + end]; return cleaned;
    }
    return null;
  }
  async _readField(cell, mode) {
    const processed = mode < 0 ? cell : GridVision.scanCell(cell, mode);
    const width = mode === -2 ? 260 : mode === -3 ? 460 : 360, height = mode === -2 ? 110 : mode === -3 ? 180 : 150;
    const large = GridVision.enlarge(processed, width, height), input = Bitmap.createBitmap(width, height + 60, ARGB_8888);
    const canvas = new Canvas(input); canvas.drawColor(Color.WHITE); const label = new Paint(Paint.ANTI_ALIAS_FLAG);
    label.setColor(Color.BLACK); label.setTextSize(22); canvas.drawText('VALUE', 20, 28, label); canvas.drawBitmap(large, 0, 60, null);
    let value = '';
    try {
      for (const block of (await this._text(input)).getTextBlocks()) for (const line of block.getLines()) for (const element of line.getElements()) {
        const bounds = element.getBoundingBox(); if (bounds != null && bounds.top >= 60) { if (value.length > 0) value += ' '; value += element.getText(); }
      }
    } finally { input.recycle(); large.recycle(); if (processed !== cell) processed.recycle(); }
    return value;
  }
  /** The cell between two printed anchor words on one text line, so a lone short value is read as part of a line. */
  async _readAnchored(cell) {
    const large = GridVision.enlarge(cell, 300, 140), input = Bitmap.createBitmap(900, 180, ARGB_8888); const canvas = new Canvas(input); canvas.drawColor(Color.WHITE);
    const anchor = new Paint(Paint.ANTI_ALIAS_FLAG); anchor.setColor(Color.BLACK); anchor.setTextSize(64); anchor.setTypeface(Typeface.create(Typeface.SERIF, Typeface.BOLD));
    canvas.drawText('WK', 30, 115, anchor); canvas.drawBitmap(large, 260, 20, null); canvas.drawText('WK', 620, 115, anchor); let value = '';
    try {
      for (const block of (await this._text(input)).getTextBlocks()) for (const line of block.getLines()) for (const element of line.getElements()) {
        const b = element.getBoundingBox(); if (b == null || b.right <= 262 || b.left >= 558) continue; let t = element.getText();
        if (b.left < 262 && !t.toUpperCase().startsWith('WK')) continue;
        t = t.replace(/^WK/i, '').replace(TRAILING_WK, ''); if (t !== '') { if (value.length > 0) value += ' '; value += t; }
      }
    } finally { input.recycle(); large.recycle(); }
    return value;
  }
  /** Black-and-white copy with strokes widened by one pixel, for thin serif digits; read under the usual label. */
  async _readThick(cell) { const thick = PipeRosterReader.thick(cell); try { return await this._readField(thick, -1); } finally { thick.recycle(); } }
  static thick(cell) {
    const w = cell.getWidth(), h = cell.getHeight(); const p = new Int32Array(w * h); cell.getPixels(p, 0, w, 0, 0, w, h); const g = new Int32Array(p.length);
    for (let i = 0; i < p.length; i++) g[i] = ((((p[i] >> 16) & 255) * 30 + ((p[i] >> 8) & 255) * 59 + (p[i] & 255) * 11) / 100) | 0;
    const sorted = g.slice().sort(); const paper = sorted[((sorted.length * 3) / 4) | 0], threshold = paper - (((paper - sorted[(sorted.length / 50) | 0]) / 2) | 0); const out = new Int32Array(p.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let dark = false; for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1) && !dark; yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) if (g[yy * w + xx] < threshold) { dark = true; break; }
      out[y * w + x] = dark ? Color.BLACK : Color.WHITE;
    }
    return Bitmap.createBitmap(out, w, h, ARGB_8888);
  }
  static cleanNumericEdge(cell) { const w = cell.getWidth(), h = cell.getHeight(); const pixels = new Int32Array(w * h); cell.getPixels(pixels, 0, w, 0, 0, w, h); const cleaned = PipeNumericEdge.clean(pixels, w, h); return cleaned == null ? null : Bitmap.createBitmap(cleaned, w, h, ARGB_8888); }
  static contrastNumeric(cell) {
    const w = cell.getWidth(), h = cell.getHeight(); const pixels = new Int32Array(w * h); cell.getPixels(pixels, 0, w, 0, 0, w, h); const stretched = PipeNumericContrast.stretch(pixels, w, h); if (stretched == null) return null;
    // Do not feed this sparse-stroke stretch into the general 10% enhancer again:
    // its new dark endpoint would be paper texture and amplify that texture into marks.
    return Bitmap.createBitmap(stretched, w, h, ARGB_8888);
  }
  static focusedNumericPixels(cell) { const w = cell.getWidth(), h = cell.getHeight(); const pixels = new Int32Array(w * h); cell.getPixels(pixels, 0, w, 0, 0, w, h); return PipeNumericFocus.create(pixels, w, h); }
  static focusNumeric(cell) { const view = PipeRosterReader.focusedNumericPixels(cell); return view == null ? null : Bitmap.createBitmap(view.pixels, view.width, view.height, ARGB_8888); }
  static focusedPredictionAllowed(prediction, readings) {
    if (prediction == null || prediction === '' || !/^[0-9]+$/.test(prediction) || prediction !== OcrCodes.pipeCandidate(prediction)) return false;
    for (const raw of readings) {
      const text = raw == null ? '' : raw; if (PipeRosterReader.multipleNumericValuesInReading(text)) return false; const observed = OcrCodes.pipeObservation(text);
      if (observed == null || observed === '' || observed === prediction) continue; if (observed.length >= prediction.length || !prediction.includes(observed)) return false;
    }
    return true;
  }
  static multipleNumericValuesInReading(raw) {
    const text = trim(raw); if (!/^[0-9]+(?:[ \t\n\x0B\f\r,;/.-]+[0-9]+)+$/.test(text)) return false; const numbers = split(text, /[ \t\n\x0B\f\r,;/.-]+/);
    return numbers.length !== 2 || numbers[0] !== numbers[1];
  }
  static focusedModelAgreement(prediction, readings, originalTop, originalProbability) { return originalProbability > f(.5) && prediction != null && prediction === originalTop && PipeRosterReader.focusedPredictionAllowed(prediction, readings); }
  static agreeCode(a, b) { const first = OcrCodes.candidate(a), second = OcrCodes.candidate(b); return first != null && first === second ? first : null; }
  static agreePipe(a, b) { const first = OcrCodes.pipeCandidate(a), second = OcrCodes.pipeCandidate(b); return first != null && first === second ? first : null; }
  static agreeDuty(a, b) { const first = OcrCodes.dutyCandidate(a), second = OcrCodes.dutyCandidate(b); return first != null && first === second ? first : null; }
  async _readTiles(cells, tileW, tileH) {
    const result = new Array(cells.length).fill(''); const columns = tileW > 400 ? 2 : 5, batch = columns * 8;
    for (let start = 0; start < cells.length; start += batch) {
      const count = Math.min(batch, cells.length - start); const montage = Bitmap.createBitmap(columns * tileW, (((count + columns - 1) / columns) | 0) * tileH, ARGB_8888); const canvas = new Canvas(montage); canvas.drawColor(Color.WHITE);
      try {
        for (let i = 0; i < count; i++) { const tile = GridVision.enlarge(cells[start + i], tileW, tileH); canvas.drawBitmap(tile, (i % columns) * tileW, ((i / columns) | 0) * tileH, null); tile.recycle(); }
        for (const block of (await this._text(montage)).getTextBlocks()) for (const line of block.getLines()) for (const element of line.getElements()) {
          const bounds = element.getBoundingBox(); if (bounds == null) continue; const index = ((bounds.centerY() / tileH) | 0) * columns + ((bounds.centerX() / tileW) | 0);
          if (index >= 0 && index < count) result[start + index] += (result[start + index] === '' ? '' : ' ') + element.getText();
        }
      } finally { montage.recycle(); }
    }
    return result;
  }
  async _evidence(cells, name) {
    let width = 0, height = 0; for (const cell of cells) { width += cell.getWidth(); height = Math.max(height, cell.getHeight()); }
    const joined = Bitmap.createBitmap(width, height, ARGB_8888); const c = new Canvas(joined); c.drawColor(Color.WHITE); let x = 0;
    for (const cell of cells) { c.drawBitmap(cell, x, 0, null); x += cell.getWidth(); } const file = new File(this._directory, name + '.png');
    const out = new FileOutputStream(file); try { await joined.compress(Bitmap.CompressFormat.PNG, 100, out); } finally { try { out.close(); } finally { joined.recycle(); } } return file.getAbsolutePath();
  }
  async _vietOcrReader() { return this._once('_vietOcr', () => NameReader.open(this._context)); }
  /** Opens a shared model on first use, once for every lane (Task A4: two photos may ask at the same time): the first
   *  caller gets the model or the failure, later callers the model or null — as the Java's "tried" flag gives. */
  async _once(field, open) {
    const root = this._self, loading = root._loading ??= {};
    if (loading[field] == null) { loading[field] = Promise.resolve().then(open); root[field] = await loading[field]; return root[field]; }
    try { await loading[field]; } catch { /* the first caller saw the failure */ } return root[field];
  }
  close() { this._recognizer.close(); if (this._vietOcr != null) this._vietOcr.close(); if (this._pipeReader != null) this._pipeReader.close(); if (this._pipeReaderT5 != null) this._pipeReaderT5.close(); }
  /** The pipe-number reader (assets/pipes, 3.0 phase 3), opened on first use; null without a context or model. */
  async _pipeReaderFor() {
    if (this._numberedSheet) return this._once('_pipeReaderT5', () => (this._context == null ? null : CellReader.open(this._context, 'pipes-t5')));
    return this._once('_pipeReader', () => (this._context == null ? null : CellReader.open(this._context, 'pipes')));
  }
}
