// Port of vn.lichdilam.PipeRules (APK 4.5). Lists are JS arrays; String[] results are 2-element arrays.
import { trim, split } from '../platform/java.js';
import { OcrCodes } from './OcrCodes.js';
import { PipeDay } from './PipeDay.js';

const D5_DUTY = new Map();
{
  const table = [['9', 'HC'], ['10', 'TC1'], ['11', 'HC'], ['12', ''], ['13', 'TC1'], ['14', 'HC'], ['15', 'TC1'], ['16', 'HC'], ['17', ''], ['18', 'HC'], ['19', ''], ['20', ''], ['21', ''], ['22', '']];
  for (const r of table) D5_DUTY.set(r[0], r[1]);
}
/** Java [\s|.,:;'\[\]()] (ASCII \s). */
const PUNCT = /[ \t\n\x0B\f\r|.,:;'[\]()]/g;
const MERGED = /^(?:([0-9]{1,2})?(HC|TC[123]?))$/;
const CODES = new Set(['S10', 'S17', 'S26', 'C23', 'D5', 'D6', 'D23', 'HC', 'P', 'H', 'BT', 'HL', 'QT', 'QN', 'TC']);

/** Business rules of the pipe sheets, given by the user on 25/10/2026 and checked on 352 + 300 answer-key cells:
 *  S10 has a pipe number and no duty; pipes 19 and 21 belong to C23 or S26; D5 has a default duty per pipe.
 *  Changed by the user on 26/10/2026: S10 and D5 may both hold 19, 20, 21 and 22 (D5 · 19 is printed on the
 *  September T5 and T.T. Vinh sheets); D5 with 19–22 has no duty. Only C23/S26 with another number is a
 *  contradiction now. Because a blurred 11 is read as 21 (Vinh 25/10, Hải Ngọc day 30), D5/S10 with 19 or 21 —
 *  the pairs that were impossible before — need a second reading (needsSecondReading, the user's choice "cách A").
 *  A printed value always wins over a rule: rules only reject contradictions and fill a duty the photo shows
 *  but OCR could not read (marked with DEFAULT_MARK so the user sees it was not read). */
export class PipeRules {
  constructor() { throw new Error('PipeRules is not instantiable'); }
  /** Shown after a duty that comes from the default table, e.g. 18-HC*. */
  static DEFAULT_MARK = '*';
  /** Default duty of a D5 pipe: "HC"/"TC1", "" (no duty), or null when the table has no entry (QT…). */
  static defaultDuty(pipe) { return pipe == null ? null : D5_DUTY.get(trim(pipe)) ?? null; }
  static late(code) { return code === 'C23' || code === 'S26'; }
  /** A code and a pipe that cannot be printed together: C23 or S26 with a number other than 19 and 21 (C23 · 14). */
  static contradicts(code, pipe) {
    if (code == null || pipe == null || pipe === '' || !/^[0-9]{1,3}$/.test(pipe)) return false;
    return PipeRules.late(code) && !(pipe === '19' || pipe === '21');
  }
  /** D5 or S10 with 19 or 21: allowed since 26/10, but one reading is not enough (a blurred 11 reads as 21). */
  static needsSecondReading(code, pipe) {
    return (code === 'D5' || code === 'S10') && (pipe === '19' || pipe === '21');
  }
  /** At least three OCR readings of the pipe cell, every non-empty one exactly this number (the D5 code beside it,
   *  "DS22 22", is not counted as a different reading). */
  static unanimous(readings, number) {
    let n = 0;
    for (const r of readings) { const p = PipeRules._readingPipe(r); if (p == null) continue; if (p !== number) return false; n++; }
    return n >= 3;
  }
  /** At least one OCR reading of the pipe cell gives this number. */
  static anyReading(readings, number) { for (const r of readings) if (number === PipeRules._readingPipe(r)) return true; return false; }
  /** The pipe number one reading gives ("19", "DS19", a T5 cell "19HC"), "" for a reading with no number, or null
   *  for an empty reading. */
  static _readingPipe(r) {
    const s = r == null ? '' : r.replace(PUNCT, '').replace(/^D[S5]/, ''); if (s === '') return null;
    if (/^[0-9]+$/.test(s)) return s; const m = PipeRules.merged(r); return m == null ? '' : m[0];
  }
  /** One cell holding pipe and duty (team T5: "12TC2", "9HC", "TC"): {pipe, duty} or null. OCR's I/l for 1 in
   *  TC1 is accepted; anything else ("10T1C") stays unread. */
  static merged(raw) {
    return PipeRules._acceptedMerged(PipeRules._mergedObservation(raw));
  }
  /** An out-of-range number can still contradict another view; apply the range only after voting. */
  static _mergedObservation(raw) {
    // The 1 of a final TC1 is also read as ":", "!" or "|" (25/10, T5: "13TC:" next to "13TC1").
    let s = trim((raw == null ? '' : raw).toUpperCase()).replace(/TC[ \t\n\x0B\f\r]*[:!|IL]$/, 'TC1').replace(PUNCT, '');
    s = s.replace(/TC[IL]$/, 'TC1');
    const m = MERGED.exec(s); if (m == null) return null;
    return [m[1] == null ? '' : m[1], m[2]];
  }
  static _acceptedMerged(value) { return value == null || value[0] !== '' && OcrCodes.pipeCandidate(value[0]) == null ? null : value; }
  /** The value printed most often among the readings when it is a merged cell, with at least two readings
   *  agreeing and no other merged value read; else null. */
  static mergedVote(readings) {
    const votes = new Map();
    for (const r of readings) { const v = PipeRules._mergedObservation(r); if (v != null) { const k = v[0] + '|' + v[1]; votes.set(k, (votes.get(k) ?? 0) + 1); } }
    if (votes.size !== 1) return null; const [key, count] = votes.entries().next().value;
    return count >= 2 ? PipeRules._acceptedMerged(split(key, /\|/, -1)) : null;
  }
  /** 28/10/2026: the user confirmed the printed token 10T1C means pipe 10 / TC1.
   *  Keep the raw parser strict; apply this explicit text correction before the existing vote.
   *  It is independent of a person's name/date and does not extrapolate to other T1C strings. */
  static confirmedMergedVote(readings) {
    const normalized = []; for (const raw of readings) { const text = raw == null ? '' : raw.toUpperCase().replace(PUNCT, ''); normalized.push(text === '10T1C' ? '10TC1' : raw); }
    return PipeRules.mergedVote(normalized);
  }
  /** Reuse the actual OCR observations of a cached cell; never overwrite a known/manual duty. */
  static confirmedPrintedDay(value) {
    if (value == null || value.conflict || value.code !== 'D5' || value.pipe !== '10' || value.duty != null && !value.duty.endsWith(PipeRules.DEFAULT_MARK)) return value;
    const field = value.raw.indexOf(' | '); if (field < 0) return value;
    const shared = value.raw.substring(field + 3); if (!shared.replace(/[ \t\n\x0B\f\r]+/g, '').includes('10T1C')) return value;
    const readings = split(shared, /[/|]/);
    for (const raw of readings) { const bare = trim(raw); if (/^[0-9]{1,2}$/.test(bare) && bare !== '10') return value; }
    const confirmed = PipeRules.confirmedMergedVote(readings);
    if (confirmed == null || confirmed[0] !== '10' || confirmed[1] !== 'TC1') return value;
    return new PipeDay(value.code, value.pipe, 'TC1', value.raw + ' | chữ in đã xác nhận: 10T1C → 10TC1', value.evidence);
  }
  /** Every non-empty reading of a cell is a bare number (no letter anywhere), and there are at least two. */
  static bareNumbers(readings) {
    let n = 0; for (const r of readings) { let s = r == null ? '' : r.replace(PUNCT, '');
      // The code cell beside it is sometimes read into the same text ("DS22 22", 25/10 T5): not a duty.
      s = s.replace(/^D[S5]/, ''); if (s === '') continue; if (!/^[0-9]+$/.test(s)) return false; n++; } return n >= 2;
  }
  /** A stored code that is a printed word ("LỘC"), not a shift code: the person works another roster that day. */
  static printedWord(code) {
    if (code == null) return false; const plain = code.normalize('NFD').replace(/\p{M}/gu, '').replace(/Đ/g, 'D').replace(/đ/g, 'd').toUpperCase();
    return plain.length >= 3 && /^\p{L}+$/u.test(plain) && !CODES.has(plain);
  }
  /** A word printed in the shift cell instead of a code (Uẩn, day 23: "LỘC"): the word itself when at least two
   *  readings agree on it, else null. Merged with the work roster it is a different shift ("Khác Ca"). */
  static wordVote(readings) {
    // Readings that differ only by accents ("LỘC", "LOC") are the same printed word.
    const votes = new Map(), forms = new Map();
    for (const r of readings) { const w = trim((r == null ? '' : r).normalize('NFC')).toUpperCase().replace(/[^\p{L}]/gu, '');
      const plain = w.normalize('NFD').replace(/\p{M}/gu, '').replace(/Đ/g, 'D');
      if (w.length < 3 || CODES.has(plain) || /^[SCD][0-9OIL]+$/.test(plain)) continue; votes.set(plain, (votes.get(plain) ?? 0) + 1);
      if (!forms.has(plain)) forms.set(plain, new Map()); const f = forms.get(plain); f.set(w, (f.get(w) ?? 0) + 1); }
    if (votes.size === 0) return null; let top = null; for (const e of votes) if (top == null || e[1] > top[1]) top = e;
    for (const e of votes) if (e[0] !== top[0] && e[1] * 2 >= top[1]) return null;
    if (top[1] < 2) return null;
    // Shown as read most often; between equally frequent forms, the one that kept its accents.
    let shown = null, count = 0; for (const [form, n] of forms.get(top[0])) if (n > count || n === count && form !== top[0]) { shown = form; count = n; }
    return shown;
  }
}
