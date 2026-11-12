// Port of vn.lichdilam.ReminderEngine (APK 4.5) with the in-page reminder runner (user decision 2: reminders fire
// only while the page — or the home-screen web app — is open).
// Ported as in the APK: the planned queue (`queue40`) with its independent batches, the delivered-key guard, the
// 2 h catch-up of overdue batches and tests, the 30 s retry, postBatch's revalidation, manual tests (Thử ngay,
// Hẹn thử lúc) and their 5-notification cap.
// Web adaptations (js/platform/notification.js):
//  - an alarm (AlarmManager + PendingIntent + ReminderReceiver) is a page timer; timers die with the page, so every
//    reschedule re-arms the saved queue (a slot is "healthy" only while its timer exists in this page);
//  - post() = NotificationManager.notify: a system notification when the browser granted it, plus the in-app banner,
//    tone and vibration (presenter installed by js/ui/ReminderRunner.js);
//  - allowed() is true: the banner and tone need no permission; exact() is true: page timers are on time while the
//    page runs; the Notification permission is a check of diagnose();
//  - Android-only parts are not ported (spec ruling): channels (channel/applySoundChoice/removeOldChannels keep their
//    names and do nothing), battery/background checks, ReminderDiagnostics/ReminderBoot/ReminderRepairJob/
//    ReminderKeeper (their decisions are logged with AppLog.event where the APK logged), diagnostic tests.
import { IllegalArgumentException, IllegalStateException, JavaHashSet, System, UUID, trim } from '../platform/java.js';
import { JSONArray, JSONObject, JSONException } from '../platform/json.js';
import { LocalDate, LocalTime, YearMonth, Instant, ZoneId, ZonedDateTime, DateTimeException, DateTimeFormatter } from '../platform/time.js';
import { Settings } from '../platform/android.js';
import { Context } from '../platform/context.js';
import { AlarmManager, NotificationManager } from '../platform/notification.js';
import { Schedule } from './Schedule.js';
import { ScheduleStore } from './ScheduleStore.js';
import { ReminderSettings } from './ReminderSettings.js';
import { ReminderPlanner } from './ReminderPlanner.js';
import { ReminderQueue } from './ReminderQueue.js';
import { BundledToneUris } from './BundledToneUris.js';
import { AppLog } from './AppLog.js';

const DATE = /[0-9]{4}-[0-9]{2}-[0-9]{2}/;
const KEEP_DELIVERED_DAYS = 45;
const REMINDER_ID = 1, TEST_ID = 2, MAX_TEST_NOTIFICATIONS = 5;
const DAY_FORMAT = DateTimeFormatter.ofPattern('dd/MM/yyyy');
const BLOCKED = 'Điện thoại đang chặn thông báo của Lịch đi làm. Cho phép thông báo rồi thử lại.';
/** Timers fire after the screen that armed them may be gone: they act through the application context. */
const app = new Context();

function queue(rt) {
  try { return new JSONArray(rt.getString('queue40', '[]')); } catch (bad) { if (!(bad instanceof JSONException)) throw bad; AppLog.failure('reminder.queue.read', bad); return new JSONArray(); }
}
function tests(rt) { try { return new JSONArray(rt.getString('tests', '[]')); } catch (e) { if (!(e instanceof JSONException)) throw e; return new JSONArray(); } }
function testRecord(c, id) { const list = tests(runtime(c)); for (let i = 0; i < list.length(); i++) { const o = list.optJSONObject(i); if (o != null && id === o.optString('id')) return o; } return null; }
/** Web: the per-device runtime state (planned queue, delivered guard, manual tests, next time, last error) lives in
 *  its own preferences file, device-local in DriveSync (js/cloud/drive-sync.js); the settings stay in "reminders". */
const RUNTIME = 'reminders-device';
const runtime = c => c.getSharedPreferences(RUNTIME, 0);
const slotKey = id => 'slot:' + id, testKey = id => 'test:' + id;
const decision = (id, reason, details = null) => AppLog.event('reminder.decision', AppLog.data('id', id, 'decision', reason, 'details', details));
const asSet = s => { const set = new JavaHashSet(); if (s != null) for (const v of s) set.add(v); return set; };

/** One checked condition of the notification path, shown to the user with its practical consequence. */
class Check {
  constructor(ok, title, detail) { this.ok = ok; this.title = title; this.detail = detail; }
  toString() { return (this.ok ? '✓ ' : '✗ ') + this.title + (this.detail === '' ? '' : '\n   ' + this.detail); }
}

/** Real reminders: bounded independent future batches, revalidated against the saved roster.
 *  A reminder is unique per date, shift code and exact time; a new time is a new valid reminder.
 *  Manual tests are separate notifications and never read or write the delivered-reminder log. */
export class ReminderEngine {
  static ACTION = 'vn.lichdilam.REMIND_SHIFT'; static TEST_ACTION = 'vn.lichdilam.TEST_REMINDER'; static CHANNEL_PREFIX = 'shift_reminder_'; static TEST_TAG = 'test-';
  /** Alarms delayed by Doze, the device maker or a reboot are still shown when this late; older ones are dropped. */
  static GRACE = 2 * 60 * 60 * 1000;
  static Check = Check;
  static RUNTIME_PREFS = RUNTIME;
  /** Web: with several open tabs only one delivers (the holder of a Web Lock, js/ui/ReminderRunner.js); the others
   *  plan but neither arm timers nor post automatic reminders. Manual "Thử ngay" always posts in its own tab. */
  static leader = true;
  /** Web: the phone's default notification sound has no file a page can play, so reminders and "Phát thử âm" play
   *  this bundled AOSP tone ("Argon") in the page instead (user decision); the picker's labels are unchanged. */
  static WEB_DEFAULT_TONE = BundledToneUris.uri('tone_aosp_argon_3be39c');
  /** The tone the page plays: the chosen bundled tone, else WEB_DEFAULT_TONE. */
  static audibleSound(c, sound) { return sound != null && sound !== Settings.System.DEFAULT_NOTIFICATION_URI && ReminderEngine.readable(c, sound) ? sound : ReminderEngine.WEB_DEFAULT_TONE; }
  static runtime(c) { return runtime(c); }
  /** Web: the in-app banner and tone need no permission, so the app may always alert while the page is open. */
  static allowed(c) { return true; } // eslint-disable-line no-unused-vars
  /** Web: page timers fire on time while the page runs (no exact-alarm permission exists). */
  static exact(c) { return true; } // eslint-disable-line no-unused-vars
  /** Web: the browser's Notification permission can still be asked (never answered). */
  static permissionRequestable() { return NotificationManager.permission() === 'default'; }
  static calendars(c) {
    const store = new ScheduleStore(c); const result = [];
    for (const key of c.getSharedPreferences('schedules', 0).getAll().keySet()) if (/^[0-9]{4}-[0-9]{2}$/.test(key)) try {
      const month = YearMonth.parse(key); if (store.load(month) != null) { const view = store.loadCombined(month); if (view != null) result.push(view); }
    } catch (ignored) { if (!(ignored instanceof IllegalArgumentException)) throw ignored; }
    result.sort((a, b) => a.month.compareTo(b.month)); return result;
  }
  static hasRealPending(c) { const q = queue(runtime(c)); for (let i = 0; i < q.length(); i++) { const o = q.optJSONObject(i); if (o != null && AlarmManager.has(slotKey(o.optString('id')))) return true; } return false; }
  /** arm(): the page timer of a real slot (deliver) or a manual test (deliverTest). */
  static _arm(c, at, kind, id) {
    if (kind === 'test') AlarmManager.set(testKey(id), at, () => ReminderEngine.deliverTest(app, id, 'testReceiver'));
    else AlarmManager.set(slotKey(id), at, () => ReminderEngine.deliver(app, id, null, 'receiver'));
    AppLog.event('reminder.arm', AppLog.data('source', 'pageTimer', 'scheduledAt', at, 'observedAt', System.currentTimeMillis(), 'id', id, 'kind', kind, 'notificationsAllowed', NotificationManager.permission()));
  }
  static _cancelSlot(c, slot, reason) { const id = slot.optString('id'); const had = AlarmManager.has(slotKey(id)); AlarmManager.cancel(slotKey(id)); AppLog.event('reminder.cancelled', AppLog.data('id', id, 'reason', reason, 'timerExisted', had)); } // eslint-disable-line no-unused-vars
  static reschedule(c, force = false) {
    const settings = new ReminderSettings(c); const now = System.currentTimeMillis();
    const before = queue(runtime(c)); const migrated = runtime(c).contains('queue40');
    if (!migrated) {
      const oldAt = runtime(c).getLong('nextAt', 0); const old = runtime(c).getString('pending', null);
      if (old != null && oldAt > 0 && oldAt <= now && now - oldAt <= ReminderEngine.GRACE) try { ReminderEngine._postBatch(c, settings, new JSONArray(old), now, 'catchUp', runtime(c).getString('token', '')); } catch (e) { AppLog.failure('reminder.migrate', e); }
    }
    AppLog.event('reminder.reschedule', AppLog.data('schema', 40, 'force', force, 'previousCount', before.length(), 'origin', 'page'));
    const enabled = settings.enabled() && ReminderEngine.allowed(c);
    const overdueRetry = new JSONArray();
    for (let i = 0; i < before.length(); i++) {
      const slot = before.optJSONObject(i); if (slot == null) continue; const at = slot.optLong('at');
      if (enabled && !ReminderEngine.leader && at <= now && now - at <= ReminderEngine.GRACE) { slot.put('armed', false); overdueRetry.put(slot); continue; } // web: kept for the delivering tab
      if (enabled && at <= now && now - at <= ReminderEngine.GRACE) try {
        AppLog.event('reminder.due', AppLog.data('id', slot.optString('id'), 'scheduledAt', at, 'observedAt', now, 'lateMs', now - at, 'path', 'catchUp'));
        if (!ReminderEngine._postBatch(c, settings, slot.getJSONArray('batch'), now, 'catchUp', slot.optString('id'))) { slot.put('armed', false); overdueRetry.put(slot); }
      } catch (e) { AppLog.failure('reminder.queue.catchUp', e); try { slot.put('armed', false); overdueRetry.put(slot); } catch (ignored) { if (!(ignored instanceof JSONException)) throw ignored; } }
    }
    if (ReminderEngine.leader) ReminderEngine._rearmTests(c, now);
    try {
      const delivered = ReminderEngine.prune(runtime(c).getStringSet('delivered', new JavaHashSet()), LocalDate.now());
      const events = enabled ? ReminderPlanner.upcoming(settings.rules(), ReminderEngine.calendars(c), Instant.ofEpochMilli(now), ZoneId.systemDefault()) : [];
      for (let i = events.length - 1; i >= 0; i--) if (delivered.contains(events[i].key())) events.splice(i, 1);
      const old = new Map(); for (let i = 0; i < before.length(); i++) { const o = before.optJSONObject(i); if (o != null) old.set(o.optString('id'), o); }
      const desired = new JSONArray();
      for (let i = 0; i < overdueRetry.length(); i++) desired.put(overdueRetry.get(i));
      for (const planned of ReminderQueue.plan(events)) {
        const batch = new JSONArray(); for (const e of planned.events) batch.put(new JSONObject().put('rule', e.rule.id).put('date', e.date.toString()).put('key', e.key()));
        const previous = old.get(planned.id); const healthy = previous != null && previous.optBoolean('armed') && AlarmManager.has(slotKey(planned.id));
        desired.put(new JSONObject().put('id', planned.id).put('at', planned.at).put('batch', batch).put('armed', healthy && !force));
      }
      const edit = runtime(c).edit().putString('queue40', desired.toString()).putStringSet('delivered', delivered).remove('lastError');
      if (desired.length() > 0) { const first = desired.getJSONObject(0); edit.putLong('nextAt', first.getLong('at')).putString('token', first.getString('id')).putString('pending', first.getJSONArray('batch').toString()); }
      else edit.remove('nextAt').remove('token').remove('pending');
      if (!edit.commit()) throw new IllegalStateException('Không lưu được danh sách hẹn.');
      const wanted = new Set(); for (let i = 0; i < desired.length(); i++) wanted.add(desired.getJSONObject(i).getString('id'));
      for (const o of old.values()) if (!wanted.has(o.optString('id'))) ReminderEngine._cancelSlot(c, o, 'queue40_removed_or_completed');
      let armed = 0, kept = 0;
      for (let i = 0; i < desired.length(); i++) {
        const slot = desired.getJSONObject(i); const id = slot.getString('id');
        if (slot.optBoolean('armed') || !ReminderEngine.leader) { kept++; continue; }
        try { const logicalAt = slot.getLong('at'); const triggerAt = logicalAt <= now ? now + 30000 : logicalAt; ReminderEngine._arm(c, triggerAt, 'real', id); slot.put('armed', true); armed++; }
        catch (failure) { slot.put('armed', false); runtime(c).edit().putString('lastError', 'Có hẹn chưa đăng ký được.').commit(); }
      }
      if (!runtime(c).edit().putString('queue40', desired.toString()).commit()) throw new IllegalStateException('Không lưu được trạng thái đăng ký hẹn.');
      AppLog.event('reminder.queue.reconciled', AppLog.data('schema', 40, 'count', desired.length(), 'newlyArmed', armed, 'retained', kept, 'force', force));
    } catch (e) { AppLog.failure('reminder.reconcile', e); runtime(c).edit().putString('lastError', 'Chưa đồng bộ được lịch nhắc.').commit(); }
  }
  static deliver(c, token, carried = null, path = 'receiver') {
    if (!ReminderEngine.leader) return;
    const settings = new ReminderSettings(c); const now = System.currentTimeMillis(); const list = queue(runtime(c)); let found = null;
    for (let i = 0; i < list.length(); i++) { const o = list.optJSONObject(i); if (o != null && o.optString('id') === token) { found = o; break; } }
    if (found == null) {
      if (token != null && token.startsWith('q40-')) { decision(token, 'queue40_stale_or_cancelled'); return; }
      if (carried != null && settings.enabled() && ReminderEngine.allowed(c)) try { ReminderEngine._postBatch(c, settings, new JSONArray(carried), now, 'legacyReceiver', token); } catch (e) { AppLog.failure('reminder.legacy', e); }
      ReminderEngine.reschedule(c); return;
    }
    const at = found.optLong('at'); AppLog.event('reminder.due', AppLog.data('id', token, 'scheduledAt', at, 'observedAt', now, 'lateMs', now - at, 'path', path));
    if (now + 1000 < at) { ReminderEngine.reschedule(c, true); return; }
    let posted = true;
    try { if (settings.enabled() && ReminderEngine.allowed(c)) posted = ReminderEngine._postBatch(c, settings, found.getJSONArray('batch'), now, path, token); }
    catch (e) { posted = false; AppLog.failure('reminder.deliver', e); }
    if (!posted) { ReminderEngine._arm(c, now + 30000, 'real', token); return; }
    AlarmManager.cancel(slotKey(token)); // web: delivered by a catch-up → its page timer is spent too
    const kept = new JSONArray(); for (let i = 0; i < list.length(); i++) { const o = list.optJSONObject(i); if (o != null && o.optString('id') !== token) kept.put(o); }
    if (!runtime(c).edit().putString('queue40', kept.toString()).commit()) AppLog.event('reminder.queue.commitFailed', AppLog.data('id', token, 'operation', 'removeCompleted'));
    ReminderEngine.reschedule(c);
  }
  static _postBatch(c, settings, batch, now, deliveryPath, deliveryId) {
    const rules = settings.rules(); const delivered = asSet(runtime(c).getStringSet('delivered', new JavaHashSet())); const store = new ScheduleStore(c);
    for (let i = 0; i < batch.length(); i++) {
      const item = batch.getJSONObject(i); let rule = null; for (const candidate of rules) if (candidate.id === item.getString('rule')) rule = candidate;
      if (rule == null) { decision(deliveryId, 'rule_removed', item); continue; }
      const e = new ReminderPlanner.Event(rule, LocalDate.parse(item.getString('date')), ZoneId.systemDefault());
      const at = e.at.toEpochMilli();
      // The rule's current time must still produce the same key: an edited time is a different reminder.
      if (item.getString('key') !== e.key() || at > now + 1000 || now - at > ReminderEngine.GRACE) { decision(deliveryId, 'rule_changed_early_or_expired', AppLog.data('item', item, 'currentKey', e.key(), 'scheduledAt', at, 'now', now, 'graceMs', ReminderEngine.GRACE)); continue; }
      const work = store.load(YearMonth.from(e.date)), view = store.loadCombined(YearMonth.from(e.date));
      if (work == null || !ReminderPlanner.stillMatches(e, view) || delivered.contains(e.key())) { decision(deliveryId, 'calendar_missing_changed_or_duplicate', AppLog.data('key', e.key(), 'calendarExists', work != null, 'stillMatches', view != null && ReminderPlanner.stillMatches(e, view), 'alreadyDelivered', delivered.contains(e.key()))); continue; }
      AppLog.event('reminder.delivery', AppLog.data('key', e.key(), 'code', rule.code, 'date', e.date.toString(), 'scheduledAt', at, 'receivedAt', now, 'lateMs', now - at, 'deliveryPath', deliveryPath, 'catchUp', deliveryPath === 'catchUp', 'late', now - at > 5000, 'lateThresholdMs', 5000, 'displayBody', ReminderEngine.body(view, e.date)));
      // A failed enqueue must not be marked delivered.
      try { ReminderEngine._post(c, settings, e.key(), REMINDER_ID, 'Ca ' + rule.code + ' · ' + e.date.format(DAY_FORMAT), ReminderEngine.body(view, e.date), e.date, null); }
      catch (failed) { AppLog.failure('reminder.notify', failed); return false; }
      delivered.add(e.key()); const saved = runtime(c).edit().putStringSet('delivered', delivered).commit(); decision(deliveryId, 'notification_posted', AppLog.data('tag', e.key(), 'deliveredGuardCommitted', saved)); if (!saved) return false;
    }
    return true;
  }
  /** Keeps the duplicate guard bounded; keys of recent dates (and unreadable ones) are kept. */
  static prune(delivered, today) {
    const kept = new JavaHashSet(); const oldest = today.minusDays(KEEP_DELIVERED_DAYS);
    for (const key of delivered) {
      const m = DATE.exec(key);
      try { if (m != null && LocalDate.parse(m[0]).isBefore(oldest)) continue; } catch (ignored) { if (!(ignored instanceof DateTimeException)) throw ignored; }
      kept.add(key);
    }
    return kept;
  }
  /** body(view, date[, today = LocalDate.now()]). */
  static body(view, date, today = LocalDate.now()) {
    const d = date.getDayOfMonth() - 1; const person = Schedule.givenName(view.swapPeople[d]); const when = date.equals(today) ? 'Hôm nay' : date.equals(today.plusDays(1)) ? 'Ngày mai' : 'Ngày ' + date.format(DAY_FORMAT);
    const code = Schedule.canonicalShift(view.shifts[d]); let text = when + (code === '' ? ' bạn nghỉ (OFF)' : code === 'P' ? ' bạn nghỉ phép (P)' : ' bạn có lịch đi làm ca ' + Schedule.displayCode(code));
    if (view.issues[d] != null) text += ' - ' + view.issues[d].label.toLowerCase() + ' với lịch phân ống';
    else if (view.kind !== Schedule.WORK) { const pipe = view.pipes[d], duty = view.duties[d]; if (pipe != null && pipe !== '') text += ' - ' + pipe; if (view.shifts[d] === 'D5' && duty != null && duty !== '') text += ' - ' + duty; if (!view.dayComplete(d)) text += ' - phân ống chưa đọc rõ'; }
    if (person !== '') text += ' - đổi cùng ' + person; return text;
  }
  /** Title and body of a manual test: the next saved day with that code, or clearly marked sample text. */
  static testText(views, code, today) {
    const wanted = code == null || trim(code) === '' ? null : Schedule.displayCode(code);
    if (wanted == null) return ['Lịch đi làm · Thông báo thử', 'Kiểm tra hiển thị và âm thanh thông báo của ứng dụng.'];
    for (const view of views) for (let d = 0; d < view.shifts.length; d++) {
      const date = view.month.atDay(d + 1);
      if (date.isBefore(today) || !view.present[d] || view.shifts[d] == null || wanted !== Schedule.displayCode(view.shifts[d])) continue;
      return ['Thử · Ca ' + wanted + ' · ' + date.format(DAY_FORMAT), ReminderEngine.body(view, date, today)];
    }
    return ['Thử · Ca ' + wanted, 'Chưa có ngày ' + wanted + ' từ hôm nay trong lịch đã lưu. Đây là nội dung mẫu để kiểm tra hiển thị và âm thanh.'];
  }
  /** Android notification channels: none on the web; the names stay for the screen's calls. */
  static channel(c, settings) { return ReminderEngine.CHANNEL_PREFIX + 'web'; } // eslint-disable-line no-unused-vars
  static applySoundChoice(c, settings) { return ReminderEngine.channel(c, settings); }
  static removeOldChannels(c, keep) {} // eslint-disable-line no-unused-vars
  /** The tone file can be opened: a bundled tone, or the phone's default sound (played by the system notification). */
  static readable(c, uri) { // eslint-disable-line no-unused-vars
    if (uri == null) return false; const s = String(uri); if (s.startsWith('content://settings/')) return true;
    const prefix = 'content://' + BundledToneUris.AUTHORITY + '/'; return s.startsWith(prefix) && BundledToneUris.validResource(s.substring(prefix.length));
  }
  static _post(c, settings, tag, id, title, body, date, subText) {
    const sound = settings.sound();
    AppLog.event('reminder.postAttempt', AppLog.data('tag', tag, 'chosenSound', sound, 'permission', NotificationManager.permission(), 'checks', ReminderEngine.diagnose(c).map(x => x.toString())));
    const month = date == null ? null : YearMonth.from(date).toString();
    NotificationManager.notify(tag, id, { title, body, subText, when: System.currentTimeMillis(), sound: ReminderEngine.audibleSound(c, sound), vibrate: settings.vibrate(), month, icon: new URL('../../assets/icons/icon-192.png', import.meta.url).href });
    AppLog.event('reminder.notification.enqueue', AppLog.data('tag', tag, 'id', id, 'activeImmediately', ReminderEngine.active(c, tag), 'meaning', 'notify_returned_not_proof_of_visual_or_audio_delivery'));
    AppLog.event('reminder.post', AppLog.data('tag', tag, 'id', id, 'title', title, 'body', body, 'date', date == null ? null : date.toString(), 'subText', subText, 'enqueued', true));
  }
  /** Each call is an independent notification with its own tag; earlier tests never block a new one. */
  static postTest(c, code, label, stableTag = null) {
    if (!ReminderEngine.allowed(c)) throw new IllegalArgumentException(BLOCKED);
    const settings = new ReminderSettings(c); const text = ReminderEngine.testText(ReminderEngine.calendars(c), code, LocalDate.now());
    const shown = NotificationManager.getActiveNotifications().filter(n => n.getTag() != null && n.getTag().startsWith(ReminderEngine.TEST_TAG));
    // Keep only the newest tests visible.
    shown.sort((a, b) => a.getPostTime() - b.getPostTime());
    for (let i = 0; i <= shown.length - MAX_TEST_NOTIFICATIONS; i++) NotificationManager.cancel(shown[i].getTag());
    const tag = stableTag == null ? ReminderEngine.TEST_TAG + UUID.randomUUID() : stableTag; const time = LocalTime.now().format(DateTimeFormatter.ofPattern('HH:mm:ss'));
    ReminderEngine._post(c, settings, tag, TEST_ID, text[0], text[1], LocalDate.now(), (label == null ? 'Thông báo thử' : label) + ' · ' + time);
    return tag;
  }
  static test(c) { return ReminderEngine.postTest(c, null, null); }
  static active(c, tag) { return NotificationManager.isActive(tag); } // eslint-disable-line no-unused-vars
  /** Schedules one independent test at the next occurrence of the given time; reminders are untouched. */
  static scheduleTest(c, minuteOfDay, code) {
    if (!ReminderEngine.allowed(c)) throw new IllegalArgumentException(BLOCKED);
    if (minuteOfDay < 0 || minuteOfDay >= 1440) throw new IllegalArgumentException('Giờ thử không hợp lệ.');
    const now = ZonedDateTime.now(); let at = now.toLocalDate().atTime(Math.trunc(minuteOfDay / 60), minuteOfDay % 60).atZone(now.getZone());
    if (!at.isAfter(now.plusSeconds(5))) at = at.plusDays(1);
    const when = at.toInstant().toEpochMilli(); ReminderEngine._saveTest(c, when, code, 'alarmClock', true); return when;
  }
  static _saveTest(c, when, code, mode, foreground) {
    if (!ReminderEngine.allowed(c)) throw new IllegalArgumentException('Cho phép thông báo trước khi hẹn thử.');
    const s = new ReminderSettings(c); const list = tests(runtime(c)); const id = String(UUID.randomUUID());
    list.put(new JSONObject().put('id', id).put('at', when).put('code', code == null ? '' : trim(code)).put('mode', mode).put('foregroundBroadcast', foreground));
    if (!runtime(c).edit().putString('tests', list.toString()).commit()) throw new IllegalStateException('Không lưu được lần thử.');
    ReminderEngine._arm(c, when, 'test', id); return id;
  }
  static deliverTest(c, id, path = 'testReceiver') {
    if (!ReminderEngine.leader) return;
    const s = new ReminderSettings(c); const list = tests(runtime(c)), kept = new JSONArray(); let found = null;
    for (let i = 0; i < list.length(); i++) { const o = list.optJSONObject(i); if (o != null && id != null && id === o.optString('id')) found = o; else if (o != null) kept.put(o); }
    if (found == null) { decision(id, 'test_id_not_pending'); return; }
    // Commit removal only after a successful enqueue; failed sends remain retryable.
    AppLog.event('reminder.due', AppLog.data('id', id, 'scheduledAt', found.optLong('at'), 'observedAt', System.currentTimeMillis(), 'path', path));
    if (!ReminderEngine.allowed(c)) { decision(id, 'test_notifications_blocked'); return; }
    if (System.currentTimeMillis() < found.optLong('at')) { decision(id, 'test_not_due'); ReminderEngine._arm(c, found.optLong('at'), 'test', id); return; }
    const time = Instant.ofEpochMilli(found.optLong('at')).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern('HH:mm'));
    try {
      const tag = ReminderEngine.postTest(c, found.optString('code', ''), 'Thử hẹn giờ ' + time, ReminderEngine.TEST_TAG + 'scheduled-' + id); decision(id, 'test_posted', AppLog.data('tag', tag));
      AlarmManager.cancel(testKey(id)); // web: delivered early by a catch-up → its page timer is spent too
      if (!runtime(c).edit().putString('tests', kept.toString()).commit()) decision(id, 'test_remove_commit_failed');
    } catch (failure) { AppLog.failure('reminder.deliverTest', failure); }
  }
  /** Pending manual tests survive reloads; a test that became due while the page was closed is shown late once. */
  static _rearmTests(c, now) {
    const list = tests(runtime(c));
    for (let i = 0; i < list.length(); i++) {
      const o = list.optJSONObject(i); if (o == null) continue; const at = o.optLong('at'); const id = o.optString('id');
      if (at > now) { if (!AlarmManager.has(testKey(id))) { AppLog.event('reminder.test.rearm', AppLog.data('id', id, 'handleExists', false)); ReminderEngine._arm(c, at, 'test', id); } }
      else if (now - at <= ReminderEngine.GRACE) ReminderEngine.deliverTest(c, id, 'catchUp'); else ReminderEngine.cancelTest(c, id);
    }
  }
  /** Saved manual tests, earliest first; each entry is [at]. */
  static pendingTests(c) { const out = []; const list = tests(runtime(c)); for (let i = 0; i < list.length(); i++) { const o = list.optJSONObject(i); if (o != null) out.push([o.optLong('at')]); } out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); return out; }
  static cancelTest(c, id) {
    const had = AlarmManager.has(testKey(id)); AlarmManager.cancel(testKey(id)); AppLog.event('reminder.cancelled', AppLog.data('id', id, 'reason', 'cancelTest', 'timerExisted', had));
    const s = new ReminderSettings(c); const list = tests(runtime(c)), kept = new JSONArray(); for (let i = 0; i < list.length(); i++) { const o = list.optJSONObject(i); if (o != null && id !== o.optString('id')) kept.put(o); } runtime(c).edit().putString('tests', kept.toString()).commit();
  }
  static cancelTests(c) { const list = tests(runtime(c)); for (let i = 0; i < list.length(); i++) { const o = list.optJSONObject(i); if (o != null) ReminderEngine.cancelTest(c, o.optString('id')); } runtime(c).edit().remove('tests').commit(); }
  /** The checks with a web counterpart: the notification permission and the chosen tone file. */
  static diagnose(c) {
    const out = []; const settings = new ReminderSettings(c);
    const permitted = NotificationManager.granted(); out.push(new Check(permitted, 'Quyền thông báo của app', permitted ? 'Đang cho phép.' : 'Đang tắt: trình duyệt sẽ không hiện thông báo của Lịch đi làm.'));
    const chosen = settings.sound() === '' ? null : settings.sound();
    if (chosen != null) out.push(new Check(ReminderEngine.readable(c, chosen), 'Tệp âm đã chọn', ReminderEngine.readable(c, chosen) ? 'Đọc được.' : 'Không mở được tệp âm; app dùng âm mặc định của điện thoại.'));
    return out;
  }
  /** The saved reminder state for the exported log (the Android channel, alarm, keeper, boot, audio and runtime
   *  fields have no web counterpart and are left out). */
  static logState(c) {
    const s = new ReminderSettings(c);
    return AppLog.data('capturedAt', System.currentTimeMillis(), 'enabled', s.enabled(), 'selectedSound', s.sound(), 'selectedSoundName', s.soundName(), 'channelRevision', s.channelRevision(), 'nextAt', runtime(c).getLong('nextAt', 0), 'queueSchema', 40, 'queue', queue(runtime(c)), 'lastError', runtime(c).getString('lastError', ''), 'pageTimers', AlarmManager.keys(), 'notificationPermission', NotificationManager.permission());
  }
  /** Turns reminders off and forgets every planned and test reminder, with their page timers and notifications. */
  static reset(c) {
    const q = queue(runtime(c)); for (let i = 0; i < q.length(); i++) { const o = q.optJSONObject(i); if (o != null) ReminderEngine._cancelSlot(c, o, 'reset'); }
    ReminderEngine.cancelTests(c);
    new ReminderSettings(c).prefs.edit().putBoolean('enabled', false).commit(); runtime(c).edit().remove('token').remove('pending').remove('nextAt').remove('tests').remove('queue40').commit();
    NotificationManager.cancelAll();
  }
}
