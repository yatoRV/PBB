// Service worker of Lịch đi làm (web) — ONLY for system notifications of the in-page reminder runner.
// Phones show a web page's notifications only through a service worker registration
// (ServiceWorkerRegistration.showNotification; Android Chrome and iOS home-screen web apps do not support
// `new Notification()`). It has NO fetch handler and caches NOTHING, so a new version of the site on GitHub Pages is
// always loaded as is. Registered by js/main.js after sign-in (js/platform/notification.js registerServiceWorker),
// scope = the site folder (./, e.g. /PBB/).
// A tap on a notification closes it, focuses the open app (or opens it) and tells the page which month to show
// (message {type: 'reminder.open', month, tag}; js/ui/ReminderRunner.js opens MainActivity on that month).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil((async () => {
    const scope = self.registration.scope;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find(c => c.url.startsWith(scope));
    if (client) {
      try { await client.focus(); } catch (e) { /* focus not allowed */ }
      client.postMessage({ type: 'reminder.open', month: data.month || null, tag: event.notification.tag || null });
      return;
    }
    if (self.clients.openWindow) await self.clients.openWindow(scope);
  })());
});
