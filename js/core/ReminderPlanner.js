// Port of vn.lichdilam.ReminderPlanner (APK 4.5).
import { compareTo, idiv, irem } from '../platform/java.js';
import { YearMonth } from '../platform/time.js';
import { Schedule } from './Schedule.js';

class Event {
  constructor(rule, date, zone) { this.rule = rule; this.date = date; this.at = date.minusDays(rule.daysBefore).atTime(idiv(rule.minute, 60), irem(rule.minute, 60)).atZone(zone).toInstant(); }
  /** One reminder per shift date, code and exact moment. Editing the time yields a new, valid key. */
  key() { return 'v2/' + this.date + '/' + this.rule.code + '/' + this.at.toEpochMilli(); }
}
/** Comparator.comparing(e -> e.at).thenComparing(Event::key), shared with ReminderQueue. */
const byTimeThenKey = (a, b) => a.at.compareTo(b.at) || compareTo(a.key(), b.key());

/** Pure calendar planning; no OCR, clock polling, or recurring guesses for missing months. */
export class ReminderPlanner {
  static Event = Event;
  static _byTimeThenKey = byTimeThenKey;
  static upcoming(rules, calendars, now, zone) {
    const result = []; const seen = new Set();
    for (const calendar of calendars) for (let day = 0; day < calendar.shifts.length; day++) {
      if (!calendar.present[day] || calendar.shifts[day] == null) continue;
      for (const rule of rules) if (rule.enabled && rule.code === Schedule.displayCode(calendar.shifts[day])) {
        const e = new Event(rule, calendar.month.atDay(day + 1), zone);
        if (e.at.isAfter(now) && !seen.has(e.key())) { seen.add(e.key()); result.push(e); }
      }
    }
    result.sort(byTimeThenKey); return result;
  }
  static stillMatches(e, calendar) { return calendar != null && calendar.month.equals(YearMonth.from(e.date)) && calendar.present[e.date.getDayOfMonth() - 1] && e.rule.enabled && e.rule.code === Schedule.displayCode(calendar.shifts[e.date.getDayOfMonth() - 1]); }
}
