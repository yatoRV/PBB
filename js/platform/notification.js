// NotificationManager and AlarmManager for the in-page reminder runner (user decision 2: reminders fire only while
// the page — or the home-screen web app — is open; nothing is delivered while it is closed).
//  - AlarmManager: one page timer per key; long waits are cut into hops of at most one hour, so a timer that the
//    browser delayed (background tab) fires as soon as the page runs again. Timers die with the page; the reminder
//    engine re-arms from its saved queue when the page opens (ReminderEngine.reschedule).
//  - NotificationManager: notify(tag, id, n) = the presenter installed by the UI (in-app banner, tone, vibration) and,
//    when the user granted the Notification permission and the page is not in front, a system notification through
//    the service worker (sw.js; phones support no other way; iOS: home-screen web app, 16.4+). The active list holds
//    what is still showing (banner, or a system notification that was really posted).
// No DOM access at import; under Node only the active list and the timers work (tests). "Now" is the Java clock
// (System.currentTimeMillis), so tests can pin it; Node timers never keep the process alive.
import { System } from './java.js';

const HOP = 60 * 60 * 1000;
const timers = new Map(); // key → { at, handle, fire }

export const AlarmManager = Object.freeze({
  /** Arms key at the epoch time `at` (ms); a key armed again replaces the old timer. */
  set(key, at, fire) {
    AlarmManager.cancel(key); const entry = { at, handle: null, fire }; timers.set(key, entry);
    const hop = () => {
      if (timers.get(key) !== entry) return; const wait = at - System.currentTimeMillis();
      if (wait <= 0) { timers.delete(key); try { fire(); } catch (e) { setTimeout(() => { throw e; }); } return; }
      entry.handle = setTimeout(hop, Math.min(HOP, wait)); entry.handle?.unref?.();
    };
    hop();
  },
  cancel(key) { const e = timers.get(key); if (e != null) { clearTimeout(e.handle); timers.delete(key); } },
  has(key) { return timers.has(key); },
  at(key) { return timers.get(key)?.at ?? null; },
  keys() { return [...timers.keys()]; },
  cancelAll() { for (const key of [...timers.keys()]) AlarmManager.cancel(key); },
});

const active = new Map(); // tag → { tag, id, postTime, banner, system: null | 'pending' | 'shown' | Notification }
let presenter = null;
const doc = () => globalThis.document ?? null;
/** The user is looking at the page: the in-app banner and tone are enough (one alert, as the APK shows one). */
const foreground = () => { const d = doc(); return d != null && d.visibilityState === 'visible' && (typeof d.hasFocus !== 'function' || d.hasFocus()); };
const sw = () => globalThis.navigator?.serviceWorker ?? null;

/** Registers sw.js (site root, scope = the site folder) — only for notifications; it caches nothing. */
export function registerServiceWorker() {
  try {
    const container = sw(); if (container == null) return Promise.resolve(null);
    return container.register(new URL('../../sw.js', import.meta.url), { scope: new URL('../../', import.meta.url).pathname }).catch(() => null);
  } catch (e) { return Promise.resolve(null); } // e.g. service workers blocked by the browser: notifications fall back
}
/** A system notification: through the service worker registration (phones), else the page constructor (desktop). */
async function postSystem(title, options, onClick) {
  const container = sw();
  if (container != null) { const registration = await container.getRegistration(new URL('../../', import.meta.url).pathname).catch(() => null); if (registration != null) { await registration.showNotification(title, options); return 'shown'; } }
  if (typeof globalThis.Notification !== 'function') return null;
  try { const n = new globalThis.Notification(title, options); n.onclick = () => { try { globalThis.focus?.(); } catch (ignored) { /* no window */ } n.close(); if (onClick) onClick(); }; return n; } catch (e) { return null; }
}
async function closeSystem(tag, system) {
  if (system != null && typeof system === 'object') { try { system.close(); } catch (ignored) { /* gone */ } return; }
  const container = sw(); if (container == null) return;
  const registration = await container.getRegistration(new URL('../../', import.meta.url).pathname).catch(() => null);
  if (registration != null) for (const n of await registration.getNotifications({ tag })) n.close();
}

export const NotificationManager = Object.freeze({
  /** UI hook: { show(tag, n, onGone), dismiss(tag) } (the in-app banner, tone and vibration). */
  setPresenter(p) { presenter = p; },
  /** The browser has the Notification API (iOS: only a home-screen web app). */
  supported() { return typeof globalThis.Notification === 'function'; },
  /** 'granted' | 'denied' | 'default' | 'unsupported'. */
  permission() { return NotificationManager.supported() ? globalThis.Notification.permission : 'unsupported'; },
  granted() { return NotificationManager.permission() === 'granted'; },
  /** Asks the browser (must run inside a user gesture); resolves to the new permission. */
  async requestPermission() {
    if (!NotificationManager.supported()) return 'unsupported';
    try { const r = globalThis.Notification.requestPermission(); return typeof r?.then === 'function' ? await r : globalThis.Notification.permission; } catch (e) { return globalThis.Notification.permission; }
  },
  /** n = { title, body, subText, when, vibrate, month, icon, onClick }. The banner (and tone) while the page is open;
   *  a system notification too when the permission is granted and the page is not in front. Throws when nothing
   *  can be shown. isActive(tag) is true while the banner shows or after the system notification was really posted. */
  notify(tag, id, n) {
    NotificationManager.cancel(tag); const record = { tag, id, postTime: System.currentTimeMillis(), banner: false, system: null };
    const gone = () => { if (active.get(tag) === record && !record.banner && record.system == null) active.delete(tag); };
    if (presenter != null) { record.banner = true; presenter.show(tag, n, () => { record.banner = false; gone(); }); }
    if (NotificationManager.granted() && !foreground()) {
      record.system = 'pending';
      const options = { body: n.subText ? n.body + '\n' + n.subText : n.body, tag, renotify: true, silent: false, timestamp: n.when ?? System.currentTimeMillis(), icon: n.icon, badge: n.icon, data: { month: n.month ?? null }, vibrate: n.vibrate ? [0, 250, 250, 250] : undefined };
      postSystem(n.title, options, n.onClick).then(r => { if (active.get(tag) !== record) { if (r != null) closeSystem(tag, r); return; } record.system = r; if (r != null && typeof r === 'object') r.onclose = () => { record.system = null; gone(); }; gone(); }, () => { record.system = null; gone(); });
    }
    if (!record.banner && record.system == null) throw new Error('Điện thoại đang chặn thông báo của Lịch đi làm. Cho phép thông báo rồi thử lại.');
    active.set(tag, record);
  },
  cancel(tag) { const r = active.get(tag); if (r == null) return; active.delete(tag); if (r.system != null && r.system !== 'pending') closeSystem(tag, r.system).catch(() => {}); if (r.banner && presenter != null) presenter.dismiss(tag); },
  cancelAll() { for (const tag of [...active.keys()]) NotificationManager.cancel(tag); },
  getActiveNotifications() { return [...active.values()].map(r => ({ getTag: () => r.tag, getId: () => r.id, getPostTime: () => r.postTime })); },
  /** Shown right now: the banner is up, or the system notification was really posted (not just attempted). */
  isActive(tag) { const r = active.get(tag); return r != null && (r.banner || (r.system != null && r.system !== 'pending')); },
});
