// Port of vn.lichdilam.PhotoViewerActivity (APK 4.5): read-only viewer of app-private original copies,
// independent from OCR geometry. docs/UI-MAP-PipeImport-PipeTable-PhotoViewer.md (PV1–PV7).
// Web adaptations: the stored file is shown by an <img> from a Blob URL (revoked on close) — the browser decodes it
// (EXIF orientation included), no full-size canvas is made (iPhone memory); ZoomPhotoView's ScaleGestureDetector /
// GestureDetector are Pointer Events (pinch, one-finger drag, double tap) and its onDraw is a CSS transform.
import { File, FileInputStream } from '../platform/files.js';
import { IllegalArgumentException } from '../platform/java.js';
import { ThemedActivity } from './ThemedActivity.js';
import { el, describe } from './Views.js';

/** The image as ZoomPhotoView draws it: scale 1–12 around a focus, offset clamped to the image. */
export class ZoomPhotoView {
  constructor() {
    this.view = el('div', 'pv-photo'); describe(this.view, 'Ảnh gốc: chụm hai ngón để thu phóng, kéo để xem, chạm hai lần để phóng to'); this.view.setAttribute('role', 'img');
    this.img = null; this.iw = 0; this.ih = 0; this.scale = 1; this.x = 0; this.y = 0; this.lastX = 0; this.lastY = 0;
    this._pointers = new Map(); this._pinch = 0; this._tap = null; this._moved = false;
    this.view.addEventListener('pointerdown', e => this._down(e)); this.view.addEventListener('pointermove', e => this._move(e));
    for (const type of ['pointerup', 'pointercancel']) this.view.addEventListener(type, e => this._up(e));
    this.view.addEventListener('dblclick', e => { if (this._lastType === 'mouse') { const [x, y] = this._local(e); this._doubleTap(x, y); } }); // touch double taps: _up
    this.view.addEventListener('wheel', e => { e.preventDefault(); const r = this.view.getBoundingClientRect(); this.zoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
    if (typeof ResizeObserver === 'function') { this._resize = new ResizeObserver(() => { this.clamp(); this.invalidate(); }); this._resize.observe(this.view); }
  }
  getWidth() { return this.view.clientWidth; }
  getHeight() { return this.view.clientHeight; }
  image(img) { this.img = img; this.iw = img.naturalWidth; this.ih = img.naturalHeight; img.classList.add('pv-image'); img.draggable = false; this.view.append(img); this.fit(); }
  zoomLevel() { return this.scale; }
  offsetX() { return this.x; }
  fit() { this.scale = 1; this.x = this.y = 0; this.invalidate(); }
  base() { return this.img == null ? 1 : Math.min(this.getWidth() / this.iw, this.getHeight() / this.ih); }
  zoomBy(factor) { this.zoom(factor, this.getWidth() / 2, this.getHeight() / 2); }
  zoom(factor, focusX, focusY) {
    const w = this.getWidth(), h = this.getHeight(); const next = Math.max(1, Math.min(12, this.scale * factor)), ratio = next / this.scale;
    this.x = (this.x + w / 2 - focusX) * ratio + focusX - w / 2; this.y = (this.y + h / 2 - focusY) * ratio + focusY - h / 2; this.scale = next; this.clamp(); this.invalidate();
  }
  clamp() {
    if (this.img == null) return; const mx = Math.max(0, (this.iw * this.base() * this.scale - this.getWidth()) / 2), my = Math.max(0, (this.ih * this.base() * this.scale - this.getHeight()) / 2);
    this.x = Math.max(-mx, Math.min(mx, this.x)); this.y = Math.max(-my, Math.min(my, this.y));
  }
  /** onDraw: the image rect centred at (w/2 + x, h/2 + y), base × scale of the image size. */
  invalidate() {
    if (this.img == null) return; const b = this.base(), w = this.iw * b, h = this.ih * b;
    const s = this.img.style; s.width = w + 'px'; s.height = h + 'px'; s.left = (this.getWidth() - w) / 2 + 'px'; s.top = (this.getHeight() - h) / 2 + 'px';
    s.transform = 'translate(' + this.x + 'px,' + this.y + 'px) scale(' + this.scale + ')';
  }
  _local(e) { const r = this.view.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  _down(e) {
    this._lastType = e.pointerType;
    try { this.view.setPointerCapture(e.pointerId); } catch (ignored) { /* already released */ }
    const [px, py] = this._local(e); this._pointers.set(e.pointerId, [px, py]);
    if (this._pointers.size === 1) { this.lastX = px; this.lastY = py; this._moved = false; }
    if (this._pointers.size === 2) { const [a, b] = [...this._pointers.values()]; this._pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); this._moved = true; }
  }
  _move(e) {
    if (!this._pointers.has(e.pointerId)) return; const [px, py] = this._local(e); this._pointers.set(e.pointerId, [px, py]);
    if (this._pointers.size >= 2) {
      const [a, b] = [...this._pointers.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (this._pinch > 0 && d > 0) this.zoom(d / this._pinch, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2); this._pinch = d; return;
    }
    if (Math.hypot(px - this.lastX, py - this.lastY) > 0) { if (Math.abs(px - this.lastX) + Math.abs(py - this.lastY) > 2) this._moved = true; this.x += px - this.lastX; this.y += py - this.lastY; this.clamp(); this.invalidate(); }
    this.lastX = px; this.lastY = py;
  }
  _up(e) {
    if (!this._pointers.has(e.pointerId)) return; const [px, py] = this._pointers.get(e.pointerId); this._pointers.delete(e.pointerId);
    if (this._pointers.size === 1) { const [rest] = [...this._pointers.values()]; this.lastX = rest[0]; this.lastY = rest[1]; this._pinch = 0; return; }
    if (this._pointers.size === 0 && e.type === 'pointerup' && e.pointerType === 'touch' && !this._moved) {
      const now = performance.now(); const t = this._tap;
      if (t != null && now - t.at < 300 && Math.hypot(px - t.x, py - t.y) < 30) { this._tap = null; this._doubleTap(px, py); } else this._tap = { at: now, x: px, y: py };
    }
  }
  _doubleTap(x, y) { if (this.scale > 1.1) this.fit(); else this.zoom(3, x, y); }
  release() { if (this._resize != null) this._resize.disconnect(); }
}

export class PhotoViewerActivity extends ThemedActivity {
  constructor() { super(); this.photo = null; this._url = null; }
  control(label, description, action) {
    const b = el('button', 'pv-control' + (label === '×' ? ' pv-control--close' : ''), label); b.type = 'button';
    // A worded label stays the accessible name (WCAG 2.5.3); the APK's description becomes the description. Symbols use it as the name.
    if (label.length > 1) b.title = description; else describe(b, description);
    b.addEventListener('click', () => action()); return b;
  }
  onCreate(state) {
    super.onCreate(state);
    const root = el('div', 'pv'); this.photo = new ZoomPhotoView(); root.append(this.photo.view);
    const status = el('p', 'pv-status', 'Đang mở ảnh gốc…'); status.setAttribute('role', 'status'); root.append(status);
    root.append(this.control('×', 'Đóng ảnh toàn màn hình', () => this.finish()));
    const controls = el('div', 'pv-controls');
    controls.append(this.control('−', 'Thu nhỏ ảnh', () => this.photo.zoomBy(0.67)), this.control('Vừa ảnh', 'Đưa ảnh về kích thước vừa màn hình', () => this.photo.fit()), this.control('+', 'Phóng to ảnh', () => this.photo.zoomBy(1.5)));
    root.append(controls); this.setContentView(root);
    try {
      const file = new File(this.getIntent().getStringExtra('path')).getCanonicalFile(); const allowed = new File(this.getFilesDir(), 'pipe-source-cache-v4').getCanonicalFile();
      if (!allowed.equals(file.getParentFile()) || !file.isFile()) throw new IllegalArgumentException('Ảnh gốc không còn. Hãy thêm lại ảnh.');
      const url = this._url = URL.createObjectURL(new Blob([new FileInputStream(file).readAllBytes()]));
      const img = new Image(); img.alt = ''; img.decoding = 'async';
      img.addEventListener('load', () => { if (this.isFinishing() || this.isDestroyed()) return; this.photo.image(img); status.hidden = true; }, { once: true });
      img.addEventListener('error', () => { if (!this.isDestroyed()) status.textContent = 'Không mở được ảnh. Đóng và chọn lại ảnh gốc.'; }, { once: true });
      img.src = url;
    } catch (e) { status.textContent = 'Không mở được ảnh. Đóng và chọn lại ảnh gốc.'; }
  }
  onDestroy() { super.onDestroy(); if (this.photo != null) this.photo.release(); if (this._url != null) { URL.revokeObjectURL(this._url); this._url = null; } }
}
