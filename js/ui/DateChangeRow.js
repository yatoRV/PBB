// Port of vn.lichdilam.DateChangeRow (APK 4.5).
// Independent, accessible DD / MM / YY entry with no shared focus state between rows.
// Web: the LinearLayout is `view` (a <div>); EditText → <input>, Spinner → <select>. Android's TextWatcher also
// fires for setText, so programmatic text changes go through _setText(), which runs the same watchers.
import { IllegalArgumentException, Objects, format, matches, Integer } from '../platform/java.js';
import { YearMonth } from '../platform/time.js';
import { AlertDialog } from '../platform/widget.js';
import { AppLog } from '../core/AppLog.js';
import { Schedule } from '../core/Schedule.js';
import { ScheduleStore } from '../core/ScheduleStore.js';
import { ShiftChange } from '../core/ShiftChange.js';
import { ManualDayEdit } from '../core/ManualDayEdit.js';
import { SwapSelection } from '../core/SwapSelection.js';
import { PipeDay } from '../core/PipeDay.js';
import { PipeRules } from '../core/PipeRules.js';
import { ConfirmedNames } from '../core/ConfirmedNames.js';
import { ThemeUi } from './ThemeUi.js';
import { el, textView, linear, describe, editText, spinner, setItems, imageView, fileExists, buttonView } from './Views.js';

const Mode = Object.freeze({ MANUAL: Object.freeze({ name: () => 'MANUAL', toString: () => 'MANUAL' }), AUTO: Object.freeze({ name: () => 'AUTO', toString: () => 'AUTO' }) });
const DUTIES = ['Chưa rõ (?)', 'Không có', 'HC', 'TC', 'TC1', 'TC2', 'TC3'];
const TEXT = ThemeUi.TEXT, MUTED = ThemeUi.MUTED;

export class DateChangeRow {
  static Mode = Mode;
  /** (context, remove[, pipeCalendar = false, lookup = null[, mode = AUTO]]); lookup = { book(month) } or month → book. */
  constructor(context, remove, pipeCalendar = false, lookup = null, mode = Mode.AUTO) { // eslint-disable-line no-unused-vars
    this.context = context; this.lookup = lookup; this.mode = Objects.requireNonNull(mode);
    this.selection = new SwapSelection(); this.confirming = false; this.populating = false;
    this.baselineCode = null; this.baselinePipe = null; this.baselineDuty = null; this.baselinePerson = ''; this.chosenValue = null;
    this.codeLabels = []; this.pipeLabels = [];
    const v = this.view = linear(false, 'change-row'); describe(v, mode === Mode.MANUAL ? 'Đổi ca thủ công' : 'Đổi ca tự động');
    const header = linear(true, 'change-row__header');
    const title = this._label('Ngày đổi ca', 13); title.classList.add('bold'); header.append(title);
    const del = this._delete = el('button', 'icon-btn change-row__delete', '×'); del.type = 'button'; describe(del, 'Xóa dòng ngày đổi ca'); del.addEventListener('click', () => remove()); header.append(del); v.append(header);
    const date = linear(true, 'change-row__date');
    this.day = this._part('DD', 'Ngày, hai chữ số'); this.month = this._part('MM', 'Tháng, hai chữ số'); this.year = this._part('YY', 'Năm, hai chữ số cuối');
    date.append(this.day, this._separator(), this.month, this._separator(), this.year); v.append(date);
    this._addHint('Ngày / Tháng / Năm · Mỗi ô 2 số. Ví dụ: 03 / 09 / 26.');
    const personLabel = this._label(mode === Mode.MANUAL ? 'Người đổi ca (không bắt buộc)' : 'Người đổi ca', 14); personLabel.classList.add('bold', 'change-row__person-label'); v.append(personLabel);
    this.person = editText({ hint: 'Ví dụ: Nguyen A', description: 'Người đổi ca', maxLength: 60 }); this.person.setAttribute('autocapitalize', 'words'); this.person.enterKeyHint = 'done'; this.person.classList.add('field--inner'); v.append(this.person);
    this._addHint('Nhập họ tên hoặc tên gọi, ví dụ Nguyen A hoặc A. Chọn và xác nhận đúng người; trên lịch chỉ hiện tên gọi, lịch sử lưu họ tên đầy đủ bạn xác nhận.');
    this._watchers = new Map([[this.day, []], [this.month, []], [this.year, []], [this.person, []]]);
    this._advance(this.day, this.month); this._advance(this.month, this.year); this._advance(this.year, this.person);
    this._addHint('App tìm trong dữ liệu của các ảnh phân ống đã lưu. Sau khi bạn xác nhận người, ca và số ống của ngày này được điền tự động.');
    const find = buttonView('Tìm & xác nhận người đổi ca', true); find.classList.add('change-row__find'); find.addEventListener('click', () => this.ensureConfirmed(() => {}));
    find.hidden = mode !== Mode.AUTO; v.append(find);
    this.preview = this._label(mode === Mode.MANUAL ? 'Nhập thủ công' : 'Chưa chọn người đổi ca', 14); ThemeUi.text(this.preview, ThemeUi.ACCENT); this.preview.classList.add('change-row__preview'); v.append(this.preview);
    this.codeLabels.push('Chọn mã ca', 'S26', 'C23', 'S10', 'D5', 'S17', 'D6', 'HC', 'HOC', 'BT', 'P', 'H', 'HL', 'OFF');
    for (const code of new ScheduleStore(context).knownCodes()) if (matches(code, '[A-Z][A-Z0-9]{0,7}') && !this.codeLabels.includes(code)) this.codeLabels.push(code);
    this.pipeLabels.push('Chưa chọn ống'); for (let n = 9; n <= 22; n++) this.pipeLabels.push(format('%02d', n));
    this.codeChoice = spinner(this.codeLabels, 'Mã ca'); this.pipeChoice = spinner(this.pipeLabels, 'Phân ống'); this.dutyChoice = spinner(DUTIES, 'Nhiệm vụ D5');
    const assignments = linear(true, 'change-row__choices');
    assignments.append(this._choiceBox('Mã ca', this.codeChoice), this._choiceBox('Phân ống', this.pipeChoice)); v.append(assignments);
    assignments.hidden = mode !== Mode.MANUAL;
    this.dutyBox = this._choiceBox('Nhiệm vụ D5', this.dutyChoice); this.dutyBox.hidden = true; v.append(this.dutyBox);
    this.details = buttonView('Xem lịch người đã xác nhận', false); this.details.hidden = true; this.details.addEventListener('click', () => this._showPersonDays()); v.append(this.details);
    this.validation = this._label('', 12); ThemeUi.text(this.validation, ThemeUi.WARNING); this.validation.hidden = true; this.validation.setAttribute('role', 'alert'); v.append(this.validation);
    const chosen = () => {
      this.dutyBox.hidden = !(mode === Mode.MANUAL && this._selectedCode() === 'D5'); this.validation.hidden = true;
      if (mode === Mode.MANUAL && !this.populating && this._assignmentEdited()) AppLog.event('user.manualAssignment.selection', AppLog.data('mode', mode.name(), 'date', this._safeDate() == null ? null : this._safeDate().toString(), 'code', this._selectedCode(), 'pipe', this._selectedPipe(), 'duty', this._selectedDuty(), 'personQuery', this._query()));
    };
    for (const choice of [this.codeChoice, this.pipeChoice, this.dutyChoice]) choice.addEventListener('change', chosen);
    for (const field of [this.day, this.month, this.year, this.person]) this._watchers.get(field).push(() => {
      if (this.populating) return; this.selection.clear(); this.chosenValue = null; this.preview.textContent = mode === Mode.MANUAL ? 'Nhập thủ công' : 'Chưa chọn người đổi ca'; this.details.hidden = true; this.validation.hidden = true; if (field !== this.person) this._prefillSavedDate();
    });
    for (const field of [this.day, this.month, this.year, this.person]) {
      let before = field.value;
      field.addEventListener('input', () => { if (field !== this.person) { const digits = field.value.replace(/[^0-9]/g, '').slice(0, 2); if (digits !== field.value) field.value = digits; } const count = field.value.length - before.length; before = field.value; this._fire(field, count > 0 ? count : 0); });
      field._syncBefore = () => { before = field.value; };
    }
    AppLog.event('ui.shiftEditor.row', AppLog.data('mode', mode.name()));
  }
  _fire(field, count) { for (const w of this._watchers.get(field)) w(count); }
  /** EditText.setText: the value, then the TextWatchers. */
  _setText(field, value) { field.value = value ?? ''; field._syncBefore(); this._fire(field, field.value.length); }

  _label(s, sp) { const t = textView(s, sp, TEXT); return t; }
  _addHint(s) {} // eslint-disable-line no-unused-vars
  _choiceBox(title, choice) { const box = linear(false, 'choice-box'); box.append(this._label(title, 14), choice); return box; }
  _selectedCode() { return this.codeChoice.selectedIndex <= 0 ? null : Schedule.canonicalShift(this.codeLabels[this.codeChoice.selectedIndex]); }
  _selectedPipe() { if (this.pipeChoice.selectedIndex <= 0) return null; const value = this.pipeLabels[this.pipeChoice.selectedIndex]; return matches(value, '[0-9]+') ? String(Integer.parseInt(value)) : value; }
  _selectedDuty() { const position = this.dutyChoice.selectedIndex; return position <= 0 ? null : position === 1 ? '' : DUTIES[position]; }
  _assignmentEdited() { const code = this._selectedCode(); return !Objects.equals(code, this.baselineCode) || !Objects.equals(this._selectedPipe(), this.baselinePipe) || (code === 'D5' && !Objects.equals(this._selectedDuty(), this.baselineDuty)); }
  _setAssignment(date, code, pipe, duty) { // eslint-disable-line no-unused-vars
    this.populating = true; this.baselineCode = code; this.baselinePipe = pipe == null || pipe === '' ? null : matches(pipe, '[0-9]+') ? String(Integer.parseInt(pipe)) : pipe;
    this.baselineDuty = code === 'D5' && duty != null && !duty.endsWith(PipeRules.DEFAULT_MARK) ? duty : null;
    const shownCode = code == null ? null : Schedule.displayCode(code); if (shownCode != null && !this.codeLabels.includes(shownCode)) { this.codeLabels.push(shownCode); setItems(this.codeChoice, this.codeLabels); }
    const shownPipe = this.baselinePipe == null ? null : matches(this.baselinePipe, '[0-9]+') ? format('%02d', Integer.parseInt(this.baselinePipe)) : this.baselinePipe;
    if (shownPipe != null && !this.pipeLabels.includes(shownPipe)) { this.pipeLabels.push(shownPipe); setItems(this.pipeChoice, this.pipeLabels); }
    this.codeChoice.selectedIndex = shownCode == null ? 0 : this.codeLabels.indexOf(shownCode); this.pipeChoice.selectedIndex = shownPipe == null ? 0 : this.pipeLabels.indexOf(shownPipe);
    const extra = this.baselineDuty == null ? 0 : this.baselineDuty === '' ? 1 : DUTIES.indexOf(this.baselineDuty); this.dutyChoice.selectedIndex = Math.max(0, extra); this.dutyBox.hidden = !(this.mode === Mode.MANUAL && code === 'D5'); this.populating = false;
  }
  _prefillSavedDate() { const date = this._safeDate(); if (date == null) return; const saved = new ScheduleStore(this.context).loadCombined(YearMonth.from(date)); const i = date.getDayOfMonth() - 1; this.baselinePerson = saved == null ? '' : saved.swapPeople[i]; this._setAssignment(date, saved == null ? null : saved.shifts[i], saved == null ? null : saved.pipes[i], saved == null ? null : saved.duties[i]); }
  _showValidation(e) { this.validation.textContent = e.message; this.validation.hidden = false; }
  _date() { return ShiftChange.parseDate(this.day.value, this.month.value, this.year.value); }
  _query() { return this.person.value.trim(); }
  _source(date) {
    const book = this.lookup == null ? null : typeof this.lookup === 'function' ? this.lookup(YearMonth.from(date)) : this.lookup.book(YearMonth.from(date));
    if (book == null) throw new IllegalArgumentException('Chưa lưu dữ liệu phân ống tháng ' + date.getMonthValue() + '/' + date.getYear() + '. Thêm ảnh phân ống trước khi đổi ca.');
    return book;
  }
  _empty() { return this.day.value.length === 0 && this.month.value.length === 0 && this.year.value.length === 0 && this._query() === '' && this.codeChoice.selectedIndex === 0 && this.pipeChoice.selectedIndex === 0; }
  _builder() { return new ThemeUi.DialogBuilder(this.context); }
  /** Save can initiate the same confirmation flow, but cancel never invokes continuation. */
  ensureConfirmed(continuation) {
    if (this.confirming) return;
    if (!this.selection.matches(this._safeDate(), this._query())) this.chosenValue = null;
    if (this._empty()) { continuation(); return; }
    try {
      if (this.mode === Mode.MANUAL) { this.read(); continuation(); return; }
      const chosenDate = this._date(); const name = this._query(); if (name === '') throw new IllegalArgumentException('Nhập tên người đổi ca rồi tìm và xác nhận.');
      AppLog.event('user.autoAssignment.lookup', AppLog.data('mode', this.mode.name(), 'date', chosenDate.toString(), 'query', name)); const book = this._source(chosenDate);
      if (this.selection.matches(chosenDate, name)) { this.read(); continuation(); return; }
      const matchesFound = book.search(name);
      if (matchesFound.length === 0) {
        const near = book.similar(name);
        if (near.length === 0) throw new IllegalArgumentException('Chưa tìm thấy tên ' + name + ' trong dữ liệu phân ống đã lưu. Hãy kiểm tra tên hoặc các ảnh đã nhập.');
        // Close spellings only: the printed name may have been read with one wrong letter. The user decides.
        const nearLabels = near.map(e => e.name); this.confirming = true;
        const list = this._builder().setTitle('Không thấy đúng tên “' + name + '”. Có phải là:').setItems(nearLabels, (d, i) => { this.confirming = false; const e = near[i]; this._setText(this.person, e.name); this._confirmPerson(e, chosenDate, this._query(), continuation); }).setNegativeButton('Không phải', null).create();
        list.setOnCancelListener(() => { this.confirming = false; }); list.setOnDismissListener(() => { this.confirming = false; }); list.show(); return;
      }
      if (matchesFound.length === 1) { this._confirmPerson(matchesFound[0], chosenDate, name, continuation); return; }
      const labels = matchesFound.map((e, i) => e.name + (e.number > 0 ? ' · STT ' + e.number : '') + ' · hàng ' + (i + 1));
      this.confirming = true;
      const list = this._builder().setTitle('Chọn đúng người đổi ca').setItems(labels, (d, i) => { this.confirming = false; this._confirmPerson(matchesFound[i], chosenDate, name, continuation); }).setNegativeButton('Hủy', null).create();
      list.setOnCancelListener(() => { this.confirming = false; }); list.setOnDismissListener(() => { this.confirming = false; }); list.show();
    } catch (e) { if (!(e instanceof IllegalArgumentException)) throw e; this._showValidation(e); }
  }
  _safeDate() { try { return this._date(); } catch (e) { if (e instanceof IllegalArgumentException) return null; throw e; } }
  /** Full name for the chosen row: a name the user confirmed before, else a suggestion read from the work-roster
   *  photo. OCR spelling can be wrong, so the name is always shown in an editable field before it is saved. */
  _confirmPerson(candidate, chosenDate, name, continuation) {
    const day = candidate.days.get(chosenDate.getDayOfMonth());
    if (day != null && day.conflict && this.chosenValue == null) { this._chooseConflictValue(candidate, chosenDate, name, continuation, day); return; }
    const store = new ScheduleStore(this.context); const saved = store.names().full(candidate.name);
    if (saved != null) { this._askConfirm(candidate, chosenDate, name, continuation, saved, 'Họ tên bạn đã xác nhận cho “' + candidate.name + '”.'); return; }
    const staff = store.staff(YearMonth.from(chosenDate)); const work = store.load(YearMonth.from(chosenDate)); const owner = work == null ? '' : work.employeeName;
    const strict = staff == null ? [] : staff.candidates(candidate.name, owner, false);
    const options = strict.length === 0 && staff != null ? staff.candidates(candidate.name, owner, true) : strict;
    const suggestion = 'Gợi ý đọc từ ảnh lịch đi làm. Đối chiếu ảnh và sửa nếu sai chữ hoặc dấu.';
    if (options.length === 1) { this._askConfirm(candidate, chosenDate, name, continuation, options[0].name, suggestion); return; }
    if (options.length === 0) { this._askConfirm(candidate, chosenDate, name, continuation, '', (staff == null ? 'Chưa có gợi ý từ ảnh lịch đi làm.' : 'Ảnh lịch đi làm không có tên khớp.') + ' Nhập họ tên đầy đủ như trên lịch đi làm, hoặc để trống để ghi tên trên ảnh phân ống.'); return; }
    const labels = options.map(o => o.name); labels.push('Nhập họ tên khác', 'Giữ tên trên ảnh phân ống: ' + candidate.name);
    this.confirming = true;
    const chooser = this._builder().setTitle('Chọn họ tên đầy đủ của ' + candidate.name).setItems(labels, (d, i) => {
      this.confirming = false;
      if (i < options.length) this._askConfirm(candidate, chosenDate, name, continuation, options[i].name, suggestion);
      else this._askConfirm(candidate, chosenDate, name, continuation, '', i === options.length ? 'Nhập họ tên đầy đủ như trên lịch đi làm.' : 'Để trống: lịch sử ghi đúng tên trên ảnh phân ống.');
    }).setNegativeButton('Hủy', null).create();
    chooser.setOnCancelListener(() => { this.confirming = false; }); chooser.setOnDismissListener(() => { this.confirming = false; }); chooser.show();
  }
  _askConfirm(candidate, chosenDate, name, continuation, suggested, note) { // eslint-disable-line no-unused-vars
    this.confirming = true; const body = linear(false, 'dlg-box');
    const question = this._label('Bạn có muốn chọn người này không: ' + candidate.name + '?\nApp sẽ lấy ca và phân ống ngày ' + format('%02d/%02d/%02d', chosenDate.getDayOfMonth(), chosenDate.getMonthValue(), chosenDate.getYear() % 100) + ' từ dữ liệu đã lưu.', 15); body.append(question);
    const fieldLabel = this._label('Họ tên đầy đủ lưu vào lịch sử', 13); ThemeUi.text(fieldLabel, MUTED); fieldLabel.style.paddingTop = '14px'; body.append(fieldLabel);
    const full = editText({ hint: 'Để trống = ' + candidate.name, value: suggested, capWords: true, maxLength: 60, description: 'Họ tên đầy đủ của người đổi ca' }); body.append(full);
    const problem = this._label('', 12); ThemeUi.text(problem, ThemeUi.WARNING); problem.hidden = true; body.append(problem);
    const dialog = this._builder().setTitle('Xác nhận người đổi ca').setView(body).setNegativeButton('Hủy', null).setPositiveButton('Xác nhận', null).create();
    dialog.setOnDismissListener(() => { this.confirming = false; }); dialog.show();
    dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(() => {
      try {
        const typed = full.value.trim(), fullName = typed === '' ? '' : ConfirmedNames.validate(typed);
        if (!chosenDate.equals(this._date()) || name !== this._query()) throw new IllegalArgumentException('Thông tin đã thay đổi. Hãy tìm lại người đổi ca.');
        this.selection.confirm(this._source(chosenDate), chosenDate, name, candidate.key(), fullName, this.chosenValue); dialog.dismiss();
        const found = this.selection.read(this._source(chosenDate), chosenDate, name); this._setAssignment(chosenDate, found.code, found.pipe, found.duty); const assignment = new PipeDay(found.code, found.pipe, found.duty, '', '').assignment();
        this.preview.textContent = 'Đã chọn: ' + found.person + (found.fullName === '' ? '' : '\nHọ tên lưu vào lịch sử: ' + found.fullName) + '\nNgày ' + found.displayDate() + '\n' + Schedule.displayCode(found.code) + (assignment === '' ? '' : '\n' + assignment) + '\n' + Schedule.givenName(found.person);
        this.details.hidden = false; this.validation.hidden = true; AppLog.event('user.autoAssignment.confirmed', AppLog.data('mode', this.mode.name(), 'date', chosenDate.toString(), 'person', found.person, 'personKey', found.personKey, 'code', found.code, 'pipe', found.pipe, 'duty', found.duty)); continuation();
      } catch (e) { if (!(e instanceof IllegalArgumentException)) throw e; problem.textContent = e.message; problem.hidden = false; }
    });
  }
  /** Photos disagree: show each printed value with its own source crop; the user decides, the app never picks. */
  _chooseConflictValue(candidate, chosenDate, name, continuation, day) {
    const choices = day.choices(); const when = format('%02d/%02d/%02d', chosenDate.getDayOfMonth(), chosenDate.getMonthValue(), chosenDate.getYear() % 100);
    if (choices.length < 2) { this._showValidation(new IllegalArgumentException('Các ảnh phân ống ghi khác nhau cho ' + candidate.name + ' ngày ' + when + ' và chưa có đủ giá trị đọc rõ để chọn. Chưa lưu thay đổi; hãy đối chiếu ảnh gốc.')); return; }
    this.confirming = true; const body = linear(false, 'dlg-box');
    body.append(this._label('Các ảnh đã lưu ghi khác nhau cho ' + candidate.name + ' ngày ' + when + '. Đối chiếu ô ảnh gốc và chọn đúng giá trị; app không tự chọn.', 14));
    const holder = [null];
    for (const choice of choices) {
      const row = el('button', 'choice-card'); row.type = 'button';
      const text = Schedule.displayCode(choice.code) + (choice.assignment() === '' ? '' : ' · ' + choice.assignment()); const value = this._label(text, 17); value.classList.add('bold'); row.append(value);
      if (fileExists(choice.evidence)) row.append(imageView(choice.evidence, 'Ô ảnh gốc: ' + text, 56, 'img img--start'));
      describe(row, 'Chọn ' + text); row.addEventListener('click', () => { this.chosenValue = choice; this.confirming = false; holder[0].dismiss(); this._confirmPerson(candidate, chosenDate, name, continuation); });
      body.append(row);
    }
    holder[0] = this._builder().setTitle('Chọn dữ liệu đúng theo ảnh').setView(body).setNegativeButton('Hủy', () => { this.chosenValue = null; }).create();
    holder[0].setOnDismissListener(() => { this.confirming = false; }); holder[0].show();
  }
  _showPersonDays() {
    try {
      const chosen = this.read(); const employee = this._source(chosen.date).byKey(chosen.personKey);
      let text = ''; for (const [day, cell] of employee.days) {
        const assignment = cell.assignment(); text += 'Ngày ' + day + ': ' + Schedule.displayCode(cell.code);
        if (assignment !== '') text += ' · ' + assignment; if (cell.conflict) text += ' · ảnh mâu thuẫn'; text += '\n';
      }
      this._builder().setTitle(employee.name).setMessage(text).setPositiveButton('Đóng', null).show();
    } catch (e) { if (!(e instanceof IllegalArgumentException)) throw e; this._showValidation(e); }
  }
  _separator() { const t = this._label('/', 20); ThemeUi.text(t, MUTED); t.classList.add('change-row__sep'); return t; }
  _part(hint, description) {
    const t = editText({ hint, numeric: true, maxLength: 2, description }); t.classList.add('field--inner', 'change-row__part'); t.enterKeyHint = 'next'; return t;
  }
  _advance(from, to) {
    this._watchers.get(from).push(count => { if (document.activeElement === from && from.value.length === 2 && count > 0) { to.focus(); to.select(); } });
  }
  read() {
    if (this._empty()) return null;
    try {
      const selected = this._date(); if (this.mode === Mode.MANUAL) return ManualDayEdit.entered(selected, this._selectedCode() == null ? '' : Schedule.displayCode(this._selectedCode()), this._selectedPipe(), this._selectedDuty(), this._query(), this.baselinePerson);
      let found; try { found = this.selection.read(this._source(selected), selected, this._query()); } catch (e) { if (e instanceof IllegalArgumentException) { this.selection.clear(); this.details.hidden = true; } throw e; }
      return found;
    } catch (e) { if (e instanceof IllegalArgumentException) this._showValidation(e); throw e; }
  }
  editExisting(s, index) {
    this.populating = true;
    const date = s.month.atDay(index + 1); this._setText(this.day, format('%02d', date.getDayOfMonth())); this._setText(this.month, format('%02d', date.getMonthValue())); this._setText(this.year, format('%02d', date.getYear() % 100));
    this.day.disabled = true; this.month.disabled = true; this.year.disabled = true;
    this._setText(this.person, s.swapPeople[index]); this.baselinePerson = s.swapPeople[index]; this.populating = false; this._setAssignment(date, s.shifts[index], s.pipes[index], s.duties[index]); this._delete.hidden = true;
  }
}
