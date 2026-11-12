// Applies the app palette (ThemePalette) to the page as CSS custom properties on <html>:
// colour "app.background" → --app-background, size "calendar.horizontalWidth" → --calendar-horizontalWidth (px).
// The mode is ThemeSettings' Sáng/Tối/Auto (Auto = light from 06:00 to before 18:00 by the device clock, as the
// APK). Before sign-in no user setting exists: css/app.css then follows the device appearance with the factory
// palettes. Screens read colours only through these variables (see css/app.css).
import { ThemeSettings } from '../core/ThemeSettings.js';
import { ZonedDateTime, Duration } from '../platform/time.js';

const hex2 = n => (n < 16 ? '0' : '') + n.toString(16);
/** CSS colour of a Java ARGB int: #rrggbb when opaque, else #rrggbbaa. */
export function cssColor(argb) {
  const a = (argb >>> 24) & 255, rgb = hex2((argb >>> 16) & 255) + hex2((argb >>> 8) & 255) + hex2(argb & 255);
  return '#' + rgb + (a === 255 ? '' : hex2(a));
}
/** CSS custom property name of a palette key. */
export const cssName = key => '--' + key.replace(/\./g, '-');
/** [[property, value]] for every colour and size of a palette. */
export function paletteVars(palette) {
  const out = [];
  for (const [k, v] of palette.colors) out.push([cssName(k), cssColor(v)]);
  for (const [k, v] of palette.sizes) out.push([cssName(k), Number(v.toPrecision(7)) + 'px']); // float → shortest decimal
  return out;
}
/** Puts a palette on the page: variables, data-theme, color-scheme and the browser bar colour. */
export function applyPalette(palette, doc = globalThis.document) {
  const root = doc.documentElement;
  root.dataset.theme = palette.light ? 'light' : 'dark';
  for (const [name, value] of paletteVars(palette)) root.style.setProperty(name, value);
  root.style.colorScheme = palette.light ? 'light' : 'dark';
  const meta = doc.querySelector('meta[name="theme-color"]');
  if (meta) { meta.removeAttribute('media'); meta.setAttribute('content', cssColor(palette.color('app.background'))); }
}

/**
 * Keeps the page in the user's theme: applies ThemeSettings.current() now, again when the appearance preferences
 * change, at the next 06:00/18:00 boundary in Auto mode and when the page becomes visible (timers sleep while an
 * iPhone page is in the background). onChange(palette) runs after each change. Returns { palette(), refresh(), stop() }.
 */
export function startTheme(context, { doc = globalThis.document, timers = globalThis, onChange = () => {} } = {}) {
  const settings = new ThemeSettings(context);
  let active = null, timer = null;
  const arm = () => {
    if (timer != null) timers.clearTimeout(timer); timer = null;
    if (settings.mode() !== ThemeSettings.Mode.AUTO) return;
    const now = ZonedDateTime.now();
    timer = timers.setTimeout(refresh, Math.max(100, Duration.between(now, ThemeSettings.nextBoundary(now)).toMillis() + 30));
  };
  function refresh() {
    const next = settings.current();
    const changed = active == null || active.json().toString() !== next.json().toString();
    active = next;
    if (changed) { applyPalette(next, doc); onChange(next); }
    arm();
  }
  const preferenceChanged = () => refresh();
  const visible = () => { if (doc.visibilityState === 'visible') refresh(); };
  settings.prefs.registerOnSharedPreferenceChangeListener(preferenceChanged);
  doc.addEventListener('visibilitychange', visible);
  refresh();
  return {
    palette: () => active,
    refresh,
    stop() { settings.prefs.unregisterOnSharedPreferenceChangeListener(preferenceChanged); doc.removeEventListener('visibilitychange', visible); if (timer != null) timers.clearTimeout(timer); timer = null; },
  };
}
