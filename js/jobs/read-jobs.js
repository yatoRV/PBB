// Reading jobs (web only, Task A2): one record per photo read, so a read that was interrupted (page left, reloaded,
// iPhone suspended the tab, "Hủy") continues instead of starting again, a finished read waits for the review table,
// and the same photo with the same settings is never read twice.
//
// A job's id is the SHA-256 of the reader type, the SHA-256 of each photo (in order) and every setting that changes
// the result (month, STT, name, primary photo, staff list, reader revision): same photo + same settings = same job.
// Records are app files (js/platform/files.js) under files/read-jobs/, so they live in this account's IndexedDB copy
// and are saved to its Google Drive by the existing sync (js/cloud/drive-sync.js: version check, three-way merge):
//   read-jobs/<id>.json          { schema, id, type, state, cancelled, failed, params, photos, createdAt, updatedAt, result }
//   read-jobs/<id>-<name>        files of the result (the work roster's identity crop)
//   read-jobs/photos/<sha>.image a copy of the work-roster photo while its job is unfinished or awaiting confirmation
//                                (another device can then continue it); deleted when the job is confirmed or
//                                discarded. Pipe photos are the APK's own content-addressed copies
//                                (pipe-source-cache-v4/<sha>.image), kept by the APK for "Cập nhật OCR", never deleted here.
// States: running (reading, or stopped before the end: cancelled = "Hủy", failed = the reader's error) → done (result
// stored, review not confirmed) → confirmed (saved to the calendar) | discarded. Nothing reaches the calendar before
// the review table is confirmed, as in the APK. The OCR calls of a job are checkpointed by js/ocr/checkpoint.js.
import { File, FileInputStream, FileOutputStream } from '../platform/files.js';
import { utf8Decode, utf8Encode } from '../platform/java.js';
import { OcrCheckpoint, sha256Hex, hashAvailable } from '../ocr/checkpoint.js';

export const JOBS_DIR = 'read-jobs';
export const PHOTOS_DIR = 'photos';
/** Part of every job id: bump when a reader's result for the same photo and settings changes (new reader logic). */
export const READER_REVISION = 1;
export const SCHEMA = 1;
/** Finished records (confirmed / discarded, without their result or files) kept per reader type. */
export const KEEP_FINISHED = 3;
export const WORK = 'work', PIPE = 'pipe';
/** A job stopped with "Hủy" (or by a page that died) that nobody continued is thrown away after this long; a failed one after a day. */
export const STALE_CANCELLED_MS = 14 * 24 * 3600_000, STALE_FAILED_MS = 24 * 3600_000;

/** JSON with sorted object keys (the job id must not depend on property order). */
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v != null && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}
/** The job id: SHA-256 (hex) of the reader type, the photos' SHA-256 and the settings. */
export async function jobId(type, photoShas, params) {
  return sha256Hex(utf8Encode(canonical(['lich-di-lam/read-job', READER_REVISION, type, photoShas, params ?? {}])));
}
const readBytes = file => new FileInputStream(file).readAllBytes();
function writeBytes(file, bytes) { const dir = file.getParentFile(); if (dir != null && !dir.isDirectory()) dir.mkdirs(); const out = new FileOutputStream(file); try { out.write(bytes); } finally { out.close(); } }

export class ReadJobs {
  /** Jobs need SHA-256 (a secure context: https or localhost); without it the readers run as before, without jobs. */
  static supported() { return hashAvailable(); }
  /** context: an app Context (getFilesDir); checkpoint: js/ocr/checkpoint.js state (dropped with the job). */
  constructor(context, { now = () => Date.now(), checkpoint = OcrCheckpoint } = {}) { this._files = context.getFilesDir(); this._now = now; this._checkpoint = checkpoint; }
  dir() { return new File(this._files, JOBS_DIR); }
  _record(id) { return new File(this.dir(), id + '.json'); }
  _photo(sha) { return new File(new File(this.dir(), PHOTOS_DIR), sha + '.image'); }
  /** A file of the job's result, by name. */
  file(id, name) { return new File(this.dir(), id + '-' + name); }

  get(id) {
    const f = this._record(id); if (id == null || !f.isFile()) return null;
    try { const r = JSON.parse(utf8Decode(readBytes(f))); return r != null && r.schema === SCHEMA && r.id === id ? r : null; } catch (e) { return null; }
  }
  _save(r) { r.updatedAt = Math.max(this._now(), (r.updatedAt ?? 0) + 1); writeBytes(this._record(r.id), utf8Encode(JSON.stringify(r))); return r; }
  /** Every record (newest first), optionally of one type. */
  list(type = null) {
    const d = this.dir(); if (!d.isDirectory()) return [];
    const out = []; for (const f of d.listFiles() ?? []) { const n = f.getName(); if (!n.endsWith('.json')) continue; const r = this.get(n.substring(0, n.length - 5)); if (r != null && (type == null || r.type === type)) out.push(r); }
    return out.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
  }
  /** The job the entry points offer: newest of the type that is done, or running and neither failed nor (when
   *  includeCancelled is false) cancelled. */
  pending(type, { includeCancelled = true } = {}) {
    for (const r of this.list(type)) {
      if (r.state === 'done') return r;
      if (r.state === 'running' && r.failed == null && (includeCancelled || !r.cancelled)) return r;
    }
    return null;
  }
  /** The photo of a job as stored for it (work: the job's copy; pipe: the APK's source copy), or null if gone. */
  photoFile(r, i = 0) { const p = r?.photos?.[i]; if (p == null) return null; const f = new File(p.path); return f.isFile() ? f : null; }

  /**
   * The job of these photos and settings: the existing record (a finished-but-discarded or confirmed one starts
   * again as running) or a new one. photos: [{ bytes } (a copy is kept for the job) | { file } (an app file the APK
   * keeps itself)]; params: the settings that change the result.
   */
  async open(type, photos, params) {
    const shas = [], files = [];
    for (const p of photos) {
      const bytes = p.bytes ?? readBytes(p.file); const sha = await sha256Hex(bytes); shas.push(sha);
      if (p.file != null) files.push({ sha256: sha, path: p.file.getAbsolutePath(), owned: false });
      else { const f = this._photo(sha); if (!f.isFile()) writeBytes(f, bytes); files.push({ sha256: sha, path: f.getAbsolutePath(), owned: true }); }
    }
    const id = await jobId(type, shas, params); let r = this.get(id);
    if (r == null) {
      r = { schema: SCHEMA, id, type, state: 'running', cancelled: false, failed: null, attempts: 0, params, photos: files, createdAt: this._now(), updatedAt: 0, result: null };
    }
    else if (r.state === 'confirmed' || r.state === 'discarded') Object.assign(r, { state: 'running', cancelled: false, failed: null, result: null, photos: files });
    else if (r.state === 'running') Object.assign(r, { cancelled: false, failed: null, photos: files });
    else return r; // done: the stored result is used, nothing is read again
    return this._save(r);
  }
  /** A read of the job starts (counted: a page that dies while reading leaves attempts > finished reads). */
  started(id) { const r = this.get(id); if (r == null || r.state !== 'running') return null; r.attempts = (r.attempts ?? 0) + 1; r.startedAt = this._now(); return this._save(r); }
  /** "Hủy" while reading: the job stays unfinished and can be continued later. */
  cancel(id) { const r = this.get(id); if (r == null || r.state !== 'running') return null; r.cancelled = true; return this._save(r); }
  /** The reader failed (its message is shown as in the APK): not offered again, the checkpoints stay for a retry. */
  fail(id, message) { const r = this.get(id); if (r == null || r.state !== 'running') return null; r.failed = String(message ?? ''); return this._save(r); }
  /**
   * The read finished: the result waits for the review table. files: { name: bytes } stored next to the record.
   * Other unconfirmed jobs of the type are superseded (discarded): the newest read is the one offered.
   */
  finish(id, result, files = {}) {
    // Only a running job finishes: one confirmed or discarded meanwhile (another tab, another device) stays so.
    const r = this.get(id); if (r == null || r.state !== 'running') return r;
    for (const [name, bytes] of Object.entries(files)) writeBytes(this.file(id, name), bytes);
    Object.assign(r, { state: 'done', cancelled: false, failed: null, result, files: Object.keys(files) }); this._save(r);
    for (const other of this.list(r.type)) if (other.id !== id && (other.state === 'running' || other.state === 'done')) this.discard(other.id);
    return r;
  }
  /** The review table was confirmed and saved. */
  confirm(id) { return this._end(id, 'confirmed'); }
  /** The user threw the job away. */
  discard(id) { return this._end(id, 'discarded'); }
  _end(id, state) {
    const r = this.get(id); if (r == null) return null;
    for (const name of r.files ?? []) this.file(id, name).delete();
    for (const p of r.photos ?? []) if (p.owned && !this.list().some(o => o.id !== id && (o.state === 'running' || o.state === 'done') && o.photos?.some(q => q.path === p.path))) new File(p.path).delete();
    Object.assign(r, { state, cancelled: false, failed: null, result: null, files: [] }); this._save(r);
    const ended = this.list(r.type).filter(o => o.state === 'confirmed' || o.state === 'discarded');
    for (const old of ended.slice(KEEP_FINISHED)) this._record(old.id).delete();
    /** The checkpoint clean-up of the last ended job (tests wait for it). */
    this.dropped = Promise.resolve(this._checkpoint?.dropJob(id)).catch(() => {});
    return r;
  }
  /** Throws away unfinished jobs nobody continued (cancelled / interrupted for STALE_CANCELLED_MS, failed for STALE_FAILED_MS), with their photo copy (and so its Drive copy). */
  pruneStale() {
    const t = this._now(); let n = 0;
    for (const r of this.list()) if (r.state === 'running' && t - (r.updatedAt ?? 0) > (r.failed != null ? STALE_FAILED_MS : STALE_CANCELLED_MS)) { this.discard(r.id); n++; }
    return n;
  }
  /** Ids of records that still hold checkpoints worth keeping (running or done). */
  liveIds() { return new Set(this.list().filter(r => r.state === 'running' || r.state === 'done').map(r => r.id)); }
}
