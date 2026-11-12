// Port of vn.lichdilam.ShiftChange (APK 4.5).
import { IllegalArgumentException, Character, Integer, format } from '../platform/java.js';
import { LocalDate, DateTimeException } from '../platform/time.js';
import { Schedule } from './Schedule.js';
import { PipeRules } from './PipeRules.js';
import { PipeDay } from './PipeDay.js';

/** A validated change; two-digit years represent 2000–2099. */
export class ShiftChange {
  /**
   * Java overloads by argument count:
   * (date, code) · (date, code, person) · (date, code, person, personNumber, pipe, duty, updatesPipe, confirmedPipe)
   * · (…, lookupPerson) · private (…, lookupPerson, personKey, fullName[, manualAssignment]).
   */
  constructor(...a) {
    let [date, code, person = null, personNumber = 0, pipe = null, duty = null, updatesPipe = false, confirmedPipe = false, lookupPerson, personKey = '', fullName = '', manualAssignment = false] = a;
    if (a.length < 9) lookupPerson = personNumber > 0;
    code = Schedule.canonicalShift(code); pipe = Schedule.canonicalToken(pipe); duty = Schedule.canonicalToken(duty);
    if (date == null || (code == null && !lookupPerson) || (code != null && code !== '' && !/^[A-Z][A-Z0-9]{0,7}$/.test(code)))
      throw new IllegalArgumentException('Chọn mã ca mới hoặc OFF.');
    this.date = date; this.code = Schedule.OFF === code ? '' : code;
    this.person = Schedule.normalizePerson(person);
    this.updatesPerson = person != null;
    this.lookupPerson = lookupPerson;
    /** Explicit selector edit; preserves a confirmed identity while overriding its assignment. */
    this.manualAssignment = manualAssignment;
    /** Exact source row explicitly selected by the user, never a fuzzy name. */
    this.personKey = personKey;
    /** Full name from the work roster that the user confirmed for this person; empty when not determined. */
    this.fullName = Schedule.normalizePerson(fullName);
    // Only an explicitly confirmed assignment verifies a default duty. An auto lookup must
    // retain its source mark: removing it here makes the unchanged source look different
    // when SwapSelection reads the confirmed person again.
    if (confirmedPipe && duty != null && duty.endsWith(PipeRules.DEFAULT_MARK)) duty = duty.substring(0, duty.length - PipeRules.DEFAULT_MARK.length);
    this.personNumber = personNumber; this.pipe = pipe; this.duty = duty; this.updatesPipe = updatesPipe; this.confirmedPipe = confirmedPipe;
    if (personNumber < 0 || personNumber > 999) throw new IllegalArgumentException('STT người đổi ca phải từ 1–999.');
    if (lookupPerson && this.person === '') throw new IllegalArgumentException('Nhập tên người đổi ca để dò đúng hàng trong ảnh.');
    if (confirmedPipe && code == null) throw new IllegalArgumentException('Chọn mã ca trước khi xác nhận số ống.');
    if (confirmedPipe && this.code !== '' && this.code !== 'P') {
      if (pipe == null || PipeDay.pipeValue(pipe) == null) throw new IllegalArgumentException('Xác nhận đúng một số ống; không nhập hai số.');
      if (this.code === 'D5' && (duty == null || !(duty === '' || duty === 'HC' || /^TC[123]?$/.test(duty)))) throw new IllegalArgumentException('Chọn đúng HC, TC, TC1, TC2, TC3 hoặc Không có theo ảnh cho ca D5.');
    }
    if (this.person.length > 60) throw new IllegalArgumentException('Tên người đổi ca tối đa 60 ký tự.');
    for (let i = 0; i < this.person.length; i++) if (Character.isISOControl(this.person.charCodeAt(i)))
      throw new IllegalArgumentException('Tên người đổi ca chứa ký tự không hợp lệ.');
    if (manualAssignment && (!updatesPipe || this.code == null || !Schedule.dayOff(this.code) && (pipe == null || PipeDay.pipeValue(pipe) == null)))
      throw new IllegalArgumentException('Chọn mã ca và đúng một số ống để sửa thủ công.');
    Object.freeze(this);
  }
  forPerson(key) {
    return new ShiftChange(this.date, this.code, this.updatesPerson ? this.person : null, this.personNumber, this.pipe, this.duty, this.updatesPipe, this.confirmedPipe, this.lookupPerson, key, this.fullName, this.manualAssignment);
  }
  withFullName(name) {
    const clean = Schedule.normalizePerson(name); if (clean.length > 60) throw new IllegalArgumentException('Họ tên tối đa 60 ký tự.');
    return new ShiftChange(this.date, this.code, this.updatesPerson ? this.person : null, this.personNumber, this.pipe, this.duty, this.updatesPipe, this.confirmedPipe, this.lookupPerson, this.personKey, clean, this.manualAssignment);
  }
  withManualAssignment() { return new ShiftChange(this.date, this.code, this.updatesPerson ? this.person : null, this.personNumber, this.pipe, this.duty, this.updatesPipe, this.confirmedPipe, this.lookupPerson, this.personKey, this.fullName, true); }
  static parseDate(day, month, year) {
    if (!/^[0-9]{2}$/.test(day) || !/^[0-9]{2}$/.test(month) || !/^[0-9]{2}$/.test(year))
      throw new IllegalArgumentException('Nhập đủ 2 chữ số cho ngày, tháng và năm (DD/MM/YY).');
    try { return LocalDate.of(2000 + Integer.parseInt(year), Integer.parseInt(month), Integer.parseInt(day)); }
    catch (e) { if (!(e instanceof DateTimeException)) throw e; throw new IllegalArgumentException('Ngày không tồn tại. Kiểm tra ngày, tháng và năm.'); }
  }
  displayDate() { return format('%02d/%02d/%02d', this.date.getDayOfMonth(), this.date.getMonthValue(), this.date.getYear() % 100); }
}
