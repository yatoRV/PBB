// java.time subset used by the app: LocalDate, YearMonth, LocalTime, LocalDateTime, ZonedDateTime, Instant,
// ZoneId/ZoneOffset, Duration, ChronoUnit, DayOfWeek, DateTimeFormatter.ofPattern (numeric fields + literals).
// The system zone is the JS runtime's local zone (Date); "now" comes from java.js System.currentTimeMillis().
import { RuntimeException, IllegalArgumentException, System } from './java.js';

export class DateTimeException extends RuntimeException { static javaName = 'java.time.DateTimeException'; }
export class DateTimeParseException extends DateTimeException {
  static javaName = 'java.time.format.DateTimeParseException';
  constructor(message, parsedData, errorIndex, cause) { super(message, cause); this.parsedString = parsedData; this.errorIndex = errorIndex; }
  getParsedString() { return this.parsedString; }
  getErrorIndex() { return this.errorIndex; }
}
export class UnsupportedTemporalTypeException extends DateTimeException { static javaName = 'java.time.temporal.UnsupportedTemporalTypeException'; }

const MS_DAY = 86400000, DAYS_PER_CYCLE = 146097, DAYS_0000_TO_1970 = 719528;
const tdiv = (a, b) => Math.trunc(a / b);
const fdiv = (a, b) => Math.floor(a / b);
const fmod = (a, b) => a - Math.floor(a / b) * b;
const pad = (v, n) => String(v).padStart(n, '0');
const MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const isLeap = y => (y & 3) === 0 && (y % 100 !== 0 || y % 400 === 0);
const monthLength = (y, m) => (m === 2 ? (isLeap(y) ? 29 : 28) : m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31);
function check(name, v, min, max, maxLabel) {
  if (!Number.isInteger(v) || v < min || v > max) throw new DateTimeException('Invalid value for ' + name + ' (valid values ' + min + ' - ' + (maxLabel ?? max) + '): ' + v);
  return v;
}
const YEAR_MIN = -999999999, YEAR_MAX = 999999999;
function yearString(y, plus) { const a = Math.abs(y); if (a < 1000) return (y < 0 ? '-' : '') + pad(a, 4); return (plus && y > 9999 ? '+' : '') + y; }
function toEpochDay(year, month, day) {
  let total = 365 * year;
  if (year >= 0) total += tdiv(year + 3, 4) - tdiv(year + 99, 100) + tdiv(year + 399, 400);
  else total -= tdiv(year, -4) - tdiv(year, -100) + tdiv(year, -400);
  total += tdiv(367 * month - 362, 12) + day - 1;
  if (month > 2) { total--; if (!isLeap(year)) total--; }
  return total - DAYS_0000_TO_1970;
}
function fromEpochDay(epochDay) {
  let zeroDay = epochDay + DAYS_0000_TO_1970 - 60, adjust = 0;
  if (zeroDay < 0) { const cycles = tdiv(zeroDay + 1, DAYS_PER_CYCLE) - 1; adjust = cycles * 400; zeroDay += -cycles * DAYS_PER_CYCLE; }
  let yearEst = tdiv(400 * zeroDay + 591, DAYS_PER_CYCLE);
  let doyEst = zeroDay - (365 * yearEst + tdiv(yearEst, 4) - tdiv(yearEst, 100) + tdiv(yearEst, 400));
  if (doyEst < 0) { yearEst--; doyEst = zeroDay - (365 * yearEst + tdiv(yearEst, 4) - tdiv(yearEst, 100) + tdiv(yearEst, 400)); }
  yearEst += adjust;
  const marchMonth0 = tdiv(doyEst * 5 + 2, 153);
  const month = ((marchMonth0 + 2) % 12) + 1, dom = doyEst - tdiv(marchMonth0 * 306 + 5, 10) + 1;
  return [yearEst + tdiv(marchMonth0, 10), month, dom];
}

// ------------------------------------------------------------------ zones
/** java.time.ZoneId: the runtime's local zone (systemDefault) or a fixed offset (ZoneOffset). */
export class ZoneId {
  constructor(kind, offsetMs, id) { this.kind = kind; this.fixedOffset = offsetMs; this.id = id; }
  static systemDefault() { return defaultZone ?? SYSTEM_ZONE; }
  static of(id) {
    if (id === 'Z' || id === 'UTC' || id === 'GMT') return id === 'Z' ? ZoneOffset.UTC : new ZoneId('fixed', 0, id);
    const m = /^(?:UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(id);
    if (m) return ZoneOffset.ofHoursMinutes((m[1] === '-' ? -1 : 1) * +m[2], (m[1] === '-' ? -1 : 1) * +(m[3] || 0));
    if (id === SYSTEM_ZONE.id) return SYSTEM_ZONE;
    if (/^[A-Za-z][A-Za-z0-9~/._+-]+$/.test(id)) { const fmt = regionFormatter(id); if (fmt) return new ZoneId('region', 0, id); }
    throw new DateTimeException('Unknown time-zone ID: ' + id);
  }
  getId() { return this.id; }
  toString() { return this.id; }
  equals(o) { return o instanceof ZoneId && o.kind === this.kind && o.id === this.id && o.fixedOffset === this.fixedOffset; }
  hashCode() { return this.fixedOffset | 0; }
  /** Offset (ms) in force at an instant. */
  offsetAt(epochMs) { return this.kind === 'fixed' ? this.fixedOffset : this.kind === 'region' ? regionOffset(this.id, epochMs) : -new Date(epochMs).getTimezoneOffset() * 60000; }
  /** Local date-time -> epoch ms (gap: shifted later by the gap; overlap: earlier offset, like Java). */
  localToEpoch(epochDay, msOfDay) {
    if (this.kind === 'fixed') return epochDay * MS_DAY + msOfDay - this.fixedOffset;
    if (this.kind === 'region') {
      // Offsets a day before and after the local time; the earlier one wins in an overlap and in a gap
      // (a gap time then moves later by the gap length), the later one when only it is valid.
      const local = epochDay * MS_DAY + msOfDay, before = this.offsetAt(local - MS_DAY), after = this.offsetAt(local + MS_DAY);
      const t1 = local - before, t2 = local - after;
      if (this.offsetAt(t1) === before) return t1;
      if (this.offsetAt(t2) === after) return t2;
      return t1;
    }
    const [y, mo, d] = fromEpochDay(epochDay); const dt = new Date(0);
    dt.setFullYear(y, mo - 1, d); dt.setHours(0, 0, 0, msOfDay); return dt.getTime();
  }
}
export class ZoneOffset extends ZoneId {
  static ofHoursMinutes(h, m) { const total = h * 3600000 + m * 60000; if (total === 0) return ZoneOffset.UTC; const a = Math.abs(total); return new ZoneOffset('fixed', total, (total < 0 ? '-' : '+') + pad(Math.floor(a / 3600000), 2) + ':' + pad((a / 60000) % 60, 2)); }
  static ofHours(h) { return ZoneOffset.ofHoursMinutes(h, 0); }
  getTotalSeconds() { return this.fixedOffset / 1000; }
}
ZoneOffset.UTC = new ZoneOffset('fixed', 0, 'Z');
/** IANA region zones (ZoneId.of("Asia/Bangkok")) use the runtime's tz database through Intl. */
const regionFormatters = new Map();
function regionFormatter(id) {
  if (regionFormatters.has(id)) return regionFormatters.get(id);
  let fmt = null;
  try { fmt = new Intl.DateTimeFormat('en-US', { timeZone: id, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', era: 'short' }); } catch { fmt = null; }
  regionFormatters.set(id, fmt); return fmt;
}
function regionOffset(id, epochMs) {
  const whole = epochMs - fmod(epochMs, 1000); const p = {};
  for (const part of regionFormatter(id).formatToParts(new Date(whole))) p[part.type] = part.value;
  const year = p.era === 'BC' || p.era === 'B' ? 1 - Number(p.year) : Number(p.year);
  const local = toEpochDay(year, Number(p.month), Number(p.day)) * MS_DAY + ((Number(p.hour) * 60 + Number(p.minute)) * 60 + Number(p.second)) * 1000;
  return local - whole;
}
const SYSTEM_ZONE = new ZoneId('system', 0,(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'SYSTEM'; } catch { return 'SYSTEM'; } })());
let defaultZone = null;
/** Tests may pin ZoneId.systemDefault() (e.g. ZoneOffset.ofHours(7)); null restores the runtime zone. */
export function setDefaultZoneForTesting(zone) { defaultZone = zone; }
function offsetId(ms) { if (ms === 0) return 'Z'; const a = Math.abs(ms), s = Math.floor(a / 1000) % 60; return (ms < 0 ? '-' : '+') + pad(Math.floor(a / 3600000), 2) + ':' + pad(Math.floor(a / 60000) % 60, 2) + (s ? ':' + pad(s, 2) : ''); }

// ------------------------------------------------------------------ enums
export class DayOfWeek {
  constructor(v, name) { this.v = v; this._name = name; }
  getValue() { return this.v; }
  name() { return this._name; }
  ordinal() { return this.v - 1; }
  toString() { return this._name; }
  plus(days) { return DayOfWeek.of(fmod(this.v - 1 + days, 7) + 1); }
  minus(days) { return this.plus(-(days % 7)); }
  compareTo(o) { return this.v - o.v; }
  equals(o) { return o === this; }
  static of(v) { if (!(v >= 1 && v <= 7)) throw new DateTimeException('Invalid value for DayOfWeek: ' + v); return DOW[v - 1]; }
  static values() { return [...DOW]; }
}
const DOW = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].map((n, i) => new DayOfWeek(i + 1, n));
for (const d of DOW) DayOfWeek[d.name()] = d;

export class ChronoUnit {
  constructor(name, display) { this._name = name; this.display = display; }
  name() { return this._name; }
  toString() { return this.display; }
  /** unit.between(a, b) == a.until(b, unit). */
  between(a, b) { return a.until(b, this); }
}
for (const [n, d] of [['MILLIS', 'Millis'], ['SECONDS', 'Seconds'], ['MINUTES', 'Minutes'], ['HOURS', 'Hours'], ['DAYS', 'Days'], ['WEEKS', 'Weeks'], ['MONTHS', 'Months'], ['YEARS', 'Years']]) ChronoUnit[n] = new ChronoUnit(n, d);
const TIME_UNIT_MS = { MILLIS: 1, SECONDS: 1000, MINUTES: 60000, HOURS: 3600000 };
const unsupportedUnit = u => new UnsupportedTemporalTypeException('Unsupported unit: ' + u);

// ------------------------------------------------------------------ LocalDate
export class LocalDate {
  constructor(y, m, d) { this.year = y; this.month = m; this.day = d; Object.freeze(this); }
  static of(year, month, dayOfMonth) {
    check('Year', year, YEAR_MIN, YEAR_MAX); check('MonthOfYear', month, 1, 12); check('DayOfMonth', dayOfMonth, 1, 31, '28/31');
    if (dayOfMonth > 28 && dayOfMonth > monthLength(year, month)) {
      if (dayOfMonth === 29) throw new DateTimeException("Invalid date 'February 29' as '" + year + "' is not a leap year");
      throw new DateTimeException("Invalid date '" + MONTH_NAMES[month - 1] + ' ' + dayOfMonth + "'");
    }
    return new LocalDate(year, month, dayOfMonth);
  }
  static ofEpochDay(epochDay) { const [y, m, d] = fromEpochDay(epochDay); return new LocalDate(y, m, d); }
  static ofYearDay(year, dayOfYear) { check('DayOfYear', dayOfYear, 1, isLeap(year) ? 366 : 365, '365/366'); return LocalDate.ofEpochDay(toEpochDay(year, 1, 1) + dayOfYear - 1); }
  static now(zone = ZoneId.systemDefault()) { return Instant.now().atZone(zone).toLocalDate(); }
  /** ISO_LOCAL_DATE (uuuu-MM-dd). */
  static parse(text, formatter) {
    if (formatter) return formatter.parse(text, LocalDate.from);
    const p = new IsoParser(text), y = p.year(); p.lit('-'); const m = p.num2(); p.lit('-'); const d = p.num2(); p.end();
    return p.build(() => LocalDate.of(y, m, d));
  }
  static from(t) {
    if (t instanceof LocalDate) return t;
    if (t instanceof LocalDateTime || t instanceof ZonedDateTime) return t.toLocalDate();
    throw new DateTimeException('Unable to obtain LocalDate from TemporalAccessor: ' + t + ' of type ' + (t?.constructor?.name ?? typeof t));
  }
  getYear() { return this.year; }
  getMonthValue() { return this.month; }
  getDayOfMonth() { return this.day; }
  getDayOfYear() { return toEpochDay(this.year, this.month, this.day) - toEpochDay(this.year, 1, 1) + 1; }
  getDayOfWeek() { return DOW[fmod(this.toEpochDay() + 3, 7)]; }
  lengthOfMonth() { return monthLength(this.year, this.month); }
  lengthOfYear() { return isLeap(this.year) ? 366 : 365; }
  isLeapYear() { return isLeap(this.year); }
  toEpochDay() { return toEpochDay(this.year, this.month, this.day); }
  plusDays(n) { return n === 0 ? this : LocalDate.ofEpochDay(this.toEpochDay() + n); }
  minusDays(n) { return this.plusDays(-n); }
  plusWeeks(n) { return this.plusDays(n * 7); }
  minusWeeks(n) { return this.plusDays(-n * 7); }
  plusMonths(n) { if (n === 0) return this; const calc = this.year * 12 + (this.month - 1) + n; const y = fdiv(calc, 12), m = fmod(calc, 12) + 1; check('Year', y, YEAR_MIN, YEAR_MAX); return new LocalDate(y, m, Math.min(this.day, monthLength(y, m))); }
  minusMonths(n) { return this.plusMonths(-n); }
  plusYears(n) { if (n === 0) return this; const y = check('Year', this.year + n, YEAR_MIN, YEAR_MAX); return new LocalDate(y, this.month, Math.min(this.day, monthLength(y, this.month))); }
  minusYears(n) { return this.plusYears(-n); }
  plus(n, unit) { switch (unit) { case ChronoUnit.DAYS: return this.plusDays(n); case ChronoUnit.WEEKS: return this.plusWeeks(n); case ChronoUnit.MONTHS: return this.plusMonths(n); case ChronoUnit.YEARS: return this.plusYears(n); default: throw unsupportedUnit(unit); } }
  minus(n, unit) { return this.plus(-n, unit); }
  withDayOfMonth(d) { return this.day === d ? this : LocalDate.of(this.year, this.month, d); }
  withMonth(m) { check('MonthOfYear', m, 1, 12); return new LocalDate(this.year, m, Math.min(this.day, monthLength(this.year, m))); }
  withYear(y) { check('Year', y, YEAR_MIN, YEAR_MAX); return new LocalDate(y, this.month, Math.min(this.day, monthLength(y, this.month))); }
  atTime(h, m = 0, s = 0, n = 0) { return h instanceof LocalTime ? new LocalDateTime(this, h) : new LocalDateTime(this, LocalTime.of(h, m, s, n)); }
  /** atStartOfDay() -> LocalDateTime; atStartOfDay(zone) -> ZonedDateTime. */
  atStartOfDay(zone) { const ldt = new LocalDateTime(this, LocalTime.MIDNIGHT); return zone ? ldt.atZone(zone) : ldt; }
  _prolepticMonth() { return this.year * 12 + this.month - 1; }
  until(end, unit) {
    const e = LocalDate.from(end);
    switch (unit) {
      case ChronoUnit.DAYS: return e.toEpochDay() - this.toEpochDay();
      case ChronoUnit.WEEKS: return tdiv(e.toEpochDay() - this.toEpochDay(), 7);
      case ChronoUnit.MONTHS: return this._monthsUntil(e);
      case ChronoUnit.YEARS: return tdiv(this._monthsUntil(e), 12);
      default: throw unsupportedUnit(unit);
    }
  }
  _monthsUntil(e) { return tdiv((e._prolepticMonth() * 32 + e.day) - (this._prolepticMonth() * 32 + this.day), 32); }
  datesUntil(end) { const out = []; for (let d = this.toEpochDay(), e = end.toEpochDay(); d < e; d++) out.push(LocalDate.ofEpochDay(d)); return out; }
  compareTo(o) { let c = this.year - o.year; if (c === 0) { c = this.month - o.month; if (c === 0) c = this.day - o.day; } return c; }
  isBefore(o) { return this.compareTo(o) < 0; }
  isAfter(o) { return this.compareTo(o) > 0; }
  isEqual(o) { return this.compareTo(o) === 0; }
  equals(o) { return o instanceof LocalDate && o.year === this.year && o.month === this.month && o.day === this.day; }
  hashCode() { const y = this.year; return (y & 0xFFFFF800) ^ ((y << 11) + (this.month << 6) + this.day); }
  format(formatter) { return formatter.format(this); }
  toString() { return yearString(this.year, true) + '-' + pad(this.month, 2) + '-' + pad(this.day, 2); }
  toJSON() { return this.toString(); }
  _field(f) { switch (f) { case 'year': return this.year; case 'month': return this.month; case 'day': return this.day; case 'dow': return this.getDayOfWeek().getValue(); default: return undefined; } }
}
LocalDate.MIN = new LocalDate(YEAR_MIN, 1, 1); LocalDate.MAX = new LocalDate(YEAR_MAX, 12, 31); LocalDate.EPOCH = new LocalDate(1970, 1, 1);

// ------------------------------------------------------------------ YearMonth
export class YearMonth {
  constructor(y, m) { this.year = y; this.month = m; Object.freeze(this); }
  static of(year, month) { check('Year', year, YEAR_MIN, YEAR_MAX); check('MonthOfYear', month, 1, 12); return new YearMonth(year, month); }
  static now(zone = ZoneId.systemDefault()) { return YearMonth.from(LocalDate.now(zone)); }
  /** uuuu-MM. */
  static parse(text, formatter) {
    if (formatter) return formatter.parse(text, YearMonth.from);
    const p = new IsoParser(text), y = p.year(); p.lit('-'); const m = p.num2(); p.end();
    if (m < 1 || m > 12) p.build(() => { throw new DateTimeException('Unable to obtain YearMonth from TemporalAccessor: {Year=' + y + ', MonthOfYear=' + m + '},ISO of type java.time.format.Parsed'); });
    return p.build(() => YearMonth.of(y, m));
  }
  static from(t) {
    if (t instanceof YearMonth) return t;
    if (t instanceof LocalDate) return new YearMonth(t.year, t.month);
    if (t instanceof LocalDateTime || t instanceof ZonedDateTime) { const d = t.toLocalDate(); return new YearMonth(d.year, d.month); }
    throw new DateTimeException('Unable to obtain YearMonth from TemporalAccessor: ' + t + ' of type ' + (t?.constructor?.name ?? typeof t));
  }
  getYear() { return this.year; }
  getMonthValue() { return this.month; }
  lengthOfMonth() { return monthLength(this.year, this.month); }
  lengthOfYear() { return isLeap(this.year) ? 366 : 365; }
  isLeapYear() { return isLeap(this.year); }
  isValidDay(d) { return d >= 1 && d <= this.lengthOfMonth(); }
  atDay(d) { return LocalDate.of(this.year, this.month, d); }
  atEndOfMonth() { return LocalDate.of(this.year, this.month, this.lengthOfMonth()); }
  _prolepticMonth() { return this.year * 12 + this.month - 1; }
  plusMonths(n) { if (n === 0) return this; const calc = this._prolepticMonth() + n; const y = check('Year', fdiv(calc, 12), YEAR_MIN, YEAR_MAX); return new YearMonth(y, fmod(calc, 12) + 1); }
  minusMonths(n) { return this.plusMonths(-n); }
  plusYears(n) { return n === 0 ? this : YearMonth.of(this.year + n, this.month); }
  minusYears(n) { return this.plusYears(-n); }
  plus(n, unit) { switch (unit) { case ChronoUnit.MONTHS: return this.plusMonths(n); case ChronoUnit.YEARS: return this.plusYears(n); default: throw unsupportedUnit(unit); } }
  minus(n, unit) { return this.plus(-n, unit); }
  withMonth(m) { return YearMonth.of(this.year, m); }
  withYear(y) { return YearMonth.of(y, this.month); }
  until(end, unit) {
    const e = YearMonth.from(end), months = e._prolepticMonth() - this._prolepticMonth();
    switch (unit) { case ChronoUnit.MONTHS: return months; case ChronoUnit.YEARS: return tdiv(months, 12); default: throw unsupportedUnit(unit); }
  }
  compareTo(o) { let c = this.year - o.year; if (c === 0) c = this.month - o.month; return c; }
  isBefore(o) { return this.compareTo(o) < 0; }
  isAfter(o) { return this.compareTo(o) > 0; }
  equals(o) { return o instanceof YearMonth && o.year === this.year && o.month === this.month; }
  hashCode() { return this.year ^ (this.month << 27); }
  format(formatter) { return formatter.format(this); }
  toString() { return yearString(this.year, false) + '-' + pad(this.month, 2); }
  toJSON() { return this.toString(); }
  _field(f) { switch (f) { case 'year': return this.year; case 'month': return this.month; default: return undefined; } }
}

// ------------------------------------------------------------------ LocalTime / LocalDateTime
export class LocalTime {
  constructor(h, m, s, n) { this.hour = h; this.minute = m; this.second = s; this.nano = n; Object.freeze(this); }
  static of(h, m, s = 0, n = 0) { check('HourOfDay', h, 0, 23); check('MinuteOfHour', m, 0, 59); check('SecondOfMinute', s, 0, 59); check('NanoOfSecond', n, 0, 999999999); return new LocalTime(h, m, s, n); }
  static ofSecondOfDay(sec) { check('SecondOfDay', sec, 0, 86399); return new LocalTime(Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60, 0); }
  static _ofMs(ms) { return new LocalTime(Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60, (ms % 1000) * 1e6); }
  static now(zone = ZoneId.systemDefault()) { return Instant.now().atZone(zone).toLocalTime(); }
  static parse(text) {
    const m = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/.exec(text);
    if (!m) throw new DateTimeParseException("Text '" + text + "' could not be parsed at index 0", text, 0);
    try { return LocalTime.of(+m[1], +m[2], +(m[3] || 0), +((m[4] || '').padEnd(9, '0') || 0)); } catch (e) { throw new DateTimeParseException("Text '" + text + "' could not be parsed: " + e.getMessage(), text, 0, e); }
  }
  getHour() { return this.hour; }
  getMinute() { return this.minute; }
  getSecond() { return this.second; }
  getNano() { return this.nano; }
  toSecondOfDay() { return this.hour * 3600 + this.minute * 60 + this.second; }
  _ms() { return this.toSecondOfDay() * 1000 + Math.floor(this.nano / 1e6); }
  plusSeconds(n) { return LocalTime._ofMs(fmod(this._ms() + n * 1000, MS_DAY))._withNano(this.nano); }
  plusMinutes(n) { return this.plusSeconds(n * 60); }
  plusHours(n) { return this.plusSeconds(n * 3600); }
  minusMinutes(n) { return this.plusMinutes(-n); }
  _withNano(n) { return new LocalTime(this.hour, this.minute, this.second, n); }
  compareTo(o) { return this.hour - o.hour || this.minute - o.minute || this.second - o.second || this.nano - o.nano; }
  isBefore(o) { return this.compareTo(o) < 0; }
  isAfter(o) { return this.compareTo(o) > 0; }
  equals(o) { return o instanceof LocalTime && this.compareTo(o) === 0; }
  hashCode() { const nod = this.toSecondOfDay() * 1e9 + this.nano; return Number(BigInt.asIntN(32, BigInt(nod) ^ (BigInt(nod) >> 32n))); }
  format(formatter) { return formatter.format(this); }
  toString() {
    let s = pad(this.hour, 2) + ':' + pad(this.minute, 2);
    if (this.second > 0 || this.nano > 0) {
      s += ':' + pad(this.second, 2);
      if (this.nano > 0) s += this.nano % 1000000 === 0 ? '.' + pad(this.nano / 1000000, 3) : this.nano % 1000 === 0 ? '.' + pad(this.nano / 1000, 6) : '.' + pad(this.nano, 9);
    }
    return s;
  }
  _field(f) { switch (f) { case 'hour': return this.hour; case 'minute': return this.minute; case 'second': return this.second; case 'nano': return this.nano; default: return undefined; } }
}
LocalTime.MIDNIGHT = new LocalTime(0, 0, 0, 0); LocalTime.NOON = new LocalTime(12, 0, 0, 0);

export class LocalDateTime {
  constructor(date, time) { this.date = date; this.time = time; Object.freeze(this); }
  static of(y, mo, d, h = 0, mi = 0, s = 0, n = 0) { return y instanceof LocalDate ? new LocalDateTime(y, mo) : new LocalDateTime(LocalDate.of(y, mo, d), LocalTime.of(h, mi, s, n)); }
  static now(zone = ZoneId.systemDefault()) { return Instant.now().atZone(zone).toLocalDateTime(); }
  /** ISO_LOCAL_DATE_TIME (uuuu-MM-dd'T'HH:mm[:ss[.fraction]]). */
  static parse(text) {
    const s = String(text), t = s.indexOf('T');
    if (t < 0) throw new DateTimeParseException("Text '" + s + "' could not be parsed at index " + s.length, s, s.length);
    let date;
    try { date = LocalDate.parse(s.substring(0, t)); } catch (e) { if (e instanceof DateTimeParseException) throw new DateTimeParseException("Text '" + s + "' could not be parsed at index " + (e.getErrorIndex?.() ?? 0), s, 0, e); throw e; }
    let time;
    try { time = LocalTime.parse(s.substring(t + 1)); } catch (e) { if (e instanceof DateTimeParseException) throw new DateTimeParseException("Text '" + s + "' could not be parsed at index " + (t + 1), s, t + 1, e); throw e; }
    return new LocalDateTime(date, time);
  }
  static _ofLocalMs(ms, nano) { const day = fdiv(ms, MS_DAY); const t = LocalTime._ofMs(ms - day * MS_DAY); return new LocalDateTime(LocalDate.ofEpochDay(day), nano === undefined ? t : t._withNano(nano)); }
  _localMs() { return this.date.toEpochDay() * MS_DAY + this.time._ms(); }
  toLocalDate() { return this.date; }
  toLocalTime() { return this.time; }
  getYear() { return this.date.year; }
  getMonthValue() { return this.date.month; }
  getDayOfMonth() { return this.date.day; }
  getDayOfWeek() { return this.date.getDayOfWeek(); }
  getHour() { return this.time.hour; }
  getMinute() { return this.time.minute; }
  getSecond() { return this.time.second; }
  getNano() { return this.time.nano; }
  atZone(zone) { return ZonedDateTime._ofLocal(this, zone); }
  plusDays(n) { return new LocalDateTime(this.date.plusDays(n), this.time); }
  minusDays(n) { return this.plusDays(-n); }
  plusMonths(n) { return new LocalDateTime(this.date.plusMonths(n), this.time); }
  plusSeconds(n) { return LocalDateTime._ofLocalMs(this._localMs() + n * 1000, this.time.nano); }
  plusMinutes(n) { return this.plusSeconds(n * 60); }
  plusHours(n) { return this.plusSeconds(n * 3600); }
  compareTo(o) { return this.date.compareTo(o.date) || this.time.compareTo(o.time); }
  isBefore(o) { return this.compareTo(o) < 0; }
  isAfter(o) { return this.compareTo(o) > 0; }
  equals(o) { return o instanceof LocalDateTime && this.compareTo(o) === 0; }
  hashCode() { return this.date.hashCode() ^ this.time.hashCode(); }
  format(formatter) { return formatter.format(this); }
  toString() { return this.date.toString() + 'T' + this.time.toString(); }
  _field(f) { const v = this.date._field(f); return v !== undefined ? v : this.time._field(f); }
}

// ------------------------------------------------------------------ Instant / ZonedDateTime / Duration
export class Instant {
  constructor(ms) { this.ms = ms; Object.freeze(this); }
  static now() { return new Instant(System.currentTimeMillis()); }
  static ofEpochMilli(ms) { return new Instant(Math.trunc(ms)); }
  /** ISO_INSTANT: uuuu-MM-dd'T'HH:mm:ss[.fraction] followed by Z or an offset (+07:00). */
  static parse(text) {
    const s = String(text); const m = /^(.*T[0-9:.]+)(Z|[+-][0-9]{2}:[0-9]{2})$/.exec(s);
    if (!m || !/T[0-9]{2}:[0-9]{2}:[0-9]{2}/.test(m[1])) throw new DateTimeParseException("Text '" + s + "' could not be parsed at index 0", s, 0);
    const ldt = LocalDateTime.parse(m[1]); const offset = m[2] === 'Z' ? 0 : (m[2][0] === '-' ? -1 : 1) * (Number(m[2].substring(1, 3)) * 3600000 + Number(m[2].substring(4, 6)) * 60000);
    return new Instant(ldt._localMs() - offset);
  }
  static ofEpochSecond(s) { return new Instant(s * 1000); }
  toEpochMilli() { return this.ms; }
  getEpochSecond() { return fdiv(this.ms, 1000); }
  getNano() { return fmod(this.ms, 1000) * 1e6; }
  atZone(zone) { return new ZonedDateTime(this.ms, zone); }
  plusMillis(n) { return new Instant(this.ms + n); }
  plusSeconds(n) { return new Instant(this.ms + n * 1000); }
  minusMillis(n) { return new Instant(this.ms - n); }
  minusSeconds(n) { return new Instant(this.ms - n * 1000); }
  until(end, unit) { const d = Instant._ms(end) - this.ms; const u = TIME_UNIT_MS[unit.name()] ?? (unit === ChronoUnit.DAYS ? MS_DAY : null); if (u == null) throw unsupportedUnit(unit); return tdiv(d, u); }
  static _ms(t) { return t instanceof Instant ? t.ms : t instanceof ZonedDateTime ? t.epochMs : (() => { throw new DateTimeException('Unable to obtain Instant from TemporalAccessor: ' + t); })(); }
  compareTo(o) { return this.ms < o.ms ? -1 : this.ms > o.ms ? 1 : 0; }
  isBefore(o) { return this.ms < o.ms; }
  isAfter(o) { return this.ms > o.ms; }
  equals(o) { return o instanceof Instant && o.ms === this.ms; }
  hashCode() { const s = this.getEpochSecond(); return (Number(BigInt.asIntN(32, BigInt(s) ^ (BigInt.asUintN(64, BigInt(s)) >> 32n))) + 51 * this.getNano()) | 0; }
  /** ISO_INSTANT, e.g. 2024-01-05T03:04:05.120Z (fraction only when non-zero). */
  toString() { const l = LocalDateTime._ofLocalMs(this.ms); const ms = fmod(this.ms, 1000); return l.date.toString() + 'T' + pad(l.time.hour, 2) + ':' + pad(l.time.minute, 2) + ':' + pad(l.time.second, 2) + (ms ? '.' + pad(ms, 3) : '') + 'Z'; }
  toJSON() { return this.toString(); }
  _field() { return undefined; }
}
Instant.EPOCH = new Instant(0);

export class ZonedDateTime {
  constructor(epochMs, zone) { this.epochMs = epochMs; this.zone = zone; this.offset = zone.offsetAt(epochMs); this.ldt = LocalDateTime._ofLocalMs(epochMs + this.offset); Object.freeze(this); }
  static now(zone = ZoneId.systemDefault()) { return Instant.now().atZone(zone); }
  static ofInstant(instant, zone) { return instant.atZone(zone); }
  static of(ldt, zone) { return ZonedDateTime._ofLocal(ldt, zone); }
  static _ofLocal(ldt, zone, preferredOffset) {
    const localMs = ldt._localMs(), day = ldt.date.toEpochDay(), msOfDay = ldt.time._ms();
    let epoch = zone.localToEpoch(day, msOfDay);
    if (preferredOffset !== undefined && zone.offsetAt(localMs - preferredOffset) === preferredOffset) epoch = localMs - preferredOffset;
    const z = new ZonedDateTime(epoch, zone);
    return ldt.time.nano % 1000000 ? z._nano(ldt.time.nano) : z;
  }
  _nano(n) { const o = Object.create(ZonedDateTime.prototype); Object.assign(o, { epochMs: this.epochMs, zone: this.zone, offset: this.offset, ldt: new LocalDateTime(this.ldt.date, this.ldt.time._withNano(n)) }); return Object.freeze(o); }
  getZone() { return this.zone; }
  getOffset() { return ZoneOffset.ofHoursMinutes(Math.trunc(this.offset / 3600000), Math.trunc((this.offset % 3600000) / 60000)); }
  toInstant() { return new Instant(this.epochMs); }
  toEpochSecond() { return fdiv(this.epochMs, 1000); }
  toLocalDate() { return this.ldt.date; }
  toLocalTime() { return this.ldt.time; }
  toLocalDateTime() { return this.ldt; }
  getYear() { return this.ldt.date.year; }
  getMonthValue() { return this.ldt.date.month; }
  getDayOfMonth() { return this.ldt.date.day; }
  getDayOfWeek() { return this.ldt.date.getDayOfWeek(); }
  getHour() { return this.ldt.time.hour; }
  getMinute() { return this.ldt.time.minute; }
  getSecond() { return this.ldt.time.second; }
  getNano() { return this.ldt.time.nano; }
  /** Date-based plus keeps the local time (re-resolved in the zone, keeping the offset when valid). */
  plusDays(n) { return ZonedDateTime._ofLocal(this.ldt.plusDays(n), this.zone, this.offset); }
  minusDays(n) { return this.plusDays(-n); }
  plusMonths(n) { return ZonedDateTime._ofLocal(this.ldt.plusMonths(n), this.zone, this.offset); }
  /** Time-based plus works on the instant line. */
  plusSeconds(n) { return new ZonedDateTime(this.epochMs + n * 1000, this.zone); }
  plusMinutes(n) { return this.plusSeconds(n * 60); }
  plusHours(n) { return this.plusSeconds(n * 3600); }
  minusSeconds(n) { return this.plusSeconds(-n); }
  minusMinutes(n) { return this.plusSeconds(-n * 60); }
  withZoneSameInstant(zone) { return new ZonedDateTime(this.epochMs, zone); }
  until(end, unit) { const e = end instanceof ZonedDateTime ? end : Instant._ms(end); const ms = (e.epochMs ?? e) - this.epochMs; const u = TIME_UNIT_MS[unit.name()]; if (u) return tdiv(ms, u); return this.ldt.date.until(new ZonedDateTime(e.epochMs ?? e, this.zone).ldt.date, unit); }
  compareTo(o) { return this.epochMs < o.epochMs ? -1 : this.epochMs > o.epochMs ? 1 : this.ldt.compareTo(o.ldt); }
  isBefore(o) { return this.epochMs < o.epochMs; }
  isAfter(o) { return this.epochMs > o.epochMs; }
  isEqual(o) { return this.epochMs === o.epochMs; }
  equals(o) { return o instanceof ZonedDateTime && o.epochMs === this.epochMs && o.zone.equals(this.zone); }
  hashCode() { return this.ldt.hashCode() ^ (this.offset / 1000) ^ this.zone.hashCode(); }
  format(formatter) { return formatter.format(this); }
  toString() { const id = offsetId(this.offset); return this.ldt.toString() + id + (this.zone.kind === 'fixed' && this.zone.id === id ? '' : '[' + this.zone.id + ']'); }
  _field(f) { return this.ldt._field(f); }
}

export class Duration {
  constructor(ms) { this.ms = ms; Object.freeze(this); }
  static ofMillis(ms) { return new Duration(ms); }
  static ofSeconds(s) { return new Duration(s * 1000); }
  static ofMinutes(m) { return new Duration(m * 60000); }
  static ofHours(h) { return new Duration(h * 3600000); }
  static ofDays(d) { return new Duration(d * MS_DAY); }
  /** Duration.between(start, end) for Instant, ZonedDateTime, LocalDateTime, LocalTime. */
  static between(a, b) {
    const ms = t => (t instanceof Instant ? t.ms : t instanceof ZonedDateTime ? t.epochMs : t instanceof LocalDateTime ? t._localMs() : t instanceof LocalTime ? t._ms() : (() => { throw new DateTimeException('Unsupported unit: Seconds'); })());
    if (a instanceof LocalDateTime && b instanceof ZonedDateTime) b = b.toLocalDateTime();
    if (a instanceof ZonedDateTime && b instanceof Instant) b = b.atZone(a.zone);
    return new Duration(ms(b) - ms(a));
  }
  toMillis() { return this.ms; }
  getSeconds() { return fdiv(this.ms, 1000); }
  toSeconds() { return this.getSeconds(); }
  toMinutes() { return tdiv(this.getSeconds(), 60); }
  toHours() { return tdiv(this.getSeconds(), 3600); }
  toDays() { return tdiv(this.getSeconds(), 86400); }
  isNegative() { return this.ms < 0; }
  isZero() { return this.ms === 0; }
  plus(d) { return new Duration(this.ms + d.ms); }
  compareTo(o) { return this.ms < o.ms ? -1 : this.ms > o.ms ? 1 : 0; }
  equals(o) { return o instanceof Duration && o.ms === this.ms; }
}

// ------------------------------------------------------------------ parsing helper for ISO text
class IsoParser {
  constructor(text) { this.t = String(text); this.i = 0; }
  fail(index = this.i) { throw new DateTimeParseException("Text '" + this.t + "' could not be parsed at index " + index, this.t, index); }
  year() { // appendValue(YEAR, 4, 10, EXCEEDS_PAD)
    const start = this.i; let sign = 1;
    if (this.t[this.i] === '+' || this.t[this.i] === '-') { sign = this.t[this.i] === '-' ? -1 : 1; this.i++; }
    const d0 = this.i; while (this.i < this.t.length && this.i - d0 < 10 && /[0-9]/.test(this.t[this.i])) this.i++;
    const n = this.i - d0; const signed = d0 > start;
    if (n < 4 || (!signed && n > 4) || (signed && sign === 1 && n === 4)) { this.i = start; this.fail(start); }
    return sign * Number(this.t.substring(d0, this.i)) || 0;
  }
  num2() { const s = this.i; if (!/^[0-9]{2}/.test(this.t.substring(s, s + 2))) this.fail(s); this.i += 2; return Number(this.t.substring(s, s + 2)); }
  lit(c) { if (this.t[this.i] !== c) this.fail(); this.i++; }
  end() { if (this.i !== this.t.length) throw new DateTimeParseException("Text '" + this.t + "' could not be parsed, unparsed text found at index " + this.i, this.t, this.i); }
  build(fn) { try { return fn(); } catch (e) { if (e instanceof DateTimeException) throw new DateTimeParseException("Text '" + this.t + "' could not be parsed: " + e.getMessage(), this.t, 0, e); throw e; } }
}

// ------------------------------------------------------------------ DateTimeFormatter.ofPattern
const FIELD_NAMES = { year: 'YearOfEra', month: 'MonthOfYear', day: 'DayOfMonth', hour: 'HourOfDay', minute: 'MinuteOfHour', second: 'SecondOfMinute', nano: 'NanoOfSecond', dow: 'DayOfWeek' };
/** java.time.format.DateTimeFormatter for numeric patterns (y u M d H h m s S a and literals). */
export class DateTimeFormatter {
  constructor(pattern, items, zone) { this.pattern = pattern; this.items = items; this.zone = zone ?? null; }
  static ofPattern(pattern) { return new DateTimeFormatter(pattern, compile(pattern)); }
  withZone(zone) { return new DateTimeFormatter(this.pattern, this.items, zone); }
  getZone() { return this.zone; }
  format(t) {
    let temporal = t;
    if (this.zone && (t instanceof Instant || t instanceof ZonedDateTime)) temporal = new ZonedDateTime(Instant._ms(t), this.zone);
    let out = '';
    for (const it of this.items) {
      if (typeof it === 'string') { out += it; continue; }
      const raw = it.f === 'hour12' ? temporal._field('hour') : it.f === 'ampm' ? temporal._field('hour') : temporal._field(it.f);
      if (raw === undefined) throw new UnsupportedTemporalTypeException('Unsupported field: ' + (FIELD_NAMES[it.f] ?? (it.f === 'ampm' ? 'AmPmOfDay' : 'ClockHourOfAmPm')));
      out += it.print(raw);
    }
    return out;
  }
  /** Parses numeric patterns; `query` builds the result from {year, month, day, hour, minute, second, nano}. */
  parse(text, query) {
    const fields = {}; let i = 0; const s = String(text);
    for (let k = 0; k < this.items.length; k++) {
      const it = this.items[k];
      if (typeof it === 'string') { if (s.substr(i, it.length) !== it) throw new DateTimeParseException("Text '" + s + "' could not be parsed at index " + i, s, i); i += it.length; continue; }
      const next = this.items[k + 1]; const adjacent = next !== undefined && typeof next !== 'string';
      const max = adjacent ? it.min : it.max ?? 19; const st = i; while (i < s.length && i - st < max && /[0-9]/.test(s[i])) i++;
      if (i - st < it.min) throw new DateTimeParseException("Text '" + s + "' could not be parsed at index " + st, s, st);
      let v = Number(s.substring(st, i)); if (it.reduced) v += 2000; if (it.fraction) v = Number(s.substring(st, i).padEnd(9, '0'));
      fields[it.f] = v;
    }
    if (i !== s.length) throw new DateTimeParseException("Text '" + s + "' could not be parsed, unparsed text found at index " + i, s, i);
    const { year, month, day, hour = 0, minute = 0, second = 0, nano = 0 } = fields;
    try {
      const date = year !== undefined && month !== undefined && day !== undefined ? LocalDate.of(year, month, day) : null;
      const value = date && fields.hour !== undefined ? new LocalDateTime(date, LocalTime.of(hour, minute, second, nano)) : date ?? (year !== undefined && month !== undefined ? YearMonth.of(year, month) : LocalTime.of(hour, minute, second, nano));
      return query ? query(value) : value;
    } catch (e) { if (e instanceof DateTimeException) throw new DateTimeParseException("Text '" + s + "' could not be parsed: " + e.getMessage(), s, 0, e); throw e; }
  }
  toString() { return this.pattern; }
}
function compile(p) {
  const items = []; let lit = '';
  const flush = () => { if (lit) { items.push(lit); lit = ''; } };
  for (let i = 0; i < p.length;) {
    const c = p[i];
    if (c === "'") {
      let j = i + 1;
      if (p[j] === "'") { lit += "'"; i += 2; continue; }
      let s = ''; for (; j < p.length; j++) { if (p[j] === "'") { if (p[j + 1] === "'") { s += "'"; j++; } else break; } else s += p[j]; }
      if (j >= p.length) throw new IllegalArgumentException('Pattern ends with an incomplete string literal: ' + p);
      lit += s; i = j + 1; continue;
    }
    if (/[A-Za-z]/.test(c)) {
      let n = 1; while (p[i + n] === c) n++;
      flush(); items.push(field(c, n, p)); i += n; continue;
    }
    if ('[]{}#'.includes(c)) throw new IllegalArgumentException("Pattern includes reserved character: '" + c + "'");
    lit += c; i++;
  }
  flush(); return items;
}
function numeric(f, n, opts = {}) { return { f, min: n, max: opts.max, ...opts, print: opts.print ?? (v => (v < 0 ? '-' + pad(-v, n) : pad(v, n))) }; }
function field(c, n, p) {
  switch (c) {
    case 'y': case 'u':
      if (n === 2) return numeric('year', 2, { max: 2, reduced: true, print: v => pad(fmod(v, 100), 2) });
      return numeric('year', n, { max: 19, print: v => (n >= 4 && v > 9999 && String(v).length > n ? '+' + v : v < 0 && c === 'u' ? '-' + pad(-v, n) : pad(Math.abs(v), n)) });
    case 'M': case 'L': if (n > 2) break; return numeric('month', n, { max: 2 });
    case 'd': if (n > 2) break; return numeric('day', n, { max: 2 });
    case 'H': if (n > 2) break; return numeric('hour', n, { max: 2 });
    case 'h': if (n > 2) break; return { f: 'hour12', min: n, max: 2, print: v => pad(v % 12 === 0 ? 12 : v % 12, n) };
    case 'm': if (n > 2) break; return numeric('minute', n, { max: 2 });
    case 's': if (n > 2) break; return numeric('second', n, { max: 2 });
    case 'S': return { f: 'nano', min: n, max: n, fraction: true, print: v => pad(v, 9).substring(0, n) };
    case 'a': if (n > 1) break; return { f: 'ampm', print: v => (v < 12 ? 'AM' : 'PM') };
    case 'e': case 'c': if (n > 1) break; return numeric('dow', 1, { max: 1 });
    default:
      if ('GQqwWEFkKAnNVvzOXxZgDY'.includes(c)) throw new IllegalArgumentException('Pattern letter not supported by this port: ' + c + ' in ' + p);
      throw new IllegalArgumentException('Unknown pattern letter: ' + c);
  }
  throw new IllegalArgumentException('Too many pattern letters: ' + c);
}
DateTimeFormatter.ISO_LOCAL_DATE = Object.assign(new DateTimeFormatter('ISO_LOCAL_DATE', []), { format: t => LocalDate.from(t).toString(), parse: (s, q) => (q ? q(LocalDate.parse(s)) : LocalDate.parse(s)) });
