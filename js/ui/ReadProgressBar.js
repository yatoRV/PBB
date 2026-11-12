// The reading progress bar of both readers (web only, Task A2; the user's reference: dark navy panel, rounded pill
// track with a thin cyan neon outline and soft glow, cyan → blue fill, big "NN%" caption — the percent, never the word
// "Loading"). Variants: 'smooth' (fill with a glowing knob, work roster) and 'segments' (block segments, pipe sheets).
// Light and dark versions follow the app theme (css/app.css .rbar tokens).
//  - Accessibility: role="progressbar" with aria-valuemin/max/now and aria-valuetext "37% – <stage>"; a polite live
//    region speaks the percent at most every LIVE_MS (or at 25/50/75/100 %), never on every tick.
//  - Cost: set() only stores the values; one requestAnimationFrame writes them (transform / text only, no layout
//    reads), so a burst of OCR calls costs one paint, and a hidden page does nothing. The fill moves by transform.
import { el } from './Views.js';

export const LIVE_MS = 15_000;
const raf = fn => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));

export class ReadProgressBar {
  /** variant: 'smooth' | 'segments'; label: accessible name of the progress bar. */
  constructor({ variant = 'smooth', label = 'Tiến độ đọc ảnh', now = () => Date.now() } = {}) {
    this._now = now; this._want = { percent: 0, stage: '', eta: null }; this._shown = { percent: -1, stage: null, eta: undefined }; this._frame = false;
    this._spoken = -1; this._spokenAt = -Infinity;
    const root = this.element = el('div', 'rbar rbar--' + variant);
    const value = el('p', 'rbar__value'); value.setAttribute('aria-hidden', 'true');
    this._num = el('span', 'rbar__num', '0'); value.append(this._num, el('span', 'rbar__unit', '%'));
    const track = this._track = el('div', 'rbar__track');
    track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', label); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100'); track.setAttribute('aria-valuenow', '0'); track.setAttribute('aria-valuetext', '0%');
    const reveal = this._reveal = el('div', 'rbar__reveal'); this._fill = el('div', 'rbar__fill'); reveal.append(this._fill); track.append(reveal);
    if (variant === 'smooth') { this._head = el('div', 'rbar__head'); this._head.append(el('span', 'rbar__knob')); track.append(this._head); } else this._head = null;
    this._eta = el('p', 'rbar__eta'); this._eta.hidden = true;
    this._live = el('p', 'rbar__live'); this._live.setAttribute('aria-live', 'polite');
    root.append(value, track, this._eta, this._live);
    this._paint(0);
  }
  /** New values (batched to the next frame). percent: 0–100 (never shown lower than before); eta: text or null. */
  set(percent, stage = this._want.stage, eta = this._want.eta) {
    const p = Math.max(this._want.percent, Math.min(100, Math.max(0, Math.floor(percent))));
    this._want = { percent: p, stage: String(stage ?? ''), eta: eta ?? null };
    if (!this._frame) { this._frame = true; raf(() => { this._frame = false; this._render(); }); }
  }
  _paint(p) {
    const f = p / 100;
    this._reveal.style.transform = 'translateX(' + ((f - 1) * 100).toFixed(2) + '%)';
    this._fill.style.transform = 'translateX(' + ((1 - f) * 100).toFixed(2) + '%)';
    if (this._head != null) this._head.style.transform = 'translateX(' + (f * 100).toFixed(2) + '%)';
  }
  _render() {
    const { percent, stage, eta } = this._want, s = this._shown;
    if (percent !== s.percent) { this._num.textContent = String(percent); this._track.setAttribute('aria-valuenow', String(percent)); this._paint(percent); this.element.classList.toggle('rbar--done', percent >= 100); }
    if (percent !== s.percent || stage !== s.stage) this._track.setAttribute('aria-valuetext', percent + '%' + (stage !== '' ? ' – ' + stage : ''));
    if (eta !== s.eta) { this._eta.textContent = eta ?? ''; this._eta.hidden = eta == null; }
    this._shown = { percent, stage, eta };
    const t = this._now(), milestone = Math.floor(percent / 25) > Math.floor(Math.max(0, this._spoken) / 25);
    if (percent !== this._spoken && (milestone || t - this._spokenAt >= LIVE_MS)) { this._spoken = percent; this._spokenAt = t; this._live.textContent = percent + '%' + (stage !== '' ? ' – ' + stage : ''); }
  }
  /** Brings the bar into view (on a phone the import form puts it below the fold); no animation with reduced motion. */
  reveal() {
    const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    raf(() => { try { this.element.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' }); } catch (e) { /* not attached */ } });
  }
  /** 100 % at once (the read is done). */
  finish(stage) { this.set(100, stage); }
  /** Values as last written to the page (tests). */
  get shown() { return { ...this._shown }; }
}
