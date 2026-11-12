// Port of vn.lichdilam.UiResume (APK 4.5) for DOM screens.
// A screen (the web ThemedActivity) is an object whose class name is the Activity's name ("PipeTableActivity"),
// that is a Context (getSharedPreferences) and has getIntent(), isDestroyed(), allowResumeSave(), resumeScope(),
// onSaveInstanceState(bundle), getWindow().getDecorView() (its root element), startActivity(intent) and
// startActivityForResult(intent, code). Views map to DOM elements: EditText → <input>/<textarea> (hint =
// placeholder), ScrollView/HorizontalScrollView → an element whose overflow scrolls; child i of a view is
// element.children[i]. Bundle/Parcel come from js/platform/android.js (the flattened bytes are UTF-8 JSON).
import { AndroidBase64, System } from '../platform/java.js';
import { JSONObject, JSONException } from '../platform/json.js';
import { BuildConfig, Intent, Bundle, Parcel } from '../platform/android.js';
import { AppLog } from '../core/AppLog.js';

const PREFS = 'ui-resume41';
const SCREENS = new Set(['MainActivity', 'ReminderActivity', 'ReminderDiagnosticsActivity', 'PipeTableActivity', 'PipeImportActivity', 'AppearanceActivity', 'LogActivity']);
const prefs = c => c.getSharedPreferences(PREFS, 0);
const simpleName = a => a.constructor.name;

/** EditText: a text field. */
const isEditText = v => v.tagName === 'TEXTAREA' || (v.tagName === 'INPUT' && !/^(?:checkbox|radio|button|submit|reset|file|image|range|color|hidden)$/i.test(v.type));
/** ScrollView / HorizontalScrollView: an element that scrolls its content. */
function isScrollView(v) { const s = v.ownerDocument?.defaultView?.getComputedStyle(v); return !!s && (/^(?:auto|scroll)$/.test(s.overflowY) || /^(?:auto|scroll)$/.test(s.overflowX)); }
/** View.getClass().getName(): the element kind. */
const typeName = v => v.tagName.toLowerCase() + (v.tagName === 'INPUT' ? ':' + v.type : '');
const hintOf = v => String(v.getAttribute('placeholder'));

function put(o, key, value) { o.put(key, value); }
function capture(v, path, out) {
  if (isEditText(v)) put(out, path, AppLog.data('type', typeName(v), 'hint', hintOf(v), 'text', v.value, 'selection', selectionStart(v)));
  else if (isScrollView(v)) put(out, path, AppLog.data('type', typeName(v), 'x', Math.round(v.scrollLeft), 'y', Math.round(v.scrollTop)));
  for (let i = 0; i < v.children.length; i++) capture(v.children[i], path + '.' + i, out);
}
function selectionStart(v) { try { return v.selectionStart ?? -1; } catch (e) { return -1; } }
function restore(v, path, all) {
  const o = all.optJSONObject(path);
  if (o != null && typeName(v) === o.optString('type')) {
    if (isEditText(v) && hintOf(v) === o.optString('hint')) {
      v.value = o.optString('text'); const at = Math.max(0, Math.min(v.value.length, o.optInt('selection', v.value.length)));
      try { v.setSelectionRange(at, at); } catch (e) { /* this input type has no selection */ }
    } else if (isScrollView(v)) {
      // Before the next frame is drawn (OnPreDrawListener), once.
      const view = v.ownerDocument?.defaultView; const x = o.optInt('x'), y = o.optInt('y');
      if (view?.requestAnimationFrame) view.requestAnimationFrame(() => v.scrollTo(x, y)); else v.scrollTo(x, y);
    }
  }
  for (let i = 0; i < v.children.length; i++) restore(v.children[i], path + '.' + i, all);
}

/** Durable UI drafts, separate from the actual roster/settings. Restoring never confirms a person. */
export class UiResume {
  static PREFS = PREFS;
  static restoreBundle(a) {
    if (!SCREENS.has(simpleName(a))) return null;
    if (simpleName(a) === 'MainActivity' && Intent.ACTION_MAIN !== a.getIntent().getAction()) return null;
    const p = prefs(a); const key = simpleName(a);
    if (p.getInt(key + ':version', 0) !== BuildConfig.VERSION_CODE) return null;
    const encoded = p.getString(key + ':bundle', ''); if (encoded === '') return null;
    const parcel = Parcel.obtain();
    try {
      const bytes = AndroidBase64.decode(encoded, AndroidBase64.NO_WRAP); if (bytes.length > 1024 * 1024) return null; parcel.unmarshall(bytes, 0, bytes.length); parcel.setDataPosition(0); const b = parcel.readBundle();
      if (key === 'PipeTableActivity' && a.getIntent().hasExtra('month') && a.getIntent().getStringExtra('month') !== b.getString('month')) return null;
      AppLog.event('ui.resume.bundle', AppLog.data('screen', key, 'savedAt', p.getLong(key + ':at', 0), 'processMayBeNew', true)); return b;
    } catch (e) { AppLog.failure('ui.resume.read', e); return null; } finally { parcel.recycle(); }
  }
  static save(a) {
    if (!SCREENS.has(simpleName(a)) || a.isDestroyed() || !a.allowResumeSave()) return;
    const b = new Bundle(); a.onSaveInstanceState(b); for (const key of [...b.keySet()]) if (key.startsWith('android:')) b.remove(key);
    const parcel = Parcel.obtain();
    try {
      parcel.writeBundle(b); const bytes = parcel.marshall(); if (bytes.length > 1024 * 1024) { AppLog.event('ui.resume.tooLarge', AppLog.data('bytes', bytes.length)); return; }
      const key = simpleName(a); const views = new JSONObject(); capture(a.getWindow().getDecorView(), 'r', views);
      const saved = prefs(a).edit().putString(key + ':bundle', AndroidBase64.encodeToString(bytes, AndroidBase64.NO_WRAP)).putString(key + ':views', views.toString()).putString(key + ':scope', a.resumeScope()).putInt(key + ':version', BuildConfig.VERSION_CODE).putLong(key + ':at', System.currentTimeMillis()).commit();
      AppLog.event('ui.resume.saved', AppLog.data('screen', key, 'scope', a.resumeScope(), 'saved', saved, 'fieldCount', views.length()));
    } catch (e) { AppLog.failure('ui.resume.save', e); } finally { parcel.recycle(); }
  }
  static restoreViews(a) {
    const p = prefs(a); const key = simpleName(a); if (p.getInt(key + ':version', 0) !== BuildConfig.VERSION_CODE || p.getString(key + ':scope', '') !== a.resumeScope()) return;
    // Setting a field's value in the DOM never moves the focus, so nothing has to be blocked meanwhile.
    try { restore(a.getWindow().getDecorView(), 'r', new JSONObject(p.getString(key + ':views', '{}'))); AppLog.event('ui.resume.views', AppLog.data('screen', key, 'scope', a.resumeScope())); } catch (e) { if (!(e instanceof JSONException)) throw e; AppLog.failure('ui.resume.views', e); }
  }
  static route(a) { const key = simpleName(a); if (SCREENS.has(key)) prefs(a).edit().putString('route', key).putString('month', a.getIntent().getStringExtra('month')).apply(); }
  static openLast(a) {
    if (Intent.ACTION_MAIN !== a.getIntent().getAction() || a.getIntent().hasExtra('month')) return false;
    const name = prefs(a).getString('route', ''); let type = null;
    if (name === 'ReminderActivity') type = 'ReminderActivity'; else if (name === 'ReminderDiagnosticsActivity') type = 'ReminderDiagnosticsActivity'; else if (name === 'PipeTableActivity') type = 'PipeTableActivity'; else if (name === 'PipeImportActivity') type = 'PipeImportActivity'; else if (name === 'AppearanceActivity') type = 'AppearanceActivity'; else if (name === 'LogActivity') type = 'LogActivity';
    if (type == null) return false; const open = new Intent(a, type).putExtra('resume41', true); const month = prefs(a).getString('month', null); if (month != null) open.putExtra('month', month); if (type === 'PipeImportActivity') a.startActivityForResult(open, 200); else a.startActivity(open); return true;
  }
}
