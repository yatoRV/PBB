// Port of vn.lichdilam.Schedule (APK 4.5).
// Java arrays → JS arrays: String[] holds strings/null, int[] numbers, boolean[] booleans.
import { IllegalArgumentException, trim, split } from '../platform/java.js';
import { YearMonth } from '../platform/time.js';
import { PipeDay } from './PipeDay.js';
import { Personnel } from './Personnel.js';

/** Java \s (ASCII whitespace only). */
const WS = /[ \t\n\x0B\f\r]+/g;
const strings = n => new Array(n).fill(null);
const ints = n => new Array(n).fill(0);

/** A null day is unreadable; an empty string is a verified blank (rest). */
export class Schedule {
  static OFF = 'OFF';
  static WORK = 1;
  static PIPE = 2;
  static COMBINED = 3;
  /**
   * new Schedule(month, number, name, shifts[, swapPeople]) — a work roster;
   * new Schedule(kind, month, number, name, shifts, people, numbers, pipes, duties).
   */
  constructor(...a) {
    let kind, month, number, name, shifts, people, numbers, pipes, duties;
    if (a[0] instanceof YearMonth) {
      [month, number, name, shifts] = a;
      people = a.length >= 5 ? a[4] : strings(shifts.length);
      kind = Schedule.WORK; numbers = ints(shifts.length); pipes = strings(shifts.length); duties = strings(shifts.length);
    } else [kind, month, number, name, shifts, people, numbers, pipes, duties] = a;
    this.kind = kind;
    /** CalendarIssue[] (package-private in Java). */
    this.issues = new Array(shifts.length).fill(null);
    /** Distinguishes an absent date from a printed date whose OCR is unknown. */
    this.present = new Array(shifts.length).fill(true);
    if (shifts.length !== month.lengthOfMonth()) throw new IllegalArgumentException('Số ngày không khớp tháng');
    if (people.length !== shifts.length || numbers.length !== shifts.length || pipes.length !== shifts.length || duties.length !== shifts.length) throw new IllegalArgumentException('Dữ liệu không khớp số ngày');
    this.month = month; this.employeeNumber = number; this.employeeName = name;
    this.shifts = Array.from(shifts);
    this.swapPeople = Array.from(people); this.swapNumbers = Array.from(numbers); this.pipes = Array.from(pipes); this.duties = Array.from(duties);
    for (let i = 0; i < shifts.length; i++) {
      this.shifts[i] = Schedule.canonicalShift(this.shifts[i]);
      this.pipes[i] = Schedule.canonicalToken(this.pipes[i]); this.duties[i] = Schedule.canonicalToken(this.duties[i]);
      this.swapPeople[i] = Schedule.normalizePerson(this.swapPeople[i]);
    }
  }
  unresolved() { let n = 0; for (let d = 0; d < this.shifts.length; d++) if (!this.dayComplete(d)) n++; return n; }
  dayComplete(d) { return !this.present[d] || (this.issues[d] == null && (this.kind === Schedule.WORK ? this.shifts[d] != null : new PipeDay(this.shifts[d], this.pipes[d], this.duties[d], '', '').complete())); }
  /** A day off is OFF (empty cell) or P (leave): both mean the person does not work that day. */
  static dayOff(code) { return code === '' || code === 'P'; }
  workDays() { let n = 0; for (let d = 0; d < this.shifts.length; d++) if (this.present[d] && this.shifts[d] != null && !Schedule.dayOff(this.shifts[d])) n++; return n; }
  offDays() { let n = 0; for (let d = 0; d < this.shifts.length; d++) if (this.present[d] && Schedule.dayOff(this.shifts[d])) n++; return n; }
  leaveDays() { let n = 0; for (let d = 0; d < this.shifts.length; d++) if (this.present[d] && this.shifts[d] === 'P') n++; return n; }
  presentDays() { let n = 0; for (const value of this.present) if (value) n++; return n; }
  withPresence(mask) { if (mask.length !== this.present.length) throw new IllegalArgumentException('Số ngày không khớp'); for (let i = 0; i < mask.length; i++) this.present[i] = mask[i]; return this; }
  copy() { const copy = new Schedule(this.kind, this.month, this.employeeNumber, this.employeeName, this.shifts, this.swapPeople, this.swapNumbers, this.pipes, this.duties).withPresence(this.present); for (let i = 0; i < this.issues.length; i++) copy.issues[i] = this.issues[i]; return copy; }
  /** Days the new photo does not hold keep what was saved for the same person and month: pipe sheets, and since
   *  3.0 work rosters photographed in part (half sheet). A full photo holds every day and replaces them all. */
  static mergeMissingDays(incoming, saved) {
    const result = incoming.copy(); if (saved == null || saved.kind !== incoming.kind || !incoming.month.equals(saved.month) || !Schedule.sameName(incoming.employeeName, saved.employeeName)) return result;
    for (let d = 0; d < result.shifts.length; d++) if (!incoming.present[d] && saved.present[d]) { result.present[d] = true; result.shifts[d] = saved.shifts[d]; result.swapPeople[d] = saved.swapPeople[d]; result.swapNumbers[d] = saved.swapNumbers[d]; result.pipes[d] = saved.pipes[d]; result.duties[d] = saved.duties[d]; } return result;
  }
  /** Case/whitespace only: do not apply OCR guesses to typed or saved data. */
  static canonicalToken(raw) { return raw == null ? null : trim(raw).toUpperCase(); }
  static canonicalShift(raw) { const value = Schedule.canonicalToken(raw); return Schedule.OFF === value ? '' : value; }
  static displayCode(code) { code = Schedule.canonicalShift(code); return code == null ? '?' : code === '' ? Schedule.OFF : code; }
  pipeLabel(index) { return !this.present[index] ? '' : this.issues[index] != null ? this.issues[index].label : new PipeDay(this.shifts[index], this.pipes[index], this.duties[index], '', '').assignment(); }
  dayLabel(index) { if (!this.present[index]) return ''; let code = Schedule.displayCode(this.shifts[index]); if (this.kind !== Schedule.WORK && this.pipeLabel(index) !== '') code += ' · ' + this.pipeLabel(index); return this.swapPeople[index] === '' ? code : code + ', ' + Schedule.givenName(this.swapPeople[index]); }
  static givenName(name) { const clean = Schedule.normalizePerson(name); const space = clean.lastIndexOf(' '); return space < 0 ? clean : clean.substring(space + 1); }
  /** A typed query (full name, initials or a given name alone) against a stored or printed name. With a staff
   *  list the query means every person it resolves to; a query meaning several people matches each of them. */
  static lookupNameMatches(input, actual) {
    const staff = Personnel.current();
    if (!staff.isEmpty()) { const person = staff.unique(actual, Personnel.Source.PRINTED); const meant = staff.resolve(input, Personnel.Source.TYPED);
      if (person != null && meant.length !== 0) return meant.includes(person); }
    const clean = Schedule.normalizePerson(input); return Schedule.sameName(input, actual) || (!clean.includes(' ') && clean !== '' && Schedule.normalizeName(clean) === Schedule.normalizeName(Schedule.givenName(actual)));
  }
  static normalizePerson(person) {
    if (person == null) return '';
    return trim(person.normalize('NFC')).replace(WS, ' ');
  }
  static normalizeName(name) {
    return name.normalize('NFD').replace(/\p{M}/gu, '')
      .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z]/g, '');
  }
  static sameName(input, recognized) {
    // A=B=C=D: two names of people on the staff list are equal exactly when they are the same person.
    const identity = Personnel.current().samePerson(input, recognized);
    if (identity != null) return identity;
    const a = Schedule.normalizeName(input), b = Schedule.normalizeName(recognized);
    if (a.length < 4 || a !== b) return false;
    const left = split(Schedule.normalizePerson(input).toLowerCase(), /[ \t\n\x0B\f\r]+/), right = split(Schedule.normalizePerson(recognized).toLowerCase(), /[ \t\n\x0B\f\r]+/);
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
      const l = left[i].replace(/[^\p{L}]/gu, ''), r = right[i].replace(/[^\p{L}]/gu, '');
      if (Schedule.normalizeName(l) !== Schedule.normalizeName(r)) return false;
      if (l !== Schedule.normalizeName(l) && r !== Schedule.normalizeName(r) && l !== r) return false;
    } return true;
  }
  static normalizeShift(raw) {
    let s = raw.normalize('NFD').replace(/\p{M}/gu, '')
      .toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (s === Schedule.OFF) return '';
    // Only unambiguous OCR substitutions inside a known code are accepted.
    if (/^[SCD][0-9OI]{1,2}$/.test(s)) s = s.substring(0, 1) + s.substring(1).replace(/O/g, '0').replace(/I/g, '1');
    if (s === 'DS') s = 'D5';
    if (/^(?:S(10|17|26)|C23|D(5|6)|HC|HOC|BT|P|H|HL)$/.test(s)) return s;
    return null;
  }
  static mondayOffset(month) { return month.atDay(1).getDayOfWeek().getValue() - 1; }
}
