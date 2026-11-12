// Port of vn.lichdilam.ConfirmedNames (APK 4.5).
import { IllegalArgumentException, IllegalStateException, JavaTreeMap, trim } from '../platform/java.js';
import { JSONObject, JSONException } from '../platform/json.js';
import { Schedule } from './Schedule.js';

const KEY = 'people:confirmed';

/** Full names the user confirmed for a name printed on the pipe photo. OCR only suggests names;
 *  history shows a full name only after the user accepted or corrected it here. */
export class ConfirmedNames {
  static KEY = KEY;
  constructor(prefs) { this._prefs = prefs; }
  /** Printed names are compared exactly (accents kept), ignoring case and spacing only. */
  static key(printed) { return Schedule.normalizePerson(printed).toLowerCase(); }
  /** A person's full name as the user typed or accepted it; letters, spaces, dots and hyphens only. */
  static validate(full) {
    const name = Schedule.normalizePerson(full);
    if (name.length < 2 || name.length > 60 || !/^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u.test(name)) throw new IllegalArgumentException('Nhập họ tên 2–60 ký tự, chỉ gồm chữ, dấu cách hoặc dấu chấm.');
    return name;
  }
  _raw() { try { return new JSONObject(this._prefs.getString(KEY, '{}')); } catch (e) { if (!(e instanceof JSONException)) throw e; return new JSONObject(); } }
  full(printed) { if (printed == null || trim(printed) === '') return null; const o = this._raw().optJSONObject(ConfirmedNames.key(printed)); return o == null ? null : o.optString('full', null); }
  /** TreeMap printed → full. */
  all() { const out = new JavaTreeMap(); const o = this._raw(); for (const it = o.keys(); it.hasNext();) { const e = o.optJSONObject(it.next()); if (e != null) out.put(e.optString('printed'), e.optString('full')); } return out; }
  /** Adds printed → full mappings to an editor so they commit together with the change that confirmed them.
   *  printedToFull: a Map (or any map with entrySet()/entries) of printed name → full name. */
  put(editor, printedToFull) {
    const entries = printedToFull instanceof Map ? [...printedToFull.entries()] : printedToFull.entrySet().toArray().map(e => [e.getKey(), e.getValue()]);
    if (entries.length === 0) return; const o = this._raw();
    try { for (const [printed, full] of entries) o.put(ConfirmedNames.key(printed), new JSONObject().put('printed', Schedule.normalizePerson(printed)).put('full', ConfirmedNames.validate(full))); } catch (e) { if (!(e instanceof JSONException)) throw e; throw new IllegalStateException(e); }
    editor.putString(KEY, o.toString());
  }
}
