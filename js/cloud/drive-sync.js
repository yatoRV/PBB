// Autosave of the signed-in user's data to their own Google Drive, with an IndexedDB copy per account.
//
// Drive layout (folder App-Lich-Di-Lam, created by this app, so the drive.file scope can see it):
//   du-lieu.json — { schema, app, version, updatedAt, prefs: <prefs.js exportState>, files: { dirs, files: [[path,
//                    base64, mtime]] } (files up to LARGE_FILE_BYTES), large: [{ path, name, id, size, mtime, sha256 }] }
//   one Drive file per larger app file (photos), named after its app path ("files__photos__x.jpg") and found
//   through the `large` index. Deleting the folder resets the user's data at the next sign-in.
// Device-local (never on Drive, never a reason to upload): the session logs (files/session-logs, AppLog.DIRECTORY)
// and the cache directory. They are kept in this device's IndexedDB copy only.
//
// Two separate paths:
//   local  — every change is written to IndexedDB LOCAL_SAVE_MS later (LOCAL_ONLY_SAVE_MS for device-local files),
//            and at once by flush(), even while an upload is running;
//   upload — a shared change marks the data dirty; DEBOUNCE_MS after the last change (at most MAX_WAIT_MS after the
//            first) the shared state is uploaded. A 401 asks for a new token on the next user gesture
//            (onAuthNeeded); offline waits for retry().
// Several devices: every upload first checks that du-lieu.json still has the Drive `version` this device last
// saw (its base). If another device wrote meanwhile, the Drive copy is downloaded and merged three-way against the
// base — per (preference file, key) and per file path, a value this device changed since the base wins, anything
// else comes from Drive — and only then uploaded. check() (page visible again) pulls Drive changes while this
// device has none of its own. Another device's changes are applied only while mayApplyRemote() allows it (the
// screens are not in the middle of an edit): otherwise nothing is applied, the base stays where it was, uploads
// wait, and onRemoteWaiting() asks the app to call resumeRemote() later; a save made meanwhile is then merged
// against the old base, so values a screen rewrote unchanged never undo the other device's edit.
// onRemoteChange() tells the app that its state was replaced under it (it reloads).
// A large file whose Drive copy is gone (404) is "missing": a device without its bytes keeps the index entry (a
// phantom: path, id, sha256, flagged missing in du-lieu.json) instead of dropping the path, and a device that still
// has the bytes uploads them again.
import { exportState as exportPrefs, importState as importPrefs, onPrefsChange } from '../platform/prefs.js';
import { exportState as exportFiles, importState as importFiles, onFilesChange, DATA_DIR } from '../platform/files.js';
import { Base64 } from '../platform/java.js';
import { BuildConfig } from '../platform/android.js';
import { DRIVE_FOLDER_NAME } from '../config.js';
import { AuthError, NetworkError, DriveError } from './drive-api.js';

export const DATA_FILE = 'du-lieu.json';
export const SCHEMA_VERSION = 1;
/** Files larger than this are kept as their own Drive files instead of inside du-lieu.json. */
export const LARGE_FILE_BYTES = 256 * 1024;
/** Photos (app files named *.image: the work-roster photo, the pipe source copies, reading-job photos) are always
 *  their own Drive files, never inside du-lieu.json, whatever their size (Task A2). */
export const isPhotoPath = path => String(path).endsWith('.image');
const isLarge = f => f.size > LARGE_FILE_BYTES || isPhotoPath(f.path);
export const DEBOUNCE_MS = 1500;
export const MAX_WAIT_MS = 10000;
/** Delay before a change is written to IndexedDB (device-local files: LOCAL_ONLY_SAVE_MS). */
export const LOCAL_SAVE_MS = 200;
export const LOCAL_ONLY_SAVE_MS = 2000;
/** Retry delay after a Drive error that is neither offline nor an expired token (quota, server error). */
export const RETRY_MS = 60000;
/** Directories that stay on this device: AppLog's session logs (AppLog.DIRECTORY) and the cache directory. */
export const DEVICE_LOCAL_DIRS = Object.freeze([DATA_DIR + '/files/session-logs', DATA_DIR + '/cache']);
/** Preference files that stay on this device: the screens' UI drafts (UiResume.PREFS "ui-resume41") and the in-page
 *  reminder runner's state (ReminderEngine.RUNTIME_PREFS "reminders-device": planned queue, delivered guard, manual
 *  tests, next time, last error — this page's timers). They are never uploaded, never mark the data dirty and are kept
 *  in the IndexedDB copy. The reminder settings ("reminders") stay shared. */
export const DEVICE_LOCAL_PREFS = Object.freeze(['ui-resume41', 'reminders-device']);

export class RestoreError extends Error { constructor(message, cause) { super(message); this.name = 'RestoreError'; this.cause = cause; } }

/** The app state: every preference file (prefs.js) and every app file (files.js). */
export const platformState = {
  capture: () => ({ prefs: exportPrefs(), files: exportFiles() }),
  apply: s => { importPrefs(s.prefs ?? {}); importFiles(s.files ?? { dirs: [], files: [] }); },
  subscribe: fn => { const a = onPrefsChange(fn), b = onFilesChange(fn); return () => { a(); b(); }; },
};

export const isDeviceLocal = path => DEVICE_LOCAL_DIRS.some(d => path === d || path.startsWith(d + '/'));
export const isDeviceLocalPrefs = name => DEVICE_LOCAL_PREFS.includes(name);
const sharedPrefs = prefs => Object.fromEntries(Object.entries(prefs ?? {}).filter(([name]) => !isDeviceLocalPrefs(name)));
const localPrefs = prefs => Object.fromEntries(Object.entries(prefs ?? {}).filter(([name]) => isDeviceLocalPrefs(name)));
/** Drive name of a large app file: its path below the data directory with "/" written as "__". */
export function driveName(path) {
  let p = String(path); if (p.startsWith(DATA_DIR + '/')) p = p.substring(DATA_DIR.length + 1);
  return p.replace(/^\/+/, '').replace(/\//g, '__');
}
export async function sha256Hex(bytes) {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  let s = ''; for (const b of d) s += (b < 16 ? '0' : '') + b.toString(16); return s;
}
/** Content fingerprint of a small file (two 32-bit hashes + length), recomputed on every capture. */
export function quickDigest(bytes) {
  let h1 = 0x811c9dc5, h2 = 5381;
  for (let i = 0; i < bytes.length; i++) { const b = bytes[i]; h1 = Math.imul(h1 ^ b, 16777619); h2 = (Math.imul(h2, 33) + b) | 0; }
  return 'f' + (h1 >>> 0).toString(16) + '.' + (h2 >>> 0).toString(16) + '.' + bytes.length;
}
const utf8 = s => new TextEncoder().encode(s);
const is404 = e => e instanceof DriveError && e.status === 404;
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const noRemote = () => ({ folderId: null, docId: null, version: null, large: [] });
const EMPTY_BASE = Object.freeze({ docId: null, version: null, prefs: {}, dirs: [], digests: [] });
const EMPTY = Object.freeze({ updatedAt: 0, prefs: {}, dirs: [], files: [] });

// ------------------------------------------------------------------ snapshots and the three-way merge
// A snapshot is { prefs: {name: [[key, type, value]]}, dirs: [path], files: [{path, bytes, mtime, size, sha256, digest}] }.
/** The part of a snapshot that goes to Drive (device-local files and directories removed). */
export function sharedOf(s) { return { prefs: sharedPrefs(s.prefs), dirs: s.dirs.filter(d => !isDeviceLocal(d)), files: s.files.filter(f => !isDeviceLocal(f.path)) }; }
/** Shared state plus the device-local part of `device`. */
function withDeviceLocal(shared, device) {
  return { prefs: { ...sharedPrefs(shared.prefs), ...localPrefs(device.prefs) }, dirs: [...shared.dirs, ...device.dirs.filter(isDeviceLocal)], files: [...shared.files, ...device.files.filter(f => isDeviceLocal(f.path))].sort(byPath) };
}
/** The base: what Drive held when this device was last in step with it (digests only for files). */
function baseOf(shared, docId, version) { return { docId, version, prefs: shared.prefs, dirs: [...shared.dirs], digests: shared.files.map(f => [f.path, f.digest]) }; }
const entryKey = e => JSON.stringify(e[1] === 'set' ? [e[1], [...e[2]].sort()] : [e[1], e[2]]);
const entryMap = entries => new Map((entries ?? []).map(e => [e[0], e]));
/**
 * Three-way merge of shared states: local L and remote R against the base B. Per (preference file, key) and per
 * file path, what L changed since B wins (including removals); everything else is taken from R. Directories:
 * R's, plus those L created, minus those L removed.
 */
export function mergeShared(L, R, B) {
  const prefs = {};
  for (const name of new Set([...Object.keys(R.prefs), ...Object.keys(L.prefs), ...Object.keys(B.prefs ?? {})])) {
    const lm = entryMap(L.prefs[name]), rm = entryMap(R.prefs[name]), bm = entryMap(B.prefs?.[name]); const out = [];
    for (const k of new Set([...rm.keys(), ...lm.keys(), ...bm.keys()])) {
      const l = lm.get(k), b = bm.get(k);
      const localChanged = (l == null) !== (b == null) || (l != null && entryKey(l) !== entryKey(b));
      const e = localChanged ? l : rm.get(k);
      if (e != null) out.push(e);
    }
    if (out.length || name in L.prefs || name in R.prefs) prefs[name] = out;
  }
  const lf = new Map(L.files.map(f => [f.path, f])), rf = new Map(R.files.map(f => [f.path, f])), bd = new Map(B.digests ?? []);
  // Listed by R but its content is gone from Drive: unknown, not deleted — keep L's bytes, else R's phantom entry.
  const missing = R.missing ?? new Map();
  const files = [];
  for (const p of new Set([...rf.keys(), ...lf.keys(), ...bd.keys()])) {
    const l = lf.get(p), b = bd.get(p) ?? null;
    // A base written before photos were always large (Task A2) holds the small-file digest of a small photo: compare
    // like with like, so an unchanged photo is not taken for a local change (no stale win, no resurrection).
    const ld = b != null && b.startsWith('f') && l != null && l.bytes != null && (l.digest ?? '').startsWith('s') ? quickDigest(l.bytes) : (l?.digest ?? null);
    const localChanged = ld !== b;
    const f = localChanged ? l : missing.has(p) ? (l ?? rf.get(p)) : rf.get(p);
    if (f != null) files.push(f);
  }
  const ld = new Set(L.dirs), bdirs = new Set(B.dirs ?? []);
  const dirs = new Set([...R.dirs, ...L.dirs.filter(d => !bdirs.has(d))]);
  for (const d of bdirs) if (!ld.has(d)) dirs.delete(d);
  return { prefs, dirs: [...dirs].sort(), files: files.sort(byPath) };
}
/** Same preferences, file contents and directories. */
export function sameShared(a, b) {
  const ad = new Set(a.dirs);
  if (ad.size !== new Set(b.dirs).size || !b.dirs.every(d => ad.has(d))) return false;
  for (const name of new Set([...Object.keys(a.prefs), ...Object.keys(b.prefs)])) {
    const am = entryMap(a.prefs[name]), bm = entryMap(b.prefs[name]);
    if (am.size !== bm.size) return false;
    for (const [k, e] of am) { const o = bm.get(k); if (o == null || entryKey(o) !== entryKey(e)) return false; }
  }
  if (a.files.length !== b.files.length) return false;
  const bf = new Map(b.files.map(f => [f.path, f.digest]));
  return a.files.every(f => bf.get(f.path) === f.digest);
}

/** The merge has real bytes for a path whose Drive copy is missing: it must be uploaded again. */
const resupplies = (merged, R) => merged.files.some(f => !f.phantom && R.missing.has(f.path));

export class DriveSync {
  /**
   * api: DriveApi; cache: UserCache; sub: Google account id; log(type, data): diagnostics (AppLog);
   * onAuthNeeded(): a call needs a new token (ask on the next user gesture, then call retry());
   * onRemoteChange({merged}): the app state was replaced by (or merged with) another device's save;
   * mayApplyRemote(): false while the screens must not have their state replaced (an edit is in progress);
   * onRemoteWaiting(): a remote change waits for mayApplyRemote() — call resumeRemote() once it is true.
   * state / timers / now / hash are injectable for tests.
   */
  constructor({ api, cache, sub, folderName = DRIVE_FOLDER_NAME, state = platformState, timers = globalThis, now = () => Date.now(),
    hash = sha256Hex, log = () => {}, onAuthNeeded = () => {}, onRemoteChange = () => {}, mayApplyRemote = () => true, onRemoteWaiting = () => {},
    debounceMs = DEBOUNCE_MS, maxWaitMs = MAX_WAIT_MS, retryMs = RETRY_MS }) {
    Object.assign(this, { _api: api, _cache: cache, sub, _folderName: folderName, _state: state, _timers: timers, _now: now, _hash: hash, _log: log,
      _onAuthNeeded: onAuthNeeded, _onRemoteChange: onRemoteChange, _mayApplyRemote: mayApplyRemote, _onRemoteWaiting: onRemoteWaiting,
      _debounceMs: debounceMs, _maxWaitMs: maxWaitMs, _retryMs: retryMs });
    this._remoteWaiting = false; this._phantoms = new Map();
    this._remote = noRemote(); this._base = null; this._changedAt = 0; this._seq = 0; this.dirty = false; this._firstPending = null;
    this._uploadTimer = null; this._localTimer = null; this._localDue = 0; this._retryTimer = null;
    this._running = null; this._again = false; this._suppress = 0; this._cacheChain = Promise.resolve(); this._cacheFailed = false;
    this._unsubscribe = null; this._hashes = new Map(); this._failure = null; this._folderChecked = false; this._trashAfter = new Set(); this._uncommitted = new Map();
    this._stopped = false; this.status = 'idle'; this._statusListeners = new Set();
  }
  /** fn(status): 'idle' | 'pending' | 'saving' | 'saved' | 'offline' | 'auth' | 'error'. Returns an unsubscribe function. */
  onStatus(fn) { this._statusListeners.add(fn); return () => this._statusListeners.delete(fn); }
  _setStatus(s) { if (this.status === s) return; this.status = s; for (const fn of this._statusListeners) fn(s); }

  // ---------------------------------------------------------------- snapshots
  async _digest(f) {
    if (f.phantom) { f.digest = 's' + f.sha256; return f; }
    if (!isLarge(f)) { f.digest = quickDigest(f.bytes); return f; }
    let h = this._hashes.get(f.path);
    if (f.sha256 && (!h || h.sha256 !== f.sha256)) { h = { mtime: f.mtime, size: f.size, sha256: f.sha256 }; this._hashes.set(f.path, h); }
    if (!h || h.mtime !== f.mtime || h.size !== f.size) { h = { mtime: f.mtime, size: f.size, sha256: await this._hash(f.bytes) }; this._hashes.set(f.path, h); }
    f.sha256 = h.sha256; f.digest = 's' + h.sha256; return f;
  }
  async _capture() {
    const { prefs, files } = this._state.capture(); const out = [];
    for (const [path, bytes, mtime] of files.files) out.push(await this._digest({ path, bytes, mtime, size: bytes.length, sha256: null, digest: null }));
    // Phantoms (large files known only by their Drive entry) stay part of the state until real bytes replace them.
    const present = new Set(out.map(f => f.path));
    for (const [p, f] of this._phantoms) { if (present.has(p)) this._phantoms.delete(p); else out.push(f); }
    out.sort(byPath);
    return { updatedAt: this._changedAt, prefs, dirs: files.dirs, files: out };
  }
  _apply(s) {
    this._phantoms = new Map(s.files.filter(f => f.phantom).map(f => [f.path, f]));
    this._suppress++;
    try { this._state.apply({ prefs: s.prefs, files: { dirs: s.dirs, files: s.files.filter(f => !f.phantom).map(f => [f.path, f.bytes, f.mtime]) } }); }
    finally { this._suppress--; }
  }

  // ---------------------------------------------------------------- restore
  /**
   * Loads the user's data (Drive and this device's IndexedDB copy), installs it into prefs/files and starts
   * listening for changes. A copy with changes Drive does not have is merged with Drive (three-way against the base
   * it started from) and uploaded. Throws RestoreError when Drive cannot be read and this device has no copy.
   */
  async restore() {
    let cached = null;
    try { cached = await this._cache.load(this.sub); if (cached) for (const f of cached.files) await this._digest(f); }
    catch (e) { cached = null; this._log('cacheError', { message: String(e?.message ?? e) }); }
    let remote = null, failed = null;
    try { remote = await this._loadRemote(cached); } catch (e) { if (e instanceof AuthError || e instanceof RestoreError) throw e; failed = e; }
    let state, source, dirty = false, base = null;
    const R = remote?.doc ?? null;
    if (failed) {
      if (!cached) throw new RestoreError('drive', failed);
      state = cached; source = 'cache'; dirty = cached.dirty; base = cached.base; this._remote = cached.remote ?? noRemote();
    } else if (remote.unchanged) {
      // Task A6: Drive still holds this device's base (same du-lieu.json version, every large file still there):
      // nothing was downloaded; the copy here is what Drive has, plus this device's own unsaved changes.
      state = cached; source = 'cache'; dirty = cached.dirty; base = cached.base; this._remote = remote.meta;
    } else {
      this._remote = remote.meta;
      if (R && cached && cached.base?.docId === R.docId && String(cached.base.version) === String(R.version)) {
        state = cached; source = 'cache'; dirty = cached.dirty; base = cached.base; // Drive unchanged since this device's base
      } else if (R && cached) {
        const B = cached.base?.docId === R.docId ? cached.base : EMPTY_BASE; // another doc: keep everything of both
        const merged = mergeShared(sharedOf(cached), R, B);
        state = withDeviceLocal(merged, cached); base = baseOf(R, R.docId, R.version); dirty = !sameShared(merged, R) || resupplies(merged, R);
        source = dirty ? 'merge' : 'drive';
      } else if (R) { state = R; source = 'drive'; base = baseOf(R, R.docId, R.version); }
      else if (cached && (cached.dirty || cached.base == null)) { // Drive has no data yet, or lost it while this device had unsaved changes
        state = cached; source = 'cache'; dirty = cached.dirty || sharedOf(cached).files.length > 0 || Object.values(sharedOf(cached).prefs).some(e => e.length);
      } else { state = EMPTY; source = 'empty'; }
    }
    const info = { source, driveVersion: R?.version ?? remote?.meta?.version ?? null, baseVersion: cached?.base?.version ?? null, cacheDirty: cached?.dirty ?? null, offline: !!failed };
    this._log('restore', info);
    if (source === 'merge') this._log('merge', { at: 'restore', driveVersion: R.version, baseVersion: cached.base?.version ?? null });
    if (source === 'empty' && cached) this._log('reset', { baseVersion: cached.base?.version ?? null });

    this._apply(state);
    this._base = base; this.dirty = dirty; this._folderChecked = false;
    this._changedAt = Math.max(cached?.updatedAt ?? 0, R?.updatedAt ?? 0);
    if (dirty) this._changedAt = Math.max(this._now(), this._changedAt + 1);
    try { if (source === 'empty' && cached) await this._cache.wipe(this.sub); } catch (e) { this._log('cacheError', { message: String(e?.message ?? e) }); }
    this._unsubscribe = this._state.subscribe(ev => this._onChange(ev));
    if (source !== 'empty') await this._saveLocal();
    this._setStatus(dirty ? 'pending' : 'saved');
    if (dirty) { this._firstPending = this._now(); this._scheduleUpload(0); }
    return info;
  }
  /** cached: this device's copy (or null). Task A6: when Drive still holds the version this copy was based on, and
   *  every large file it points at is still in the folder, nothing is downloaded ({ unchanged: true }); else
   *  du-lieu.json is downloaded and the large files this device already has (same sha256) are not. */
  async _loadRemote(cached = null) {
    const folderId = await this._api.findOrCreateFolder(this._folderName);
    const listed = await this._api.listFolder(folderId);
    const docs = listed.filter(f => f.name === DATA_FILE); // oldest first
    if (!docs.length) return { meta: { folderId, docId: null, version: null, large: [] }, doc: null };
    const docId = docs[0].id, mine = cached?.remote;
    if (cached?.base != null && cached.base.docId === docId && mine?.docId === docId && String(mine.version) === String(cached.base.version)) {
      const meta = await this._api.get(docId, 'id,version,trashed');
      const live = new Set(listed.map(f => f.id));
      if (!meta.trashed && String(meta.version) === String(cached.base.version) && (mine.large ?? []).every(l => live.has(l.id))) {
        return { meta: { folderId, docId, version: String(meta.version), large: mine.large ?? [] }, doc: null, unchanged: true };
      }
    }
    const have = new Map();
    for (const f of cached?.files ?? []) if (f.bytes != null && f.sha256 != null) have.set(f.sha256, f.bytes);
    const doc = await this._loadDoc(docId, have, new Set(listed.map(f => f.id)));
    return { meta: { folderId, docId: doc.docId, version: doc.version, large: doc.largeIndex }, doc };
  }
  /** Downloads du-lieu.json and its large files (bytes already on this device, by sha256, are reused). live: ids of
   *  the files in the folder (Task A6): a large file not among them is gone, as a download would find (404). */
  async _loadDoc(docId, have, live = null) {
    const meta = await this._api.get(docId, 'id,version,trashed');
    let json;
    try { json = JSON.parse(new TextDecoder('utf-8').decode(await this._api.download(docId))); } catch (e) { if (e instanceof SyntaxError) throw new RestoreError('bad ' + DATA_FILE, e); throw e; }
    if (!json || typeof json !== 'object' || !(json.schema <= SCHEMA_VERSION)) throw new RestoreError('unsupported ' + DATA_FILE);
    const dec = Base64.getDecoder(); const files = [], largeIndex = [], missing = new Map();
    for (const [path, b64, mtime] of json.files?.files ?? []) { const bytes = dec.decode(b64); files.push(await this._digest({ path, bytes, mtime, size: bytes.length, sha256: null, digest: null })); }
    const phantom = l => { // gone on Drive: unknown content, not a deletion
      const f = { path: l.path, phantom: true, bytes: null, id: l.id, size: l.size, mtime: l.mtime, sha256: l.sha256, digest: 's' + l.sha256 };
      files.push(f); missing.set(l.path, f);
    };
    for (const l of json.large ?? []) {
      if (l.missing) { phantom(l); continue; }
      if (live != null && !live.has(l.id)) { this._log('missingFile', { path: l.path }); phantom(l); continue; }
      let bytes = have.get(l.sha256) ?? null;
      if (bytes == null) {
        try { bytes = await this._api.download(l.id); }
        catch (e) { if (is404(e)) { this._log('missingFile', { path: l.path }); phantom(l); continue; } throw e; }
      }
      const sha256 = bytes.length === l.size && have.has(l.sha256) ? l.sha256 : await this._hash(bytes);
      files.push({ path: l.path, bytes, mtime: l.mtime, size: bytes.length, sha256, digest: 's' + sha256 });
      largeIndex.push({ path: l.path, id: l.id, sha256 });
    }
    files.sort(byPath);
    return { docId, version: String(meta.version), updatedAt: Number(json.updatedAt) || 0, prefs: sharedPrefs(json.prefs), dirs: json.files?.dirs ?? [], files, largeIndex, missing };
  }

  // ---------------------------------------------------------------- change tracking and local persistence
  _onChange(ev) {
    if (this._suppress || !this._unsubscribe) return;
    if (ev && ev.type && ev.path != null && isDeviceLocal(ev.path) && (ev.to == null || isDeviceLocal(ev.to))) { this._scheduleLocal(LOCAL_ONLY_SAVE_MS); return; }
    if (ev && !ev.type && ev.name != null && isDeviceLocalPrefs(ev.name)) { this._scheduleLocal(LOCAL_ONLY_SAVE_MS); return; } // a UI draft
    this._seq++; this.dirty = true;
    // Strictly after the restored copy (diagnostics only; conflicts are decided by Drive versions).
    this._changedAt = Math.max(this._now(), this._changedAt + 1);
    if (this._firstPending == null) this._firstPending = this._now();
    if (this.status !== 'auth' && this.status !== 'saving') this._setStatus('pending');
    this._scheduleLocal(LOCAL_SAVE_MS);
    this._scheduleUpload();
  }
  /** Writes to IndexedDB at most `ms` from now (an earlier pending write is kept, so a stream of changes cannot delay it). */
  _scheduleLocal(ms) {
    if (this._stopped) return;
    const due = this._now() + ms;
    if (this._localTimer != null) { if (this._localDue <= due) return; this._timers.clearTimeout(this._localTimer); }
    this._localDue = due;
    this._localTimer = this._timers.setTimeout(() => { this._localTimer = null; this._saveLocal(); }, ms);
  }
  /** Writes the whole current state with its sync metadata to IndexedDB (serialised; never waits for Drive). */
  _saveLocal() {
    if (this._localTimer != null) { this._timers.clearTimeout(this._localTimer); this._localTimer = null; }
    if (this._stopped) return this._cacheChain;
    this._cacheChain = this._cacheChain.then(async () => {
      const snap = await this._capture();
      await this._cache.save(this.sub, snap, { dirty: this.dirty, base: this._base, remote: this._remote, updatedAt: this._changedAt });
      this._cacheFailed = false;
    }).catch(e => { if (!this._cacheFailed) { this._cacheFailed = true; this._log('cacheError', { message: String(e?.message ?? e) }); } });
    return this._cacheChain;
  }
  _scheduleUpload(delay = null) {
    if (this._stopped) return;
    if (this._uploadTimer != null) this._timers.clearTimeout(this._uploadTimer);
    const wait = delay ?? Math.max(0, Math.min(this._debounceMs, (this._firstPending ?? this._now()) + this._maxWaitMs - this._now()));
    this._uploadTimer = this._timers.setTimeout(() => { this._uploadTimer = null; this._run(); }, wait);
  }
  /** Page hidden or closing: writes IndexedDB at once and starts the upload; resolves when both ended. */
  flush() {
    if (!this._unsubscribe) return Promise.resolve();
    const local = this._saveLocal();
    if (this._uploadTimer != null) { this._timers.clearTimeout(this._uploadTimer); this._uploadTimer = null; }
    const upload = this.dirty ? this._run() : (this._running ?? Promise.resolve());
    return Promise.all([local, upload]).then(() => {});
  }
  /** Tries the upload again after coming back online or a new token. */
  retry() {
    if (!this._unsubscribe || !this.dirty) return Promise.resolve();
    if (this._uploadTimer != null) { this._timers.clearTimeout(this._uploadTimer); this._uploadTimer = null; }
    return this._run();
  }
  /** Page visible again: uploads pending changes, or pulls what another device saved meanwhile. */
  check() {
    if (!this._unsubscribe) return Promise.resolve();
    if (this.dirty) return this.retry();
    return this._op('check');
  }
  /** stop(), then waits for the running Drive operation and IndexedDB write (sign-out wipes the copy after this). */
  async close() {
    this.stop();
    try { await this._running; } catch (e) { /* reported already */ }
    await this._cacheChain;
  }
  /** Stops listening and cancels pending timers (sign-out). */
  stop() {
    this._stopped = true;
    if (this._unsubscribe) { this._unsubscribe(); this._unsubscribe = null; }
    for (const t of ['_uploadTimer', '_localTimer', '_retryTimer']) { if (this[t] != null) this._timers.clearTimeout(this[t]); this[t] = null; }
  }

  // ---------------------------------------------------------------- Drive operations (one at a time)
  _run() { return this._op('save'); }
  _op(kind) {
    if (this._running) { if (kind === 'save') this._again = true; return this._running; }
    this._again = kind === 'save';
    this._running = (async () => {
      if (kind === 'check') await this._checkOnce();
      while (this._again) {
        this._again = false;
        if (!this.dirty) break;
        this._firstPending = null;
        await this._saveOnce();
        if (this.status !== 'pending' && this.status !== 'saved') break;
      }
    })().finally(() => { this._running = null; });
    return this._running;
  }
  _failed(e) {
    if (e instanceof AuthError) { this._fail('auth', e); this._setStatus('auth'); this._onAuthNeeded(); }
    else if (e instanceof NetworkError) { this._fail('offline', e); this._setStatus('offline'); }
    else { this._fail('error', e); this._setStatus('error'); if (this._retryTimer == null && !this._stopped) this._retryTimer = this._timers.setTimeout(() => { this._retryTimer = null; this.retry(); }, this._retryMs); }
  }
  async _saveOnce() {
    if (this._retryTimer != null) { this._timers.clearTimeout(this._retryTimer); this._retryTimer = null; }
    if (this._remoteWaiting) { this._setStatus('pending'); return; } // Drive is ahead: upload after resumeRemote()
    try {
      for (let round = 0; !this._stopped; round++) {
        const seq = this._seq; const snap = await this._capture();
        if (this._stopped) return;
        this._setStatus('saving');
        const result = await this._uploadOnce(snap);
        if (result === 'ok') { if (seq === this._seq) this.dirty = false; break; }
        if (await this._pullAndMerge() === 'waiting') break; // another device saved meanwhile
        if (!this.dirty || round >= 2) break;
      }
    } catch (e) { this._failed(e); await this._saveLocal(); return; }
    if (this._stopped) return;
    if (this._failure != null) { this._log('saved', { after: this._failure }); this._failure = null; }
    this._setStatus(this.dirty ? 'pending' : 'saved');
    if (this.dirty && this._uploadTimer == null && !this._remoteWaiting) { this._firstPending = this._firstPending ?? this._now(); this._scheduleUpload(); }
    await this._saveLocal();
  }
  async _checkOnce() {
    const { docId, folderId } = this._remote;
    if (this.dirty || !folderId || this._remoteWaiting) return;
    try {
      if (!docId) { // Drive had no data at sign-in: another device may have saved since
        const docs = (await this._api.listFolder(folderId)).filter(f => f.name === DATA_FILE);
        if (!docs.length) return;
        this._remote = { ...this._remote, docId: docs[0].id, version: null };
      } else {
        const meta = await this._api.get(docId, 'id,version,trashed');
        if (meta.trashed || String(meta.version) === String(this._remote.version)) return;
      }
    } catch (e) { if (e instanceof AuthError) this._failed(e); return; }
    try { await this._pullAndMerge(); } catch (e) { this._failed(e); return; }
    if (this.dirty) this._again = true;
  }
  /** Logs a failure once per kind (logging writes app files, which would otherwise start another save). */
  _fail(kind, e) { if (this._failure === kind) return; this._failure = kind; this._log('saveFailed', { kind, message: String(e?.message ?? e) }); }

  /** Applies the Drive changes that waited for mayApplyRemote() (merging what was saved here meanwhile). */
  resumeRemote() {
    if (!this._unsubscribe) return Promise.resolve();
    this._remoteWaiting = false;
    return this.check();
  }
  /**
   * Downloads the current du-lieu.json and merges it into this device's state (three-way against the base).
   * Resolves to 'waiting' when the merge would change this device's state but mayApplyRemote() says not now:
   * then nothing changes here (state, base and Drive ids stay), and onRemoteWaiting() is called.
   */
  async _pullAndMerge() {
    const r = this._remote;
    const now = await this._capture();
    const R = await this._loadDoc(r.docId, new Map(now.files.filter(f => f.sha256 && f.bytes).map(f => [f.sha256, f.bytes])));
    let snap = null;
    for (let i = 0; i < 5 && snap == null; i++) { const seq = this._seq; const s = await this._capture(); if (seq === this._seq) snap = s; }
    if (snap == null) throw new DriveError(0, 'busy'); // the app keeps changing: try again later
    if (this._stopped) return; // signed out meanwhile: never touch the state or reload the page
    // No await from here to the apply: nothing can change the state in between.
    const L = sharedOf(snap);
    const merged = mergeShared(L, R, this._base ?? EMPTY_BASE);
    const phantomsHere = new Set(L.files.filter(f => f.phantom).map(f => f.path));
    const changedHere = !sameShared(merged, L) || merged.files.some(f => !f.phantom && phantomsHere.has(f.path)); // (bytes arrived for a phantom)
    if (changedHere && !this._mayApplyRemote()) {
      this._remoteWaiting = true; this._log('pullDeferred', { driveVersion: R.version });
      this._onRemoteWaiting(); return 'waiting';
    }
    if (changedHere) this._apply(withDeviceLocal(merged, snap));
    this._remote = { folderId: r.folderId, docId: R.docId, version: R.version, large: R.largeIndex };
    this._base = baseOf(R, R.docId, R.version);
    this.dirty = !sameShared(merged, R) || resupplies(merged, R);
    if (this.dirty) this._changedAt = Math.max(this._now(), this._changedAt + 1);
    this._log(this.dirty ? 'merge' : 'pull', { at: 'save', driveVersion: R.version, changedHere });
    await this._saveLocal();
    if (changedHere && !this._stopped) this._onRemoteChange({ merged: this.dirty });
    return 'applied';
  }

  /** Uploads the shared state; 'conflict' when Drive's du-lieu.json is not the version this device is based on. */
  async _uploadOnce(snap) {
    const shared = sharedOf(snap);
    let r = { ...this._remote, large: [...this._remote.large] };
    if (!r.folderId) r = { ...noRemote(), folderId: await this._api.findOrCreateFolder(this._folderName) };
    if (!this._folderChecked) {
      // Two devices signing in for the first time at once may each create the folder: all converge to the oldest.
      const folders = await this._api.listFolders(this._folderName);
      this._folderChecked = true;
      const oldest = folders[0]?.id ?? null;
      if (oldest != null && oldest !== r.folderId) {
        if (folders.some(f => f.id === r.folderId)) this._trashAfter.add(r.folderId);
        const docs = (await this._api.listFolder(oldest)).filter(f => f.name === DATA_FILE);
        this._remote = r = { folderId: oldest, docId: docs[0]?.id ?? null, version: null, large: [] };
        this._base = null; // another device's data: keep everything of both
        if (r.docId) return 'conflict';
      }
    }
    if (r.docId) {
      let meta = null;
      try { meta = await this._api.get(r.docId, 'id,version,trashed'); } catch (e) { if (!is404(e)) throw e; }
      if (meta && !meta.trashed) { if (String(meta.version) !== String(r.version)) { this._remote = r; return 'conflict'; } }
      else {
        // du-lieu.json was deleted on Drive: recreate only what is missing.
        let folder = null;
        try { folder = await this._api.get(r.folderId, 'id,trashed'); } catch (e) { if (!is404(e)) throw e; }
        if (!folder || folder.trashed) r = { ...noRemote(), folderId: await this._api.findOrCreateFolder(this._folderName) };
        else { const live = new Set((await this._api.listFolder(r.folderId)).map(f => f.id)); r = { ...r, docId: null, version: null, large: r.large.filter(l => live.has(l.id)) }; }
      }
    }
    if (!r.docId) {
      const docs = (await this._api.listFolder(r.folderId)).filter(f => f.name === DATA_FILE);
      if (docs.length) { this._remote = { ...r, docId: docs[0].id, version: null }; this._base = null; return 'conflict'; }
    }
    // Large files: a changed file is uploaded as a NEW Drive file; the old one stays as it is until du-lieu.json
    // points at the new one, so a commit that does not happen (conflict, failure) never damages Drive's copy.
    // Uploaded-but-uncommitted files are remembered (path + sha256), reused by the next attempt, and trashed after
    // the next commit if it does not use them.
    const previous = new Map(r.large.map(l => [l.path, l]));
    const index = [];
    for (const f of shared.files) {
      if (f.phantom) { index.push({ path: f.path, name: driveName(f.path), id: f.id, size: f.size, mtime: f.mtime, sha256: f.sha256, missing: true }); continue; }
      if (!isLarge(f)) continue;
      const prev = previous.get(f.path); const name = driveName(f.path); const key = f.path + '\u0000' + f.sha256;
      let id = prev && prev.sha256 === f.sha256 ? prev.id : this._uncommitted.get(key);
      if (id == null) {
        id = (await this._api.upload({ id: null, name, parent: r.folderId, bytes: f.bytes, mime: 'application/octet-stream' })).id;
        this._uncommitted.set(key, id);
      }
      index.push({ path: f.path, name, id, size: f.size, mtime: f.mtime, sha256: f.sha256 });
    }
    const enc = Base64.getEncoder();
    const doc = { schema: SCHEMA_VERSION, app: BuildConfig.APPLICATION_ID, version: BuildConfig.VERSION_NAME, updatedAt: snap.updatedAt, prefs: shared.prefs,
      files: { dirs: shared.dirs, files: shared.files.filter(f => !f.phantom && !isLarge(f)).map(f => [f.path, enc.encodeToString(f.bytes), f.mtime]) }, large: index };
    const body = utf8(JSON.stringify(doc));
    // Check again right before the commit: another device may have saved while the large files were uploading.
    if (r.docId) {
      let meta = null;
      try { meta = await this._api.get(r.docId, 'id,version,trashed'); } catch (e) { if (!is404(e)) throw e; }
      if (meta && !meta.trashed && String(meta.version) !== String(r.version)) { this._remote = r; return 'conflict'; }
      if (!meta || meta.trashed) r = { ...r, docId: null, version: null }; // deleted meanwhile: write a new one
    } else {
      const docs = (await this._api.listFolder(r.folderId)).filter(f => f.name === DATA_FILE);
      if (docs.length) { this._remote = { ...r, docId: docs[0].id, version: null }; this._base = null; return 'conflict'; }
    }
    const putDoc = id => this._api.upload({ id, name: DATA_FILE, parent: r.folderId, bytes: body, mime: 'application/json' });
    let res;
    try { res = await putDoc(r.docId); } catch (e) { if (!(r.docId && is404(e))) throw e; res = await putDoc(null); }
    // Trashed between the re-check and the write: the write went into the trash, so write a new file.
    if (res.trashed) res = await putDoc(null);
    // Committed: only now may the replaced and unused files go.
    const used = new Set(index.map(l => l.id));
    this._remote = { folderId: r.folderId, docId: res.id, version: res.version, large: index.filter(l => !l.missing).map(l => ({ path: l.path, id: l.id, sha256: l.sha256 })) };
    this._base = baseOf(shared, res.id, res.version);
    const trash = new Set([...[...previous.values()].map(p => p.id), ...this._uncommitted.values()].filter(id => !used.has(id)));
    for (const id of this._trashAfter) trash.add(id);
    this._trashAfter.clear(); this._uncommitted.clear();
    for (const id of trash) { try { await this._api.trash(id); } catch (e) { /* stays; harmless */ } }
    return 'ok';
  }
}
