// Port of vn.lichdilam.ThemePalette (APK 4.5). LinkedHashMap → Map; colours are signed 32-bit ints like Java's
// int (0xFF101522 | 0); sizes are Java floats (Math.fround) and are written to JSON as floats (jfloat).
import { IllegalArgumentException, IllegalStateException, NullPointerException, Float, format, roundF } from '../platform/java.js';
import { JSONObject, JSONArray, JSONException, jfloat } from '../platform/json.js';
import { Schedule } from './Schedule.js';

const f = Math.fround;
const mapEquals = (a, b) => { if (a.size !== b.size) return false; for (const [k, v] of a) if (!b.has(k) || b.get(k) !== v) return false; return true; };
const keySetEquals = (a, b) => { if (a.size !== b.size) return false; for (const k of a.keys()) if (!b.has(k)) return false; return true; };
const arrayEquals = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
function luminance(c) { const v = [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255]; for (let i = 0; i < 3; i++) v[i] = v[i] <= 0.04045 ? v[i] / 12.92 : Math.pow((v[i] + 0.055) / 1.055, 2.4); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; }

/** Value-only palette. Draft copies never write schedule data or preferences. */
export class ThemePalette {
  constructor(light) {
    this.light = light;
    this.colors = new Map();
    this.sizes = new Map();
    this.shifts = new Map();
    this._defaults();
  }
  _put(key, dark, bright) { this.colors.set(key, (this.light ? bright : dark) | 0); }
  _defaults() {
    const put = (k, d, b) => this._put(k, d, b);
    put('app.background', 0xFF101522, 0xFFF4F6FC); put('app.panel', 0xFF1C2334, 0xFFFFFFFF);
    put('app.text', 0xFFF1F3FB, 0xFF18233B); put('app.muted', 0xFFA8B2CA, 0xFF516079);
    put('app.accent', 0xFFB8C7FF, 0xFF3155B8); put('app.onAccent', 0xFF1F2D52, 0xFFFFFFFF);
    put('app.warning', 0xFFE6C189, 0xFF864400); put('app.success', 0xFFA6DCC2, 0xFF17623F); put('app.danger', 0xFFFFB8B2, 0xFFA52330);
    put('calendar.background', 0xFF292E41, 0xFFFFFFFF); put('calendar.cell', 0x00292E41, 0x00FFFFFF);
    put('calendar.horizontal', 0xFF454B60, 0xFFDCE2EE); put('calendar.vertical', 0xFF454B60, 0xFFDCE2EE);
    put('calendar.border', 0x00454B60, 0xFFE0E5F0); put('calendar.hover', 0x284F70B0, 0x203155B8);
    put('calendar.month', 0xFFF1F3FB, 0xFF18233B); put('calendar.year', 0xFFA8B2CA, 0xFF516079);
    put('calendar.weekday', 0xFFA7AEC3, 0xFF516079); put('calendar.day', 0xFFE5E8F3, 0xFF273752);
    put('calendar.outside', 0xAA858CA4, 0xAA637089); put('calendar.weekend', 0xFFE5E8F3, 0xFF334D82);
    put('shift.background', 0xFF606FA3, 0xFF405DA8); put('shift.text', 0xFFFFFFFF, 0xFFFFFFFF);
    put('pipe.text', 0xFFFFFFFF, 0xFF203969); put('pipe.number', 0xFFFFFFFF, 0xFF203969);
    put('pipe.background', 0x006776AE, 0x00EDF1FB); put('pipe.block', 0xFF606FA3, 0xFFE9EEFA);
    put('warning.background', 0xFF795738, 0xFFFFE4BA); put('warning.text', 0xFFFFFFFF, 0xFF623500);
    put('today.fill', 0xFFFFFFFF, 0xFF3155B8); put('today.border', 0xFFB8C7FF, 0xFF3155B8); put('today.text', 0xFF253157, 0xFFFFFFFF);
    put('selected.border', 0xFFFFFFFF, 0xFF3155B8); put('selected.fill', 0x183F5B99, 0x183155B8); put('selected.effect', 0x504B6DB2, 0x403155B8);
    put('button.prev', 0xFFA8B2CA, 0xFF516079); put('button.next', 0xFFA8B2CA, 0xFF516079);
    put('button.addBackground', 0xFFB8C7FF, 0xFF3155B8); put('button.addText', 0xFF253157, 0xFFFFFFFF);
    put('button.editBackground', 0xFFB8C7FF, 0xFF3155B8); put('button.editText', 0xFF253157, 0xFFFFFFFF);
    put('button.effect', 0x554F70B0, 0x443155B8);
    // 3.3 (the user, 27/10): the pipe table's own marks — the border of today's row and the guide
    // line of the column that was tapped.
    put('pipeTable.today', 0xFFD97706, 0xFF1D4ED8); put('pipeTable.guide', 0xFF059669, 0xFF6D28D9);
    this.sizes.set('calendar.horizontalWidth', f(0.7)); this.sizes.set('calendar.verticalWidth', f(0.7)); this.sizes.set('selected.width', f(1.8));
    this.shifts.set('OFF', [(this.light ? 0xFFE2E7F1 : 0xFF4C566F) | 0, (this.light ? 0xFF33425C : 0xFFFFFFFF) | 0]);
  }
  /** color(key) reads a colour; color(key, value) sets an existing one. */
  color(key, value) {
    if (value === undefined) { const v = this.colors.get(key); if (v === undefined) throw new IllegalArgumentException('Màu không tồn tại: ' + key); return v; }
    if (!this.colors.has(key)) throw new IllegalArgumentException('Màu không tồn tại'); this.colors.set(key, value | 0);
  }
  /** size(key) reads a thickness; size(key, value) sets an existing one (0–6). */
  size(key, value) {
    if (value === undefined) { const v = this.sizes.get(key); if (v === undefined) throw new NullPointerException(); return v; }
    value = f(value);
    if (!this.sizes.has(key) || !Float.isFinite(value) || value < 0 || value > 6) throw new IllegalArgumentException('Độ dày phải từ 0 đến 6'); this.sizes.set(key, value);
  }
  // P (leave) is a day off: without its own colour it is drawn like OFF, not like a working shift.
  /** shift(code, text) reads the background (text=false) or text colour of a code; shift(code, text, value) sets it. */
  shift(code, text, value) {
    const key = Schedule.displayCode(code);
    if (value === undefined) { let pair = this.shifts.get(key); if (pair === undefined && key === 'P') pair = this.shifts.get('OFF'); return pair === undefined ? this.color(text ? 'shift.text' : 'shift.background') : pair[text ? 1 : 0]; }
    const pair = [this.shift(code, false), this.shift(code, true)]; pair[text ? 1 : 0] = value | 0; this.shifts.set(key, pair);
  }
  /** Value equality independent of JSON key order. */
  sameAs(o) {
    if (o == null || o.light !== this.light || !mapEquals(this.colors, o.colors) || !mapEquals(this.sizes, o.sizes) || !keySetEquals(this.shifts, o.shifts)) return false;
    for (const [k, v] of this.shifts) if (!arrayEquals(v, o.shifts.get(k))) return false; return true;
  }
  copy() { const p = new ThemePalette(this.light); for (const [k, v] of this.colors) p.colors.set(k, v); for (const [k, v] of this.sizes) p.sizes.set(k, v); p.shifts.clear(); for (const [k, v] of this.shifts) p.shifts.set(k, [...v]); return p; }
  json() {
    try {
      const o = new JSONObject().put('version', 1).put('light', this.light); const c = new JSONObject(), s = new JSONObject(), codes = new JSONObject();
      for (const [k, v] of this.colors) c.put(k, format('#%08X', v)); for (const [k, v] of this.sizes) s.put(k, jfloat(v));
      for (const [k, v] of this.shifts) codes.put(k, new JSONArray().put(format('#%08X', v[0])).put(format('#%08X', v[1])));
      return o.put('colors', c).put('sizes', s).put('shifts', codes);
    } catch (e) { if (!(e instanceof JSONException)) throw e; throw new IllegalStateException(e); }
  }
  static parse(o) {
    try {
      if (o.getInt('version') !== 1) throw new IllegalArgumentException('Phiên bản giao diện không được hỗ trợ');
      const p = new ThemePalette(o.getBoolean('light')); const c = o.getJSONObject('colors'); for (const it = c.keys(); it.hasNext();) { const key = it.next(); p.color(key, ThemePalette.parseColor(c.getString(key))); }
      const s = o.getJSONObject('sizes'); for (const it = s.keys(); it.hasNext();) { const key = it.next(); p.size(key, f(s.getDouble(key))); }
      const codes = o.getJSONObject('shifts'); if (codes.length() > 512) throw new IllegalArgumentException('Quá nhiều mã ca');
      for (const it = codes.keys(); it.hasNext();) {
        const key = it.next(); if (!/^[A-Za-z0-9?]{1,12}$/.test(key)) throw new IllegalArgumentException('Mã ca không hợp lệ'); const a = codes.getJSONArray(key);
        if (a.length() !== 2) throw new IllegalArgumentException('Màu mã ca không hợp lệ'); p.shift(key, false, ThemePalette.parseColor(a.getString(0))); p.shift(key, true, ThemePalette.parseColor(a.getString(1)));
      }
      return p;
    } catch (e) { if (!(e instanceof JSONException)) throw e; throw new IllegalArgumentException('Cấu hình màu không hợp lệ', e); }
  }
  static parseColor(hex) {
    if (hex == null || !/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(hex)) throw new IllegalArgumentException('Nhập #RRGGBB hoặc #AARRGGBB');
    const n = parseInt(hex.substring(1), 16); return hex.length === 7 ? (n | 0xFF000000) : (n | 0);
  }
  static contrast(foreground, background) { const a = luminance(foreground), b = luminance(background); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); }
  static over(front, back) {
    const a = f((front >>> 24) / 255); const na = f(1 - a);
    const r = roundF(f(f(((front >> 16) & 255) * a) + f(((back >> 16) & 255) * na))), g = roundF(f(f(((front >> 8) & 255) * a) + f(((back >> 8) & 255) * na))), b = roundF(f(f((front & 255) * a) + f((back & 255) * na)));
    return 0xFF000000 | r << 16 | g << 8 | b;
  }
}
