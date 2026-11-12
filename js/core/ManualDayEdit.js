// Port of vn.lichdilam.ManualDayEdit (APK 4.5).
import { IllegalArgumentException, Integer, trim } from '../platform/java.js';
import { Schedule } from './Schedule.js';
import { ShiftChange } from './ShiftChange.js';
import { ConfirmedNames } from './ConfirmedNames.js';
import { PipeDay } from './PipeDay.js';

const ASSIGNMENT = /^(?:([1-9][0-9]{0,2}|QT|QN1?)(?:[ \t\n\x0B\f\r]*-[ \t\n\x0B\f\r]*(HC|TC[123]?)\*?)?)$/;

/** Explicit user correction; never performs OCR or borrows another person's assignment. */
export class ManualDayEdit {
  /** The manual screen records the typed name directly; it never resolves another person's roster. */
  static entered(date, enteredCode, enteredPipe, enteredDuty, typedPerson, baselinePerson) {
    const assignment = ManualDayEdit.select(date, enteredCode, enteredPipe, enteredDuty, null);
    let name = Schedule.normalizePerson(typedPerson);
    // Editing an assignment alone must retain the counterpart and its original identity/history.
    if (name === '' || name === Schedule.normalizePerson(baselinePerson)) return assignment;
    name = ConfirmedNames.validate(name);
    return new ShiftChange(date, assignment.code, name, 0, assignment.pipe, assignment.duty, true, assignment.confirmedPipe, false).withFullName(name).withManualAssignment();
  }
  /** Selector values are explicit; null duty remains unknown instead of becoming a default. */
  static select(date, enteredCode, enteredPipe, enteredDuty, identity) {
    const code = Schedule.canonicalShift(enteredCode); let pipe = Schedule.canonicalToken(enteredPipe), duty = Schedule.canonicalToken(enteredDuty);
    if (code == null || trim(enteredCode) === '' || code !== '' && !/^[A-Z][A-Z0-9]{0,7}$/.test(code))
      throw new IllegalArgumentException('Chọn mã ca trước khi lưu.');
    if (Schedule.dayOff(code)) { pipe = ''; duty = ''; }
    else {
      if (pipe != null && /^0[0-9]+$/.test(pipe)) pipe = String(Integer.parseInt(pipe));
      pipe = pipe == null ? null : PipeDay.pipeValue(pipe);
      if (pipe == null) throw new IllegalArgumentException('Chọn đúng một số ống trước khi lưu.');
      if (code !== 'D5') duty = '';
      else if (duty != null && !(duty === '' || duty === 'HC' || /^TC[123]?$/.test(duty)))
        throw new IllegalArgumentException('Chọn nhiệm vụ D5 đúng theo ảnh, hoặc giữ Chưa rõ.');
    }
    const confirmed = code !== 'D5' || duty != null;
    let change = new ShiftChange(date, code, identity == null ? null : identity.person, identity == null ? 0 : identity.personNumber, pipe, duty, true, confirmed, identity != null && identity.lookupPerson);
    if (identity != null) change = change.forPerson(identity.personKey).withFullName(identity.fullName);
    return change.withManualAssignment();
  }
  static parse(date, enteredCode, enteredAssignment) {
    const code = Schedule.canonicalShift(enteredCode), assignment = Schedule.canonicalToken(enteredAssignment);
    if (code == null || trim(enteredCode) === '' || (code !== '' && !/^[A-Z][A-Z0-9]{0,7}$/.test(code)))
      throw new IllegalArgumentException('Nhập mã ca, ví dụ S10, D5, C23, S26, HC, TC1, P hoặc OFF.');
    if (code === '' || code === 'P') {
      if (assignment != null && assignment !== '') throw new IllegalArgumentException('Ca OFF hoặc P không có phân ống. Xóa số ống để xác nhận.');
      return new ShiftChange(date, code, null, 0, '', '', true, true, false);
    }
    const match = ASSIGNMENT.exec(assignment == null ? '' : assignment);
    if (match == null) throw new IllegalArgumentException('Nhập một số ống, ví dụ 21, 18-HC hoặc 15-TC1. Không dùng ? hay hai số ống.');
    const duty = match[2] == null ? '' : match[2];
    if (duty !== '' && code !== 'D5') throw new IllegalArgumentException('HC/TC/TC1/TC2/TC3 trong cột bổ sung chỉ áp dụng cho D5. Kiểm tra lại mã ca và số ống.');
    return new ShiftChange(date, code, null, 0, match[1], duty, true, true, false);
  }
}
