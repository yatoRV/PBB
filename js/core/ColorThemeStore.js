// Port of vn.lichdilam.ColorThemeStore (APK 4.5). Files live in the virtual app storage (js/platform/files.js);
// java.text.Collator("vi") → Collator from java.js; TreeMap → JavaTreeMap.
import { IllegalArgumentException, IOException, UUID, System, Character, Collator, JavaTreeMap, compareTo, trim, utf8Encode, utf8Decode } from '../platform/java.js';
import { JSONObject, JSONArray, JSONException } from '../platform/json.js';
import { File, Files, FileOutputStream, StandardCopyOption, AtomicMoveNotSupportedException } from '../platform/files.js';
import { ThemePalette } from './ThemePalette.js';

const DIRECTORY = 'color-themes', FORMAT = 'lichdilam-color-theme';
const LIMIT = 100;
const rethrowUnlessJson = e => { if (!(e instanceof JSONException)) throw e; };
const listEquals = (a, b) => (a == null || b == null ? a === b : a.length === b.length && a.every((x, i) => x === b[i]));

function name(value) {
  const n = value == null ? '' : trim(value.normalize('NFC')).replace(/[ \t\n\x0B\f\r]+/g, ' ');
  if (n === '' || n.length > 60) throw new IllegalArgumentException('Tên bộ màu phải có 1–60 ký tự.');
  for (let i = 0; i < n.length; i++) if (Character.isISOControl(n.charAt(i))) throw new IllegalArgumentException('Tên bộ màu chứa ký tự không hợp lệ.');
  return n;
}
function id(value) { if (value == null || !/^[0-9a-f-]{36}$/.test(value)) throw new IllegalArgumentException('Mã bộ màu không hợp lệ.'); return value; }
function key(n) { return name(n).toLowerCase(); }

class Theme {
  constructor(themeId, themeName, created, updated, light, dark, favorites) { this.id = themeId; this.name = themeName; this.created = created; this.updated = updated; this.light = light; this.dark = dark; this.favorites = favorites == null ? null : Object.freeze([...favorites]); }
  /** Which palettes the set restores; sets converted from 1.7.1 presets may hold only one. */
  scope() { return this.light != null && this.dark != null ? 'Sáng và Tối' : this.light != null ? 'chỉ bảng Sáng' : 'chỉ bảng Tối'; }
  json() {
    const o = new JSONObject().put('format', FORMAT).put('version', 1).put('id', this.id).put('name', this.name).put('created', this.created).put('updated', this.updated);
    if (this.light != null) o.put('light', this.light.json()); if (this.dark != null) o.put('dark', this.dark.json());
    if (this.favorites != null) { const a = new JSONArray(); for (const c of this.favorites) a.put(c); o.put('favorites', a); } return o;
  }
  static parse(o) {
    try {
      if (FORMAT !== o.getString('format') || o.getInt('version') !== 1) throw new IllegalArgumentException('Tệp không phải bộ màu được hỗ trợ.');
      const light = o.has('light') ? ThemePalette.parse(o.getJSONObject('light')) : null, dark = o.has('dark') ? ThemePalette.parse(o.getJSONObject('dark')) : null;
      if ((light == null && dark == null) || (light != null && !light.light) || (dark != null && dark.light)) throw new IllegalArgumentException('Bảng màu sáng/tối không khớp.');
      let favorites = null; const a = o.optJSONArray('favorites'); if (a != null) { favorites = []; for (let i = 0; i < Math.min(48, a.length()); i++) favorites.push(a.getInt(i)); }
      return new Theme(id(o.getString('id')), name(o.getString('name')), o.getLong('created'), o.getLong('updated'), light, dark, favorites);
    } catch (e) { rethrowUnlessJson(e); throw new IllegalArgumentException('Bộ màu không đọc được.', e); }
  }
}
/** Thrown when the name is taken; the caller may ask to overwrite that set. */
class DuplicateName extends IllegalArgumentException {
  static javaName = 'vn.lichdilam.ColorThemeStore$DuplicateName';
  constructor(existing) { super('Đã có bộ màu tên “' + existing.name + '”.'); this.existing = existing; }
}
function read(file) {
  const data = Files.readAllBytes(file.toPath()); if (data.length > 2 * 1024 * 1024) throw new IOException('Tệp bộ màu quá lớn.');
  try { return Theme.parse(new JSONObject(utf8Decode(data))); } catch (e) { rethrowUnlessJson(e); throw new IOException('Tệp bộ màu hỏng.', e); }
}

/** Named color sets, one JSON file each, in the app's private files directory chosen by Android
 *  (Context.getFilesDir()/color-themes). No storage permission and no user-typed path is needed.
 *  A save is reported only after the file was written, synced, renamed into place and read back equal. */
export class ColorThemeStore {
  static DIRECTORY = DIRECTORY; static FORMAT = FORMAT;
  static LIMIT = LIMIT;
  static Theme = Theme;
  static DuplicateName = DuplicateName;
  /** new ColorThemeStore(context) | new ColorThemeStore(directory: File). */
  constructor(a) { this.directory = a instanceof File ? a : new File(a.getFilesDir(), DIRECTORY); this._unreadable = 0; }
  static name(value) { return name(value); }
  _file(themeId) { return new File(this.directory, id(themeId) + '.json'); }
  /** Files that exist but could not be read in the last list(); they are left untouched. */
  unreadable() { return this._unreadable; }
  list() {
    const result = []; this._unreadable = 0; const files = this.directory.listFiles((dir, n) => /^[0-9a-f-]{36}\.json$/.test(n));
    if (files != null) for (const file of files) try { const t = read(file); if (file.getName() === t.id + '.json') result.push(t); else this._unreadable++; } catch (e) { this._unreadable++; }
    const order = Collator.getInstance('vi'); result.sort((a, b) => { const c = order.compare(a.name, b.name); return c !== 0 ? c : compareTo(a.id, b.id); }); return result;
  }
  find(themeId) { for (const t of this.list()) if (t.id === themeId) return t; return null; }
  /** Saves a new named set, or replaces the set with the same name only when overwrite is true. */
  save(themeName, light, dark, favorites, overwrite) {
    const clean = name(themeName); if (light == null && dark == null) throw new IllegalArgumentException('Không có bảng màu để lưu.');
    let existing = null; const all = this.list(); for (const t of all) if (key(t.name) === key(clean)) existing = t;
    if (existing != null && !overwrite) throw new DuplicateName(existing);
    if (existing == null && all.length >= LIMIT) throw new IllegalArgumentException('Đã có ' + LIMIT + ' bộ màu. Xóa bộ màu không dùng trước.');
    const now = System.currentTimeMillis();
    const theme = new Theme(existing == null ? UUID.randomUUID().toString() : existing.id, clean, existing == null ? now : existing.created, now, light == null ? null : light.copy(), dark == null ? null : dark.copy(), favorites);
    this._write(theme); return theme;
  }
  rename(themeId, newName) {
    const t = this.find(themeId); if (t == null) throw new IllegalArgumentException('Không tìm thấy bộ màu. Danh sách đã thay đổi.'); const clean = name(newName);
    for (const other of this.list()) if (other.id !== themeId && key(other.name) === key(clean)) throw new DuplicateName(other);
    const renamed = new Theme(t.id, clean, t.created, System.currentTimeMillis(), t.light, t.dark, t.favorites); this._write(renamed); return renamed;
  }
  delete(themeId) { const file = this._file(themeId); Files.deleteIfExists(file.toPath()); if (file.exists()) throw new IOException('Chưa xóa được bộ màu.'); }
  _write(theme) {
    if (!this.directory.isDirectory() && !this.directory.mkdirs() && !this.directory.isDirectory()) throw new IOException('Không tạo được thư mục lưu màu trong bộ nhớ ứng dụng.');
    let json; try { json = theme.json().toString(2); } catch (e) { rethrowUnlessJson(e); throw new IOException(e); }
    const target = this._file(theme.id), temp = new File(this.directory, theme.id + '.json.tmp'); const bytes = utf8Encode(json);
    const out = new FileOutputStream(temp); try { out.write(bytes); out.flush(); out.getFD().sync(); } finally { out.close(); }
    try {
      try { Files.move(temp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
      catch (e) { if (!(e instanceof AtomicMoveNotSupportedException)) throw e; Files.move(temp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING); }
    } finally { Files.deleteIfExists(temp.toPath()); }
    // Report success only when the stored file reads back to exactly the same set.
    if (!ColorThemeStore.same(read(target), theme)) throw new IOException('Dữ liệu đọc lại không khớp bộ màu vừa lưu.');
  }
  static same(a, b) {
    return a.id === b.id && a.name === b.name && a.created === b.created && a.updated === b.updated && listEquals(a.favorites, b.favorites)
      && (a.light == null ? b.light == null : a.light.sameAs(b.light)) && (a.dark == null ? b.dark == null : a.dark.sameAs(b.dark));
  }
  /** Converts 1.7.1 presets (one palette each) into files once; nothing missing is invented.
   *  The old entries are removed only after every converted file was verified. */
  migrateLegacy(legacy) {
    if (legacy == null || legacy.getAll().isEmpty()) return 0; const old = new JavaTreeMap(legacy.getAll()); const done = new Set(); let added = 0;
    const names = new Set(); for (const t of this.list()) names.add(key(t.name));
    for (const [k, v] of old) {
      if (typeof v !== 'string') continue; let p, n;
      try { p = ThemePalette.parse(new JSONObject(v)); n = name(k); } catch (broken) { continue; }
      if (!names.has(key(n))) { this.save(n, p.light ? p : null, p.light ? null : p, null, false); names.add(key(n)); added++; }
      done.add(k);
    }
    const editor = legacy.edit(); for (const k of done) editor.remove(k); if (!editor.commit()) throw new IOException('Chưa dọn được preset cũ.');
    return added;
  }
}
