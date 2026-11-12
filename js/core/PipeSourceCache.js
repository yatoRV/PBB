// Port of vn.lichdilam.PipeSourceCache (APK 4.5). Files live in the virtual app storage (js/platform/files.js),
// which is synchronous like java.io. The interrupt check reads the job's thread (Thread.currentThread() of java.js).
import { IOException, InterruptedException, Thread, MessageDigest, format, utf8Encode, utf8Decode, compareTo, matches } from '../platform/java.js';
import { File, Files, FileOutputStream, StandardCopyOption } from '../platform/files.js';
import { JSONObject } from '../platform/json.js';
import { PipeBook } from './PipeBook.js';

/** Content-addressed app-private copies and OCR results. Original document URIs are read-only. */
export class PipeSourceCache {
  // 3.0: results read by 1.7.x (revision 9) are not reused; the saved source images are. 31 (26/10): pipe columns
  // found again as curves when straight ones leave days uneven, VietOCR round 2 — earlier 3.0 results are read again.
  // 32 (26/10 evening): the pipe-number reader (assets/pipes) and its S10 rule came after 31 — read again with them.
  // 33 (26/10 night): S10/D5 may hold 19–22 (user, "cách A": 19 and 21 need a second reading) — read again.
  // 3.5: the T5 model, verified shared-cell border cleanup, orientation/name validation and OCR pipe range.
  // Revision 35 also invalidates the intermediate 3.5 test results from before the faint-rule fix.
  // 37: split staff rows from a separate notes frame on full-page photos; re-read saved sources.
  // 42: independent staff-table outline and one consensus for every name row; old note/merged-row
  // results must be read again from their preserved source, never reused as the corrected OCR.
  static REVISION = 43;
  constructor(files) { this._root = new File(files, 'pipe-source-cache-v4'); if (!this._root.isDirectory() && !this._root.mkdirs()) throw new IOException('Không tạo được nơi lưu ảnh.'); }
  copy(input) {
    if (input == null) throw new IOException('Không mở được ảnh.'); const temp = File.createTempFile('source-', '.tmp', this._root);
    try {
      const digest = MessageDigest.getInstance('SHA-256'); let total = 0;
      const out = new FileOutputStream(temp);
      try {
        const bytes = new Uint8Array(65536); let n; while ((n = input.read(bytes)) !== -1) {
          if (Thread.currentThread().isInterrupted()) throw new InterruptedException(); total += n; if (total > 80 * 1024 * 1024) throw new IOException('Ảnh vượt quá 80 MB.'); digest.update(bytes, 0, n); out.write(bytes, 0, n);
        }
      } finally { try { out.close(); } finally { input.close(); } }
      let hash = ''; for (const b of digest.digest()) hash += format('%02x', b & 255);
      const target = new File(this._root, hash + '.image'); if (!target.exists()) Files.move(temp.toPath(), target.toPath()); return target;
    } finally { Files.deleteIfExists(temp.toPath()); }
  }
  _record(image, month) { return new File(this._root, image.getName() + '-' + month + '-r' + PipeSourceCache.REVISION + '.json'); }
  load(image, month) {
    try {
      const json = utf8Decode(Files.readAllBytes(this._record(image, month).toPath()));
      if (new JSONObject(json).optInt('ocrRevision', 0) !== PipeSourceCache.REVISION) return null;
      const book = PipeBook.fromJson(json);
      if (!month.equals(book.month)) return null;
      for (const e of book.employees) { if (!new File(e.identityEvidence).isFile()) return null; for (const d of e.days.values()) if (!new File(d.evidence).isFile()) return null; }
      return book;
    } catch (missing) { return null; }
  }
  save(image, book) {
    const temp = File.createTempFile('result-', '.tmp', this._root); try {
      Files.write(temp.toPath(), utf8Encode(new JSONObject(book.toJson()).put('ocrRevision', PipeSourceCache.REVISION).toString()));
      Files.move(temp.toPath(), this._record(image, book.month).toPath(), StandardCopyOption.REPLACE_EXISTING);
    } finally { Files.deleteIfExists(temp.toPath()); }
  }
  /** Locate only original copies associated with the saved month's evidence. */
  sourcesFor(saved) {
    if (saved.hasPrimary()) {
      const paths = [];
      for (const path of saved.sourceImages()) { const file = new File(path).getCanonicalFile(); if (!this._root.getCanonicalFile().equals(file.getParentFile()) || !file.isFile()) throw new IOException('Ảnh gốc đã lưu không còn. Hãy chọn lại bộ ảnh và đánh dấu ảnh phân ống chính.'); paths.push(file); }
      return paths;
    }
    const evidence = new Set();
    for (const person of saved.employees) { evidence.add(person.identityEvidence); for (const day of person.days.values()) evidence.add(day.evidence); }
    evidence.delete(''); const result = [];
    const pattern = '[a-f0-9]{64}\\.image-' + saved.month + '(-r[0-9]+)?\\.json';
    const records = this._root.listFiles((dir, name) => matches(name, pattern));
    if (records != null) for (const record of records) try {
      const page = PipeBook.fromJson(utf8Decode(Files.readAllBytes(record.toPath()))); let belongs = false;
      for (const person of page.employees) { if (evidence.has(person.identityEvidence)) belongs = true; for (const day of person.days.values()) if (evidence.has(day.evidence)) belongs = true; }
      const source = new File(this._root, record.getName().substring(0, record.getName().indexOf('.image-') + 6));
      if (belongs && source.isFile() && !result.some(f => f.equals(source))) result.push(source);
    } catch (unreadable) { /* Never select an unrelated image as a fallback. */ }
    result.sort((a, b) => compareTo(a.getName(), b.getName())); return result;
  }
}
