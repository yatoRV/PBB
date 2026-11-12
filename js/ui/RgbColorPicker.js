// Port of vn.lichdilam.RgbColorPicker (APK 4.5): RGB/HEX and HSV are different controls for the same draft ARGB
// value. docs/UI-MAP-Settings.md (C1–C8). Web: SeekBar → <input type=range>, the swatch and the saturation/brightness
// plane are small canvases (the plane follows Pointer Events), the TextWatchers are "input" listeners.
import { format } from '../platform/java.js';
import { Color } from '../platform/bitmap.js';
import { AlertDialog } from '../platform/widget.js';
import { cssColor } from '../shell/theme.js';
import { ThemePalette } from '../core/ThemePalette.js';
import { ThemeUi } from './ThemeUi.js';
import { el, textView, buttonView, editText, setError, clearError, describe } from './Views.js';

const dpr = () => globalThis.devicePixelRatio || 1;
function sized(canvas) {
  const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 280, h = canvas.clientHeight || parseFloat(canvas.style.height) || 40, k = dpr();
  if (canvas.width !== Math.round(w * k) || canvas.height !== Math.round(h * k)) { canvas.width = Math.round(w * k); canvas.height = Math.round(h * k); }
  const c = canvas.getContext('2d'); c.setTransform(k, 0, 0, k, 0, 0); return [c, w, h];
}

export class RgbColorPicker {
  constructor(a, old, favorites, changed) {
    this.activity = a; this.original = this.value = old | 0; this.favoriteList = favorites; this.changed = changed; this.syncing = false; this.confirmed = false;
    this.hex = null; this.channels = new Array(4); this.hue = null; this.plane = null; this.swatches = null; this.favoriteRow = null; this._observer = null;
  }
  static show(a, title, value, favorites, changed) { new RgbColorPicker(a, value, favorites, changed).open(title); }
  label(s) { const t = textView(s, 13, ThemeUi.MUTED); t.classList.add('rcp-label'); return t; }
  open(title) {
    const content = el('div', 'col rcp');
    this.swatches = el('canvas', 'rcp-swatches'); this.swatches.style.height = '42px'; describe(this.swatches, 'Màu trước và sau'); this.swatches.setAttribute('role', 'img'); content.append(this.swatches);
    content.append(this.label('Sắc độ · Độ bão hòa / Độ sáng')); this.plane = el('canvas', 'rcp-plane'); this.plane.style.height = '140px'; describe(this.plane, 'Chọn độ bão hòa và độ sáng'); this.plane.setAttribute('role', 'slider'); content.append(this.plane);
    const touch = e => {
      const r = this.plane.getBoundingClientRect(); const hsv = [0, 0, 0]; Color.colorToHSV(this.value, hsv);
      hsv[1] = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); hsv[2] = 1 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)); this.set(Color.HSVToColor(this.value >>> 24, hsv));
    };
    this.plane.addEventListener('pointerdown', e => { try { this.plane.setPointerCapture(e.pointerId); } catch (ignored) { /* released */ } touch(e); });
    this.plane.addEventListener('pointermove', e => { if (this.plane.hasPointerCapture?.(e.pointerId)) touch(e); });
    this.hue = el('input', 'rcp-hue'); this.hue.type = 'range'; this.hue.min = '0'; this.hue.max = '359'; describe(this.hue, 'Sắc độ Hue'); content.append(this.hue);
    this.hue.addEventListener('input', () => { if (this.syncing) return; const hsv = [0, 0, 0]; Color.colorToHSV(this.value, hsv); hsv[0] = Number(this.hue.value); if (hsv[1] === 0) hsv[1] = 1; this.set(Color.HSVToColor(this.value >>> 24, hsv)); });
    const row = el('div', 'row rcp-channels'); const names = ['R', 'G', 'B', 'Alpha'];
    for (let i = 0; i < 4; i++) {
      const column = el('div', 'col grow'); column.append(this.label(names[i])); const e = editText({ numeric: true, maxLength: 3, description: names[i] + ' từ 0 đến 255' }); e.classList.add('field--inner', 'rcp-field'); this.channels[i] = e;
      column.append(e); row.append(column); e.addEventListener('input', () => { if (!this.syncing) this.fromChannels(); });
    }
    content.append(row);
    content.append(this.label('HEX · #RRGGBB')); this.hex = editText({ maxLength: 7, description: 'HEX #RRGGBB' }); this.hex.classList.add('field--inner', 'rcp-hex'); content.append(this.hex); this.hex.addEventListener('input', () => { if (!this.syncing) this.fromHex(); });
    content.append(this.label('Màu gợi ý')); const quick = el('div', 'row rcp-quick'); for (const color of [Color.WHITE, Color.BLACK, 0xFF3155B8 | 0, 0xFF8652D4 | 0, 0xFF187A54 | 0, 0xFFE35D50 | 0]) this.addSwatch(quick, color); content.append(quick);
    const favorite = buttonView('+ Lưu màu yêu thích', false); favorite.classList.add('rcp-favorite'); favorite.addEventListener('click', () => { if (!this.valid()) return; if (!this.favoriteList.includes(this.value)) { if (this.favoriteList.length >= 48) this.favoriteList.splice(0, 1); this.favoriteList.push(this.value); } this.favorites(); }); content.append(favorite);
    const favoritesScroll = el('div', 'rcp-favorites'); this.favoriteRow = el('div', 'row'); favoritesScroll.append(this.favoriteRow); content.append(favoritesScroll); this.favorites();
    const dialog = new ThemeUi.DialogBuilder(this.activity).setTitle(title).setView(content).setNegativeButton('Hủy', null).setPositiveButton('Xác nhận', null).create();
    dialog.setOnDismissListener(() => { if (this._observer != null) this._observer.disconnect(); this.swatches.width = this.plane.width = 0; if (!this.confirmed) this.changed(this.original); });
    dialog.show(); dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(() => { if (!this.valid()) return; this.confirmed = true; this.changed(this.value); dialog.dismiss(); });
    if (typeof ResizeObserver === 'function') { this._observer = new ResizeObserver(() => this.draw()); this._observer.observe(this.plane); }
    this.sync();
  }
  addSwatch(row, color) {
    const swatch = el('button', 'rcp-swatch'); swatch.type = 'button'; swatch.style.background = cssColor(color); describe(swatch, format('Màu #%08X', color >>> 0));
    swatch.addEventListener('click', () => this.set(color)); row.append(swatch);
  }
  favorites() { this.favoriteRow.replaceChildren(); for (const color of this.favoriteList) this.addSwatch(this.favoriteRow, color); }
  fromChannels() {
    const c = new Array(4);
    for (let i = 0; i < 4; i++) { const raw = this.channels[i].value; if (raw === '') return; if (!/^[0-9]+$/.test(raw)) return; c[i] = parseInt(raw, 10); if (c[i] > 255) { setError(this.channels[i], '0–255'); return; } clearError(this.channels[i]); }
    this.set(Color.argb(c[3], c[0], c[1], c[2]));
  }
  fromHex() { const raw = this.hex.value; if (/^#[0-9a-fA-F]{6}$/.test(raw)) { clearError(this.hex); this.set((this.value & 0xFF000000) | (ThemePalette.parseColor(raw) & 0xFFFFFF)); } else if (raw.length === 7) setError(this.hex, 'Nhập #RRGGBB'); }
  valid() {
    let valid = true; for (const e of this.channels) { const n = /^[0-9]+$/.test(e.value) ? parseInt(e.value, 10) : -1; if (n < 0 || n > 255) { setError(e, 'Nhập 0–255'); valid = false; } }
    if (!/^#[0-9a-fA-F]{6}$/.test(this.hex.value)) { setError(this.hex, 'Nhập #RRGGBB'); valid = false; } return valid;
  }
  set(color) { this.value = color | 0; this.sync(); this.changed(this.value); }
  sync() {
    this.syncing = true; const v = this.value; const values = [String((v >> 16) & 255), String((v >> 8) & 255), String(v & 255), String(v >>> 24)];
    for (let i = 0; i < 4; i++) if (this.channels[i].value !== values[i]) { this.channels[i].value = values[i]; clearError(this.channels[i]); }
    this.hex.value = format('#%06X', v & 0xFFFFFF); clearError(this.hex); const hsv = [0, 0, 0]; Color.colorToHSV(v, hsv); this.hue.value = String(Math.round(hsv[0])); this.draw(); this.syncing = false;
  }
  draw() {
    { const [c, w, h] = sized(this.swatches); for (let i = 0; i < 2; i++) { const color = i === 0 ? this.original : this.value; c.clearRect(i * w / 2, 0, w / 2, h); c.fillStyle = cssColor(color); c.fillRect(i * w / 2, 0, w / 2, h);
      c.fillStyle = ThemePalette.contrast(color, Color.WHITE) > 4.5 ? '#fff' : '#000'; c.font = '12px ' + getComputedStyle(this.swatches).fontFamily; c.textAlign = 'center'; c.fillText(i === 0 ? 'Trước' : 'Sau', (i + 0.5) * w / 2, h / 2 + 4); } }
    { const [c, w, h] = sized(this.plane); const hsv = [0, 0, 0]; Color.colorToHSV(this.value, hsv);
      let g = c.createLinearGradient(0, 0, w, 0); g.addColorStop(0, '#fff'); g.addColorStop(1, cssColor(Color.HSVToColor(255, [hsv[0], 1, 1]))); c.fillStyle = g; c.fillRect(0, 0, w, h);
      g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, '#000'); c.fillStyle = g; c.fillRect(0, 0, w, h);
      c.lineWidth = 2; c.strokeStyle = '#fff'; c.beginPath(); c.arc(hsv[1] * w, (1 - hsv[2]) * h, 6, 0, Math.PI * 2); c.stroke(); c.lineWidth = 1; c.strokeStyle = '#000'; c.beginPath(); c.arc(hsv[1] * w, (1 - hsv[2]) * h, 8, 0, Math.PI * 2); c.stroke();
      this.plane.setAttribute('aria-valuetext', Math.round(hsv[1] * 100) + '% · ' + Math.round(hsv[2] * 100) + '%'); }
  }
}
