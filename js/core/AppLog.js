// Port of vn.lichdilam.AppLog (APK 4.5). The single-thread writer (Executors.newSingleThreadExecutor) becomes a
// promise chain: events are appended in order after the caller returns, flush()/export() wait for it (async).
// Events from the page run on the thread "main"; a job of an Executors executor runs as that executor's worker
// ("pool-N-thread-1", js/platform/java.js), so events it logs carry that name — and, the page having one JS thread,
// so do UI events logged while that job is running. android.util.Log → js/platform/log.js. The alarm-delivery diagnostics
// of state() (ReminderDiagnostics, Android only) are not part of the web log.
import { IOException, JavaTreeMap, JavaTreeSet, System, SystemClock, Thread, Locale, MessageDigest, format, iterableOf, printStackTrace, javaThrowableToString } from '../platform/java.js';
import { JSONObject, JSONArray, JSONException } from '../platform/json.js';
import { File, Files, FileInputStream, FileOutputStream, StringWriter, PrintWriter } from '../platform/files.js';
import { Instant, ZoneId } from '../platform/time.js';
import { Log } from '../platform/log.js';
import { BuildConfig, Build, Process } from '../platform/android.js';
import { CalendarCell } from './CalendarCell.js';
import { SessionJournal } from './SessionJournal.js';
import { PipeSourceCache } from './PipeSourceCache.js';
import { PipeTable } from './PipeTable.js';
import { ReminderSettings } from './ReminderSettings.js';
import { ReminderEngine } from './ReminderEngine.js';
import { ThemeSettings } from './ThemeSettings.js';
import { OwnerProfile } from './OwnerProfile.js';
import { ErrorLedger } from './ErrorLedger.js';
import { Personnel } from './Personnel.js';

const DIRECTORY = 'session-logs';
let instance = null;

function json(value) {
  if (value == null) return JSONObject.NULL;
  if (value instanceof Map || (typeof value === 'object' && typeof value.entrySet === 'function')) {
    const result = new JSONObject(); const entries = value instanceof Map ? [...value.entries()] : value.entrySet().toArray().map(e => [e.getKey(), e.getValue()]);
    for (const [k, v] of entries) result.put(String(k), json(v)); return result;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value instanceof JSONObject || value instanceof JSONArray) return value;
  if (Array.isArray(value) || value instanceof Set || (typeof value === 'object' && typeof value.toArray === 'function')) { const result = new JSONArray(); for (const item of iterableOf(value)) result.put(json(item)); return result; }
  return String(value);
}
/** Runs tasks one after another, after the current call stack (the Java writer thread). */
class SerialWriter {
  constructor() { this._tail = Promise.resolve(); }
  execute(task) { this._tail = this._tail.then(task, task); }
  /** submit(task).get(timeout): resolves when every earlier task and this one ran; rejects after timeoutMs. */
  submitAndWait(task, timeoutMs) {
    const done = new Promise((resolve, reject) => { this.execute(() => { try { task(); resolve(); } catch (e) { reject(e); } }); });
    let timer; const timeout = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new IOException('java.util.concurrent.TimeoutException')), timeoutMs); });
    return Promise.race([done, timeout]).finally(() => clearTimeout(timer));
  }
}

/** One ordered writer for UI, readers, saved state, receivers and fatal failures. */
export class AppLog {
  static DIRECTORY = DIRECTORY;
  constructor(c) {
    this._context = c.getApplicationContext(); this.journal = new SessionJournal(new File(c.getFilesDir(), DIRECTORY));
    this._writer = new SerialWriter(); this._observed = new Map(); this._listeners = new Map(); this._error = ''; this._started = SystemClock.elapsedRealtime();
  }
  static initialize(c) {
    if (instance != null) return;
    try {
      instance = new AppLog(c);
      AppLog.event('session.start', AppLog.data('version', BuildConfig.VERSION_NAME, 'versionCode', BuildConfig.VERSION_CODE, 'android', Build.VERSION.RELEASE,
        'sdk', Build.VERSION.SDK_INT, 'device', Build.MANUFACTURER + ' ' + Build.MODEL, 'pid', Process.myPid(), 'zone', ZoneId.systemDefault().toString(), 'locale', Locale.getDefault().toLanguageTag(), 'ocrRevision', PipeSourceCache.REVISION));
      AppLog.observePreferences(); AppLog.event('session.initialState', AppLog.data('version', BuildConfig.VERSION_NAME, 'capturedAt', Instant.now().toString(), 'preferences', AppLog._preferenceValues()));
      const previous = Thread.getDefaultUncaughtExceptionHandler();
      Thread.setDefaultUncaughtExceptionHandler((thread, failure) => {
        AppLog.failure('crash.uncaught', failure); AppLog.flush();
        if (previous != null) previous(thread, failure);
      });
    } catch (failed) { Log.e('AppSessionLog', 'Cannot initialize log', failed); }
  }
  static data(...pairs) {
    const result = new JSONObject(); try { for (let i = 0; i + 1 < pairs.length; i += 2) result.put(String(pairs[i]), json(pairs[i + 1])); } catch (ignored) { if (!(ignored instanceof JSONException)) throw ignored; } return result;
  }
  static event(type, details) {
    const log = instance; if (log == null) return;
    const at = System.currentTimeMillis(), elapsed = SystemClock.elapsedRealtime() - log._started; const thread = Thread.currentThread().getName();
    // Freeze mutable JSON before crossing threads; callers can continue editing their models.
    const frozen = details.toString();
    if (type.startsWith('reminder.registration') || type.startsWith('reminder.diagnostic') || type.startsWith('reminder.keeper.') || type === 'reminder.receiver.onReceive' || type === 'reminder.receiver.worker' || type === 'reminder.receiver.entry' || type === 'reminder.cancel' || type === 'reminder.notification.enqueue' || type === 'reminder.sound.providerOpen' || type === 'reminder.audio.result') Log.i('LichReminderTrace', type + ' ' + frozen);
    log._writer.execute(() => { try { log.journal.append(type, new JSONObject(frozen), at, elapsed, thread); } catch (failed) { log._error = javaThrowableToString(failed); Log.e('AppSessionLog', 'Cannot write session', failed); } });
  }
  static failure(operation, failure) { const out = new StringWriter(); printStackTrace(failure, new PrintWriter(out)); AppLog.event('error', AppLog.data('operation', operation, 'message', javaThrowableToString(failure), 'stack', out.toString())); }
  static message(operation, message) { AppLog.event('operation.progress', AppLog.data('operation', operation, 'message', message)); }
  /** Waits (at most 3 s) until every event logged so far is written. */
  static async flush() { const log = instance; if (log == null) return; try { await log._writer.submitAndWait(() => {}, 3000); } catch (failed) { log._error = javaThrowableToString(failed); } }
  static error() { return instance == null ? 'Log chưa khởi tạo.' : instance._error; }
  static source(kind, original) {
    const log = instance; if (log == null || !original.isFile()) return;
    try {
      const directory = new File(log.journal.directory, 'sources'); if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException('Không tạo được nơi lưu ảnh log.');
      const digest = MessageDigest.getInstance('SHA-256');
      const input = new FileInputStream(original); try { const bytes = new Uint8Array(65536); let n; while ((n = input.read(bytes)) !== -1) digest.update(bytes, 0, n); } finally { input.close(); }
      let hash = ''; for (const b of digest.digest()) hash += format('%02x', b & 255);
      const destination = new File(directory, hash + '.image'); if (!destination.exists()) Files.copy(original.toPath(), destination.toPath());
      AppLog.event('source.image', AppLog.data('kind', kind, 'original', original.getAbsolutePath(), 'sha256', hash, 'bytes', original.length(), 'logPath', 'sources/recorded/' + destination.getName()));
    } catch (failure) { AppLog.failure('source.image', failure); }
  }
  static current() { return instance; }
  static intent(intent) {
    if (intent == null) return AppLog.data(); const uris = new JSONArray(); const clip = intent.getClipData();
    if (clip != null) for (let i = 0; i < clip.getItemCount(); i++) { const uri = clip.getItemAt(i).getUri(); uris.put(uri == null ? JSONObject.NULL : String(uri)); }
    return AppLog.data('intent', intent.toUri(0), 'clipUris', uris);
  }
  static observePreferences() {
    const log = instance; if (log == null) return;
    const names = new JavaTreeSet(['schedules', 'widgets', ReminderSettings.PREFS, ThemeSettings.PREFS, ThemeSettings.PRESETS, OwnerProfile.PREFERENCES, ErrorLedger.PREFERENCES, Personnel.PREFS]);
    const files = new File(log._context.getApplicationInfo().dataDir, 'shared_prefs').listFiles();
    if (files != null) for (const f of files) if (f.getName().endsWith('.xml')) names.add(f.getName().substring(0, f.getName().length - 4));
    for (const name of names) {
      const prefs = log._context.getSharedPreferences(name, 0); if (log._observed.get(name) === prefs) continue;
      const old = log._observed.get(name); log._observed.set(name, prefs); if (old != null) old.unregisterOnSharedPreferenceChangeListener(log._listeners.get(name));
      const listener = (p, key) => {
        if (key == null) AppLog.event('storage.clear', AppLog.data('preferences', name, 'remaining', p.getAll()));
        else AppLog.event('storage.change', AppLog.data('preferences', name, 'key', key, 'removed', !p.contains(key), 'value', p.getAll().get(key)));
      }; log._listeners.set(name, listener); prefs.registerOnSharedPreferenceChangeListener(listener);
    }
  }
  static _preferenceValues() { const result = new JavaTreeMap(); if (instance != null) for (const [k, v] of instance._observed) result.put(k, v.getAll()); return result; }
  static state() {
    const log = instance; if (log == null) return AppLog.data();
    const preferences = AppLog._preferenceValues();
    let reminderState; try { reminderState = ReminderEngine.logState(log._context); } catch (e) { reminderState = AppLog.data('snapshotError', javaThrowableToString(e)); }
    return AppLog.data('version', BuildConfig.VERSION_NAME, 'capturedAt', Instant.now().toString(), 'preferences', preferences, 'files', AppLog._fileList(log._context.getFilesDir(), ''), 'reminderDiagnostics', reminderState, 'logError', log._error);
  }
  static _fileList(root, prefix) {
    const result = new JSONArray(); const files = root.listFiles(); if (files == null) return result;
    for (const file of files) {
      const name = prefix + file.getName();
      if (file.isDirectory()) { if (name !== DIRECTORY) { const nested = AppLog._fileList(file, name + '/'); for (let i = 0; i < nested.length(); i++) result.put(nested.opt(i)); } }
      else result.put(AppLog.data('path', name, 'bytes', file.length(), 'modified', file.lastModified()));
    }
    return result;
  }
  static schedule(s) {
    if (s == null) return AppLog.data('empty', true);
    const days = new JSONArray(); for (let d = 0; d < s.shifts.length; d++) days.put(AppLog.data('date', s.month.atDay(d + 1).toString(), 'present', s.present[d], 'code', s.shifts[d], 'pipe', s.pipes[d], 'duty', s.duties[d], 'swapPerson', s.swapPeople[d], 'swapNumber', s.swapNumbers[d], 'complete', s.dayComplete(d), 'displayLines', CalendarCell.lines(s, d), 'displayLabel', s.dayLabel(d), 'issue', s.issues[d] == null ? null : s.issues[d].label));
    return AppLog.data('kind', s.kind, 'month', s.month.toString(), 'name', s.employeeName, 'number', s.employeeNumber, 'days', days);
  }
  /** scene: CalendarPainter.Scene (month, current, previous, next). */
  static calendar(screen, scene) {
    if (instance == null) return;
    AppLog.event('display.calendar', AppLog.data('screen', screen, 'month', scene.month.toString(), 'current', AppLog.schedule(scene.current), 'previous', AppLog.schedule(scene.previous), 'next', AppLog.schedule(scene.next)));
  }
  static table(screen, month, sheet, table, typed, owner, lockNames, lockDays, guide) {
    if (instance == null) return; const rows = new JSONArray();
    if (table != null) for (let day = 1; day <= table.days; day++) {
      const cells = new JSONArray();
      for (const pipe of table.columns) {
        const manual = typed.get(month, sheet, day, pipe); const names = manual == null ? table.names(day, pipe) : [manual]; const display = new JSONArray();
        for (const name of names) display.put(AppLog.data('fullName', name, 'shortName', PipeTable.shortName(name), 'nameLines', PipeTable.nameLines(name)));
        cells.put(AppLog.data('pipe', pipe, 'manual', manual != null, 'printedNames', table.names(day, pipe), 'display', display));
      }
      rows.put(AppLog.data('date', month.atDay(day).toString(), 'cells', cells));
    }
    AppLog.event('display.pipeTable', AppLog.data('screen', screen, 'month', month.toString(), 'sheet', sheet + 1, 'owner', owner, 'lockNames', lockNames, 'lockDays', lockDays, 'guide', guide, 'columns', table == null ? [] : table.columns, 'rows', rows));
  }
  /** Writes every session, the app state and the kept source images into a zip in the cache; resolves to that File. */
  static async export() {
    const log = instance; if (log == null) throw new IOException('Log chưa khởi tạo.');
    AppLog.event('log.export', AppLog.data('sessions', log.journal.sessions().length)); await log._writer.submitAndWait(() => {}, 30000);
    const directory = new File(log._context.getCacheDir(), 'log-exports'); if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException('Không tạo được file xuất log.');
    const destination = new File(directory, 'Lich-di-lam-' + BuildConfig.VERSION_NAME + '-log-' + System.currentTimeMillis() + '.zip');
    const attachments = new Map();
    const recorded = new File(log.journal.directory, 'sources').listFiles(); if (recorded != null) for (const file of recorded) if (file.isFile()) attachments.set('sources/recorded/' + file.getName(), file);
    const sources = new File(log._context.getFilesDir(), 'pipe-source-cache-v4'); const originals = sources.listFiles((d, n) => n.endsWith('.image') || n.endsWith('.json'));
    if (originals != null) for (const file of originals) attachments.set('sources/pipe/' + file.getName(), file);
    const imported = new File(log._context.getCacheDir(), 'imported-image'); if (imported.isFile()) attachments.set('sources/work/imported-image', imported);
    const scan = new File(log._context.getFilesDir(), 'last-scan.json'); if (scan.isFile()) attachments.set('sources/work/last-scan.json', scan);
    try { log.journal.export(new FileOutputStream(destination), AppLog.state(), attachments); return destination; } catch (failure) { destination.delete(); throw failure; }
  }
}
