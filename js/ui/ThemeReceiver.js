// Port of vn.lichdilam.ThemeReceiver (APK 4.5).
// One boundary alarm, no background polling service. Foreground transitions use the UI clock.
// Web: the AlarmManager alarm is a page timer at the next 06:00/18:00 boundary (Auto mode only; any other mode
// cancels it). On receive it logs, refreshes the launcher widgets (none on the web: CalendarWidget is not portable)
// and tells the open page to re-apply its theme, then re-arms. Timers sleep while an iPhone page is hidden, so
// ThemedActivity also re-checks when the page becomes visible.
import { AppLog } from '../core/AppLog.js';
import { ThemeSettings } from '../core/ThemeSettings.js';
import { ZonedDateTime, Duration } from '../platform/time.js';
import { Intent } from '../platform/android.js';

let alarm = null;
const receivers = new Set();

export class ThemeReceiver {
  /** Listeners run on every boundary (the page's theme refresh). Returns a function that removes the listener. */
  static listen(fn) { receivers.add(fn); return () => receivers.delete(fn); }
  static onReceive(c, i) {
    AppLog.event('theme.receive', AppLog.intent(i));
    // CalendarWidget.refreshAppearance(c): no launcher widget on the web.
    for (const fn of [...receivers]) fn();
    ThemeReceiver.schedule(c);
  }
  static schedule(c, timers = globalThis) {
    if (alarm != null) timers.clearTimeout(alarm); alarm = null;
    if (new ThemeSettings(c).mode() !== ThemeSettings.Mode.AUTO) return;
    const now = ZonedDateTime.now(), at = ThemeSettings.nextBoundary(now);
    alarm = timers.setTimeout(() => { alarm = null; ThemeReceiver.onReceive(c, new Intent('vn.lichdilam.THEME_BOUNDARY')); }, Math.max(0, Duration.between(now, at).toMillis()));
  }
  /** Whether an alarm is armed (tests). */
  static armed() { return alarm != null; }
}
