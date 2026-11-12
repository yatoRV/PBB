// Port of vn.lichdilam.ThemedActivity (APK 4.5): the base of every web screen.
// A screen is an Activity: a Context with an Intent, a root element (getWindow().getDecorView()) and the Android
// lifecycle, driven by the router of js/ui/start.js (onCreate → onStart → onResume; onPause → onStop → onDestroy;
// the page going to the background pauses/stops the top screen, coming back starts/resumes it).
// Web adaptations:
//  - the palette is the CSS variables written by js/shell/theme.js, so recolouring views/dialogs (ThemeUi.visit)
//    is automatic; refreshTheme() only keeps palette() current and calls onPaletteChanged();
//  - clock/time-zone broadcasts → the page becoming visible; the Auto boundary timer is kept (06:00/18:00 + 30 ms);
//  - the OnGlobalLayoutListener that watches new fields → a MutationObserver on the root;
//  - an Android process keeps running in the background and saves UiResume in onPause; a web page can be reloaded
//    (another device's merge) or killed at any time, so setContentView also schedules the 600 ms UiResume save, and
//    holdsRemote() is true while that save is pending or the screen is busy (js/main.js setReloadGuard).
import { Context } from '../platform/context.js';
import { ZonedDateTime, Duration } from '../platform/time.js';
import { AppLog } from '../core/AppLog.js';
import { ThemeSettings } from '../core/ThemeSettings.js';
import { UiResume } from './UiResume.js';
import { UiSessionLog } from './UiSessionLog.js';
import { ThemeReceiver } from './ThemeReceiver.js';

const FIELD = 'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=file]),textarea';

export class ThemedActivity extends Context {
  static RESULT_OK = -1;
  static RESULT_CANCELED = 0;
  constructor() {
    super();
    this._active = null; this._dialogs = []; this._observing = false; this._restored41 = false; this._restoreViews41 = false;
    this._themeClock = null; this._resumeWriter = null; this._watched41 = new WeakSet(); this._layout = null;
    this._destroyed = false; this._finishing = false; this._intent = null; this._router = null; this._result = { code: ThemedActivity.RESULT_CANCELED, data: null };
    this.root = null; this._window = null; this._unlisten = [];
    this._save41 = () => { this._resumeWriter = null; UiResume.save(this); };
    this._preferenceChanged = () => Promise.resolve().then(() => { if (this._observing) { this.refreshTheme(); this._armBoundary(); } });
    this._visible = () => { if (this._observing && document.visibilityState === 'visible') { this.refreshTheme(); this._armBoundary(); } };
  }
  /** Router hook: the screen's intent, root element and router. */
  _attach(router, intent, root) { this._router = router; this._intent = intent; this.root = root; const decor = root; this._window = { getDecorView: () => decor }; }
  getIntent() { return this._intent; }
  setIntent(intent) { this._intent = intent; }
  getWindow() { return this._window; }
  isDestroyed() { return this._destroyed; }
  isFinishing() { return this._finishing || this._destroyed; }
  allowResumeSave() { return true; }
  resumeScope() { return this.constructor.name; }
  onSaveInstanceState(state) {} // eslint-disable-line no-unused-vars
  /** Runnable posted to the UI thread: the page has one thread, so it runs now. */
  runOnUiThread(fn) { fn(); }
  /** True while the screen has work that a page reload would lose (subclasses: a running job). */
  uiBusy() { return false; }
  /** Holds back another device's changes (and the reload that applies them): a pending draft save or busy work. */
  holdsRemote() { return this._resumeWriter != null || this.uiBusy(); }

  _watchFields41(v) {
    for (const field of v.querySelectorAll(FIELD)) {
      if (this._watched41.has(field)) continue; this._watched41.add(field);
      field.addEventListener('input', () => this._scheduleSave41());
    }
  }
  _scheduleSave41() { if (this._resumeWriter != null) clearTimeout(this._resumeWriter); this._resumeWriter = setTimeout(this._save41, 600); }

  palette() { if (this._active == null) this._active = new ThemeSettings(this).current(); return this._active; }
  onCreate(b) { this._restoreViews41 = b != null; AppLog.initialize(this.getApplicationContext()); AppLog.event('activity.create', AppLog.data('screen', this.constructor.name, 'restored', b != null)); this._active = new ThemeSettings(this).current(); }
  setContentView(v) {
    this.root.replaceChildren(v); AppLog.observePreferences(); UiSessionLog.attach(this.getWindow(), this.constructor.name);
    if (this._restored41) this._scheduleSave41(); // web: a new page of the screen is a draft worth keeping (see header)
  }
  watch(dialog) { UiSessionLog.attach(dialog.getWindow(), this.constructor.name + '.dialog'); this._dialogs.push(new WeakRef(dialog)); }
  refreshTheme() {
    const next = new ThemeSettings(this).current(); const changed = this._active == null || this._active.json().toString() !== next.json().toString(); this._active = next;
    this._dialogs = this._dialogs.filter(r => { const d = r.deref(); return d != null && d.isShowing(); });
    if (changed) this.onPaletteChanged();
  }
  onPaletteChanged() {}
  _armBoundary() {
    if (this._themeClock != null) clearTimeout(this._themeClock); this._themeClock = null;
    if (this._observing && new ThemeSettings(this).mode() === ThemeSettings.Mode.AUTO) { const now = ZonedDateTime.now(); this._themeClock = setTimeout(() => { this.refreshTheme(); this._armBoundary(); }, Math.max(100, Duration.between(now, ThemeSettings.nextBoundary(now)).toMillis() + 30)); }
  }
  onStart() {
    AppLog.observePreferences(); AppLog.event('activity.start', AppLog.data('screen', this.constructor.name)); this._observing = true;
    document.addEventListener('visibilitychange', this._visible);
    new ThemeSettings(this).prefs.registerOnSharedPreferenceChangeListener(this._preferenceChanged);
    this._unlisten.push(ThemeReceiver.listen(() => { this.refreshTheme(); }));
    this.refreshTheme(); this._armBoundary(); ThemeReceiver.schedule(this);
  }
  onStop() {
    this._observing = false; if (this._themeClock != null) clearTimeout(this._themeClock); this._themeClock = null;
    new ThemeSettings(this).prefs.unregisterOnSharedPreferenceChangeListener(this._preferenceChanged);
    document.removeEventListener('visibilitychange', this._visible); for (const off of this._unlisten.splice(0)) off();
  }
  onResume() {
    if (!this._restored41) { this._restored41 = true; requestAnimationFrame(() => { if (this._destroyed) return; if (this._restoreViews41) UiResume.restoreViews(this); this._watchFields41(this.root); }); }
    UiResume.route(this);
    this._layout = new MutationObserver(() => this._watchFields41(this.root)); this._layout.observe(this.root, { childList: true, subtree: true });
    AppLog.event('activity.resume', AppLog.data('screen', this.constructor.name));
  }
  onPause() {
    if (this._resumeWriter != null) clearTimeout(this._resumeWriter); this._resumeWriter = null; UiResume.save(this);
    if (this._layout != null) this._layout.disconnect(); this._layout = null;
    AppLog.event('activity.pause', AppLog.data('screen', this.constructor.name));
  }
  onDestroy() {
    AppLog.event('activity.destroy', AppLog.data('screen', this.constructor.name)); if (this._themeClock != null) clearTimeout(this._themeClock); this._themeClock = null;
    this._dialogs = []; if (this._resumeWriter != null) clearTimeout(this._resumeWriter); this._resumeWriter = null; this._destroyed = true;
  }
  startActivity(intent) { this.startActivityForResult(intent, -1); }
  startActivityForResult(intent, request) { AppLog.event('navigation.start', AppLog.data('screen', this.constructor.name, 'request', request, 'intent', intent.toUri(0))); this._router.start(intent, request, this); }
  onActivityResult(request, result, data) { AppLog.event('navigation.result', AppLog.data('screen', this.constructor.name, 'request', request, 'result', result, 'resultData', AppLog.intent(data))); }
  setResult(code, data = null) { this._result = { code, data }; }
  finish() { if (this._finishing) return; this._finishing = true; this._router.finish(this); }
  onBackPressed() { AppLog.event('user.back', AppLog.data('screen', this.constructor.name)); this.finish(); }
}
