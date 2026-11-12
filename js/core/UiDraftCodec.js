// Port of vn.lichdilam.UiDraftCodec (APK 4.5). The Java overloads schedule(Schedule)/schedule(String) and
// changes(Collection)/changes(String) are one method each here, chosen by the argument type.
import { JSONObject, JSONArray } from '../platform/json.js';
import { YearMonth, LocalDate } from '../platform/time.js';
import { iterableOf } from '../platform/java.js';
import { Schedule } from './Schedule.js';
import { ScheduleStore } from './ScheduleStore.js';
import { CalendarIssue } from './CalendarIssue.js';
import { ShiftChange } from './ShiftChange.js';

const str = (a, d) => (a.isNull(d) ? null : a.optString(d));
const nullable = (o, key) => (o.isNull(key) ? null : o.optString(key));

/** Draft-only encoding: never writes into the saved roster or automatically confirms a lookup. */
export class UiDraftCodec {
  /** schedule(Schedule) → JSON text; schedule(String) → Schedule. */
  static schedule(arg) { return typeof arg === 'string' ? UiDraftCodec._decodeSchedule(arg) : UiDraftCodec._encodeSchedule(arg); }
  static _encodeSchedule(s) {
    const o = new JSONObject(ScheduleStore.encode(s)).put('month', s.month.toString()); const issues = new JSONArray();
    for (const i of s.issues) issues.put(i == null ? JSONObject.NULL : new JSONObject().put('label', i.label).put('detail', i.detail)); return o.put('issues', issues).toString();
  }
  static _decodeSchedule(json) {
    const o = new JSONObject(json); const a = o.getJSONArray('days'); const n = a.length(); const days = new Array(n).fill(null), people = new Array(n).fill(null), pipes = new Array(n).fill(null), duties = new Array(n).fill(null); const numbers = new Array(n).fill(0);
    for (let d = 0; d < n; d++) { days[d] = str(a, d); people[d] = o.getJSONArray('swapPeople').optString(d, ''); numbers[d] = o.getJSONArray('swapNumbers').optInt(d); pipes[d] = str(o.getJSONArray('pipes'), d); duties[d] = str(o.getJSONArray('duties'), d); }
    const s = new Schedule(o.getInt('kind'), YearMonth.parse(o.getString('month')), o.getInt('number'), o.getString('name'), days, people, numbers, pipes, duties);
    const present = o.getJSONArray('present'), issues = o.optJSONArray('issues'); for (let d = 0; d < n; d++) { s.present[d] = present.optBoolean(d, true); const i = issues == null ? null : issues.optJSONObject(d); if (i != null) s.issues[d] = new CalendarIssue(i.getString('label'), i.getString('detail')); } return s;
  }
  /** changes(Collection<ShiftChange>) → JSON text; changes(String) → List<ShiftChange>. */
  static changes(arg) { return typeof arg === 'string' ? UiDraftCodec._decodeChanges(arg) : UiDraftCodec._encodeChanges(arg); }
  static _encodeChanges(changes) {
    const a = new JSONArray(); for (const s of iterableOf(changes)) a.put(new JSONObject().put('date', s.date.toString()).put('code', s.code == null ? JSONObject.NULL : s.code).put('person', s.updatesPerson ? s.person : JSONObject.NULL).put('number', s.personNumber).put('pipe', s.pipe == null ? JSONObject.NULL : s.pipe).put('duty', s.duty == null ? JSONObject.NULL : s.duty).put('updatesPipe', s.updatesPipe).put('confirmedPipe', s.confirmedPipe).put('lookupPerson', s.lookupPerson).put('personKey', s.personKey).put('fullName', s.fullName).put('manualAssignment', s.manualAssignment)); return a.toString();
  }
  static _decodeChanges(json) {
    const a = new JSONArray(json); const out = []; for (let i = 0; i < a.length(); i++) { const o = a.getJSONObject(i); const change = new ShiftChange(LocalDate.parse(o.getString('date')), nullable(o, 'code'), nullable(o, 'person'), o.getInt('number'), nullable(o, 'pipe'), nullable(o, 'duty'), o.getBoolean('updatesPipe'), o.getBoolean('confirmedPipe'), o.getBoolean('lookupPerson')).forPerson(o.optString('personKey', '')).withFullName(o.optString('fullName', '')); out.push(o.optBoolean('manualAssignment', false) ? change.withManualAssignment() : change); } return out;
  }
}
