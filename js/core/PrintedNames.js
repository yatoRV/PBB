// Port of vn.lichdilam.PrintedNames (APK 4.5).
import { IllegalStateException, JavaHashMap } from '../platform/java.js';
import { JSONObject, JSONException } from '../platform/json.js';
import { Schedule } from './Schedule.js';
import { ConfirmedNames } from './ConfirmedNames.js';

const KEY = 'people:printed';

/** Names the user corrected for what OCR read on a pipe photo ("Misi Huy" is "Minh Huy" on the sheet). Kept
 *  across months and photos, because the same people are printed on every sheet; never filled in by the app. */
export class PrintedNames {
  static KEY = KEY;
  constructor(prefs) { this._prefs = prefs; }
  _raw() { try { return new JSONObject(this._prefs.getString(KEY, '{}')); } catch (e) { if (!(e instanceof JSONException)) throw e; return new JSONObject(); } }
  /** OCR spelling key (ConfirmedNames.key) → the name as printed (a HashMap). */
  all() { const out = new JavaHashMap(); const o = this._raw(); for (const it = o.keys(); it.hasNext();) { const k = it.next(); const e = o.optJSONObject(k); if (e != null && e.optString('name') !== '') out.put(k, e.optString('name')); } return out; }
  put(ocr, printed) {
    const name = ConfirmedNames.validate(printed); const o = this._raw();
    try { o.put(ConfirmedNames.key(ocr), new JSONObject().put('ocr', Schedule.normalizePerson(ocr)).put('name', name)); } catch (e) { if (!(e instanceof JSONException)) throw e; throw new IllegalStateException(e); }
    if (!this._prefs.edit().putString(KEY, o.toString()).commit()) throw new IllegalStateException('Chưa lưu được tên.');
  }
  remove(ocr) { const o = this._raw(); o.remove(ConfirmedNames.key(ocr)); this._prefs.edit().putString(KEY, o.toString()).commit(); }
}
