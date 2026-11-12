// Checkpoints of a reading job (web only, Task A2): every OCR call a job makes is kept in IndexedDB, keyed by what
// decides its result — the engine and its model version, the exact input pixels (SHA-256 of the RGBA bytes) and the
// image size. A reader started again from the beginning (page reloaded, tab killed, "Hủy" then "Đọc tiếp") runs the
// ported Java logic unchanged, and each OCR call it already made is answered from here at once. The engine is
// deterministic, so the replayed read returns exactly what an uninterrupted read returns. Outside a job (no
// beginJob) calls go straight to the engine, as before.
//
// Store "calls" of the database "lich-di-lam-ocr" (separate from the per-account data copy of js/cloud/user-cache.js),
// every key prefixed with the Google account id (sub) so one account never reads another's entries:
//   sub \0 c \0 <call key>             -> { r: result JSON, n: bytes, t: time }    the OCR result
//   sub \0 j \0 <job id> \0 <call key> -> 1                                       the job used that call
//   sub \0 t \0 <job id>               -> time                                    the job's last use
// Bounded: at most MAX_ENTRIES results (oldest jobs dropped first, never the running one). A job's entries are dropped
// when it is confirmed or discarded (dropJob), every entry of other accounts when the account changes (setAccount),
// and everything of an account at sign-out (clearAccount).
import { checkedPixels, Text } from './TextRecognizer.js';

const DB_NAME = 'lich-di-lam-ocr';
const DB_VERSION = 1;
const CALLS = 'calls';
const SEP = '\u0000';
/** Most results kept (a work roster or pipe sheet makes 190–400 calls; a result is a few kB of JSON). */
export const MAX_ENTRIES = 3000;
/** A call slower than this may have hit the readers' 60 s Tasks.await limit (or the page was suspended meanwhile). */
export const SLOW_CALL_MS = 55_000;
/** Part of every call key: bump when the OCR models or their pre/post-processing change (old results then unused). */
export const CHECKPOINT_REVISION = 1;

const done = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const finished = tx => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted')); });

/** SHA-256 needs a secure context (https or localhost): without it no job and no checkpoint, reads go on as before. */
export const hashAvailable = () => typeof globalThis.crypto?.subtle?.digest === 'function';
/** An IndexedDB lookup that does not answer within this time is a miss (the store is then off for the page). */
export const LOOKUP_MS = 2000;
/** Lookups timed out in a row before the store is switched off for the page (one slow lookup is only a miss). */
export const MAX_LOOKUP_TIMEOUTS = 3;
const TIMED_OUT = Symbol('timed out');
function withTimeout(promise, ms) {
  if (!(ms > 0)) return promise; let timer = null;
  return Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(TIMED_OUT), ms); })]).finally(() => clearTimeout(timer));
}
export async function sha256Hex(bytes) {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  let s = ''; for (const b of d) s += (b < 16 ? '0' : '') + b.toString(16); return s;
}

/** The IndexedDB side. indexedDB / IDBKeyRange are injectable (tests). Every request of a transaction is issued
 *  synchronously (older Safari ends a transaction at the first promise turn). */
export class CheckpointStore {
  constructor({ indexedDB = globalThis.indexedDB, IDBKeyRange = globalThis.IDBKeyRange } = {}) { this._idb = indexedDB; this._range = IDBKeyRange; this._db = null; }
  get available() { return this._idb != null && this._range != null; }
  async _open() {
    if (this._db) return this._db;
    const req = this._idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(CALLS)) db.createObjectStore(CALLS); };
    this._db = await done(req); return this._db;
  }
  _prefix(p) { return this._range.bound(p, p + '￿', false, true); }
  async _keys(prefix) { const db = await this._open(); const tx = db.transaction([CALLS], 'readonly'); const r = done(tx.objectStore(CALLS).getAllKeys(prefix == null ? undefined : this._prefix(prefix))); await finished(tx); return r; }
  /** The stored result text of a call, or null. */
  async get(sub, key) {
    const db = await this._open(); const tx = db.transaction([CALLS], 'readonly'); const r = done(tx.objectStore(CALLS).get(sub + SEP + 'c' + SEP + key)); await finished(tx);
    const v = await r; return v == null ? null : v.r;
  }
  /** Records that `job` used the call (result stored by put, or found by get). */
  async mark(sub, job, key, now = Date.now()) {
    const db = await this._open(); const tx = db.transaction([CALLS], 'readwrite'); const s = tx.objectStore(CALLS);
    s.put(1, sub + SEP + 'j' + SEP + job + SEP + key); s.put(now, sub + SEP + 't' + SEP + job); await finished(tx);
  }
  async put(sub, job, key, text, now = Date.now()) {
    const db = await this._open(); const tx = db.transaction([CALLS], 'readwrite'); const s = tx.objectStore(CALLS);
    s.put({ r: text, n: text.length, t: now }, sub + SEP + 'c' + SEP + key); s.put(1, sub + SEP + 'j' + SEP + job + SEP + key); s.put(now, sub + SEP + 't' + SEP + job);
    await finished(tx);
  }
  /** Deletes one stored result (a damaged entry). */
  async remove(sub, key) { const db = await this._open(); const tx = db.transaction([CALLS], 'readwrite'); tx.objectStore(CALLS).delete(sub + SEP + 'c' + SEP + key); await finished(tx); }
  /** Call keys the job used. */
  async jobKeys(sub, job) { const p = sub + SEP + 'j' + SEP + job + SEP; return (await this._keys(p)).map(k => k.substring(p.length)); }
  /** Job ids that have entries, with their last use. */
  async jobs(sub) {
    const p = sub + SEP + 't' + SEP; const keys = await this._keys(p);
    const db = await this._open(); const tx = db.transaction([CALLS], 'readonly'); const s = tx.objectStore(CALLS);
    const reads = keys.map(k => done(s.get(k))); await finished(tx); const times = await Promise.all(reads);
    return keys.map((k, i) => ({ job: k.substring(p.length), t: Number(times[i]) || 0 }));
  }
  async count(sub) { return (await this._keys(sub + SEP + 'c' + SEP)).length; }
  /** Drops the job's marks and every result no other job of the account used. */
  async dropJob(sub, job) {
    const all = await this._keys(sub + SEP + 'j' + SEP); const mine = sub + SEP + 'j' + SEP + job + SEP;
    const others = new Set(); const drop = [];
    for (const k of all) { if (k.startsWith(mine)) drop.push(k); else { const rest = k.substring(sub.length + 3); others.add(rest.substring(rest.indexOf(SEP) + 1)); } }
    const db = await this._open(); const tx = db.transaction([CALLS], 'readwrite'); const s = tx.objectStore(CALLS);
    for (const k of drop) { s.delete(k); const key = k.substring(mine.length); if (!others.has(key)) s.delete(sub + SEP + 'c' + SEP + key); }
    s.delete(sub + SEP + 't' + SEP + job);
    await finished(tx);
  }
  /** Results without any job mark (their job was dropped elsewhere, e.g. a reset). */
  async dropUnmarked(sub) {
    const used = new Set((await this._keys(sub + SEP + 'j' + SEP)).map(k => { const rest = k.substring(sub.length + 3); return rest.substring(rest.indexOf(SEP) + 1); }));
    const p = sub + SEP + 'c' + SEP; const stale = (await this._keys(p)).filter(k => !used.has(k.substring(p.length)));
    if (stale.length === 0) return 0;
    const db = await this._open(); const tx = db.transaction([CALLS], 'readwrite'); const s = tx.objectStore(CALLS); for (const k of stale) s.delete(k); await finished(tx);
    return stale.length;
  }
  /** Deletes every entry of the account (sub), or of every account but `keep` (keepOnly). */
  async clear({ sub = null, keepOnly = null } = {}) {
    const keys = await this._keys(null); const drop = keys.filter(k => (sub != null ? k.startsWith(sub + SEP) : keepOnly == null || !k.startsWith(keepOnly + SEP)));
    if (drop.length === 0) return;
    const db = await this._open(); const tx = db.transaction([CALLS], 'readwrite'); const s = tx.objectStore(CALLS); for (const k of drop) s.delete(k); await finished(tx);
  }
}

/**
 * Explicit sign-out marker (localStorage, survives the reload and new tabs): the accounts whose checkpoints a page
 * starting signed out must delete. A page that is merely signed out (new tab, browser restart, iOS closed the tab,
 * token older than an hour: the session is per tab) keeps them, so the read can still be continued after signing in.
 */
export const SIGNED_OUT_KEY = 'lich-di-lam:ocr-signed-out';
const signedOutList = storage => { try { const v = JSON.parse(storage?.getItem(SIGNED_OUT_KEY) ?? '[]'); return Array.isArray(v) ? v.map(String) : []; } catch (e) { return []; } };
/** "Đăng xuất": the account's checkpoints are to be deleted (also by the next signed-out start). */
export function markSignedOut(storage, sub) {
  if (sub == null) return; const list = signedOutList(storage); if (!list.includes(String(sub))) list.push(String(sub));
  try { storage?.setItem(SIGNED_OUT_KEY, JSON.stringify(list)); } catch (e) { /* private mode: the sign-out itself cleared them */ }
}
/** Signed in again: the account's checkpoints are wanted again. */
export function unmarkSignedOut(storage, sub) {
  const list = signedOutList(storage).filter(s => s !== String(sub));
  try { if (list.length === 0) storage?.removeItem(SIGNED_OUT_KEY); else storage?.setItem(SIGNED_OUT_KEY, JSON.stringify(list)); } catch (e) { /* nothing marked */ }
}
/** A page starting signed out: deletes the checkpoints of the accounts that signed out explicitly, then the marker. */
export async function clearSignedOut({ storage, store }) {
  const list = signedOutList(storage); if (list.length === 0 || store == null) return 0;
  for (const sub of list) await store.clear({ sub });
  try { storage?.removeItem(SIGNED_OUT_KEY); } catch (e) { /* cleared anyway */ }
  return list.length;
}

/** The checkpoint state of the page: the account, the running job, slow calls. */
class Checkpoints {
  constructor() { this.store = null; this.sub = null; this.job = null; this._slow = new Map(); this._pending = new Set(); this._inflight = new Map(); this.slowAfterMs = SLOW_CALL_MS; this.hits = 0; this.misses = 0; this._listeners = new Set(); this.lookupMs = LOOKUP_MS; this._lookupTimeouts = 0; }
  /** Calls of the job still running that started more than SLOW_CALL_MS ago (the reader may have given up on them). */
  slowRunning(id, t = Date.now()) { let n = 0; for (const c of this._inflight.values()) if (c.job === id && t - c.started > this.slowAfterMs) n++; return n; }
  /** The readers' OCR wait limit (s) now: a call is slow 5 s before it. The pipe reader raises it while it reads
   *  several photos at once (Task A4: a call may then queue behind the other photos' calls without timing out). */
  readerWait(seconds) { this.slowAfterMs = seconds * 1000 - 5000; }
  /** Waits (at most maxMs) until no call of the job is running, and its results are stored. */
  async settle(id, maxMs = 90_000) {
    const until = Date.now() + maxMs;
    while ([...this._inflight.values()].some(c => c.job === id) && Date.now() < until) await Promise.race([...[...this._inflight.values()].filter(c => c.job === id).map(c => c.done), new Promise(r => setTimeout(r, 1000))]);
    await this.flush();
  }
  /** Store to use (null: none, every call goes to the engine). */
  use(store) { this.store = store != null && store.available !== false ? store : null; return this; }
  get enabled() { return this.store != null && this.sub != null; }
  /** The signed-in account: other accounts' entries are deleted (an account switch on this device). */
  async setAccount(sub) {
    this.sub = sub == null || sub === '' ? null : String(sub); this.job = null;
    if (this.store == null) return;
    try { await this.store.clear({ keepOnly: this.sub ?? '￿' }); } catch (e) { /* the entries stay unreachable for this account */ }
  }
  /** Sign-out: deletes everything of the account. */
  async clearAccount(sub = this.sub) {
    // No account from now on: calls still running write nothing (checkpointed checks the account at write time).
    this.job = null; if (sub != null && String(sub) === this.sub) this.sub = null;
    if (this.store == null || sub == null) return;
    await this.flush(); await this.store.clear({ sub: String(sub) });
  }
  /** OCR calls from now on belong to the job (until endJob). */
  beginJob(id) { this.job = id; this._slow.delete(id); this.hits = 0; this.misses = 0; }
  endJob(id) { if (this.job === id) this.job = null; }
  /** A call of the job took longer than slowAfterMs (SLOW_CALL_MS by default): the reader may have timed out on it. */
  slow(id) { return this._slow.get(id) ?? 0; }
  /** fn({hit}) after every OCR call of a job (progress). Returns an unsubscribe function. */
  onCall(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _call(hit) { if (hit) this.hits++; else this.misses++; for (const fn of this._listeners) try { fn({ hit }); } catch (e) { /* progress only */ } }
  /** Waits for the IndexedDB writes issued so far. */
  async flush() { while (this._pending.size) await Promise.allSettled([...this._pending]); }
  _track(p) { const q = p.catch(() => {}).finally(() => this._pending.delete(q)); this._pending.add(q); return q; }
  /** The job is confirmed or discarded: its entries go. */
  async dropJob(id) { if (this.store == null || this.sub == null || id == null) return; await this.flush(); try { await this.store.dropJob(this.sub, id); } catch (e) { /* retried by prune */ } }
  /**
   * Keeps the store bounded: results nobody uses go, then whole jobs (least recently used first, never `keep` or the
   * running job) until at most `max` results remain. `live(id)` false: the job record is gone (reset, other device).
   */
  async prune({ live = () => true, keep = [], max = MAX_ENTRIES } = {}) {
    if (this.store == null || this.sub == null) return;
    try {
      await this.flush(); const sub = this.sub; const protect = new Set([...keep, this.job].filter(x => x != null));
      const jobs = (await this.store.jobs(sub)).sort((a, b) => a.t - b.t);
      for (const j of jobs) if (!protect.has(j.job) && !live(j.job)) await this.store.dropJob(sub, j.job);
      await this.store.dropUnmarked(sub);
      for (const j of jobs) { if ((await this.store.count(sub)) <= max) break; if (!protect.has(j.job) && live(j.job)) await this.store.dropJob(sub, j.job); }
    } catch (e) { /* tried again next time */ }
  }
}
/** The page's checkpoints (one per page, like the OCR engine). */
export const OcrCheckpoint = new Checkpoints();

/**
 * Wraps an OCR engine (js/ocr/TextRecognizer.js contract): inside a job, each call is looked up by
 * engineId | modelVersion | width x height | SHA-256(RGBA) and answered from the store (a new object each time);
 * otherwise the engine reads it and the plain result is stored. The pixels are copied before the first await (the
 * reader may recycle its bitmap). The same call made again while the first is still running waits for it.
 */
export function checkpointed(engine, { engineId = engine.name ?? 'engine', modelVersion = '', state = OcrCheckpoint, now = () => Date.now() } = {}) {
  const running = new Map();
  const forward = (data, width, height, options) => engine.process({ data, owned: true, getWidth: () => width, getHeight: () => height, isRecycled: () => false }, options);
  return {
    name: engine.name, modelVersion, // part of every key (Task A5: tests read it)
    get inner() { return engine; },
    process(bitmap, options) {
      const job = state.job, sub = state.sub, store = state.store;
      if (job == null || sub == null || store == null || !hashAvailable()) return engine.process(bitmap, options);
      let data, width, height;
      try { const px = checkedPixels(bitmap); width = bitmap.getWidth(); height = bitmap.getHeight(); data = new Uint8ClampedArray(px); } catch (e) { return Promise.reject(e); }
      // Writes only while the same account is signed in with the same store (a sign-out meanwhile stops them).
      const current = () => state.sub === sub && state.store === store;
      return (async () => {
        const key = [engineId, modelVersion, 'r' + CHECKPOINT_REVISION, width + 'x' + height, await sha256Hex(data)].join('|');
        let text = null;
        try { text = await withTimeout(store.get(sub, key), state.lookupMs); state._lookupTimeouts = 0; }
        catch (e) { text = null; if (e === TIMED_OUT && state.store === store && ++state._lookupTimeouts >= MAX_LOOKUP_TIMEOUTS) state.use(null); } // IndexedDB stuck (old iOS): off for this page after a few in a row
        if (text != null) {
          let parsed = null; try { parsed = JSON.parse(text); } catch (broken) { parsed = null; }
          if (parsed != null && Array.isArray(parsed.textBlocks)) { if (current()) state._track(store.mark(sub, job, key, now())); state._call(true); return parsed; }
          if (current()) state._track(store.remove(sub, key)); // a damaged entry: read again
        }
        let shared = running.get(key);
        if (shared == null) {
          const started = now();
          // Shared until the result is in the store, so a repeat in between never reaches the engine again.
          shared = forward(data, width, height, options).then(result => {
            if (now() - started > state.slowAfterMs) state._slow.set(job, (state._slow.get(job) ?? 0) + 1);
            if (result != null && Array.isArray(result.textBlocks) && !(result instanceof Text)) {
              const json = JSON.stringify(result);
              if (current()) state._track(store.put(sub, job, key, json, now())).then(() => running.delete(key)); else running.delete(key);
              return json;
            }
            running.delete(key); return result;
          }, e => { running.delete(key); throw e; });
          running.set(key, shared);
          const token = {}; state._inflight.set(token, { job, started, done: shared.catch(() => {}) }); shared.then(() => state._inflight.delete(token), () => state._inflight.delete(token));
        }
        const out = await shared; state._call(false);
        return typeof out === 'string' ? JSON.parse(out) : out;
      })();
    },
    warm: () => engine.warm?.(),
    close: () => engine.close?.(),
  };
}
