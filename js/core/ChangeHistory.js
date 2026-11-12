// Port of vn.lichdilam.ChangeHistory (APK 4.5). The Java field `swap` is `_swap` here (swap() is a method).
import { IllegalStateException, UUID, System, Objects } from '../platform/java.js';
import { JSONObject, JSONArray, JSONException } from '../platform/json.js';
import { LocalDate } from '../platform/time.js';
import { Schedule } from './Schedule.js';
import { PipeDay } from './PipeDay.js';
import { ConfirmedNames } from './ConfirmedNames.js';

const nullable = s => (s == null ? JSONObject.NULL : s);
const rethrowUnlessJson = e => { if (!(e instanceof JSONException)) throw e; };

/** One swap between the calendar owner and one other person, shown together in one history entry. */
class Swap {
  constructor(ownerName, ownerCode, partnerName, partnerPrinted, partnerCode, partnerConfirmed) {
    this.ownerName = ownerName; this.ownerCode = ownerCode; this.partnerName = partnerName; this.partnerPrinted = partnerPrinted; this.partnerCode = partnerCode;
    /** The full name was accepted or typed by the user; otherwise it is the name printed on the pipe photo. */
    this.partnerConfirmed = partnerConfirmed; Object.freeze(this);
  }
  json() { return new JSONObject().put('ownerName', this.ownerName).put('ownerCode', nullable(this.ownerCode)).put('partnerName', this.partnerName).put('partnerPrinted', this.partnerPrinted).put('partnerCode', nullable(this.partnerCode)).put('partnerConfirmed', this.partnerConfirmed); }
  static parse(o) { return new Swap(o.getString('ownerName'), o.isNull('ownerCode') ? null : o.getString('ownerCode'), o.getString('partnerName'), o.optString('partnerPrinted', o.getString('partnerName')), o.isNull('partnerCode') ? null : o.getString('partnerCode'), o.optBoolean('partnerConfirmed', false)); }
}

/** Day-sized before/after snapshots, committed together with the calendar transaction. */
export class ChangeHistory {
  static Swap = Swap;
  /** (owner, date, action, before, after[, swap]) — new id and time; (id, owner, date, time, action, before, after, swap) — as stored. */
  constructor(...a) {
    let id, owner, date, time, action, before, after, swap;
    if (a.length >= 8) [id, owner, date, time, action, before, after, swap] = a;
    else { [owner, date, action, before, after, swap = null] = a; id = UUID.randomUUID().toString(); time = System.currentTimeMillis(); }
    this.id = id; this.owner = owner; this.date = date; this.time = time; this.action = action; this.before = before; this.after = after;
    /** Both people of one swap, frozen when it is saved (1.7.2+); null for other changes and older records. */
    this._swap = swap;
  }
  static snapshot(work, pipe, day) {
    const result = new JSONObject();
    for (const kind of [Schedule.WORK, Schedule.PIPE]) {
      const s = kind === Schedule.WORK ? work : pipe; const value = new JSONObject();
      value.put('present', s != null && s.present[day]);
      value.put('code', nullable(s == null ? null : s.shifts[day]));
      value.put('pipe', nullable(s == null ? null : s.pipes[day]));
      value.put('duty', nullable(s == null ? null : s.duties[day]));
      value.put('person', s == null ? '' : s.swapPeople[day]); value.put('number', s == null ? 0 : s.swapNumbers[day]);
      result.put(String(kind), value);
    } return result;
  }
  static apply(snapshot, s, day) {
    const v = snapshot.getJSONObject(String(s.kind));
    s.present[day] = v.getBoolean('present'); s.shifts[day] = ChangeHistory._value(v, 'code'); s.pipes[day] = ChangeHistory._value(v, 'pipe'); s.duties[day] = ChangeHistory._value(v, 'duty');
    s.swapPeople[day] = v.getString('person'); s.swapNumbers[day] = v.getInt('number');
  }
  static present(snapshot, kind) { return snapshot.getJSONObject(String(kind)).getBoolean('present'); }
  static _value(o, key) { const value = o.isNull(key) ? null : o.getString(key); return key === 'code' ? Schedule.canonicalShift(value) : Schedule.canonicalToken(value); }
  beforeLabel() { return ChangeHistory._label(this.before); }
  afterLabel() { return ChangeHistory._label(this.after); }
  static _label(state) {
    try {
      const work = state.getJSONObject('1'), pipe = state.getJSONObject('2'), code = work.getBoolean('present') ? work : pipe;
      if (!code.getBoolean('present')) return 'Chưa có dữ liệu';
      const shift = ChangeHistory._value(code, 'code'), person = code.getString('person'); let result = Schedule.displayCode(shift);
      if (pipe.getBoolean('present') && Objects.equals(shift, ChangeHistory._value(pipe, 'code')) && shift !== '' && shift !== 'P') result += ' · ' + new PipeDay(shift, ChangeHistory._value(pipe, 'pipe'), ChangeHistory._value(pipe, 'duty'), '', '').assignment();
      return result + (person === '' ? '' : ' · ' + person);
    } catch (e) { rethrowUnlessJson(e); throw new IllegalStateException('Lịch sử không đọc được.', e); }
  }
  json() { const o = new JSONObject().put('id', this.id).put('owner', this.owner).put('date', this.date.toString()).put('time', this.time).put('action', this.action).put('before', this.before).put('after', this.after); if (this._swap != null) o.put('swap', this._swap); return o; }
  static read(raw) {
    try {
      const a = new JSONArray(raw); const result = [];
      for (let i = 0; i < a.length(); i++) { const o = a.getJSONObject(i); result.push(new ChangeHistory(o.getString('id'), o.getString('owner'), LocalDate.parse(o.getString('date')), o.getLong('time'), o.getString('action'), o.getJSONObject('before'), o.getJSONObject('after'), o.optJSONObject('swap'))); }
      return result;
    } catch (e) { throw new IllegalStateException('Không đọc được lịch sử. Dữ liệu cũ được giữ nguyên.', e); }
  }
  static _codeSource(state) { const work = state.getJSONObject('1'), pipe = state.getJSONObject('2'); return work.getBoolean('present') ? work : pipe; }
  /** Displayed shift code of a stored day (OFF for rest), or null when that day had no known code. */
  static code(state) { const c = ChangeHistory._codeSource(state); if (!c.getBoolean('present')) return null; const code = ChangeHistory._value(c, 'code'); return code == null ? null : Schedule.displayCode(code); }
  static person(state) { return Schedule.normalizePerson(ChangeHistory._codeSource(state).getString('person')); }
  /** The owner's own code before any swap on that day: this record's "before" if it had no swap person,
   *  otherwise the newest earlier record of the same day whose "before" had none. Null when not recorded. */
  static originalCode(chronological, date, owner, before) {
    if (ChangeHistory.person(before) === '') return ChangeHistory.code(before);
    let found = null; for (const h of chronological) if (h.date.equals(date) && Schedule.sameName(h.owner, owner) && ChangeHistory.person(h.before) === '') found = ChangeHistory.code(h.before);
    return found;
  }
  /** Swap data for a new record; null when the change did not pick another person. */
  static swapRecord(owner, before, after, change, existing) {
    if (change == null || !change.lookupPerson || change.person === '') return null;
    const full = change.fullName === '' ? change.person : change.fullName;
    return new Swap(Schedule.normalizePerson(owner), ChangeHistory.code(after), full, change.person, ChangeHistory.originalCode(existing, change.date, owner, before), change.fullName !== '').json();
  }
  /** Both sides of this entry if it is a swap. Older records are converted only from their stored before/after
   *  states; a full name is shown only if the user confirmed one for that printed name. */
  swap(chronological, names) {
    try {
      if (this._swap != null) return Swap.parse(this._swap);
      if (this.action.startsWith('Khôi phục')) return null;
      const partner = ChangeHistory.person(this.after); if (partner === '' || Schedule.normalizeName(partner) === Schedule.normalizeName(ChangeHistory.person(this.before))) return null;
      const earlier = []; for (const h of chronological) { if (h === this || h.id === this.id) break; earlier.push(h); }
      const full = names == null ? null : names.full(partner);
      return new Swap(Schedule.normalizePerson(this.owner), ChangeHistory.code(this.after), full == null ? partner : full, partner, ChangeHistory.originalCode(earlier, this.date, this.owner, this.before), full != null);
    } catch (e) { rethrowUnlessJson(e); return null; }
  }
  /** Applies a corrected full name to every saved swap with this printed partner name. */
  static renamePartner(records, printed, full) {
    for (const h of records) if (h._swap != null && ConfirmedNames.key(h._swap.optString('partnerPrinted', h._swap.optString('partnerName'))) === ConfirmedNames.key(printed)) h._swap.put('partnerName', full).put('partnerConfirmed', true);
  }
  static write(records) { const a = new JSONArray(); for (const h of records) a.put(h.json()); return a.toString(); }
}
