// Port of vn.lichdilam.AppearanceActivity (APK 4.5): "Giao diện". Editing uses private palette copies. Only Apply
// replaces the two persisted palettes. docs/UI-MAP-Settings.md (A1–A20).
// Web: the previews are canvases drawn by the real CalendarPainter (sized to their box at the device pixel ratio);
// a palette written through ThemeSettings recolours the app at once (CSS variables, js/shell/theme.js) and the
// calendar redraws; saved colour sets are ColorThemeStore files (files/color-themes), synced to Drive with the other
// files. CalendarWidget.refreshAppearance: no widgets on the web (spec ruling).
import { JSONArray, JSONObject } from '../platform/json.js';
import { YearMonth, LocalDate, Instant, ZoneId, DateTimeFormatter } from '../platform/time.js';
import { Toast } from '../platform/widget.js';
import { AlertDialog } from '../platform/widget.js';
import { cssColor } from '../shell/theme.js';
import { AppLog } from '../core/AppLog.js';
import { Schedule } from '../core/Schedule.js';
import { ScheduleStore } from '../core/ScheduleStore.js';
import { CalendarIssue } from '../core/CalendarIssue.js';
import { ThemePalette } from '../core/ThemePalette.js';
import { ThemeSettings } from '../core/ThemeSettings.js';
import { ColorThemeStore } from '../core/ColorThemeStore.js';
import { ThemedActivity } from './ThemedActivity.js';
import { ThemeUi } from './ThemeUi.js';
import { ThemeReceiver } from './ThemeReceiver.js';
import { UiResume } from './UiResume.js';
import { CalendarPainter, Canvas2D, TextPaint } from './CalendarPainter.js';
import { RgbColorPicker } from './RgbColorPicker.js';
import { el, textView, buttonView, editText, describe } from './Views.js';

const CalendarWidget = Object.freeze({ refreshAppearance() {} }); // no launcher widgets on the web (spec ruling)
const dpr = () => globalThis.devicePixelRatio || 1;

/** A View drawn on a canvas sized to its box (onDraw(ctx, width, height) in CSS px). */
class CanvasView {
  constructor(height, onDraw) {
    this.view = el('canvas', 'canvas-view'); this.view.style.height = height + 'px'; this.onDraw = onDraw; this._frame = 0;
    if (typeof ResizeObserver === 'function') { this._observer = new ResizeObserver(() => this.invalidate()); this._observer.observe(this.view); }
  }
  getWidth() { return this.view.clientWidth; }
  getHeight() { return this.view.clientHeight; }
  invalidate() { if (this._frame !== 0) return; this._frame = requestAnimationFrame(() => { this._frame = 0; this.draw(); }); }
  draw() {
    const w = this.getWidth(), h = this.getHeight(); if (w === 0 || h === 0) return; const k = dpr();
    if (this.view.width !== Math.round(w * k) || this.view.height !== Math.round(h * k)) { this.view.width = Math.round(w * k); this.view.height = Math.round(h * k); }
    const ctx = this.view.getContext('2d'); ctx.setTransform(k, 0, 0, k, 0, 0); ctx.clearRect(0, 0, w, h); this.onDraw(ctx, w, h);
  }
  release() { if (this._observer != null) this._observer.disconnect(); if (this._frame !== 0) cancelAnimationFrame(this._frame); this.view.width = this.view.height = 0; }
}

export class AppearanceActivity extends ThemedActivity {
  constructor() {
    super();
    this.settings = null; this.light = null; this.dark = null; this.editingLight = true; this.sample = false; this.favorites = null; this.codes = new Set(); this.swatches = []; this.refreshNumbers = []; this.expanded = new Set();
    this.month = null; this.realScene = null; this.preview = null; this.contrast = null; this.editingLabel = null; this.options = null; this.themes = null; this.lightButton = null; this.darkButton = null; this._canvases = [];
  }
  onCreate(state) {
    if (state == null) state = UiResume.restoreBundle(this); super.onCreate(state); this.settings = new ThemeSettings(this); this.light = this.settings.palette(true); this.dark = this.settings.palette(false); this.favorites = this.settings.favorites(); this.editingLight = this.palette().light; this.month = new ScheduleStore(this).lastCombinedMonth();
    try {
      if (this.getIntent().hasExtra('month')) this.month = YearMonth.parse(this.getIntent().getStringExtra('month'));
      if (state != null) { this.light = ThemePalette.parse(new JSONObject(state.getString('draftLight'))); this.dark = ThemePalette.parse(new JSONObject(state.getString('draftDark'))); this.editingLight = state.getBoolean('editingLight'); this.sample = state.getBoolean('sample'); this.favorites = []; const colors = new JSONArray(state.getString('favorites', '[]')); for (let i = 0; i < colors.length(); i++) this.favorites.push(colors.getInt(i)); for (const i of state.getIntArray('expanded') ?? []) this.expanded.add(i); }
    } catch (e) { Toast.makeText(this, 'Đã khôi phục bảng màu đã lưu.', Toast.LENGTH_SHORT).show(); }
    this.themes = new ColorThemeStore(this); try { this.themes.migrateLegacy(this.settings.presets); } catch (e) { Toast.makeText(this, 'Chưa chuyển hết preset cũ sang bộ màu: ' + e.message, Toast.LENGTH_LONG).show(); }
    const store = new ScheduleStore(this); this.realScene = new CalendarPainter.Scene(this.month, store, null);
    const codes = [...store.knownCodes(), ...this.light.shifts.keys(), ...this.dark.shifts.keys()]; this.codes = new Set(codes.sort()); this.build();
  }
  /** TreeSet order of the codes. */
  addCodes(keys) { const all = [...this.codes, ...keys]; this.codes = new Set([...new Set(all)].sort()); }
  draft() { return this.editingLight ? this.light : this.dark; }
  text(value, size, role) { const t = textView(value, size, role); t.classList.add('aa-text'); return t; }
  button(label, action) {
    const b = buttonView(label, false); b.classList.add('aa-button');
    b.addEventListener('click', () => { AppLog.event('user.action', AppLog.data('screen', this.constructor.name, 'action', b.textContent)); action(); }); return b;
  }
  canvas(height, onDraw) { const v = new CanvasView(height, onDraw); this._canvases.push(v); return v; }
  build() {
    const root = el('div', 'main'); const scroll = el('div', 'scroll'); const body = el('div', 'page aa'); scroll.append(body); root.append(scroll);
    const heading = this.text('Giao diện', 27, ThemeUi.TEXT); heading.classList.add('bold'); body.append(heading);
    const tabs = el('div', 'row aa-tabs'); this.lightButton = this.button('Bảng màu Sáng', () => this.switchDraft(true)); this.darkButton = this.button('Bảng màu Tối', () => this.switchDraft(false)); tabs.append(this.lightButton, this.darkButton); body.append(tabs);
    this.editingLabel = this.text('', 12, ThemeUi.ACCENT); body.append(this.editingLabel);
    this.preview = new Preview(this); describe(this.preview.view, 'Xem trước lịch với màu chưa áp dụng'); body.append(this.preview.view);
    const data = this.button('Đổi mẫu: lịch đã lưu / mẫu đủ trạng thái', () => { this.sample = !this.sample; this.changed(); }); data.classList.add('aa-sample'); body.append(data);
    this.contrast = this.text('', 12, ThemeUi.WARNING); this.contrast.setAttribute('aria-live', 'polite'); body.append(this.contrast); this.options = el('div', 'col aa-options'); ThemeUi.bg(this.options, ThemeUi.PANEL, 16); body.append(this.options); this.groups();
    body.append(this.button('Khôi phục màu mặc định của bảng đang sửa', () => new ThemeUi.DialogBuilder(this).setTitle('Khôi phục bảng màu ' + (this.editingLight ? 'Sáng' : 'Tối') + '?').setMessage('Chỉ thay đổi bản xem trước. Nhấn Áp dụng để lưu.').setNegativeButton('Hủy', null).setPositiveButton('Khôi phục', () => { if (this.editingLight) this.light = new ThemePalette(true); else this.dark = new ThemePalette(false); this.changed(); }).show()));
    const manage = this.text('Quản lý màu giao diện', 18, ThemeUi.TEXT); manage.classList.add('aa-manage'); body.append(manage); body.append(this.button('Lưu màu giao diện', () => this.saveThemeDialog())); body.append(this.button('Tải màu giao diện đã lưu', () => new SavedThemes(this).show())); body.append(this.button('Reset màu giao diện mặc định', () => this.resetDefaultsDialog()));
    const actions = el('div', 'row aa-actions'); const cancel = this.button('Hủy', () => this.finish()); actions.append(cancel); const apply = this.button('Áp dụng', () => this.apply()); apply.classList.add('btn--primary'); actions.append(apply); root.append(actions);
    this.setContentView(root); this.changed();
  }
  switchDraft(value) { this.editingLight = value; this.changed(); }
  changed() {
    if (this.preview == null) return; this.editingLabel.textContent = 'Đang chỉnh: ' + (this.editingLight ? 'Sáng' : 'Tối') + ' · ' + (this.sample ? 'Mẫu minh họa' : 'Lịch đã lưu') + ' · Chưa áp dụng';
    this.lightButton.setAttribute('aria-pressed', String(this.editingLight)); this.darkButton.setAttribute('aria-pressed', String(!this.editingLight));
    this.lightButton.textContent = this.editingLight ? '✓ Bảng màu Sáng' : 'Bảng màu Sáng'; this.darkButton.textContent = this.editingLight ? 'Bảng màu Tối' : '✓ Bảng màu Tối';
    for (const s of this.swatches) s(); for (const r of this.refreshNumbers) r(); this.preview.invalidate(); this.checkContrast();
  }
  group(index, title, hint) { // eslint-disable-line no-unused-vars
    const box = el('div', 'col aa-group'); ThemeUi.bg(box, ThemeUi.PANEL, 14); this.options.append(box);
    const toggle = this.button(title + '  ▾', () => {}); toggle.classList.add('aa-toggle'); box.append(toggle);
    const fields = el('div', 'col aa-fields'); fields.hidden = !this.expanded.has(index); toggle.setAttribute('aria-expanded', String(!fields.hidden)); box.append(fields);
    const divider = el('div', 'aa-divider'); divider.style.background = ThemeUi.css('calendar.horizontal'); box.append(divider);
    toggle.addEventListener('click', () => { const opening = fields.hidden; fields.hidden = !opening; if (opening) this.expanded.add(index); else this.expanded.delete(index); toggle.textContent = title + (opening ? '  ▴' : '  ▾'); toggle.setAttribute('aria-expanded', String(opening)); });
    if (!fields.hidden) toggle.textContent = title + '  ▴';
    return fields;
  }
  groups() {
    this.swatches = []; this.refreshNumbers = []; this.options.replaceChildren(); const a = this.group(0, 'Nền & bố cục', 'Nền lịch, đường kẻ, viền');
    this.colors(a, [['calendar.background', 'Nền khung lịch'], ['calendar.cell', 'Nền ô ngày'], ['calendar.horizontal', 'Đường kẻ ngang'], ['calendar.vertical', 'Đường kẻ dọc'], ['calendar.border', 'Viền ngoài khung lịch'], ['calendar.hover', 'Nền ô khi rê chuột']]); this.size(a, 'calendar.horizontalWidth', 'Độ dày đường ngang'); this.size(a, 'calendar.verticalWidth', 'Độ dày đường dọc');
    const b = this.group(1, 'Ngày & tiêu đề', 'Tháng, năm, thứ, số ngày'); this.colors(b, [['calendar.month', 'Tiêu đề tháng'], ['calendar.year', 'Năm'], ['calendar.weekday', 'Thứ trong tuần'], ['calendar.day', 'Số ngày'], ['calendar.outside', 'Ngày tháng khác · Alpha = độ mờ'], ['calendar.weekend', 'Ngày cuối tuần']]);
    const c = this.group(2, 'Mã ca làm việc', 'Màu nền và chữ riêng cho từng mã ca'); for (const code of this.codes) { const t = this.text(code, 15, ThemeUi.ACCENT); t.classList.add('aa-code'); c.append(t); this.color(c, 'Nền ' + code, () => this.draft().shift(code, false), v => this.draft().shift(code, false, v)); this.color(c, 'Chữ ' + code, () => this.draft().shift(code, true), v => this.draft().shift(code, true, v)); } this.colors(c, [['shift.background', 'Nền mặc định cho mã mới'], ['shift.text', 'Chữ mặc định cho mã mới']]);
    const d = this.group(3, 'Phân ống & trạng thái', 'TC1, HC, số ống, Khác Ca và dấu ?'); this.colors(d, [['pipe.text', 'Chữ phân ống có ký hiệu / tên'], ['pipe.number', 'Chữ số ống'], ['pipe.background', 'Nền vùng thông tin bổ sung'], ['warning.background', 'Nền cảnh báo ? / Khác Ca'], ['warning.text', 'Chữ cảnh báo ? / Khác Ca'], ['pipe.block', 'Nền khối mã ca kèm phân ống']]);
    const e = this.group(4, 'Điểm nhấn & nút bấm', 'Ngày hôm nay, ngày chọn, nút điều khiển'); this.colors(e, [['today.fill', 'Nền vòng tròn hôm nay'], ['today.border', 'Viền vòng tròn hôm nay'], ['today.text', 'Chữ ngày hôm nay'], ['selected.border', 'Viền ô ngày được chọn'], ['selected.fill', 'Nền ô ngày được chọn'], ['selected.effect', 'Hiệu ứng khi chọn ngày'], ['button.prev', 'Mũi tên tháng trước'], ['button.next', 'Mũi tên tháng sau'], ['button.addBackground', 'Nền nút +'], ['button.addText', 'Biểu tượng +'], ['button.editBackground', 'Nền nút Đổi mã ca'], ['button.editText', 'Chữ nút Đổi mã ca'], ['button.effect', 'Hiệu ứng nút khi nhấn / rê chuột']]); this.size(e, 'selected.width', 'Độ dày viền ngày được chọn');
    const f = this.group(5, 'Màu Lịch phân ống', 'Viền ngày hôm nay và viền dọc cột ống'); this.colors(f, [['pipeTable.today', 'Viền ngang ngày hôm nay'], ['pipeTable.guide', 'Viền dọc cột ống đang chọn']]);
  }
  colors(group, values) { for (const v of values) this.color(group, v[1], () => this.draft().color(v[0]), n => this.draft().color(v[0], n)); }
  color(parent, label, get, set) {
    const row = el('button', 'row aa-color'); row.type = 'button'; describe(row, 'Màu: ' + label); const title = el('span', 'grow aa-color__label', label); title.style.color = ThemeUi.css(ThemeUi.TEXT);
    const swatch = el('span', 'aa-swatch'); const fill = el('span', 'aa-swatch__fill'); swatch.append(fill); row.append(title, swatch);
    this.swatches.push(() => { fill.style.background = cssColor(get()); }); fill.style.background = cssColor(get());
    row.addEventListener('click', () => RgbColorPicker.show(this, label, get(), this.favorites, n => { set(n); this.changed(); })); parent.append(row);
  }
  size(parent, key, label) {
    const title = this.text('', 13, ThemeUi.MUTED); parent.append(title); const seek = el('input', 'aa-seek'); seek.type = 'range'; seek.min = '0'; seek.max = '60'; describe(seek, label); parent.append(seek);
    this.refreshNumbers.push(() => { title.textContent = label + ': ' + this.draft().size(key).toFixed(1); seek.value = String(Math.round(this.draft().size(key) * 10)); });
    seek.addEventListener('input', () => { this.draft().size(key, Number(seek.value) / 10); this.changed(); });
  }
  checkContrast() {
    const p = this.draft(); const bad = []; const bg = ThemePalette.over(p.color('calendar.cell'), p.color('calendar.background'));
    for (const pair of [['calendar.day', 'Số ngày'], ['calendar.weekend', 'Cuối tuần'], ['calendar.weekday', 'Thứ'], ['calendar.month', 'Tháng'], ['calendar.year', 'Năm']]) if (this.ratio(p.color(pair[0]), bg) < 4.5) bad.push(pair[1]);
    for (const code of this.codes) if (this.ratio(p.shift(code, true), ThemePalette.over(p.shift(code, false), bg)) < 4.5) bad.push(code);
    for (const pair of [['today.text', 'today.fill'], ['warning.text', 'warning.background'], ['button.addText', 'button.addBackground'], ['button.editText', 'button.editBackground'], ['pipe.text', 'pipe.block'], ['pipe.number', 'pipe.block']])
      if (this.ratio(p.color(pair[0]), pair[0].startsWith('pipe') ? ThemePalette.over(p.color('pipe.background'), ThemePalette.over(p.color(pair[1]), bg)) : ThemePalette.over(p.color(pair[1]), bg)) < 4.5) bad.push(pair[0].startsWith('pipe') ? 'Phân ống' : pair[0].startsWith('today') ? 'Hôm nay' : pair[0].startsWith('warning') ? 'Cảnh báo' : 'Nút bấm');
    this.contrast.textContent = bad.length === 0 ? '' : 'Màu có thể khó đọc: ' + [...new Set(bad)].join(', ') + '.'; ThemeUi.text(this.contrast, bad.length === 0 ? ThemeUi.MUTED : ThemeUi.WARNING);
  }
  ratio(text, bg) { return ThemePalette.contrast(ThemePalette.over(text, bg), bg); }
  apply() { try { this.settings.apply(this.light, this.dark, this.favorites); ThemeReceiver.schedule(this); CalendarWidget.refreshAppearance(this); Toast.makeText(this, 'Đã áp dụng và lưu hai bảng màu.', Toast.LENGTH_SHORT).show(); this.finish(); } catch (e) { this.error(e); } }
  error(e) { new ThemeUi.DialogBuilder(this).setTitle('Chưa thực hiện được').setMessage(e.message).setPositiveButton('Đóng', null).show(); }
  onSaveInstanceState(state) {
    super.onSaveInstanceState(state); if (this.light == null) return; state.putString('draftLight', this.light.json().toString()); state.putString('draftDark', this.dark.json().toString()); state.putBoolean('editingLight', this.editingLight); state.putBoolean('sample', this.sample);
    const a = new JSONArray(); for (const c of this.favorites) a.put(c); state.putString('favorites', a.toString()); state.putIntArray('expanded', [...this.expanded]);
  }
  /** Shared drawing for the live preview and the saved-set preview; both use the real calendar painter. */
  static paintCalendar(ctx, width, viewHeight, p, month, scene, today, selected, hover, pressed) {
    const scale = width / 340; ctx.save(); ctx.scale(scale, scale); const height = viewHeight / scale; const canvas = new Canvas2D(ctx); const paint = new TextPaint((font, s) => { ctx.font = font; return ctx.measureText(s).width; });
    paint.setColor(p.color('calendar.background')); canvas.drawRoundRect(0, 0, 340, height, 24, 24, paint); paint.setStyle(TextPaint.STROKE); paint.setStrokeWidth(1); paint.setColor(p.color('calendar.border')); canvas.drawRoundRect(0.5, 0.5, 339.5, height - 0.5, 24, 24, paint); paint.setStyle(TextPaint.FILL);
    paint.setTextSize(15); paint.setTypeface('sans-serif-medium'); paint.setColor(p.color('calendar.month')); canvas.drawText('Tháng ' + month.getMonthValue(), 14, 34, paint); paint.setTextSize(11); paint.setColor(p.color('calendar.year')); canvas.drawText(String(month.getYear()), 14, 56, paint);
    paint.setTextSize(28); paint.setColor(p.color('button.prev')); canvas.drawText('‹', 117, 36, paint); paint.setColor(p.color('button.next')); canvas.drawText('›', 157, 36, paint); paint.setColor(p.color('button.addBackground')); canvas.drawRoundRect(193, 12, 229, 50, 16, 16, paint); paint.setColor(p.color('button.addText')); canvas.drawText('+', 202, 38, paint); paint.setColor(p.color('button.editBackground')); canvas.drawRoundRect(237, 12, 327, 50, 16, 16, paint); paint.setColor(p.color('button.editText')); paint.setTextSize(12); canvas.drawText('Đổi mã ca', 250, 35, paint);
    ctx.translate(10, 64); CalendarPainter.draw(canvas, 320, height - 78, scene, p, today, selected, hover, pressed); ctx.restore();
  }
  /** Box 1: names the colors currently shown (both palettes) and stores them as a verified file. */
  saveThemeDialog() {
    const box = el('div', 'col dlg-box'); box.append(this.text('Tên bộ màu', 13, ThemeUi.MUTED));
    const name = editText({ hint: 'Ví dụ: Xanh dương yêu thích', maxLength: 60, description: 'Tên bộ màu', capWords: true }); name.classList.add('field--inner'); box.append(name);
    const problem = this.text('', 13, ThemeUi.DANGER); problem.hidden = true; box.append(problem);
    const dialog = new ThemeUi.DialogBuilder(this).setTitle('Lưu màu giao diện').setView(box).setNegativeButton('Quay lại', null).setPositiveButton('Xác nhận', null).create();
    dialog.show(); dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(() => this.storeTheme(dialog, name, problem, false));
  }
  storeTheme(dialog, name, problem, overwrite) {
    try { const saved = this.themes.save(name.value, this.light, this.dark, this.favorites, overwrite); dialog.dismiss(); Toast.makeText(this, 'Đã lưu bộ màu “' + saved.name + '” vào bộ nhớ ứng dụng.', Toast.LENGTH_LONG).show(); }
    catch (e) {
      if (e instanceof ColorThemeStore.DuplicateName) { new ThemeUi.DialogBuilder(this).setTitle('Ghi đè bộ màu?').setMessage(e.message + ' Thay bộ màu đó bằng màu hiện tại?').setNegativeButton('Quay lại', null).setPositiveButton('Ghi đè', () => this.storeTheme(dialog, name, problem, true)).show(); return; }
      problem.textContent = e?.message == null ? 'Chưa lưu được bộ màu.' : e.message; problem.hidden = false;
    }
  }
  /** Box 3: factory colors for the palette in use now (Auto follows the phone clock); saved sets stay. */
  resetDefaultsDialog() {
    const active = this.settings.activeLight(); const palette = active ? 'Sáng' : 'Tối'; const mode = this.settings.mode() === ThemeSettings.Mode.AUTO ? 'Auto, đang dùng bảng ' + palette + ' theo giờ điện thoại' : this.settings.mode().label();
    new ThemeUi.DialogBuilder(this).setTitle('Reset màu giao diện mặc định?').setMessage('Chế độ: ' + mode + '.\nKhôi phục màu mặc định của bảng ' + palette + ': nền, chữ, mã ca, thông tin phân ống, ngày hôm nay, ngày được chọn, đường kẻ, viền và nút.\n\nCác bộ màu đã lưu, lịch đi làm, lịch phân ống và lịch sử đổi ca được giữ nguyên.')
      .setNegativeButton('Quay lại', null).setPositiveButton('Reset màu', () => {
        try {
          this.settings.resetPalette(active); if (active) this.light = this.settings.palette(true); else this.dark = this.settings.palette(false); this.editingLight = active;
          this.groups(); this.refreshTheme(); this.changed(); ThemeReceiver.schedule(this); CalendarWidget.refreshAppearance(this); Toast.makeText(this, 'Đã khôi phục màu mặc định bảng ' + palette + '.', Toast.LENGTH_LONG).show();
        } catch (e) { this.error(e); }
      }).show();
  }
  sampleScene() {
    const count = this.month.lengthOfMonth(); const shifts = new Array(count), pipes = new Array(count), duties = new Array(count), people = new Array(count).fill(null);
    for (let i = 0; i < count; i++) { shifts[i] = ['S10', 'D5', 'C23', 'S26', ''][i % 5]; pipes[i] = shifts[i] === '' ? '' : String(15 + i % 8); duties[i] = shifts[i] === 'D5' ? (i % 2 === 0 ? 'HC' : 'TC1') : ''; }
    people[14] = 'Nguyễn Thành Luân'; const demo = new Schedule(Schedule.COMBINED, this.month, 0, 'Mẫu màu', shifts, people, new Array(count).fill(0), pipes, duties); demo.issues[17] = new CalendarIssue('Khác Ca', 'Mẫu xem trước'); demo.pipes[20] = null;
    return new CalendarPainter.Scene(this.month, demo, null, null);
  }
  onPaletteChanged() { if (this.preview != null) this.preview.invalidate(); }
  onDestroy() { super.onDestroy(); for (const c of this._canvases) c.release(); this._canvases = []; }
}

/** The live preview: the real calendar with the draft palette; a tap selects a day, a mouse hovers. */
class Preview {
  constructor(a) {
    this.a = a; this.selected = new ThemeSettings(a).selected(); this.hover = null; this.pressed = 0;
    this.canvas = a.canvas(285, (ctx, w, h) => { const today = a.sample ? a.month.atDay(Math.min(20, a.month.lengthOfMonth())) : LocalDate.now(); AppearanceActivity.paintCalendar(ctx, w, h, a.draft(), a.month, a.sample ? a.sampleScene() : a.realScene, today, this.selected, this.hover, this.pressed); });
    this.view = this.canvas.view; this.view.classList.add('aa-preview'); this.view.setAttribute('role', 'img');
    const hit = e => { const r = this.view.getBoundingClientRect(); const scale = r.width / 340; return CalendarPainter.hit((e.clientX - r.left) / scale - 10, (e.clientY - r.top) / scale - 64, 320, r.height / scale - 78, a.sample ? a.sampleScene() : a.realScene); };
    this.view.addEventListener('pointerdown', e => { const date = hit(e); if (date == null) return; this.selected = date; this.pressed = 1; this.invalidate(); });
    for (const type of ['pointerup', 'pointercancel']) this.view.addEventListener(type, () => { if (this.pressed !== 0) { this.pressed = 0; this.invalidate(); } });
    this.view.addEventListener('pointermove', e => { if (e.pointerType !== 'mouse') return; const date = hit(e); if ((date == null) !== (this.hover == null) || (date != null && !date.equals(this.hover))) { this.hover = date; this.invalidate(); } });
    this.view.addEventListener('pointerleave', () => { if (this.hover != null) { this.hover = null; this.invalidate(); } });
  }
  invalidate() { this.canvas.invalidate(); }
}

/** Box 2: lists the files actually stored, previews one set, and applies, renames or deletes it. */
class SavedThemes {
  constructor(a) { this.a = a; this.items = []; this.chosen = null; this.viewLight = a.settings.activeLight(); this.dialog = null; this.names = null; this.preview = null; this.info = null; this.lightView = null; this.darkView = null; }
  show() {
    const a = this.a; this.items = [...a.themes.list()]; this.chosen = null; this.dialog = null;
    if (this.items.length === 0) { new ThemeUi.DialogBuilder(a).setTitle('Tải màu giao diện đã lưu').setMessage('Chưa có giao diện màu được lưu' + (a.themes.unreadable() > 0 ? '\n\nCó ' + a.themes.unreadable() + ' tệp bộ màu không đọc được nên không hiển thị.' : '')).setPositiveButton('Đóng', null).show(); return; }
    const box = el('div', 'col dlg-box');
    const scroll = el('div', 'aa-themes'); this.names = el('div', 'col'); this.names.setAttribute('role', 'radiogroup'); scroll.append(this.names); scroll.style.maxHeight = (Math.min(4, this.items.length) * 46 + 4) + 'px'; box.append(scroll);
    this.preview = a.canvas(200, (ctx, w, h) => {
      const p = this.palette();
      if (p != null) AppearanceActivity.paintCalendar(ctx, w, h, p, a.month, a.realScene, LocalDate.now(), null, null, 0);
      else { ctx.fillStyle = cssColor(ThemeUi.color(a, 'app.muted')); ctx.font = '13px ' + getComputedStyle(this.preview.view).fontFamily; ctx.textAlign = 'center'; ctx.fillText('Chưa chọn bộ màu', w / 2, h / 2); }
    });
    describe(this.preview.view, 'Xem trước bộ màu đã chọn'); this.preview.view.setAttribute('role', 'img'); box.append(this.preview.view);
    const toggles = el('div', 'row aa-tabs'); this.lightView = a.button('Xem bảng Sáng', () => { this.viewLight = true; this.refresh(); }); this.darkView = a.button('Xem bảng Tối', () => { this.viewLight = false; this.refresh(); });
    for (const b of [this.lightView, this.darkView]) b.classList.add('aa-small'); toggles.append(this.lightView, this.darkView); box.append(toggles);
    this.info = a.text('', 12, ThemeUi.MUTED); box.append(this.info); this.fill();
    this.dialog = new ThemeUi.DialogBuilder(a).setTitle('Tải màu giao diện đã lưu').setView(box).setNegativeButton('Quay lại', null).setNeutralButton('Đổi tên / Xóa', null).setPositiveButton('Áp dụng', null).create();
    this.dialog.setOnDismissListener(() => this.preview.release());
    this.dialog.show(); this.dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(() => this.apply()); this.dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(() => this.manage()); this.refresh();
  }
  palette() { return this.chosen == null ? null : this.viewLight ? this.chosen.light : this.chosen.dark; }
  fill() {
    this.names.replaceChildren(); const group = 'aa-theme-' + Math.random().toString(36).slice(2);
    for (const t of this.items) {
      const r = el('label', 'check aa-theme'); const input = el('input'); input.type = 'radio'; input.name = group; input.checked = this.chosen != null && this.chosen.id === t.id;
      const label = el('span', null, t.name + (t.light != null && t.dark != null ? '' : ' · ' + t.scope())); label.style.fontSize = '15px'; ThemeUi.text(label, ThemeUi.TEXT); r.append(input, label); this.names.append(r);
      input.addEventListener('change', () => { if (!input.checked) return; this.chosen = t; if (this.chosen != null && (this.viewLight ? this.chosen.light : this.chosen.dark) == null) this.viewLight = !this.viewLight; this.refresh(); });
    }
  }
  refresh() {
    if (this.dialog == null) return; this.dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(this.chosen != null); this.dialog.getButton(AlertDialog.BUTTON_NEUTRAL).setEnabled(this.chosen != null);
    this.lightView.disabled = !(this.chosen == null || this.chosen.light != null); this.darkView.disabled = !(this.chosen == null || this.chosen.dark != null); this.lightView.textContent = (this.viewLight ? '✓ ' : '') + 'Xem bảng Sáng'; this.darkView.textContent = (this.viewLight ? '' : '✓ ') + 'Xem bảng Tối';
    this.info.textContent = this.chosen == null ? 'Đã lưu ' + this.items.length + ' bộ màu.' : 'Lưu lúc ' + DateTimeFormatter.ofPattern('dd/MM/yyyy HH:mm').format(Instant.ofEpochMilli(this.chosen.updated).atZone(ZoneId.systemDefault())) + ' · Gồm ' + this.chosen.scope() + (this.chosen.light != null && this.chosen.dark != null ? '' : '; bảng còn lại giữ nguyên khi áp dụng') + '.';
    this.preview.invalidate();
  }
  apply() {
    const a = this.a; if (this.chosen == null) return;
    try {
      const l = this.chosen.light != null ? this.chosen.light.copy() : a.settings.palette(true), d = this.chosen.dark != null ? this.chosen.dark.copy() : a.settings.palette(false);
      a.settings.apply(l, d, this.chosen.favorites != null ? [...this.chosen.favorites] : a.settings.favorites());
      a.light = a.settings.palette(true); a.dark = a.settings.palette(false); a.favorites = a.settings.favorites(); a.addCodes([...a.light.shifts.keys(), ...a.dark.shifts.keys()]); a.editingLight = a.settings.activeLight();
      a.groups(); a.refreshTheme(); a.changed(); ThemeReceiver.schedule(a); CalendarWidget.refreshAppearance(a); this.dialog.dismiss();
      Toast.makeText(a, 'Đã áp dụng bộ màu “' + this.chosen.name + '”.', Toast.LENGTH_LONG).show();
    } catch (e) { a.error(e); }
  }
  manage() {
    const a = this.a; const t = this.chosen; if (t == null) return;
    new ThemeUi.DialogBuilder(a).setTitle(t.name).setItems(['Đổi tên', 'Xóa bộ màu'], (d, which) => {
      if (which === 0) this.rename(t);
      else new ThemeUi.DialogBuilder(a).setTitle('Xóa bộ màu “' + t.name + '”?').setMessage('Chỉ xóa bộ màu đã lưu này. Màu đang dùng, lịch và mã ca được giữ nguyên.').setNegativeButton('Quay lại', null).setPositiveButton('Xóa', () => { try { a.themes.delete(t.id); this.reload(null); Toast.makeText(a, 'Đã xóa bộ màu “' + t.name + '”.', Toast.LENGTH_SHORT).show(); } catch (e) { a.error(e); } }).show();
    }).setNegativeButton('Quay lại', null).show();
  }
  rename(t) {
    const a = this.a; const box = el('div', 'col dlg-box'); const name = editText({ value: t.name, maxLength: 60, description: 'Tên bộ màu', capWords: true }); name.classList.add('field--inner'); box.append(name); const problem = a.text('', 13, ThemeUi.DANGER); problem.hidden = true; box.append(problem);
    const rename = new ThemeUi.DialogBuilder(a).setTitle('Đổi tên bộ màu').setView(box).setNegativeButton('Quay lại', null).setPositiveButton('Xác nhận', null).create(); rename.show();
    rename.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(() => { try { const renamed = a.themes.rename(t.id, name.value); rename.dismiss(); this.reload(renamed.id); } catch (e) { problem.textContent = e.message; problem.hidden = false; } });
  }
  reload(select) {
    this.items = [...this.a.themes.list()]; this.chosen = null; if (select != null) for (const t of this.items) if (t.id === select) this.chosen = t;
    if (this.items.length === 0) { this.dialog.dismiss(); this.show(); return; } this.fill(); this.refresh();
  }
}
