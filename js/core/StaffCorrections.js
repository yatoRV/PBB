// Port of vn.lichdilam.StaffCorrections (APK 4.5).
import { trim } from '../platform/java.js';
import { JSONObject, JSONArray, JSONException } from '../platform/json.js';
import { Schedule } from './Schedule.js';

/** Two full-name corrections explicitly confirmed by the user on 29/10/2026. */
export class StaffCorrections {
  constructor() { throw new Error('StaffCorrections is not instantiable'); }
  static name(raw) {
    const clean = Schedule.normalizePerson(raw);
    if (!/^[\p{L}\p{M} ]+$/u.test(clean)) return clean;
    if (Schedule.normalizeName(clean) === 'nguyenhoangminh') return 'Nguyễn Huỳnh Minh';
    if (Schedule.normalizeName(clean) === 'tranquoccuong') return 'Trần Quang Cường';
    return clean;
  }
  static _token(raw) {
    const fixed = StaffCorrections.name(raw); if (fixed !== Schedule.normalizePerson(raw)) return fixed;
    // Existing identity preference: STT + ':' + normalized full name.
    if (/^[0-9]+:[^\n\r\u0085\u2028\u2029]*$/.test(raw)) {
      const colon = raw.indexOf(':'); const identity = Schedule.normalizeName(raw.substring(colon + 1));
      if (identity === 'nguyenhoangminh') return raw.substring(0, colon + 1) + 'nguyenhuynhminh';
      if (identity === 'tranquoccuong') return raw.substring(0, colon + 1) + 'tranquangcuong';
    }
    return raw;
  }
  static _rewrite(value) {
    if (value instanceof JSONObject) { const o = value; const keys = []; const it = o.keys(); while (it.hasNext()) keys.push(it.next()); for (const k of keys) o.put(k, StaffCorrections._rewrite(o._raw(k))); return o; }
    if (value instanceof JSONArray) { const a = value; for (let i = 0; i < a.length(); i++) a.put(i, StaffCorrections._rewrite(a._raw(i))); return a; }
    return typeof value === 'string' ? StaffCorrections._token(value) : value;
  }
  static storedValue(raw) {
    try { if (trim(raw).startsWith('{')) return StaffCorrections._rewrite(new JSONObject(raw)).toString(); if (trim(raw).startsWith('[')) return StaffCorrections._rewrite(new JSONArray(raw)).toString(); } catch (ignored) { if (!(ignored instanceof JSONException)) throw ignored; }
    return StaffCorrections._token(raw);
  }
  /** Atomic and idempotent: only exact identity values change; dates, shifts and evidence remain intact. */
  static migrate(prefs) {
    if (prefs.getBoolean('staffNames40Corrected', false)) return true;
    const edit = prefs.edit();
    for (const e of prefs.getAll().entrySet()) if (typeof e.getValue() === 'string') { const before = e.getValue(), after = StaffCorrections.storedValue(before); if (before !== after) edit.putString(e.getKey(), after); }
    return edit.putBoolean('staffNames40Corrected', true).commit();
  }
}
