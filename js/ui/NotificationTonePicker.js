// Port of vn.lichdilam.NotificationTonePicker (APK 4.5). Audition is temporary. Only the explicit confirmation
// callback may change the saved tone. docs/UI-MAP-Settings.md (N1–N5).
// Web: the MediaPlayer is js/platform/media.js (the Ogg file is decoded on the first tap of a tone — the browser's
// decoder, else the pinned Ogg Vorbis decoder — and played with WebAudio); a new tap stops the previous tone.
import { AlertDialog } from '../platform/widget.js';
import { MediaPlayer } from '../platform/media.js';
import { ThemeUi } from './ThemeUi.js';
import { el, textView } from './Views.js';

export class NotificationTonePicker {
  /** listener = { confirm(tone), back() }. */
  constructor(activity, tones, listener) { this.activity = activity; this.tones = tones; this.listener = listener; this.player = null; this.generation = 0; this.selected = -1; this.ready = false; this.status = null; this.dialog = null; this._timers = new Set(); }
  _postDelayed(fn, ms) { const t = setTimeout(() => { this._timers.delete(t); fn(); }, ms); this._timers.add(t); }
  show(title, savedUri, source) {
    const body = el('div', 'col ntp'); this.status = textView(source, 13, ThemeUi.MUTED); this.status.classList.add('ntp-status'); this.status.setAttribute('aria-live', 'polite'); body.append(this.status);
    if (this.tones.length !== 0) {
      const list = el('div', 'ntp-list'); list.setAttribute('role', 'radiogroup'); list.setAttribute('aria-label', title);
      let current = -1; for (let i = 0; i < this.tones.length; i++) if (this.tones[i].uri === savedUri) current = i;
      const name = 'ntp-' + Math.random().toString(36).slice(2);
      this.tones.forEach((tone, position) => {
        const row = el('label', 'ntp-row'); const radio = el('input'); radio.type = 'radio'; radio.name = name; radio.checked = position === current; radio.setAttribute('aria-label', tone.name);
        const label = el('span', null, tone.name); ThemeUi.text(label, ThemeUi.TEXT); row.append(label, radio);
        radio.addEventListener('change', () => this.audition(position)); row.addEventListener('click', e => { if (e.target !== radio && radio.checked) { e.preventDefault(); this.audition(position); } });
        list.append(row);
      });
      list.style.maxHeight = Math.min(52 * this.tones.length, Math.round((globalThis.innerHeight || 700) * 0.43)) + 'px';
      body.append(list);
    }
    this.dialog = new ThemeUi.DialogBuilder(this.activity).setTitle(title).setView(body).setNegativeButton('Quay lại', () => this.listener.back()).setPositiveButton('Xác nhận', null).create();
    this.dialog.setOnCancelListener(() => this.listener.back()); this.dialog.setOnDismissListener(() => this.stop()); this.dialog.show(); this.dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false);
    this.dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(() => { if (this.ready && this.selected >= 0) { try { this.listener.confirm(this.tones[this.selected]); this.dialog.dismiss(); } catch (e) { this.status.textContent = e.message; } } });
  }
  audition(position) {
    this.stop(); this.selected = position; this.ready = false; this.dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false); this.status.textContent = 'Đang nghe: ' + this.tones[position].name;
    const ticket = this.generation; const candidate = new MediaPlayer(); this.player = candidate;
    candidate.setOnPreparedListener(p => { if (ticket !== this.generation || this.player !== p) return; try { p.start(); this.ready = true; this.dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(true); this._postDelayed(() => this.stop(), 30000); } catch (e) { this.failed(ticket); } });
    candidate.setOnErrorListener(() => { this.failed(ticket); return true; });
    candidate.setOnCompletionListener(() => { if (ticket === this.generation) { this.stop(); this.status.textContent = 'Đã nghe: ' + this.tones[position].name; } });
    try { candidate.setDataSource(this.activity, this.tones[position].uri); candidate.prepareAsync(); } catch (e) { this.failed(ticket); }
  }
  failed(ticket) { if (ticket !== this.generation) return; this.stop(); this.ready = false; this.dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false); this.status.textContent = 'Không đọc được tệp âm này. Thêm lại tệp hoặc chọn âm khác.'; }
  stop() { this.generation++; for (const t of this._timers) clearTimeout(t); this._timers.clear(); if (this.player != null) { this.player.release(); this.player = null; } }
  close() { this.stop(); if (this.dialog != null) this.dialog.dismiss(); }
}
