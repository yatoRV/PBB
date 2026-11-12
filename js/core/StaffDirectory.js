// Port of vn.lichdilam.StaffDirectory (APK 4.5). Lists are JS arrays.
import { IllegalArgumentException, IllegalStateException, RuntimeException, Integer, trim, split } from '../platform/java.js';
import { JSONObject, JSONArray, JSONException } from '../platform/json.js';
import { YearMonth } from '../platform/time.js';
import { Schedule } from './Schedule.js';
import { OcrCodes } from './OcrCodes.js';
import { Personnel } from './Personnel.js';

class Entry {
  constructor(number, name) { this.number = number; this.name = Schedule.normalizePerson(name); Object.freeze(this); }
  toString() { return this.name + (this.number > 0 ? ' · STT ' + this.number : ''); }
}

/** Names exactly as read from the work-roster photo ("lịch đi làm"), used to show full names in swap history.
 *  Matching a pipe-photo name to a roster name never guesses: several or no matches return no single name. */
export class StaffDirectory {
  static Entry = Entry;
  constructor(month, entries) { this.month = month; this.entries = Object.freeze([...entries]); }
  /** Roster rows with a readable personal name; header text and unreadable cells are skipped, not repaired. */
  static fromRoster(month, serials, names) {
    const result = []; const seen = new Set();
    for (let r = 0; r < names.length; r++) {
      const name = StaffDirectory.clean(names[r]); if (name == null) continue; const digits = r < serials.length && serials[r] != null ? serials[r].replace(/[^0-9]/g, '') : '';
      const number = digits === '' || digits.length > 3 ? 0 : Integer.parseInt(digits);
      const key = number + ':' + name; if (!seen.has(key)) { seen.add(key); result.push(new Entry(number, name)); }
    } return new StaffDirectory(month, result);
  }
  /** A plausible printed person name, or null. Header words such as STT / Họ và tên are not names. */
  static clean(raw) {
    const name = trim(Schedule.normalizePerson(OcrCodes.vietnameseName(raw == null ? '' : raw).replace(/[|_*:;,"“”]+/g, ' ')).replace(/^[0-9 .-]+/, ''));
    if (name.length < 3 || name.length > 60 || !/^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u.test(name)) return null;
    const words = split(name, / /); if (words.length < 2) return null;
    for (const w of words) { const n = Schedule.normalizeName(w); if (n === 'stt' || n === 'ten' || n === 'hova' || n === 'hoten') return null; }
    return name;
  }
  toJson() {
    try { const a = new JSONArray(); for (const e of this.entries) a.put(new JSONObject().put('number', e.number).put('name', e.name)); return new JSONObject().put('month', this.month.toString()).put('entries', a).toString(); }
    catch (e) { if (!(e instanceof JSONException)) throw e; throw new IllegalStateException(e); }
  }
  static fromJson(json) {
    try { const o = new JSONObject(json); const a = o.getJSONArray('entries'); const list = []; for (let i = 0; i < a.length(); i++) { const e = a.getJSONObject(i); const name = StaffDirectory.clean(e.getString('name')); if (name != null) list.push(new Entry(e.optInt('number', 0), name)); } return new StaffDirectory(YearMonth.parse(o.getString('month')), list); }
    catch (e) { if (!(e instanceof JSONException || e instanceof RuntimeException || e instanceof TypeError)) throw e; throw new IllegalArgumentException('Danh sách họ tên không đọc được.', e); }
  }
  /** Words of a printed name; "Ng.Hồ" and "T.T.Vinh" become separate abbreviated words. */
  static _words(name) { const out = []; for (const w of split(Schedule.normalizePerson(name).replace(/\.(?=[^ \t\n\x0B\f\r])/g, '. '), / /)) if (Schedule.normalizeName(w) !== '') out.push(w); return out; }
  static _accented(w) { const letters = w.replace(/[^\p{L}\p{M}]/gu, ''); return letters.toLowerCase() !== Schedule.normalizeName(letters); }
  /** Same word: equal without accents, and when both carry accents the accents agree too (unless loose). */
  static _same(a, b, loose) {
    const x = Schedule.normalizeName(a), y = Schedule.normalizeName(b); if (x === '' || x !== y) return false; if (loose) return true;
    const la = a.replace(/[^\p{L}\p{M}]/gu, '').normalize('NFC').toLowerCase(), lb = b.replace(/[^\p{L}\p{M}]/gu, '').normalize('NFC').toLowerCase();
    return !StaffDirectory._accented(a) || !StaffDirectory._accented(b) || la === lb;
  }
  /** A short initial (up to 3 letters, as printed "T." or "Ng") standing for the other word. */
  static _initial(shortWord, full) { const s = Schedule.normalizeName(shortWord), f = Schedule.normalizeName(full); return s !== '' && s.length <= 3 && s.length < f.length && f.startsWith(s); }
  /** 3 = same full name, 2 = same words with initials, 1 = the printed name is the last words, 0 = no match.
   *  Loose ignores accent differences; it only proposes names for the user to confirm. */
  static strength(printed, roster, loose = false) {
    const p = StaffDirectory._words(printed), r = StaffDirectory._words(roster); if (p.length === 0 || r.length === 0) return 0;
    if (!StaffDirectory._same(p[p.length - 1], r[r.length - 1], loose)) return 0;
    if (p.length === r.length) {
      let exact = true; for (let i = 0; i < p.length; i++) { const a = p[i], b = r[i]; if (StaffDirectory._same(a, b, loose)) continue; exact = false; if (i === p.length - 1 || !(StaffDirectory._initial(a, b) || StaffDirectory._initial(b, a))) return 0; }
      return exact ? 3 : 2;
    }
    if (p.length < r.length) { for (let i = 0; i < p.length; i++) if (!StaffDirectory._same(p[p.length - 1 - i], r[r.length - 1 - i], loose)) return 0; return 1; }
    return 0;
  }
  /** Every roster name at the strongest match level, excluding the calendar owner. */
  candidates(printed, owner, loose = false) {
    // A=B=C=D first: the printed name and each roster name are the same person on the staff list.
    const staff = Personnel.current(); const person = staff.unique(printed, Personnel.Source.PRINTED);
    if (person != null) { const same = [];
      for (const e of this.entries) { if (owner != null && owner !== '' && Schedule.sameName(owner, e.name)) continue; if (staff.unique(e.name, Personnel.Source.PRINTED) === person) same.push(e); }
      if (same.length !== 0) return same; }
    let best = 0; let result = [];
    for (const e of this.entries) { if (owner != null && owner !== '' && Schedule.sameName(owner, e.name)) continue; const s = StaffDirectory.strength(printed, e.name, loose); if (s === 0 || s < best) continue; if (s > best) { best = s; result = []; } result.push(e); }
    return result;
  }
  /** The single roster name for a printed name under the strict rule, or null when there is none or more than one. */
  unique(printed, owner) { const list = this.candidates(printed, owner, false); return list.length === 1 ? list[0].name : null; }
}
