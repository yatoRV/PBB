// Port of vn.lichdilam.PipeTableNames (APK 4.5).
import { IllegalStateException, trim } from '../platform/java.js';
import { JSONObject, JSONException } from '../platform/json.js';
import { ConfirmedNames } from './ConfirmedNames.js';

const KEY = 'pipe:table:typed';

/** 3.1 (the user, 27/10): names typed by hand into the pipe table, for cells the photo does not show clearly.
 *  Kept apart from what was read, so a later re-read of the photos never overwrites them and they never turn
 *  a read value into a different one: the table shows the typed name, the calendar keeps the read data. */
export class PipeTableNames {
  static KEY = KEY;
  constructor(prefs) { this._prefs = prefs; }
  _raw() { try { return new JSONObject(this._prefs.getString(KEY, '{}')); } catch (e) { if (!(e instanceof JSONException)) throw e; return new JSONObject(); } }
  static key(month, sheet, day, pipe) { return month + '|' + sheet + '|' + day + '|' + pipe; }
  get(month, sheet, day, pipe) {
    const value = this._raw().optString(PipeTableNames.key(month, sheet, day, pipe), '');
    return value === '' ? null : value;
  }
  /** An empty name removes what was typed before, so the cell shows the photo again. */
  put(month, sheet, day, pipe, name) {
    const stored = this._raw(); const key = PipeTableNames.key(month, sheet, day, pipe);
    const typed = name == null ? '' : trim(name);
    try { if (typed === '') stored.remove(key); else stored.put(key, ConfirmedNames.validate(typed)); } catch (e) { if (!(e instanceof JSONException)) throw e; throw new IllegalStateException(e); }
    if (!this._prefs.edit().putString(KEY, stored.toString()).commit()) throw new IllegalStateException('Chưa lưu được tên.');
  }
}
