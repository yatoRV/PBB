// Port of vn.lichdilam.UiSessionLog (APK 4.5) for DOM screens: observes a screen without replacing click, input,
// focus or scroll behaviour. The Android Window becomes the screen's window object (getDecorView() = root element).
// Window.Callback dispatch → capturing pointer/key listeners on the root; OnGlobalLayoutListener → MutationObserver;
// OnScrollChangedListener → capturing "scroll"; OnGlobalFocusChangeListener → "focusin"; TextWatcher → "input"
// (fields) and text mutations (other text). Views map to elements: TextView = an input/textarea/select/button or an
// element with its own text, contentDescription = aria-label, ProgressBar = <progress>, CompoundButton = checkbox/radio.
import { JSONArray } from '../platform/json.js';
import { AppLog } from '../core/AppLog.js';

const attached = new WeakMap();
const FIELD = /^(?:INPUT|TEXTAREA|SELECT)$/;
const isEditText = v => v.tagName === 'TEXTAREA' || (v.tagName === 'INPUT' && !/^(?:checkbox|radio|button|submit|reset|file|image|range|color|hidden)$/i.test(v.type));
const isCompound = v => v.tagName === 'INPUT' && /^(?:checkbox|radio)$/i.test(v.type);
const description = v => v.getAttribute('aria-label') ?? v.getAttribute('title'); // title: contentDescription kept off the name (PhotoViewer 'Vừa ảnh')
function ownText(v) { let s = ''; for (const n of v.childNodes) if (n.nodeType === 3) s += n.nodeValue; return s.trim(); }
function textOf(v) {
  if (FIELD.test(v.tagName)) return v.tagName === 'SELECT' ? (v.selectedOptions?.[0]?.text ?? '') : isCompound(v) ? (v.labels?.[0]?.textContent ?? '').trim() : v.value;
  return v.children.length === 0 ? (v.textContent ?? '').trim() : ownText(v);
}
const isTextView = v => FIELD.test(v.tagName) || v.tagName === 'BUTTON' || ownText(v) !== '';
const MOTION = { pointerdown: 'ACTION_DOWN', pointermove: 'ACTION_MOVE', pointerup: 'ACTION_UP', pointercancel: 'ACTION_CANCEL' };

/** Observe windows without replacing click, input, focus or scroll behavior. */
export class UiSessionLog {
  constructor(window, screen) { this._screen = screen; this._root = window.getDecorView(); this._watched = new WeakMap(); this._previous = ''; this._timer = null; this._snapshot = () => this._snap(); }
  static attach(window, screen) {
    if (window == null || attached.has(window) || screen.startsWith('LogActivity')) return;
    const observer = new UiSessionLog(window, screen); attached.set(window, new WeakRef(observer));
    const root = observer._root;
    for (const type of Object.keys(MOTION)) root.addEventListener(type, ev => { if (type !== 'pointermove' || ev.buttons !== 0) observer._touch(ev); observer._queue(); }, true);
    for (const type of ['keydown', 'keyup']) root.addEventListener(type, ev => {
      AppLog.event('user.key', AppLog.data('screen', screen, 'action', type === 'keydown' ? 0 : 1, 'keyCode', ev.keyCode, 'unicode', ev.key && [...ev.key].length === 1 ? ev.key.codePointAt(0) : 0, 'repeat', ev.repeat ? 1 : 0)); observer._queue();
    }, true);
    new root.ownerDocument.defaultView.MutationObserver(records => { observer._texts(records); observer._queue(); }).observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    root.addEventListener('scroll', () => { AppLog.event('user.scroll', AppLog.data('screen', screen, 'views', observer._scrollPositions(root, 'root'))); observer._queue(); }, true);
    root.addEventListener('focusin', ev => { AppLog.event('ui.focus', AppLog.data('screen', screen, 'field', ev.target == null ? null : observer._label(ev.target))); observer._queue(); });
    observer._queue();
  }
  _queue() { clearTimeout(this._timer); this._timer = setTimeout(this._snapshot, 60); }
  _snap() {
    if (!this._root.isConnected) return;
    const nodes = new JSONArray(); this._visit(this._root, 'root', nodes); const current = nodes.toString();
    if (this._previous !== current) { this._previous = current; AppLog.event('display.screen', AppLog.data('screen', this._screen, 'views', nodes)); }
  }
  _visible(view) { if (view.hidden) return false; const s = view.ownerDocument.defaultView.getComputedStyle(view); return s.display !== 'none' && s.visibility === 'visible'; }
  _visit(view, path, nodes) {
    if (!this._visible(view)) return;
    if (isTextView(view) || description(view) != null || view.tagName === 'PROGRESS') {
      const doc = view.ownerDocument; const node = AppLog.data('path', path, 'class', view.tagName.toLowerCase(), 'description', description(view), 'enabled', !view.disabled, 'focused', view.contains(doc.activeElement));
      if (isTextView(view)) {
        node.put('text', textOf(view)); if (view.getAttribute('placeholder') != null) node.put('hint', view.getAttribute('placeholder'));
        if (!this._watched.has(view)) {
          const field = this._label(view); this._watched.set(view, { field, before: textOf(view) });
          if (isEditText(view)) view.addEventListener('input', () => { const w = this._watched.get(view); const value = view.value; AppLog.event('input.change', AppLog.data('screen', this._screen, 'field', w.field, 'before', w.before, 'value', value, 'focused', view.contains(doc.activeElement))); w.before = value; this._queue(); });
        }
      }
      if (isCompound(view)) node.put('checked', view.checked);
      if (view.tagName === 'PROGRESS') node.put('progress', Math.round(view.value));
      nodes.put(node);
    }
    for (let i = 0; i < view.children.length; i++) this._visit(view.children[i], path + '/' + i, nodes);
  }
  /** TextWatcher of non-field text: a watched element whose text changed reports it (display.text). */
  _texts(records) {
    const seen = new Set();
    for (const r of records) {
      if (r.type === 'attributes') continue;
      for (let v = r.target.nodeType === 1 ? r.target : r.target.parentElement; v != null && v !== this._root.parentElement; v = v.parentElement) {
        const w = this._watched.get(v); if (w == null || isEditText(v) || seen.has(v)) continue; seen.add(v);
        const value = textOf(v); if (value === w.before) continue;
        AppLog.event('display.text', AppLog.data('screen', this._screen, 'field', w.field, 'before', w.before, 'value', value, 'focused', v.contains(v.ownerDocument.activeElement))); w.before = value;
      }
    }
  }
  _label(view) {
    if (description(view) != null) return description(view);
    if (isEditText(view)) {
      const hint = view.getAttribute('placeholder'); if (hint != null && hint !== '') return hint;
      const parent = view.parentElement; if (parent != null) { const before = view.previousElementSibling; if (before != null && isTextView(before)) return textOf(before); }
    }
    if (isTextView(view)) return textOf(view); return view.tagName.toLowerCase();
  }
  _touch(event) {
    const rect = this._root.getBoundingClientRect(); const target = event.target instanceof this._root.ownerDocument.defaultView.Element && this._root.contains(event.target) ? event.target : null; const points = new JSONArray();
    points.put(AppLog.data('id', event.pointerId, 'x', event.clientX - rect.left, 'y', event.clientY - rect.top));
    AppLog.event('user.touch', AppLog.data('screen', this._screen, 'action', MOTION[event.type], 'target', target == null ? null : this._label(target), 'rawX', event.clientX, 'rawY', event.clientY, 'points', points));
  }
  _scrollPositions(view, path) {
    const result = new JSONArray();
    if (view.scrollLeft !== 0 || view.scrollTop !== 0) result.put(AppLog.data('path', path, 'x', Math.round(view.scrollLeft), 'y', Math.round(view.scrollTop)));
    for (let i = 0; i < view.children.length; i++) { const children = this._scrollPositions(view.children[i], path + '/' + i); for (let j = 0; j < children.length(); j++) result.put(children.opt(j)); }
    return result;
  }
}
