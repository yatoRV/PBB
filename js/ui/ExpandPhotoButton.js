// Port of vn.lichdilam.ExpandPhotoButton (APK 4.5).
// Bold diagonal expand arrows, with a solid contrasting touch target.
// Web: a <button> holding a <canvas> drawn like onDraw (48-unit design scaled to the button, crisp at the device
// pixel ratio). Used by PipeImportActivity (Task 12). Its colours are fixed in the APK (not palette colours).
import { cssColor } from '../shell/theme.js';

export class ExpandPhotoButton {
  constructor(c, size = 44) { // eslint-disable-line no-unused-vars
    const b = this.view = document.createElement('button'); b.type = 'button'; b.className = 'expand-photo';
    b.setAttribute('aria-label', 'Mở ảnh toàn màn hình');
    const canvas = this._canvas = document.createElement('canvas'); b.append(canvas); this._size = size; this.draw();
  }
  setContentDescription(text) { this.view.setAttribute('aria-label', text); }
  setOnClickListener(fn) { this.view.addEventListener('click', () => fn(this.view)); }
  draw() {
    const dpr = globalThis.devicePixelRatio || 1, s = this._size, canvas = this._canvas;
    canvas.width = Math.round(s * dpr); canvas.height = Math.round(s * dpr); canvas.style.width = s + 'px'; canvas.style.height = s + 'px';
    const c = canvas.getContext('2d'); const u = Math.min(s, s) / 48 * dpr; c.save(); c.scale(u, u);
    c.fillStyle = cssColor(0xF02F50B4 | 0); c.beginPath(); const r = 12; c.moveTo(1 + r, 1); c.arcTo(47, 1, 47, 47, r); c.arcTo(47, 47, 1, 47, r); c.arcTo(1, 47, 1, 1, r); c.arcTo(1, 1, 47, 1, r); c.closePath(); c.fill();
    c.strokeStyle = '#ffffff'; c.lineWidth = 4; c.lineCap = 'round'; c.lineJoin = 'round';
    for (const [x1, y1, x2, y2] of [[27, 21, 36, 12], [26, 12, 36, 12], [36, 12, 36, 22], [21, 27, 12, 36], [12, 26, 12, 36], [12, 36, 22, 36]]) { c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); }
    c.restore();
  }
}
