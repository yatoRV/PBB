// Port of vn.lichdilam.CalendarPainter (APK 4.5).
// One renderer for the real calendar, live preview and launcher widget.
// Web: draw() paints on an android.graphics.Canvas-like object. Canvas2D adapts a CanvasRenderingContext2D (the
// screen's <canvas>, scaled by devicePixelRatio so it stays crisp) and TextPaint is the Paint used here (ARGB int
// colour with alpha, text size/align, fill/stroke). Text metrics follow Roboto (Android's sans-serif): ascent
// -0.9277 × size, descent 0.2441 × size. The widget entry points (bitmap) are not ported: the web has no launcher
// widget (spec ruling). No DOM access at module level, so tests run under Node with a fake context.
import { LocalDate, YearMonth, ChronoUnit } from '../platform/time.js';
import { matches } from '../platform/java.js';
import { Schedule } from '../core/Schedule.js';
import { CalendarCell } from '../core/CalendarCell.js';
import { ThemeUi } from './ThemeUi.js';

const f = Math.fround;
const ASCENT = -1900 / 2048, DESCENT = 500 / 2048;
const css = argb => 'rgba(' + ((argb >>> 16) & 255) + ',' + ((argb >>> 8) & 255) + ',' + (argb & 255) + ',' + (((argb >>> 24) & 255) / 255) + ')';

/** android.text.TextPaint subset (ANTI_ALIAS). measure(font, text) gives the advance width in px. */
export class TextPaint {
  static FILL = 'FILL'; static STROKE = 'STROKE';
  constructor(measure) { this._measure = measure; this._color = 0xFF000000 | 0; this._size = 12; this._family = 'sans-serif'; this._align = 'left'; this._style = TextPaint.FILL; this._stroke = 0; }
  setColor(argb) { this._color = argb | 0; }
  getColor() { return this._color; }
  getAlpha() { return (this._color >>> 24) & 255; }
  setAlpha(a) { this._color = ((a & 255) << 24) | (this._color & 0xFFFFFF); }
  setTextSize(px) { this._size = f(px); }
  getTextSize() { return this._size; }
  /** Typeface.create("sans-serif" | "sans-serif-medium", NORMAL). */
  setTypeface(family) { this._family = family; }
  setTextAlign(align) { this._align = align; }
  setStyle(style) { this._style = style; }
  setStrokeWidth(w) { this._stroke = f(w); }
  getStrokeWidth() { return this._stroke; }
  font() { return (this._family === 'sans-serif-medium' ? '500 ' : '400 ') + this._size + 'px ' + "Roboto, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif"; }
  measureText(s) { return f(this._measure(this.font(), s)); }
  ascent() { return f(ASCENT * this._size); }
  descent() { return f(DESCENT * this._size); }
}

/** android.graphics.Canvas over a CanvasRenderingContext2D (coordinates in CSS px). */
export class Canvas2D {
  constructor(ctx) { this.ctx = ctx; }
  _paint(p) { const c = this.ctx; if (p._style === TextPaint.STROKE) { c.strokeStyle = css(p._color); c.lineWidth = p._stroke; } else c.fillStyle = css(p._color); }
  drawRect(l, t, r, b, p) { this._paint(p); if (p._style === TextPaint.STROKE) this.ctx.strokeRect(l, t, r - l, b - t); else this.ctx.fillRect(l, t, r - l, b - t); }
  drawLine(x1, y1, x2, y2, p) { const c = this.ctx; c.strokeStyle = css(p._color); c.lineWidth = p._stroke; c.lineCap = 'butt'; c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); }
  drawCircle(cx, cy, r, p) { const c = this.ctx; this._paint(p); c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); if (p._style === TextPaint.STROKE) c.stroke(); else c.fill(); }
  drawRoundRect(l, t, r, b, rx, ry, p) {
    const c = this.ctx; this._paint(p); const k = Math.min(rx, (r - l) / 2, (b - t) / 2); c.beginPath();
    c.moveTo(l + k, t); c.arcTo(r, t, r, b, k); c.arcTo(r, b, l, b, k); c.arcTo(l, b, l, t, k); c.arcTo(l, t, r, t, k); c.closePath();
    if (p._style === TextPaint.STROKE) c.stroke(); else c.fill();
  }
  drawText(s, x, y, p) { const c = this.ctx; c.font = p.font(); c.textAlign = p._align; c.textBaseline = 'alphabetic'; c.fillStyle = css(p._color); c.fillText(s, x, y); }
}

/** The month on screen with its neighbours (their days fill the first and last week). */
class Scene {
  /** (month, current, previous, next) or (month, store, draft). */
  constructor(m, a, b, c) {
    this.month = m;
    if (a != null && typeof a.combinedPreview === 'function') { this.current = a.combinedPreview(m, b); this.previous = a.loadCombined(m.minusMonths(1)); this.next = a.loadCombined(m.plusMonths(1)); }
    else { this.current = a; this.previous = b; this.next = c; }
  }
  combined() { return this.current != null && this.current.kind !== Schedule.WORK; }
  rows() { return Math.trunc((Schedule.mondayOffset(this.month) + this.month.lengthOfMonth() + 6) / 7); }
}

export class CalendarPainter {
  static PANEL = 0xFF292E41 | 0; static ACCENT = ThemeUi.ACCENT;
  static Scene = Scene;
  static scale(w, h, s) { return Math.min(f(w / 340), f(h / f(27 + s.rows() * (s.combined() ? 67 : 46)))); }
  static hit(x, y, w, h, s) {
    const head = f(27 * CalendarPainter.scale(w, h, s)); if (x < 0 || x >= w || y < head || y >= h) return null;
    const cell = Math.trunc(f(f(y - head) / f(f(h - head) / s.rows()))) * 7 + Math.trunc(f(x / f(w / 7)));
    return s.month.atDay(1).minusDays(Schedule.mondayOffset(s.month)).plusDays(cell);
  }
  static draw(c, w, h, scene, t, today, selected, hover, pressed) {
    const p = new TextPaint(c.measure ?? ((font, s) => { c.ctx.font = font; return c.ctx.measureText(s).width; }));
    const scale = CalendarPainter.scale(w, h, scene), head = f(27 * scale), col = f(w / 7), rh = f(f(h - head) / scene.rows());
    const first = scene.month.atDay(1).minusDays(Schedule.mondayOffset(scene.month));
    const same = (a, b) => a != null && b != null && a.equals(b);
    p.setColor(t.color('calendar.background')); c.drawRect(0, 0, w, h, p);
    for (let i = 0; i < scene.rows() * 7; i++) {
      const date = first.plusDays(i); const x = f((i % 7) * col), y = f(head + Math.trunc(i / 7) * rh);
      p.setColor(t.color('calendar.cell')); c.drawRect(x, y, x + col, y + rh, p);
      if (same(date, selected)) { p.setColor(t.color('selected.fill')); c.drawRect(x, y, x + col, y + rh, p); if (pressed > 0) { p.setColor(t.color('selected.effect')); p.setAlpha(Math.round(p.getAlpha() * pressed)); c.drawRect(x, y, x + col, y + rh, p); } }
      if (same(date, hover)) { p.setColor(t.color('calendar.hover')); c.drawRect(x, y, x + col, y + rh, p); }
    }
    p.setTypeface('sans-serif'); p.setTextAlign('center'); p.setTextSize(11 * scale); p.setColor(t.color('calendar.weekday'));
    const weekdays = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN']; for (let i = 0; i < 7; i++) c.drawText(weekdays[i], f((i + 0.5) * col), f(17 * scale), p);
    p.setColor(t.color('calendar.vertical')); p.setStrokeWidth(t.size('calendar.verticalWidth') * scale); if (p.getStrokeWidth() > 0) for (let i = 1; i < 7; i++) c.drawLine(i * col, head, i * col, h, p);
    p.setColor(t.color('calendar.horizontal')); p.setStrokeWidth(t.size('calendar.horizontalWidth') * scale); if (p.getStrokeWidth() > 0) for (let i = 0; i < scene.rows(); i++) c.drawLine(0, head + i * rh, w, head + i * rh, p);
    for (let i = 0; i < scene.rows() * 7; i++) {
      const date = first.plusDays(i); const active = YearMonth.from(date).equals(scene.month), isToday = same(date, today); const x = f((i % 7) * col), y = f(head + Math.trunc(i / 7) * rh);
      if (isToday) { p.setColor(t.color('today.fill')); c.drawCircle(x + col / 2, y + 11.3 * scale, 9 * scale, p); p.setStyle(TextPaint.STROKE); p.setStrokeWidth(scale); p.setColor(t.color('today.border')); c.drawCircle(x + col / 2, y + 11.3 * scale, 9 * scale, p); p.setStyle(TextPaint.FILL); }
      p.setTypeface('sans-serif'); p.setTextSize(11 * scale); p.setColor(t.color(isToday ? 'today.text' : !active ? 'calendar.outside' : i % 7 >= 5 ? 'calendar.weekend' : 'calendar.day')); c.drawText(String(date.getDayOfMonth()), x + col / 2, y + 15 * scale, p);
      const s = active ? scene.current : date.isBefore(scene.month.atDay(1)) ? scene.previous : scene.next; if (s == null) continue; const index = date.getDayOfMonth() - 1;
      const lines = CalendarCell.lines(s, index); if (lines.length === 0) continue;
      const code = s.shifts[index], person = Schedule.givenName(s.swapPeople[index]); const warning = !s.dayComplete(index); const alpha = active ? 255 : t.color('calendar.outside') >>> 24;
      const top = f(y + 22 * scale), bottom = Math.min(f(top + lines.length * 13 * scale + 4 * scale), f(y + rh - 3 * scale)), lineH = f((bottom - top) / lines.length), available = f(col - 8 * scale);
      p.setColor(t.color(warning ? 'warning.background' : 'pipe.block')); p.setAlpha(Math.trunc(p.getAlpha() * alpha / 255)); c.drawRoundRect(x + 2 * scale, top, x + col - 2 * scale, bottom, 4 * scale, 4 * scale, p);
      for (let line = 0; line < lines.length; line++) {
        const lt = f(top + line * lineH), lb = f(lt + lineH); const nameLine = person !== '' && line === lines.length - 1;
        p.setColor(line === 0 ? (code == null ? t.color('warning.background') : t.shift(code, false)) : warning ? t.color('warning.background') : t.color('pipe.background')); p.setAlpha(Math.trunc(p.getAlpha() * alpha / 255));
        if (line === 0) c.drawRoundRect(x + 2 * scale, lt, x + col - 2 * scale, lb, 3 * scale, 3 * scale, p); else c.drawRect(x + 2 * scale, lt, x + col - 2 * scale, lb, p);
        p.setColor(line === 0 ? (code == null ? t.color('warning.text') : t.shift(code, true)) : warning ? t.color('warning.text') : t.color(!nameLine && matches(lines[line], '[0-9]+') ? 'pipe.number' : 'pipe.text')); p.setAlpha(Math.trunc(p.getAlpha() * alpha / 255));
        p.setTypeface(line === 0 ? 'sans-serif-medium' : 'sans-serif'); p.setTextSize((line === 0 ? 11 : 10) * scale);
        if (!nameLine && p.measureText(lines[line]) > available) p.setTextSize(Math.max(7 * scale, p.getTextSize() * available / p.measureText(lines[line])));
        c.drawText(CalendarPainter.ellipsize(lines[line], p, available), x + col / 2, (lt + lb) / 2 - (p.ascent() + p.descent()) / 2, p);
      }
    }
    // Selection is independent of today's circle, including on an empty day.
    if (selected != null) {
      const index = ChronoUnit.DAYS.between(first, selected);
      if (index >= 0 && index < scene.rows() * 7 && t.size('selected.width') > 0) {
        const x = f((index % 7) * col), y = f(head + Math.trunc(index / 7) * rh), inset = Math.max(1, f(t.size('selected.width') * scale / 2));
        p.setStyle(TextPaint.STROKE); p.setStrokeWidth(t.size('selected.width') * scale); p.setColor(t.color('selected.border')); c.drawRoundRect(x + inset, y + inset, x + col - inset, y + rh - inset, 5 * scale, 5 * scale, p); p.setStyle(TextPaint.FILL);
      }
    }
  }
  /** TextUtils.ellipsize(value, p, width, END). */
  static ellipsize(value, p, width) {
    width = Math.max(0, width); if (p.measureText(value) <= width) return value;
    for (let n = value.length - 1; n > 0; n--) { const cut = value.substring(0, n) + '…'; if (p.measureText(cut) <= width) return cut; }
    return p.measureText('…') <= width ? '…' : '';
  }
}

/** LocalDate today (overridable in tests). */
export const today = () => LocalDate.now();
