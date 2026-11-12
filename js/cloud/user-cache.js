// Local copy of each signed-in user's data in IndexedDB, so a dropped network or a closed page loses nothing.
// Everything is keyed by the Google account id (`sub`): a user's record is never read for another account, and
// signing out wipes it. Store "users": sub -> { schema: 2, updatedAt, dirty, prefs, dirs, small: [[path, bytes, mtime]],
// large: [{path, size, mtime, sha256}], base, remote } — the whole app state of this device (device-local files
// included), whether it still has changes Drive does not have (dirty), the Drive copy it was last in step with
// (base, for the three-way merge) and the Drive ids (remote).
// Store "blobs": sub + "\0" + sha256 -> bytes of a large file (written once per content, dropped when unused).
const DB_NAME = 'lich-di-lam';
const DB_VERSION = 1;
const USERS = 'users', BLOBS = 'blobs';
const SEP = '\u0000';
/** Files above this size are kept as blobs (same limit as the Drive layout). */
const LARGE = 256 * 1024;

const done = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const finished = tx => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted')); });

export class UserCache {
  /** indexedDB / IDBKeyRange: the browser globals (injected by tests). */
  constructor({ indexedDB = globalThis.indexedDB, IDBKeyRange = globalThis.IDBKeyRange } = {}) { this._idb = indexedDB; this._range = IDBKeyRange; this._db = null; }

  async _open() {
    if (this._db) return this._db;
    const req = this._idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(USERS)) db.createObjectStore(USERS);
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
    };
    this._db = await done(req);
    return this._db;
  }
  _blobRange(sub) { return this._range.bound(sub + SEP, sub + '\u0001', false, true); }

  // Every request of a transaction is issued synchronously (no await inside a transaction): older Safari ends a
  // transaction at the first promise turn.
  async _get(store, key) { const db = await this._open(); const tx = db.transaction([store], 'readonly'); const v = done(tx.objectStore(store).get(key)); await finished(tx); return v; }

  /**
   * The user's cached copy, or null: { updatedAt, dirty, base, remote, prefs, dirs, files: [{path, bytes, mtime,
   * size, sha256}] } (sha256 only for large files; phantom entries — large files known only by their Drive id —
   * have phantom: true, id and bytes: null).
   */
  async load(sub) {
    const rec = await this._get(USERS, sub);
    if (rec == null || rec.schema !== 2) return null;
    const db = await this._open(); const tx = db.transaction([BLOBS], 'readonly'); const blobs = tx.objectStore(BLOBS);
    const reads = rec.large.map(l => done(blobs.get(sub + SEP + l.sha256)));
    await finished(tx);
    const bytes = await Promise.all(reads);
    if (bytes.some(b => b == null)) return null; // incomplete copy: not usable
    const files = [...rec.small.map(([path, b, mtime]) => ({ path, bytes: b, mtime, size: b.length, sha256: null })),
      ...rec.large.map((l, i) => ({ path: l.path, bytes: bytes[i], mtime: l.mtime, size: l.size, sha256: l.sha256 })),
      ...(rec.phantoms ?? []).map(p => ({ ...p, phantom: true, bytes: null }))];
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { updatedAt: rec.updatedAt, dirty: rec.dirty, base: rec.base ?? null, remote: rec.remote ?? null, prefs: rec.prefs, dirs: rec.dirs, files };
  }
  /** Writes the whole state (snap.files: [{path, bytes, mtime, size, sha256}]) with its sync metadata. */
  async save(sub, snap, { dirty, base, remote, updatedAt }) {
    const db = await this._open();
    const t0 = db.transaction([BLOBS], 'readonly'); const keysReq = done(t0.objectStore(BLOBS).getAllKeys(this._blobRange(sub))); await finished(t0);
    const existing = new Set(await keysReq);
    const small = [], large = [];
    const phantoms = [];
    for (const f of snap.files) {
      if (f.phantom) phantoms.push({ path: f.path, id: f.id, size: f.size, mtime: f.mtime, sha256: f.sha256 });
      else if (f.bytes.length > LARGE) large.push(f); else small.push([f.path, f.bytes, f.mtime]);
    }
    const keep = new Set(large.map(f => sub + SEP + f.sha256));
    const tx = db.transaction([USERS, BLOBS], 'readwrite'); const blobs = tx.objectStore(BLOBS);
    for (const f of large) { const k = sub + SEP + f.sha256; if (!existing.has(k)) { blobs.put(f.bytes, k); existing.add(k); } }
    for (const k of existing) if (!keep.has(k)) blobs.delete(k);
    tx.objectStore(USERS).put({
      sub, schema: 2, updatedAt, dirty: !!dirty, base: base ?? null, remote: remote ?? null, prefs: snap.prefs, dirs: snap.dirs, small, phantoms,
      large: large.map(f => ({ path: f.path, size: f.bytes.length, mtime: f.mtime, sha256: f.sha256 })),
    }, sub);
    await finished(tx);
  }
  /** Deletes everything kept for this user. */
  async wipe(sub) {
    const db = await this._open(); const tx = db.transaction([USERS, BLOBS], 'readwrite');
    tx.objectStore(USERS).delete(sub); tx.objectStore(BLOBS).delete(this._blobRange(sub));
    await finished(tx);
  }
}
