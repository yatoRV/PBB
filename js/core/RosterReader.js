// Port of vn.lichdilam.RosterReader (APK 4.5). Everything that waits for OCR or ONNX is async (read, scanNames and
// the private readers); consensus() and the Result JSON stay synchronous. ML Kit → js/ocr/TextRecognizer.js with
// the same Text/TextBlock/Line/Element walk; Tasks.await keeps its 60 s timeout and, in a job of an ExecutorService
// (js/platform/java.js), throws InterruptedException when the job is cancelled, as on Android. Progress is an object with
// update(message), like the Java interface. Int division with |0 (Java truncation), float drawing positions with
// Math.fround. Java's `catch (Exception)` also catches JS errors here (they are the NullPointerExceptions of Java).
import { JavaException, equalsIgnoreCase, javaFloatToString, trim } from '../platform/java.js';
import { JSONObject, JSONArray } from '../platform/json.js';
import { YearMonth } from '../platform/time.js';
import { File, FileOutputStream, AtomicFile } from '../platform/files.js';
import { Bitmap, Canvas, Color, Matrix, Paint } from '../platform/bitmap.js';
import { BuildConfig } from '../platform/android.js';
import { Log } from '../platform/log.js';
import { TextRecognition, TextRecognizerOptions, InputImage, Tasks, TimeUnit } from '../ocr/TextRecognizer.js';
import { AppLog } from './AppLog.js';
import { GridVision } from './GridVision.js';
import { RosterRows } from './RosterRows.js';
import { StaffDirectory } from './StaffDirectory.js';
import { Personnel } from './Personnel.js';
import { Schedule } from './Schedule.js';
import { OcrCodes } from './OcrCodes.js';
import { NameReader } from './NameReader.js';
import { CellReader } from './CellReader.js';

const f = Math.fround;
const ARGB_8888 = Bitmap.Config.ARGB_8888;
/** Arrays.toString of a String[] / Arrays.deepToString of a String[][]. */
const arrayText = a => (a == null ? 'null' : '[' + a.map(v => (Array.isArray(v) ? arrayText(v) : v == null ? 'null' : String(v))).join(', ') + ']');
/** Arrays.toString(float[]). */
const floatsText = a => (a == null ? 'null' : '[' + Array.from(a, javaFloatToString).join(', ') + ']');

class Result {
  constructor() {
    this.schedule = null;
    this.readName = null; this.readNumber = null;
    this.identityMatches = false;
    this.identityImage = null;
    this.numberImage = null;
    this.cells = null;
    this.raw = null;
    this.row = 0;
    /** Every readable name in the roster's name column, kept exactly as printed (for swap history). */
    this.staff = null;
  }
  toStructuredJson() {
    const schedule = this.schedule;
    const root = new JSONObject(); root.put('schema', 1); root.put('month', schedule.month.toString()); root.put('scanLongEdge', 3840);
    const employee = new JSONObject(); employee.put('number', schedule.employeeNumber); employee.put('name', schedule.employeeName); employee.put('ocrNumber', this.readNumber); employee.put('ocrName', this.readName); employee.put('matched', this.identityMatches); root.put('employee', employee);
    const days = new JSONArray();
    for (let d = 0; d < schedule.shifts.length; d++) {
      const code = schedule.shifts[d]; const day = new JSONObject(); day.put('date', schedule.month.atDay(d + 1).toString()); day.put('code', code == null ? JSONObject.NULL : code);
      day.put('status', !schedule.present[d] ? 'notInPhoto' : code == null ? 'uncertain' : code === '' ? 'rest' : 'recognized'); day.put('ocr', this.raw[d]); days.put(day);
    }
    root.put('days', days); if (this.staff != null) root.put('staff', new JSONObject(this.staff.toJson()).getJSONArray('entries')); return root.toString();
  }
  saveStructured(context) {
    const file = new AtomicFile(new File(context.getFilesDir(), 'last-scan.json')); let output = null;
    try { output = file.startWrite(); output.write(new TextEncoder().encode(this.toStructuredJson())); file.finishWrite(output); }
    catch (e) { if (output != null) file.failWrite(output); throw e; }
  }
}

export class RosterReader {
  static Result = Result;
  /** new RosterReader() | new RosterReader(context). */
  constructor(context = null) {
    this._recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
    /** VietOCR second name reader (3.0); null = ML Kit only. Opened on the first photo. */
    this._context = context == null ? null : context.getApplicationContext(); this._vietOcr = null; this._vietOcrTried = false;
    /** Per row of the last name column read: {ML Kit, VietOCR views…, chosen text} (audit / name training). */
    this.lastNameReadings = null;
    // The grid, STT and name columns of the last photo stay ready for the next person on the same photo.
    this._cachedInput = null; this._cachedSource = null; this._cachedScan = null; this._cachedMonth = null; this._cachedGrid = null; this._cachedSerials = null; this._cachedNames = null;
    this._cellReader = null; this._cellReaderTried = false;
  }
  /** Audit hook (3.0 name training): only the name column of the photo, as the reader reads it, with each name
   *  cell saved to cropDir as name-r{row}.png exactly as given to the readers.
   *  scanNames(bitmap, corners, month: YearMonth | days: int, cropDir) — days: the day columns the grid must hold
   *  (the month's length in the app; an audit may give a half sheet's 15). */
  async scanNames(bitmap, corners, month, cropDir) {
    const days = month instanceof YearMonth ? month.lengthOfMonth() : month;
    const scan = GridVision.prepareScan(bitmap); const grid = GridVision.analyze(scan, corners, days);
    try {
      const count = grid.y.length - 1; await this._readNames(grid, count);
      if (cropDir != null) for (let r = 0; r < count; r++) { const c = grid.cell(1, r); const out = new FileOutputStream(new File(cropDir, 'name-r' + r + '.png')); try { await c.compress(Bitmap.CompressFormat.PNG, 100, out); } finally { try { out.close(); } finally { c.recycle(); } } }
      return this.lastNameReadings;
    } finally { grid.table.recycle(); scan.recycle(); }
  }
  async _text(b) {
    const result = await Tasks.await(this._recognizer.process(InputImage.fromBitmap(b, 0)), 60, TimeUnit.SECONDS);
    AppLog.event('ocr.raw', AppLog.data('reader', 'work', 'width', b.getWidth(), 'height', b.getHeight(), 'text', result.getText())); return result;
  }
  _dropCache() {
    if (this._cachedGrid != null && !this._cachedGrid.table.isRecycled()) this._cachedGrid.table.recycle(); if (this._cachedScan != null && !this._cachedScan.isRecycled()) this._cachedScan.recycle();
    if (this._cachedSource != null && this._cachedSource !== this._cachedInput && !this._cachedSource.isRecycled()) this._cachedSource.recycle();
    this._cachedInput = this._cachedSource = this._cachedScan = null; this._cachedGrid = null; this._cachedSerials = this._cachedNames = null; this._cachedMonth = null;
  }
  /** number ≤ 0 or an empty name means "not given": a name or an STT is enough. No manual border or rotation:
   *  the photo is tried as it is, then turned 90°, 270° and 180°. */
  async read(bitmap, corners, number, name, month, progress) {
    AppLog.event('ocr.work.begin', AppLog.data('number', number, 'name', name, 'month', month.toString(), 'width', bitmap.getWidth(), 'height', bitmap.getHeight(), 'corners', floatsText(corners)));
    try { const found = await this._readInternal(bitmap, corners, number, name, month, { update: message => { AppLog.message('ocr.work', message); progress.update(message); } }); AppLog.event('ocr.work.complete', new JSONObject(found.toStructuredJson())); return found; }
    catch (failure) { AppLog.failure('ocr.work', failure); throw failure; }
  }
  async _readInternal(bitmap, corners, number, name, month, progress) {
    if (bitmap === this._cachedInput && month.equals(this._cachedMonth) && this._cachedGrid != null) return this._readGrid(this._cachedSource, this._cachedGrid, number, name, month, progress);
    this._dropCache(); let first = null;
    for (const angle of [0, 90, 270, 180]) {
      let source = bitmap, found = corners;
      if (angle !== 0) { const turn = new Matrix(); turn.postRotate(angle); source = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), turn, true); found = GridVision.corners(source); progress.update('Đang thử ảnh xoay ' + angle + '°…'); }
      else progress.update('Đang tạo bản quét 4K và làm rõ nét chữ…');
      const scan = GridVision.prepareScan(source); let grid;
      try { progress.update('Đang tách các cột ngày và hàng nhân viên…'); grid = GridVision.analyze(scan, found, month.lengthOfMonth()); }
      catch (notThisWay) { if (first == null) first = notThisWay; scan.recycle(); if (source !== bitmap) source.recycle(); continue; }
      this._cachedInput = bitmap; this._cachedSource = source; this._cachedScan = scan; this._cachedGrid = grid; this._cachedMonth = month;
      return this._readGrid(source, grid, number, name, month, progress);
    }
    throw first;
  }
  static _staffOnly(values, summary) { const out = values.slice(); for (let r = 0; r < out.length; r++) if (summary[r]) out[r] = ''; return out; }
  async _readGrid(bitmap, grid, number, name, month, progress) {
    const count = grid.y.length - 1;
    // Read all serial numbers in padded individual strips, so merged table text cannot shift rows.
    if (grid !== this._cachedGrid || this._cachedSerials == null) {
      progress.update(number > 0 ? 'Đang tìm số thứ tự ' + number + '…' : 'Đang đọc cột số thứ tự…');
      this._cachedSerials = await this._readColumn(grid, 0, count, 120, 72);
      if (BuildConfig.DEBUG) Log.d('RosterTest', 'serials=' + arrayText(this._cachedSerials));
      progress.update('Đang đọc họ tên các nhân viên trong ảnh…');
      try { this._cachedNames = await this._readNames(grid, count); } catch (unreadable) { this._cachedNames = new Array(count).fill(''); }
    }
    const serials = this._cachedSerials, names = this._cachedNames;
    const summary = RosterRows.summaryRows(serials, names);
    const shown = RosterReader._staffOnly(names, summary); for (let r = 0; r < shown.length; r++) if (shown[r] !== '') shown[r] = Personnel.current().display(shown[r]);
    let staff; try { staff = StaffDirectory.fromRoster(month, RosterReader._staffOnly(serials, summary), shown); } catch (unreadable) { staff = null; /* Names are optional; the schedule is still read. */ }
    const choice = RosterRows.choose(serials, names, number, name, Personnel.current());
    if (choice.error != null) throw new JavaException(choice.error);
    if (choice.row < 0) throw new JavaException('Chưa thấy hàng của ' + (Schedule.normalizePerson(name) === '' ? 'STT ' + number : Schedule.normalizePerson(name)) + ' trên ảnh này. Kiểm tra họ tên hoặc STT. Lịch đã lưu vẫn được giữ nguyên.');
    const row = choice.row;
    progress.update('Đang đối chiếu hàng nhân viên…');
    const nameImage = grid.cell(1, row);
    const readName = trim((await this._text(GridVision.enlarge(nameImage, 900, 150))).getText().replace(/\n/g, ' '));
    const numberImage = grid.cell(0, row);
    const readNumber = trim((await this._text(GridVision.enlarge(GridVision.enhance(numberImage), 250, 150))).getText());
    const result = new Result(); result.readName = names[row] !== '' ? names[row] : readName; result.readNumber = readNumber === '' ? serials[row] : readNumber; result.row = row;
    result.numberImage = numberImage; result.identityMatches = choice.identityMatches;
    const left = Math.trunc(grid.x[0]), top = Math.trunc(grid.y[row]), right = Math.trunc(grid.x[2]), bottom = Math.trunc(grid.y[row + 1]);
    result.identityImage = Bitmap.createBitmap(grid.table, left, top, right - left, bottom - top);
    // The calendar owner is the confirmed person: the printed or OCR name never becomes the stored name.
    const owner = choice.person != null ? choice.person.name : Schedule.normalizePerson(name) !== '' ? Schedule.normalizePerson(name) : Personnel.current().display(result.readName);
    const ownerNumber = choice.number;
    const days = month.lengthOfMonth(), dayCount = grid.dayColumns();
    // 3.0 (26/10): a photo may hold only part of the month (the user's half sheet, days 1–15); only those days are
    // read and shown, the other days keep what was saved. The printed day numbers say which days they are;
    // without them the days are not guessed.
    if (grid.firstDay < 0) {
      grid.firstDay = dayCount >= days ? 0 : await this._firstDay(grid, dayCount, days);
      if (grid.firstDay < 0) throw new JavaException('Ảnh có ' + dayCount + ' cột ngày nhưng chưa đọc được số ngày in trên đầu cột, nên chưa biết đó là những ngày nào. Lịch đã lưu vẫn được giữ nguyên.');
    }
    const first = grid.firstDay, last = first + dayCount;
    progress.update('Đang đọc ca cho ' + (dayCount < days ? 'ngày ' + (first + 1) + '–' + last + ' (' + dayCount + ' ngày trong ảnh)' : days + ' ngày') + '…');
    result.cells = new Array(days).fill(null); result.raw = new Array(days).fill(null); const shifts = new Array(days).fill(null);
    // Each tile occupies a fixed OCR coordinate; empty days keep their original position.
    const tileW = 200, tileH = 100, columns = 4;
    const montage = Bitmap.createBitmap(tileW * columns, (((days + columns - 1) / columns) | 0) * tileH, ARGB_8888);
    const canvas = new Canvas(montage); canvas.drawColor(Color.WHITE);
    const processed = new Array(days).fill(null);
    for (let d = first; d < last; d++) { result.cells[d] = grid.cellFrom(d - first + 2, result.row, bitmap); processed[d] = grid.cell(d - first + 2, result.row); const big = GridVision.enlarge(processed[d], tileW, tileH); canvas.drawBitmap(big, (d % columns) * tileW, ((d / columns) | 0) * tileH, null); big.recycle(); }
    const recognition = await this._text(montage); result.raw.fill('');
    for (const block of recognition.getTextBlocks()) for (const line of block.getLines()) for (const element of line.getElements()) {
      const b = element.getBoundingBox(); if (b == null) continue;
      const d = ((b.centerY() / tileH) | 0) * columns + ((b.centerX() / tileW) | 0);
      if (d >= 0 && d < days) result.raw[d] += element.getText();
    }
    if (this._context != null && !this._cellReaderTried) { this._cellReaderTried = true; this._cellReader = await CellReader.open(this._context); }
    for (let d = first; d < last; d++) {
      const blank = GridVision.clearlyBlank(result.cells[d]);
      shifts[d] = OcrCodes.initialResult(result.raw[d], blank);
      // 3.0 (26/10): nothing read in the cell and not clearly blank (a darker or blurred re-shot photo) — the
      // cell reader answers OFF at its threshold before the slow re-reads (4–7 s a cell); any other answer, or
      // none, takes the usual way. Measured: 0 cells with a code read as OFF on 3,773 never-trained cells.
      if (shifts[d] == null && trim(result.raw[d]) === '' && this._cellReader != null) try { if ((await this._cellReader.read(result.cells[d])) === '') { shifts[d] = ''; result.raw[d] = 'bộ đọc ô: OFF'; continue; } } catch (unreadable) { /* the usual way */ }
      // 3.0: a one-letter code (H, P) from one montage reading can be half of the neighbouring "HC"/"P" when
      // the crop sits off the rules (25/10, Chu Văn Chinh day 4: "H" on an empty day). A second, separate
      // reading must agree; otherwise the cell goes to the voting below and may stay "?".
      let checked = false;
      if (shifts[d] != null && shifts[d].length === 1) {
        const second = (await this._text(GridVision.enlarge(GridVision.enhance(processed[d]), 420, 160))).getText(); checked = true;
        if (shifts[d] !== Schedule.normalizeShift(second)) shifts[d] = null; result.raw[d] += ' / ' + second;
      }
      if (shifts[d] == null && !checked) {
        progress.update('Đang kiểm tra kỹ ô ngày ' + (d + 1) + ' / ' + days + '…');
        const retry = (await this._text(GridVision.enlarge(GridVision.enhance(processed[d]), 420, 160))).getText();
        if (BuildConfig.DEBUG) Log.d('RosterTest', 'retry ' + (d + 1) + ': ' + retry);
        const normalized = Schedule.normalizeShift(retry); if (normalized != null) { shifts[d] = normalized; result.raw[d] = retry; }
      }
    }
    for (let d = first; d < last; d++) if (shifts[d] == null) {
      let variants = await this._readVariants(processed[d]);
      if (BuildConfig.DEBUG) Log.d('RosterTest', 'variants ' + (d + 1) + ': ' + arrayText(variants));
      shifts[d] = RosterReader.consensus(variants);
      if (shifts[d] == null) {
        const original = await this._readVariants(result.cells[d]);
        if (BuildConfig.DEBUG) Log.d('RosterTest', 'original variants ' + (d + 1) + ': ' + arrayText(original));
        variants = variants.concat(original);
        shifts[d] = RosterReader.consensus(variants);
      }
      result.raw[d] = variants.join(' / ');
    }
    // 3.0, phase 2: the cell reader answers what every OCR pass left unread (and, above, OFF where nothing was read).
    if (this._context != null) {
      if (this._cellReader != null) for (let d = 0; d < days; d++) if (shifts[d] == null && result.cells[d] != null) try { const code = await this._cellReader.read(result.cells[d]); if (code != null) { shifts[d] = code; result.raw[d] += ' / bộ đọc ô: ' + (code === '' ? 'OFF' : code); } } catch (unreadable) { /* stays ? */ }
    }
    for (const cell of processed) if (cell != null) cell.recycle(); montage.recycle(); result.schedule = new Schedule(month, ownerNumber, owner, shifts);
    if (dayCount < days) { const inPhoto = new Array(days).fill(false); for (let d = first; d < last; d++) inPhoto[d] = true; result.schedule.withPresence(inPhoto); }
    result.staff = staff; return result;
  }
  /** Which month day (0-based) the first of `count` day columns is, from the numbers printed in the header row
   *  (row 0, else row 1): each column read as a number votes for "first = number − column"; at least 3 columns
   *  and a third of them must agree, else −1 (the days are then not guessed). */
  async _firstDay(grid, count, days) {
    const tileW = 160, tileH = 100, columns = 4; let best = -1, bestVotes = 0;
    for (let row = 0; row < Math.min(2, grid.y.length - 1); row++) {
      const montage = Bitmap.createBitmap(tileW * columns, (((count + columns - 1) / columns) | 0) * tileH, ARGB_8888); const canvas = new Canvas(montage); canvas.drawColor(Color.WHITE);
      for (let c = 0; c < count; c++) { const cell = grid.cell(c + 2, row), big = GridVision.enlarge(cell, tileW, tileH); canvas.drawBitmap(big, (c % columns) * tileW, ((c / columns) | 0) * tileH, null); big.recycle(); cell.recycle(); }
      const read = new Array(count).fill(''); let text; try { text = await this._text(montage); } finally { montage.recycle(); }
      for (const block of text.getTextBlocks()) for (const line of block.getLines()) for (const element of line.getElements()) {
        const b = element.getBoundingBox(); if (b == null) continue; const c = ((b.centerY() / tileH) | 0) * columns + ((b.centerX() / tileW) | 0); if (c >= 0 && c < count) read[c] += element.getText();
      }
      const votes = new Int32Array(days + 1);
      for (let c = 0; c < count; c++) { const digits = read[c].replace(/[^0-9]/g, ''); if (digits === '' || digits.length > 2) continue; const start = parseInt(digits, 10) - c; if (start >= 1 && start + count - 1 <= days) votes[start]++; }
      if (BuildConfig.DEBUG) Log.d('RosterTest', 'header row ' + row + ': ' + arrayText(read));
      for (let day = 1; day <= days; day++) if (votes[day] > bestVotes) { bestVotes = votes[day]; best = day; }
    }
    return bestVotes >= Math.max(3, (count / 3) | 0) ? best - 1 : -1;
  }
  static consensus(variants) {
    // HashMap in Java: only read when it holds a single code, so its iteration order is never observable.
    const votes = new Map(), exact = new Map();
    for (const variant of variants) { const code = OcrCodes.workCandidate(variant); if (code == null) continue; votes.set(code, (votes.get(code) ?? 0) + 1); if (Schedule.normalizeShift(variant) != null) exact.set(code, (exact.get(code) ?? 0) + 1); }
    // Conflicting valid codes remain uncertain, even if one appears more often.
    if (votes.size !== 1) return null;
    const code = votes.keys().next().value; const count = votes.get(code);
    return count >= 2 && ((exact.get(code) ?? 0) > 0 || count >= 4) ? code : null;
  }
  async _readVariants(cell) {
    const tileW = 240, tileH = 100, columns = 4, count = 12;
    const sheet = Bitmap.createBitmap(tileW * columns, tileH * 3, ARGB_8888); const canvas = new Canvas(sheet); canvas.drawColor(Color.WHITE);
    for (let i = 0; i < count; i++) {
      const scan = GridVision.scanCell(cell, i % 4), scaled = GridVision.enlarge(scan, i < 4 ? 100 : i < 8 ? 150 : 190, i < 4 ? 52 : i < 8 ? 72 : 94);
      const anchor = new Paint(Paint.ANTI_ALIAS_FLAG); anchor.setColor(Color.BLACK); anchor.setTextSize(24); canvas.drawText('Ca', (i % columns) * tileW + 8, ((i / columns) | 0) * tileH + 58, anchor);
      canvas.drawBitmap(scaled, (i % columns) * tileW + 45, f(((i / columns) | 0) * tileH + f((tileH - scaled.getHeight()) / 2)), null); scan.recycle(); scaled.recycle();
    }
    const out = new Array(count).fill('');
    for (const block of (await this._text(sheet)).getTextBlocks()) for (const line of block.getLines()) for (const element of line.getElements()) {
      const b = element.getBoundingBox(); if (b == null) continue; const i = ((b.centerY() / tileH) | 0) * columns + ((b.centerX() / tileW) | 0);
      if (i >= 0 && i < count && !equalsIgnoreCase(element.getText(), 'Ca')) out[i] += element.getText();
    }
    sheet.recycle(); return out;
  }
  async _readColumn(grid, col, count, tileW, tileH) {
    const out = new Array(count).fill(''); const columns = 5, anchor = col === 0 ? 64 : 0, stride = tileW + anchor;
    const montage = Bitmap.createBitmap(stride * columns, (((count + columns - 1) / columns) | 0) * tileH, ARGB_8888);
    const c = new Canvas(montage); c.drawColor(Color.WHITE);
    const label = new Paint(Paint.ANTI_ALIAS_FLAG); label.setColor(Color.BLACK); label.setTextSize(20);
    for (let r = 0; r < count; r++) {
      const cell = grid.cell(col, r), big = GridVision.enlarge(cell, tileW, tileH); const left = (r % columns) * stride, top = ((r / columns) | 0) * tileH;
      // Upright words keep numeric-only montages from being read upside down. The anchor
      // occupies a separate region and can never become part of the returned STT.
      if (anchor > 0) c.drawText('Staff', left + 4, f(f(top + f(tileH / 2)) + 7), label);
      c.drawBitmap(big, left + anchor, top, null); big.recycle(); cell.recycle();
    }
    for (const block of (await this._text(montage)).getTextBlocks()) for (const line of block.getLines()) for (const element of line.getElements()) {
      const b = element.getBoundingBox(); if (b == null || b.centerX() % stride < anchor) continue; const r = ((b.centerY() / tileH) | 0) * columns + ((b.centerX() / stride) | 0); if (r >= 0 && r < count) out[r] += element.getText();
    }
    montage.recycle(); return out;
  }
  /** Name column of every row, ten rows per OCR sheet; words of one row are joined left to right. */
  async _readNames(grid, count) {
    const out = new Array(count).fill(''); const tileW = 900, tileH = 120, perSheet = 10;
    for (let first = 0; first < count; first += perSheet) {
      const n = Math.min(perSheet, count - first); const sheet = Bitmap.createBitmap(tileW, n * tileH, ARGB_8888); const c = new Canvas(sheet); c.drawColor(Color.WHITE);
      for (let i = 0; i < n; i++) { const cell = grid.cell(1, first + i), big = GridVision.enlarge(cell, tileW, tileH); c.drawBitmap(big, 0, i * tileH, null); big.recycle(); cell.recycle(); }
      const rows = []; for (let i = 0; i < n; i++) rows.push([]);
      for (const block of (await this._text(sheet)).getTextBlocks()) for (const line of block.getLines()) for (const element of line.getElements()) { const b = element.getBoundingBox(); if (b == null) continue; const i = (b.centerY() / tileH) | 0; if (i >= 0 && i < n) rows[i].push(element); }
      for (let i = 0; i < n; i++) { const words = rows[i]; words.sort((a, b) => a.getBoundingBox().left - b.getBoundingBox().left); let joined = ''; for (const w of words) { if (joined.length > 0) joined += ' '; joined += w.getText(); } out[first + i] = joined; }
      sheet.recycle();
    }
    if (BuildConfig.DEBUG) Log.d('RosterTest', 'names=' + arrayText(out));
    if (!this._vietOcrTried && this._context != null) { this._vietOcrTried = true; this._vietOcr = await NameReader.open(this._context); }
    this.lastNameReadings = new Array(count).fill(null);
    if (this._vietOcr != null) {
      const second = new Array(count).fill(null).map(() => []);
      for (let r = 0; r < count; r++) {
        const cell = grid.cell(1, r); try { second[r] = await this._vietOcr.readViews(cell); } catch (unreadable) { second[r] = []; } finally { cell.recycle(); }
        const ml = out[r]; out[r] = NameReader.pick(out[r], second[r], Personnel.current());
        this.lastNameReadings[r] = [ml, ...second[r], out[r]];
      }
      if (BuildConfig.DEBUG) Log.d('RosterTest', 'vietocr=' + arrayText(second) + ' picked=' + arrayText(out));
    }
    return out;
  }
  close() { this._dropCache(); this._recognizer.close(); if (this._vietOcr != null) this._vietOcr.close(); if (this._cellReader != null) this._cellReader.close(); }
}
