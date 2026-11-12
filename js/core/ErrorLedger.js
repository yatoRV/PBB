// Port of vn.lichdilam.ErrorLedger (APK 4.5). float[] signatures → Float32Array; HashMap → JavaHashMap.
// record() is async because Bitmap.compress (the cell image) is async on the web; everything else is synchronous.
import { IllegalStateException, IOException, UUID, System, Base64, roundF, idiv, JavaHashMap } from '../platform/java.js';
import { JSONObject, JSONArray, JSONException } from '../platform/json.js';
import { File, FileOutputStream } from '../platform/files.js';
import { Bitmap } from '../platform/bitmap.js';
import { Schedule } from './Schedule.js';
import { PipeDay } from './PipeDay.js';
import { GlyphMatch } from './GlyphMatch.js';

const f = Math.fround;
const PREFERENCES = 'error-ledger', DIRECTORY = 'error-ledger';
const UNREAD = 'Chưa đọc được', MISREAD = 'Đọc sai', DIFFERENT = 'Khác Ca / khác người';
const rethrowUnlessJson = e => { if (!(e instanceof JSONException)) throw e; };

class Entry {
  constructor() { this.id = null; this.month = null; this.person = null; this.source = null; this.shown = null; this.confirmed = null; this.raw = null; this.image = null; this.cause = null; this.time = 0; this.day = 0; this.signature = null; this.pipe = null; }
  json() {
    const o = new JSONObject().put('id', this.id).put('time', this.time).put('month', this.month).put('person', this.person).put('day', this.day).put('source', this.source)
      .put('shown', this.shown).put('confirmed', this.confirmed).put('raw', this.raw).put('cause', this.cause).put('image', this.image == null ? '' : this.image).put('pipe', this.pipe == null ? '' : this.pipe);
    if (this.signature != null) o.put('signature', ErrorLedger.encode(this.signature)); return o;
  }
  static from(o) {
    const e = new Entry(); e.id = o.optString('id'); e.time = o.optLong('time'); e.month = o.optString('month'); e.person = o.optString('person'); e.day = o.optInt('day');
    e.source = o.optString('source'); e.shown = o.optString('shown'); e.confirmed = o.optString('confirmed'); e.raw = o.optString('raw'); e.cause = o.optString('cause');
    e.image = o.optString('image'); if (e.image === '') e.image = null; e.pipe = o.optString('pipe'); if (e.pipe === '') e.pipe = null;
    const s = o.optString('signature'); e.signature = s === '' ? null : ErrorLedger.decode(s); return e;
  }
}

/** Error ledger (3.0, proposal §9.1): each "?" cell the user confirmed and each OCR value the user corrected, with
 *  the cell image, the raw readings, what the app showed and what the user confirmed. It survives Reset; the user
 *  deletes entries on the "Lỗi đã ghi nhớ" screen. Confirmed position cells become templates for later scans. */
export class ErrorLedger {
  static PREFERENCES = PREFERENCES; static DIRECTORY = DIRECTORY;
  /** Templates from another photo: stricter than the same-photo thresholds (GlyphMatchReplayTest measures them). */
  static TEMPLATE_SCORE = f(0.80); static TEMPLATE_MARGIN = f(0.12);
  static LIMIT = 400;
  static UNREAD = UNREAD; static MISREAD = MISREAD; static DIFFERENT = DIFFERENT;
  static Entry = Entry;
  /** new ErrorLedger(context) | new ErrorLedger(prefs, dir). */
  constructor(a, dir) {
    if (dir === undefined) { this._prefs = a.getSharedPreferences(PREFERENCES, 0); this._dir = new File(a.getFilesDir(), DIRECTORY); }
    else { this._prefs = a; this._dir = dir; }
  }
  entries() {
    const out = [];
    try { const a = new JSONArray(this._prefs.getString('entries', '[]')); for (let i = 0; i < a.length(); i++) out.push(Entry.from(a.getJSONObject(i))); } catch (broken) { rethrowUnlessJson(broken); /* start over */ }
    out.sort((a, b) => (b.time < a.time ? -1 : b.time === a.time ? 0 : 1)); return out;
  }
  _save(list) { const a = new JSONArray(); for (const e of list) a.put(e.json()); if (!this._prefs.edit().putString('entries', a.toString()).commit()) throw new IllegalStateException('Chưa lưu được sổ lỗi.'); }
  /** Records one confirmed cell; the newest entry for the same month/person/day/source replaces the older one. */
  async record(month, person, day, source, shown, confirmed, raw, image, signature, pipe) {
    const e = new Entry(); e.id = UUID.randomUUID().toString(); e.time = System.currentTimeMillis(); e.month = month; e.person = person == null ? '' : person; e.day = day; e.source = source;
    e.shown = shown; e.confirmed = confirmed; e.raw = raw == null ? '' : raw; e.signature = signature; e.pipe = pipe; e.cause = shown === '?' || shown.includes('?') ? UNREAD : shown.includes('Khác') ? DIFFERENT : MISREAD;
    if (image != null && !image.isRecycled()) try {
      if (!this._dir.isDirectory() && !this._dir.mkdirs()) throw new IOException(); const file = new File(this._dir, e.id + '.png');
      const out = new FileOutputStream(file); try { await image.compress(Bitmap.CompressFormat.PNG, 100, out); } finally { out.close(); } e.image = file.getName();
    } catch (noImage) { if (!(noImage instanceof IOException)) throw noImage; e.image = null; }
    const list = this.entries();
    for (let i = 0; i < list.length; i++) { const old = list[i]; if (old.month === e.month && old.day === e.day && old.source === e.source && Schedule.normalizeName(old.person) === Schedule.normalizeName(e.person)) { this._deleteImage(old); list.splice(i--, 1); } }
    list.unshift(e); while (list.length > ErrorLedger.LIMIT) this._deleteImage(list.pop());
    try { this._save(list); } catch (broken) { rethrowUnlessJson(broken); throw new IllegalStateException(broken); } return e;
  }
  delete(id) {
    const list = this.entries(); for (let i = 0; i < list.length; i++) { const e = list[i]; if (e.id === id) { this._deleteImage(e); list.splice(i--, 1); } }
    try { this._save(list); } catch (broken) { rethrowUnlessJson(broken); throw new IllegalStateException(broken); }
  }
  clear() { for (const e of this.entries()) this._deleteImage(e); if (!this._prefs.edit().clear().commit()) throw new IllegalStateException('Chưa xóa được sổ lỗi.'); }
  image(e) { return e.image == null ? null : new File(this._dir, e.image); }
  _deleteImage(e) { const file = this.image(e); if (file != null && file.exists() && !file.delete()) file.deleteOnExit(); }
  /** Position value → signatures of cells the user confirmed (templates for later scans). */
  pipeTemplates() {
    const m = new JavaHashMap();
    for (const e of this.entries()) if (e.signature != null && e.pipe != null && PipeDay.pipeValue(e.pipe) != null) m.computeIfAbsent(e.pipe, () => []).push(e.signature); return m;
  }

  /** Signature stored as one byte per value (0–255), Base64. */
  static encode(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = roundF(f(Math.max(0, Math.min(1, s[i])) * 255)) & 255; return Base64.getEncoder().encodeToString(b); }
  static decode(text) { const b = Base64.getDecoder().decode(text); const s = new Float32Array(b.length); for (let i = 0; i < b.length; i++) s[i] = (b[i] & 255) / 255; return s.length === GlyphMatch.W * GlyphMatch.H ? s : null; }
  /** The position part of a stored day crop (code | position | duty side by side) as a template signature. */
  static pipeSignature(dayCrop, parts) {
    if (dayCrop == null || parts < 2) return null; const w = dayCrop.getWidth(), h = dayCrop.getHeight(), x0 = idiv(w, parts), x1 = idiv(2 * w, parts); if (x1 - x0 < 8) return null;
    const px = new Int32Array((x1 - x0) * h); dayCrop.getPixels(px, 0, x1 - x0, x0, 0, x1 - x0, h); return GlyphMatch.signature(px, x1 - x0, h);
  }
}
