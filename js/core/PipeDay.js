// Port of vn.lichdilam.PipeDay (APK 4.5). Lists are JS arrays (options frozen like Collections.unmodifiableList).
import { trim, Objects, equalsIgnoreCase } from '../platform/java.js';
import { Schedule } from './Schedule.js';

const EMPTY = Object.freeze([]);

/** One dated assignment. Null fields mean unverified, never OFF. */
export class PipeDay {
  /** new PipeDay(code, pipe, duty, raw, evidence[, conflict[, options]]). */
  constructor(code, pipe, duty, raw, evidence, conflict = false, options = EMPTY) {
    code = Schedule.canonicalShift(code); pipe = Schedule.canonicalToken(pipe); duty = Schedule.canonicalToken(duty);
    this.conflict = conflict;
    this.code = code;
    const noPipe = code === '' || code === 'P';
    this.pipe = noPipe ? '' : pipe;
    // A spare third column belongs to D5 only. It must not turn C23/21
    // into an apparent conflict when an older scan stored null there.
    this.duty = code != null && code !== 'D5' ? '' : duty;
    this.raw = raw == null ? '' : raw; this.evidence = evidence == null ? '' : evidence;
    /** For a conflict: each different printed value with its own source crop. The user picks one; the app never does. */
    this.options = conflict && options != null ? Object.freeze([...options]) : EMPTY;
    Object.freeze(this);
  }
  /** Complete printed values of a conflict that the user can choose between. */
  choices() { const out = []; for (const o of this.options) if (o.complete()) out.push(o); return out; }
  sameValue(o) { return Objects.equals(this.code, o.code) && Objects.equals(this.pipe, o.pipe) && Objects.equals(this.duty, o.duty); }
  complete() { return !this.conflict && this.code != null && (this.code === '' || this.code === 'P' || (this.pipe != null && (this.code !== 'D5' || this.duty != null))); }
  assignment() {
    if (this.code === '' || this.code === 'P') return ''; const extra = this.code === 'D5' ? this.duty == null ? '?' : this.duty : '';
    if (this.pipe === '') return extra; return (this.pipe == null ? '?' : this.pipe) + (extra === '' ? '' : '-' + extra);
  }
  static pipeValue(raw) {
    const value = trim(raw).toUpperCase();
    // Never join "17, 19", "17 19", or "1719" into a single pipe.
    if (/^[1-9][0-9]{0,2}$/.test(value)) return value;
    if (/^(?:QT|QN|QN1)$/.test(value)) return value;
    // 27/10 (the user): "CĐ" (cơ động, a mobile position) printed where the pipe goes is shown as it is. OCR reads it
    // CĐ, CÐ or CD; no other cell of the 25/10–27/10 sheets is read so.
    if (/^C[ĐÐD]$/.test(value.replace(/[ \t\n\x0B\f\r.]/g, ''))) return 'CĐ';
    return null;
  }
  static dutyValue(raw, blank) {
    const value = trim(raw).toUpperCase().replace(/[ \t\n\x0B\f\r]+/g, '');
    if (value === 'HC' || /^TC[123]?$/.test(value)) return value;
    return value === '' && blank ? '' : null;
  }
  /** shift "" / "OFF" means the printed shift cell itself is empty (white or gray): the day is off only
   *  when its position cell is empty too. A readable shift with an empty position cell keeps its shift
   *  and an empty position; a position printed without a shift is not enough to know the shift. */
  static fromCells(shift, pipe, duty, emptyPipe, emptyDuty, evidence) {
    const code = equalsIgnoreCase('D23', trim(shift)) ? 'D23' : Schedule.normalizeShift(shift);
    const noPosition = trim(pipe) === '' && emptyPipe; const raw = pipe + (duty === '' ? '' : ' / ' + duty);
    // P always wins over blank assignment cells: it must remain P in both calendars.
    if (code === 'P') return new PipeDay(code, '', '', pipe, evidence);
    if (code === '') return noPosition ? new PipeDay('', '', '', pipe, evidence) : new PipeDay(null, PipeDay.pipeValue(pipe), null, raw, evidence);
    const dutyValue = code == null || code === 'D5' ? PipeDay.dutyValue(duty, emptyDuty) : '';
    if (noPosition) return new PipeDay(code, '', dutyValue, raw, evidence);
    return new PipeDay(code, PipeDay.pipeValue(pipe), dutyValue, raw, evidence);
  }
  static fromRecognition(code, pipe, duty, emptyPipe, emptyDuty, evidence) {
    return PipeDay.fromCells(code == null ? '?' : code === '' ? 'OFF' : code, emptyPipe ? '' : pipe == null ? '?' : pipe, emptyDuty ? '' : duty == null ? '?' : duty, emptyPipe, emptyDuty, evidence);
  }
  static _values(d) { return d.conflict ? d.options : [d]; }
  static _conflict(a, b) {
    const all = [];
    for (const v of PipeDay._values(a)) { let seen = false; for (const o of all) seen = seen || o.sameValue(v); if (!seen) all.push(v); }
    for (const v of PipeDay._values(b)) { let seen = false; for (const o of all) seen = seen || o.sameValue(v); if (!seen) all.push(v); }
    let code = null; for (const v of all) { if (v === all[0]) code = v.code; else if (!Objects.equals(code, v.code)) code = null; }
    return new PipeDay(code, null, null, 'Ảnh trùng ngày có dữ liệu khác nhau: ' + a.raw + ' | ' + b.raw, a.evidence, true, all);
  }
  static merge(a, b) {
    if (a == null) return b;
    // A later page never silently replaces a known contradiction: it is added as one more choice.
    if (a.conflict || b.conflict) { if (!b.conflict && PipeDay._values(a).some(v => v.sameValue(b))) return a; return PipeDay._conflict(a, b); }
    if (Objects.equals(a.code, b.code) && Objects.equals(a.pipe, b.pipe) && Objects.equals(a.duty, b.duty)) return a;
    // An earlier OCR miss is not a contradictory source. Fill only unknown
    // fields; two different known values, including OFF, remain a conflict.
    const codeConflict = a.code != null && b.code != null && a.code !== b.code;
    const pipeConflict = a.pipe != null && b.pipe != null && a.pipe !== b.pipe;
    const dutyConflict = a.code === 'D5' && b.code === 'D5' && a.duty != null && b.duty != null && a.duty !== b.duty;
    if (!codeConflict && !pipeConflict && !dutyConflict) {
      const code = b.code != null ? b.code : a.code, pipe = b.pipe != null ? b.pipe : a.pipe;
      let duty = b.code === 'D5' ? b.duty : a.code === 'D5' ? a.duty : '';
      if (code === 'D5' && duty == null) duty = a.code === 'D5' ? a.duty : null;
      return new PipeDay(code, pipe, duty, b.raw, b.evidence);
    }
    return PipeDay._conflict(a, b);
  }
}
