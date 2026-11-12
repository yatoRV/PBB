// Port of vn.lichdilam.SwapSelection (APK 4.5).
import { IllegalArgumentException, trim } from '../platform/java.js';
import { Schedule } from './Schedule.js';
import { ShiftChange } from './ShiftChange.js';

/** Confirmation is scoped to an exact source identity and date; edits invalidate it. */
export class SwapSelection {
  constructor() { this._date = null; this._query = null; this._selected = null; }
  clear() { this._selected = null; this._date = null; this._query = null; }
  matches(date, query) { return this._selected != null && this._date.equals(date) && this._query === trim(query); }
  /** fullName is the work-roster name the user confirmed for this row, or empty when none was determined.
   *  chosen is the printed value the user picked when the saved photos disagree for this person and date. */
  confirm(book, date, query, key, fullName = '', chosen = null) {
    this.clear();
    const person = book.byKey(key);
    if (!book.search(query).includes(person)) throw new IllegalArgumentException('Tên đã nhập không khớp người được chọn.');
    let request = new ShiftChange(date, null, person.name, 0, null, null, false, false, true);
    if (chosen != null) {
      const day = person.days.get(date.getDayOfMonth());
      if (day == null || !day.conflict || !day.choices().some(c => c.sameValue(chosen))) throw new IllegalArgumentException('Lựa chọn không còn khớp dữ liệu đã lưu. Hãy tìm lại người đổi ca.');
      request = new ShiftChange(date, Schedule.displayCode(chosen.code), person.name, 0, chosen.pipe, chosen.duty, true, true, true);
    }
    // A day the photos do not confirm is saved too (3.0): the calendar shows "?" or "Khác Ca" for it.
    const found = book.resolve(request.forPerson(key).withFullName(fullName));
    this._date = date; this._query = trim(query); this._selected = found;
  }
  read(book, date, query) {
    if (!this.matches(date, query)) throw new IllegalArgumentException('Hãy tìm và xác nhận đúng người đổi ca trước khi lưu.');
    return book.resolve(this._selected);
  }
}
