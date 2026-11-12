// Port of vn.lichdilam.RosterRows (APK 4.5). Java \s is ASCII ([ \t\n\x0B\f\r]); int[] → Int32Array.
import { trim } from '../platform/java.js';
import { Personnel } from './Personnel.js';
import { Schedule } from './Schedule.js';

class Choice {
  constructor() { this.row = -1; this.number = 0; this.person = null; this.identityMatches = false; this.error = null;
    /** All rows that could be the user's when the choice is not unique (shown to the user, never picked). */
    this.alternatives = []; }
}
function fold(s) { return trim((s == null ? '' : s).normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9]+/g, ' ')); }

/** Which work-roster row belongs to the user, from what OCR read in the STT and name columns.
 *  The user gives a name, an STT, or both; names go through A=B=C=D (Personnel). Count rows under the table
 *  ("S26 · Ca S26: 8h-16h", "Tổng 8h-16h", "Tổng số 18h-06h+") are never staff rows and never STT candidates. */
export class RosterRows {
  static Choice = Choice;
  /** The printed STT: digits only (OCR O/I/l inside a number are read as 0/1); anything else is not an STT. */
  static serial(raw) {
    // Rules of the cell are read as | [ ] ( ) or as a trailing I/l after the digits ("4I" is 4, "1S]" stays unknown).
    let s = (raw == null ? '' : raw).replace(/[ \t\n\x0B\f\r.|:,'"[\](){}]/g, '');
    if (/^[0-9]{1,2}[Il]$/.test(s)) s = s.substring(0, s.length - 1);
    if (/^[Il][0-9]{1,2}$/.test(s)) s = s.substring(1);
    if (/^[SsCcDd][0-9OoIl]{1,2}$/.test(s)) return -1;   // a shift code (S10, C23, D5), never an STT
    if (s.length === 0 || s.length > 3 || !/^[0-9OoIlS]+$/.test(s) || !/^.*[0-9].*$/.test(s)) return -1;
    // Inside a number cell next to a real digit: O/o → 0, I/l → 1, S → 5 ("1S" is 15).
    s = s.replace(/O/g, '0').replace(/o/g, '0').replace(/I/g, '1').replace(/l/g, '1').replace(/S/g, '5'); return parseInt(s, 10);
  }
  /** Printed STTs climb by one or skip; an unread STT whose neighbours are k-1 and k+1 is k. Used only as a
   *  hint for the row of a person on the list, never as a confirmation. */
  static serials(raw, summary, header = new Array(raw.length).fill(false)) {
    const s = new Int32Array(raw.length); for (let r = 0; r < raw.length; r++) s[r] = summary[r] || header[r] ? -1 : RosterRows.serial(raw[r]);
    const out = s.slice();
    for (let r = 0; r < raw.length; r++) {
      if (s[r] >= 0 || summary[r] || header[r]) continue;
      let a = r - 1; while (a >= 0 && s[a] < 0 && !summary[a] && !header[a]) a--; let b = r + 1; while (b < raw.length && s[b] < 0 && !summary[b] && !header[b]) b++;
      const known = a >= 0 && s[a] > 0, after = b < raw.length && s[b] > 0;
      // Only a run whose ends count by one per row (no printed gap inside) can be filled.
      if (known && after) { if (s[b] - s[a] === b - a) out[r] = s[a] + (r - a); }
      else if (after && s[b] - (b - r) >= 1) out[r] = s[b] - (b - r);
      else if (known) out[r] = s[a] + (r - a);
    }
    return out;
  }
  /** STTs printed in a pipe photo's first column, from row firstRow on. A number is kept only when it is the
   *  row person's work-roster STT (the T.T. Vinh sheet) or when the column counts by one and the number fits
   *  its neighbours (sheets with their own 1…n numbering). Anything else stays 0: lookup by name. */
  static sheetNumbers(stt, names, firstRow, staff) {
    const n = stt.length; const s = new Int32Array(n), out = new Int32Array(n); for (let r = 0; r < n; r++) s[r] = r < firstRow ? -1 : RosterRows.serial(stt[r]);
    let pairs = 0, counting = 0; for (let r = firstRow; r + 1 < n; r++) if (s[r] > 0 && s[r + 1] > 0) { pairs++; if (s[r + 1] === s[r] + 1) counting++; }
    const counts = pairs >= 3 && counting >= pairs * 0.7;
    for (let r = firstRow; r < n; r++) {
      if (s[r] <= 0) continue;
      const p = staff.unique(names[r], Personnel.Source.PRINTED);
      const own = p != null && p.workStt === s[r];
      const fits = counts && (r > firstRow && s[r - 1] > 0 && s[r] === s[r - 1] + 1 || r + 1 < n && s[r + 1] > 0 && s[r + 1] === s[r] + 1);
      if (own || fits) out[r] = s[r];
    }
    return out;
  }
  /** Header rows above the staff ("STT · Name of staff", "Họ và tên"). */
  static header(name) {
    const b = fold(name); return b.includes('name of staff') || /^(?:(stt )?(ho va ten|ho ten|ten nhan vien))$/.test(b) || b === 'stt'
      // Notes printed under the table ("LƯU Ý: Các vị trí…", "Ghi chú") are not staff rows either.
      || /^(?:(luu y|ghi chu|chu y)\b.*)$/.test(b);
  }
  /** A count row: its first column or label is a shift code or an hour total. */
  static summary(serial, name) {
    const a = fold(serial), b = fold(name);
    if (/^(?:(s26|s10|s17|c23|d5|d6|0h|8h|16h|18h|00h)( .*)?)$/.test(a)) return true;
    return /^(?:ca [scd] ?[0-9]+.*)$/.test(b) || /^(?:tong( so)?( nhan su)?( [0-9]+ ?h.*)?)$/.test(b) || b.startsWith('tong ');
  }
  /** Rows from the first count row to the end of the table are count rows. */
  static summaryRows(serials, names) {
    const out = new Array(names.length).fill(false); let below = false;
    for (let r = 0; r < names.length; r++) { if (RosterRows.summary(serials[r], names[r])) below = true; out[r] = below; }
    return out;
  }
  static choose(serials, names, number, typed, staff) {
    const c = new Choice(); const summary = RosterRows.summaryRows(serials, names);
    typed = Schedule.normalizePerson(typed); let meant = null;
    if (typed.length > 0) {
      const people = staff.resolve(typed, Personnel.Source.TYPED);
      if (people.length > 1) { let list = ''; for (const p of people) list += '\n• ' + p; c.error = 'Tên “' + typed + '” khớp nhiều người. Nhập họ tên đầy đủ hoặc STT:' + list; return c; }
      if (people.length === 0 && !staff.isEmpty()) {
        const near = staff.unique(typed, Personnel.Source.PRINTED);
        c.error = near != null ? 'Không có “' + typed + '” trong danh sách nhân sự. Có phải ' + near.name + '?' : 'Không có “' + typed + '” trong danh sách nhân sự. Kiểm tra họ tên, nhập STT, hoặc thêm người này vào danh sách.'; return c;
      }
      if (people.length === 1) meant = people[0];
    }
    const head = new Array(names.length).fill(false); for (let r = 0; r < names.length; r++) head[r] = RosterRows.header(names[r]);
    const score = new Int32Array(names.length), inferred = RosterRows.serials(serials, summary, head); let best = 0;
    for (let r = 0; r < names.length; r++) {
      if (summary[r] || head[r]) continue;
      const s = RosterRows.serial(serials[r]);
      // Printed STT = 4; an STT known only from its neighbours (unread cell between k-1 and k+1) = 2.
      const byNumber = number > 0 ? (s === number ? 4 : s < 0 && inferred[r] === number ? 2 : 0) : 0;
      const rowPerson = staff.unique(names[r], Personnel.Source.PRINTED);
      // A name read with one wrong letter is only a weak sign (2) and never confirms the row by itself.
      const byName = meant != null ? (rowPerson === meant ? 4 : rowPerson == null && staff.closest(names[r]) === meant ? 2 : 0) : typed.length > 0 && Schedule.sameName(typed, names[r]) ? 4 : 0;
      // Without a typed STT, the person's STT on the confirmed list is a weaker hint than the printed name.
      const byListStt = number <= 0 && meant != null && meant.workStt > 0 && (s === meant.workStt || s < 0 && inferred[r] === meant.workStt) ? 1 : 0;
      score[r] = byNumber + byName + byListStt; best = Math.max(best, score[r]);
    }
    if (best === 0) { c.error = null; return c; }
    for (let r = 0; r < names.length; r++) if (score[r] === best) c.alternatives.push(r);
    if (c.alternatives.length !== 1) {
      c.error = number > 0 && meant != null && best === 4 ? 'STT ' + number + ' và tên ' + meant.name + ' nằm ở hai hàng khác nhau trên ảnh. Kiểm tra lại STT hoặc họ tên.'
        : 'Có nhiều hàng trùng STT/tên trên ảnh. Nhập thêm STT hoặc họ tên đầy đủ.'; return c;
    }
    c.row = c.alternatives[0]; const s = RosterRows.serial(serials[c.row]);
    const rowPerson = staff.unique(names[c.row], Personnel.Source.PRINTED);
    // Confirmed only by what is printed and read on that row: an exact name and/or a printed STT.
    const nameOk = typed.length === 0 || (meant != null ? rowPerson === meant : Schedule.sameName(typed, names[c.row]));
    const numberOk = number <= 0 || s === number;
    c.identityMatches = nameOk && numberOk && (typed.length > 0 || number > 0 && s === number);
    c.person = meant != null ? meant : rowPerson;
    c.number = s > 0 ? s : inferred[c.row] > 0 ? inferred[c.row] : number > 0 ? number : c.person != null ? c.person.workStt : 0;
    return c;
  }
}
