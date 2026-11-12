// DOM counterparts of the Android views the screens build in code (no XML layouts in the APK):
// TextView → <p>, Button → <button>, EditText → <input> (+ setError line), Spinner → <select>, CheckBox → <label>
// with a checkbox, ImageView → <img> (a Bitmap is PNG-encoded, a stored file is read from files.js; both shown
// through an object URL released once loaded), LinearLayout → <div> (flex row/column). Sizes are dp/sp = CSS px.
// contentDescription → aria-label. Nothing touches the document at import.
import { File, FileInputStream, ByteArrayOutputStream } from '../platform/files.js';
import { CompressFormat } from '../platform/bitmap.js';
import { ThemeUi } from './ThemeUi.js';

export function el(tag, className = null, text = null) {
  const v = document.createElement(tag); if (className) v.className = className; if (text != null) v.textContent = text; return v;
}
/** TextView with a text size (sp) and a colour role/key. */
export function textView(s, sp, role) { const t = el('p', 'tv', s); t.style.fontSize = sp + 'px'; if (role != null) ThemeUi.text(t, role); return t; }
/** LinearLayout: vertical (default) or horizontal. */
export function linear(horizontal = false, className = '') { return el('div', (horizontal ? 'row' : 'col') + (className ? ' ' + className : '')); }
/** Fixed vertical gap (dp). */
export function gapView(h) { const g = el('div', 'gap'); g.style.height = h + 'px'; return g; }
export function describe(v, description) { if (description != null) v.setAttribute('aria-label', description); return v; }

/** Button: label (may hold "\n"), primary = accent fill; logs and runs action on click (set by the caller). */
export function buttonView(label, primary) { const b = el('button', 'btn' + (primary ? ' btn--primary' : ''), label); b.type = 'button'; return b; }

/** EditText. numeric → digits keyboard. capWords → autocapitalize words. */
export function editText({ hint = null, value = '', numeric = false, capWords = false, capChars = false, maxLength = 0, description = null } = {}) {
  const input = el('input', 'field'); input.type = 'text'; input.value = value ?? ''; if (hint != null) input.placeholder = hint;
  input.autocomplete = 'off'; input.spellcheck = false; input.setAttribute('autocorrect', 'off');
  if (numeric) { input.inputMode = 'numeric'; input.pattern = '[0-9]*'; }
  input.setAttribute('autocapitalize', capChars ? 'characters' : capWords ? 'words' : 'off');
  if (maxLength > 0) input.maxLength = maxLength; describe(input, description);
  input.addEventListener('input', () => clearError(input));
  return input;
}
/** EditText.setError(message): an alert line under the field; cleared on the next edit. */
export function setError(input, message) {
  clearError(input); input.setAttribute('aria-invalid', 'true');
  const line = el('p', 'field-error', message); line.setAttribute('role', 'alert'); ThemeUi.text(line, ThemeUi.WARNING);
  if (input.parentElement?.classList.contains('field-wrap')) input.parentElement.append(line); else input.after(line); input._errorLine = line; try { input.focus(); } catch (e) { /* not focusable */ }
}
export function clearError(input) { if (input._errorLine) { input._errorLine.remove(); input._errorLine = null; input.removeAttribute('aria-invalid'); } }

/** Spinner over the labels; selectedIndex = getSelectedItemPosition(). */
export function spinner(labels, description = null) {
  const s = el('select', 'spinner'); describe(s, description); setItems(s, labels); return s;
}
export function setItems(s, labels) { const at = s.selectedIndex; s.replaceChildren(...labels.map((l, i) => { const o = el('option', null, l); o.value = String(i); return o; })); if (at >= 0 && at < labels.length) s.selectedIndex = at; }

/** CheckBox with its text. Returns { view, input }. */
export function checkBox(label, checked = false) {
  const view = el('label', 'check'); const input = el('input'); input.type = 'checkbox'; input.checked = checked;
  view.append(input, el('span', null, label)); return { view, input };
}

/** ImageView of a Bitmap, a stored file path, or null (nothing shown). height in dp; fit centre. */
export function imageView(source, description = null, height = null, className = 'img') {
  const img = el('img', className); img.alt = description ?? ''; describe(img, description); img.decoding = 'async';
  if (height != null) img.style.height = height + 'px';
  const show = bytes => { const url = URL.createObjectURL(new Blob([bytes])); img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true }); img.addEventListener('error', () => { URL.revokeObjectURL(url); img.hidden = true; }, { once: true }); img.src = url; };
  if (source == null) { img.hidden = true; return img; }
  if (typeof source === 'string' || source instanceof File) {
    const f = source instanceof File ? source : new File(source);
    try { show(new FileInputStream(f).readAllBytes()); } catch (e) { img.hidden = true; }
  } else {
    const out = new ByteArrayOutputStream();
    source.compress(CompressFormat.PNG, 100, out).then(() => show(out.toByteArray()), () => { img.hidden = true; });
  }
  return img;
}
/** Whether a stored image file exists (BitmapFactory.decodeFile(path) != null for the APK's own files). */
export function fileExists(path) { return path != null && path !== '' && new File(path).isFile(); }
