// Port of vn.lichdilam.ThemeSettings (APK 4.5). The Mode enum keeps name()/ordinal()/valueOf().
import { IllegalArgumentException, IllegalStateException } from '../platform/java.js';
import { JSONObject, JSONArray } from '../platform/json.js';
import { LocalDate, LocalTime } from '../platform/time.js';
import { ThemePalette } from './ThemePalette.js';

const PREFS = 'appearance', PRESETS = 'appearance-presets';

class Mode {
  constructor(name, ordinal) { this._name = name; this._ordinal = ordinal; Object.freeze(this); }
  name() { return this._name; }
  ordinal() { return this._ordinal; }
  toString() { return this._name; }
  label() { return this === Mode.LIGHT ? 'Sáng' : this === Mode.DARK ? 'Tối' : 'Auto'; }
  next() { return this === Mode.LIGHT ? Mode.DARK : this === Mode.DARK ? Mode.AUTO : Mode.LIGHT; }
  static values() { return [Mode.LIGHT, Mode.DARK, Mode.AUTO]; }
  static valueOf(name) { const m = Mode.values().find(v => v._name === name); if (m === undefined) throw new IllegalArgumentException('No enum constant vn.lichdilam.ThemeSettings.Mode.' + name); return m; }
}
Mode.LIGHT = new Mode('LIGHT', 0); Mode.DARK = new Mode('DARK', 1); Mode.AUTO = new Mode('AUTO', 2);

/** Theme preferences are isolated from calendars, OCR, names and reminders. */
export class ThemeSettings {
  /** PRESETS holds 1.7.1 single-palette presets until ColorThemeStore converts them to files. */
  static PREFS = PREFS; static PRESETS = PRESETS;
  static Mode = Mode;
  /** new ThemeSettings(context) | new ThemeSettings(prefs, presets). */
  constructor(a, saved) {
    if (saved === undefined) { this.prefs = a.getSharedPreferences(PREFS, 0); this.presets = a.getSharedPreferences(PRESETS, 0); }
    else { this.prefs = a; this.presets = saved; }
  }
  /** mode() reads the mode; mode(mode) saves it. */
  mode(mode) {
    if (mode !== undefined) { ThemeSettings.commit(this.prefs.edit().putString('mode', mode.name())); return; }
    try { return Mode.valueOf(this.prefs.getString('mode', 'DARK')); } catch (e) { return Mode.DARK; }
  }
  /** selected() reads the selected date; selected(date) saves it. */
  selected(date) {
    if (date !== undefined) { this.prefs.edit().putString('selected', date.toString()).apply(); return; }
    try { return LocalDate.parse(this.prefs.getString('selected', LocalDate.now().toString())); } catch (e) { return LocalDate.now(); }
  }
  static light(mode, time) { return mode === Mode.LIGHT || (mode === Mode.AUTO && time.getHour() >= 6 && time.getHour() < 18); }
  static nextBoundary(now) { const day = now.toLocalDate(); const hour = now.getHour(); return (hour < 6 ? day.atTime(6, 0) : hour < 18 ? day.atTime(18, 0) : day.plusDays(1).atTime(6, 0)).atZone(now.getZone()); }
  current() { return this.palette(ThemeSettings.light(this.mode(), LocalTime.now())); }
  palette(light) {
    try { const value = this.prefs.getString(light ? 'light' : 'dark', null); if (value != null) { const p = ThemePalette.parse(new JSONObject(value)); if (p.light === light) return p; } } catch (ignored) { /* falls back to the defaults */ }
    return new ThemePalette(light);
  }
  apply(light, dark, favorites) {
    if (!light.light || dark.light) throw new IllegalArgumentException('Bảng màu sáng/tối không khớp');
    const a = new JSONArray(); for (const c of favorites) a.put(c | 0);
    ThemeSettings.commit(this.prefs.edit().putString('light', light.json().toString()).putString('dark', dark.json().toString()).putString('favorites', a.toString()));
  }
  favorites() { const list = []; try { const a = new JSONArray(this.prefs.getString('favorites', '[]')); for (let i = 0; i < Math.min(48, a.length()); i++) list.push(a.getInt(i)); } catch (ignored) { /* none */ } return list; }
  reset() { ThemeSettings.commit(this.prefs.edit().clear()); }
  /** Restores the factory colors of one palette only; mode, favorites and saved color sets stay. */
  resetPalette(light) { ThemeSettings.commit(this.prefs.edit().remove(light ? 'light' : 'dark')); }
  /** Palette shown right now: Light/Dark mode, or Auto by the phone clock. */
  activeLight() { return ThemeSettings.light(this.mode(), LocalTime.now()); }
  static commit(e) { if (!e.commit()) throw new IllegalStateException('Không lưu được giao diện. Vui lòng thử lại.'); }
}
