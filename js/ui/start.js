// Entry of the app screens, mounted by js/main.js once the user is signed in, their data is restored from Drive and
// Personnel is loaded. It installs the OCR engine, then starts MainActivity (Intent.ACTION_MAIN) in a small
// Activity router.
//
// Router (the Android activity stack):
//  - start(intent, request, caller): loads js/ui/<Screen>.js (the Activity class of that name), creates it in its
//    own <section class="activity"> on top of the stack: onCreate(state) → onStart → onResume; the screen below
//    gets onPause → onStop. A screen not ported yet is logged ("navigation.missing") and nothing opens.
//  - finish(screen): onPause → onStop → onDestroy, then the screen below gets onActivityResult(request, code, data)
//    (for startActivityForResult) → onStart → onResume. The root screen cannot finish: a web page cannot close
//    itself.
//  - Back (the browser/Android back button, iOS edge swipe): a history entry is kept on top, so "popstate" cancels
//    the top dialog if one is open, else calls onBackPressed() of the top screen.
//  - The page hidden (Home, app switch, lock) pauses/stops the top screen; visible again starts/resumes it.
//  - setReloadGuard: another device's changes wait while the default guard holds (a field focused, a dialog open)
//    or the top screen holdsRemote() (draft save pending, OCR running).
// Screens are js/ui/<Name>.js exporting class <Name> extends ThemedActivity. The reminder runner (js/ui/ReminderRunner.js)
// is installed with the router: reminders fire only while the page is open.
import { Intent } from '../platform/android.js';
import { AlertDialog } from '../platform/widget.js';
import { AppLog } from '../core/AppLog.js';
import { defaultReloadGuard } from '../shell/session.js';
import { installDefaultEngine } from '../ocr/engine.js';
import { warmUpAfterSignIn } from '../ocr/warm-up.js';
import { OcrCheckpoint, CheckpointStore, unmarkSignedOut } from '../ocr/checkpoint.js';
import { ReadJobs } from '../jobs/read-jobs.js';
import { ReminderRunner } from './ReminderRunner.js';

/** Screen name → module (lazy). */
const SCREENS = new Set(['MainActivity', 'ReminderActivity', 'PipeTableActivity', 'PipeImportActivity', 'AppearanceActivity', 'LogActivity', 'PhotoViewerActivity']);

export class Router {
  constructor(host, context, shell = {}) {
    this.host = host; this.context = context; this.shell = shell; this.stack = []; this._history = false;
    this._popstate = () => { this._pushSentinel(); this.back(); };
    this._visibility = () => { const top = this.top(); if (top == null) return; if (document.visibilityState === 'hidden') { if (top._resumed) this._pause(top); } else if (!top._resumed) { top.onStart(); this._resume(top); } };
    this._pagehide = () => { const top = this.top(); if (top != null && top._resumed) this._pause(top); };
  }
  top() { return this.stack.length === 0 ? null : this.stack[this.stack.length - 1]; }
  install() {
    try { history.pushState({ lich: 'top' }, ''); this._history = true; } catch (e) { /* no history API */ }
    addEventListener('popstate', this._popstate); document.addEventListener('visibilitychange', this._visibility); addEventListener('pagehide', this._pagehide);
    if (this.shell.setReloadGuard) this.shell.setReloadGuard(() => defaultReloadGuard(document) || (this.top()?.holdsRemote() ?? false));
  }
  _pushSentinel() { if (this._history) try { history.pushState({ lich: 'top' }, ''); } catch (e) { /* ignore */ } }
  back() { const dialog = AlertDialog.top(); if (dialog != null) { dialog.cancel(); return; } const top = this.top(); if (top != null) top.onBackPressed(); }
  _pause(a) { a._resumed = false; a.onPause(); a.onStop(); }
  _resume(a) { a._resumed = true; a.onResume(); }
  async start(intent, request = -1, caller = null) {
    const name = intent.getComponent();
    if (!SCREENS.has(name)) { AppLog.event('navigation.missing', AppLog.data('screen', name)); return null; }
    let Screen;
    try { Screen = (await import('./' + name + '.js'))[name]; if (typeof Screen !== 'function') throw new Error('no class ' + name); }
    catch (e) { AppLog.event('navigation.missing', AppLog.data('screen', name, 'message', String(e?.message ?? e))); return null; }
    const below = this.top();
    const section = document.createElement('section'); section.className = 'activity' + (below == null ? '' : ' activity--enter'); section.dataset.screen = name;
    const a = new Screen(); a._attach(this, intent, section); a._request = request; a._caller = caller; a._resumed = false; a._shell = this.shell;
    if (below != null && below._resumed) this._pause(below);
    this.stack.push(a); this.host.append(section);
    for (const other of this.stack) if (other !== a) other.root.hidden = true;
    await a.onCreate(null);
    if (a.isFinishing()) return a;
    a.onStart(); this._resume(a);
    if (below != null) requestAnimationFrame(() => section.classList.remove('activity--enter'));
    return a;
  }
  /** FLAG_ACTIVITY_CLEAR_TOP to the root screen (a reminder's tap intent): the screens above it finish, the root
   *  gets onNewIntent(intent). */
  clearTop(intent) {
    while (this.stack.length > 1) { const top = this.top(); top._finishing = true; this.finish(top); }
    const root = this.top(); if (root != null && typeof root.onNewIntent === 'function') root.onNewIntent(intent);
  }
  finish(a) {
    const i = this.stack.indexOf(a);
    if (i <= 0) { a._finishing = false; return; } // the root screen: a web page cannot close itself
    if (a._resumed) this._pause(a);
    this.stack.splice(i, 1); a.onDestroy(); a.root.remove();
    const top = this.top();
    if (i === this.stack.length && top != null) {
      top.root.hidden = false;
      if (a._caller === top && a._request >= 0) top.onActivityResult(a._request, a._result.code, a._result.data);
      top.onStart(); this._resume(top);
    }
  }
}

/** Mounts the first screen into `root` (the #app element). `context` is the application Context; `shell` gives
 *  { setReloadGuard, signOut, profile } from js/main.js. */
export async function mount(root, context, shell = {}) {
  root.className = 'app';
  root.replaceChildren();
  installDefaultEngine();
  // Reading-job checkpoints (Task A2) of this Google account only: other accounts' entries go, stale ones are pruned.
  OcrCheckpoint.use(new CheckpointStore());
  { const sub = shell.profile?.()?.sub; if (sub != null) try { unmarkSignedOut(globalThis.localStorage, sub); } catch (e) { /* no localStorage */ } } // signed in again: keep them
  OcrCheckpoint.setAccount(shell.profile?.()?.sub ?? null).then(() => { const jobs = new ReadJobs(context); jobs.pruneStale(); const live = jobs.liveIds(); return OcrCheckpoint.prune({ live: id => live.has(id) }); }).catch(() => {});
  const router = new Router(root, context, shell);
  router.install();
  router.reminders = new ReminderRunner(router).install(); // in-page reminders (Task 13), only while the page is open
  await router.start(new Intent(Intent.ACTION_MAIN).setComponent('MainActivity'));
  warmUpAfterSignIn(); // Task A3: the OCR engine (or only its files on iPhone / iPad) once the page is idle
  return router;
}
