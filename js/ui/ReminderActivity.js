// Port of vn.lichdilam.ReminderActivity (APK 4.5): "Chuông thông báo". docs/UI-MAP-Settings.md (R1–R41) lists every
// view and text. Web adaptations (user decision 2 and the spec ruling; each marked where it happens):
//  - reminders fire only while the page is open (js/core/ReminderEngine.js + js/ui/ReminderRunner.js);
//  - Android-only controls are not built: "Duy trì nhắc lịch" (ReminderKeeper), "Chẩn đoán hẹn giờ / thử khi đóng
//    app" (ReminderDiagnosticsActivity), the channel / phone notification / exact alarm / battery buttons;
//  - "the needed permission" is the browser's Notification permission, asked inside the "Lưu cài đặt thông báo" tap;
//  - SoundWatch (the audio mixer's playback callback) → whether the page started a tone during the test;
//  - Switch → a checkbox switch, AutoCompleteTextView → <input list> suggestions, the clock InputFilter → beforeinput.
import { IllegalArgumentException, UUID } from '../platform/java.js';
import { JSONArray, JSONObject } from '../platform/json.js';
import { LocalDate, LocalTime, Instant, ZoneId, DateTimeFormatter } from '../platform/time.js';
import { Settings } from '../platform/android.js';
import { Toast } from '../platform/widget.js';
import { MediaPlayer } from '../platform/media.js';
import { NotificationManager } from '../platform/notification.js';
import { AppLog } from '../core/AppLog.js';
import { AppDataReset } from '../core/AppDataReset.js';
import { Schedule } from '../core/Schedule.js';
import { ClockInput } from '../core/ClockInput.js';
import { ReminderRule } from '../core/ReminderRule.js';
import { ReminderSettings } from '../core/ReminderSettings.js';
import { ReminderEngine } from '../core/ReminderEngine.js';
import { NotificationToneLibrary } from '../core/NotificationToneLibrary.js';
import { ThemedActivity } from './ThemedActivity.js';
import { ThemeUi } from './ThemeUi.js';
import { UiResume } from './UiResume.js';
import { NotificationTonePicker } from './NotificationTonePicker.js';
import { el, textView, buttonView, editText, spinner, describe } from './Views.js';

const PANEL = ThemeUi.PANEL, TEXT = ThemeUi.TEXT, MUTED = ThemeUi.MUTED, ACCENT = ThemeUi.ACCENT;
const fmt = (ms, pattern) => Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern(pattern));
let datalists = 0;

/** Switch: a checkbox drawn as a switch, with its text. */
function switchView(label, checked) {
  const view = el('label', 'switch'); const text = el('span', 'switch__text', label); ThemeUi.text(text, TEXT);
  const input = el('input'); input.type = 'checkbox'; input.setAttribute('role', 'switch'); input.checked = checked;
  view.append(text, input, el('span', 'switch__track')); return { view, input, isChecked: () => input.checked, setChecked: v => { input.checked = v; } };
}

export class ReminderActivity extends ThemedActivity {
  constructor() {
    super();
    this.rows = []; this.content = null; this.list = null; this.enabled = null; this.vibration = null; this.status = null; this.checks = null; this.pendingTests = null; this.tone = null; this.cancelTests = null;
    this.sound = null; this.soundName = null; this.savedState = ''; this.settings = null; this.tonePicker = null; this.importGroup = ''; this.importGeneration = 0; this.testCount = 0;
    this.preview = null; this._timers = new Set();
  }
  postDelayed(fn, ms) { const t = setTimeout(() => { this._timers.delete(t); fn(); }, ms); this._timers.add(t); }
  onCreate(state) {
    if (state == null) state = UiResume.restoreBundle(this); super.onCreate(state); this.settings = new ReminderSettings(this);
    this.sound = state == null ? this.settings.sound() : state.getString('sound', this.settings.sound()); this.soundName = state == null ? this.settings.soundName() : state.getString('soundName', this.settings.soundName());
    if (state != null) { this.importGroup = state.getString('importGroup', ''); this.testCount = state.getInt('testCount', 0); } this.importGeneration = AppDataReset.generation();
    const root = el('div', 'main'); const scroll = el('div', 'scroll'); this.content = el('div', 'page ra'); scroll.append(this.content); root.append(scroll); this.setContentView(root);
    const eyebrow = this.text('CHUÔNG THÔNG BÁO', 11, ACCENT); eyebrow.classList.add('eyebrow'); this.add(eyebrow); this.gap(8); const heading = this.text('Nhắc lịch đi làm', 28, TEXT); heading.classList.add('bold'); this.add(heading); this.gap(8); this.gap(18);
    this.enabled = switchView('Bật thông báo ca làm', state == null ? this.settings.enabled() : state.getBoolean('enabled')); this.add(this.enabled.view); this.gap(12);
    this.status = this.text('', 13, ThemeUi.WARNING); this.status.setAttribute('aria-live', 'polite'); this.add(this.status); this.gap(20); this.enabled.input.addEventListener('change', () => this.updateStatus());
    // "Duy trì nhắc lịch" (ReminderKeeper, an Android foreground service): not built (spec ruling).
    this.list = el('div', 'col'); this.add(this.list);
    try {
      if (state != null && state.containsKey('rows')) { const a = new JSONArray(state.getString('rows')); for (let i = 0; i < a.length(); i++) { const o = a.getJSONObject(i); const r = this.addRow(o.getString('id'), o.getString('code'), -1, o.getInt('before'), o.getBoolean('enabled')); r.hour.value = o.optString('hour', ''); r.minute.value = o.optString('minute', ''); r.updateTestLabel(); } }
      else for (const r of this.settings.rules()) this.addRow(r.id, r.code, r.minute, r.daysBefore, r.enabled);
    } catch (e) { this.error('Chưa đọc được cài đặt', e.message); this.enabled.setChecked(false); }
    if (this.rows.length === 0) this.addRow(String(UUID.randomUUID()), '', -1, 0, true);
    this.add(this.button('+  Thêm mã ca thông báo', false, () => this.addRow(String(UUID.randomUUID()), '', -1, 0, true))); this.gap(22);
    this.add(this.text('Âm thông báo tin nhắn', 18, TEXT)); this.gap(8); this.tone = this.button(this.soundName, false, () => this.chooseSound()); this.add(this.tone); this.gap(8);
    this.gap(8);
    const licenses = el('button', 'link', 'Nguồn âm và giấy phép'); licenses.type = 'button'; ThemeUi.text(licenses, ACCENT); licenses.addEventListener('click', () => this.showAudioLicenses()); this.add(licenses);
    this.vibration = switchView('Rung khi thông báo', state == null ? this.settings.vibrate() : state.getBoolean('vibrate')); this.add(this.vibration.view); this.gap(20);
    this.add(this.button('Lưu cài đặt thông báo', true, () => this.save(true))); this.gap(26);
    const checkTitle = this.text('Kiểm tra thông báo & âm thanh', 18, TEXT); checkTitle.classList.add('bold'); this.add(checkTitle); this.gap(6);
    this.gap(10);
    this.checks = this.text('', 13, TEXT); this.checks.classList.add('ra-checks'); ThemeUi.bg(this.checks, PANEL, 14); this.add(this.checks); this.gap(8);
    // "Chẩn đoán hẹn giờ / thử khi đóng app" (ReminderDiagnosticsActivity): not built (spec ruling).
    this.pendingTests = this.text('', 13, ACCENT); this.add(this.pendingTests); this.gap(8);
    this.cancelTests = this.button('Hủy các lần thử đang hẹn', false, () => { ReminderEngine.cancelTests(this); this.updateStatus(); }); this.add(this.cancelTests); this.gap(8);
    this.add(this.button('Phát thử âm đang chọn (qua loa, không qua thông báo)', false, () => this.playTone())); this.gap(8);
    // "Mở cài đặt kênh Nhắc ca", "Cài đặt thông báo trên điện thoại", "Cho phép nhắc đúng giờ", "Cho phép chạy nền
    // (bỏ tối ưu pin)": Android settings screens, not built (spec ruling).
    this.gap(16); this.add(this.button('Về lịch', false, () => this.leave()));
    this.savedState = this.savedStateOf();
  }
  text(value, size, color) { const t = textView(value, size, color); t.classList.add('ra-text'); return t; }
  button(label, primary, click) {
    const b = buttonView(label, primary); b.classList.add('btn--block', 'ra-button');
    b.addEventListener('click', () => { AppLog.event('user.action', AppLog.data('screen', this.constructor.name, 'action', b.textContent)); click(); }); return b;
  }
  add(v) { this.content.append(v); }
  gap(n) { const g = el('div', 'gap'); g.style.height = n + 'px'; this.content.append(g); }
  error(title, message) { new ThemeUi.DialogBuilder(this).setTitle(title).setMessage(message).setPositiveButton('Đã hiểu', null).show(); }
  addRow(id, code, minute, before, active) { const row = new Row(this, id, code, minute, before, active); this.rows.push(row); this.list.append(row.box); return row; }
  /** Separate [hour] : [minute] fields; out-of-range keystrokes are rejected, single digits are padded. */
  clock(hint, description, max) {
    const t = editText({ hint, numeric: true, description }); t.classList.add('field', 'ra-clock'); t.maxLength = 2;
    t.addEventListener('beforeinput', e => {
      if (!/^insert/.test(e.inputType)) return; const insertion = e.data ?? e.dataTransfer?.getData('text') ?? '';
      if (ClockInput.accept(t.value, t.selectionStart ?? t.value.length, t.selectionEnd ?? t.value.length, insertion, max) == null) e.preventDefault();
    });
    t.addEventListener('focus', () => { try { t.select(); } catch (ignored) { /* no selection */ } });
    t.addEventListener('blur', () => { try { const padded = ClockInput.pad(t.value); if (padded !== t.value) { t.value = padded; t.dispatchEvent(new Event('input')); } } catch (ignored) { /* not digits: kept for Save to report */ } });
    return t;
  }
  /** Comparable form of the screen; blank rows are ignored exactly as Save ignores them. */
  state() { try { const a = new JSONArray(); for (const r of this.rows) if (!r.blank()) a.put(r.state()); return this.enabled.isChecked() + '|' + this.vibration.isChecked() + '|' + this.sound + '|' + a; } catch (e) { return ''; } }
  savedStateOf() { try { const a = new JSONArray(); for (const r of this.settings.rules()) a.put(new JSONObject().put('id', r.id).put('code', r.code).put('hour', ClockInput.two(Math.trunc(r.minute / 60))).put('minute', ClockInput.two(r.minute % 60)).put('before', r.daysBefore).put('enabled', r.enabled)); return this.settings.enabled() + '|' + this.settings.vibrate() + '|' + this.settings.sound() + '|' + a; } catch (e) { return ''; } }
  dirty() { return this.state() !== this.savedState; }
  /** Saves the screen; returns null on success or the reason the settings could not be saved. */
  persist() {
    try {
      const rules = []; for (const row of this.rows) { const r = row.read(); if (r != null) rules.push(r); }
      if (this.enabled.isChecked() && !rules.some(r => r.enabled)) throw new IllegalArgumentException('Thêm ít nhất một mã ca và giờ nhắc, hoặc tắt thông báo ca làm.');
      const channelChanged = this.sound !== this.settings.sound() || this.vibration.isChecked() !== this.settings.vibrate();
      this.settings.save(rules, this.enabled.isChecked(), this.sound, this.soundName, this.vibration.isChecked());
      for (const row of this.rows) for (const field of [row.hour, row.minute]) { const padded = ClockInput.pad(field.value); if (padded !== field.value) { field.value = padded; row.updateTestLabel(); } }
      const channel = ReminderEngine.channel(this, this.settings); if (channelChanged) ReminderEngine.removeOldChannels(this, channel);
      ReminderEngine.reschedule(this); this.savedState = this.savedStateOf(); this.updateStatus(); return null;
    } catch (e) { return e?.message == null ? 'Không lưu được cài đặt thông báo.' : e.message; }
  }
  save(askPermission) {
    const problem = this.persist(); if (problem != null) { this.error('Chưa lưu', problem); return false; }
    if (askPermission) {
      try { ReminderEngine.applySoundChoice(this, this.settings); this.updateStatus(); } catch (e) { this.error('Chưa áp dụng được âm', e.message); return false; }
      Toast.makeText(this, 'Đã lưu cài đặt thông báo.', Toast.LENGTH_SHORT).show(); if (this.enabled.isChecked()) this.requestNeededPermission();
    }
    return true;
  }
  /** Back and "Về lịch" keep valid edits; invalid edits are never discarded silently. */
  leave() {
    if (!this.dirty()) { this.finish(); return; }
    const problem = this.persist();
    if (problem == null) { Toast.makeText(this, 'Đã lưu thay đổi thông báo.', Toast.LENGTH_SHORT).show(); this.finish(); return; }
    new ThemeUi.DialogBuilder(this).setTitle('Chưa lưu được thay đổi').setMessage(problem + '\n\nSửa lại để lưu, hoặc bỏ các thay đổi chưa lưu.').setNegativeButton('Bỏ thay đổi', () => this.finish()).setPositiveButton('Sửa lại', null).show();
  }
  onBackPressed() { this.leave(); }
  /** Web: the browser's Notification permission, asked inside this tap when it was never answered (iOS: only a
   *  home-screen web app has it). Exact alarms need no permission on the web. */
  requestNeededPermission() { if (ReminderEngine.permissionRequestable()) this.requestNotifications(); }
  requestNotifications() { NotificationManager.requestPermission().then(result => { AppLog.event('reminder.permission', AppLog.data('result', result)); this.onRequestPermissionsResult(23, result); }); }
  onRequestPermissionsResult(request, result) { if (this.isDestroyed()) return; ReminderEngine.reschedule(this); this.updateStatus(); if (request === 23 && result === 'granted') this.requestNeededPermission(); }
  onResume() { super.onResume(); ReminderEngine.reschedule(this); this.updateStatus(); }
  updateStatus() {
    if (this.status == null) return; let value;
    if (!ReminderEngine.allowed(this) || ReminderEngine.permissionRequestable()) value = 'Điện thoại chưa cho phép thông báo. Khi bật và lưu cài đặt, app sẽ yêu cầu quyền cần thiết.';
    else if (!this.settings.enabled()) value = this.enabled.isChecked() ? 'Chưa lưu: thông báo sẽ bật khi bạn bấm Lưu cài đặt thông báo hoặc rời màn hình.' : 'Thông báo đang tắt. Bật công tắc và Lưu cài đặt để dùng.';
    else if (!this.enabled.isChecked()) value = 'Chưa lưu: thông báo sẽ tắt khi bạn bấm Lưu cài đặt thông báo hoặc rời màn hình.';
    else { const next = ReminderEngine.runtime(this).getLong('nextAt', 0); value = next === 0 ? 'Chưa có ca phù hợp trong lịch đã lưu. App sẽ đặt nhắc khi bạn thêm hoặc sửa lịch.' : 'Lần nhắc tiếp theo: ' + fmt(next, 'HH:mm · dd/MM/yyyy'); } // web (user decision): the exact-alarm sentence is dropped
    const error = ReminderEngine.runtime(this).getString('lastError', ''); if (error !== '') value += '\n' + error; this.status.textContent = value;
    if (this.checks == null) return; const lines = []; for (const c of ReminderEngine.diagnose(this)) lines.push((c.ok ? '✓ ' : '✗ ') + c.title); this.checks.textContent = lines.join('\n');
    const tests = ReminderEngine.pendingTests(this); let planned = ''; for (const t of tests) planned += (planned.length === 0 ? 'Đang hẹn thử: ' : ', ') + fmt(t[0], 'HH:mm dd/MM');
    this.pendingTests.textContent = planned; this.pendingTests.hidden = tests.length === 0; this.cancelTests.hidden = tests.length === 0;
  }
  blockedForTest() {
    if (ReminderEngine.allowed(this)) return false;
    new ThemeUi.DialogBuilder(this).setTitle('Thông báo đang bị chặn').setMessage('Trình duyệt đang chặn thông báo của Lịch đi làm nên lần thử không thể hiện. Cho phép thông báo rồi thử lại.').setNegativeButton('Đóng', null).setPositiveButton('Cho phép', () => this.requestNotifications()).show();
    return true;
  }
  testNow(row) {
    if (this.blockedForTest()) return; this.stopTone();
    // A short pause keeps every press a real attempt.
    row.testNow.disabled = true; this.postDelayed(() => { row.testNow.disabled = false; }, 1500);
    const heardFrom = MediaPlayer.startCount; let tag; const attempt = ++this.testCount; const sent = LocalTime.now();
    try { tag = ReminderEngine.postTest(this, row.code.value, 'Thử ngay #' + attempt); } catch (e) { this.error('Chưa gửi được thông báo thử', e.message); return; }
    this.postDelayed(() => { if (this.isFinishing()) return; const shown = ReminderEngine.active(this, tag), heard = MediaPlayer.startCount > heardFrom; this.showTestResult(attempt, sent, shown, heard); }, 2500);
  }
  showTestResult(attempt, sent, shown, heard) {
    const list = ReminderEngine.diagnose(this); let text = 'Lần thử #' + attempt + ' lúc ' + sent.format(DateTimeFormatter.ofPattern('HH:mm:ss')) + '\n\n';
    text += (shown ? '✓ Thông báo đã có trong thanh thông báo.' : '✗ Không thấy thông báo thử trong thanh thông báo. Kiểm tra quyền và kênh bên dưới.') + '\n';
    text += (heard ? '✓ Hệ thống âm thanh đã ghi nhận một âm thông báo được phát.' : '✗ Không ghi nhận âm thông báo nào được phát trong 2 giây.') + '\n\n';
    let problem = false; for (const c of list) { text += c + '\n'; problem = problem || !c.ok; }
    if (!heard) text += problem ? '\nSửa các mục ✗ ở trên rồi bấm thử lại.' : '\nCác cài đặt app đọc được đều đạt. Nếu vẫn im lặng, kiểm tra mục Âm thanh của Lịch đi làm trong cài đặt thông báo của hãng điện thoại, rồi dùng Phát thử âm để kiểm tra loa.';
    text += '\n\nApp không nghe trực tiếp được loa; mục âm thanh dựa trên trạng thái trình duyệt báo lại.';
    // "Mở cài đặt kênh" (Android channel settings): not built (spec ruling).
    new ThemeUi.DialogBuilder(this).setTitle('Kết quả thử thông báo').setMessage(text.trim()).setPositiveButton('Đóng', null).show(); this.updateStatus();
  }
  testAt(row) {
    if (this.blockedForTest()) return;
    try {
      const minute = ClockInput.minuteOfDay(row.hour.value, row.minute.value); const at = ReminderEngine.scheduleTest(this, minute, row.code.value);
      const when = Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault()); const day = when.toLocalDate().equals(LocalDate.now()) ? 'hôm nay' : 'ngày ' + when.format(DateTimeFormatter.ofPattern('dd/MM/yyyy'));
      // Web: the APK's last sentence (close the app to test background delivery) is left out — the page delivers
      // only while it is open — and so is the exact-alarm sentence (user decision).
      new ThemeUi.DialogBuilder(this).setTitle('Đã hẹn thử lúc ' + when.format(DateTimeFormatter.ofPattern('HH:mm'))).setMessage('Thông báo thử sẽ đến ' + day + '. Lần thử này độc lập với lịch nhắc thật và không bị chặn bởi các lần thử trước.').setPositiveButton('Đã hiểu', null).show(); this.updateStatus();
    } catch (e) { if (!(e instanceof IllegalArgumentException)) throw e; this.error('Chưa hẹn thử', e.message); }
  }
  playTone() {
    this.stopTone(); let uri = this.sound === '' ? Settings.System.DEFAULT_NOTIFICATION_URI : this.sound; if (!ReminderEngine.readable(this, uri)) uri = Settings.System.DEFAULT_NOTIFICATION_URI;
    uri = ReminderEngine.audibleSound(this, uri); // web: the phone's default sound → the bundled default tone
    const player = new MediaPlayer(); this.preview = player;
    player.setOnPreparedListener(p => { if (this.preview === p) { p.start(); Toast.makeText(this, 'Đang phát qua âm lượng Thông báo. Không nghe thấy: kiểm tra âm lượng, Rung/Im lặng.', Toast.LENGTH_LONG).show(); } });
    player.setOnCompletionListener(() => this.stopTone()); player.setOnErrorListener(() => { this.stopTone(); this.error('Không phát được âm', 'Điện thoại không mở được tệp âm này. Chọn âm khác.'); return true; });
    try { player.setDataSource(this, uri); player.prepareAsync(); } catch (e) { this.stopTone(); this.error('Không phát được âm', e?.message == null ? 'Tệp âm không đọc được.' : e.message); }
  }
  stopTone() { if (this.preview != null) { this.preview.release(); this.preview = null; } }
  async showAudioLicenses() {
    try {
      const info = this.text(await NotificationToneLibrary.assetText(this, 'notification_audio_licenses.txt'), 12, TEXT); info.classList.add('ra-licenses');
      const scroll = el('div', 'ra-licenses-scroll'); scroll.append(info); new ThemeUi.DialogBuilder(this).setTitle('Nguồn âm và giấy phép').setView(scroll).setPositiveButton('Đóng', null).show();
    } catch (e) { this.error('Chưa đọc được giấy phép', e.message); }
  }
  chooseSound() { this.stopPreview(); new ThemeUi.DialogBuilder(this).setTitle('Âm thông báo tin nhắn').setItems(NotificationToneLibrary.LABELS, (d, index) => this.showToneGroup(NotificationToneLibrary.IDS[index])).setNegativeButton('Đóng', null).show(); }
  async showToneGroup(group) {
    this.stopPreview(); if (this.tonePicker != null) this.tonePicker.close(); const index = NotificationToneLibrary.IDS.indexOf(group); if (index < 0) return;
    try {
      const sounds = await NotificationToneLibrary.load(this, group); if (this.isDestroyed()) return;
      this.tonePicker = new NotificationTonePicker(this, sounds, {
        confirm: chosen => {
          this.settings.saveSound(chosen.uri, chosen.name); this.select(chosen.uri, chosen.name); ReminderEngine.applySoundChoice(this, this.settings); ReminderEngine.reschedule(this);
          // Only the tone was saved; the baseline is re-read from storage so other edits stay unsaved.
          this.savedState = this.savedStateOf(); this.updateStatus(); Toast.makeText(this, 'Đã chọn âm: ' + chosen.name, Toast.LENGTH_SHORT).show();
        },
        back: () => this.chooseSound(),
      });
      this.tonePicker.show(NotificationToneLibrary.LABELS[index], this.sound, NotificationToneLibrary.SOURCES[index]);
    } catch (e) { this.error('Chưa mở được danh sách âm', e.message); }
  }
  select(uri, name) { this.stopPreview(); this.sound = uri; this.soundName = name; this.tone.textContent = name; }
  // onActivityResult(32) / importSound: no caller in APK 4.5 (request 32 is never started) — not ported.
  stopPreview() { if (this.tonePicker != null) this.tonePicker.stop(); this.stopTone(); }
  onPause() {
    this.stopPreview();
    // Leaving through Home or another app keeps valid edits, without permission prompts.
    if (!this.isFinishing() && this.dirty()) this.persist();
    super.onPause();
  }
  onDestroy() { for (const t of this._timers) clearTimeout(t); this._timers.clear(); if (this.tonePicker != null) this.tonePicker.close(); this.stopTone(); super.onDestroy(); }
  onSaveInstanceState(state) {
    super.onSaveInstanceState(state); if (this.enabled == null) return;
    state.putString('importGroup', this.importGroup); state.putString('sound', this.sound); state.putString('soundName', this.soundName); state.putBoolean('enabled', this.enabled.isChecked()); state.putBoolean('vibrate', this.vibration.isChecked()); state.putInt('testCount', this.testCount);
    const a = new JSONArray(); for (const r of this.rows) a.put(new JSONObject().put('id', r.id).put('code', r.code.value).put('hour', r.hour.value).put('minute', r.minute.value).put('before', r.before.selectedIndex).put('enabled', r.active.isChecked())); state.putString('rows', a.toString());
  }
}

class Row {
  constructor(a, id, value, saved, offset, checked) {
    this.a = a; this.id = id;
    const box = this.box = el('div', 'col ra-row'); ThemeUi.bg(box, PANEL, 14);
    const titles = el('div', 'row ra-row__titles'); titles.append(a.text('Mã ca', 13, MUTED), a.text('Giờ thông báo (Giờ : Phút)', 13, MUTED)); box.append(titles);
    const fields = el('div', 'row ra-row__fields');
    const code = this.code = editText({ hint: 'S10, D5…', value, capChars: true, maxLength: 8, description: 'Mã ca thông báo' }); code.classList.add('ra-code');
    const choices = new Set(['S10', 'S26', 'D5', 'C23', 'S17', 'D6', 'HC', 'BT', 'P', 'OFF']); for (const s of ReminderEngine.calendars(a)) for (const c of s.shifts) if (c != null && c !== '') choices.add(c);
    const list = el('datalist'); list.id = 'ra-codes-' + (++datalists); for (const c of [...choices].sort()) { const o = el('option'); o.value = c; list.append(o); } code.setAttribute('list', list.id);
    fields.append(code, list);
    const clock = el('div', 'row ra-clock-box');
    const hour = this.hour = a.clock('HH', 'Giờ thông báo, 00 đến 23', ClockInput.HOUR_MAX); const minute = this.minute = a.clock('mm', 'Phút thông báo, 00 đến 59', ClockInput.MINUTE_MAX);
    if (saved >= 0) { hour.value = ClockInput.two(Math.trunc(saved / 60)); minute.value = ClockInput.two(saved % 60); }
    const colon = a.text(':', 22, TEXT); colon.classList.add('ra-colon');
    clock.append(hour, colon, minute); fields.append(clock); box.append(fields);
    hour.enterKeyHint = 'next';
    const hourChanged = () => { const v = hour.value; if (document.activeElement === hour && ClockInput.complete(v, ClockInput.HOUR_MAX)) { if (v.length === 1) { hour.value = ClockInput.pad(v); hourChanged(); return; } minute.focus(); minute.select(); } this.updateTestLabel(); };
    hour.addEventListener('input', hourChanged);
    minute.addEventListener('input', () => { const v = minute.value; if (document.activeElement === minute && v.length === 1 && ClockInput.complete(v, ClockInput.MINUTE_MAX)) { minute.value = ClockInput.pad(v); minute.setSelectionRange(2, 2); } this.updateTestLabel(); });
    minute.addEventListener('keydown', e => { if (e.key === 'Backspace' && minute.value.length === 0) { e.preventDefault(); hour.focus(); hour.setSelectionRange(hour.value.length, hour.value.length); } });
    const before = this.before = spinner(['Trong ngày làm việc', 'Hôm trước ngày làm việc'], 'Ngày gửi thông báo'); before.selectedIndex = offset; box.append(before);
    const footer = el('div', 'row ra-row__footer'); this.active = switchView('Nhắc mã ca này', checked); this.active.view.classList.add('grow'); footer.append(this.active.view);
    const remove = a.button('×', false, () => { a.rows.splice(a.rows.indexOf(this), 1); box.remove(); }); remove.classList.remove('btn--block'); remove.classList.add('ra-remove'); describe(remove, 'Xóa mã ca thông báo'); footer.append(remove); box.append(footer);
    const tests = el('div', 'row ra-row__tests'); this.testNow = a.button('Thử ngay', false, () => a.testNow(this)); this.testAt = a.button('', false, () => a.testAt(this));
    for (const b of [this.testNow, this.testAt]) { b.classList.remove('btn--block'); b.classList.add('ra-test'); } tests.append(this.testNow, this.testAt); box.append(tests); this.updateTestLabel();
  }
  updateTestLabel() { if (this.testAt == null) return; const h = this.hour.value, m = this.minute.value; let hh = h, mm = m; try { hh = h === '' ? '--' : ClockInput.pad(h); } catch (e) { hh = h; } try { mm = m === '' ? '--' : ClockInput.pad(m); } catch (e) { mm = m; } this.testAt.textContent = 'Hẹn thử lúc ' + hh + ':' + mm; }
  blank() { return this.code.value.trim() === '' && this.hour.value.length === 0 && this.minute.value.length === 0; }
  read() { if (this.blank()) return null; const value = this.code.value.trim(); return new ReminderRule(this.id, value, ClockInput.minuteOfDay(this.hour.value, this.minute.value), this.before.selectedIndex, this.active.isChecked()); }
  state() { return new JSONObject().put('id', this.id).put('code', Schedule.canonicalToken(this.code.value)).put('hour', ClockInput.pad(this.hour.value)).put('minute', ClockInput.pad(this.minute.value)).put('before', this.before.selectedIndex).put('enabled', this.active.isChecked()); }
}
