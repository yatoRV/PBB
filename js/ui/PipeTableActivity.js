// Port of vn.lichdilam.PipeTableActivity (APK 4.5).
// 3.1–3.4 (the user, 27/10): the assignment photos as the paper reads — a row per date, a column per pipe, the
// people's names in the cells. The screen is always sideways, so the rows are as long as the phone can make them;
// swiping left and right reaches the other pipes. The row of pipes stays in sight while the dates scroll, today's row
// has its own border, and the person using the app is written in bold. Nothing else is on this screen: no legend and
// no notice. docs/UI-MAP-PipeImport-PipeTable-PhotoViewer.md (PT1–PT14).
// Web adaptations:
//  - setRequestedOrientation(LANDSCAPE) → screen.orientation.lock("landscape") where the browser allows it; the table
//    also works upright;
//  - the HorizontalScrollView + ScrollView pair is one scroll container (it scrolls only inside the table area); the
//    HeaderView and BodyView are two canvases the size of the visible area, redrawn at the scroll position, so no
//    canvas is ever larger than the screen (iPhone memory); the header follows the sideways scroll only;
//  - LockChip is a button holding the same padlock/chip drawn as SVG (44 px touch target around the 32 dp chip).
import { RuntimeException } from '../platform/java.js';
import { YearMonth, LocalDate } from '../platform/time.js';
import { Toast } from '../platform/widget.js';
import { AppLog } from '../core/AppLog.js';
import { Schedule } from '../core/Schedule.js';
import { ScheduleStore } from '../core/ScheduleStore.js';
import { PipeTable } from '../core/PipeTable.js';
import { PipeTableNames } from '../core/PipeTableNames.js';
import { ThemedActivity } from './ThemedActivity.js';
import { ThemeUi } from './ThemeUi.js';
import { UiResume } from './UiResume.js';
import { TextPaint, Canvas2D } from './CalendarPainter.js';
import { el, textView, editText, describe } from './Views.js';

const LOCK_NAMES = 'pipe:table:lockNames', LOCK_DAYS = 'pipe:table:lockDays';
const SVG = 'http://www.w3.org/2000/svg';
const dpr = () => globalThis.devicePixelRatio || 1;
/** dp(n) in CSS px: Math.round(n × density) device pixels. */
const dp = n => Math.round(n * dpr()) / dpr();
const f = Math.fround;

/** TextPaint with the bold style (Typeface.create(family, BOLD)) and the ink bounds of getTextBounds. */
class Paint extends TextPaint {
  constructor(ctx) { super((font, s) => { ctx.font = font; return ctx.measureText(s).width; }); this._ctx = ctx; this._bold = false; }
  setTypeface(family, bold = false) { super.setTypeface(family); this._bold = bold; }
  font() { const base = super.font(); return this._bold ? base.replace(/^\d+ /, '700 ') : base; }
  /** getTextBounds(value): ink left/right relative to the start of the text. */
  textBounds(s) { const c = this._ctx; c.font = this.font(); c.textAlign = 'left'; const m = c.measureText(s); return { left: -(m.actualBoundingBoxLeft || 0), right: m.actualBoundingBoxRight || m.width }; }
}

export class PipeTableActivity extends ThemedActivity {
  constructor() {
    super();
    this.month = null; this.book = null; this.data = null; this.sheet = 0; this.lockNames = false; this.lockDays = false;
    /** The pipe column the user tapped, kept as a guide down the dates; null until one is tapped. */
    this.guide = null;
    this.draftDay41 = 0; this.draftPipe41 = null; this.draftName41 = null; this.owner = ''; this.typed = null; this.prefs = null;
    this.header = null; this.body = null; this._frame = 0; this._resize = null;
  }
  onCreate(state) {
    if (state == null) state = UiResume.restoreBundle(this);
    super.onCreate(state);
    // 3.4 (the user): opening the table turns the phone sideways at once — the table is read lengthwise.
    try { const lock = globalThis.screen?.orientation?.lock?.('landscape'); if (lock != null && typeof lock.catch === 'function') lock.catch(() => {}); } catch (ignored) { /* not allowed here */ }
    this.prefs = this.getSharedPreferences('schedules', 0); this.typed = new PipeTableNames(this.prefs);
    this.lockNames = this.prefs.getBoolean(LOCK_NAMES, false); this.lockDays = this.prefs.getBoolean(LOCK_DAYS, false);
    const store = new ScheduleStore(this);
    this.month = store.lastCombinedMonth();
    try { if (this.getIntent().hasExtra('month')) this.month = YearMonth.parse(this.getIntent().getStringExtra('month')); } catch (ignored) { /* keep */ }
    if (state != null) { try { this.month = YearMonth.parse(state.getString('month', this.month.toString())); } catch (ignored) { /* keep */ } this.sheet = state.getInt('sheet', 0); this.guide = state.getString('guide'); }
    this.book = store.pipeBook(this.month);
    const work = store.load(this.month);
    this.owner = work != null && work.employeeName != null ? work.employeeName : store.name();
    this.build();
    if (state != null && state.getInt('editDay41', 0) > 0 && this.data != null) { const saved = state; requestAnimationFrame(() => { this.editCell(saved.getInt('editDay41'), saved.getString('editPipe41')); if (this.draftName41 != null) this.draftName41.value = saved.getString('editName41', ''); }); }
  }
  onSaveInstanceState(state) {
    super.onSaveInstanceState(state); if (this.month == null) return; state.putString('month', this.month.toString()); state.putInt('sheet', this.sheet); state.putString('guide', this.guide);
    if (this.draftName41 != null) { state.putInt('editDay41', this.draftDay41); state.putString('editPipe41', this.draftPipe41); state.putString('editName41', this.draftName41.value); }
  }
  /** onConfigurationChanged (rotation) / a resize: the table is laid out again at its scroll position. */
  onConfigurationChanged() { this.redrawSoon(); }
  onPaletteChanged() { this.redrawSoon(); } // the chips use the palette's CSS variables
  resumeScope() { return 'pipe:' + this.month + ':' + this.sheet; }
  sheets() { return Math.max(1, PipeTable.count(this.book)); }
  redraw() { AppLog.table('PipeTableActivity', this.month, this.sheet, this.data, this.typed, this.owner, this.lockNames, this.lockDays, this.guide); if (this.body != null) this.body.auditNextDraw = true; this.paint(); }
  redrawSoon() { if (this._frame !== 0) return; this._frame = requestAnimationFrame(() => { this._frame = 0; this.paint(); }); }

  build() {
    this.release(); this.header = null; this.body = null;
    const root = el('div', 'pt'); ThemeUi.solid(root, ThemeUi.BG);
    const top = el('div', 'row pt-top');
    const title = el('button', 'pt-title', 'Lịch phân ống ' + (this.sheet + 1)); title.type = 'button'; ThemeUi.text(title, ThemeUi.TEXT);
    describe(title, 'Lịch phân ống ' + (this.sheet + 1) + ' trên ' + this.sheets() + '. Chạm để xem tờ tiếp theo.');
    title.addEventListener('click', () => { this.sheet = (this.sheet + 1) % this.sheets(); this.guide = null; this.build(); });
    top.append(title);
    // 3.4 (the user): both locks on one line, so the table keeps the height instead.
    top.append(this.lock('Khoá tên', this.lockNames, on => { this.lockNames = on; this.prefs.edit().putBoolean(LOCK_NAMES, on).apply(); this.build(); }));
    top.append(this.lock('Khoá ngày', this.lockDays, on => { this.lockDays = on; this.prefs.edit().putBoolean(LOCK_DAYS, on).apply(); if (on) this.guide = null; this.build(); }));
    root.append(top);
    if (this.book == null || PipeTable.count(this.book) === 0) {
      root.append(textView('Chưa có ảnh phân ống cho tháng ' + this.month.getMonthValue() + '.', 14, ThemeUi.MUTED));
      AppLog.table('PipeTableActivity', this.month, this.sheet, null, this.typed, this.owner, this.lockNames, this.lockDays, this.guide); this.setContentView(root); return;
    }
    this.sheet = Math.max(0, Math.min(this.sheet, this.sheets() - 1)); this.data = PipeTable.of(this.book, this.sheet);
    AppLog.table('PipeTableActivity', this.month, this.sheet, this.data, this.typed, this.owner, this.lockNames, this.lockDays, this.guide);
    const area = el('div', 'pt-table'); const headerCanvas = el('canvas', 'pt-header'); const bodyCanvas = el('canvas', 'pt-body');
    const scroller = el('div', 'pt-scroll'); const sizer = el('div', 'pt-sizer'); scroller.append(sizer); area.append(headerCanvas, bodyCanvas, scroller); root.append(area);
    this.header = { canvas: headerCanvas, height: 34 }; this.body = { canvas: bodyCanvas, scroller, sizer, rowHeight: 46, auditNextDraw: true, w: 0, h: 0 };
    scroller.addEventListener('scroll', () => this.redrawSoon(), { passive: true });
    scroller.addEventListener('click', e => this.tap(e));
    this.setContentView(root);
    if (typeof ResizeObserver === 'function') { this._resize = new ResizeObserver(() => { if (this.body != null) this.body.auditNextDraw = true; this.redrawSoon(); }); this._resize.observe(area); }
    this.redrawSoon();
  }
  lock(label, on, toggle) {
    const chip = el('button', 'pt-lock'); chip.type = 'button'; chip.setAttribute('aria-pressed', String(on));
    describe(chip, label + (on ? ': đang bật, không sửa được' : ': đang tắt'));
    chip.append(this.lockChip(label, on)); chip.addEventListener('click', () => toggle(!on)); return chip;
  }
  /** "Khoá tên" and "khoá ngày": a closed padlock and a lit chip while the lock is on (106 × 32 dp). */
  lockChip(label, on) {
    const w = 106, h = 32, r = h / 2; const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h); svg.setAttribute('width', w); svg.setAttribute('height', h); svg.setAttribute('aria-hidden', 'true');
    const node = (tag, attrs) => { const n = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); svg.append(n); return n; };
    const fill = ThemeUi.css(on ? 'app.accent' : 'app.panel'), ink = ThemeUi.css(on ? 'app.onAccent' : 'app.muted');
    const rect = node('rect', { x: on ? 0 : 0.5, y: on ? 0 : 0.5, width: on ? w : w - 1, height: on ? h : h - 1, rx: r, ry: r }); rect.style.fill = fill;
    if (!on) { rect.style.stroke = ThemeUi.css('calendar.horizontal'); rect.style.strokeWidth = String(Math.max(1, dp(1))); }
    // A padlock whose shackle stands over the body when locked and leans open when not.
    const cx = h * 0.52, cy = h / 2, size = h * 0.46, bw = size * 0.62, bh = size * 0.48, top = cy + size * 0.02;
    const body = node('rect', { x: cx - bw / 2, y: top - bh / 2, width: bw, height: bh, rx: size * 0.1, ry: size * 0.1 }); body.style.fill = ink;
    const shackle = size * 0.24, hinge = on ? cx : cx - size * 0.26, arcY = top - bh / 2 - shackle * 0.5, stroke = Math.max(1.4, size * 0.15);
    let d = 'M' + (hinge - shackle) + ' ' + arcY + ' A' + shackle + ' ' + shackle + ' 0 0 1 ' + (hinge + shackle) + ' ' + arcY + ' M' + (hinge + shackle) + ' ' + (top - bh / 2 - shackle * 0.5) + ' L' + (hinge + shackle) + ' ' + (top - bh / 2);
    if (!on) d += ' M' + (hinge - shackle) + ' ' + (top - bh / 2 - shackle * 0.5) + ' L' + (hinge - shackle) + ' ' + (top - bh / 2 - shackle * 0.1);
    const path = node('path', { d, fill: 'none', 'stroke-linecap': 'round' }); path.style.stroke = ink; path.style.strokeWidth = String(stroke);
    const text = node('text', { x: h * 0.86, y: h / 2, 'dominant-baseline': 'central', 'font-size': h * 0.40 }); text.textContent = label; text.style.fill = ink; text.style.fontWeight = on ? '700' : '500';
    return svg;
  }
  isOwner(name) {
    if (this.owner == null || this.owner.trim() === '' || name == null || name.trim() === '') return false;
    try { return Schedule.lookupNameMatches(this.owner, name); } catch (e) { if (e instanceof RuntimeException || e instanceof Error) return false; throw e; }
  }
  editCell(day, pipe) {
    const input = editText({ hint: 'Họ tên người đi ống này', capWords: true }); input.classList.add('field--inner'); this.draftDay41 = day; this.draftPipe41 = pipe; this.draftName41 = input;
    const current = this.typed.get(this.month, this.sheet, day, pipe); const read = this.data.names(day, pipe);
    input.value = current != null ? current : read.length === 0 ? '' : read[0];
    const box = el('div', 'dlg-box'); box.append(input);
    const dialog = new ThemeUi.DialogBuilder(this)
      .setTitle('Ngày ' + day + ' · ống ' + pipe)
      .setView(box)
      .setPositiveButton('Lưu', () => {
        try { this.typed.put(this.month, this.sheet, day, pipe, input.value); this.redraw(); }
        catch (e) { if (!(e instanceof RuntimeException) && !(e instanceof Error)) throw e; Toast.makeText(this, e.message, Toast.LENGTH_LONG).show(); }
      })
      .setNeutralButton('Xóa tên', () => { this.typed.put(this.month, this.sheet, day, pipe, ''); this.redraw(); })
      .setNegativeButton('Hủy', null).create();
    dialog.setOnDismissListener(() => { this.draftName41 = null; this.draftDay41 = 0; this.draftPipe41 = null; }); dialog.show();
  }

  /** Body size as the views measure it: the table is at least the visible area (fillViewport). */
  measureTable() {
    const b = this.body, s = b.scroller; const viewW = s.clientWidth, viewH = s.clientHeight;
    b.w = Math.max(viewW, 46 + this.data.columns.length * 88); b.h = Math.max(viewH, b.rowHeight * this.data.days);
    b.sizer.style.width = b.w + 'px'; b.sizer.style.height = b.h + 'px'; return [viewW, viewH];
  }
  _canvas(canvas, w, h) {
    const k = dpr(), cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; } canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d'); ctx.setTransform(k, 0, 0, k, 0, 0); return ctx;
  }
  paint() {
    if (this.body == null || this.data == null || this.isDestroyed()) return;
    const [viewW, viewH] = this.measureTable(); if (viewW === 0 || viewH === 0) return; const sx = this.body.scroller.scrollLeft, sy = this.body.scroller.scrollTop;
    const hc = this._canvas(this.header.canvas, viewW, this.header.height); hc.save(); hc.translate(-sx, 0); this.drawHeader(new Canvas2D(hc), hc, this.body.w, this.header.height); hc.restore();
    const bc = this._canvas(this.body.canvas, viewW, viewH); bc.clearRect(0, 0, viewW, viewH); bc.save(); bc.translate(-sx, -sy); this.drawBody(new Canvas2D(bc), bc, { x: sx, y: sy, w: viewW, h: viewH }); bc.restore();
  }
  /** The row of pipes. It is outside the scrolling dates, so it stays in sight whichever date is reached. */
  drawHeader(c, ctx, w, h) {
    const t = this.palette(); const paint = new Paint(ctx); const data = this.data;
    const dayWidth = dp(46), cell = (w - dayWidth) / data.columns.length;
    paint.setColor(t.color('calendar.background')); c.drawRect(0, 0, w, h, paint);
    paint.setColor(t.color('calendar.cell')); c.drawRect(0, 0, w, h, paint);
    paint.setTextAlign('center'); paint.setTypeface('sans-serif-medium');
    paint.setColor(t.color('pipe.number'));
    for (let i = 0; i < data.columns.length; i++) {
      const x = dayWidth + (i + 0.5) * cell; const pipe = data.columns[i];
      paint.setTextSize(Math.min(dp(17), h * 0.58));
      if (paint.measureText(pipe) > cell - dp(4)) paint.setTextSize(paint.getTextSize() * (cell - dp(4)) / paint.measureText(pipe));
      c.drawText(pipe, x, h / 2 - (paint.ascent() + paint.descent()) / 2, paint);
    }
    paint.setColor(t.color('calendar.vertical')); paint.setStrokeWidth(Math.max(1 / dpr(), dp(0.6)));
    c.drawLine(dayWidth, 0, dayWidth, h, paint);
    for (let i = 1; i < data.columns.length; i++) c.drawLine(dayWidth + i * cell, 0, dayWidth + i * cell, h, paint);
    const at = this.guide == null ? -1 : data.columns.indexOf(this.guide);
    if (at >= 0) { paint.setColor(t.color('pipeTable.guide')); paint.setStyle(TextPaint.STROKE); paint.setStrokeWidth(dp(2)); c.drawRect(dayWidth + at * cell + dp(1), dp(1), dayWidth + (at + 1) * cell - dp(1), h, paint); paint.setStyle(TextPaint.FILL); }
    paint.setColor(t.color('calendar.horizontal')); paint.setStrokeWidth(Math.max(1 / dpr(), dp(0.6))); c.drawLine(0, h - 1 / dpr(), w, h - 1 / dpr(), paint);
  }
  /** The dates and the names on them (drawn for the visible part; the whole table when audited). */
  drawBody(c, ctx, view) {
    const t = this.palette(); const b = this.body; const data = this.data; const paint = new Paint(ctx);
    const audit = b.auditNextDraw ? [] : null; let overflowLines = 0, ellipsisLines = 0; const self = this;
    const w = b.w, h = b.h, dayWidth = dp(46), cell = (w - dayWidth) / data.columns.length, row = h / data.days;
    const now = LocalDate.now(); const today = YearMonth.from(now).equals(this.month) ? now.getDayOfMonth() : -1;
    const visible = (l, tp, r, bt) => audit != null || (r >= view.x && l <= view.x + view.w && bt >= view.y && tp <= view.y + view.h);
    let auditDay = 0, auditPipe = null, auditName = null;
    /** Keep every letter: fit the advance AND accented ink, with a small rounding margin (4 attempts, × 0.98). */
    function line(value, x, middle, available, size) {
      paint.setTextSize(size); const room = Math.max(1, available - 1);
      for (let attempt = 0; attempt < 4; attempt++) {
        const advance = paint.measureText(value); const ink = paint.textBounds(value);
        const width = Math.max(advance, Math.max(advance - 2 * ink.left, 2 * ink.right - advance));
        if (width <= room) break;
        paint.setTextSize(paint.getTextSize() * room / width * 0.98);
      }
      c.drawText(value, x, middle - (paint.ascent() + paint.descent()) / 2, paint);
      if (audit != null && auditName != null) {
        const advance = paint.measureText(value); const ink = paint.textBounds(value); const measured = Math.max(advance, Math.max(advance - 2 * ink.left, 2 * ink.right - advance));
        const overflow = measured > available + 0.01, ellipsis = value.includes('…') || value.includes('...'); if (overflow) overflowLines++; if (ellipsis) ellipsisLines++;
        audit.push(AppLog.data('day', auditDay, 'pipe', auditPipe, 'fullName', auditName, 'drawnText', value, 'textSizePx', f(paint.getTextSize() * dpr()), 'measuredWidthPx', f(measured * dpr()), 'availablePx', f(available * dpr()), 'overflow', overflow, 'containsEllipsis', ellipsis));
      }
    }
    /** 3.4 (the user): a name too wide for its cell goes on two lines — "L.T." above, "Nghĩa" below. */
    function name(full, x, middle, available, slot) {
      const parts = PipeTable.nameLines(full); const one = Math.min(dp(16), slot * 0.52);
      paint.setTextSize(one);
      if (parts.length === 1 || paint.measureText(PipeTable.shortName(full)) <= available) { line(PipeTable.shortName(full), x, middle, available, one); return; }
      const size = Math.min(dp(15), slot * 0.40), gap = size * 1.04;
      line(parts[0], x, middle - gap / 2, available, size); line(parts[1], x, middle + gap / 2, available, size);
    }
    paint.setColor(t.color('calendar.background')); c.drawRect(0, 0, w, h, paint);
    paint.setColor(t.color('calendar.cell')); c.drawRect(0, 0, dayWidth, h, paint);
    paint.setTextAlign('center');
    for (let day = 1; day <= data.days; day++) {
      const top = row * (day - 1); if (!visible(0, top, w, top + row)) continue;
      auditName = null;
      paint.setColor(t.color('calendar.day')); paint.setTypeface('sans-serif-medium');
      line(String(day), dayWidth / 2, top + row / 2, dayWidth - dp(3), Math.min(dp(18), row * 0.42));
      for (let i = 0; i < data.columns.length; i++) {
        const pipe = data.columns[i]; const manual = this.typed.get(this.month, this.sheet, day, pipe);
        const names = manual != null ? [manual] : data.names(day, pipe);
        if (names.length === 0) continue;
        const x = dayWidth + (i + 0.5) * cell, available = cell - dp(5), slot = row / names.length;
        if (!visible(x - cell / 2, top, x + cell / 2, top + row)) continue;
        for (let n = 0; n < names.length; n++) {
          auditDay = day; auditPipe = pipe; auditName = names[n];
          const mine = self.isOwner(names[n]);
          paint.setColor(t.color(manual != null ? 'app.accent' : 'pipe.text'));
          paint.setTypeface(mine ? 'sans-serif-medium' : 'sans-serif', mine);
          const middle = top + (n + 0.5) * slot; const dot = mine && day === today;
          name(names[n], x, dot ? middle - slot * 0.10 : middle, available, slot);
          // Today only: a dot under the user's own name, so their row is found at a glance.
          if (dot) { paint.setColor(t.color('pipeTable.today')); c.drawCircle(x, middle + slot * 0.36, Math.max(dp(2), slot * 0.08), paint); }
        }
      }
    }
    paint.setColor(t.color('calendar.vertical')); paint.setStrokeWidth(Math.max(1 / dpr(), dp(0.6)));
    c.drawLine(dayWidth, 0, dayWidth, h, paint);
    for (let i = 1; i < data.columns.length; i++) c.drawLine(dayWidth + i * cell, 0, dayWidth + i * cell, h, paint);
    paint.setColor(t.color('calendar.horizontal'));
    for (let day = 1; day < data.days; day++) c.drawLine(0, row * day, w, row * day, paint);
    const at = this.guide == null ? -1 : data.columns.indexOf(this.guide);
    if (at >= 0) { paint.setColor(t.color('pipeTable.guide')); paint.setStyle(TextPaint.STROKE); paint.setStrokeWidth(dp(2)); c.drawRect(dayWidth + at * cell + dp(1), 0, dayWidth + (at + 1) * cell - dp(1), h, paint); paint.setStyle(TextPaint.FILL); }
    if (today > 0) {
      paint.setColor(t.color('pipeTable.today')); paint.setStrokeWidth(dp(2.4));
      const top = row * (today - 1), bottom = top + row;
      c.drawLine(0, top, w, top, paint); c.drawLine(0, bottom, w, bottom, paint);
    }
    if (audit != null) { AppLog.event('display.pipeTable.render', AppLog.data('month', this.month.toString(), 'sheet', this.sheet + 1, 'widthPx', f(w * dpr()), 'heightPx', f(h * dpr()), 'cellWidthPx', f(cell * dpr()), 'rowHeightPx', f(row * dpr()), 'density', dpr(), 'fontScale', 1, 'overflowLineCount', overflowLines, 'ellipsisLineCount', ellipsisLines, 'drawnLines', audit)); b.auditNextDraw = false; }
  }
  tap(e) {
    const b = this.body; if (b == null) return; const r = b.sizer.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
    const data = this.data; const dayWidth = dp(46), cell = (b.w - dayWidth) / data.columns.length, row = b.h / data.days;
    if (x < dayWidth) return;
    const day = Math.trunc(y / row) + 1, column = Math.trunc((x - dayWidth) / cell);
    if (day < 1 || day > data.days || column < 0 || column >= data.columns.length) return;
    const pipe = data.columns[column];
    AppLog.event('user.pipeTableCell', AppLog.data('month', this.month.toString(), 'sheet', this.sheet + 1, 'day', day, 'pipe', pipe, 'names', data.names(day, pipe), 'manualName', this.typed.get(this.month, this.sheet, day, pipe), 'lockNames', this.lockNames, 'lockDays', this.lockDays));
    // "Khoá ngày" off: the tapped column is marked down the dates, so the next days of the same pipe are easy to
    // follow. "Khoá tên" off: the same tap opens the name of that cell for typing.
    if (!this.lockDays) { this.guide = pipe === this.guide ? null : pipe; this.redraw(); }
    if (!this.lockNames) this.editCell(day, pipe);
  }
  release() {
    if (this._resize != null) { this._resize.disconnect(); this._resize = null; }
    if (this._frame !== 0) { cancelAnimationFrame(this._frame); this._frame = 0; }
    for (const v of [this.header, this.body]) if (v != null) { v.canvas.width = 0; v.canvas.height = 0; }
  }
  onDestroy() {
    super.onDestroy(); this.release();
    try { globalThis.screen?.orientation?.unlock?.(); } catch (ignored) { /* nothing locked */ }
  }
}
