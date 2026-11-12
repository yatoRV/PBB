// Port of vn.lichdilam.PipeHeaders (APK 4.5). Java float math via Math.fround; Java \s / \d are ASCII.
// List<int[]> → array of int arrays; List<Integer> → array of numbers (null allowed where Java allows null).
import { IllegalArgumentException, FLOAT_MAX, Double, trim } from '../platform/java.js';

const f = Math.fround;
const EMPTY = Object.freeze([]);

class Token { constructor(text, x, y) { this.text = text; this.x = f(x); this.y = f(y); Object.freeze(this); } }
class Group { constructor(day, start, end, headerRow) { this.day = day; this.start = start; this.end = end; this.headerRow = headerRow; Object.freeze(this); } }
/** A printed day column whose date is not confirmed. Its cells are still read and kept. */
class Open { constructor(start, end, headerRow, structured, readings) { this.start = start; this.end = end; this.headerRow = headerRow; this.structured = structured; this.readings = readings; Object.freeze(this); } }
/** Every data column of the table: confirmed dates plus columns whose date still needs the user. */
class Layout {
  /** numbered: the date row was read by its printed numbers (team T5): every day is two subcolumns, code | pipe and duty. */
  constructor(groups, open, numbered = false) { this.groups = groups; this.open = open; this.numbered = numbered; Object.freeze(this); }
}

// A slash in a small serif title is often read as |, \, l or I.
const S = '[ \\t\\n\\x0B\\f\\r]*', SEP = '[/.|\\\\lI]';
const PERIOD = new RegExp('(\\d{1,2})' + S + SEP + S + '(\\d{1,2})' + S + SEP + S + '(\\d{2,4})' + S + '[-–—~]+' + S + '(\\d{1,2})' + S + SEP + S + '(\\d{1,2})' + S + SEP + S + '(\\d{2,4})', 'g');
const isDayToken = t => /^[0-9]{1,2}$/.test(t);
function sameYear(printed, year) { return printed === year || printed < 100 && printed === year % 100; }
function orderedLength(days, maxDay, omitted) {
  const length = new Int32Array(days.length); let best = 0;
  for (let i = 0; i < days.length; i++) {
    const day = days[i]; if (i === omitted || day == null || day < 1 || day > maxDay) continue; length[i] = 1;
    for (let j = 0; j < i; j++) if (length[j] > 0 && days[j] < day) length[i] = Math.max(length[i], length[j] + 1); best = Math.max(best, length[i]);
  }
  return best;
}

/** Maps actual printed day headers onto groups of 2 or 3 ruled columns. */
export class PipeHeaders {
  static Token = Token; static Group = Group; static Open = Open; static Layout = Layout;
  static parse(tokens, columns, rows, maxDay) {
    // Without merged-border evidence, do not treat the first employee's
    // numeric pipe assignments (third grid row) as missing date headers.
    for (let row = 0; row < Math.min(2, rows.length - 1); row++) {
      const dates = [];
      for (const t of tokens) if (t.x > columns[2] && t.y > rows[row] && t.y < rows[row + 1] && isDayToken(t.text)) {
        const day = parseInt(t.text, 10); if (day >= 1 && day <= maxDay) dates.push(t);
      }
      dates.sort((a, b) => Double.compare(a.x, b.x)); if (dates.length === 0) continue;
      // Keep the established curved-header fit when every detected token
      // forms a valid group. Otherwise recover independent groups below.
      const complete = []; let begin = 2, previous = 0, valid = true;
      for (let i = 0; i < dates.length; i++) {
        const day = parseInt(dates[i].text, 10); let end = columns.length - 1;
        if (i + 1 < dates.length) {
          const target = f(f(dates[i].x + dates[i + 1].x) / 2); let best = FLOAT_MAX;
          for (let c = begin + 1; c < columns.length - 1; c++) if (Math.abs(f(columns[c] - target)) < best) { best = Math.abs(f(columns[c] - target)); end = c; }
        }
        const center = f(f(columns[begin] + columns[end]) / 2), width = f(columns[end] - columns[begin]);
        if (day <= previous || (end - begin !== 2 && end - begin !== 3) || Math.abs(f(dates[i].x - center)) > f(width * f(.24))) { valid = false; break; }
        complete.push(new Group(day, begin, end, row)); begin = end; previous = day;
      }
      if (valid && complete.length > 0) return complete;
      const spans = [], numbers = [];
      for (const date of dates) {
        let chosen = null, ambiguous = false;
        for (let start = 2; start < columns.length - 1; start++) for (let size = 2; size <= 3 && start + size < columns.length; size++) {
          const end = start + size; const center = f(f(columns[start] + columns[end]) / 2), width = f(columns[end] - columns[start]);
          if (Math.abs(f(date.x - center)) <= f(width * f(.14))) { if (chosen != null) ambiguous = true; chosen = [start, end]; }
        }
        if (chosen != null && !ambiguous) { spans.push(chosen); numbers.push(parseInt(date.text, 10)); }
      }
      for (let i = 0; i < spans.length; i++) for (let j = i + 1; j < spans.length; j++) if (spans[i][1] > spans[j][0]) { numbers[i] = null; numbers[j] = null; }
      const groups = PipeHeaders.confirmed(spans, numbers, row, maxDay); if (groups.length > 0) return groups;
    }
    throw new IllegalArgumentException('Chưa xác định được ngày nào cùng vị trí cột tương ứng. Cần đọc được ít nhất một số ngày để đặt lịch đúng ngày.');
  }
  /** A day header holds only a number: letters that are drawn like digits are read as those digits. */
  static headerDigits(raw) {
    // A cell border read beside the date ("10 |", "| 7") is not a 1 when a space separates it: 26/10, the user's
    // T5 photo read "10 |" seven times and day 10 was lost to one "30".
    if (raw == null) return null;
    let s = trim(raw).replace(/^[|!][ \t\n\x0B\f\r]+/, '').replace(/[ \t\n\x0B\f\r]+[|!]$/, '').replace(/[ \t\n\x0B\f\r]+/g, '').replace(/[.,:;'`"_-]+$/, '').replace(/^[.,:;'`"_-]+/, '');
    // 3.7: the full T5 image reads day 17 as "|17" without a separating space.
    // Three characters with a LEADING bar and two actual digits cannot be a day number.
    // Keep two-character readings such as "|7" unchanged: there the bar can be digit 1.
    s = s.replace(/^[|!](?=[0-9]{2}$)/, '');
    let out = '';
    for (const ch of s.split('')) { const d = ch === 'I' || ch === 'l' || ch === '|' || ch === '!' || ch === 'i' ? '1' : ch === 'O' || ch === 'o' || ch === 'D' || ch === 'Q' ? '0' : ch === 'S' || ch === 's' ? '5' : ch === 'Z' || ch === 'z' ? '2' : ch === 'B' ? '8' : ch; out += d; }
    const digits = out; return /^[0-9]{1,2}$/.test(digits) ? String(parseInt(digits, 10)) : null;
  }
  /** Independent readings of one header cell: readings of the isolated cell and readings taken from a
   *  montage of all header cells (which can borrow a neighbour's digit). A date is accepted when at least
   *  two readings agree, one of them of the isolated cell, and every other date is read at most half as
   *  often; otherwise the column stays open. */
  static vote(isolated, montage, maxDay) {
    // Java HashMap: the result does not depend on its iteration order (the runner-up is the maximum of all
    // other counts whatever the order), so a Map is used.
    const count = new Map(); const seenAlone = new Set();
    for (const r of isolated) { const d = PipeHeaders.headerDigits(r); if (d == null) continue; const day = parseInt(d, 10); if (day >= 1 && day <= maxDay) { count.set(day, (count.get(day) ?? 0) + 1); seenAlone.add(day); } }
    for (const r of montage) { const d = PipeHeaders.headerDigits(r); if (d == null) continue; const day = parseInt(d, 10); if (day >= 1 && day <= maxDay) count.set(day, (count.get(day) ?? 0) + 1); }
    let best = null, top = 0, other = 0;
    for (const [key, value] of count) if (value > top) { other = Math.max(other, top); top = value; best = key; } else other = Math.max(other, value);
    return best != null && top >= 2 && top >= 2 * other && seenAlone.has(best) ? best : null;
  }
  /** 27/10 (the user: pipe sheets do not always follow a fixed cycle of dates, so none is assumed): a column the vote
   *  left open that lies between two dates already read takes the one number its own isolated readings give inside
   *  that gap (between 6 and 9, a single clear "7"), when they give exactly one such number. Columns before the first
   *  or after the last date stay open, as do open columns that would take the same date or break the order. */
  static fillBetween(days, isolated, maxDay) {
    const filled = new Array(days.length).fill(null);
    for (let i = 0; i < days.length; i++) {
      if (days[i] != null) continue;
      let low = null, high = null; for (let j = i - 1; j >= 0 && low == null; j--) low = days[j]; for (let j = i + 1; j < days.length && high == null; j++) high = days[j];
      if (low == null || high == null) continue; const inside = new Set();
      for (const v of PipeHeaders.numbers(isolated[i], maxDay)) if (v > low && v < high) inside.add(v);
      if (inside.size === 1) filled[i] = inside.values().next().value;
    }
    for (let i = 0; i < filled.length; i++) if (filled[i] != null) {
      let clash = false;
      for (let j = 0; j < filled.length; j++) if (j !== i && filled[j] != null && (j < i ? filled[j] >= filled[i] : filled[j] <= filled[i])) clash = true;
      if (!clash) days[i] = filled[i];
    }
  }
  static numbers(readings, maxDay) {
    const out = []; for (const r of readings) { const d = PipeHeaders.headerDigits(r); if (d != null) { const day = parseInt(d, 10); if (day >= 1 && day <= maxDay) out.push(day); } } return out;
  }
  /** Physical column segments between full-height header borders, including irregular ones (1 or 4+
   *  columns) that {@link #spans} leaves out; those must not disappear from the calendar silently. */
  static segments(boundaryStrength) {
    const result = []; let start = 2;
    for (let end = 3; end < boundaryStrength.length; end++) if (end === boundaryStrength.length - 1 || boundaryStrength[end] >= f(.60)) { result.push([start, end]); start = end; }
    return result;
  }
  /** Proposes a merged crop when a digit stem divides one otherwise merged day header into two single
   *  subcolumns. Only an isolated pair is unambiguous: 1+2, longer runs and predominantly single-column
   *  headers keep their original structure. This supplies no date; the isolated OCR vote must still read
   *  and confirm the actual number in the proposed crop. Input segments are never modified. */
  static repairSplitSegments(segments) {
    const copy = []; let normal = 0, single = 0, ordered = true, previous = -1;
    for (const segment of segments) {
      copy.push(segment.slice()); const width = segment[1] - segment[0]; if (width === 2 || width === 3) normal++; if (width === 1) single++;
      if (width <= 0 || segment[0] < previous) ordered = false; previous = segment[1];
    }
    if (!ordered || normal < 3 || single < 2 || single >= f(segments.length * f(.7))) return copy;
    const repaired = [];
    for (let i = 0; i < copy.length;) {
      const first = copy[i]; if (first[1] - first[0] !== 1) { repaired.push(first); i++; continue; }
      let end = i + 1; while (end < copy.length && copy[end][1] - copy[end][0] === 1 && copy[end - 1][1] === copy[end][0]) end++;
      if (end - i === 2) repaired.push([first[0], copy[end - 1][1]]); else for (let j = i; j < end; j++) repaired.push(copy[j]);
      i = end;
    }
    return repaired;
  }
  /** Splits a run of data columns that no confirmed date covers into day groups: 2 or 3 columns is one
   *  day, 4 columns can only be two 2-column days; any other width keeps its structure unknown. */
  static uncovered(groups, firstColumn, lastBoundary, headerRow) {
    const covered = new Array(lastBoundary + 1).fill(false); for (const g of groups) for (let c = g.start; c < g.end && c < covered.length; c++) covered[c] = true;
    const result = []; let c = firstColumn;
    while (c < lastBoundary) { if (covered[c]) { c++; continue; } const start = c; while (c < lastBoundary && !covered[c]) c++; result.push(...PipeHeaders.split(start, c, headerRow, EMPTY)); }
    return result;
  }
  static split(start, end, headerRow, readings) {
    const width = end - start; const result = [];
    if (width === 2 || width === 3) result.push(new Open(start, end, headerRow, true, readings));
    else if (width === 4) { result.push(new Open(start, start + 2, headerRow, true, EMPTY)); result.push(new Open(start + 2, end, headerRow, true, EMPTY)); }
    else if (width > 0) result.push(new Open(start, end, headerRow, false, readings));
    return result;
  }
  /** The period printed in the sheet title ("TỪ 16/10/2026 - 31/10/2026"): {first day, last day} of this month,
   *  or null when no such printed range is found. Only bounds open columns; it never dates a column itself. */
  static printedPeriod(text, month) {
    if (text == null) return null;
    for (const line of text.split('\n')) {
      const m = new RegExp(PERIOD.source, 'g'); const input = line.replace(/O/g, '0').replace(/o/g, '0'); let g;
      while ((g = m.exec(input)) !== null) {
        const d1 = parseInt(g[1], 10), m1 = parseInt(g[2], 10), y1 = parseInt(g[3], 10), d2 = parseInt(g[4], 10), m2 = parseInt(g[5], 10), y2 = parseInt(g[6], 10);
        if (m1 !== month.getMonthValue() || m2 !== month.getMonthValue() || !sameYear(y1, month.getYear()) || !sameYear(y2, month.getYear())) continue;
        if (d1 >= 1 && d2 <= month.lengthOfMonth() && d1 <= d2) return [d1, d2];
      }
    }
    return null;
  }
  /** Printed full-height header separators, unlike internal shift/pipe subcolumns. */
  static spans(boundaryStrength) {
    const spans = []; let start = 2;
    for (let end = 3; end < boundaryStrength.length; end++) if (end === boundaryStrength.length - 1 || boundaryStrength[end] >= f(.60)) {
      if (end - start === 2 || end - start === 3) spans.push([start, end]); start = end;
    }
    if (spans.length === 0) throw new IllegalArgumentException('Chưa xác định được vị trí nhóm cột ngày.'); return spans;
  }
  /** Every confirmed date retains its physical columns even when neighbours are unreadable. */
  static confirmed(spans, days, row, maxDay) {
    if (spans.length !== days.length) throw new IllegalArgumentException('Số vùng ngày không khớp.');
    // Keep only dates shared by every longest increasing reading. A single
    // rotated digit near the right edge must not discard all earlier days.
    // Tied alternatives (including duplicate dates) are both left unresolved.
    const longest = orderedLength(days, maxDay, -1);
    const result = []; for (let i = 0; i < days.length; i++) if (orderedLength(days, maxDay, i) < longest) { const span = spans[i]; result.push(new Group(days[i], span[0], span[1], row)); }
    return result;
  }
}
