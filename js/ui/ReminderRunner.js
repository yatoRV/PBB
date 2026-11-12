// The in-page reminder runner (user decision 2): the web counterpart of the APK's ReminderReceiver + notification
// shade, alive only while the page (or the home-screen web app) is open. Installed once by js/ui/start.js:
//  - the NotificationManager presenter: an in-app banner (title, text, sub text; tap opens the month like the
//    notification's tap intent; "×" dismisses it), the chosen tone (js/platform/media.js) and vibration;
//  - audio unlock on the first tap (iOS);
//  - ReminderEngine.reschedule when the page becomes visible again (catch-up of reminders due < 2 h, as the APK does
//    after Doze or a reboot) and when the saved rosters change (a debounced "schedules" preference listener);
//  - one delivering tab: with several tabs open, the holder of the Web Lock "lich-di-lam-reminders" delivers
//    (ReminderEngine.leader); another tab takes over when it closes. Without Web Locks every tab delivers;
//  - a tap on a system notification (sw.js message "reminder.open") opens the month like the banner.
// Nothing is delivered while the page is closed.
import { Intent } from '../platform/android.js';
import { Context } from '../platform/context.js';
import { NotificationManager } from '../platform/notification.js';
import { MediaPlayer, installUnlock } from '../platform/media.js';
import { AppLog } from '../core/AppLog.js';
import { ReminderEngine } from '../core/ReminderEngine.js';
import { el, describe } from './Views.js';

const app = new Context();

export class ReminderRunner {
  constructor(router) { this.router = router; this.host = null; this.banners = new Map(); this.player = null; this._timer = null; this._off = []; }
  install(doc = document) {
    this.host = el('div', 'reminder-banners'); this.host.setAttribute('aria-live', 'assertive'); doc.body.append(this.host);
    NotificationManager.setPresenter({ show: (tag, n, gone) => this.show(tag, n, gone), dismiss: tag => this.dismiss(tag) });
    this._off.push(installUnlock(doc));
    const visible = () => { if (doc.visibilityState === 'visible') this.reschedule('visible'); };
    doc.addEventListener('visibilitychange', visible); this._off.push(() => doc.removeEventListener('visibilitychange', visible));
    const schedules = app.getSharedPreferences('schedules', 0); const changed = () => this.rescheduleSoon();
    schedules.registerOnSharedPreferenceChangeListener(changed); this._off.push(() => schedules.unregisterOnSharedPreferenceChangeListener(changed));
    const container = globalThis.navigator?.serviceWorker;
    if (container != null) { const message = e => { if (e.data?.type !== 'reminder.open') return; if (e.data.tag) NotificationManager.cancel(e.data.tag); if (e.data.month && this.router != null) this.router.clearTop(new Intent(app, 'MainActivity').putExtra('month', e.data.month)); }; container.addEventListener('message', message); this._off.push(() => container.removeEventListener('message', message)); }
    const locks = globalThis.navigator?.locks;
    if (locks != null && typeof locks.request === 'function') {
      ReminderEngine.leader = false; let release = null; const held = new Promise(resolve => { release = resolve; }); this._off.push(() => { ReminderEngine.leader = false; release(); });
      locks.request('lich-di-lam-reminders', () => { ReminderEngine.leader = true; AppLog.event('reminder.runner.leader', AppLog.data()); this.reschedule('leader'); return held; }).catch(e => AppLog.failure('reminder.runner.lock', e));
    }
    this.reschedule('start');
    return this;
  }
  reschedule(reason) { try { ReminderEngine.reschedule(app); } catch (e) { AppLog.failure('reminder.runner.' + reason, e); } }
  rescheduleSoon() { if (this._timer != null) clearTimeout(this._timer); this._timer = setTimeout(() => { this._timer = null; this.reschedule('rosterChanged'); }, 1500); }
  show(tag, n, gone) {
    this.dismiss(tag);
    const banner = el('div', 'reminder-banner'); banner.setAttribute('role', 'alert'); banner.tabIndex = 0;
    const text = el('div', 'reminder-banner__text'); text.append(el('p', 'reminder-banner__title', n.title), el('p', 'reminder-banner__body', n.body));
    if (n.subText) text.append(el('p', 'reminder-banner__sub', n.subText));
    const close = el('button', 'reminder-banner__close', '×'); close.type = 'button'; describe(close, 'Đóng');
    const remove = () => { if (this.banners.get(tag)?.banner !== banner) return; this.banners.delete(tag); banner.remove(); gone(); };
    close.addEventListener('click', e => { e.stopPropagation(); remove(); });
    // The notification's tap intent: MainActivity on the reminder's month (FLAG_ACTIVITY_CLEAR_TOP); auto-cancel.
    const open = () => { remove(); if (n.month != null && this.router != null) this.router.clearTop(new Intent(app, 'MainActivity').putExtra('month', n.month)); };
    banner.addEventListener('click', open); banner.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
    banner.append(text, close); this.host.prepend(banner); this.banners.set(tag, { banner });
    if (n.sound != null) this.tone(n.sound); // always set: the chosen tone or ReminderEngine.WEB_DEFAULT_TONE
    if (n.vibrate && typeof navigator.vibrate === 'function') try { navigator.vibrate([0, 250, 250, 250]); } catch (ignored) { /* not allowed */ }
  }
  dismiss(tag) { const b = this.banners.get(tag); if (b == null) return; this.banners.delete(tag); b.banner.remove(); }
  tone(uri) {
    if (this.player != null) this.player.release(); const player = this.player = new MediaPlayer();
    player.setOnPreparedListener(p => { if (this.player === p) try { p.start(); } catch (e) { AppLog.failure('reminder.tone', e); } });
    player.setOnCompletionListener(p => { if (this.player === p) { p.release(); this.player = null; } });
    player.setOnErrorListener(p => { AppLog.event('reminder.tone.failed', AppLog.data('sound', uri)); if (this.player === p) { p.release(); this.player = null; } return true; });
    try { player.setDataSource(app, uri); player.prepareAsync(); } catch (e) { AppLog.failure('reminder.tone', e); this.player = null; }
  }
  uninstall() { for (const off of this._off.splice(0)) off(); NotificationManager.setPresenter(null); if (this.host != null) this.host.remove(); }
}
