// Port of vn.lichdilam.ReminderRule (APK 4.5).
import { IllegalArgumentException, IllegalStateException, format, idiv, irem, split, trim, Integer } from '../platform/java.js';
import { JSONObject, JSONArray, JSONException } from '../platform/json.js';
import { Schedule } from './Schedule.js';

export class ReminderRule {
  constructor(id, code, minute, daysBefore, enabled) {
    const clean = code == null ? '' : Schedule.canonicalToken(code);
    if (id == null || !/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw new IllegalArgumentException('Mục nhắc không hợp lệ.');
    if (!/^[A-Z][A-Z0-9]{0,7}$/.test(clean)) throw new IllegalArgumentException('Nhập mã ca, ví dụ S10 hoặc D5.');
    if (minute < 0 || minute >= 1440 || daysBefore < 0 || daysBefore > 1) throw new IllegalArgumentException('Giờ hoặc ngày nhắc không hợp lệ.');
    this.id = id; this.code = clean; this.minute = minute; this.daysBefore = daysBefore; this.enabled = enabled;
    Object.freeze(this);
  }
  time() { return format('%02d:%02d', idiv(this.minute, 60), irem(this.minute, 60)); }
  static parseTime(value) {
    const text = value == null ? '' : trim(value);
    if (!/^(?:[01]?[0-9]|2[0-3]):[0-5][0-9]$/.test(text)) throw new IllegalArgumentException('Nhập giờ theo dạng HH:mm, từ 00:00 đến 23:59; ví dụ 06:30.');
    const parts = split(text, ':'); return Integer.parseInt(parts[0]) * 60 + Integer.parseInt(parts[1]);
  }
  json() { return new JSONObject().put('id', this.id).put('code', this.code).put('minute', this.minute).put('daysBefore', this.daysBefore).put('enabled', this.enabled); }
  static decode(raw) {
    try {
      const rows = new JSONArray(raw); const result = [];
      for (let i = 0; i < rows.length(); i++) { const o = rows.getJSONObject(i); result.push(new ReminderRule(o.getString('id'), o.getString('code'), o.getInt('minute'), o.getInt('daysBefore'), o.getBoolean('enabled'))); }
      ReminderRule.validate(result); return result;
    } catch (e) { if (!(e instanceof JSONException)) throw e; throw new IllegalArgumentException('Không đọc được cài đặt nhắc ca.', e); }
  }
  static encode(rules) {
    ReminderRule.validate(rules);
    try { const a = new JSONArray(); for (const r of rules) a.put(r.json()); return a.toString(); } catch (e) { if (!(e instanceof JSONException)) throw e; throw new IllegalStateException(e); }
  }
  static validate(rules) {
    const ids = new Set(), times = new Set();
    for (const r of rules) {
      if (ids.has(r.id)) throw new IllegalArgumentException('Mục nhắc bị trùng.'); ids.add(r.id);
      const key = r.code + ':' + r.minute + ':' + r.daysBefore;
      if (times.has(key)) throw new IllegalArgumentException('Đã có lịch nhắc ' + r.code + ' lúc ' + r.time() + ' trong cùng ngày nhắc.'); times.add(key);
    }
  }
}
