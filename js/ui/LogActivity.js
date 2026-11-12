// Port of vn.lichdilam.LogActivity (APK 4.5): in-app session browser and explicit, local export. Viewing never
// copies the log back into itself. docs/UI-MAP-Settings.md (G1–G9).
// Web adaptations: "Lưu ZIP" (ACTION_CREATE_DOCUMENT) and "Chia sẻ" (the Android share sheet) both download the same
// ZIP through a Blob link (spec ruling); "Chẩn đoán hẹn giờ / thử sau 2 phút" (ReminderDiagnosticsActivity) is not
// built (spec ruling).
import { Executors } from '../platform/java.js';
import { FileInputStream } from '../platform/files.js';
import { AppLog } from '../core/AppLog.js';
import { ThemedActivity } from './ThemedActivity.js';
import { ThemeUi } from './ThemeUi.js';
import { UiResume } from './UiResume.js';
import { el, textView, buttonView, spinner, setItems, describe } from './Views.js';

const kb = bytes => new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false }).format(bytes / 1024.0);

export class LogActivity extends ThemedActivity {
  constructor() { super(); this.worker = Executors.newSingleThreadExecutor(); this.sessions = null; this.status = null; this.body = null; this.files = []; this.exported = null; this.request = 0; this.busy = false; }
  onCreate(state) {
    if (state == null) state = UiResume.restoreBundle(this); super.onCreate(state);
    const content = el('div', 'la'); ThemeUi.solid(content, ThemeUi.BG);
    const title = textView('Log hoạt động', 24, ThemeUi.TEXT); title.id = 'la-title'; content.append(title);
    // "Chẩn đoán hẹn giờ / thử sau 2 phút" (ReminderDiagnosticsActivity): not built (spec ruling).
    // Accessibility (web): the title names the session list and the focusable log region.
    this.sessions = spinner([]); this.sessions.setAttribute('aria-labelledby', 'la-title'); content.append(this.sessions); this.status = textView('', 12, ThemeUi.MUTED); this.status.setAttribute('aria-live', 'polite'); content.append(this.status);
    const actions = el('div', 'row la-actions'); actions.append(this.button('Làm mới', () => this.refresh()), this.button('Lưu ZIP', () => this.export(false)), this.button('Chia sẻ', () => this.export(true))); content.append(actions);
    const scroll = el('div', 'la-scroll'); scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-labelledby', 'la-title'); this.body = el('pre', 'la-body'); ThemeUi.text(this.body, ThemeUi.TEXT); scroll.append(this.body); content.append(scroll);
    const close = this.button('Đóng', () => this.finish()); close.classList.add('la-close'); content.append(close); this.setContentView(content);
    this.sessions.addEventListener('change', () => this.showSession(this.sessions.selectedIndex)); this.refresh();
  }
  button(text, action) { const b = buttonView(text, false); b.classList.add('la-button'); ThemeUi.text(b, ThemeUi.ACCENT); b.addEventListener('click', () => { AppLog.event('user.action', AppLog.data('screen', 'LogActivity', 'action', text)); action(); }); return b; }
  refresh() {
    if (this.busy) return; this.busy = true; this.status.textContent = 'Đang đọc các phiên log…';
    this.worker.execute(async () => {
      await AppLog.flush(); const log = AppLog.current(); const loaded = log == null ? [] : [...log.journal.sessions()]; loaded.reverse();
      this.runOnUiThread(() => {
        if (this.isDestroyed()) return; this.busy = false; this.files = loaded; const labels = []; for (const file of this.files) labels.push(file.getName() + ' · ' + kb(file.length()) + ' KB');
        setItems(this.sessions, labels); this.sessions.selectedIndex = labels.length === 0 ? -1 : 0; if (this.files.length === 0) this.status.textContent = 'Chưa có log. ' + AppLog.error(); else this.showSession(0);
      });
    });
  }
  showSession(at) {
    if (at < 0 || at >= this.files.length) return; const selected = this.files[at]; const token = ++this.request;
    this.worker.execute(async () => {
      try { await AppLog.flush(); const value = AppLog.current().journal.tail(selected, 64 * 1024); this.runOnUiThread(() => { if (this.isDestroyed() || token !== this.request) return; this.body.textContent = value; this.status.textContent = this.files.length + ' phiên' + (AppLog.error() === '' ? '' : '\nLỗi ghi log: ' + AppLog.error()); }); }
      catch (failure) { this.showFailure(failure); }
    });
  }
  export(share) {
    if (this.busy) return; this.busy = true; this.status.textContent = 'Đang đóng gói toàn bộ log…';
    this.worker.execute(async () => {
      try {
        const file = await AppLog.export();
        this.runOnUiThread(() => {
          if (this.isDestroyed()) return; this.exported = file; this.busy = false; this.status.textContent = 'Đã tạo ZIP · ' + file.length() + ' byte.';
          this.download(file); if (!share) this.onSaved(file);
        });
      } catch (failure) { this.showFailure(failure); }
    });
  }
  /** Web: the save-as dialog / share sheet → the browser downloads the ZIP (a Blob link, released afterwards). */
  download(file) {
    const url = URL.createObjectURL(new Blob([new FileInputStream(file).readAllBytes()], { type: 'application/zip' }));
    const link = el('a'); link.href = url; link.download = file.getName(); link.rel = 'noopener'; link.hidden = true; describe(link, file.getName()); document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  onSaved(source) { AppLog.event('log.saved', AppLog.data('uri', 'download:' + source.getName(), 'bytes', source.length())); this.status.textContent = 'Đã lưu toàn bộ log.'; }
  showFailure(failure) { AppLog.failure('log.viewer', failure); this.runOnUiThread(() => { if (!this.isDestroyed()) { this.busy = false; this.status.textContent = 'Chưa hoàn tất: ' + failure.message; } }); }
  onDestroy() { super.onDestroy(); this.worker.shutdown(); }
}
