// Port of vn.lichdilam.ClockInput (APK 4.5).
import { IllegalArgumentException, Integer, Character, format, idiv, trim } from '../platform/java.js';

const HOUR_MAX = 23, MINUTE_MAX = 59;
const DIGITS = /^[0-9]{1,2}$/;

/** Pure rules for the separate [hour] : [minute] reminder fields; Android views only call these. */
export class ClockInput {
  static HOUR_MAX = HOUR_MAX; static MINUTE_MAX = MINUTE_MAX;
  /** Text the field would contain after an edit, or null when the edit must be rejected. */
  static accept(current, start, end, insertion, max) {
    const before = current == null ? '' : current; start = Math.max(0, Math.min(start, before.length)); end = Math.max(start, Math.min(end, before.length));
    const result = before.substring(0, start) + (insertion == null ? '' : String(insertion)) + before.substring(end);
    if (result === '') return result;
    if (result.length > 2 || !DIGITS.test(result)) return null;
    return Integer.parseInt(result) <= max ? result : null;
  }
  /** A field is finished at two digits, or at one digit that cannot start a valid two-digit value. */
  static complete(value, max) {
    if (value == null || !DIGITS.test(value)) return false;
    return value.length === 2 || Character.digit(value.charAt(0), 10) > idiv(max, 10);
  }
  /** Two-digit display form; empty stays empty so a missing value is never invented. */
  static pad(value) {
    const text = value == null ? '' : trim(value);
    if (text === '') return '';
    if (!DIGITS.test(text)) throw new IllegalArgumentException('Chỉ nhập số.');
    return format('%02d', Integer.parseInt(text));
  }
  static two(value) { return format('%02d', value); }
  /** Minute of day for a saved rule; both fields are required and range-checked. */
  static minuteOfDay(hour, minute) {
    const h = hour == null ? '' : trim(hour), m = minute == null ? '' : trim(minute);
    if (h === '' || m === '') throw new IllegalArgumentException('Nhập đủ giờ (00–23) và phút (00–59).');
    if (!DIGITS.test(h) || Integer.parseInt(h) > HOUR_MAX) throw new IllegalArgumentException('Giờ phải từ 00 đến 23.');
    if (!DIGITS.test(m) || Integer.parseInt(m) > MINUTE_MAX) throw new IllegalArgumentException('Phút phải từ 00 đến 59.');
    return Integer.parseInt(h) * 60 + Integer.parseInt(m);
  }
}
