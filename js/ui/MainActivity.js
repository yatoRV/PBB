// Port of vn.lichdilam.MainActivity (APK 4.5): the main screen (calendar, import, review/editor, repairs,
// settings, saved pipe data, history, error ledger, reset). Same pages, texts, dialogs and flows; docs/UI-MAP-
// MainActivity.md lists every one with its Java line. Web adaptations (each marked where it happens):
//  - views are DOM elements (js/ui/Views.js), the calendar is a <canvas> drawn by CalendarPainter;
//  - the system image picker (ACTION_OPEN_DOCUMENT, request 100) is an <input type=file accept="image/*">;
//  - OCR and image work run in Executors.newSingleThreadExecutor() jobs as in Java ("Hủy" → readJob.cancel(true),
//    leaving the screen → shutdownNow()); every result checks the job token;
//  - launcher widgets (CalendarWidget, pinWidget, AppWidgetManager) do not exist on the web: their calls are
//    no-ops and the "Đưa lịch ra màn hình chính" button is not shown (spec ruling: widgets omitted);
//  - one extra control decided by the user: "Đăng xuất" with the signed-in Google email, next to Reset / Giao diện;
//  - resumable reading (user request, Task A2): a read is a job (js/jobs/read-jobs.js) whose OCR calls are
//    checkpointed; "Thêm ảnh lịch đi làm / phân ống" first offers a job that is unfinished (continue) or done
//    (its review table), the home screen shows a small note for it, and a progress bar shows the percent.
//    Nothing reaches the calendar before the review table is confirmed, as in the APK.
import { IllegalArgumentException, IllegalStateException, RuntimeException, IOException, Integer, Executors, matches, format, utf8Decode } from '../platform/java.js';
import { YearMonth, LocalDate, Instant, ZoneId, DateTimeFormatter } from '../platform/time.js';
import { File, FileOutputStream, FileInputStream } from '../platform/files.js';
import { Bitmap, BitmapFactory, ExifInterface, Matrix, CompressFormat } from '../platform/bitmap.js';
import { Intent, BuildConfig, Uri } from '../platform/android.js';
import { AlertDialog, Toast } from '../platform/widget.js';
import { AppLog } from '../core/AppLog.js';
import { AppDataReset } from '../core/AppDataReset.js';
import { Schedule } from '../core/Schedule.js';
import { ScheduleStore } from '../core/ScheduleStore.js';
import { UiDraftCodec } from '../core/UiDraftCodec.js';
import { RosterReader } from '../core/RosterReader.js';
import { PipeRosterReader } from '../core/PipeRosterReader.js';
import { PipeSourceCache } from '../core/PipeSourceCache.js';
import { PipeBook } from '../core/PipeBook.js';
import { PipeDay } from '../core/PipeDay.js';
import { PipeRules } from '../core/PipeRules.js';
import { PipeFieldVotes } from '../core/PipeFieldVotes.js';
import { GridVision } from '../core/GridVision.js';
import { StaffDirectory } from '../core/StaffDirectory.js';
import { OwnerProfile } from '../core/OwnerProfile.js';
import { ThemeSettings } from '../core/ThemeSettings.js';
import { ErrorLedger } from '../core/ErrorLedger.js';
import { OpenColumns } from '../core/OpenColumns.js';
import { ConfirmedNames } from '../core/ConfirmedNames.js';
import { ManualDayEdit } from '../core/ManualDayEdit.js';
import { ShiftChange } from '../core/ShiftChange.js';
import { HelpText } from '../core/HelpText.js';
import { ReminderEngine } from '../core/ReminderEngine.js';
import { ThemedActivity } from './ThemedActivity.js';
import { ThemeUi } from './ThemeUi.js';
import { ThemeReceiver } from './ThemeReceiver.js';
import { UiResume } from './UiResume.js';
import { CalendarPainter, Canvas2D } from './CalendarPainter.js';
import { DateChangeRow } from './DateChangeRow.js';
import { DayColumnDialog } from './DayColumnDialog.js';
import { el, textView, linear, gapView, describe, buttonView, editText, setError, spinner, checkBox, imageView, fileExists } from './Views.js';
import { InterruptedException } from '../platform/java.js';
import { ReadJobs, WORK, PIPE } from '../jobs/read-jobs.js';
import { ReadProgress, etaText } from '../jobs/read-progress.js';
import { ReadProgressBar } from './ReadProgressBar.js';
import { runJob, staffFingerprint, workResultRecord, workResultFrom } from './ReadJobUi.js';
import { warmUpReading } from '../ocr/warm-up.js';

const BG = ThemeUi.BG, PANEL = ThemeUi.PANEL, TEXT = ThemeUi.TEXT, MUTED = ThemeUi.MUTED, ACCENT = ThemeUi.ACCENT; // eslint-disable-line no-unused-vars
const OPEN_DOCUMENT = 'android.intent.action.OPEN_DOCUMENT';
const isIAE = e => e instanceof IllegalArgumentException;
const isIAEorISE = e => e instanceof IllegalArgumentException || e instanceof IllegalStateException;
/** Lets the browser paint the page just shown before a job's synchronous image work starts (no UI thread split). */
const nextFrame = () => new Promise(resolve => { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0)); else setTimeout(resolve, 0); });
/** Calendar widget calls of the APK: no launcher widget on the web (spec ruling). */
const CalendarWidget = Object.freeze({ refresh() {}, refreshAppearance() {}, clearForReset() {} });

export class MainActivity extends ThemedActivity {
  constructor() {
    super();
    this.worker = Executors.newSingleThreadExecutor();
    this.store = null; this.month = null; this.content = null; this.imported = null; this.corners = null;
    this.numberInput = null; this.nameInput = null; this.monthInput = null; this.yearInput = null; this.progress = null; this.readButton = null;
    this.busy = false; this.inImport = false; this.resetting = false; this.result = null; this.identityConfirmed = false; this.editingSaved = false;
    this.changeRows = []; this.changeList = null; this.pendingBook = null; this.importBaseline = null; this.calendarView = null;
    this.modeButton = null; this.modeStatus = null; this.directChanges = new Map(); this.resumePage41 = 'home'; this.job = 0; this.readJob = null;
    this._picker = null;
    /** Web (Task A2): the job whose result the review shows, the job being read, the home note closed this session. */
    this.shownJob = null; this.runningJob = null; this._jobNoteClosed = false;
  }
  uiBusy() { return this.busy; }
  async onCreate(state) {
    const cold = state == null, frameworkState = state != null;
    if (state == null && !this.getIntent().hasExtra('month')) state = UiResume.restoreBundle(this);
    super.onCreate(state); this.store = new ScheduleStore(this); this.month = this.store.lastCombinedMonth();
    if (state != null) try { this.month = YearMonth.parse(state.getString('month')); } catch (ignored) { /* keep */ }
    this.handleIntent(this.getIntent());
    if (state != null && (frameworkState || (Intent.ACTION_MAIN === this.getIntent().getAction() && !this.getIntent().hasExtra('month')))) await this.restorePage41(state);
    if (cold) UiResume.openLast(this);
  }
  onSaveInstanceState(state) {
    super.onSaveInstanceState(state); if (this.month == null) return; state.putString('month', this.month.toString()); state.putString('page41', this.resumePage41);
    try {
      if ((this.resumePage41 === 'editor' || this.resumePage41 === 'review') && this.result != null) {
        state.putString('draft41', UiDraftCodec.schedule(this.result.schedule)); state.putString('changes41', UiDraftCodec.changes([...this.directChanges.values()])); state.putInt('rowCount41', this.changeRows.length); state.putBoolean('editing41', this.editingSaved); state.putBoolean('identity41', this.identityConfirmed);
        state.putString('readName41', this.result.readName); state.putString('readNumber41', this.result.readNumber); state.putStringArray('raw41', this.result.raw);
        if (this.result.staff != null) state.putString('staff41', this.result.staff.toJson()); if (this.importBaseline != null) state.putString('baseline41', UiDraftCodec.schedule(this.importBaseline)); if (this.pendingBook != null) state.putString('book41', this.pendingBook.toJson());
        if (this.shownJob != null) state.putString('readJob41', this.shownJob); // web: the job the review confirms
      }
    } catch (e) { AppLog.failure('ui.resume.mainDraft', e); }
  }
  allowResumeSave() { return !this.resetting; }
  resumeScope() { return 'main:' + this.month + ':' + this.resumePage41; }
  async restorePage41(b) {
    try {
      const page = b.getString('page41', 'home');
      if ((page === 'editor' || page === 'review') && b.containsKey('draft41')) {
        this.result = new RosterReader.Result(); this.result.schedule = UiDraftCodec.schedule(b.getString('draft41')); this.month = this.result.schedule.month; this.editingSaved = b.getBoolean('editing41'); this.identityConfirmed = b.getBoolean('identity41');
        this.store = new ScheduleStore(this, this.result.schedule.kind === Schedule.PIPE ? Schedule.PIPE : Schedule.WORK); this.result.readName = b.getString('readName41', ''); this.result.readNumber = b.getString('readNumber41', ''); this.result.raw = b.getStringArray('raw41'); this.result.cells = new Array(this.month.lengthOfMonth()).fill(null);
        if (b.containsKey('staff41')) this.result.staff = StaffDirectory.fromJson(b.getString('staff41')); if (b.containsKey('baseline41')) this.importBaseline = UiDraftCodec.schedule(b.getString('baseline41')); if (b.containsKey('book41')) this.pendingBook = PipeBook.fromJson(b.getString('book41'));
        this.result.identityImage = await BitmapFactory.decodeFile(new File(this.getFilesDir(), 'ui-identity41.png').toString());
        if (!this.editingSaved && this.result.schedule.kind === Schedule.WORK) { const source = new File(this.getFilesDir(), 'work-import41.image'); if (source.isFile()) try { this.imported = await this.decodeWorkImage41(source); this.corners = GridVision.corners(this.imported); } catch (e) { AppLog.failure('ui.resume.workPhoto', e); } }
        this.shownJob = b.containsKey('readJob41') ? b.getString('readJob41') : null;
        this.directChanges.clear(); for (const c of UiDraftCodec.changes(b.getString('changes41', '[]'))) this.directChanges.set(c.date.toString(), c);
        this.showReview(); while (this.changeRows.length < b.getInt('rowCount41', 1)) this.addChangeRow(false);
      } else if (page === 'import' && new File(this.getFilesDir(), 'work-import41.image').isFile()) {
        this.imported = await this.decodeWorkImage41(new File(this.getFilesDir(), 'work-import41.image')); this.corners = GridVision.corners(this.imported); this.showImport();
      } else if (page === 'repairs') this.showManualRepairs(); else if (page === 'settings') this.showSettings(); else if (page === 'history') this.showHistory(); else if (page === 'source') this.showSourceBook(); else if (page === 'ledger') this.showLedger();
    } catch (e) { AppLog.failure('ui.resume.main', e); this.showHome(); }
  }

  onResume() {
    super.onResume(); if (this.calendarView != null) this.calendarView.invalidate();
    // ReminderEngine.reschedule (the in-page reminder runner) is added by Task 13.
    if (!this.resetting && typeof ReminderEngine.reschedule === 'function') ReminderEngine.reschedule(this);
  }
  onNewIntent(intent) { this.setIntent(intent); this.handleIntent(intent); }
  handleIntent(i) {
    if (this.resetting) return; this.store = new ScheduleStore(this); if (this.month == null) this.month = this.store.lastCombinedMonth(); try { if (i.hasExtra('month')) this.month = YearMonth.parse(i.getStringExtra('month')); } catch (ignored) { /* keep */ }
    this.showHome(); if (i.getAction() === 'vn.lichdilam.ADD') this.chooseImage(); else if (i.getAction() === 'vn.lichdilam.EDIT') this.openShiftEditor();
  }
  base() {
    // Web: the replaced page's calendar canvas is released at once (iPhone memory); a new page draws its own.
    if (this.calendarView != null) { this.calendarView.release(); this.calendarView = null; }
    const root = linear(false, 'main'); const scroll = el('div', 'scroll');
    this.content = el('div', 'page'); scroll.append(this.content); root.append(scroll);
    if (document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement)) document.activeElement.blur(); // content.requestFocus(): no keyboard
    this.setContentView(root);
  }
  text(s, sp, color) { return textView(s, sp, color); }
  gap(h) { this.content.append(gapView(h)); }
  heading(eyebrow, title, desc) { // eslint-disable-line no-unused-vars
    const e = this.text(eyebrow, 11, ACCENT); e.classList.add('eyebrow'); this.content.append(e); this.gap(8);
    const t = el('h1', 'title', title); this.content.append(t); this.gap(16);
  }
  button(label, primary, action) {
    const b = buttonView(label, primary);
    b.addEventListener('click', () => { AppLog.event('user.action', AppLog.data('screen', this.constructor.name, 'action', b.textContent)); action(); });
    return b;
  }
  addButton(label, primary, action) { const b = this.button(label, primary, action); b.classList.add('btn--block'); this.content.append(b); return b; }

  // ---------------------------------------------------------------- home
  showHome() {
    this.resumePage41 = 'home';
    this.inImport = false; this.pendingBook = null; this.directChanges.clear(); this.changeRows = []; this.store = new ScheduleStore(this); this.base();
    // Web (iPhone memory): the decoded work photo (up to 3600×5000 RGBA) is only used by the import form and its read;
    // every way back to that form decodes it again (onActivityResult 100, or restorePage41 from the stored file).
    this.imported = null; this.corners = null; this.shownJob = null;
    const top = linear(true, 'home-top');
    const logo = el('img', 'home-top__logo'); logo.src = 'assets/icons/icon-120.webp'; logo.alt = 'Lịch A380'; describe(logo, 'Lịch A380'); top.append(logo);
    const eyebrow = this.text('LỊCH CÁ NHÂN', 11, ACCENT); eyebrow.classList.add('eyebrow', 'grow'); top.append(eyebrow);
    const notifications = this.button('Chuông\nthông báo', false, () => this.startActivity(new Intent(this, 'ReminderActivity'))); notifications.classList.add('btn--bell'); describe(notifications, 'Chuông thông báo — cài đặt nhắc mã ca');
    notifications.prepend(bellIcon()); top.append(notifications);
    const reset = this.button('Reset', false, () => this.confirmReset()); reset.classList.add('btn--small', 'btn--outlined'); describe(reset, 'Reset ứng dụng — mở hộp xác nhận'); top.append(reset); this.content.append(top);
    this.gap(10); const appearance = linear(true, 'home-row');
    const look = this.button('Giao diện', false, () => this.startActivity(new Intent(this, 'AppearanceActivity').putExtra('month', this.month.toString()))); look.classList.add('grow', 'btn--row'); appearance.append(look);
    this.modeButton = this.button('', false, () => { const settings = new ThemeSettings(this); settings.mode(settings.mode().next()); this.refreshTheme(); this.updateMode(); ThemeReceiver.schedule(this); CalendarWidget.refreshAppearance(this); });
    this.modeButton.classList.add('btn--mode', 'btn--row'); appearance.append(this.modeButton); this.content.append(appearance);
    // Web-only (user decision): the signed-in Google account and "Đăng xuất", beside Log.
    const logRow = linear(true, 'home-row home-row--end');
    const email = this._shell?.profile?.()?.email ?? '';
    if (email !== '' || this._shell?.signOut) { const account = this.text(email, 12, MUTED); account.classList.add('grow', 'ellipsis', 'home-account'); logRow.append(account); const out = this.button('Đăng xuất', false, () => this.confirmSignOut(email)); out.classList.add('btn--row', 'btn--signout'); describe(out, 'Đăng xuất' + (email === '' ? '' : ' — ' + email)); logRow.append(out); }
    const logButton = this.button('Log', false, () => this.startActivity(new Intent(this, 'LogActivity'))); describe(logButton, 'Log — xem và xuất toàn bộ phiên hoạt động'); logButton.classList.add('btn--mode', 'btn--row'); logRow.append(logButton); this.content.append(logRow);
    this.gap(5); this.modeStatus = this.text('', 11, MUTED); this.content.append(this.modeStatus); this.updateMode();
    this.gap(8); const title = el('h1', 'title', 'Lịch đi làm'); this.content.append(title); this.gap(8); this.gap(24);
    this.jobNote();
    this.calendarCard(this.month, null);
    const s = this.store.loadCombined(this.month); this.gap(18);
    if (s != null) {
      let conflicts = 0; for (const issue of s.issues) if (issue != null) conflicts++;
      if (conflicts > 0) { this.content.append(this.text(conflicts + ' ngày cần đối chiếu.', 13, ThemeUi.WARNING)); this.gap(12); }
    }
    const savedBook = this.store.pipeBook(this.month);
    if (savedBook != null && savedBook.openColumns().length !== 0) {
      const open = savedBook.openColumns().length;
      this.content.append(this.text('Còn ' + open + ' cột chưa xác định ngày.', 13, ThemeUi.WARNING)); this.gap(8);
      this.addButton('Xác định cột ngày còn thiếu (' + open + ')', false, () => this.chooseOpenColumn(savedBook, this.firstOpen(savedBook), true, null)); this.gap(12);
    }
    if (this.store.conflictingOwners(this.month)) { this.content.append(this.text('Hai nguồn lịch khác tên.', 13, ThemeUi.WARNING)); this.gap(12); }
    if (s == null) { this.content.append(this.text('Bắt đầu từ ảnh bảng lịch', 19, TEXT)); this.gap(6); this.gap(20); this.addButton('+  Thêm ảnh lịch', true, () => this.chooseImage()); }
    else {
      const stats = linear(true, 'stats');
      stats.append(this.stat(String(s.workDays()), 'ngày có mã ca'));
      const leave = s.leaveDays(); stats.append(this.stat(String(s.offDays()), leave > 0 ? 'ngày OFF · gồm ' + leave + ' ngày P' : 'ngày OFF')); this.content.append(stats);
      // "Đưa lịch ra màn hình chính" (pinWidget) is not shown: no launcher widget on the web (spec ruling).
      this.gap(20); this.gap(8);
    }
    this.gap(12); this.addButton('Ngày đổi mã ca', true, () => this.openShiftEditor());
    this.gap(10); this.addButton('Sửa “?” và “Khác Ca”', false, () => this.showManualRepairs());
    this.gap(10); this.addButton('Lịch phân ống', false, () => this.startActivity(new Intent(this, 'PipeTableActivity').putExtra('month', this.month.toString())));
    this.gap(10); this.addButton('Thêm / thay ảnh lịch đi làm', false, () => this.chooseWorkImage()); this.gap(10); this.addButton('Thêm / thay ảnh phân ống', false, () => this.choosePipeImage());
    if (this.store.pipeBook(this.month) != null) { this.gap(10); this.addButton('Cập nhật OCR từ ảnh đã lưu', false, () => this.refreshSavedPipe()); this.gap(10); this.addButton('Kiểm tra tên trong ảnh phân ống', false, () => this.editPrintedNames(this.store.pipeBook(this.month), true)); }
    this.gap(20); this.gap(8);
    this.gap(6);
    this.gap(10); this.addButton('Lịch sử đổi ca', false, () => this.showHistory()); this.gap(10); this.addButton('Cài đặt', false, () => this.showSettings());
  }
  updateMode() {
    if (this.modeButton == null || this.modeStatus == null) return; const mode = new ThemeSettings(this).mode(); this.modeButton.textContent = mode.next().label(); describe(this.modeButton, 'Chuyển sang ' + mode.next().label());
    this.modeStatus.textContent = 'Đang dùng: ' + mode.label() + (mode === ThemeSettings.Mode.AUTO ? ' · ' + (this.palette().light ? 'Sáng' : 'Tối') + ' (06:00–18:00)' : '');
  }
  onPaletteChanged() { this.updateMode(); if (this.calendarView != null) this.calendarView.invalidate(); }
  stat(value, label) { const l = linear(false, 'stat'); const t = this.text(value, 25, ACCENT); t.classList.add('bold'); l.append(t, this.text(label, 12, MUTED)); return l; }
  /** Web-only (user decision): confirm, then sign out of Google (js/main.js signOut). */
  confirmSignOut(email) {
    new ThemeUi.DialogBuilder(this).setTitle('Đăng xuất?').setMessage((email === '' ? 'Đăng xuất tài khoản Google này?' : 'Đăng xuất tài khoản ' + email + '?') + '\n\nDữ liệu đã lưu trên Google Drive được giữ nguyên. Đăng nhập lại để dùng tiếp.')
      .setNegativeButton('Hủy', null).setPositiveButton('Đăng xuất', () => {
        if (this.busy) { this.error('Đang xử lý', 'Chờ tác vụ hiện tại hoàn tất rồi Đăng xuất.'); return; }
        Promise.resolve().then(() => this._shell.signOut()).catch(e => { AppLog.failure('ui.signOut', e); this.error('Chưa đăng xuất', e?.message === 'unsynced' ? 'Còn thay đổi chưa lưu lên Google Drive. Kiểm tra kết nối mạng rồi thử lại.' : 'Đăng xuất không thành công. Vui lòng thử lại.'); });
      }).show();
  }
  calendarCard(m, draft) {
    const displayed = this.store.combinedPreview(m, draft);
    const scene = new CalendarPainter.Scene(m, this.store, draft);
    AppLog.calendar(draft == null ? 'MainActivity.home' : 'MainActivity.preview', scene);
    const panel = linear(false, 'calendar-card');
    const bar = linear(true, 'calendar-card__bar');
    const label = this.text('Tháng ' + m.getMonthValue(), 15, 'calendar.month'); label.classList.add('bold', 'calendar-card__month'); describe(label, 'Tháng ' + m.getMonthValue() + ' năm ' + m.getYear()); bar.append(label);
    if (draft == null) {
      bar.append(this.icon('‹', 'Tháng trước', () => { this.month = this.month.minusMonths(1); this.showHome(); }));
      bar.append(this.icon('›', 'Tháng sau', () => { this.month = this.month.plusMonths(1); this.showHome(); }));
      const add = this.icon('+', 'Thêm ảnh lịch', () => this.chooseImage()); add.classList.add('calendar-card__add'); bar.append(add);
      const edit = el('button', 'calendar-card__edit', 'Đổi mã ca'); edit.type = 'button'; describe(edit, 'Đổi mã ca cho nhiều ngày'); edit.addEventListener('click', () => this.openShiftEditor()); bar.append(edit);
    }
    const actions = el('div', 'calendar-card__actions'); actions.append(bar); panel.append(actions);
    const year = this.text(String(m.getYear()), 11, 'calendar.year'); year.classList.add('calendar-card__year'); panel.append(year);
    if (this.calendarView != null) this.calendarView.release();
    const view = this.calendarView = new CalendarView(this, m, scene, draft, displayed);
    let description = 'Lịch tháng ' + m.getMonthValue() + ' năm ' + m.getYear(); const descriptionSchedule = displayed;
    if (descriptionSchedule != null) for (let day = 0; day < descriptionSchedule.shifts.length; day++) description += '. Ngày ' + (day + 1) + ': ' + descriptionSchedule.dayLabel(day);
    describe(view.canvas, description); panel.append(view.wrap);
    if (draft == null && displayed == null) { const empty = this.text('Chưa có lịch tháng này', 12, MUTED); empty.classList.add('center', 'calendar-card__empty'); panel.append(empty); }
    this.content.append(panel);
  }
  /** Calendar tap (ACTION_UP) on a day of a saved month: select it and open that day in the editor (AUTO). */
  _calendarTap(m, displayed, x, y, w, h) {
    const rows = Math.trunc((Schedule.mondayOffset(m) + m.lengthOfMonth() + 6) / 7);
    const scale = Math.min(Math.fround(w / 340), Math.fround(h / Math.fround(27 + rows * (displayed.kind !== Schedule.WORK ? 67 : 46)))), head = Math.fround(27 * scale);
    if (y < head) return;
    const column = Math.min(6, Math.trunc(x / (w / 7))), row = Math.trunc((y - head) / ((h - head) / rows));
    const day = row * 7 + column - Schedule.mondayOffset(m);
    if (day >= 0 && day < m.lengthOfMonth()) { AppLog.event('user.calendarCell', AppLog.data('date', m.atDay(day + 1).toString(), 'display', displayed.dayLabel(day), 'complete', displayed.dayComplete(day))); new ThemeSettings(this).selected(m.atDay(day + 1)); CalendarWidget.refreshAppearance(this); this.openShiftEditor(); this.editDay(day, true); }
  }
  icon(s, desc, action) {
    const t = el('button', 'icon-btn', s); t.type = 'button'; if (s === '‹' || s === '›') ThemeUi.text(t, s === '‹' ? 'button.prev' : 'button.next'); else ThemeUi.text(t, MUTED); describe(t, desc);
    t.addEventListener('click', () => { AppLog.event('user.action', AppLog.data('screen', 'MainActivity', 'action', desc)); action(); }); return t;
  }

  // ---------------------------------------------------------------- images
  chooseImage() { if (this.busy) return; warmUpReading(this, null); new ThemeUi.DialogBuilder(this).setTitle('Thêm ảnh vào lịch chung').setItems(['Ảnh lịch đi làm', 'Ảnh phân ống (tối đa 3)'], (d, index) => { if (index === 0) this.chooseWorkImage(); else this.choosePipeImage(); }).show(); }
  chooseWorkImage() { if (this.busy) return; warmUpReading(this, 'work'); this.store = new ScheduleStore(this); if (this.offerJob(WORK)) return; this.pickWorkImage(); }
  pickWorkImage() { this.store = new ScheduleStore(this); const intent = new Intent(OPEN_DOCUMENT).putExtra('type', 'image/*'); this.startActivityForResult(intent, 100); }
  choosePipeImage() { if (this.busy) return; const saved = new ScheduleStore(this); if (saved.load(YearMonth.now()) == null && saved.load(this.month) == null) { this.error('Bước 1 · Thêm lịch đi làm', 'Hãy thêm và lưu lịch đi làm trước. Sau đó thêm tối đa 3 ảnh phân ống cùng tháng để ghép.'); return; } warmUpReading(this, 'pipe'); if (this.offerJob(PIPE)) return; this.openPipeImport(null); }
  openPipeImport(jobId) { this.store = new ScheduleStore(this, Schedule.PIPE); const intent = new Intent(this, 'PipeImportActivity'); if (jobId != null) intent.putExtra('readJob', jobId); this.startActivityForResult(intent, 200); }

  // ---------------------------------------------------------------- reading jobs (web, Task A2)
  /** "Thêm ảnh…": a job of that reader that is done opens its review table; an unfinished one is never restarted
   *  silently — the user chooses "Đọc tiếp" or "Chọn ảnh khác" (a read that crashed the page, e.g. iOS closing the
   *  tab, can always be left this way). Not the job whose review is on screen ("Chọn ảnh khác"). */
  offerJob(type) {
    const jobs = new ReadJobs(this); const r = jobs.pending(type);
    if (r == null || r.id === this.shownJob) return false;
    if (r.state === 'done') { this.openJob(r); return true; }
    new ThemeUi.DialogBuilder(this).setTitle('Ảnh đang đọc dở').setMessage('Đọc tiếp ảnh trước, hay chọn ảnh khác?')
      .setNegativeButton('Chọn ảnh khác', () => { jobs.discard(r.id); if (type === WORK) this.pickWorkImage(); else this.openPipeImport(null); })
      .setPositiveButton('Đọc tiếp', () => this.openJob(r)).show();
    return true;
  }
  openJob(r) { AppLog.event('ui.readJob.open', AppLog.data('type', r.type, 'state', r.state)); if (r.type === PIPE) this.openPipeImport(r.id); else this.openWorkJob(r); }
  /** The work photo of the job back as the import photo; done → its review table, else the read goes on. */
  openWorkJob(r) {
    const jobs = new ReadJobs(this); const photo = jobs.photoFile(r);
    if (photo == null) { jobs.discard(r.id); this.pickWorkImage(); return; }
    this.store = new ScheduleStore(this); this.busy = true; const token = ++this.job; this.base(); this.heading('THÊM LỊCH', 'Đang mở ảnh…', 'Đang tìm viền bảng để giữ đúng hàng và cột.');
    this.worker.execute(AppDataReset.task(async () => {
      try {
        await nextFrame();
        const f = new File(this.getFilesDir(), 'work-import41.image'); const out = new FileOutputStream(f); try { out.write(new FileInputStream(photo).readAllBytes()); } finally { out.close(); }
        const b = await this.decodeWorkImage41(f); const points = GridVision.corners(b);
        const found = r.state === 'done' ? await workResultFrom(jobs, r) : null;
        this.runOnUiThread(() => {
          if (this.isDestroyed() || this.job !== token) return; this.busy = false; this.imported = b; this.corners = points; this.result = null; this.monthInput = this.yearInput = null;
          if (found != null) { this.month = found.schedule.month; this.showFound(found, r.id); return; }
          this.showImport(); const p = r.params ?? {}, m = YearMonth.parse(p.month);
          this.numberInput.value = p.number > 0 ? String(p.number) : ''; this.nameInput.value = p.name ?? ''; this.monthInput.value = String(m.getMonthValue()); this.yearInput.value = String(m.getYear());
          this.readRoster();
        });
      } catch (e) { AppLog.failure('MainActivity', e); this.runOnUiThread(() => { if (this.isDestroyed() || this.job !== token) return; this.busy = false; this.showHome(); this.error('Không mở được ảnh', e.message); }); }
    }));
  }
  /** Home: a small note for a job that is unfinished (not stopped by the user) or waiting for its review. */
  jobNote() {
    if (this._jobNoteClosed) return; const jobs = new ReadJobs(this);
    const r = [jobs.pending(WORK, { includeCancelled: false }), jobs.pending(PIPE, { includeCancelled: false })].filter(x => x != null).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (r == null) return;
    const what = r.type === PIPE ? 'Ảnh phân ống' : 'Ảnh lịch đi làm', done = r.state === 'done';
    const note = el('div', 'job-note'); // not a live region: home is rebuilt on every return
    const text = el('p', 'job-note__text', what + (done ? ' đã đọc xong, chưa lưu.' : ' đang đọc dở.'));
    const open = el('button', 'job-note__open', 'Xem'); open.type = 'button'; // unfinished: then "Đọc tiếp" / "Chọn ảnh khác"
    open.addEventListener('click', () => { AppLog.event('user.action', AppLog.data('screen', 'MainActivity', 'action', open.textContent)); if (this.busy) return; if (r.type === PIPE) this.choosePipeImage(); else this.chooseWorkImage(); });
    const close = el('button', 'job-note__close', '×'); close.type = 'button'; describe(close, 'Để sau');
    close.addEventListener('click', () => { this._jobNoteClosed = true; note.remove(); });
    note.append(text, open, close); this.content.append(note);
  }
  /** The review of a work-roster read (the APK's success path of readRoster). */
  showFound(found, jobId) {
    this.result = found; this.result.schedule = this.store.prepareImport(found.schedule); this.importBaseline = this.result.schedule.copy(); this.identityConfirmed = found.identityMatches; this.editingSaved = false; this.pendingBook = null; this.directChanges.clear(); this.changeRows = [];
    this.shownJob = jobId; this.showReview();
  }
  /** Web: ACTION_OPEN_DOCUMENT image/* is the browser's file picker (iOS offers the photo library and the camera). */
  startActivityForResult(intent, request) {
    if (intent.getAction() !== OPEN_DOCUMENT) { super.startActivityForResult(intent, request); return; }
    AppLog.event('navigation.start', AppLog.data('screen', this.constructor.name, 'request', request, 'intent', intent.toUri(0)));
    if (this._picker == null) {
      const input = this._picker = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.className = 'picker'; input.tabIndex = -1; input.setAttribute('aria-hidden', 'true');
      input.addEventListener('change', () => { const file = input.files?.[0] ?? null; input.value = ''; if (file == null) this.onActivityResult(input._request, ThemedActivity.RESULT_CANCELED, null); else this.onActivityResult(input._request, ThemedActivity.RESULT_OK, new Intent().setData(Uri.fromBlob(file))); });
      input.addEventListener('cancel', () => this.onActivityResult(input._request, ThemedActivity.RESULT_CANCELED, null));
      document.body.append(input);
    }
    this._picker._request = request; this._picker.click();
  }
  refreshSavedPipe() {
    if (this.busy) return; const selected = this.month; const savedStore = new ScheduleStore(this);
    const work = savedStore.load(selected); const previous = savedStore.pipeBook(selected);
    if (work == null || previous == null) { this.error('Chưa có nguồn ảnh', 'Thêm và lưu hai lịch trước khi cập nhật OCR.'); return; }
    const sources = [];
    try { for (const image of new PipeSourceCache(this.getFilesDir()).sourcesFor(previous)) sources.push(new PipeRosterReader.Source(Uri.fromFile(image), previous.hasPrimary() && previous.primaryIndex() === sources.length)); }
    catch (e) { if (!(e instanceof IOException)) throw e; this.error('Chưa mở được ảnh đã lưu', e.message); return; }
    if (sources.length === 0 || sources.length > 3) { this.error('Kiểm tra ảnh nguồn', 'Không xác định được bộ 1–3 ảnh gốc của lịch này. Hãy chọn lại đúng bộ ảnh tại Thêm / thay ảnh phân ống. Lịch và ngày đổi ca đã lưu được giữ nguyên.'); return; }
    this.busy = true; const token = ++this.job, epoch = AppDataReset.generation(); this.base(); this.heading('CẬP NHẬT NHẬN DIỆN', 'Đang đọc ảnh đã lưu', 'Đọc lại bằng thuật toán mới một lần. Giữ lịch đi làm, tên đã lưu và các ngày bạn đã đổi ca.');
    const status = this.text('Đang mở ảnh…', 14, MUTED); this.content.append(status);
    this.readJob = this.worker.submit(AppDataReset.task(async () => {
      try {
        const reader = new PipeRosterReader(this);
        try {
          reader.forceRefresh = true; await nextFrame();
          const fresh = await reader.read(sources, selected, work.employeeName, { update: message => this.runOnUiThread(() => { if (!this.isDestroyed() && this.job === token) status.textContent = message; }) });
          const combined = PipeBook.overlay(previous, savedStore.withPrintedNames(fresh)); const pipe = combined.personalByName(work.employeeName, work);
          if (!AppDataReset.current(epoch)) return;
          savedStore.other().saveImported(pipe, [], combined);
          this.runOnUiThread(() => { if (this.isDestroyed() || this.job !== token || !AppDataReset.current(epoch)) return; this.busy = false; CalendarWidget.refresh(this, false); this.showHome(); Toast.makeText(this, 'Đã cập nhật OCR và lịch. Những ngày Khác Ca cần đối chiếu hai nguồn.', Toast.LENGTH_LONG).show(); });
        } finally { reader.close(); }
      } catch (e) {
        AppLog.failure('MainActivity', e); this.runOnUiThread(() => { if (this.isDestroyed() || this.job !== token || !AppDataReset.current(epoch)) return; this.busy = false; this.showHome();
          // 26/10 (user): no notice or warning — the saved pipe data stays as it was.
        });
      }
    }));
  }
  async onActivityResult(request, code, data) {
    super.onActivityResult(request, code, data);
    if ((request === 100 || request === 200) && code !== ThemedActivity.RESULT_OK) { this.store = new ScheduleStore(this, this.inImport && !this.editingSaved && this.result != null ? this.result.schedule.kind : Schedule.WORK); return; }
    if (request === 200 && code === ThemedActivity.RESULT_OK && data != null) {
      try {
        const file = new File(data.getStringExtra('bookFile')); if (!file.getCanonicalPath().startsWith(this.getCacheDir().getCanonicalPath() + '/')) throw new IOException('Bản quét không hợp lệ.');
        this.pendingBook = new ScheduleStore(this).withPrintedNames(PipeBook.fromJson(utf8Decode(new FileInputStream(file).readAllBytes()))); file.delete(); this.store = new ScheduleStore(this, Schedule.PIPE); this.month = this.pendingBook.month; const number = data.getIntExtra('number', 0); const name = data.getStringExtra('name'); const employee = this.pendingBook.owner(name); // eslint-disable-line no-unused-vars
        this.pendingBook = PipeBook.overlay(this.store.pipeBook(this.month), this.pendingBook); this.result = new RosterReader.Result(); this.result.schedule = this.pendingBook.personalByName(name, new ScheduleStore(this).load(this.month)); this.result.schedule = this.store.prepareImport(this.result.schedule, this.pendingBook); this.importBaseline = this.result.schedule.copy(); this.result.readName = employee.name; this.result.readNumber = String(employee.number);
        this.result.identityImage = await BitmapFactory.decodeFile(employee.identityEvidence); this.result.cells = new Array(this.month.lengthOfMonth()).fill(null); this.identityConfirmed = true; this.editingSaved = false; this.changeRows = []; this.directChanges.clear();
        this.shownJob = data.hasExtra('readJob') ? data.getStringExtra('readJob') : null; this.showReview();
      } catch (e) { AppLog.failure('MainActivity', e); this.showHome(); }
      return;
    }
    if (request !== 100 || code !== ThemedActivity.RESULT_OK || data == null || data.getData() == null) return;
    const uri = data.getData(); this.busy = true; const token = ++this.job; this.base(); this.heading('THÊM LỊCH', 'Đang mở ảnh…', 'Đang tìm viền bảng để giữ đúng hàng và cột.');
    this.worker.execute(AppDataReset.task(async () => {
      try {
        await nextFrame(); const b = await this.loadImage(uri); const points = GridVision.corners(b);
        this.runOnUiThread(() => { if (this.isDestroyed() || this.job !== token) return; this.busy = false; this.imported = b; this.corners = points; this.result = null; this.monthInput = this.yearInput = null; this.showImport(); });
      } catch (e) { AppLog.failure('MainActivity', e); this.runOnUiThread(() => { if (this.isDestroyed() || this.job !== token) return; this.busy = false; this.showHome(); this.error('Không mở được ảnh', e.message); }); }
    }));
  }
  async loadImage(uri) {
    const f = new File(this.getFilesDir(), 'work-import41.image');
    const input = await this.getContentResolver().openInputStream(uri); const out = new FileOutputStream(f);
    try {
      if (input == null) throw new IOException('Không có dữ liệu ảnh'); const bytes = new Uint8Array(65536); let n; let total = 0;
      while ((n = input.read(bytes)) !== -1) { total += n; if (total > 80 * 1024 * 1024) throw new IOException('Ảnh quá lớn. Chọn ảnh dưới 80 MB.'); out.write(bytes, 0, n); }
    } finally { try { out.close(); } finally { if (input != null) input.close(); } }
    AppLog.source('work', f); return this.decodeWorkImage41(f);
  }
  async decodeWorkImage41(f) {
    const opt = new BitmapFactory.Options(); opt.inJustDecodeBounds = true; await BitmapFactory.decodeFile(f.toString(), opt);
    if (opt.outWidth <= 0) throw new IOException('Định dạng ảnh không được hỗ trợ'); let sample = 1; while (Math.trunc(opt.outWidth / sample) > 3600 || Math.trunc(opt.outHeight / sample) > 5000) sample *= 2;
    opt.inJustDecodeBounds = false; opt.inSampleSize = sample; let bitmap = await BitmapFactory.decodeFile(f.toString(), opt); if (bitmap == null) throw new IOException('Không giải mã được ảnh');
    const exif = new ExifInterface(f); const m = new Matrix(); if (exif.isFlipped()) m.postScale(-1, 1); m.postRotate(exif.getRotationDegrees());
    if (!m.isIdentity()) { const rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), m, true); if (rotated !== bitmap) bitmap.recycle(); bitmap = rotated; }
    return bitmap;
  }
  field(label, hint, value, numeric) {
    this.content.append(this.text(label, 13, MUTED)); const input = editText({ hint, value, numeric, capWords: !numeric }); input.classList.add('field--form'); const wrap = el('div', 'field-wrap'); wrap.append(input); this.content.append(wrap); return input; // the wrap keeps setError's line out of the page's child paths (UiResume)
  }

  // ---------------------------------------------------------------- import form
  showImport() {
    this.resumePage41 = 'import';
    const current = YearMonth.now(); const draftMonth = this.monthInput == null ? String(current.getMonthValue()) : this.monthInput.value, draftYear = this.yearInput == null ? String(current.getYear()) : this.yearInput.value;
    this.inImport = true; this.base(); this.heading('ẢNH → LỊCH CÁ NHÂN', 'Thêm lịch của bạn', 'Nhập họ tên hoặc số thứ tự (STT) của bạn. Chỉ cần một trong hai.');
    // The photo itself (fit centre); the browser shows the stored file, so no full-size canvas is needed.
    const preview = imageView(new File(this.getFilesDir(), 'work-import41.image'), null, 185, 'img img--preview'); this.content.append(preview); this.gap(10);
    this.numberInput = this.field('Số thứ tự (STT)', 'Ví dụ: 12', this.store.number() === 0 ? '' : String(this.store.number()), true);
    this.gap(14);
    this.nameInput = this.field('Họ và tên của bạn', 'Ví dụ: Nguyen A', new OwnerProfile(this).defaultName(this.store.name()), false);
    this.addButton('Lưu Tên', true, () => { try { new OwnerProfile(this).save(this.nameInput.value); Toast.makeText(this, 'Đã lưu tên mặc định cho cả hai lịch.', Toast.LENGTH_SHORT).show(); } catch (e) { if (!isIAEorISE(e)) throw e; setError(this.nameInput, e.message); } }); this.gap(8);
    this.gap(8);
    this.gap(14);
    this.monthInput = this.field('Tháng của bảng lịch', '1–12', draftMonth, true);
    this.content.append(this.text('Tháng ghi trên ảnh, từ 1 đến 12. Ví dụ: 10.', 12, MUTED)); this.gap(14);
    this.yearInput = this.field('Năm của bảng lịch', String(current.getYear()), draftYear, true);
    this.gap(16);
    this.progress = this.text('', 13, ACCENT); this.progress.setAttribute('aria-live', 'polite'); this.content.append(this.progress); this.gap(10);
    this.readButton = this.addButton('Tự động đọc lịch', true, () => this.readRoster()); this.gap(12);
    // Web (Task A2): the job stopped by "Hủy" stays unfinished and can be continued later.
    this.addButton('Hủy', false, () => { this.job++; if (this.readJob != null) this.readJob.cancel(true); if (this.busy && this.runningJob != null) new ReadJobs(this).cancel(this.runningJob); this.runningJob = null; this.busy = false; this.showHome(); });
  }
  readRoster() {
    if (this.busy) return; let number, year, mon; const name = this.nameInput.value.trim();
    try { const typedNumber = this.numberInput.value.trim(); number = typedNumber === '' ? 0 : Integer.parseInt(typedNumber); mon = Integer.parseInt(this.monthInput.value); year = Integer.parseInt(this.yearInput.value); if (number < 0 || number > 999 || year < 2000 || year > 2100) throw new IllegalArgumentException(); this.month = YearMonth.of(year, mon); }
    catch (e) { AppLog.failure('MainActivity', e); this.error('Kiểm tra thông tin', 'STT (nếu nhập) từ 1–999, tháng từ 1–12 và năm từ 2000–2100.'); return; }
    // A name or an STT is enough (3.0).
    if (number === 0 && Schedule.normalizeName(name) === '') { setError(this.nameInput, 'Nhập họ tên hoặc STT'); return; }
    if (Schedule.normalizeName(name) !== '' && Schedule.normalizeName(name).length < 2) { setError(this.nameInput, 'Nhập họ tên hoặc STT'); return; }
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); // hide the keyboard
    this.busy = true; this.readButton.disabled = true; this.readButton.textContent = 'Đang đọc ảnh…'; const token = ++this.job; const selected = this.month;
    const progress = this.progress, readButton = this.readButton;
    // Web (Task A2): the read is a job (same photo + settings = same job: a done one is not read again, an
    // interrupted one replays its finished OCR calls) with a progress bar above the APK's progress line.
    const bar = new ReadProgressBar({ variant: 'smooth' }); progress.before(bar.element); progress.setAttribute('aria-live', 'off'); bar.reveal();
    const model = new ReadProgress('work'); let stageText = '';
    const show = () => { if (this.job === token) bar.set(model.percent(), stageText, etaText(model.eta())); };
    this.readJob = this.worker.submit(AppDataReset.task(async () => {
      let job = null;
      try {
        const jobs = new ReadJobs(this); const photo = new FileInputStream(new File(this.getFilesDir(), 'work-import41.image')).readAllBytes();
        if (ReadJobs.supported()) job = await jobs.open(WORK, [{ bytes: photo }], { month: selected.toString(), number, name, staff: await staffFingerprint() });
        if (this.job !== token) return;
        this.runningJob = job?.id ?? null;
        const read = async () => {
          const reader = new RosterReader(this);
          try {
            await nextFrame();
            return await reader.read(this.imported, this.corners, number, name, selected, { update: message => { model.stage(message); stageText = message; show(); this.runOnUiThread(() => { if (this.job === token) progress.textContent = message; }); } });
          } finally { reader.close(); }
        };
        let found;
        if (job != null && job.state === 'done') { found = await workResultFrom(jobs, job); found.saveStructured(this); }
        else {
          if (job != null) jobs.started(job.id);
          found = job == null ? await read() : await runJob({ id: job.id, progress: model, onProgress: show, read });
          found.saveStructured(this);
          if (job != null) { const record = await workResultRecord(found); jobs.finish(job.id, record.result, record.files); }
        }
        model.done(); show();
        this.runOnUiThread(() => { if (this.isDestroyed() || this.job !== token) return; this.busy = false; this.runningJob = null; this.showFound(found, job?.id ?? null); });
      } catch (e) {
        AppLog.failure('MainActivity', e);
        if (job != null && !(e instanceof InterruptedException)) new ReadJobs(this).fail(job.id, e?.message);
        this.runOnUiThread(() => { if (this.isDestroyed() || this.job !== token) return; this.busy = false; this.runningJob = null; bar.element.remove(); progress.setAttribute('aria-live', 'polite'); readButton.disabled = false; readButton.textContent = 'Đọc lại lịch'; progress.textContent = 'Chưa thể hoàn tất. Dữ liệu đã lưu vẫn được giữ.';
          // 26/10 (user): no dialog, notice or warning — only the line above stays on the screen.
        });
      }
    }));
  }

  // ---------------------------------------------------------------- review / editor
  showReview() {
    this.resumePage41 = this.editingSaved ? 'editor' : 'review';
    if (!this.editingSaved && this.result != null && this.result.identityImage != null) {
      const out = new FileOutputStream(new File(this.getFilesDir(), 'ui-identity41.png'));
      this.result.identityImage.compress(CompressFormat.PNG, 100, out).catch(e => AppLog.failure('ui.resume.identity', e)).finally(() => out.close());
    }
    this.inImport = true; this.base();
    const r = this.result, s = r.schedule;
    this.heading(this.editingSaved ? 'LỊCH THÁNG ' + s.month.getMonthValue() + ' / ' + s.month.getYear() : 'KIỂM TRA TRƯỚC KHI LƯU', this.editingSaved ? 'Ngày đổi mã ca' : 'Lịch đã đọc từ ảnh', this.editingSaved ? 'Chọn ngày, tìm tên và xác nhận đúng người đổi. App tự lấy mã ca và số ống từ dữ liệu đã lưu.' : 'Đối chiếu hàng nhân viên và mã ca rồi lưu lịch. Đổi ca tại mục Ngày đổi mã ca trên màn hình chính.');
    if (!this.editingSaved) {
      const identity = linear(false, 'card');
      identity.append(this.text(this.identityConfirmed ? '✓ Đã xác nhận hàng nhân viên' : 'Cần xác nhận hàng nhân viên', 15, this.identityConfirmed ? ThemeUi.SUCCESS : ThemeUi.WARNING));
      identity.append(this.text('Nhân viên: ' + (s.kind === Schedule.WORK ? (s.employeeNumber > 0 ? 'STT ' + s.employeeNumber + ' · ' : '') : r.readNumber != null && r.readNumber !== '0' ? 'STT ' + r.readNumber + ' · ' : '') + s.employeeName, 13, TEXT));
      identity.append(this.text('Ảnh đọc được: ' + (s.kind === Schedule.WORK ? r.readNumber + ' · ' : '') + r.readName, 13, MUTED));
      identity.append(imageView(r.identityImage, null, 65, 'img img--crop'));
      if (!this.identityConfirmed) { const confirm = checkBox('Tôi đối chiếu ảnh: đúng số thứ tự và tên của tôi'); confirm.input.addEventListener('change', () => { this.identityConfirmed = confirm.input.checked; }); identity.append(confirm.view); }
      this.content.append(identity); this.gap(20); this.calendarCard(s.month, s); this.gap(16);
    }
    if (!this.editingSaved && this.pendingBook != null && this.pendingBook.openColumns().length !== 0) {
      const open = this.pendingBook.openColumns().length;
      this.content.append(this.text('⚠ ' + open + ' cột ngày trong ảnh phân ống chưa đọc được số ngày. App không bỏ cột nào: các ô đã được đọc và giữ lại. Chọn đúng ngày cho từng cột (có ảnh ô số ngày để đối chiếu), hoặc lưu trước và chọn sau trên lịch.', 14, ThemeUi.WARNING)); this.gap(8);
      this.addButton('Xác định cột ngày (' + open + ')', true, () => this.chooseOpenColumn(this.pendingBook, this.firstOpen(this.pendingBook), false, null)); this.gap(16);
    }
    if (!this.editingSaved && this.pendingBook != null) {
      // Many unread cells in one date column usually mean that part of the photo is blurred (often an edge).
      const unread = new Map(); for (const e of this.pendingBook.employees) for (const [day, value] of e.days) if (!value.complete()) unread.set(day, (unread.get(day) ?? 0) + 1);
      let blurred = ''; for (const [day, n] of [...unread].sort((a, b) => a[0] - b[0])) if (n >= 3) blurred += (blurred.length === 0 ? '' : ', ') + 'ngày ' + day + ' (' + n + ' ô)';
      if (blurred.length > 0) { this.content.append(this.text('Nhiều ô chưa đọc rõ ở cột ' + blurred + ': chạm từng ô ? để đối chiếu với ảnh gốc.', 13, ThemeUi.WARNING)); this.gap(8); }
      this.addButton('Kiểm tra tên trong ảnh phân ống', false, () => this.editPrintedNames(this.pendingBook, false)); this.gap(16);
    }
    const unknown = s.unresolved(); this.content.append(this.text(unknown > 0 ? unknown + ' ô chưa đọc rõ' : this.editingSaved ? 'Lịch hiện tại · ' + s.shifts.length + ' ngày' : 'Lịch có ' + s.presentDays() + ' ngày có dữ liệu', 16, unknown > 0 ? ThemeUi.WARNING : ThemeUi.SUCCESS)); this.gap(6); this.gap(14);
    const pipeCalendar = s.kind !== Schedule.WORK;
    if (pipeCalendar) this.gap(12);
    let row = null; let visibleDay = 0;
    for (let i = 0; i < s.shifts.length; i++) {
      if (!s.present[i]) continue;
      if (visibleDay++ % 4 === 0) { row = linear(true, 'grid4 grid4--' + (pipeCalendar ? 'tall' : 'short')); this.content.append(row); }
      const day = i; const shift = s.shifts[i], person = Schedule.givenName(s.swapPeople[i]); let label = (i + 1) + (pipeCalendar ? '\n' : '  ·  ') + Schedule.displayCode(shift); if (pipeCalendar && s.pipeLabel(i) !== '') label += '\n' + s.pipeLabel(i); if (person !== '') label += '\n' + person;
      const b = this.button(label, false, () => this.editDay(day)); b.classList.add('btn--cell', pipeCalendar ? 'lines4' : 'lines2'); describe(b, 'Ngày ' + (i + 1) + ': ' + s.dayLabel(i)); b.title = s.dayLabel(i); if (!s.dayComplete(i)) ThemeUi.text(b, ThemeUi.WARNING);
      row.append(b);
    }
    if (this.editingSaved) {
      this.gap(22); this.content.append(this.text('Thêm ngày cần đổi', 20, TEXT)); this.gap(6); this.gap(12);
      this.changeList = linear(false, 'change-list'); this.content.append(this.changeList);
      if (this.changeRows.length === 0) this.addChangeRow(false); else this.renderChangeRows();
      this.gap(8); this.addButton('+  Thêm ngày đổi ca', false, () => this.addChangeRow(true));
    } else { this.changeRows = []; this.changeList = null; }
    this.gap(12); this.gap(12); this.addButton(this.editingSaved ? 'Xác nhận đổi mã ca' : pipeCalendar ? 'Xác nhận & Lưu lịch phân ống' : 'Xác nhận & Lưu lịch đi làm', true, () => this.saveResult()); this.gap(10);
    if (this.editingSaved) this.addButton('Hủy thay đổi', false, () => this.showHome());
    else { this.addButton('Chọn ảnh khác', false, () => this.chooseImage()); this.gap(10); if (!pipeCalendar) this.addButton('Quay lại thông tin', false, () => this.showImport()); else this.addButton('Hủy nhập lịch', false, () => { if (this.shownJob != null) new ReadJobs(this).discard(this.shownJob); this.showHome(); }); }
  }
  openShiftEditor() {
    const saved = this.store.loadCombined(this.month); if (saved == null) { this.error('Chưa có lịch tháng này', 'Nhấn + để thêm ảnh và lưu lịch trước khi đổi mã ca.'); return; }
    AppLog.event('ui.shiftEditor.open', AppLog.data('mode', DateChangeRow.Mode.MANUAL.name(), 'month', this.month.toString()));
    this.result = new RosterReader.Result(); this.result.schedule = saved; this.identityConfirmed = true; this.editingSaved = true; this.pendingBook = null; this.directChanges.clear(); this.changeRows = []; this.showReview();
  }
  /** Own-day repairs are independent of the automatic counterpart lookup on ordinary calendar cells. */
  showManualRepairs() {
    this.store = new ScheduleStore(this); const saved = this.store.loadCombined(this.month);
    if (saved == null) { this.showHome(); this.error('Chưa có lịch tháng này', 'Thêm và lưu lịch trước khi sửa ngày.'); return; }
    this.resumePage41 = 'repairs'; this.inImport = false; this.editingSaved = false; this.pendingBook = null; this.directChanges.clear(); this.changeRows = []; this.calendarView = null; this.base();
    AppLog.event('ui.manualRepairs.open', AppLog.data('month', this.month.toString(), 'schedule', AppLog.schedule(saved)));
    this.heading('LỊCH THÁNG ' + this.month.getMonthValue() + ' / ' + this.month.getYear(), 'Sửa “?” và “Khác Ca”', '');
    let row = null;
    for (let index = 0; index < this.month.lengthOfMonth(); index++) {
      if (index % 4 === 0) { row = linear(true, 'grid4 grid4--tall'); this.content.append(row); }
      const day = index; const shown = saved.present[index] ? saved.dayLabel(index) : 'Chưa có dữ liệu';
      let label = String(index + 1) + '\n' + (saved.present[index] ? Schedule.displayCode(saved.shifts[index]) : '?');
      const pipe = saved.pipeLabel(index), person = Schedule.givenName(saved.swapPeople[index]);
      if (pipe !== '') label += '\n' + pipe; if (person !== '') label += '\n' + person;
      const cell = this.button(label, false, () => this.editManualDay(saved, day)); cell.classList.add('btn--cell', 'lines4');
      describe(cell, 'Sửa thủ công ngày ' + (index + 1) + ': ' + shown);
      if (!saved.present[index] || !saved.dayComplete(index)) ThemeUi.text(cell, ThemeUi.WARNING);
      row.append(cell);
    }
    const left = this.month.lengthOfMonth() % 4; if (left !== 0) for (let i = left; i < 4; i++) row.append(el('div', 'grid4__spacer'));
    this.gap(12); this.addButton('Về lịch', false, () => this.showHome());
  }
  addChangeRow(focus) {
    if (!this.editingSaved) return;
    const holder = [null];
    holder[0] = new DateChangeRow(this, () => { this.changeRows.splice(this.changeRows.indexOf(holder[0]), 1); this.renderChangeRows(); }, this.editingSaved || this.store.kind === Schedule.PIPE, this.lookup(), DateChangeRow.Mode.MANUAL); this.changeRows.push(holder[0]); this.renderChangeRows();
    if (focus) { holder[0].day.focus(); requestAnimationFrame(() => holder[0].view.scrollIntoView({ block: 'nearest', behavior: 'smooth' })); }
  }
  renderChangeRows() { this.changeList.replaceChildren(...this.changeRows.map(r => r.view)); }
  /** Names as OCR read them on the pipe photos; the user corrects a damaged one once and the correction is used
   *  for every later reading of any photo. */
  editPrintedNames(book, saved) {
    if (book == null) { this.error('Chưa có ảnh phân ống', 'Thêm ảnh phân ống trước.'); return; }
    const people = [...book.employees]; people.sort((a, b) => { const x = Schedule.normalizeName(a.name), y = Schedule.normalizeName(b.name); return x < y ? -1 : x > y ? 1 : 0; });
    const labels = people.map(e => (e.number > 0 ? 'STT ' + e.number + ' · ' : '') + e.name + (e.ocrName() === e.name ? '' : '  (ảnh in: ' + e.ocrName() + ')'));
    new ThemeUi.DialogBuilder(this).setTitle('Tên đọc từ ảnh phân ống · chạm để sửa').setItems(labels, (d, i) => {
      const e = people[i];
      const box = linear(false, 'dlg-box');
      box.append(imageView(fileExists(e.identityEvidence) ? e.identityEvidence : null, 'Ô tên trong ảnh gốc', 56, 'img img--crop'));
      box.append(this.text('Ảnh đọc: ' + e.ocrName() + '', 13, MUTED));
      const input = editText({ value: e.name, description: 'Tên đúng trên tờ lịch' }); box.append(input);
      const dialog = new ThemeUi.DialogBuilder(this).setTitle('Sửa tên trên ảnh').setView(box).setNegativeButton('Hủy', null).setNeutralButton('Dùng tên ảnh đọc', () => { new ScheduleStore(this).printedNames().remove(e.ocrName()); this.namesChanged(saved); }).setPositiveButton('Lưu tên', null).create();
      dialog.setOnShowListener(() => dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(() => {
        try {
          const fixed = ConfirmedNames.validate(input.value); const names = new ScheduleStore(this); names.printedNames().put(e.ocrName(), fixed);
          // A full name confirmed for the old spelling stays with the person.
          const full = names.names().full(e.name); if (full != null && names.names().full(fixed) == null) { const editor = this.getSharedPreferences('schedules', 0).edit(); names.names().put(editor, new Map([[fixed, full]])); editor.commit(); }
          dialog.dismiss(); this.namesChanged(saved); Toast.makeText(this, 'Đã lưu tên “' + fixed + '”.', Toast.LENGTH_SHORT).show();
        } catch (x) { if (!isIAEorISE(x)) throw x; setError(input, x.message); }
      }));
      dialog.show();
    }).setNegativeButton('Đóng', null).show();
  }
  namesChanged(saved) {
    if (saved) { CalendarWidget.refresh(this, false); this.showHome(); return; }
    this.pendingBook.correctNames(new ScheduleStore(this).printedNames().all()); const work = new ScheduleStore(this).load(this.pendingBook.month);
    this.result.schedule = this.store.prepareImport(this.pendingBook.personalByName(this.result.schedule.employeeName, work), this.pendingBook); this.importBaseline = this.result.schedule.copy(); this.showReview();
  }
  firstOpen(book) { const owner = book.ownerOpenColumns(); return owner.length === 0 ? book.openColumns()[0] : owner[0]; }
  openUnclearDay(view, day) {
    const book = this.store.pipeBook(view.month); const open = book == null ? null : book.ownerOpenColumn(day + 1);
    if (open != null) this.chooseOpenColumn(book, open, true, () => this.editManualDay(view, day)); else this.editManualDay(view, day);
  }
  /** The user reads the date printed above an open column; its cells then belong to that date. */
  chooseOpenColumn(book, column, saved, manual) {
    const work = new ScheduleStore(this).load(book.month); let ownerRow = null;
    try { if (work != null) ownerRow = book.owner(work.employeeName).name; } catch (unknownOwner) { if (!isIAE(unknownOwner)) throw unknownOwner; }
    DayColumnDialog.show(this, book, column, ownerRow, work, day => {
      try {
        const updated = OpenColumns.choose(this.getFilesDir(), book, column, day, new ScheduleStore(this).printedNames().all());
        if (saved) { const pipeStore = new ScheduleStore(this, Schedule.PIPE); const pipe = pipeStore.prepareImport(updated.personalByName(work.employeeName, work), updated); pipeStore.saveImported(pipe, [], updated); CalendarWidget.refresh(this, false); this.showHome(); }
        else { this.pendingBook = updated; this.result.schedule = this.store.prepareImport(this.pendingBook.personalByName(this.result.schedule.employeeName, work), this.pendingBook); this.importBaseline = this.result.schedule.copy(); this.showReview(); }
        Toast.makeText(this, 'Đã ghép cột vào ngày ' + day + '.', Toast.LENGTH_SHORT).show();
      } catch (e) { AppLog.failure('MainActivity', e); this.error('Chưa ghép được cột ngày', e.message); }
    }, manual);
  }
  /** One day as the user sees it: "D5 · 18-HC", "S10 · ?", "?" for an unread code. */
  static describeDay(s, d) {
    const code = s.shifts[d] == null ? '?' : Schedule.displayCode(s.shifts[d]); if (s.kind === Schedule.WORK) return code;
    const a = new PipeDay(s.shifts[d], s.pipes[d], s.duties[d], '', '').assignment(); return a === '' ? code : code + ' · ' + a;
  }
  /** Error ledger (3.0): a cell the app could not read, or read differently from what the user confirmed. */
  remember(s, day, before, raw, cell, parts) {
    const after = MainActivity.describeDay(s, day); if (!before.includes('?') && !before.includes('Khác') && before === after) return;
    const pipe = s.kind !== Schedule.WORK; const value = pipe && s.pipes[day] != null && PipeDay.pipeValue(s.pipes[day]) != null ? s.pipes[day] : null;
    try {
      new ErrorLedger(this).record(s.month.toString(), s.employeeName, day + 1, pipe ? 'Phân ống' : 'Đi làm', before, after, raw, cell, value == null ? null : ErrorLedger.pipeSignature(cell, parts), value)
        .catch(() => { /* the correction itself is saved; the ledger is a record only */ });
    } catch (notSaved) { if (!(notSaved instanceof RuntimeException || notSaved instanceof TypeError)) throw notSaved; /* the correction itself is saved; the ledger is a record only */ }
  }
  editManualDay(view, day) {
    const repairPage = this.resumePage41 === 'repairs';
    AppLog.event('ui.manualRepairs.day', AppLog.data('date', view.month.atDay(day + 1).toString(), 'fromRepairPage', repairPage, 'before', view.dayLabel(day), 'present', view.present[day], 'person', view.swapPeople[day]));
    const box = linear(false, 'dlg-box');
    const codes = ['Chọn mã ca', 'S26', 'C23', 'S10', 'D5', 'S17', 'D6', 'HC', 'HOC', 'BT', 'P', 'H', 'HL', 'OFF'];
    for (const known of this.store.knownCodes()) if (matches(known, '[A-Z][A-Z0-9]{0,7}') && !codes.includes(known)) codes.push(known);
    const oldCode = view.shifts[day] == null ? null : Schedule.displayCode(view.shifts[day]); if (oldCode != null && !codes.includes(oldCode)) codes.push(oldCode);
    const pipes = ['Chọn phân ống']; for (let pipe = 9; pipe <= 22; pipe++) pipes.push(format('%02d', pipe));
    let oldPipe = view.issues[day] == null ? view.pipes[day] : null;
    if (oldPipe != null && oldPipe !== '') { if (matches(oldPipe, '[0-9]+')) oldPipe = format('%02d', Integer.parseInt(oldPipe)); if (!pipes.includes(oldPipe)) pipes.push(oldPipe); }
    const duties = ['Chưa rõ (?)', 'Không có', 'HC', 'TC', 'TC1', 'TC2', 'TC3'];
    const code = spinner(codes, 'Mã ca sửa thủ công'), assignment = spinner(pipes, 'Phân ống sửa thủ công'), duty = spinner(duties, 'Nhiệm vụ D5 sửa thủ công');
    code.selectedIndex = oldCode == null ? 0 : codes.indexOf(oldCode); assignment.selectedIndex = oldPipe == null || oldPipe === '' ? 0 : pipes.indexOf(oldPipe);
    const oldDuty = view.issues[day] == null ? view.duties[day] : null; const extra = oldDuty == null || oldDuty.endsWith(PipeRules.DEFAULT_MARK) ? 0 : oldDuty === '' ? 1 : duties.indexOf(oldDuty); duty.selectedIndex = Math.max(0, extra);
    box.append(this.text('Mã ca', 14, TEXT), code);
    const pipeBox = linear(false, 'choice-box'); pipeBox.append(this.text('Phân ống', 14, TEXT), assignment); box.append(pipeBox);
    const dutyBox = linear(false, 'choice-box'); dutyBox.append(this.text('Nhiệm vụ D5', 14, TEXT), duty); box.append(dutyBox);
    const problem = this.text('', 12, ThemeUi.WARNING); problem.hidden = true; problem.setAttribute('role', 'alert'); box.append(problem);
    const updateChoices = () => { const chosen = code.selectedIndex === 0 ? null : Schedule.canonicalShift(codes[code.selectedIndex]); pipeBox.hidden = Schedule.dayOff(chosen); dutyBox.hidden = chosen !== 'D5'; problem.hidden = true; };
    code.addEventListener('change', updateChoices); updateChoices();
    const cancelled = () => AppLog.event('ui.manualRepairs.cancel', AppLog.data('date', view.month.atDay(day + 1).toString(), 'fromRepairPage', repairPage));
    const dialog = new ThemeUi.DialogBuilder(this).setTitle('Ngày ' + (day + 1) + ' · Nhập thủ công').setView(box).setNegativeButton('Quay lại', () => cancelled()).setPositiveButton('Xác nhận', null).create();
    dialog.setOnCancelListener(() => cancelled());
    dialog.setOnShowListener(() => dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(() => {
      try {
        const correction = ManualDayEdit.select(view.month.atDay(day + 1), code.selectedIndex === 0 ? '' : codes[code.selectedIndex], assignment.selectedIndex === 0 ? null : pipes[assignment.selectedIndex], duty.selectedIndex === 0 ? null : duty.selectedIndex === 1 ? '' : duties[duty.selectedIndex], null);
        const latest = this.store.loadCombined(view.month); if (latest == null || !Schedule.sameName(latest.employeeName, view.employeeName)) throw new IllegalArgumentException('Lịch đang mở đã thay đổi. Mở lại ngày để sửa.');
        const before = latest.issues[day] != null ? MainActivity.describeDay(latest, day) + ' · ' + latest.issues[day].label : MainActivity.describeDay(latest, day); this.store.saveManualCorrection(latest, correction);
        const after = this.store.loadCombined(view.month); this.remember(after, day, before, '', null, 0); AppLog.event('ui.manualRepairs.saved', AppLog.data('date', correction.date.toString(), 'fromRepairPage', repairPage, 'before', before, 'after', after.dayLabel(day), 'code', correction.code, 'pipe', correction.pipe, 'duty', correction.duty, 'person', after.swapPeople[day]));
        CalendarWidget.refresh(this, false); dialog.dismiss(); if (repairPage) this.showManualRepairs(); else this.showHome(); Toast.makeText(this, 'Đã lưu sửa thủ công và lịch sử.', Toast.LENGTH_SHORT).show();
      } catch (e) { if (!isIAEorISE(e)) throw e; AppLog.failure('ui.manualRepairs.save', e); problem.textContent = e.message; problem.hidden = false; }
    }));
    dialog.show();
  }
  /** Correct an OCR cell only; importing never offers counterpart/date exchange fields. */
  editImportedDay(day) { this.editImportedCell(day); }
  async editImportedCell(day) {
    const box = linear(false, 'dlg-box');
    let source = null; const pipe = this.result.schedule.kind === Schedule.PIPE; let printed = null;
    if (pipe) { try { const b = this.book(this.result.schedule.month); printed = b == null ? null : b.owner(this.result.schedule.employeeName).days.get(day + 1); if (printed != null) source = await BitmapFactory.decodeFile(printed.evidence); } catch (ignored) { if (!isIAE(ignored)) throw ignored; } }
    else if (this.result.cells != null) source = this.result.cells[day];
    // What the separate OCR readings of each part said, so a correction starts from the photo, not from a default.
    const fields = printed == null ? [] : printed.raw.split(' | ');
    const printedRaw = [printed == null ? '' : printed.raw]; const shownCell = [source]; const fieldCount = [fields.length];
    const dutyRead = fields.length > 2 ? PipeFieldVotes.summary(PipeFieldVotes.Field.DUTY, fields[2]) : '';
    if (source != null) box.append(imageView(source, null, 100, 'img img--cell'));
    if (fields.length >= 2) {
      const c = PipeFieldVotes.summary(PipeFieldVotes.Field.CODE, fields[0]), pp = PipeFieldVotes.summary(PipeFieldVotes.Field.PIPE, fields[1]);
      const read = this.text('OCR đã đọc: ca ' + (c === '' ? 'không ra chữ' : c) + ' · ống ' + (pp === '' ? 'không ra chữ' : pp) + (fields.length > 2 ? ' · nhiệm vụ ' + (dutyRead === '' ? 'không ra chữ' : dutyRead) : ''), 13, TEXT); describe(read, 'Các lần OCR đọc ô này'); box.append(read);
    }
    box.append(this.text('Mã ca trong ảnh', 14, TEXT)); const code = editText({ hint: 'S10, D5, C23, S26, P hoặc OFF', value: this.result.schedule.shifts[day] == null ? '' : Schedule.displayCode(this.result.schedule.shifts[day]), capChars: true, description: 'Mã ca đối chiếu ảnh' }); box.append(code);
    const pipeInput = editText({ hint: 'Số ống trong ảnh; ? nếu chưa rõ', value: this.result.schedule.pipes[day] == null ? '' : this.result.schedule.pipes[day], description: 'Phân ống đối chiếu ảnh' });
    const labels = ['Không có ký hiệu bổ sung', 'HC', 'TC1', 'TC2', 'TC3', 'TC', 'Chưa rõ (?)']; const duty = spinner(labels, 'Nhiệm vụ đối chiếu ảnh'); let previous = this.result.schedule.duties[day];
    // An empty duty while OCR saw HC/TC in that cell is not "none": start from "Chưa rõ" so it is checked.
    if (previous === '' && dutyRead !== '') previous = null;
    duty.selectedIndex = previous == null ? 6 : previous === 'HC' ? 1 : previous === 'TC1' ? 2 : previous === 'TC2' ? 3 : previous === 'TC3' ? 4 : previous === 'TC' ? 5 : 0; const warned = [false];
    if (pipe) { box.append(this.text('Số ống trong ảnh', 14, TEXT), pipeInput, duty); }
    const dialog = new ThemeUi.DialogBuilder(this).setTitle('Đối chiếu ảnh · ngày ' + (day + 1)).setView(box).setPositiveButton('Áp dụng', null).setNegativeButton('Đóng', null).create();
    dialog.setOnShowListener(() => dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(() => {
      try {
        const value = code.value.trim().toUpperCase(); if (!matches(value, '[A-Z][A-Z0-9]{0,7}')) throw new IllegalArgumentException('Nhập mã ca đúng theo ảnh; OFF nếu ô nghỉ.');
        const assignment = pipeInput.value.trim().toUpperCase(); if (assignment !== '' && assignment !== '?' && PipeDay.pipeValue(assignment) == null) throw new IllegalArgumentException('Chỉ nhập một số ống rõ trong ảnh; dùng ? khi chưa xác định.');
        const extra = duty.selectedIndex === 6 ? null : ['', 'HC', 'TC1', 'TC2', 'TC3', 'TC'][duty.selectedIndex];
        if (pipe && Schedule.canonicalShift(value) === 'D5' && extra === '' && dutyRead !== '' && !warned[0]) { warned[0] = true; throw new IllegalArgumentException('Ô nhiệm vụ trong ảnh có chữ (OCR đọc: ' + dutyRead + '). Chọn đúng ký hiệu; nếu ô thật sự trống, bấm Áp dụng lần nữa.'); }
        const correction = new ShiftChange(this.result.schedule.month.atDay(day + 1), value, null, 0, assignment === '' || assignment === '?' ? null : assignment, extra, pipe, false, false);
        const before = MainActivity.describeDay(this.result.schedule, day); ScheduleStore.apply(this.result.schedule, correction); this.directChanges.set(correction.date.toString(), correction);
        this.remember(this.result.schedule, day, before, pipe ? printedRaw[0] : this.result.raw == null ? '' : this.result.raw[day], shownCell[0], fieldCount[0]);
        dialog.dismiss(); this.showReview();
      } catch (e) { if (!isIAE(e)) throw e; this.error('Kiểm tra ô trong ảnh', e.message); }
    }));
    dialog.show();
  }
  /** editDay(day) | editDay(day, quick) (AUTO) | editDay(day, quick, mode). */
  async editDay(day, quick = false, mode = DateChangeRow.Mode.AUTO) {
    if (!this.editingSaved) { this.editImportedDay(day); return; }
    const schedule = this.result.schedule;
    AppLog.event('ui.shiftEditor.day', AppLog.data('mode', mode.name(), 'date', schedule.month.atDay(day + 1).toString(), 'quick', quick));
    const box = linear(false, 'dlg-box');
    if (schedule.issues[day] != null) box.append(this.text(schedule.issues[day].detail, 14, ThemeUi.WARNING));
    let source = null;
    if (schedule.kind !== Schedule.WORK) { try { const book = this.book(schedule.month); const entry = book == null ? null : book.owner(schedule.employeeName).days.get(day + 1); if (entry != null) source = await BitmapFactory.decodeFile(entry.evidence); } catch (ignored) { if (!isIAE(ignored)) throw ignored; } }
    else if (!this.editingSaved && this.result.cells != null) source = this.result.cells[day];
    if (source != null) { box.append(imageView(source, null, 100, 'img img--cell')); box.append(this.text('Ô nguồn của bạn · ngày ' + (day + 1), 12, MUTED)); }
    const row = new DateChangeRow(this, () => {}, this.editingSaved || this.store.kind === Schedule.PIPE, this.lookup(), mode); row.editExisting(schedule, day); box.append(row.view);
    const builder = new ThemeUi.DialogBuilder(this).setTitle('Ngày ' + (day + 1)).setView(box).setPositiveButton(quick ? 'Lưu ngày này' : 'Áp dụng', null).setNegativeButton('Đóng', () => { if (quick) this.showHome(); });
    let original = null; try { if (this.editingSaved) original = this.store.original(schedule, day + 1); } catch (corrupt) { if (!(corrupt instanceof IllegalStateException)) throw corrupt; this.error('Không mở được lịch sử', corrupt.message); return; }
    const restorePoint = original;
    if (restorePoint != null) builder.setNeutralButton('Khôi phục ban đầu', () => this.confirmRestore(restorePoint));
    const dialog = builder.create(); dialog.setOnCancelListener(() => { if (quick) this.showHome(); });
    if (mode === DateChangeRow.Mode.MANUAL && schedule.issues[day] != null && schedule.swapPeople[day] === '') {
      const currentView = schedule.copy();
      try {
        const saved = this.book(currentView.month); const printed = saved == null ? null : saved.owner(currentView.employeeName).days.get(day + 1);
        if (printed != null && printed.complete()) box.append(this.button('Dùng ca & phân ống theo ảnh này', false, () => {
          const description = 'Ngày ' + (day + 1) + ': ' + Schedule.displayCode(currentView.shifts[day]) + ' → ' + Schedule.displayCode(printed.code) + (printed.assignment() === '' ? '' : ' · ' + printed.assignment()) + '.\nChỉ cập nhật ngày này theo hàng của bạn trong ảnh phân ống. Lưu lịch sử để có thể khôi phục.';
          new ThemeUi.DialogBuilder(this).setTitle('Xác nhận nguồn cho ngày này').setMessage(description).setNegativeButton('Hủy', null).setPositiveButton('Xác nhận', () => {
            try {
              const latest = this.store.pipeBook(currentView.month); const now = latest == null ? null : latest.owner(currentView.employeeName).days.get(day + 1);
              if (now == null || !now.complete() || now.code !== printed.code || now.pipe !== printed.pipe || now.duty !== printed.duty) throw new IllegalArgumentException('Dữ liệu nguồn đã thay đổi. Mở lại ngày để đối chiếu.');
              const chosen = new ShiftChange(currentView.month.atDay(day + 1), now.code, '', 0, now.pipe, now.duty, true, true, false);
              this.store.saveCombinedChanges(currentView, [chosen]); CalendarWidget.refresh(this, false); dialog.dismiss(); this.showHome();
            } catch (e) { if (!isIAEorISE(e)) throw e; this.error('Chưa cập nhật ngày', e.message); }
          }).show();
        }));
      } catch (ignored) { if (!isIAE(ignored)) throw ignored; /* An ambiguous owner must not supply an assignment. */ }
    }
    dialog.setOnShowListener(() => {
      dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(() => row.ensureConfirmed(() => {
        try {
          const change = row.read(); if (change == null) return;
          if (change.lookupPerson && !new PipeDay(change.code, change.pipe, change.duty, '', '').complete()) throw new IllegalArgumentException('Dữ liệu phân ống của người này trong ngày đã chọn chưa rõ. Chưa thể tự ghép số ống; thay đổi chưa được lưu.');
          if (quick) { if (change.manualAssignment && !change.lookupPerson && !change.updatesPerson) this.store.saveManualCorrection(this.result.schedule, change); else this.store.saveCombinedChanges(this.result.schedule, [change]); CalendarWidget.refresh(this, false); dialog.dismiss(); this.showHome(); Toast.makeText(this, 'Đã lưu ngày đổi ca và lịch sử.', Toast.LENGTH_SHORT).show(); return; }
          if (this.editingSaved && change.updatesPipe && this.result.schedule.kind === Schedule.WORK) { const old = this.result.schedule; this.result.schedule = new Schedule(Schedule.COMBINED, old.month, old.employeeNumber, old.employeeName, old.shifts, old.swapPeople, old.swapNumbers, old.pipes, old.duties); }
          ScheduleStore.apply(this.result.schedule, change); this.directChanges.set(change.date.toString(), change); dialog.dismiss(); this.showReview();
        } catch (e) { if (!isIAEorISE(e)) throw e; this.error('Kiểm tra ngày đổi ca', e.message); }
      }));
    });
    dialog.show();
  }
  book(selected) { return this.pendingBook != null && this.pendingBook.month.equals(selected) ? this.pendingBook : this.store.pipeBook(selected); }
  lookup() { return m => this.book(m); }

  // ---------------------------------------------------------------- saving
  saveResult() { if (this.editingSaved) { this.confirmRows(0); return; } this.saveConfirmedResult(); }
  confirmRows(index) { if (index >= this.changeRows.length) { this.saveConfirmedResult(); return; } this.changeRows[index].ensureConfirmed(() => this.confirmRows(index + 1)); }
  saveConfirmedResult() {
    if (!this.identityConfirmed) { this.error('Chưa xác nhận nhân viên', 'Hãy đối chiếu số thứ tự và họ tên trong ảnh rồi đánh dấu xác nhận. Nếu không đúng, chọn lại ảnh hoặc thông tin.'); return; }
    const collected = new Map(this.directChanges); const entered = new Set();
    try { if (this.editingSaved) for (const row of this.changeRows) { const change = row.read(); if (change != null) { const key = change.date.toString(); if (entered.has(key)) throw new IllegalArgumentException('Ngày ' + change.displayDate() + ' bị nhập trùng.'); entered.add(key); collected.set(key, change); } } }
    catch (e) { if (!isIAE(e)) throw e; this.error('Kiểm tra ngày đổi ca', e.message); return; }
    const changes = [...collected.values()];
    const save = () => {
      try {
        if (this.editingSaved) this.store.saveCombinedChanges(this.result.schedule, changes);
        else {
          this.store.saveImported(this.importBaseline == null ? this.result.schedule : this.importBaseline, changes, this.pendingBook); if (this.result.staff != null) try { this.store.saveStaff(this.result.staff); } catch (ignored) { if (!(ignored instanceof RuntimeException)) throw ignored; /* The schedule is saved; full names stay optional. */ }
          if (this.shownJob != null) { new ReadJobs(this).confirm(this.shownJob); this.shownJob = null; } // web: the read job is confirmed
        }
        this.month = this.result.schedule.month; CalendarWidget.refresh(this, !this.editingSaved, this.store.kind); const message = this.editingSaved ? 'Đã lưu ' + changes.length + ' ngày đổi ca. Lịch và widget đã cập nhật.' : 'Đã lưu lịch. Bạn có thể đổi ca tại mục Ngày đổi mã ca trên màn hình chính.'; this.showHome(); Toast.makeText(this, message, Toast.LENGTH_LONG).show();
      } catch (e) { if (!isIAEorISE(e)) throw e; this.error('Chưa lưu thay đổi', e.message); }
    };
    if (!this.editingSaved && this.store.differentPerson(this.result.schedule.employeeNumber, this.result.schedule.employeeName)) new ThemeUi.DialogBuilder(this).setTitle('Đổi người dùng?').setMessage('Các tháng của người trước trong loại lịch này sẽ được thay. Loại lịch còn lại được giữ riêng.').setPositiveButton('Đổi người & lưu', () => save()).setNegativeButton('Hủy', null).show();
    else if (!this.editingSaved && this.store.kind !== Schedule.PIPE && this.store.load(this.month) != null) new ThemeUi.DialogBuilder(this).setTitle('Thay lịch tháng ' + this.month.getMonthValue() + '?').setMessage('Cập nhật dữ liệu từ ảnh. Các ngày đã đổi ca được giữ nguyên; dữ liệu ảnh trùng ngày nhưng khác nhau sẽ cần đối chiếu.').setPositiveButton('Thay lịch', () => save()).setNegativeButton('Hủy', null).show(); else save();
  }

  // ---------------------------------------------------------------- settings and data pages
  showSettings() {
    this.resumePage41 = 'settings';
    this.base(); this.heading('CÀI ĐẶT', 'Dữ liệu ứng dụng', 'Phiên bản ' + BuildConfig.VERSION_NAME + ' · Dữ liệu được lưu trên điện thoại.');
    this.gap(16); this.addButton('Xem dữ liệu phân ống đã lưu', false, () => this.showSourceBook()); this.gap(10); this.addButton('Lịch sử đổi ca', false, () => this.showHistory());
    this.gap(10); this.addButton('Chuông thông báo', false, () => this.startActivity(new Intent(this, 'ReminderActivity')));
    this.gap(10); this.addButton('Lỗi đã ghi nhớ', false, () => this.showLedger());
    this.gap(24); this.gap(12);
    const reset = this.addButton('Reset', false, () => this.confirmReset()); ThemeUi.text(reset, ThemeUi.DANGER); this.gap(16); this.addButton('Về lịch', false, () => this.showHome());
  }
  confirmReset() {
    const keepPresets = checkBox('Giữ các bộ màu giao diện đã lưu', true); keepPresets.view.classList.add('check--dialog');
    new ThemeUi.DialogBuilder(this).setTitle('Reset ứng dụng, giữ tên đã lưu?').setMessage('Xóa vĩnh viễn lịch đi làm, phân ống, bản sao ảnh trong app, OCR, lịch sử đổi ca, cache và cài đặt. Không thể hoàn tác.\n\nTên mặc định đã bấm Lưu Tên và ảnh gốc ngoài app được giữ nguyên. Bỏ chọn bên dưới nếu muốn xóa cả các bộ màu giao diện đã lưu.').setView(keepPresets.view)
      .setNegativeButton('Hủy', null).setPositiveButton('Reset, giữ tên', () => {
        if (this.busy) { this.error('Đang xử lý', 'Chờ tác vụ hiện tại hoàn tất rồi Reset.'); return; }
        const preservePresets = keepPresets.input.checked; this.resetting = true; this.busy = true; this.job++; AppDataReset.invalidatePending();
        CalendarWidget.clearForReset(this); this.base(); this.heading('RESET', 'Đang xóa dữ liệu…', 'Giữ lại tên mặc định đã lưu. Đợi các tác vụ ảnh kết thúc để dữ liệu cũ không được ghi lại.');
        this.worker.execute(() => {
          let failure = null; try { AppDataReset.reset(this.getApplicationContext(), preservePresets); } catch (e) { AppLog.failure('MainActivity', e); failure = e.message; }
          const message = failure; this.runOnUiThread(() => {
            if (this.isDestroyed()) return; this.result = null; this.importBaseline = null; this.pendingBook = null; this.imported = null; this.corners = null; this.numberInput = this.nameInput = this.monthInput = this.yearInput = null; this.readButton = null; this.progress = null; this.changeList = null; this.directChanges.clear(); this.changeRows = []; this.editingSaved = false; this.identityConfirmed = false; this.month = YearMonth.now(); this.busy = false; this.resetting = false;
            this.showHome(); CalendarWidget.refresh(this, false);
            if (message == null) Toast.makeText(this, 'Đã Reset. Tên mặc định được giữ nguyên.', Toast.LENGTH_LONG).show(); else this.error('Reset chưa hoàn tất', 'Một phần dữ liệu đã xóa. Hãy Reset lại để hoàn tất.\n' + message);
          });
        });
      }).show();
  }
  showSourceBook() {
    this.resumePage41 = 'source';
    this.base(); this.heading('DỮ LIỆU ĐÃ LƯU', 'Phân ống · ' + this.month.getMonthValue(), 'Chọn tên để xem ca và vị trí theo từng ngày. Dấu ? cần đối chiếu; không được tự gán số ống.');
    const source = this.store.pipeBook(this.month);
    if (source == null) this.content.append(this.text('Chưa có dữ liệu phân ống tháng này.', 14, MUTED));
    else for (const e of source.employees) {
      let unknown = 0; for (const day of e.days.values()) if (!day.complete()) unknown++;
      this.addButton((e.number > 0 ? 'STT ' + e.number + ' · ' : '') + e.name + ' · ' + e.days.size() + ' ngày · ' + unknown + ' chưa rõ', false, () => {
        let details = ''; for (const [key, day] of e.days) details += 'Ngày ' + key + ': ' + Schedule.displayCode(day.code) + ' · ' + day.assignment() + (day.conflict ? ' · ảnh mâu thuẫn' : '') + '\n';
        this.error(e.name, details);
      }); this.gap(8);
    }
    this.gap(14); this.addButton('Về cài đặt', false, () => this.showSettings());
  }
  showHistory() {
    this.resumePage41 = 'history';
    this.base(); this.heading('LỊCH SỬ ĐỔI CA', 'Thay đổi đã lưu', 'Tháng ' + this.month.getMonthValue() + '/' + this.month.getYear() + ' · Mỗi lần đổi ca giữa hai người nằm trong một ô. Chạm ô để xem chi tiết hoặc khôi phục.');
    const view = this.store.loadCombined(this.month);
    try {
      const history = view == null ? [] : this.store.history(view); const chronological = [...history].reverse(); const names = this.store.names(); let printedOnly = false; // eslint-disable-line no-unused-vars
      if (history.length === 0) this.content.append(this.text('Chưa có lịch sử.', 14, MUTED));
      for (const h of history) { const swap = h.swap(chronological, names); printedOnly |= swap != null && !swap.partnerConfirmed; this.content.append(this.historyCard(h, swap)); this.gap(10); }
    } catch (e) { if (!(e instanceof IllegalStateException)) throw e; this.error('Không mở được lịch sử', e.message); }
    this.gap(12); this.addButton('Về lịch', false, () => this.showHome());
  }
  /** Error ledger screen (3.0): what the app could not read or read differently, and what you confirmed. */
  showLedger() {
    this.resumePage41 = 'ledger';
    this.base(); this.heading('SỔ LỖI', 'Lỗi đã ghi nhớ', 'Ô app chưa đọc được hoặc đọc khác với giá trị bạn xác nhận. Số ống bạn xác nhận được dùng làm mẫu so cho các lần quét sau. Reset không xóa sổ này.');
    const ledger = new ErrorLedger(this); const entries = ledger.entries();
    if (entries.length === 0) this.content.append(this.text('Chưa có lỗi đã lưu.', 14, MUTED));
    for (const e of entries) {
      const card = linear(false, 'card');
      const saved = DateTimeFormatter.ofPattern('dd/MM/yy HH:mm').format(Instant.ofEpochMilli(e.time).atZone(ZoneId.systemDefault()));
      card.append(this.text(e.cause + ' · ' + e.source + ' · lưu lúc ' + saved, 12, ACCENT));
      const ym = e.month.split('-'); const date = ym.length === 2 ? e.day + '/' + ym[1] + '/' + ym[0] : e.day + ' · ' + e.month;
      card.append(this.text('Ngày ' + date + (e.person === '' ? '' : ' · ' + e.person), 15, TEXT));
      const image = ledger.image(e); if (image != null && image.isFile()) card.append(imageView(image, 'Ảnh ô ngày ' + e.day, 64, 'img img--start'));
      card.append(this.text('App: ' + e.shown + '  →  Bạn xác nhận: ' + e.confirmed, 14, TEXT));
      if (e.raw !== '') card.append(this.text('Các lần đọc: ' + e.raw, 12, MUTED));
      const del = this.button('Xóa mục này', false, () => new ThemeUi.DialogBuilder(this).setMessage('Xóa mục ngày ' + e.day + ' khỏi sổ lỗi? Lịch không thay đổi.').setNegativeButton('Quay lại', null).setPositiveButton('Xóa', () => { ledger.delete(e.id); this.showLedger(); }).show());
      del.classList.add('btn--in-card'); card.append(del);
      this.content.append(card); this.gap(10);
    }
    if (entries.length !== 0) { this.gap(6); const all = this.addButton('Xóa toàn bộ sổ lỗi', false, () => new ThemeUi.DialogBuilder(this).setMessage('Xóa toàn bộ ' + entries.length + ' mục? App sẽ không còn dùng các ô này làm mẫu so. Lịch không thay đổi.').setNegativeButton('Quay lại', null).setPositiveButton('Xóa toàn bộ', () => { ledger.clear(); this.showLedger(); }).show()); ThemeUi.text(all, ThemeUi.DANGER); }
    this.gap(12); this.addButton('Về cài đặt', false, () => this.showSettings());
  }
  static shortDate(date) { return DateTimeFormatter.ofPattern('dd/MM/yy').format(date); }
  /** One entry per saved change; a swap shows both people in the same box, split by a divider. */
  historyCard(h, swap) {
    const card = el('div', 'card card--tap'); card.tabIndex = 0; card.setAttribute('role', 'button');
    const saved = DateTimeFormatter.ofPattern('dd/MM/yy HH:mm').format(Instant.ofEpochMilli(h.time).atZone(ZoneId.systemDefault())), day = MainActivity.shortDate(h.date);
    const restore = h.action.startsWith('Khôi phục'); const kind = swap != null ? 'Đổi ca' : restore ? 'Khôi phục' : h.action;
    card.append(this.text(kind + ' · lưu lúc ' + saved, 12, ACCENT));
    let spoken = kind + ' ngày ' + day + '. ';
    if (swap != null) {
      card.append(this.personBlock('Người thứ nhất', day, swap.ownerName, swap.ownerCode, null));
      card.append(el('div', 'divider'));
      card.append(this.personBlock('Người thứ hai', day, swap.partnerName, swap.partnerCode, swap.partnerConfirmed ? null : 'theo ảnh phân ống'));
      spoken += 'Người thứ nhất ' + swap.ownerName + ' làm mã ca ' + MainActivity.codeText(swap.ownerCode) + '. Người thứ hai ' + swap.partnerName + ' làm mã ca ' + MainActivity.codeText(swap.partnerCode) + '.';
    } else {
      card.append(this.line('Ngày: ' + day, 15, TEXT)); card.append(this.line('Tên: ' + Schedule.normalizePerson(h.owner), 15, TEXT)); card.append(this.line('Mã ca: ' + h.beforeLabel() + ' → ' + h.afterLabel(), 15, TEXT));
      spoken += Schedule.normalizePerson(h.owner) + ': ' + h.beforeLabel() + ' thành ' + h.afterLabel();
    }
    describe(card, spoken);
    const open = () => {
      const summary = swap == null ? '' : 'Người thứ nhất: ' + swap.ownerName + ' · làm mã ca ' + MainActivity.codeText(swap.ownerCode) + '\nNgười thứ hai: ' + swap.partnerName + ' · làm mã ca ' + MainActivity.codeText(swap.partnerCode) + (swap.partnerPrinted === swap.partnerName ? '' : '\nTên trên ảnh phân ống: ' + swap.partnerPrinted) + '\n\n';
      const body = linear(false, 'dlg-box'); body.append(this.text(summary + 'Lịch của bạn trước: ' + h.beforeLabel() + '\n\nLịch của bạn sau: ' + h.afterLabel(), 15, TEXT));
      const dialog = new ThemeUi.DialogBuilder(this).setTitle('Ngày ' + h.date.getDayOfMonth() + ' · ' + kind).setView(body)
        .setPositiveButton('Khôi phục trước lần này', () => this.confirmRestore(h)).setNeutralButton('Chỉnh sửa ngày', () => { this.openShiftEditor(); this.editDay(h.date.getDayOfMonth() - 1, true, DateChangeRow.Mode.MANUAL); }).setNegativeButton('Đóng', null).create();
      if (swap != null) { const rename = this.button('Sửa họ tên người thứ hai', false, () => { dialog.dismiss(); this.renamePartner(swap); }); rename.classList.add('btn--in-card'); body.append(rename); }
      dialog.show();
    };
    card.addEventListener('click', open); card.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
    return card;
  }
  /** The user types the exact full name from the work roster; every swap with that printed name shows it. */
  renamePartner(swap) {
    const box = linear(false, 'dlg-box');
    box.append(this.text('Tên trên ảnh phân ống: ' + swap.partnerPrinted, 13, MUTED)); const full = editText({ value: swap.partnerName, capWords: true, description: 'Họ tên đầy đủ của người đổi ca' }); box.append(full);
    const problem = this.text('', 12, ThemeUi.WARNING); problem.hidden = true; problem.setAttribute('role', 'alert'); box.append(problem);
    const dialog = new ThemeUi.DialogBuilder(this).setTitle('Sửa họ tên người thứ hai').setView(box).setNegativeButton('Quay lại', null).setPositiveButton('Xác nhận', null).create(); dialog.show();
    dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(() => { try { this.store.renamePartner(swap.partnerPrinted, full.value); dialog.dismiss(); this.showHistory(); Toast.makeText(this, 'Đã lưu họ tên.', Toast.LENGTH_SHORT).show(); } catch (e) { if (!isIAEorISE(e)) throw e; problem.textContent = e.message; problem.hidden = false; } });
  }
  static codeText(code) { return code == null ? 'Chưa rõ' : code; }
  line(value, size, color) { const t = this.text(value, size, color); t.classList.add('line'); return t; }
  personBlock(title, day, name, code, note) {
    const block = linear(false, 'person-block');
    const head = this.line(title, 13, MUTED); head.classList.add('bold'); block.append(head);
    block.append(this.line('Ngày: ' + day, 15, TEXT)); block.append(this.line('Tên: ' + name + (note == null ? '' : ' (' + note + ')'), 15, TEXT)); block.append(this.line('Làm mã ca: ' + MainActivity.codeText(code), 15, TEXT));
    return block;
  }
  confirmRestore(h) {
    new ThemeUi.DialogBuilder(this).setTitle('Khôi phục ngày ' + h.date.getDayOfMonth() + '?').setMessage('Lịch ngày này sẽ trở về:\n' + h.beforeLabel() + '\n\nCác ngày khác được giữ nguyên. Lần khôi phục này cũng được ghi vào lịch sử.')
      .setNegativeButton('Hủy', () => this.showHome()).setPositiveButton('Khôi phục', () => { try { const current = this.store.loadCombined(this.month); if (current == null) throw new IllegalArgumentException('Chưa có lịch.'); this.store.restore(current, h.id); CalendarWidget.refresh(this, false); this.showHome(); } catch (e) { if (!isIAEorISE(e)) throw e; this.error('Chưa khôi phục', e.message); } }).show();
  }
  /** No caller in APK 4.5 (kept as in the source). */
  help() { this.error('Cách dùng · phiên bản ' + BuildConfig.VERSION_NAME, HelpText.TEXT); }
  error(title, message) { AppLog.event('ui.error', AppLog.data('screen', 'MainActivity', 'title', title, 'message', message)); if (!this.isFinishing()) new ThemeUi.DialogBuilder(this).setTitle(title).setMessage(message).setPositiveButton('Đã hiểu', null).show(); }
  onBackPressed() {
    if (this.busy) { Toast.makeText(this, 'Đang xử lý, vui lòng đợi…', Toast.LENGTH_SHORT).show(); return; }
    if (this.inImport || this.resumePage41 === 'repairs') this.showHome(); else super.onBackPressed();
  }
  onDestroy() { super.onDestroy(); this.job++; this.worker.shutdownNow(); if (this._picker != null) this._picker.remove(); if (this.calendarView != null) { this.calendarView.release(); this.calendarView = null; } }
}

/** The calendar View of calendarCard: a <canvas> at the device pixel ratio, height = width × 1.2 (pipe/combined) or
 *  × 0.90, redrawn by invalidate(); hover (mouse) and press highlight; a tap on a day opens it (home only). */
class CalendarView {
  constructor(a, m, scene, draft, displayed) {
    this.a = a; this.m = m; this.scene = scene; this.draft = draft; this.displayed = displayed; this.hovered = null; this.pressedDate = null; this.pressed = 0; this.w = 0; this.h = 0;
    this.wrap = el('div', 'calendar'); this.canvas = el('canvas', 'calendar__canvas'); this.canvas.setAttribute('role', 'img'); this.wrap.append(this.canvas);
    const ratio = displayed != null && displayed.kind !== Schedule.WORK ? 1.2 : 0.90;
    this._resize = new ResizeObserver(entries => { const w = Math.floor(entries[0].contentRect.width); requestAnimationFrame(() => { if (w <= 0 || this._released) return; const h = Math.round(w * ratio); if (w === this.w && h === this.h) return; this.w = w; this.h = h; this.wrap.style.height = h + 'px'; this.invalidate(); }); }); // next frame: no ResizeObserver loop
    this._resize.observe(this.wrap);
    const pos = ev => { const r = this.canvas.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
    this.canvas.addEventListener('pointermove', ev => { if (ev.pointerType !== 'mouse') return; const [x, y] = pos(ev); this.hovered = CalendarPainter.hit(x, y, this.w, this.h, scene); this.invalidate(); });
    this.canvas.addEventListener('pointerleave', () => { if (this.hovered != null) { this.hovered = null; this.invalidate(); } });
    if (draft == null && displayed != null) {
      this.canvas.style.cursor = 'pointer';
      this.canvas.addEventListener('pointerdown', ev => { const [x, y] = pos(ev); const chosen = CalendarPainter.hit(x, y, this.w, this.h, scene); if (chosen != null && YearMonth.from(chosen).equals(m)) { this.pressedDate = chosen; this.pressed = 1; this.invalidate(); } });
      this.canvas.addEventListener('pointercancel', () => { this.pressedDate = null; this.pressed = 0; this.invalidate(); });
      this.canvas.addEventListener('pointerup', ev => { const [x, y] = pos(ev); this.pressedDate = null; this.pressed = 0; this.invalidate(); a._calendarTap(m, displayed, x, y, this.w, this.h); });
    }
  }
  /** Stops observing and frees the canvas backing store (a replaced or destroyed page). */
  release() { this._released = true; this._resize.disconnect(); this.canvas.width = 0; this.canvas.height = 0; }
  invalidate() {
    if (this.w <= 0 || this._released) return;
    const dpr = globalThis.devicePixelRatio || 1, c = this.canvas; c.width = Math.round(this.w * dpr); c.height = Math.round(this.h * dpr); c.style.width = this.w + 'px'; c.style.height = this.h + 'px';
    const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    CalendarPainter.draw(new Canvas2D(ctx), this.w, this.h, this.scene, this.a.palette(), LocalDate.now(), this.pressedDate == null ? new ThemeSettings(this.a).selected() : this.pressedDate, this.hovered, this.pressed);
  }
}

function bellIcon() {
  const ns = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('bell');
  const path = document.createElementNS(ns, 'path'); path.setAttribute('d', 'M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2z'); path.setAttribute('fill', 'currentColor'); svg.append(path); return svg;
}
