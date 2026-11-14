// App shell: Google sign-in first, then the user's data from Google Drive, then the app screens.
// Nothing of the app (data, screens) is loaded before a valid Google token and the account's profile exist.
// Boot after sign-in: restore Drive data (prefs + files) → AppLog.initialize (LogApplication.onCreate) →
// await Personnel.load(context) → theme → old pipe-scans folders pruned (Task A6) → mount js/ui/start.js. Every change is then autosaved by DriveSync.
// Only what the sign-in screen needs is imported statically; the app modules (≈ 45 files) load in the background
// once that screen shows (loadApp), so it appears without waiting for them.
import { GOOGLE_CLIENT_ID, GOOGLE_SCOPES } from './config.js';
import { GoogleAuth, loadGis } from './cloud/google-auth.js';
import { MESSAGES, signInMessage, reauthOnGesture, wirePageLifecycle, uiGuard } from './shell/session.js';

/** The app modules, loaded once (a failed load, e.g. offline, is retried by the next call). */
let appModules = null, appLoaded = null;
function loadApp() {
  if (appLoaded == null) appLoaded = Promise.all([
    import('./platform/notification.js'), import('./cloud/drive-api.js'), import('./cloud/drive-sync.js'), import('./cloud/user-cache.js'),
    import('./shell/theme.js'), import('./platform/context.js'), import('./core/AppLog.js'), import('./core/Personnel.js'),
  ]).then(ms => (appModules = Object.assign({}, ...ms)), e => { appLoaded = null; throw e; });
  return appLoaded;
}
/** Task A6: the screens' modules (js/ui/start.js and the main screen, with the OCR and job modules they import) start
 *  downloading while the user signs in or while Drive is read, instead of after; loading them runs no app code (they
 *  only define classes and functions). A failure here is met again, and handled, by the real import later. */
let screensLoading = null;
function preloadScreens() {
  if (screensLoading == null) screensLoading = Promise.all([import('./ui/start.js'), import('./ui/MainActivity.js')]).catch(() => { screensLoading = null; });
  return screensLoading;
}

// GitHub Pages cannot send frame-ancestors / X-Frame-Options: the app never runs inside another site's frame
// (clickjacking). The page then stays on its loading screen.
if (window.top !== window.self) throw new Error('Lịch đi làm: framed page refused');

const $ = id => document.getElementById(id);
const views = { boot: $('boot'), signin: $('signin'), app: $('app') };
const button = $('signin-button'), errorLine = $('signin-error');

function show(name) { for (const [k, el] of Object.entries(views)) el.hidden = k !== name; }
let gisState = 'loading'; // the button stays disabled until GIS is loaded, so the first tap can open its popup
function showSignIn(message = '') { errorLine.textContent = message; button.disabled = gisState === 'loading'; show('signin'); }
function sessionStore() { try { return globalThis.sessionStorage; } catch (e) { return null; } }

function localStore() { try { return globalThis.localStorage; } catch (e) { return null; } }
// Task A8: the account is remembered on this device (never the token) until "Đăng xuất".
const auth = new GoogleAuth({ fetch: (...a) => fetch(...a), clientId: GOOGLE_CLIENT_ID, scopes: GOOGLE_SCOPES, storage: sessionStore(), accountStorage: localStore() });
/** The GIS library (loaded at start; loading again after a failure, e.g. offline). */
const ensureGis = () => loadGis(document).then(gis => { auth.attachGis(gis); gisState = 'ready'; return gis; });
ensureGis().then(() => { if (!entered) button.disabled = false; }, () => {
  gisState = 'failed';
  if (!entered) { errorLine.textContent = MESSAGES.failed; button.disabled = false; }
});
let cache = null, sync = null, theme = null, unwire = null, entered = false;

// Sync diagnostics go to AppLog once it is initialised (the restore happens before).
const pendingLogs = [];
function logSync(type, data) {
  const pairs = []; for (const [k, v] of Object.entries(data ?? {})) pairs.push(k, v);
  const AppLog = appModules?.AppLog;
  if (AppLog == null || AppLog.current() == null) { pendingLogs.push([type, pairs]); return; }
  AppLog.event('drive.' + type, AppLog.data(...pairs));
}

const reauth = reauthOnGesture({
  doc: document, auth,
  onToken: () => { sync?.check(); }, // uploads what waits, else pulls what other devices saved (Task A8)
  onError: e => {
    logSync('reauthFailed', { kind: e?.kind ?? 'failed', message: String(e?.message ?? e) });
    if (e?.kind !== 'account') return true; // asked again at the next tap
    // Task A8: the browser's Google account is not the remembered one: no popup at every tap; the copy here stays,
    // and "Đăng xuất" then signing in with the right account brings Drive back.
    import('./platform/widget.js').then(({ Toast }) => Toast.makeText(appModules?.appContext, 'Tài khoản Google trên trình duyệt khác tài khoản của app nên chưa đồng bộ được với Google Drive. Bấm Đăng xuất rồi đăng nhập lại đúng tài khoản.', Toast.LENGTH_LONG).show()).catch(() => {});
    return false;
  },
});

/**
 * Another device's save reaches this page only while the user is not in the middle of an edit (ui.blocked()):
 * DriveSync then merges it in and calls remoteChanged(), and the page reloads at once (the screens hold the old
 * state; the merged state is already in IndexedDB and the tab session skips the sign-in screen). While the user is
 * editing, nothing is applied and saves made meanwhile are merged against the old base later (resumeRemote).
 */
const ui = uiGuard({ doc: document, win: window });
function remoteChanged() { location.reload(); }
function remoteWaiting() { ui.whenClear(() => { sync?.resumeRemote(); }); }
/**
 * Lets a screen hold back another device's changes while it has unsaved UI state: fn() returns true to wait
 * (checked again after taps, focus and dialog changes, and every second). setReloadGuard(null) restores the
 * default (editable field focused or dialog open).
 */
export function setReloadGuard(fn) { ui.setGuard(fn); }

/** Signed in: restore the user's data, then open the app. Stays on the sign-in screen if anything fails. */
async function enter(profile) {
  if (entered) return; entered = true;
  show('boot');
  let m;
  try { m = await loadApp(); } catch (e) { entered = false; showSignIn(MESSAGES.failed); return; }
  preloadScreens(); // meanwhile Drive is read (Task A6)
  const { UserCache, DriveApi, DriveSync, AppLog, appContext, startTheme, Personnel, registerServiceWorker } = m;
  cache = new UserCache();
  const api = new DriveApi({ fetch: (...a) => fetch(...a), getToken: () => auth.token() });
  sync = new DriveSync({ api, cache, sub: profile.sub, log: logSync, onAuthNeeded: () => { auth.invalidate(); reauth.arm(); },
    onRemoteChange: remoteChanged, mayApplyRemote: () => !ui.blocked(), onRemoteWaiting: remoteWaiting });
  // Task A8: a remembered account without a token opens this device's copy; Drive follows the next tap.
  const offline = auth.token() == null;
  try { await sync.restore({ offline }); }
  catch (e) { await sync.close(); sync = null; entered = false; showSignIn(offline ? '' : signInMessage(e)); return; }
  if (offline) reauth.arm();
  unwire = wirePageLifecycle({ doc: document, win: window, sync });
  try {
    AppLog.initialize(appContext);
    for (const [type, pairs] of pendingLogs.splice(0)) AppLog.event('drive.' + type, AppLog.data(...pairs));
    theme = startTheme(appContext);
    await Personnel.load(appContext);
    // Task A6: the evidence folders of earlier pipe readings nothing refers to any more (they went to Drive with
    // every save and came back at every sign-in); before any reading can start.
    try {
      const { prunePipeScans } = await import('./shell/prune-scans.js'); const pruned = prunePipeScans();
      if (pruned.removed > 0) AppLog.event('storage.pipeScansPruned', AppLog.data('removed', pruned.removed, 'kept', pruned.kept, 'files', pruned.files, 'bytes', pruned.bytes));
    } catch (e) { logSync('pruneFailed', { message: String(e?.message ?? e) }); } // tried again at the next sign-in
    const root = views.app;
    show('app');
    const { mount } = await import('./ui/start.js');
    await mount(root, appContext, { setReloadGuard, signOut, profile: () => auth.profile });
    registerServiceWorker(); // sw.js: system notifications of the reminders only (no cache), after sign-in
  } catch (e) {
    // Never a blank screen: back to the sign-in screen with the error line (the data stays saved).
    logSync('bootFailed', { message: String(e?.message ?? e) });
    unwire(); unwire = null; theme?.stop(); theme = null;
    try { await sync.flush(); } finally { await sync.close(); sync = null; entered = false; }
    views.app.textContent = '';
    showSignIn(MESSAGES.failed);
  }
}

button.addEventListener('click', async () => {
  errorLine.textContent = ''; button.disabled = true;
  try {
    // GIS loaded: open its popup synchronously inside this tap (no await before it), or Safari's popup blocker
    // drops the user gesture. Only a not-yet-loaded GIS (slow network, retry after a failure) is awaited first.
    const signingIn = gisState === 'ready' ? auth.signIn() : ensureGis().then(() => auth.signIn());
    const profile = await signingIn;
    await enter(profile);
  } catch (e) { if (!entered) showSignIn(signInMessage(e)); }
});

/** OCR checkpoints of reading jobs (js/ocr/checkpoint.js, Task A2) at "Đăng xuất": the account's entries are deleted
 *  now (calls still running write nothing) and marked, so a page that starts signed out deletes whatever another tab
 *  of that account wrote since. A page that is only signed out (new tab, restart, expired session) keeps them, so an
 *  unfinished read can still continue after signing in. */
async function signOutOcrCheckpoints(sub) {
  try {
    const m = await import('./ocr/checkpoint.js'); m.markSignedOut(localStore(), sub);
    await m.OcrCheckpoint.clearAccount(sub); await (m.OcrCheckpoint.store ?? new m.CheckpointStore()).clear({ sub });
  } catch (e) { /* no IndexedDB: nothing stored */ }
}
/** A page starting signed out: only the accounts that signed out explicitly lose their checkpoints. */
async function clearSignedOutOcrCheckpoints() {
  try {
    const storage = localStore(); const m = await import('./ocr/checkpoint.js');
    if (storage?.getItem(m.SIGNED_OUT_KEY) != null) await m.clearSignedOut({ storage, store: new m.CheckpointStore() });
  } catch (e) { /* tried again at the next start */ }
}

async function boot() {
  let profile = null;
  try { profile = await auth.restore(); } catch (e) { profile = null; }
  if (profile) await enter(profile);
  else { showSignIn(gisState === 'failed' ? MESSAGES.failed : ''); clearSignedOutOcrCheckpoints(); loadApp().then(preloadScreens, () => { /* retried by enter() */ }); }
}
boot();

/**
 * Signs out: saves what is pending, wipes this account's copy on this device, revokes the token and reloads to
 * the sign-in screen. Rejects with Error('unsynced') when changes could not reach Drive, unless discardUnsynced.
 * now (Task A7, "Đăng xuất ngay"): does not wait for Drive; when Drive may not have everything yet, this device's copy
 * (and the account's OCR checkpoints) are kept, and the next sign-in of the account sends the changes. It may be
 * called while a waiting sign-out is still saving; that one then stops. The token revoke waits at most REVOKE_WAIT_MS.
 * The APK has no sign-out; the main screen places it next to Reset / Giao diện (user decision, Task 11).
 */
const REVOKE_WAIT_MS = 1500;
let leavingNow = false;
export async function signOut({ discardUnsynced = false, now = false } = {}) {
  if (sync) {
    let keep = false;
    if (now) { leavingNow = true; try { keep = await sync.leave(); } catch (e) { leavingNow = false; throw e; } }
    else {
      await sync.flush();
      if (leavingNow) return new Promise(() => {}); // "Đăng xuất ngay" took over meanwhile; the page is reloading
      if (sync.dirty && !discardUnsynced) throw new Error('unsynced');
    }
    unwire?.(); theme?.stop(); reauth.disarm();
    if (!now) await sync.close(); // no IndexedDB write can follow the wipe
    if (!keep) {
      try { await cache.wipe(sync.sub); } catch (e) { /* the reload drops the memory copy anyway */ }
      await signOutOcrCheckpoints(sync.sub); // the account's OCR checkpoints go with it (Task A2)
    }
  }
  await Promise.race([auth.signOut(), new Promise(resolve => setTimeout(resolve, REVOKE_WAIT_MS))]);
  location.reload();
}
/** Signed-in account ({sub, email, name, picture}) or null, and the autosave (status, onStatus, flush). */
export const session = Object.freeze({ profile: () => auth.profile, sync: () => sync, theme: () => theme });
