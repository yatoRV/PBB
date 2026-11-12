// android.app.AlertDialog (+ Builder), android.content.DialogInterface and android.widget.Toast for DOM screens.
// Browser only: the document is touched when a dialog or toast is created, never at import (Node tests import the
// screens' modules). A dialog is a modal <dialog> element (js/shell/session.js holds back a remote reload while one
// is open). Android semantics kept:
//  - a button made by setPositive/Negative/NeutralButton(label, listener) runs the listener, then dismisses; a click
//    listener set later on getButton(which) replaces that (no automatic dismiss);
//  - an item of setItems(labels, listener) runs the listener, then dismisses;
//  - back (Escape, the router's back) and a tap outside cancel: onCancel, then onDismiss;
//  - the show, cancel and dismiss listeners are posted (they run after the call that caused them, as Android's
//    Dialog sends them through its Handler).
// Button order follows Material AlertDialog: neutral on the left, then negative, then positive.

const post = fn => Promise.resolve().then(fn);

export const DialogInterface = Object.freeze({ BUTTON_POSITIVE: -1, BUTTON_NEGATIVE: -2, BUTTON_NEUTRAL: -3 });

/** One dialog button (the android.widget.Button of getButton): the element plus Android's listener API. */
class DialogButton {
  constructor(dialog, which, label, listener) {
    this.dialog = dialog; this.which = which;
    const el = this.el = document.createElement('button');
    el.type = 'button'; el.className = 'dlg__button' + (which === DialogInterface.BUTTON_POSITIVE ? ' dlg__button--positive' : '');
    el.textContent = label;
    this._click = () => { if (listener != null) listener(dialog, which); dialog.dismiss(); };
    el.addEventListener('click', ev => { ev.stopPropagation(); this._click(this); });
  }
  setOnClickListener(fn) { this._click = fn ?? (() => {}); }
  setEnabled(enabled) { this.el.disabled = !enabled; }
  setText(text) { this.el.textContent = text; }
  getText() { return this.el.textContent; }
  performClick() { this.el.click(); return true; }
}

export class AlertDialog {
  static BUTTON_POSITIVE = DialogInterface.BUTTON_POSITIVE;
  static BUTTON_NEGATIVE = DialogInterface.BUTTON_NEGATIVE;
  static BUTTON_NEUTRAL = DialogInterface.BUTTON_NEUTRAL;
  constructor(context, p) {
    this.context = context; this._showing = false; this._gone = false; this._buttons = new Map();
    this._onShow = null; this._onCancel = null; this._onDismiss = null; this._cancelOnOutside = true;
    const el = this._el = document.createElement('dialog');
    el.className = 'dlg' + (p.theme ? ' dlg--' + p.theme : '');
    el.setAttribute('aria-modal', 'true');
    const card = document.createElement('div'); card.className = 'dlg__card'; el.append(card);
    if (p.title != null) {
      const title = document.createElement('h2'); title.className = 'dlg__title'; title.textContent = p.title; card.append(title);
      el.setAttribute('aria-label', p.title);
    }
    const body = this._body = document.createElement('div'); body.className = 'dlg__body'; card.append(body);
    if (p.message != null) { const m = document.createElement('p'); m.className = 'dlg__message'; m.textContent = p.message; body.append(m); }
    if (p.items != null) {
      const list = document.createElement('div'); list.className = 'dlg__items'; list.setAttribute('role', 'list');
      p.items.forEach((label, index) => {
        const item = document.createElement('button'); item.type = 'button'; item.className = 'dlg__item'; item.textContent = label; item.setAttribute('role', 'listitem');
        item.addEventListener('click', ev => { ev.stopPropagation(); if (p.itemsListener != null) p.itemsListener(this, index); this.dismiss(); });
        list.append(item);
      });
      body.append(list);
    }
    if (p.view != null) body.append(p.view);
    const bar = document.createElement('div'); bar.className = 'dlg__buttons';
    for (const [which, b] of [[DialogInterface.BUTTON_NEUTRAL, p.neutral], [DialogInterface.BUTTON_NEGATIVE, p.negative], [DialogInterface.BUTTON_POSITIVE, p.positive]]) {
      if (b == null) continue; const button = new DialogButton(this, which, b.label, b.listener); this._buttons.set(which, button); bar.append(button.el);
      if (which === DialogInterface.BUTTON_NEUTRAL) { const spring = document.createElement('span'); spring.className = 'dlg__spring'; bar.append(spring); }
    }
    if (this._buttons.size > 0) card.append(bar);
    // Escape / back: cancel. A tap on the backdrop (outside the card): cancel.
    el.addEventListener('cancel', ev => { ev.preventDefault(); if (p.cancelable !== false) this.cancel(); });
    el.addEventListener('click', ev => { if (ev.target === el && this._cancelOnOutside && p.cancelable !== false) this.cancel(); });
  }
  getButton(which) { return this._buttons.get(which) ?? null; }
  /** Window.getDecorView(): the dialog element (UiSessionLog observes it). */
  getWindow() { if (this._window == null) { const el = this._el; this._window = { getDecorView: () => el }; } return this._window; }
  setOnShowListener(fn) { this._onShow = fn; }
  setOnCancelListener(fn) { this._onCancel = fn; }
  setOnDismissListener(fn) { this._onDismiss = fn; }
  setCanceledOnTouchOutside(v) { this._cancelOnOutside = !!v; }
  isShowing() { return this._showing; }
  show() {
    if (this._showing || this._gone) return;
    this._showing = true; document.body.append(this._el);
    try { this._el.showModal(); } catch (e) { this._el.setAttribute('open', ''); }
    AlertDialog._open.push(this);
    post(() => { if (this._onShow != null) this._onShow(this); });
  }
  cancel() { if (!this._showing) return; post(() => { if (this._onCancel != null) this._onCancel(this); }); this.dismiss(); }
  dismiss() {
    if (!this._showing) return;
    this._showing = false; this._gone = true;
    const i = AlertDialog._open.indexOf(this); if (i >= 0) AlertDialog._open.splice(i, 1);
    try { this._el.close(); } catch (e) { this._el.removeAttribute('open'); }
    this._el.remove();
    post(() => { if (this._onDismiss != null) this._onDismiss(this); });
  }
  /** The dialog on top, or null (the router's back cancels it first). */
  static top() { return AlertDialog._open.length === 0 ? null : AlertDialog._open[AlertDialog._open.length - 1]; }
  static _open = [];

  static Builder = class Builder {
    constructor(context, theme = null) { this._context = context; this._p = { theme }; }
    getContext() { return this._context; }
    setTitle(title) { this._p.title = title; return this; }
    setMessage(message) { this._p.message = message; return this; }
    setView(view) { this._p.view = view; return this; }
    setItems(items, listener) { this._p.items = [...items]; this._p.itemsListener = listener; return this; }
    setPositiveButton(label, listener) { this._p.positive = { label, listener }; return this; }
    setNegativeButton(label, listener) { this._p.negative = { label, listener }; return this; }
    setNeutralButton(label, listener) { this._p.neutral = { label, listener }; return this; }
    setCancelable(cancelable) { this._p.cancelable = cancelable; return this; }
    create() { return new AlertDialog(this._context, this._p); }
    show() { const d = this.create(); d.show(); return d; }
  };
}

/** android.widget.Toast: one message at a time at the bottom of the page; later toasts wait their turn. */
export class Toast {
  static LENGTH_SHORT = 0;
  static LENGTH_LONG = 1;
  static _queue = [];
  static _current = null;
  constructor(text, duration) { this._text = text; this._duration = duration; }
  static makeText(context, text, duration) { return new Toast(String(text), duration); } // eslint-disable-line no-unused-vars
  show() { Toast._queue.push(this); if (Toast._current == null) Toast._next(); }
  static _next() {
    const t = Toast._queue.shift(); Toast._current = t ?? null; if (t == null) return;
    const el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite'); el.textContent = t._text;
    document.body.append(el);
    requestAnimationFrame(() => el.classList.add('toast--in'));
    setTimeout(() => { el.classList.remove('toast--in'); setTimeout(() => { el.remove(); Toast._next(); }, 200); }, t._duration === Toast.LENGTH_LONG ? 3500 : 2000);
  }
}
