// Port of vn.lichdilam.OpenColumns (APK 4.5).
import { IllegalArgumentException } from '../platform/java.js';
import { File } from '../platform/files.js';
import { PipeBook } from './PipeBook.js';
import { PipeSourceCache } from './PipeSourceCache.js';

/** Applies the date the user read above an open column. The decision is written into that photo's saved
 *  OCR record (so reading the same photo again keeps it) and the set of photos is rebuilt from the records. */
export class OpenColumns {
  static choose(filesDir, merged, column, day, nameCorrections) {
    if (!merged.hasPrimary() || column.page() < 0 || column.page() >= merged.sourceImages().length) throw new IllegalArgumentException('Không xác định được ảnh của cột này. Hãy đọc lại bộ ảnh phân ống.');
    const cache = new PipeSourceCache(filesDir); const paths = [...merged.sourceImages()]; const pages = [];
    for (let i = 0; i < paths.length; i++) {
      const page = cache.load(new File(paths[i]), merged.month);
      if (page == null) throw new IllegalArgumentException('Kết quả đọc ảnh ' + (i + 1) + ' không còn trong máy. Bấm "Cập nhật OCR từ ảnh đã lưu" rồi chọn lại ngày cho cột.'); pages.push(page);
    }
    const page = pages[column.page()]; page.chooseColumnDay(column.start, column.end, day); cache.save(new File(paths[column.page()]), page);
    const rebuilt = PipeBook.fromPages(pages, paths, merged.primaryIndex()); rebuilt.correctNames(nameCorrections);
    return PipeBook.overlay(merged, rebuilt);
  }
  /** Dates of the owner's work roster that carry the same shift as the owner's cell in this column. Shown as a
   *  hint only; the user still reads the printed date and decides. */
  static rosterMatches(column, owner, work) {
    const result = []; if (owner == null || owner.code == null || work == null) return result;
    for (const day of column.days()) if (day >= 1 && day <= work.shifts.length && owner.code === work.shifts[day - 1]) result.push(day);
    return result;
  }
}
