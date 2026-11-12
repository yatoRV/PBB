// Port of vn.lichdilam.UnifiedSchedule (APK 4.5). combine(work, pipe) and combine(work, pipe, book) are the two
// Java overloads, chosen by the number of arguments (the 3-argument form also when book is null).
import { IllegalArgumentException, Objects } from '../platform/java.js';
import { Schedule } from './Schedule.js';
import { CalendarIssue } from './CalendarIssue.js';
import { PipeDay } from './PipeDay.js';
import { PipeRules } from './PipeRules.js';
import { PipeBook } from './PipeBook.js';
import { DayColumnDialog } from '../ui/DayColumnDialog.js';

const rethrowUnlessIae = e => { if (!(e instanceof IllegalArgumentException)) throw e; };

/** Read-only view: work codes plus matching assignments, never rewriting either source. */
export class UnifiedSchedule {
  static sameOwner(a, b) { return a != null && b != null && a.month.equals(b.month) && Schedule.sameName(a.employeeName, b.employeeName); }
  static combine(work, pipe, book) { return arguments.length >= 3 ? UnifiedSchedule._combineWithBook(work, pipe, book) : UnifiedSchedule._combine(work, pipe); }
  static _combine(work, pipe) {
    work = work == null ? null : work.copy(); pipe = pipe == null ? null : pipe.copy();
    if (work == null) return pipe == null ? null : pipe.copy();
    if (!UnifiedSchedule.sameOwner(work, pipe)) return work.copy();
    const count = work.shifts.length; const codes = [...work.shifts], people = [...work.swapPeople], pipes = new Array(count).fill(null), duties = new Array(count).fill(null); const numbers = [...work.swapNumbers];
    const issues = new Array(count).fill(null);
    for (let d = 0; d < count; d++) {
      if (!pipe.present[d]) { pipes[d] = ''; duties[d] = ''; continue; }
      if (codes[d] == null) { codes[d] = pipe.shifts[d]; people[d] = pipe.swapPeople[d]; numbers[d] = pipe.swapNumbers[d]; }
      else if (people[d] === '' && pipe.swapPeople[d] !== '' && Objects.equals(codes[d], pipe.shifts[d])) { people[d] = pipe.swapPeople[d]; numbers[d] = pipe.swapNumbers[d]; }
      const samePerson = Schedule.normalizeName(people[d]) === Schedule.normalizeName(pipe.swapPeople[d]);
      // OFF and P are both a day off: a leave on one sheet and an empty cell on the other agree.
      if ((Objects.equals(codes[d], pipe.shifts[d]) || codes[d] != null && pipe.shifts[d] != null && Schedule.dayOff(codes[d]) && Schedule.dayOff(pipe.shifts[d])) && samePerson) { pipes[d] = pipe.pipes[d]; duties[d] = pipe.duties[d]; }
      else {
        pipes[d] = null; duties[d] = null;
        let source = 'Lịch đi làm: ' + Schedule.displayCode(codes[d]) + '. Lịch phân ống: ' + Schedule.displayCode(pipe.shifts[d]);
        if (pipe.shifts[d] != null && pipe.shifts[d] !== '' && pipe.shifts[d] !== 'P') source += ' · ' + new PipeDay(pipe.shifts[d], pipe.pipes[d], pipe.duties[d], '', '').assignment();
        if (!samePerson) issues[d] = new CalendarIssue('Khác người', source + '. Hai lịch đang ghi người đổi ca khác nhau; chưa ghép phân ống.');
        else if (pipe.shifts[d] == null) issues[d] = new CalendarIssue('?', source + '. Chưa đọc rõ mã ca trong ảnh phân ống; chưa ghép số ống.');
        else issues[d] = new CalendarIssue('Khác Ca', source + '. Hai nguồn khác ca. Giữ lịch đi làm và chờ bạn đối chiếu; không tự gán phân ống.');
      }
      if (codes[d] === '' || codes[d] === 'P') { pipes[d] = ''; duties[d] = ''; }
    }
    const present = [...work.present]; for (let d = 0; d < count; d++) present[d] = present[d] || pipe.present[d];
    const view = new Schedule(Schedule.COMBINED, work.month, work.employeeNumber, work.employeeName, codes, people, numbers, pipes, duties).withPresence(present);
    for (let i = 0; i < count; i++) view.issues[i] = issues[i]; return view;
  }
  /** Complete a previously saved swap from the counterpart's row, never from the owner's row. */
  static _combineWithBook(work, pipe, book) {
    // Recover missing personal dates from their uniquely identified source row.
    // Presence means a printed date, including a verified OFF; never infer a date.
    if (work != null && book != null && book.month.equals(work.month) && (pipe == null || UnifiedSchedule.sameOwner(work, pipe))) try {
      const fromBook = book.personalByName(work.employeeName, work);
      if (UnifiedSchedule.sameOwner(work, fromBook)) {
        if (book.hasPrimary()) {
          // The selected source owns every unswapped date, even if a
          // legacy personal record already contains a blank/stale value.
          if (pipe != null) for (let d = 0; d < fromBook.shifts.length; d++) if (pipe.present[d] && (pipe.swapPeople[d] !== '' || work.swapPeople[d] !== '')) {
            fromBook.present[d] = true; fromBook.shifts[d] = pipe.shifts[d]; fromBook.pipes[d] = pipe.pipes[d]; fromBook.duties[d] = pipe.duties[d]; fromBook.swapPeople[d] = pipe.swapPeople[d]; fromBook.swapNumbers[d] = pipe.swapNumbers[d];
          }
          pipe = fromBook;
        } else pipe = pipe == null ? fromBook : Schedule.mergeMissingDays(pipe, fromBook);
      }
    } catch (missingOrAmbiguousOwner) { rethrowUnlessIae(missingOrAmbiguousOwner); /* Do not borrow a similar name. */ }
    const view = UnifiedSchedule._combine(work, pipe);
    if (view == null || work == null || book == null || !book.month.equals(work.month) || (pipe != null && !UnifiedSchedule.sameOwner(work, pipe))) return view;
    if (view.kind === Schedule.WORK) { view.pipes.fill(''); view.duties.fill(''); }
    let assigned = false;
    // A contradictory pair of source images is not an empty cell or an OCR miss.
    // Keep an explicitly resolved, complete personal assignment if one was saved.
    try {
      const owner = book.owner(work.employeeName); for (let d = 0; d < view.shifts.length; d++) {
        const source = owner.days.get(d + 1); if (source == null || !source.conflict || view.swapPeople[d] !== '') continue;
        if (pipe != null && pipe.present[d] && new PipeDay(pipe.shifts[d], pipe.pipes[d], pipe.duties[d], '', '').complete()) continue;
        view.issues[d] = new CalendarIssue('Khác Ca', 'Các ảnh phân ống đã lưu ghi dữ liệu khác nhau cho cùng người/ngày. Giữ mã ca ' + Schedule.displayCode(view.shifts[d]) + ' từ lịch đi làm; cần đối chiếu ảnh nguồn.'); assigned = true;
      }
    } catch (missingOrAmbiguousOwner) { rethrowUnlessIae(missingOrAmbiguousOwner); /* Never guess which row owns the date. */ }
    for (let d = 0; d < view.shifts.length; d++) {
      const code = view.shifts[d], person = view.swapPeople[d];
      if (person === '') continue;
      // A swap the photos could not give a code for (3.0): "Khác Ca" when the counterpart's photos disagree or
      // show a word instead of a code that day (another roster); otherwise the day stays "?".
      if (code == null) {
        try {
          const source = book.findByName(person).days.get(d + 1);
          if (source != null && (source.conflict || PipeRules.printedWord(source.code))) {
            view.pipes[d] = ''; view.duties[d] = '';
            view.issues[d] = new CalendarIssue('Khác Ca', 'Lịch phân ống của ' + person + ' ngày ' + (d + 1) + ': ' + (source.conflict ? 'các ảnh ghi khác nhau' : 'ghi «' + source.code + '» thay cho mã ca') + '. Có thể hôm đó người này làm theo lịch/ca khác; cần đối chiếu ảnh nguồn.');
          }
        } catch (missingOrAmbiguousName) { rethrowUnlessIae(missingOrAmbiguousName); /* stays ? */ }
        continue;
      }
      if (code === '' || code === 'P') continue;
      // Explicit, matching personal-calendar assignments take precedence over source OCR.
      if (pipe != null && pipe.present[d] && view.kind !== Schedule.WORK && view.dayComplete(d)) continue;
      try {
        const source = book.findByName(person).days.get(d + 1);
        if (source == null) continue;
        if (source.conflict || source.code != null && code !== source.code) {
          view.pipes[d] = ''; view.duties[d] = ''; view.issues[d] = new CalendarIssue('Khác Ca', 'Lịch đi làm: ' + Schedule.displayCode(code) + '. Lịch phân ống của ' + person + ': ' + Schedule.displayCode(source.code) + (source.conflict ? '. Các ảnh phân ống không khớp nhau.' : '. Hai nguồn khác ca; giữ mã ca lịch đi làm.')); assigned = true; continue;
        }
        if (!source.complete()) continue;
        if (view.kind !== Schedule.WORK && view.issues[d] == null && view.pipes[d] != null && view.pipes[d] !== source.pipe) continue;
        view.pipes[d] = source.pipe; view.duties[d] = source.duty; view.issues[d] = null; assigned = true;
      } catch (missingOrAmbiguousName) { rethrowUnlessIae(missingOrAmbiguousName); /* Keep ?; never choose a different person. */ }
    }
    // Dates an open column of the owner's photo may hold: say why they are unknown and what is waiting.
    let ownerRow = null; try { ownerRow = book.owner(work.employeeName).name; } catch (missingOrAmbiguousOwner) { rethrowUnlessIae(missingOrAmbiguousOwner); }
    for (const c of book.ownerOpenColumns()) {
      const held = ownerRow == null ? null : c.valueFor(ownerRow);
      for (const day of c.days()) if (day >= 1 && day <= view.shifts.length && view.issues[day - 1] != null && view.issues[day - 1].label === '?')
        view.issues[day - 1] = new CalendarIssue('?', 'Ảnh phân ống có một cột chưa đọc được số ngày, có thể là ngày ' + PipeBook.range(c) + '.' + (held == null ? '' : ' Ô của bạn trong cột đó: ' + DayColumnDialog.describe(held) + '.') + ' Chạm để chọn đúng ngày cho cột; app không tự chọn.');
    }
    if (!assigned) return view;
    const combined = new Schedule(Schedule.COMBINED, view.month, view.employeeNumber, view.employeeName, view.shifts, view.swapPeople, view.swapNumbers, view.pipes, view.duties).withPresence(view.present);
    for (let i = 0; i < view.issues.length; i++) combined.issues[i] = view.issues[i]; return combined;
  }
}
