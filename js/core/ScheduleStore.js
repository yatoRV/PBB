// Port of vn.lichdilam.ScheduleStore (APK 4.5).
// HashMap/HashSet keyed by LocalDate → JavaHashMap/JavaHashSet (Java order); LinkedHashMap<String,…> → Map;
// LinkedHashMap<LocalDate|YearMonth,…> → JavaLinkedHashMap. Overloads: saveWithChanges(draft, changes[, pendingBook]),
// prepareImport(incoming[, source]); the private overloads are _saveWithChanges / _saveCombinedChanges.
import { IllegalArgumentException, IllegalStateException, ClassCastException, JavaHashMap, JavaHashSet, JavaLinkedHashMap, JavaTreeSet, Objects } from '../platform/java.js';
import { JSONObject, JSONArray, JSONException } from '../platform/json.js';
import { YearMonth, ChronoUnit } from '../platform/time.js';
import { Schedule } from './Schedule.js';
import { Personnel } from './Personnel.js';
import { PipeBook } from './PipeBook.js';
import { PipeDay } from './PipeDay.js';
import { PrintedNames } from './PrintedNames.js';
import { ConfirmedNames } from './ConfirmedNames.js';
import { ChangeHistory } from './ChangeHistory.js';
import { StaffDirectory } from './StaffDirectory.js';
import { UnifiedSchedule } from './UnifiedSchedule.js';
import { AppLog } from './AppLog.js';

const rethrowUnlessJson = e => { if (!(e instanceof JSONException)) throw e; };
const asString = v => { if (v != null && typeof v !== 'string') throw new ClassCastException('cannot be cast to java.lang.String'); return v; };
const prefix = kind => (kind === Schedule.PIPE ? 'pipe:' : '');
const keyOf = s => prefix(s.kind) + s.month;
const strings = n => new Array(n).fill(null);

export class ScheduleStore {
  /** new ScheduleStore(context[, kind]) or new ScheduleStore(sharedPreferences[, kind]); kind defaults to WORK. */
  constructor(contextOrPrefs, kind = Schedule.WORK) {
    this._prefs = typeof contextOrPrefs.getSharedPreferences === 'function' ? Personnel.ensureLoaded(contextOrPrefs).getSharedPreferences('schedules', 0) : contextOrPrefs;
    this.kind = kind;
  }
  _key(name) { return prefix(this.kind) + name; }
  other() { return new ScheduleStore(this._prefs, this.kind === Schedule.WORK ? Schedule.PIPE : Schedule.WORK); }
  forKind(type) { return new ScheduleStore(this._prefs, type); }
  loadCombined(month) { return this.combinedPreview(month, null); }
  knownCodes() {
    const result = new JavaTreeSet(['S10', 'D5', 'C23', 'S26', 'OFF']); for (const entry of this._prefs.getAll().entrySet()) try {
      const key = entry.getKey(); if (/^(?:pipe:)?[0-9]{4}-[0-9]{2}$/.test(key)) { const days = new JSONObject(asString(entry.getValue())).getJSONArray('days'); for (let i = 0; i < days.length(); i++) if (!days.isNull(i)) result.add(Schedule.displayCode(days.getString(i))); }
      else if (key.startsWith('book:')) { const book = PipeBook.fromJson(asString(entry.getValue())); for (const employee of book.employees) for (const day of employee.days.values()) if (day.code != null) result.add(Schedule.displayCode(day.code)); }
    } catch (ignored) { /* skipped */ } return result;
  }
  combinedPreview(month, draft) {
    if (draft != null && draft.kind === Schedule.COMBINED) return draft;
    const work = draft != null && draft.kind === Schedule.WORK ? draft : this.forKind(Schedule.WORK).load(month), pipe = draft != null && draft.kind === Schedule.PIPE ? draft : this.forKind(Schedule.PIPE).load(month);
    return UnifiedSchedule.combine(work, pipe, draft != null && draft.kind === Schedule.PIPE ? null : this.pipeBook(month));
  }
  conflictingOwners(month) { const w = this.forKind(Schedule.WORK).load(month), p = this.forKind(Schedule.PIPE).load(month); return w != null && p != null && !UnifiedSchedule.sameOwner(w, p); }
  lastCombinedMonth() { try { return YearMonth.parse(this._prefs.getString('combined:last', this._prefs.getString('last', this._prefs.getString('pipe:last', YearMonth.now().toString())))); } catch (e) { return YearMonth.now(); } }
  pipeBook(month) { try { const json = this._prefs.getString('book:' + month, null); return json == null ? null : this.withPrintedNames(PipeBook.fromJson(json)); } catch (e) { return null; } }
  /** Applies the names the user corrected on pipe photos. */
  withPrintedNames(book) { if (book != null) { book.applyStaffList(Personnel.current()); book.correctNames(new PrintedNames(this._prefs).all()); } return book; }
  printedNames() { return new PrintedNames(this._prefs); }
  resolve(change, pending) {
    if (!change.lookupPerson) return change;
    const book = pending != null && pending.month.equals(YearMonth.from(change.date)) ? pending : this.pipeBook(YearMonth.from(change.date));
    if (book == null) throw new IllegalArgumentException('Thêm ảnh Lịch ống tháng ' + change.date.getMonthValue() + ' trước khi dò người đổi ca.');
    return book.resolve(change);
  }
  save(s) { this.saveWithChanges(s, []); }
  saveImported(draft, corrections, source) {
    for (const correction of corrections) if (correction.lookupPerson || correction.updatesPerson || !YearMonth.from(correction.date).equals(draft.month))
      throw new IllegalArgumentException('Bước nhập ảnh chỉ đối chiếu dữ liệu nguồn. Hãy lưu lịch rồi mở Ngày đổi mã ca trên màn hình chính.');
    this._saveWithChanges(draft, corrections, source, true);
  }
  /** Reimporting OCR must not silently erase changes the user already saved. */
  prepareImport(incoming, source = null) {
    const saved = this.forKind(incoming.kind).load(incoming.month), result = source != null && source.hasPrimary() ? incoming.copy() : Schedule.mergeMissingDays(incoming, saved);
    if (saved == null || !Schedule.sameName(saved.employeeName, incoming.employeeName)) return result;
    const edited = new Set(); for (const h of this.history(incoming)) edited.add(h.date.getDayOfMonth() - 1);
    for (let d = 0; d < result.shifts.length; d++) if (edited.has(d) || saved.swapPeople[d] !== '') {
      result.present[d] = saved.present[d]; result.shifts[d] = saved.shifts[d]; result.pipes[d] = saved.pipes[d]; result.duties[d] = saved.duties[d]; result.swapPeople[d] = saved.swapPeople[d]; result.swapNumbers[d] = saved.swapNumbers[d];
    } return result;
  }
  /** Validate every affected month first; a single commit replaces only those month records. */
  saveWithChanges(draft, changes, pendingBook = null) {
    this._saveWithChanges(draft, changes, pendingBook, false);
  }
  _saveWithChanges(draft, changes, pendingBook, importedCorrections) {
    AppLog.event('schedule.save.begin', AppLog.data('kind', this.kind, 'draft', AppLog.schedule(draft), 'changeCount', changes.length));
    if (draft.kind !== this.kind) throw new IllegalArgumentException('Loại lịch không khớp.');
    const updates = new Map();
    updates.set(keyOf(draft), pendingBook != null ? this.prepareImport(draft, pendingBook) : Schedule.mergeMissingDays(draft, this.load(draft.month)));
    const before = new JavaLinkedHashMap(); const resolved = new JavaHashMap();
    const dates = new JavaHashSet();
    for (const requested of changes) {
      const change = this.resolve(requested, pendingBook); resolved.put(change.date, change);
      if (!dates.add(change.date)) throw new IllegalArgumentException('Ngày ' + change.displayDate() + ' bị nhập trùng. Chỉ giữ một dòng cho mỗi ngày.');
      const month = YearMonth.from(change.date);
      let s = updates.get(prefix(this.kind) + month);
      if (s == null) {
        s = this.load(month);
        if (s == null) throw new IllegalArgumentException('Chưa có lịch tháng ' + month.getMonthValue() + '/' + month.getYear() + '. Hãy thêm ảnh tháng đó trước.');
        // The same person on the staff list keeps the calendar even when the printed STT changed or was unread.
        if (!Schedule.sameName(s.employeeName, draft.employeeName) || s.employeeNumber !== draft.employeeNumber && Personnel.current().samePerson(s.employeeName, draft.employeeName) == null)
          throw new IllegalArgumentException('Ngày đổi ca thuộc lịch của người khác.');
        updates.set(keyOf(s), s);
      }
      this._remember(before, change.date, updates);
      ScheduleStore.apply(s, change);
      // A counterpart lookup updates both saved calendars for the same owner atomically.
      if (change.lookupPerson) {
        let linked = updates.get(prefix(this.other().kind) + month);
        if (linked == null) linked = this.other().load(month);
        if (linked != null) {
          if (!Schedule.sameName(linked.employeeName, draft.employeeName)) throw new IllegalArgumentException('Hai lịch đang thuộc tên khác nhau. Kiểm tra người dùng trước khi đồng bộ đổi ca.');
          ScheduleStore.apply(linked, change); updates.set(keyOf(linked), linked);
        }
      }
    }
    for (const s of updates.values()) if (s.kind === Schedule.WORK && s.unresolved() > 0) throw new IllegalStateException('Còn ' + s.unresolved() + ' ô chưa xác minh trong tháng ' + s.month.getMonthValue() + '.');
    try {
      // This app has one active person. Never mix another person's adjacent months.
      this._prefs.getString(this._key('identity'), ''); // old identity (read, unused, as in Java)
      const identity = draft.employeeNumber + ':' + Schedule.normalizeName(draft.employeeName);
      const e = this._prefs.edit();
      if (this.differentPerson(draft.employeeNumber, draft.employeeName)) for (const stored of this._prefs.getAll().keySet()) {
        const sameKind = this.kind === Schedule.PIPE ? stored.startsWith('pipe:') : !stored.includes(':'); if (sameKind) e.remove(stored);
      }
      for (const s of updates.values()) e.putString(keyOf(s), ScheduleStore.encode(s));
      this._appendHistory(e, draft.employeeName, before, updates, 'Đổi mã ca', resolved);
      if (pendingBook != null) {
        const savedBook = PipeBook.overlay(this.pipeBook(pendingBook.month), PipeBook.fromJson(pendingBook.toJson()));
        if (savedBook.hasPrimary() && draft.kind === Schedule.PIPE) for (const change of changes) if (!change.lookupPerson && change.updatesPipe && YearMonth.from(change.date).equals(savedBook.month)) {
          const corrected = updates.get(keyOf(draft)); const day = change.date.getDayOfMonth() - 1;
          // Imported corrections are explicit user input, including a date OCR missed.
          // Automatic/photo confirmation still requires the date to exist in its source.
          const value = new PipeDay(corrected.shifts[day], corrected.pipes[day], corrected.duties[day], importedCorrections ? 'Người dùng xác nhận thủ công' : '', '');
          if (importedCorrections) savedBook.confirmManualOwnerDay(draft.employeeName, day + 1, value);
          else savedBook.confirmOwnerDay(draft.employeeName, day + 1, value);
        }
        e.putString('book:' + pendingBook.month, savedBook.toJson());
      }
      if (!e.putString(this._key('identity'), identity).putInt(this._key('number'), draft.employeeNumber).putString(this._key('name'), draft.employeeName)
        .putString(this._key('last'), draft.month.toString()).putString('combined:last', draft.month.toString()).commit()) throw new IllegalStateException('Không ghi được dữ liệu. Hãy kiểm tra dung lượng điện thoại rồi thử lại.');
      for (const saved of updates.values()) AppLog.event('schedule.saved', AppLog.schedule(saved));
    } catch (e) { rethrowUnlessJson(e); throw new IllegalStateException(e); }
  }
  static encode(s) {
    s = s.copy();
    const o = new JSONObject(); o.put('schema', 5); o.put('kind', s.kind); o.put('number', s.employeeNumber); o.put('name', s.employeeName); o.put('present', new JSONArray(s.present));
    const days = new JSONArray(), people = new JSONArray(), numbers = new JSONArray(), pipes = new JSONArray(), duties = new JSONArray();
    for (let d = 0; d < s.shifts.length; d++) { days.put(s.shifts[d] == null ? JSONObject.NULL : s.shifts[d]); people.put(s.swapPeople[d]); numbers.put(s.swapNumbers[d]); pipes.put(s.pipes[d] == null ? JSONObject.NULL : s.pipes[d]); duties.put(s.duties[d] == null ? JSONObject.NULL : s.duties[d]); }
    o.put('days', days); o.put('swapPeople', people); o.put('swapNumbers', numbers); o.put('pipes', pipes); o.put('duties', duties); return o.toString();
  }
  // 3.0 (26/10, the user): an auto swap whose source day is not fully confirmed is saved; the calendar shows "?"
  // for what is unknown and "Khác Ca" where the photos disagree (UnifiedSchedule), instead of refusing the change.
  /** Editing the unified view changes only explicitly edited dates in the existing sources. */
  saveCombinedChanges(view, changes) {
    this._saveCombinedChanges(view, changes, false);
  }
  saveManualCorrection(view, change) {
    if (!YearMonth.from(change.date).equals(view.month) || change.lookupPerson || change.updatesPerson || !change.updatesPipe || !change.confirmedPipe && !change.manualAssignment)
      throw new IllegalArgumentException('Sửa thủ công phải xác nhận mã ca và phân ống của đúng ngày đang mở.');
    this._saveCombinedChanges(view, [change], true);
  }
  _saveCombinedChanges(view, changes, manual) {
    AppLog.event('schedule.edit.begin', AppLog.data('manual', manual, 'before', AppLog.schedule(view), 'changeCount', changes.length));
    const updates = new Map(); const dates = new JavaHashSet();
    const before = new JavaLinkedHashMap(); const resolved = new JavaHashMap();
    for (const requested of changes) {
      const change = this.resolve(requested, null); resolved.put(change.date, change); if (!dates.add(change.date)) throw new IllegalArgumentException('Ngày ' + change.displayDate() + ' bị nhập trùng.'); const selected = YearMonth.from(change.date);
      if (change.manualAssignment) AppLog.event('schedule.manualAssignment.request', AppLog.data('date', change.date.toString(), 'code', change.code, 'pipe', change.pipe, 'duty', change.duty, 'lookupPerson', change.lookupPerson, 'person', change.person, 'fullName', change.fullName));
      let work = updates.get(prefix(Schedule.WORK) + selected), pipe = updates.get(prefix(Schedule.PIPE) + selected);
      if (work == null) work = this.forKind(Schedule.WORK).load(selected); if (pipe == null) pipe = this.forKind(Schedule.PIPE).load(selected);
      if (work == null && pipe == null) throw new IllegalArgumentException('Chưa có lịch tháng ' + selected + '. Thêm ảnh trước khi đổi ca.');
      for (const s of [work, pipe]) if (s != null && !Schedule.sameName(s.employeeName, view.employeeName)) throw new IllegalArgumentException('Ảnh đang thuộc tên khác nhau. Thêm đúng lịch của bạn trước khi ghép/đổi ca.');
      this._remember(before, change.date, updates);
      if (pipe == null && change.updatesPipe) { const count = selected.lengthOfMonth(); pipe = new Schedule(Schedule.PIPE, selected, 0, view.employeeName, strings(count), strings(count), new Array(count).fill(0), strings(count), strings(count)).withPresence(new Array(count).fill(false)); }
      for (const s of [work, pipe]) if (s != null) { ScheduleStore.apply(s, change); updates.set(keyOf(s), s); }
    }
    try {
      const editor = this._prefs.edit(); for (const s of updates.values()) {
        editor.putString(keyOf(s), ScheduleStore.encode(s)); const p = prefix(s.kind); if (!this._prefs.contains(p + 'identity')) editor.putString(p + 'identity', s.employeeNumber + ':' + Schedule.normalizeName(s.employeeName)).putString(p + 'name', s.employeeName).putInt(p + 'number', s.employeeNumber); editor.putString(p + 'last', view.month.toString());
      }
      const manualBooks = new JavaLinkedHashMap();
      for (const change of resolved.values()) if ((manual || change.manualAssignment) && !change.lookupPerson && !change.updatesPerson) {
        const selected = YearMonth.from(change.date); const corrected = updates.get(prefix(Schedule.PIPE) + selected); const day = change.date.getDayOfMonth() - 1;
        if (corrected == null || corrected.swapPeople[day] !== '') continue;
        const book = manualBooks.containsKey(selected) ? manualBooks.get(selected) : this.pipeBook(selected); manualBooks.put(selected, book);
        if (book != null && book.hasPrimary())
          book.confirmManualOwnerDay(view.employeeName, day + 1, new PipeDay(corrected.shifts[day], corrected.pipes[day], corrected.duties[day], 'Người dùng xác nhận thủ công', ''));
      }
      for (const entry of manualBooks.entrySet()) if (entry.getValue() != null && entry.getValue().hasPrimary()) editor.putString('book:' + entry.getKey(), entry.getValue().toJson());
      this._appendHistory(editor, view.employeeName, before, updates, manual ? 'Nhập thủ công' : 'Đổi mã ca', resolved); if (!editor.putString('combined:last', view.month.toString()).commit()) throw new IllegalStateException('Không ghi được dữ liệu. Kiểm tra dung lượng rồi thử lại.');
    } catch (e) { rethrowUnlessJson(e); throw new IllegalStateException(e); }
    for (const saved of updates.values()) AppLog.event('schedule.saved', AppLog.schedule(saved));
  }
  _updated(updates, month, kind) { const s = updates.get(prefix(kind) + month); return s == null ? this.forKind(kind).load(month) : s; }
  _remember(before, date, updates) {
    try { const m = YearMonth.from(date); before.put(date, ChangeHistory.snapshot(this._updated(updates, m, Schedule.WORK), this._updated(updates, m, Schedule.PIPE), date.getDayOfMonth() - 1)); }
    catch (e) { rethrowUnlessJson(e); throw new IllegalStateException(e); }
  }
  /** One record per changed date; a swap record carries both people so one swap is never split in two. */
  _appendHistory(editor, owner, before, updates, action, changes) {
    if (before.isEmpty()) return; const records = ChangeHistory.read(this._prefs.getString('history:events', '[]')); const existing = [...records];
    for (const entry of before.entrySet()) {
      const date = entry.getKey(); const m = YearMonth.from(date);
      const after = ChangeHistory.snapshot(this._updated(updates, m, Schedule.WORK), this._updated(updates, m, Schedule.PIPE), date.getDayOfMonth() - 1);
      const change = changes.get(date); const actionForDate = action === 'Đổi mã ca' && change != null && change.manualAssignment && !change.lookupPerson && !change.updatesPerson ? 'Nhập thủ công' : action;
      records.push(new ChangeHistory(owner, date, actionForDate, entry.getValue(), after, ChangeHistory.swapRecord(owner, entry.getValue(), after, change, existing)));
    } editor.putString('history:events', ChangeHistory.write(records));
    // A full name the user confirmed for this swap is remembered for the same printed name.
    const confirmed = new Map(); for (const c of changes.values()) if (c.lookupPerson && c.fullName !== '' && c.person !== '') confirmed.set(c.person, c.fullName);
    this.names().put(editor, confirmed);
  }
  names() { return new ConfirmedNames(this._prefs); }
  /** User correction of a partner's full name: remembered and applied to every saved swap with that printed name. */
  renamePartner(printed, full) {
    const clean = ConfirmedNames.validate(full);
    try {
      const records = ChangeHistory.read(this._prefs.getString('history:events', '[]')); ChangeHistory.renamePartner(records, printed, clean);
      const editor = this._prefs.edit().putString('history:events', ChangeHistory.write(records)); this.names().put(editor, new Map([[printed, clean]]));
      if (!editor.commit()) throw new IllegalStateException('Không lưu được họ tên.');
    } catch (e) { rethrowUnlessJson(e); throw new IllegalStateException(e); }
  }
  history(view) {
    const result = []; for (const h of ChangeHistory.read(this._prefs.getString('history:events', '[]')))
      if (YearMonth.from(h.date).equals(view.month) && Schedule.sameName(h.owner, view.employeeName)) result.push(h);
    result.reverse(); return result;
  }
  /** Oldest first: the order needed to convert older records without guessing. */
  chronological(view) { const list = this.history(view); list.reverse(); return list; }
  /** Names read from the work-roster photo of that month, or of the nearest saved month. */
  staff(month) {
    const exact = this._prefs.getString('staff:' + month, null); if (exact != null) try { return StaffDirectory.fromJson(exact); } catch (ignored) { if (!(ignored instanceof IllegalArgumentException)) throw ignored; }
    let best = null; for (const e of this._prefs.getAll().entrySet()) if (/^staff:[0-9]{4}-[0-9]{2}$/.test(e.getKey()) && typeof e.getValue() === 'string') try {
      const d = StaffDirectory.fromJson(e.getValue()); if (best == null || Math.abs(d.month.until(month, ChronoUnit.MONTHS)) < Math.abs(best.month.until(month, ChronoUnit.MONTHS))) best = d;
    } catch (ignored) { if (!(ignored instanceof IllegalArgumentException)) throw ignored; }
    return best;
  }
  saveStaff(staff) { if (staff == null || staff.entries.length === 0) return; if (!this._prefs.edit().putString('staff:' + staff.month, staff.toJson()).commit()) throw new IllegalStateException('Không lưu được danh sách họ tên.'); }
  original(view, day) { let first = null; for (const h of this.history(view)) if (h.date.getDayOfMonth() === day) first = h; return first; }
  /** Restore one day in both sources, keeping every other day and the OCR book intact. */
  restore(view, historyId) {
    let selected = null; for (const h of this.history(view)) if (h.id === historyId) selected = h;
    if (selected == null) throw new IllegalArgumentException('Không tìm thấy lịch sử của nhân viên/tháng này.');
    const date = selected.date; const day = date.getDayOfMonth() - 1; const updates = new Map(); const before = new JavaLinkedHashMap();
    this._remember(before, date, updates);
    try {
      for (const kind of [Schedule.WORK, Schedule.PIPE]) {
        let s = this.forKind(kind).load(view.month);
        if (s != null && !Schedule.sameName(s.employeeName, view.employeeName)) throw new IllegalArgumentException('Lịch hiện tại thuộc người khác; không khôi phục.');
        if (s == null && ChangeHistory.present(selected.before, kind)) { const n = view.month.lengthOfMonth(); s = new Schedule(kind, view.month, view.employeeNumber, view.employeeName, strings(n), strings(n), new Array(n).fill(0), strings(n), strings(n)).withPresence(new Array(n).fill(false)); }
        if (s != null) { ChangeHistory.apply(selected.before, s, day); updates.set(keyOf(s), s); }
      }
      const editor = this._prefs.edit(); for (const s of updates.values()) editor.putString(keyOf(s), ScheduleStore.encode(s));
      const book = this.pipeBook(view.month); const restoredPipe = updates.get(prefix(Schedule.PIPE) + view.month);
      if (book != null && restoredPipe != null && restoredPipe.swapPeople[day] === '' && book.hasOwnerCorrection(view.employeeName, day + 1)) {
        if (restoredPipe.present[day]) book.confirmOwnerDay(view.employeeName, day + 1, new PipeDay(restoredPipe.shifts[day], restoredPipe.pipes[day], restoredPipe.duties[day], '', '')); else book.removeOwnerDayCorrection(view.employeeName, day + 1); editor.putString('book:' + view.month, book.toJson());
      }
      this._appendHistory(editor, view.employeeName, before, updates, 'Khôi phục · ' + selected.id, new JavaHashMap());
      if (!editor.commit()) throw new IllegalStateException('Không ghi được dữ liệu khôi phục.');
    } catch (e) { rethrowUnlessJson(e); throw new IllegalStateException(e); }
  }
  load(m) {
    try {
      const raw = this._prefs.getString(this._key(m.toString()), null); if (raw == null) return null;
      const o = new JSONObject(raw); const a = o.getJSONArray('days');
      const days = strings(a.length()); for (let i = 0; i < days.length; i++) days[i] = a.isNull(i) ? null : a.getString(i);
      const people = strings(days.length); const names = o.optJSONArray('swapPeople');
      for (let i = 0; i < people.length; i++) people[i] = names == null || names.isNull(i) ? '' : names.optString(i, '');
      const numbers = new Array(days.length).fill(0); const pipes = strings(days.length), duties = strings(days.length); const ns = o.optJSONArray('swapNumbers'), ps = o.optJSONArray('pipes'), ds = o.optJSONArray('duties');
      for (let d = 0; d < days.length; d++) { numbers[d] = ns == null ? 0 : ns.optInt(d, 0); pipes[d] = ps == null || ps.isNull(d) ? null : ps.optString(d); duties[d] = ds == null || ds.isNull(d) ? null : ds.optString(d); }
      const schedule = new Schedule(this.kind, m, o.getInt('number'), o.getString('name'), days, people, numbers, pipes, duties); const present = o.optJSONArray('present');
      if (present != null) for (let d = 0; d < days.length; d++) schedule.present[d] = present.optBoolean(d, true);
      else if (this.kind === Schedule.PIPE) {
        const source = this.pipeBook(m); if (source != null) try {
          const employee = source.findByName(schedule.employeeName);
          for (let d = 0; d < days.length; d++) schedule.present[d] = employee.days.containsKey(d + 1) || days[d] != null || pipes[d] != null || duties[d] != null || people[d] !== '' || numbers[d] !== 0;
        } catch (unknownOwner) { if (!(unknownOwner instanceof IllegalArgumentException)) throw unknownOwner; /* Preserve older data if its source cannot be identified. */ }
      }
      return schedule;
    } catch (ignored) { return null; }
  }
  static apply(s, change) {
    const d = change.date.getDayOfMonth() - 1; s.present[d] = true; s.issues[d] = null; const sameCode = Objects.equals(Schedule.canonicalShift(s.shifts[d]), change.code); const samePerson = !change.updatesPerson || Schedule.normalizeName(s.swapPeople[d]) === Schedule.normalizeName(change.person); s.shifts[d] = change.code; if (change.updatesPerson) { s.swapPeople[d] = change.person; s.swapNumbers[d] = change.personNumber; } if (s.kind !== Schedule.WORK) {
      if (change.code === '' || change.code === 'P') { s.pipes[d] = ''; s.duties[d] = ''; }
      else if (change.updatesPipe) { s.pipes[d] = change.pipe; s.duties[d] = change.code === 'D5' ? change.duty : ''; }
      else if (!sameCode || !samePerson) { s.pipes[d] = null; s.duties[d] = change.code === 'D5' ? null : ''; }
    }
  }
  lastMonth() { try { return YearMonth.parse(this._prefs.getString(this._key('last'), YearMonth.now().toString())); } catch (e) { return YearMonth.now(); } }
  name() { return this._prefs.getString(this._key('name'), ''); }
  number() { return this._prefs.getInt(this._key('number'), 0); }
  differentPerson(n, name) {
    const id = this._prefs.getString(this._key('identity'), ''); if (id === '') return false;
    const saved = this._prefs.getString(this._key('name'), ''); const same = saved === '' ? null : Personnel.current().samePerson(saved, name); if (same != null) return !same; if (this.kind === Schedule.PIPE) { const old = id.substring(id.indexOf(':') + 1); return old !== Schedule.normalizeName(name); } return id !== n + ':' + Schedule.normalizeName(name);
  }
}
