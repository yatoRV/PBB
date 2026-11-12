// Port of vn.lichdilam.DayColumnDialog (APK 4.5).
// Asks for the date printed above a column whose date number OCR could not confirm. Shows the printed date
// cell, the owner's cells in that column and only dates that keep the printed dates in order. The app never
// picks one; a roster match is only a hint.
// describe() is used by js/core/UnifiedSchedule.js under Node: this module must not touch the DOM at import (the
// dialog's DOM helpers are only called from show()).
import { JavaTreeMap } from '../platform/java.js';
import { Schedule } from '../core/Schedule.js';
import { OpenColumns } from '../core/OpenColumns.js';
import { ThemeUi } from './ThemeUi.js';
import { el, textView, linear, describe as describeView, imageView, fileExists } from './Views.js';

function label(c, s, sp, role) { const t = textView(s, sp, role); t.classList.add('dcd__label'); return t; } // eslint-disable-line no-unused-vars
function image(c, box, path, description, height) { // eslint-disable-line no-unused-vars
  if (!fileExists(path)) return;
  box.append(imageView(path, description, height, 'img img--white'));
}
function join(days) { return days.join(', '); }

export class DayColumnDialog {
  static describe(v) { const a = v.assignment(); return Schedule.displayCode(v.code) + (a === '' ? '' : ' · ' + a); }
  /** choice: day → void (Java Choice.chosen); manual: Runnable or null. Returns the AlertDialog. */
  static show(c, book, column, ownerRow, work, choice, manual) {
    const box = linear(false, 'dlg-box');
    const primary = !book.hasPrimary() || column.page() === book.primaryIndex();
    box.append(label(c, 'Ảnh phân ống ' + (column.page() + 1) + (primary ? ' (ảnh chính)' : '') + ': chưa xác định ngày.', 14, ThemeUi.TEXT));
    image(c, box, column.evidence, 'Ô số ngày của cột trong ảnh gốc', 86);
    const days = column.days(); const possible = column.structured && !column.crowded && days.length !== 0;
    if (possible) box.append(label(c, days.length === 1 ? 'Ngày phù hợp: ' + days[0] + '.' : 'Ngày phù hợp: ' + join(days) + '.', 13, ThemeUi.MUTED));
    else box.append(label(c, column.structured ? 'Các ngày đọc được hai bên không còn chỗ cho cột này. Hãy kiểm tra ảnh gốc; có thể nhập thủ công từng ngày.' : 'Không xác định được cột này gồm mấy ô (đường kẻ trong ảnh không rõ). Hãy nhập thủ công các ngày liên quan.', 13, ThemeUi.WARNING));
    if (column.readings.length !== 0) {
      const seen = new JavaTreeMap(); for (const r of column.readings) seen.merge(r, 1, (a, b) => a + b); let s = '';
      for (const [k, v] of seen) s += (s.length === 0 ? '' : ', ') + k + ' (' + v + ' lần)';
      box.append(label(c, 'OCR đọc ra: ' + s + '', 12, ThemeUi.MUTED));
    }
    const owner = ownerRow == null || !primary ? null : column.valueFor(ownerRow); const hint = OpenColumns.rosterMatches(column, owner, work);
    if (owner != null) { box.append(label(c, 'Ô của bạn trong cột này: ' + DayColumnDialog.describe(owner), 14, ThemeUi.TEXT)); image(c, box, owner.evidence, 'Ô của bạn trong cột này', 54); }
    const holder = [null];
    if (possible) {
      let row = null;
      for (let i = 0; i < days.length; i++) {
        if (i % 4 === 0) { row = linear(true, 'grid4'); box.append(row); }
        const day = days[i]; const b = el('button', 'btn btn--cell', 'Ngày ' + day + (hint.length === 1 && hint[0] === day ? ' ✓' : '')); b.type = 'button'; describeView(b, 'Chọn ngày ' + day + ' cho cột này');
        b.addEventListener('click', () => { holder[0].dismiss(); choice(day); }); row.append(b);
      }
      for (let i = days.length % 4 === 0 ? 4 : days.length % 4; i < 4 && row != null; i++) row.append(el('div', 'grid4__spacer'));
    }
    const builder = new ThemeUi.DialogBuilder(c); builder.setTitle('Chọn ngày cho cột chưa đọc được').setView(box).setNegativeButton('Để sau', null);
    if (manual != null) builder.setNeutralButton('Nhập thủ công', () => manual());
    holder[0] = builder.create(); holder[0].show(); return holder[0];
  }
}
