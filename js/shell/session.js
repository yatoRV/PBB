// Pieces of the signed-in session that js/main.js wires to the page: renewing the token on a user gesture,
// saving when the page is hidden or closed, and the sign-in error texts.
import { SignInError } from '../cloud/google-auth.js';
import { RestoreError } from '../cloud/drive-sync.js';

/** Error line of the sign-in screen. */
export const MESSAGES = Object.freeze({
  cancelled: 'Đăng nhập đã bị hủy.',
  scope: 'Cần cho phép truy cập Google Drive để lưu dữ liệu.',
  failed: 'Đăng nhập không thành công. Vui lòng thử lại.',
  drive: 'Không tải được dữ liệu từ Google Drive. Vui lòng thử lại.',
});
export function signInMessage(e) {
  if (e instanceof RestoreError) return MESSAGES.drive;
  if (e instanceof SignInError && MESSAGES[e.kind]) return MESSAGES[e.kind];
  return MESSAGES.failed;
}

// Events that carry user activation, so the GIS popup may open: pointerup (touch), click, keydown.
const GESTURES = ['pointerup', 'click', 'keydown'];

/**
 * When the token expired (Drive answered 401 or the hour is over), the next tap/click/key asks GIS for a new
 * token for the same account (no account chooser), then calls onToken() (the sync retries its queued save).
 * A failed or cancelled renewal waits for the next gesture again. arm() is idempotent.
 */
export function reauthOnGesture({ doc, auth, onToken, onError = () => {} }) {
  let armed = false, busy = false;
  const handler = () => {
    if (busy) return;
    disarm(); busy = true;
    auth.refresh().then(() => { busy = false; onToken(); }, e => { busy = false; if (onError(e) !== false) arm(); }); // false: stop asking (Task A8)
  };
  function arm() { if (armed || busy) return; armed = true; for (const t of GESTURES) doc.addEventListener(t, handler, { capture: true }); }
  function disarm() { if (!armed) return; armed = false; for (const t of GESTURES) doc.removeEventListener(t, handler, { capture: true }); }
  return { arm, disarm, get armed() { return armed; } };
}

const NOT_TEXT = /^(?:button|submit|reset|checkbox|radio|range|color|file|image|hidden)$/i;
/** Default edit guard: a text field, select or editable element has focus, or a dialog is open. */
export function defaultReloadGuard(doc) {
  const a = doc.activeElement;
  if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable === true || (a.tagName === 'INPUT' && !NOT_TEXT.test(a.type ?? '')))) return true;
  return !!doc.querySelector?.('dialog[open], [aria-modal="true"]:not([hidden])');
}

/**
 * Tells whether the user is in the middle of something, so another device's changes must not replace the screens'
 * state yet. blocked() is true while the guard says so (default: defaultReloadGuard; setGuard(fn) for screens with
 * their own unsaved UI state, setGuard(null) restores it), while a pointer is down, and for SETTLE_MS after any
 * tap/click/key — so a field losing focus because the user clicks "Save" never lets an update in before that
 * click's handler ran. whenClear(fn) runs fn as soon as blocked() is false: now, SETTLE_MS after a focus / dialog
 * / visibility / pointer change, or at the latest on the next poll.
 */
export const SETTLE_MS = 300;
export function uiGuard({ doc, win, timers = globalThis, now = () => Date.now(), pollMs = 1000, settleMs = SETTLE_MS }) {
  const fallback = () => defaultReloadGuard(doc);
  let guard = fallback, pending = null, poll = null, pointerDown = false, lastInput = -Infinity;
  const later = () => { timers.setTimeout(attempt, settleMs); };
  const input = () => { lastInput = now(); };
  const listen = [
    [doc, 'pointerdown', () => { pointerDown = true; input(); }],
    [doc, 'pointerup', () => { pointerDown = false; input(); later(); }],
    [doc, 'pointercancel', () => { pointerDown = false; input(); later(); }],
    [doc, 'click', () => { input(); later(); }],
    [doc, 'keydown', () => { input(); later(); }],
    [doc, 'focusout', later], [doc, 'close', later], [doc, 'visibilitychange', later], [win, 'blur', later],
  ];
  for (const [t, n, fn] of listen) t.addEventListener(n, fn, true);
  function blocked() {
    if (pointerDown || now() - lastInput < settleMs) return true;
    try { return !!guard(); } catch (e) { return false; }
  }
  function attempt() {
    if (pending == null || blocked()) return;
    const fn = pending; pending = null;
    if (poll != null) { timers.clearInterval(poll); poll = null; }
    fn();
  }
  return {
    blocked,
    whenClear(fn) {
      pending = fn; attempt();
      if (pending != null && poll == null) poll = timers.setInterval(attempt, pollMs);
    },
    setGuard(fn) { guard = fn ?? fallback; attempt(); },
    get pending() { return pending != null; },
  };
}

/**
 * Saves at once when the page is hidden or closed; when it is visible again or gets focus, uploads what is pending
 * or pulls what another device saved meanwhile; retries when back online. Returns an unwire function.
 */
export function wirePageLifecycle({ doc, win, sync }) {
  const visibility = () => { if (doc.visibilityState === 'hidden') sync.flush(); else sync.check(); };
  const hide = () => { sync.flush(); };
  const focus = () => { sync.check(); };
  const online = () => { sync.retry(); };
  doc.addEventListener('visibilitychange', visibility);
  win.addEventListener('pagehide', hide);
  win.addEventListener('focus', focus);
  win.addEventListener('online', online);
  return () => {
    doc.removeEventListener('visibilitychange', visibility); win.removeEventListener('pagehide', hide);
    win.removeEventListener('focus', focus); win.removeEventListener('online', online);
  };
}
