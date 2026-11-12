// Port of vn.lichdilam.PipeBook (APK 4.5).
// Java → JS: List → array; TreeMap/TreeSet → JavaTreeMap/JavaTreeSet; LinkedHashMap<String,…> → Map.
// Package-private fields whose name is also a public method get a leading underscore:
// PipeBook._sheets/_openColumns/_primaryPage/_sourceImages/_primaryIndex, Employee._ocrName, DayColumn._page/_low/_high.
import { IllegalArgumentException, ArrayIndexOutOfBoundsException, NumberFormatException, JavaTreeMap, JavaTreeSet, JavaHashMap, Objects, Integer, trim, split } from '../platform/java.js';
import { JSONObject, JSONArray, JSONException } from '../platform/json.js';
import { YearMonth } from '../platform/time.js';
import { Schedule } from './Schedule.js';
import { PipeDay } from './PipeDay.js';
import { PipeRules } from './PipeRules.js';
import { ShiftChange } from './ShiftChange.js';
import { ConfirmedNames } from './ConfirmedNames.js';
import { Personnel } from './Personnel.js';

/** Map.get / isEmpty / getOrDefault for a JS Map or a Java-style map (JavaHashMap, JavaTreeMap). */
const mapGet = (m, k) => { const v = m.get(k); return v === undefined ? null : v; };
const mapIsEmpty = m => (m instanceof Map ? m.size === 0 : m.isEmpty());
const removeFirst = (list, x) => { const i = list.indexOf(x); if (i >= 0) { list.splice(i, 1); return true; } return false; };
const EMPTY_SET = Object.freeze({ contains: () => false });

function personKey(name) { return trim(Schedule.normalizePerson(name).toLowerCase().replace(/[^\p{L} \t\n\x0B\f\r]/gu, '').replace(/[ \t\n\x0B\f\r]+/g, ' ')); }
function matchKey(name) { let key = ''; for (const part of split(personKey(name), /[ \t\n\x0B\f\r]+/)) { const word = Schedule.normalizeName(part); if (word !== '') { if (key.length > 0) key += ' '; key += word; } } return key; }
function compatibleAccents(input, actual) {
  const a = split(personKey(input), / /); let b = split(personKey(actual), / /);
  if (a.length < b.length) b = b.slice(b.length - a.length, b.length); if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== Schedule.normalizeName(a[i]) && b[i] !== Schedule.normalizeName(b[i]) && a[i] !== b[i]) return false;
  return true;
}
function matchesName(input, actual) {
  // A=B=C=D through the staff list first; the printed-name rules below remain for people not on it.
  const staff = Personnel.current();
  if (!staff.isEmpty()) { const person = staff.unique(actual, Personnel.Source.PRINTED); let meant = staff.resolve(input, Personnel.Source.TYPED);
    if (meant.length === 0) meant = staff.resolve(input, Personnel.Source.PRINTED);
    if (person != null && meant.length !== 0) return meant.includes(person); }
  const key = matchKey(input), full = matchKey(actual); return key !== '' && compatibleAccents(input, actual) && (key === full || full.endsWith(' ' + key) || PipeBook.matchesPrintedAbbreviation(input, actual) || PipeBook.matchesPrintedAbbreviation(actual, input));
}
function edits(a, b) {
  const row = new Int32Array(b.length + 1); for (let j = 0; j <= b.length; j++) row[j] = j;
  for (let i = 1; i <= a.length; i++) { let prev = row[0]; row[0] = i; for (let j = 1; j <= b.length; j++) { const temp = row[j]; row[j] = Math.min(Math.min(row[j] + 1, row[j - 1] + 1), prev + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1)); prev = temp; } }
  return row[b.length];
}
const nullable = value => (value == null ? JSONObject.NULL : value);
const value = (o, key) => (o.isNull(key) ? null : o.getString(key));

class Employee {
  constructor(number, name, evidence) {
    this.number = number; this.name = name; this.identityEvidence = evidence;
    this.days = new JavaTreeMap();
    /** The name exactly as OCR read it on the photo; differs from name once the user corrected it. */
    this._ocrName = name;
  }
  ocrName() { return this._ocrName; }
  key() { return this.number + ':' + personKey(this.name); }
}
/** A printed day column of one photo whose date number could not be confirmed. Its cells are read and
 *  kept here, never dropped and never placed on a date until the date is certain: confirmed by OCR,
 *  forced by the order of the neighbouring printed dates, or chosen by the user. */
class DayColumn {
  constructor(start, end, headerRow, structured, readings, evidence) {
    this.start = start; this.end = end; this.headerRow = headerRow; this.structured = structured; this.readings = [...readings]; this.evidence = evidence == null ? '' : evidence;
    /** Printed employee name on that photo → the cells read in this column. */
    this.values = new Map();
    this._page = -1; this._low = 1; this._high = 31; this.crowded = false;
  }
  page() { return this._page; }
  /** First and last date this column can be, from the confirmed dates printed around it. */
  low() { return this._low; }
  high() { return this._high; }
  possible(day) { return day >= this._low && day <= this._high; }
  days() { const d = []; for (let i = this._low; i <= this._high; i++) d.push(i); return d; }
  id() { return this._page + ':' + this.start + '-' + this.end; }
  valueFor(name) { for (const [k, v] of this.values) if (personKey(k) === personKey(name) || matchKey(k) === matchKey(name) && compatibleAccents(name, k)) return v; return null; }
  copy(page) { const c = new DayColumn(this.start, this.end, this.headerRow, this.structured, this.readings, this.evidence); for (const [k, v] of this.values) c.values.set(k, v); c._page = page; c._low = this._low; c._high = this._high; c.crowded = this.crowded; return c; }
}
/** 3.1 (the user): the rows one source photo printed, kept so the app can show that photo's own pipe
 *  table — a row per date, a column per pipe, the people's names in the cells. Only the printed name and
 *  the pipe of each date are kept; the reading detail stays in the merged book and is not duplicated. */
class Sheet {
  constructor() {
    /** Printed (OCR) name of every row, in the order of the photo. */
    this.rows = [];
    /** Same order: date → pipe. "" is a day with no pipe (off); a date that is absent was not read. */
    this.pipes = [];
  }
  static of(page) {
    const sheet = new Sheet();
    for (const e of page.employees) {
      const days = new JavaTreeMap();
      for (const [day, v] of e.days) if (!v.conflict && v.pipe != null) days.put(day, v.pipe);
      sheet.rows.push(e._ocrName); sheet.pipes.push(days);
    }
    return sheet;
  }
}

/** Source roster retained for lookup after import, independently from personal calendar edits. */
export class PipeBook {
  static Employee = Employee;
  static DayColumn = DayColumn;
  static Sheet = Sheet;
  constructor(month) {
    this.month = month;
    this.employees = [];
    this._sheets = [];
    /** Page books only: grid columns of every confirmed date ({start,end,day}). */
    this.layout = [];
    this._openColumns = [];
    /** Page books only: first and last date of the period printed in the photo's title (0 = not read). */
    this.printedFrom = 0; this.printedTo = 0;
    this._primaryPage = null;
    this._sourceImages = [];
    this._primaryIndex = -1;
    this._confirmedOwnerDays = new JavaTreeMap();
  }
  /** One entry per source photo, in the order the photos were added. Empty for a book saved before 3.1:
   *  re-reading the photos ("Cập nhật OCR từ ảnh đã lưu") fills it again. */
  sheets() { return Object.freeze([...this._sheets]); }
  /** The person shown for a row of a sheet: the name the user or the staff list confirmed, else what was printed. */
  sheetName(printed) {
    if (printed == null || trim(printed) === '') return '';
    for (const e of this.employees) if (ConfirmedNames.key(e._ocrName) === ConfirmedNames.key(printed)) return e.name;
    return printed;
  }
  /** Open columns of every photo of the set (each with its photo index). */
  openColumns() { return Object.freeze([...this._openColumns]); }
  /** Open columns of the photo that holds the owner's row. */
  ownerOpenColumns() { const r = []; for (const c of this._openColumns) if (!this.hasPrimary() || c._page === this._primaryIndex) r.push(c); return r; }
  /** The open column of the owner's photo that may hold this date, if any. */
  ownerOpenColumn(day) { for (const c of this.ownerOpenColumns()) if (c.possible(day)) return c; return null; }
  _previousDay(column) { let best = this.printedFrom > 0 ? this.printedFrom - 1 : 0; for (const g of this.layout) if (g[1] <= column) best = Math.max(best, g[2]); return best; }
  _nextDay(column) { let best = this.printedTo > 0 ? this.printedTo + 1 : this.month.lengthOfMonth() + 1; for (const g of this.layout) if (g[0] >= column) best = Math.min(best, g[2]); return best; }
  /** Page books: recompute each open column's possible dates from the confirmed dates printed around it,
   *  and place columns whose date is forced (k unread columns between two printed dates with exactly k
   *  dates left between them). A run containing a column of unknown structure is never forced. */
  settleColumns() {
    const maxDay = this.month.lengthOfMonth(); let placed = true; const open = this._openColumns;
    while (placed) {
      placed = false; open.sort((a, b) => Integer.compare(a.start, b.start));
      for (let i = 0; i < open.length && !placed;) {
        const prev = this._previousDay(open[i].start), next = this._nextDay(open[i].end); let j = i;
        while (j < open.length && this._previousDay(open[j].start) === prev && this._nextDay(open[j].end) === next) j++;
        const run = open.slice(i, j); let structured = true; for (const c of run) structured = structured && c.structured;
        const k = run.length, free = next - prev - 1;
        for (let n = 0; n < k; n++) {
          const c = run[n];
          c._low = structured ? prev + 1 + n : prev + 1; c._high = structured ? next - 1 - (k - 1 - n) : next - 1; c.crowded = structured && free < k;
          if (c._low > c._high) { c._low = prev + 1; c._high = next - 1; } c._low = Math.max(1, c._low); c._high = Math.min(maxDay, c._high);
        }
        if (structured && k === free && k > 0) { for (let n = 0; n < k; n++) this._place(run[n], prev + 1 + n); placed = true; }
        // Beyond the last printed date of the sheet (or before the first) there is no date left: such a
        // column cannot hold anything of this month (page border, notes column) and is not kept.
        else if (free <= 0 && (prev >= (this.printedTo > 0 ? this.printedTo : maxDay) || next <= (this.printedFrom > 0 ? this.printedFrom : 1))) { const keep = open.filter(c => !run.includes(c)); open.length = 0; open.push(...keep); placed = true; }
        i = j;
      }
    }
  }
  _place(c, day) {
    for (const [name, v] of c.values) for (const e of this.employees) if (e.name === name || e._ocrName === name) { e.days.put(day, PipeDay.merge(e.days.get(day), v)); break; }
    this.layout.push([c.start, c.end, day]); removeFirst(this._openColumns, c);
  }
  /** Page books: the user read the date printed above an open column. Only a date that keeps the printed
   *  dates in order is accepted; the column's cells then belong to that date. */
  chooseColumnDay(start, end, day) {
    let found = null; for (const c of this._openColumns) if (c.start === start && c.end === end) found = c;
    if (found == null) throw new IllegalArgumentException('Cột này đã được xác định hoặc ảnh đã được đọc lại. Hãy mở lại lịch.');
    if (!found.possible(day)) throw new IllegalArgumentException('Ngày ' + day + ' không nằm giữa các ngày in hai bên cột này (' + found._low + '–' + found._high + ').');
    this._place(found, day); this.settleColumns();
  }
  /** Applies the names the user corrected for what OCR read on a photo ("Misi Huy" → "Minh Huy"), keyed by
   *  ConfirmedNames.key of the OCR name. Days, evidence and the OCR spelling are kept; applying twice is harmless. */
  /** Rows whose printed name means exactly one person on the staff list show that person's full name; the
   *  printed form stays in ocrName. The user's own corrections (PrintedNames) are applied afterwards and win. */
  applyStaffList(staff) {
    if (staff.isEmpty()) return; const fixes = new JavaHashMap();
    for (const e of this.employees) { const p = staff.unique(e._ocrName, Personnel.Source.PRINTED); if (p != null && p.name !== e.name) fixes.put(ConfirmedNames.key(e._ocrName), p.name); }
    this.correctNames(fixes);
  }
  /** The row printed with this STT on the photo (the sheet's own numbering), else the one person on the sheet
   *  whose work-roster STT it is; null when neither is unique. */
  findByNumber(number) {
    const own = []; for (const e of this.employees) if (number > 0 && e.number === number) own.push(e);
    if (own.length === 1) return own[0]; if (own.length > 1) return null;
    const p = Personnel.current().byStt(number); if (p == null) return null;
    let found = null; for (const e of this.employees) if (Personnel.current().unique(e._ocrName, Personnel.Source.PRINTED) === p) { if (found != null) return null; found = e; }
    return found;
  }
  /** corrections: ConfirmedNames.key of the OCR name → corrected name (a JS Map or a Java-style map). */
  correctNames(corrections) {
    if (mapIsEmpty(corrections)) return; const renamedKeys = new JavaHashMap(), renamedNames = new JavaHashMap();
    for (let i = 0; i < this.employees.length; i++) {
      const e = this.employees[i]; const fixed = mapGet(corrections, ConfirmedNames.key(e._ocrName));
      if (fixed == null || fixed === e.name) continue; const n = new Employee(e.number, fixed, e.identityEvidence); n._ocrName = e._ocrName; n.days.putAll(e.days);
      renamedKeys.put(e.key(), n.key()); renamedNames.put(e.name, fixed); this.employees[i] = n;
    }
    for (const c of this._openColumns) { const copy = new Map(); for (const [k, v] of c.values) { const fixed = mapGet(corrections, ConfirmedNames.key(k)); copy.set(fixed != null ? fixed : renamedNames.getOrDefault(k, k), v); } c.values.clear(); for (const [k, v] of copy) c.values.set(k, v); }
    const confirmed = new JavaTreeMap(); for (const [k, v] of this._confirmedOwnerDays) confirmed.put(renamedKeys.getOrDefault(k, k), v); this._confirmedOwnerDays.clear(); this._confirmedOwnerDays.putAll(confirmed);
    if (this._primaryPage != null) this._primaryPage.correctNames(corrections);
  }
  hasPrimary() { return this._primaryPage != null; }
  /** The page of the primary photo as read, or null (audit: re-merging the pages of separate scans). */
  primaryPage() { return this._primaryPage; }
  primaryIndex() { return this._primaryIndex; }
  sourceImages() { return Object.freeze([...this._sourceImages]); }
  /** The owner's calendar is read only from the selected page; swaps search all pages. */
  owner(name) { return (this.hasPrimary() ? this._primaryPage : this).findByName(name); }
  /** The owner's row on the selected page by the STT printed there (or the work-roster STT of a person on it). */
  ownerByNumber(number) { const e = (this.hasPrimary() ? this._primaryPage : this).findByNumber(number); if (e == null) throw new IllegalArgumentException('Chưa thấy STT ' + number + ' trên ảnh phân ống chính. Nhập họ tên để tìm theo tên.'); return e; }
  ownerRows() { return Object.freeze([...(this.hasPrimary() ? this._primaryPage : this).employees]); }
  /** Days where a pipe row and the work roster both have a code, and how many of them agree (OFF and P agree). */
  static agreement(row, work) {
    let compared = 0, agree = 0;
    for (const [day, v] of row.days) {
      const d = day - 1; const code = v.code;
      if (code == null || v.conflict || d < 0 || d >= work.shifts.length || !work.present[d] || work.shifts[d] == null) continue; compared++;
      if (code === work.shifts[d] || Schedule.dayOff(code) && Schedule.dayOff(work.shifts[d])) agree++;
    }
    return [compared, agree];
  }
  /** The owner's pipe row against the owner's work roster. When the row printed just above or below agrees clearly
   *  better, the photo's rows may be shifted against the names (3.0, phase 2). Only a warning: rows never move. */
  rowShiftWarning(owner, work) {
    if (owner == null || work == null) return null; const rows = this.ownerRows(); const at = rows.indexOf(owner); if (at < 0) return null;
    const own = PipeBook.agreement(owner, work); if (own[0] < 4 || own[1] * 10 >= own[0] * 6) return null;
    for (const step of [-1, 1]) {
      const n = at + step; if (n < 0 || n >= rows.length) continue; const other = PipeBook.agreement(rows[n], work);
      if (other[0] >= 4 && other[1] * 10 >= other[0] * 9 && other[1] >= own[1] + 3)
        return 'Hàng ' + owner.name + ' trên ảnh phân ống chỉ khớp lịch đi làm ' + own[1] + '/' + own[0] + ' ngày, còn hàng ngay ' + (step < 0 ? 'trên' : 'dưới') + ' (' + rows[n].name + ') khớp ' + other[1] + '/' + other[0] + ' ngày. Hàng có thể bị lệch so với tên. App vẫn ghép theo tên và để Khác Ca ở ngày không khớp; hãy đối chiếu ảnh.';
    }
    return null;
  }
  hasOwnerCorrection(name, day) { return this.hasPrimary() && this._confirmedOwnerDays.getOrDefault(this.owner(name).key(), EMPTY_SET).contains(day); }
  confirmOwnerDay(name, day, value) {
    if (!this.hasPrimary()) return; const e = this.owner(name); if (!e.days.containsKey(day)) throw new IllegalArgumentException('Ảnh phân ống chính không có ngày này.');
    const original = e.days.get(day); e.days.put(day, new PipeDay(value.code, value.pipe, value.duty, original.raw, original.evidence)); this._confirmedOwnerDays.computeIfAbsent(e.key(), () => new JavaTreeSet()).add(day);
  }
  confirmManualOwnerDay(name, day, value) {
    if (!this.hasPrimary()) return; if (day < 1 || day > this.month.lengthOfMonth()) throw new IllegalArgumentException('Ngày không tồn tại.'); const e = this.owner(name);
    if (e.days.containsKey(day)) { this.confirmOwnerDay(name, day, value); return; }
    e.days.put(day, value); this._confirmedOwnerDays.computeIfAbsent(e.key(), () => new JavaTreeSet()).add(day);
  }
  removeOwnerDayCorrection(name, day) { const e = this.owner(name); e.days.remove(day); const days = this._confirmedOwnerDays.get(e.key()); if (days != null) days.remove(day); }
  static fromPages(pages, paths, primary) {
    if (pages.length === 0 || pages.length > 3 || paths.length !== pages.length || primary < 0 || primary >= pages.length) throw new IllegalArgumentException('Chọn đúng một ảnh phân ống chính.');
    let merged = new PipeBook(pages[primary].month);
    for (const page of pages) { if (!page.month.equals(merged.month)) throw new IllegalArgumentException('Các ảnh phải cùng tháng.'); merged = PipeBook.overlay(merged, page); }
    merged._primaryPage = pages[primary]; merged._primaryIndex = primary; merged._sourceImages.push(...paths);
    for (const page of pages) merged._sheets.push(Sheet.of(page));
    for (let i = 0; i < pages.length; i++) for (const c of pages[i]._openColumns) merged._openColumns.push(c.copy(i));
    return merged;
  }
  /** Apply only explicit, user-confirmed printed-text corrections to retained OCR evidence. */
  applyConfirmedPrintedAliases() {
    for (const employee of this.employees) for (const day of employee.days.keySet()) employee.days.put(day, PipeRules.confirmedPrintedDay(employee.days.get(day)));
    for (const column of this._openColumns) for (const [name, v] of column.values) column.values.set(name, PipeRules.confirmedPrintedDay(v));
    if (this._primaryPage != null) this._primaryPage.applyConfirmedPrintedAliases();
  }
  /** 26/10 (the user: no notice or warning while importing): the user's own row when the photo could not be read or
   *  holds no row of theirs. Every working day of their saved roster is unknown — shown "?" — and the rest of
   *  what was read stays for swaps. Added to the page that is matched with the work roster. */
  unreadOwner(work) {
    const page = this.hasPrimary() ? this._primaryPage : this; const e = page.add(work.employeeNumber, work.employeeName, '');
    for (let d = 0; d < work.shifts.length && d < this.month.lengthOfMonth(); d++) {
      const s = work.shifts[d];
      if (s != null && s !== '' && s !== 'P' && !e.days.containsKey(d + 1)) e.days.put(d + 1, new PipeDay(null, null, null, 'chưa đọc được ảnh', ''));
    }
    return e;
  }
  add(number, name, evidence) {
    for (const e of this.employees) if (e.number === number && personKey(e.name) === personKey(name)) return e;
    const employee = new Employee(number, name, evidence); this.employees.push(employee); return employee;
  }
  find(number, name) {
    let match = null; for (const e of this.employees) if (e.number === number && matchesName(name, e.name)) {
      if (match != null) throw new IllegalArgumentException('Có nhiều người trùng STT/tên. Nhập tên đầy đủ đúng như trên ảnh Lịch ống.'); match = e;
    }
    if (match == null) throw new IllegalArgumentException('Chưa tìm đúng STT ' + number + ' và tên ' + name + ' trong ảnh Lịch ống. Kiểm tra STT của lịch 2 và thêm đủ ảnh.');
    return match;
  }
  findByName(name) {
    const matches = this.search(name);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) { let names = ''; for (const e of matches) names += '\n• ' + e.name; throw new IllegalArgumentException('Tên chưa xác định duy nhất một hàng. Nhập đầy đủ họ tên đúng trên ảnh:' + names); }
    throw new IllegalArgumentException('Chưa đọc được đúng tên ' + name + '. Kiểm tra tên trên ảnh và dùng ảnh rõ, đủ hàng nhân viên.');
  }
  search(name) {
    if (matchKey(name) === '') throw new IllegalArgumentException('Nhập tên hoặc họ tên người đổi ca.');
    const matches = []; for (const e of this.employees) if (matchesName(name, e.name)) matches.push(e);
    return matches;
  }
  /** Rows whose printed name is one or two letters away from the typed name (OCR misreads such as
   *  "Mish Huy" for "Misi Huy"). Only offered for the user to confirm; never used automatically. */
  similar(name) {
    const query = matchKey(name); const result = []; if (query.length < 3) return result;
    const words = split(query, / /); let limit = Math.max(1, Math.trunc(query.length / 6));
    // One short given name that differs by a letter is usually another person (Tuấn / Luân);
    // for those only an accent-only difference (an OCR mark on the printed name) is offered.
    if (words.length === 1 && query.length < 6) limit = 0; const distance = new Map();
    for (const e of this.employees) {
      const full = matchKey(e.name); if (full === '' || matchesName(name, e.name)) continue; const parts = split(full, / /);
      let best = edits(query, full);
      if (words.length <= parts.length) { const tail = parts.slice(parts.length - words.length, parts.length).join(' '); best = Math.min(best, edits(query, tail)); }
      // Called only when the exact search found nobody: distance 0 here means the accents disagree.
      if (best <= limit) { distance.set(e, best); result.push(e); continue; }
      // Two or more words whose given name is printed identically: a middle or family word damaged on the
      // paper ("Minh Huy" printed with a smudge, read "Misi Huy") is offered if it keeps its first letter
      // and length and differs in at most two letters. Only offered; the user decides.
      if (words.length >= 2 && words.length <= parts.length) {
        const tail = parts.slice(parts.length - words.length, parts.length);
        let close = tail[tail.length - 1] === words[words.length - 1]; let sum = 0;
        for (let i = 0; close && i < words.length - 1; i++) { const d = edits(words[i], tail[i]); close = d <= 2 && tail[i].length === words[i].length && tail[i].charAt(0) === words[i].charAt(0); sum += d; }
        if (close) { distance.set(e, limit + sum); result.push(e); }
      }
    }
    result.sort((a, b) => Integer.compare(distance.get(a), distance.get(b))); return result.length > 5 ? result.slice(0, 5) : result;
  }
  byKey(key) {
    let found = null; for (const e of this.employees) if (e.key() === key) {
      if (found != null) throw new IllegalArgumentException('Hàng nhân viên bị trùng; cần đối chiếu dữ liệu nguồn.');
      found = e;
    }
    if (found == null) throw new IllegalArgumentException('Dữ liệu người đã chọn đã thay đổi. Hãy tìm và xác nhận lại.');
    return found;
  }
  static matchesPrintedAbbreviation(input, printed) {
    const full = split(Schedule.normalizePerson(input), /[ \t\n\x0B\f\r]+/), shortened = split(Schedule.normalizePerson(printed).replace(/\.(?=[^ \t\n\x0B\f\r])/g, '. '), /[ \t\n\x0B\f\r]+/);
    if (full.length !== shortened.length || full.length < 3) return false; let exact = 0; let abbreviation = false;
    for (let i = 0; i < full.length; i++) {
      const a = Schedule.normalizeName(full[i]), b = Schedule.normalizeName(shortened[i]); if (a === '' || b === '') return false;
      if (a === b) { exact++; continue; } if (i === full.length - 1 || !shortened[i].endsWith('.') || !a.startsWith(b)) return false; abbreviation = true;
    } return abbreviation && exact >= 2;
  }
  addByName(number, name, evidence) { const same = []; for (const e of this.employees) if (matchKey(e.name) === matchKey(name) && compatibleAccents(name, e.name) && (number === 0 || e.number === 0 || number === e.number)) same.push(e); return same.length === 1 ? same[0] : this.add(number, name, evidence); }
  resolve(request) {
    if (!YearMonth.from(request.date).equals(this.month)) throw new IllegalArgumentException('Ảnh Lịch ống không thuộc tháng đổi ca.');
    const person = request.personKey !== '' ? this.byKey(request.personKey) : request.personNumber > 0 ? this.find(request.personNumber, request.person) : this.findByName(request.person); const day = person.days.get(request.date.getDayOfMonth());
    // 3.0 (26/10, the user): an auto swap never stops on a source cell it cannot confirm. The swap is recorded
    // (person and date); a code or pipe the photos do not confirm stays empty and the calendar shows "?", and
    // photos that disagree for that person and day, or a word printed instead of a code (the person works
    // another roster that day), show "Khác Ca" (UnifiedSchedule.combine).
    const other = day != null && (day.conflict || PipeRules.printedWord(day.code)), known = day != null && !other && day.code != null;
    const code = request.code != null ? request.code : known ? day.code : null; let pipe = known ? day.pipe : null, duty = known ? day.duty : null;
    // A code given for the swap that the photo does not show: that code is kept, the photo's pipe is not.
    if (request.code != null && known && request.code !== day.code) { pipe = null; duty = null; }
    if (request.confirmedPipe || request.manualAssignment) { pipe = request.pipe; duty = request.duty; }
    if (request.personKey !== '' && request.updatesPipe &&
      (!Objects.equals(request.pipe, pipe) || !Objects.equals(request.duty, duty)))
      throw new IllegalArgumentException('Phân ống đã thay đổi sau khi xác nhận. Hãy tìm và xác nhận lại người đổi ca.');
    const resolved = new ShiftChange(request.date, code, person.name, person.number, pipe, duty, true, request.confirmedPipe, true).forPerson(request.personKey).withFullName(request.fullName);
    return request.manualAssignment ? resolved.withManualAssignment() : resolved;
  }
  personal(number, name, work) {
    const e = this.find(number, name); const count = this.month.lengthOfMonth(); const codes = new Array(count).fill(null), pipes = new Array(count).fill(null), duties = new Array(count).fill(null);
    for (let d = 0; d < count; d++) {
      const entry = e.days.get(d + 1);
      if (entry != null) { codes[d] = entry.code; pipes[d] = entry.pipe; duties[d] = entry.duty; }
      else if (work != null && work.month.equals(this.month) && Schedule.lookupNameMatches(name, work.employeeName)) {
        const existing = work.shifts[d]; if (existing === '' || existing === 'P') { codes[d] = existing; pipes[d] = ''; duties[d] = ''; }
      }
    }
    const present = new Array(count).fill(false); for (const day of e.days.keySet()) { if (day - 1 < 0 || day - 1 >= count) throw new ArrayIndexOutOfBoundsException('Index ' + (day - 1) + ' out of bounds for length ' + count); present[day - 1] = true; }
    // A printed column whose date is still open may be any of these dates: they are unknown (?), not empty.
    for (const c of this._openColumns) for (let day = c._low; day <= c._high; day++) if (day >= 1 && day <= count && !e.days.containsKey(day)) { present[day - 1] = true; codes[day - 1] = null; pipes[day - 1] = null; duties[day - 1] = null; }
    return new Schedule(Schedule.PIPE, this.month, number, e.name, codes, new Array(count).fill(null), new Array(count).fill(0), pipes, duties).withPresence(present);
  }
  _openDay(day) { for (const c of this._openColumns) if (c.possible(day)) return true; return false; }
  personalByName(name, work) {
    if (this.hasPrimary()) return this._primaryPage.personalByName(name, work);
    const e = this.findByName(name); const result = this.personal(e.number, e.name, work);
    // A unique printed abbreviation may identify the existing full-name owner.
    // Keep the source spelling in the book, while the personal calendars share
    // the confirmed full name. Never combine a different person's calendar.
    const owner = work == null ? [] : this.search(work.employeeName);
    if (work != null && work.month.equals(this.month) && owner.length === 1 && owner[0] === e) {
      for (let d = 0; d < result.shifts.length; d++) if (!e.days.containsKey(d + 1) && !this._openDay(d + 1) && (work.shifts[d] === '' || work.shifts[d] === 'P')) { result.shifts[d] = work.shifts[d]; result.pipes[d] = ''; result.duties[d] = ''; }
      return new Schedule(Schedule.PIPE, this.month, work.employeeNumber, work.employeeName, result.shifts, result.swapPeople, result.swapNumbers, result.pipes, result.duties).withPresence(result.present);
    }
    return result;
  }
  static overlay(older, incoming) {
    // An explicitly selected set replaces the old imported set. Re-merging
    // old OCR here would resurrect conflicts from a removed auxiliary photo.
    if (incoming.hasPrimary()) {
      if (older != null && older.hasPrimary() && older.month.equals(incoming.month) && older._sourceImages[older._primaryIndex] === incoming._sourceImages[incoming._primaryIndex]) {
        for (const [key, days] of older._confirmedOwnerDays) try {
          const old = older._primaryPage.byKey(key), fresh = incoming._primaryPage.byKey(key);
          for (const day of days) if (old.days.containsKey(day)) { fresh.days.put(day, old.days.get(day)); incoming._confirmedOwnerDays.computeIfAbsent(key, () => new JavaTreeSet()).add(day); }
        } catch (changedIdentity) { if (!(changedIdentity instanceof IllegalArgumentException)) throw changedIdentity; /* Never transfer a correction to a different row. */ }
      }
      return incoming;
    }
    if (older != null && older.hasPrimary()) throw new IllegalArgumentException('Chọn lại ảnh phân ống chính trước khi thay bộ ảnh đã lưu.');
    if (older == null || !older.month.equals(incoming.month)) return incoming;
    const result = new PipeBook(incoming.month);
    for (const e of older.employees) result.add(e.number, e.name, e.identityEvidence).days.putAll(e.days);
    for (const e of incoming.employees) {
      let previous = null; const candidates = []; for (const p of result.employees) if (matchKey(p.name) === matchKey(e.name) && compatibleAccents(p.name, e.name) && (e.number === 0 || p.number === 0 || e.number === p.number)) candidates.push(p); if (candidates.length === 1) previous = candidates[0];
      const days = new JavaTreeMap(); if (previous != null) { days.putAll(previous.days); removeFirst(result.employees, previous); } for (const [day, v] of e.days) days.put(day, PipeDay.merge(days.get(day), v));
      // Keep existing accented identity when the new OCR loses diacritics.
      const keptName = previous != null && personKey(previous.name) !== matchKey(previous.name) && personKey(e.name) === matchKey(e.name) ? previous.name : e.name;
      result.add(e.number === 0 && previous != null ? previous.number : e.number, keptName, e.identityEvidence).days.putAll(days);
    } return result;
  }
  toJson() {
    const root = new JSONObject(); root.put('month', this.month.toString()); const people = new JSONArray();
    for (const e of this.employees) {
      const person = new JSONObject(); person.put('number', e.number); person.put('name', e.name); person.put('evidence', e.identityEvidence); if (e._ocrName !== e.name) person.put('ocr', e._ocrName); const days = new JSONArray();
      for (const [day, v] of e.days) { const d = new JSONObject(); d.put('day', day); d.put('code', nullable(v.code)); d.put('pipe', nullable(v.pipe)); d.put('duty', nullable(v.duty)); d.put('raw', v.raw); d.put('evidence', v.evidence); d.put('conflict', v.conflict); if (v.options.length !== 0) { const options = new JSONArray(); for (const o of v.options) options.put(new JSONObject().put('code', nullable(o.code)).put('pipe', nullable(o.pipe)).put('duty', nullable(o.duty)).put('raw', o.raw).put('evidence', o.evidence)); d.put('options', options); } days.put(d); } person.put('days', days); people.put(person);
    } root.put('employees', people); if (this.layout.length !== 0 || this._openColumns.length !== 0 || this.printedFrom > 0) this._columnsToJson(root);
    if (this._sheets.length !== 0) root.put('sheets', this._sheetsToJson());
    if (this.hasPrimary()) { root.put('primaryPage', new JSONObject(this._primaryPage.toJson())); root.put('primaryIndex', this._primaryIndex); root.put('sourceImages', new JSONArray(this._sourceImages)); const confirmed = new JSONObject(); for (const [key, days] of this._confirmedOwnerDays) confirmed.put(key, new JSONArray(days.toArray())); root.put('confirmedOwnerDays', confirmed); }
    return root.toString();
  }
  static range(c) { return c._low === c._high ? String(c._low) : c._low + '–' + c._high; }
  static _dayJson(v) {
    const d = new JSONObject(); d.put('code', nullable(v.code)); d.put('pipe', nullable(v.pipe)); d.put('duty', nullable(v.duty)); d.put('raw', v.raw); d.put('evidence', v.evidence); d.put('conflict', v.conflict);
    if (v.options.length !== 0) { const options = new JSONArray(); for (const o of v.options) options.put(new JSONObject().put('code', nullable(o.code)).put('pipe', nullable(o.pipe)).put('duty', nullable(o.duty)).put('raw', o.raw).put('evidence', o.evidence)); d.put('options', options); }
    return d;
  }
  static _dayFromJson(d) {
    const options = []; const o = d.optJSONArray('options'); if (o != null) for (let k = 0; k < o.length(); k++) { const v = o.getJSONObject(k); options.push(new PipeDay(value(v, 'code'), value(v, 'pipe'), value(v, 'duty'), v.optString('raw', ''), v.optString('evidence', ''))); }
    return new PipeDay(value(d, 'code'), value(d, 'pipe'), value(d, 'duty'), d.optString('raw', ''), d.optString('evidence', ''), d.optBoolean('conflict', d.optString('raw', '').startsWith('Ảnh trùng ngày')), options);
  }
  _columnsToJson(root) {
    const groups = new JSONArray(); for (const g of this.layout) groups.put(new JSONArray().put(g[0]).put(g[1]).put(g[2])); root.put('layout', groups);
    const open = new JSONArray(); for (const c of this._openColumns) {
      const o = new JSONObject().put('start', c.start).put('end', c.end).put('headerRow', c.headerRow).put('structured', c.structured).put('readings', new JSONArray(c.readings)).put('evidence', c.evidence).put('page', c._page).put('low', c._low).put('high', c._high).put('crowded', c.crowded);
      const values = new JSONArray(); for (const [name, v] of c.values) values.put(PipeBook._dayJson(v).put('name', name)); o.put('values', values); open.put(o);
    }
    root.put('openColumns', open); if (this.printedFrom > 0) root.put('printedFrom', this.printedFrom).put('printedTo', this.printedTo);
  }
  _columnsFromJson(root) {
    this.printedFrom = root.optInt('printedFrom', 0); this.printedTo = root.optInt('printedTo', 0);
    const groups = root.optJSONArray('layout'); if (groups != null) for (let i = 0; i < groups.length(); i++) { const g = groups.getJSONArray(i); this.layout.push([g.getInt(0), g.getInt(1), g.getInt(2)]); }
    const open = root.optJSONArray('openColumns'); if (open != null) for (let i = 0; i < open.length(); i++) {
      const o = open.getJSONObject(i); const readings = []; const r = o.optJSONArray('readings'); if (r != null) for (let k = 0; k < r.length(); k++) readings.push(r.getInt(k));
      const c = new DayColumn(o.getInt('start'), o.getInt('end'), o.optInt('headerRow', 0), o.optBoolean('structured', true), readings, o.optString('evidence', '')); c._page = o.optInt('page', -1); c._low = Math.max(1, o.optInt('low', 1)); c._high = Math.min(this.month.lengthOfMonth(), o.optInt('high', this.month.lengthOfMonth())); c.crowded = o.optBoolean('crowded', false);
      const values = o.optJSONArray('values'); if (values != null) for (let k = 0; k < values.length(); k++) { const v = values.getJSONObject(k); c.values.set(v.getString('name'), PipeBook._dayFromJson(v)); } this._openColumns.push(c);
    }
  }
  _sheetsToJson() {
    const out = new JSONArray();
    for (const sheet of this._sheets) {
      const rows = new JSONArray();
      for (let i = 0; i < sheet.rows.length; i++) { const days = new JSONObject();
        for (const [day, pipe] of sheet.pipes[i]) days.put(String(day), pipe);
        rows.put(new JSONObject().put('ocr', sheet.rows[i]).put('days', days)); }
      out.put(new JSONObject().put('rows', rows));
    }
    return out;
  }
  _sheetsFromJson(root) {
    const saved = root.optJSONArray('sheets'); if (saved == null) return;
    for (let i = 0; i < saved.length(); i++) {
      const sheet = new Sheet(); const rows = saved.getJSONObject(i).optJSONArray('rows');
      if (rows != null) for (let j = 0; j < rows.length(); j++) {
        const row = rows.getJSONObject(j); const days = new JavaTreeMap();
        const printed = row.optJSONObject('days');
        if (printed != null) for (const keys = printed.keys(); keys.hasNext();) {
          const key = keys.next();
          try { const day = Integer.parseInt(key); if (day >= 1 && day <= this.month.lengthOfMonth()) days.put(day, printed.getString(key)); } catch (notADate) { if (!(notADate instanceof NumberFormatException)) throw notADate; /* a key that is not a date is ignored */ }
        }
        sheet.rows.push(row.optString('ocr', '')); sheet.pipes.push(days);
      }
      this._sheets.push(sheet);
    }
  }
  static fromJson(json) {
    const root = new JSONObject(json); const book = new PipeBook(YearMonth.parse(root.getString('month'))); const people = root.getJSONArray('employees');
    for (let i = 0; i < people.length(); i++) {
      const p = people.getJSONObject(i); const e = book.add(p.getInt('number'), p.getString('name'), p.optString('evidence', '')); e._ocrName = p.optString('ocr', e.name); const days = p.getJSONArray('days');
      for (let j = 0; j < days.length(); j++) {
        const d = days.getJSONObject(j); const day = d.getInt('day'); const options = []; const o = d.optJSONArray('options'); if (o != null) for (let k = 0; k < o.length(); k++) { const v = o.getJSONObject(k); options.push(new PipeDay(value(v, 'code'), value(v, 'pipe'), value(v, 'duty'), v.optString('raw', ''), v.optString('evidence', ''))); }
        if (day >= 1 && day <= book.month.lengthOfMonth()) e.days.put(day, new PipeDay(value(d, 'code'), value(d, 'pipe'), value(d, 'duty'), d.optString('raw', ''), d.optString('evidence', ''), d.optBoolean('conflict', d.optString('raw', '').startsWith('Ảnh trùng ngày')), options));
      }
    }
    book._columnsFromJson(root); book._sheetsFromJson(root);
    if (root.has('primaryPage')) {
      const page = root.getJSONObject('primaryPage'); if (page.has('primaryPage')) throw new JSONException('Nested primary page');
      book._primaryPage = PipeBook.fromJson(page.toString()); book._primaryIndex = root.getInt('primaryIndex'); const paths = root.getJSONArray('sourceImages'); for (let i = 0; i < paths.length(); i++) book._sourceImages.push(paths.getString(i));
      if (!book.month.equals(book._primaryPage.month) || paths.length() < 1 || paths.length() > 3 || book._primaryIndex < 0 || book._primaryIndex >= paths.length()) throw new JSONException('Invalid primary image metadata');
      const confirmed = root.optJSONObject('confirmedOwnerDays'); if (confirmed != null) for (const keys = confirmed.keys(); keys.hasNext();) { const key = keys.next(); const days = confirmed.getJSONArray(key); const set = new JavaTreeSet(); for (let i = 0; i < days.length(); i++) { const day = days.getInt(i); if (day >= 1 && day <= book.month.lengthOfMonth()) set.add(day); } book._confirmedOwnerDays.put(key, set); }
    }
    return book;
  }
}
