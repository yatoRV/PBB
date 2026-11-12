// Port of vn.lichdilam.PipeTable (APK 4.5). TreeMap/TreeSet with the pipe comparator → JavaTreeMap/JavaTreeSet;
// unmodifiable lists → frozen copies.
import { Integer, NumberFormatException, JavaTreeMap, JavaTreeSet, Character, compareTo, split, trim } from '../platform/java.js';
import { Schedule } from './Schedule.js';

const FIRST_PIPE = 9, LAST_PIPE = 22;
const EMPTY = Object.freeze([]);

function number(pipe) { try { return Integer.parseInt(pipe); } catch (notANumber) { if (!(notANumber instanceof NumberFormatException)) throw notANumber; return null; } }
function standard(pipe) { const n = number(pipe); return n != null && n >= FIRST_PIPE && n <= LAST_PIPE; }

/** 3.1 (the user, 27/10): one assignment photo seen the way the paper reads — a row per date, a column per
 *  pipe, the people's names in the cells. Built only from what was read: an empty cell means nobody was
 *  printed on that pipe that day. Nothing is guessed and no date cycle is assumed. */
export class PipeTable {
  /** The pipes the sheets are printed with; always shown, even on a day nobody is on them. */
  static FIRST_PIPE = FIRST_PIPE; static LAST_PIPE = LAST_PIPE;
  constructor(days) {
    this.columns = [];
    this.days = days;
    /** date → pipe → the full names printed there, in the order of the photo's rows. */
    this._cells = new JavaTreeMap();
  }
  names(day, pipe) {
    const row = this._cells.get(day); const found = row == null ? null : row.get(pipe);
    return found == null ? EMPTY : Object.freeze([...found]);
  }
  /** "Nguyễn Hải Ngọc" → "N.H.Ngọc": every word before the given name becomes its first letter, and the
   *  given name itself is always written out. A name that was not read shows as "?" so the user can type it. */
  static shortName(full) { return PipeTable.nameLines(full).join(''); }
  /** 3.4 (the user): the lines a cell is written on — the family and middle names shortened on the first,
   *  the given name whole on the second ("Lê Trung Nghĩa" → "L.T." then "Nghĩa"). A cell too narrow for one
   *  line uses both, so the given name is always readable and never cut to "L.T.N…". */
  static nameLines(full) {
    const name = full == null ? '' : Schedule.normalizePerson(full);
    if (name === '') return ['?'];
    // Saved/typed initials may have no spaces ("V.V.Thanh", "N.H.Minh"). They need
    // the same two-line layout as a full name; the given name is never an initial.
    const parts = split(name.replace(/\.(?=\p{L})/gu, '. '), /[ \t\n\x0B\f\r]+/);
    if (parts.length === 1) return [parts[0]];
    let head = '';
    for (let i = 0; i < parts.length - 1; i++) { const word = parts[i].split('.').join(''); if (word === '') continue; head += Character.toUpperCase(word.charAt(0)) + '.'; }
    const given = parts[parts.length - 1];
    return head.length === 0 ? [given] : [head, given];
  }
  /** Sheet number of the photo, as the title names it. */
  static count(book) { return book == null ? 0 : Math.max(book.sheets().length, book.employees.length === 0 ? 0 : 1); }
  /** The table of one photo. A book saved before 3.1 has no per-photo rows; everything that was read is
   *  then shown as one sheet, which is what a single-photo set holds anyway. */
  static of(book, sheet) {
    const table = new PipeTable(book.month.lengthOfMonth());
    const extra = new JavaTreeSet(PipeTable.comparePipes);
    const sheets = book.sheets();
    if (sheet >= 0 && sheet < sheets.length) {
      const printed = sheets[sheet];
      for (let row = 0; row < printed.rows.length; row++) {
        const name = book.sheetName(printed.rows[row]);
        for (const [day, pipe] of printed.pipes[row]) table._put(day, pipe, name, extra);
      }
    } else if (sheets.length === 0 && sheet === 0) {
      for (const e of book.employees)
        for (const [day, value] of e.days) if (!value.conflict && value.pipe != null) table._put(day, value.pipe, e.name, extra);
    }
    for (let pipe = FIRST_PIPE; pipe <= LAST_PIPE; pipe++) table.columns.push(String(pipe));
    table.columns.push(...extra);
    return table;
  }
  _put(day, pipe, name, extra) {
    if (pipe == null || trim(pipe) === '' || day < 1 || day > this.days) return;
    const value = trim(pipe);
    if (!standard(value)) extra.add(value);
    this._cells.computeIfAbsent(day, () => new JavaTreeMap(PipeTable.comparePipes)).computeIfAbsent(value, () => []).push(name == null ? '' : name);
  }
  /** Pipe numbers in numeric order, then the printed words (QT, CĐ) after them. */
  static comparePipes(a, b) {
    const x = number(a), y = number(b);
    if (x != null && y != null) return Integer.compare(x, y);
    if (x != null) return -1;
    if (y != null) return 1;
    return compareTo(a, b);
  }
}
