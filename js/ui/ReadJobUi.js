// What both import screens share for resumable reading (web only, Task A2): running a read as a job (checkpointed
// OCR, progress, screen kept awake), the work roster result as a job result, and the staff-list fingerprint that is
// part of a job's settings. js/jobs/read-jobs.js keeps the records, js/ocr/checkpoint.js the OCR calls.
import { InterruptedException } from '../platform/java.js';
import { ByteArrayOutputStream } from '../platform/files.js';
import { BitmapFactory, CompressFormat } from '../platform/bitmap.js';
import { utf8Encode } from '../platform/java.js';
import { OcrCheckpoint, sha256Hex } from '../ocr/checkpoint.js';
import { RosterReader } from '../core/RosterReader.js';
import { StaffDirectory } from '../core/StaffDirectory.js';
import { UiDraftCodec } from '../core/UiDraftCodec.js';
import { Personnel } from '../core/Personnel.js';
import { PipeRosterReader } from '../core/PipeRosterReader.js';
import { PipeSourceCache } from '../core/PipeSourceCache.js';
import { ErrorLedger } from '../core/ErrorLedger.js';
import { ScheduleStore } from '../core/ScheduleStore.js';

/** Screen Wake Lock while a read runs (taken again when the page is visible again; nothing where unsupported). */
export class WakeLock {
  constructor({ nav = globalThis.navigator, doc = globalThis.document } = {}) {
    this._nav = nav; this._doc = doc; this._sentinel = null; this._wanted = false;
    this._visible = () => { if (this._doc?.visibilityState === 'visible') this._request(); };
  }
  get supported() { return typeof this._nav?.wakeLock?.request === 'function'; }
  get held() { return this._sentinel != null && this._sentinel.released !== true; }
  acquire() {
    if (this._wanted || !this.supported) return this; this._wanted = true;
    this._doc?.addEventListener?.('visibilitychange', this._visible); this._request(); return this;
  }
  async _request() {
    if (!this._wanted || this.held || this._doc?.visibilityState === 'hidden') return;
    try { const s = await this._nav.wakeLock.request('screen'); if (this._wanted) this._sentinel = s; else s.release().catch(() => {}); } catch (e) { /* denied (low battery, not visible): the read goes on */ }
  }
  release() {
    this._wanted = false; this._doc?.removeEventListener?.('visibilitychange', this._visible);
    const s = this._sentinel; this._sentinel = null; if (s != null && s.released !== true) s.release().catch(() => {});
  }
}

/**
 * Runs read() as reading job `id`: its OCR calls are checkpointed, every call and every second updates `progress`
 * (js/jobs/read-progress.js) and calls onProgress(), the screen stays awake. When an OCR call of the read took longer
 * than the readers' 60 s limit (slow device, or the page was suspended in the background meanwhile), the read is run
 * once more from the start once that call has finished: it then comes from the checkpoints at once, so the result is
 * the one an unhurried read gives. A read stopped by "Hủy" or by leaving the screen (InterruptedException) is not.
 */
export async function runJob({ id, read, progress, onProgress = () => {}, degraded = null, state = OcrCheckpoint, wake = new WakeLock(), timers = globalThis, now = () => Date.now() }) {
  wake?.acquire();
  const off = state.onCall(({ hit }) => onProgress(progress.call(hit)));
  const tick = timers.setInterval(() => onProgress(progress.tick()), 1000);
  try {
    for (let attempt = 0; ; attempt++) {
      state.beginJob(id); let out, failure = null; const since = now();
      try { out = await read(attempt); } catch (e) { failure = e; } finally { if (failure == null || !(failure instanceof InterruptedException)) await state.settle(id, state.slowRunning(id) > 0 ? 90_000 : 0); state.endJob(id); }
      const slow = state.slow(id) > 0;
      // What the attempt saved from a degraded read (the pipe reader's page cache) must not be reused.
      if (slow && degraded != null) await degraded(attempt, since);
      if (attempt === 0 && slow && !(failure instanceof InterruptedException)) continue;
      if (failure != null) throw failure;
      return out;
    }
  } finally { off(); timers.clearInterval(tick); wake?.release(); }
}

/**
 * The read of a pipe job (PipeImportActivity): attempt 0 is the APK read; a replay (attempt > 0, after a slow call)
 * reads every page again (forceRefresh) so the page cache cannot hand back the degraded page, its OCR calls coming
 * from the checkpoints. `degraded` drops the pages the attempt saved into the APK page cache (pipe-source-cache-v4)
 * when one of its OCR calls ran past the limit. Reader is injectable (tests).
 */
export function pipeJobRead({ context, sources, images, month, name, progress, Reader = PipeRosterReader, before = async () => {} }) {
  return {
    read: async attempt => {
      const reader = new Reader(context); if (attempt > 0) reader.forceRefresh = true;
      try { await before(); return await reader.read(sources, month, name, progress); } finally { reader.close?.(); }
    },
    degraded: async (attempt, since) => dropPagesSavedSince(context, images, month, since),
  };
}
/** Deletes the page-cache records of these source copies for the month written since `since` (ms). */
export function dropPagesSavedSince(context, images, month, since) {
  const cache = new PipeSourceCache(context.getFilesDir()); let n = 0;
  for (const image of images) { const f = cache._record(image, month); if (f.isFile() && f.lastModified() >= since - 1000) { f.delete(); n++; } }
  return n;
}
/** What else the pipe reader reads besides the photos (part of a pipe job's settings): the error ledger's templates
 *  and the confirmed printed names. */
export async function pipeContextFingerprint(context) {
  let ledger = '', names = '';
  try { ledger = context.getSharedPreferences(ErrorLedger.PREFERENCES, 0).getString('entries', '[]'); } catch (e) { ledger = ''; }
  try { names = new ScheduleStore(context).names()._raw().toString(); } catch (e) { names = ''; }
  return (await sha256Hex(utf8Encode(JSON.stringify([ledger, names])))).substring(0, 16);
}

/** The staff list the readers match names against (part of a job's settings: another list may read another name). */
export async function staffFingerprint() { return (await sha256Hex(utf8Encode(Personnel.current().toJson()))).substring(0, 16); }

/** A work-roster read as a job result: what the review table needs (as MainActivity keeps it across a restart). */
export async function workResultRecord(found) {
  const files = {};
  if (found.identityImage != null && !found.identityImage.isRecycled()) { const out = new ByteArrayOutputStream(); await found.identityImage.compress(CompressFormat.PNG, 100, out); files['identity.png'] = out.toByteArray(); }
  const result = {
    schedule: UiDraftCodec.schedule(found.schedule), readName: found.readName, readNumber: found.readNumber, identityMatches: found.identityMatches,
    row: found.row, raw: found.raw, staff: found.staff == null ? null : found.staff.toJson(),
  };
  return { result, files };
}
/** RosterReader.Result of a done job (the cell crops are not kept, as after the APK's process restore). */
export async function workResultFrom(jobs, record) {
  const r = record.result, found = new RosterReader.Result();
  found.schedule = UiDraftCodec.schedule(r.schedule); found.readName = r.readName; found.readNumber = r.readNumber; found.identityMatches = r.identityMatches === true;
  found.row = r.row ?? 0; found.raw = r.raw; found.staff = r.staff == null ? null : StaffDirectory.fromJson(r.staff);
  found.cells = new Array(found.schedule.month.lengthOfMonth()).fill(null);
  const identity = jobs.file(record.id, 'identity.png'); found.identityImage = identity.isFile() ? await BitmapFactory.decodeFile(identity.toString()) : null;
  return found;
}
