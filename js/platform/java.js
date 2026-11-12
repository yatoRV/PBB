// java.lang / java.util semantics used by the port (no app logic).
// Conventions for ported code:
//   int arithmetic -> `|0`, Math.imul; int division -> idiv(); (int) of double -> d2i(); float -> Math.fround.
//   char -> 1-char string (charAt) or UTF-16 code (charCodeAt); helpers below accept both.
//   byte[] -> Uint8Array (unsigned!). Apply i2b() where the Java code relies on signed bytes.
//   HashMap/HashSet with observable iteration order -> JavaHashMap/JavaHashSet (Java 17 order).

// ---------------------------------------------------------------- exceptions
/** java.lang.Throwable: getMessage(), toString() = "<java class>: <message>", optional cause. */
export class JavaException extends Error {
  static javaName = 'java.lang.Exception';
  constructor(message, cause) {
    if (message instanceof Error && cause === undefined) { cause = message; message = javaThrowableToString(cause); }
    super(message == null ? undefined : String(message));
    this.javaMessage = message == null ? null : String(message);
    this.cause = cause ?? null;
    this.name = this.constructor.javaName;
  }
  getMessage() { return this.javaMessage; }
  getCause() { return this.cause; }
  toString() { return javaThrowableToString(this); }
  /** printStackTrace(PrintWriter|PrintStream); without an argument writes to console.error (System.err). */
  printStackTrace(out) { printStackTrace(this, out); }
}
/** Throwable.printStackTrace text: "<class>: <message>", "\tat …" frames (JS stack), "Caused by: …" chain. */
export function javaStackTrace(e) {
  if (e == null) return '';
  const frames = typeof e.stack === 'string' ? e.stack.split('\n').filter(l => /^\s+at /.test(l)).map(l => '\tat ' + l.trim().replace(/^at /, '')) : [];
  let out = [javaThrowableToString(e), ...frames].join('\n');
  if (e.cause && e.cause !== e) out += '\nCaused by: ' + javaStackTrace(e.cause);
  return out;
}
/** e.printStackTrace(pw) for any thrown value (JS errors included); each line println'd like Java. */
export function printStackTrace(e, out) {
  const text = javaStackTrace(e) + '\n';
  if (out == null) { console.error(text); return; } // eslint-disable-line no-console
  if (typeof out.print === 'function') out.print(text); else if (typeof out.write === 'function') out.write(text);
}
/** Throwable.toString() for any error (JS errors are reported by their name). */
export function javaThrowableToString(e) {
  if (e instanceof JavaException) return e.constructor.javaName + (e.javaMessage != null ? ': ' + e.javaMessage : '');
  if (e instanceof Error) return e.name + (e.message ? ': ' + e.message : '');
  return String(e);
}
const ex = (name, Base) => { const C = class extends Base {}; C.javaName = name; Object.defineProperty(C, 'name', { value: name.slice(name.lastIndexOf('.') + 1) }); return C; };
export const RuntimeException = ex('java.lang.RuntimeException', JavaException);
export const IllegalArgumentException = ex('java.lang.IllegalArgumentException', RuntimeException);
export const IllegalStateException = ex('java.lang.IllegalStateException', RuntimeException);
export const NumberFormatException = ex('java.lang.NumberFormatException', IllegalArgumentException);
export const ArithmeticException = ex('java.lang.ArithmeticException', RuntimeException);
export const IndexOutOfBoundsException = ex('java.lang.IndexOutOfBoundsException', RuntimeException);
export const ArrayIndexOutOfBoundsException = ex('java.lang.ArrayIndexOutOfBoundsException', IndexOutOfBoundsException);
export const NullPointerException = ex('java.lang.NullPointerException', RuntimeException);
export const ClassCastException = ex('java.lang.ClassCastException', RuntimeException);
export const UnsupportedOperationException = ex('java.lang.UnsupportedOperationException', RuntimeException);
export const NoSuchElementException = ex('java.util.NoSuchElementException', RuntimeException);
export const ConcurrentModificationException = ex('java.util.ConcurrentModificationException', RuntimeException);
export const InterruptedException = ex('java.lang.InterruptedException', JavaException);
export const IOException = ex('java.io.IOException', JavaException);
export const FileNotFoundException = ex('java.io.FileNotFoundException', IOException);
export const UncheckedIOException = ex('java.io.UncheckedIOException', RuntimeException);
export const NoSuchAlgorithmException = ex('java.security.NoSuchAlgorithmException', JavaException);

// ---------------------------------------------------------------- int / long / float helpers
export const INT_MIN = -2147483648, INT_MAX = 2147483647;
export const LONG_MAX = 9223372036854775807, LONG_MIN = -9223372036854775808; // as doubles (2^63)
export const FLOAT_MAX = 3.4028234663852886e38, FLOAT_MIN = 1.401298464324817e-45;
export const f = Math.fround;
/** int / int (truncating, throws on zero like Java). */
export function idiv(a, b) { if (b === 0) throw new ArithmeticException('/ by zero'); return (a / b) | 0; }
/** int % int (sign of dividend, throws on zero). */
export function irem(a, b) { if (b === 0) throw new ArithmeticException('/ by zero'); return (a % b) | 0; }
/** long / long within the safe-integer range. */
export function ldiv(a, b) { if (b === 0) throw new ArithmeticException('/ by zero'); return Math.trunc(a / b); }
export function floorDiv(a, b) { if (b === 0) throw new ArithmeticException('/ by zero'); return Math.floor(a / b); }
export function floorMod(a, b) { if (b === 0) throw new ArithmeticException('/ by zero'); return a - Math.floor(a / b) * b; }
/** (int) cast of a double/float: NaN -> 0, saturating, truncating. */
export function d2i(x) { if (Number.isNaN(x)) return 0; if (x >= INT_MAX) return INT_MAX; if (x <= INT_MIN) return INT_MIN; return Math.trunc(x) | 0; }
/** (long) cast of a double (result is a double; exact only inside the safe-integer range). */
export function d2l(x) { if (Number.isNaN(x)) return 0; if (x >= LONG_MAX) return LONG_MAX; if (x <= LONG_MIN) return LONG_MIN; return Math.trunc(x) || 0; }
export const i2b = x => (x << 24) >> 24;
export const i2s = x => (x << 16) >> 16;
export const i2c = x => x & 0xFFFF;
/** Math.round(float) -> int. */
export function roundF(x) { if (Number.isNaN(x)) return 0; const r = Math.round(x); return r >= INT_MAX ? INT_MAX : r <= INT_MIN ? INT_MIN : (r | 0); }
/**
 * Speed-up for the vision loops that compute Math.round((float)(base + shift)) for an integer base 0 <= base < maxBase
 * and fixed float shifts: returns {offset, careful} so that the result is base + offset[k] whenever careful[k] is 0.
 * That holds because base + shift then lies at least one float rounding step away from a .5 boundary, so the float
 * sum rounds to the same integer as the exact sum. careful[k] = 1 marks shifts whose fraction is too close to .5;
 * the caller computes those exactly with roundF(Math.fround(base + shift)).
 */
export function floatRoundPlan(shifts, maxBase) {
  const n = shifts.length, offset = new Int32Array(n), careful = new Uint8Array(n);
  let max = 0; for (let k = 0; k < n; k++) max = Math.max(max, Math.abs(shifts[k]));
  let bound = 1; while (bound <= maxBase + max + 1) bound *= 2;
  const tolerance = bound * 2 ** -22;
  for (let k = 0; k < n; k++) { const s = shifts[k], fl = Math.floor(s); offset[k] = Math.floor(s + 0.5); careful[k] = Math.abs(s - fl - 0.5) <= tolerance ? 1 : 0; }
  return { offset, careful };
}
/** Math.round(double) -> long. */
export function roundD(x) { if (Number.isNaN(x)) return 0; const r = Math.round(x); return r >= LONG_MAX ? LONG_MAX : r <= LONG_MIN ? LONG_MIN : (r || 0); }
export const Integer = {
  MAX_VALUE: INT_MAX, MIN_VALUE: INT_MIN,
  compare: (a, b) => (a < b ? -1 : a === b ? 0 : 1),
  parseInt: (s, radix = 10) => { const v = parseJavaLong(s, radix); if (v < INT_MIN || v > INT_MAX) throw nfe(s, radix); return Number(v); },
  valueOf: (s, radix = 10) => Integer.parseInt(s, radix),
  toString: (v, radix = 10) => (v | 0).toString(radix),
  toHexString: v => (v >>> 0).toString(16),
  signum: v => (v > 0 ? 1 : v < 0 ? -1 : 0),
  hashCode: v => v | 0,
};
export const Long = {
  MAX_VALUE: LONG_MAX, MIN_VALUE: LONG_MIN,
  compare: (a, b) => (a < b ? -1 : a === b ? 0 : 1),
  /** Returns a double; values beyond 2^53 lose precision (none in this app). */
  parseLong: (s, radix = 10) => Number(parseJavaLong(s, radix)),
  hashCode: v => { const b = BigInt.asUintN(64, BigInt(Math.trunc(v))); return Number(BigInt.asIntN(32, b ^ (b >> 32n))); },
};
function nfe(s, radix) { return new NumberFormatException(s == null ? 'Cannot parse null string: null' : 'For input string: "' + s + '"' + (radix === 10 ? '' : ' under radix ' + radix)); }
/** Long.parseLong semantics (sign, Unicode digits via Character.digit, range check) -> BigInt. */
function parseJavaLong(s, radix) {
  if (s == null) throw new NumberFormatException('Cannot parse null string: null');
  s = String(s); const len = s.length; if (len === 0) throw nfe(s, radix);
  let i = 0, neg = false; const c0 = s[0];
  if (c0 < '0') { if (c0 === '-') neg = true; else if (c0 !== '+') throw nfe(s, radix); if (len === 1) throw nfe(s, radix); i = 1; }
  let v = 0n; const R = BigInt(radix);
  for (; i < len; i++) { const d = Character.digit(s.charCodeAt(i), radix); if (d < 0) throw nfe(s, radix); v = v * R + BigInt(d); }
  if (neg) v = -v;
  if (v > 9223372036854775807n || v < -9223372036854775808n) throw nfe(s, radix);
  return v;
}
const JAVA_FLOAT_RE = /^[+-]?(NaN|Infinity|((\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)[fFdD]?)$/;
/** Double.parseDouble: trims chars <= ' ', accepts Java float literals (no hex floats). */
export function parseDouble(s) {
  if (s == null) throw new NullPointerException();
  const t = trim(String(s));
  if (!JAVA_FLOAT_RE.test(t)) throw new NumberFormatException(t.length === 0 ? 'empty String' : 'For input string: "' + t + '"');
  return Number(t.replace(/[fFdD]$/, ''));
}
export const parseFloat = s => Math.fround(parseDouble(s));
export const Float = {
  MAX_VALUE: FLOAT_MAX, MIN_VALUE: FLOAT_MIN, NEGATIVE_INFINITY: -Infinity, POSITIVE_INFINITY: Infinity, NaN: NaN,
  parseFloat, isFinite: Number.isFinite, isNaN: Number.isNaN,
  /** Float.compare/Double.compare: -0.0 < 0.0, NaN greatest and equal to itself. */
  compare: (a, b) => javaNumberCompare(a, b),
  toString: v => javaFloatToString(v),
};
export const Double = { parseDouble, compare: (a, b) => javaNumberCompare(a, b), isNaN: Number.isNaN, isFinite: Number.isFinite, toString: v => javaDoubleToString(v), MAX_VALUE: Number.MAX_VALUE };
export function javaNumberCompare(a, b) {
  if (a < b) return -1; if (a > b) return 1;
  const an = Number.isNaN(a), bn = Number.isNaN(b);
  if (an || bn) return an === bn ? 0 : an ? 1 : -1;
  if (a === 0 && b === 0) { const ai = Object.is(a, -0), bi = Object.is(b, -0); return ai === bi ? 0 : ai ? -1 : 1; }
  return 0;
}

// Double.toString / Float.toString formatting (digits = shortest round-trip, Java layout).
function javaLayout(neg, digits, exp10) { // value = d1.d2d3... x 10^exp10
  const sign = neg ? '-' : '';
  if (exp10 >= -3 && exp10 < 7) {
    if (exp10 >= 0) {
      const ip = digits.length > exp10 + 1 ? digits.slice(0, exp10 + 1) : digits.padEnd(exp10 + 1, '0');
      const fp = digits.length > exp10 + 1 ? digits.slice(exp10 + 1) : '0';
      return sign + ip + '.' + fp;
    }
    return sign + '0.' + '0'.repeat(-exp10 - 1) + digits;
  }
  return sign + digits[0] + '.' + (digits.length > 1 ? digits.slice(1) : '0') + 'E' + exp10;
}
function special(v) { if (Number.isNaN(v)) return 'NaN'; if (v === Infinity) return 'Infinity'; if (v === -Infinity) return '-Infinity'; if (v === 0) return Object.is(v, -0) ? '-0.0' : '0.0'; return null; }
function splitExp(s) { const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s); let d = m[2] + (m[3] || ''); d = d.replace(/0+$/, '') || '0'; return [m[1] === '-', d, Number(m[4])]; }
/** String.valueOf(double). (JDK <19 prints non-shortest digits in a few rare cases; ignored.) */
export function javaDoubleToString(v) { const sp = special(v); if (sp) return sp; const [n, d, e] = splitExp(v.toExponential()); return javaLayout(n, d, e); }
/** String.valueOf(float): shortest digits that round-trip through float. */
export function javaFloatToString(v) {
  v = Math.fround(v); const sp = special(v); if (sp) return sp;
  for (let p = 1; p <= 9; p++) { const s = v.toExponential(p - 1); if (Math.fround(Number(s)) === v) { const [n, d, e] = splitExp(s); return javaLayout(n, d, e); } }
  return javaDoubleToString(v);
}

// ---------------------------------------------------------------- String helpers
/** String.hashCode(). */
export function javaStringHash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return h; }
/** String.compareTo: difference of first differing UTF-16 units, else length difference. */
export function compareTo(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { const x = a.charCodeAt(i), y = b.charCodeAt(i); if (x !== y) return x - y; }
  return a.length - b.length;
}
/** String.compareToIgnoreCase / String.CASE_INSENSITIVE_ORDER. */
export function compareToIgnoreCase(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i), y = b.charCodeAt(i);
    if (x !== y) { x = Character.toUpperCase(x); y = Character.toUpperCase(y); if (x !== y) { x = Character.toLowerCase(x); y = Character.toLowerCase(y); if (x !== y) return x - y; } }
  }
  return a.length - b.length;
}
export const CASE_INSENSITIVE_ORDER = compareToIgnoreCase;
export const equalsIgnoreCase = (a, b) => b != null && a.length === b.length && compareToIgnoreCase(a, b) === 0;
/** String.trim(): strips chars <= U+0020 (not Unicode spaces). */
export function trim(s) { let a = 0, b = s.length; while (a < b && s.charCodeAt(a) <= 32) a++; while (b > a && s.charCodeAt(b - 1) <= 32) b--; return a > 0 || b < s.length ? s.substring(a, b) : s; }
/** String.strip() / isBlank(): Character.isWhitespace based. */
export function strip(s) { let a = 0, b = s.length; while (a < b && Character.isWhitespace(s.charCodeAt(a))) a++; while (b > a && Character.isWhitespace(s.charCodeAt(b - 1))) b--; return s.substring(a, b); }
export const isBlank = s => strip(s).length === 0;
/** Converts a Java regex given as string to RegExp (adds 'u' when \p{..} is used). Prefer passing RegExp literals. */
export function toRegExp(regex, extraFlags = '') {
  if (regex instanceof RegExp) { const fl = [...new Set((regex.flags + extraFlags).split(''))].join(''); return fl === regex.flags ? regex : new RegExp(regex.source, fl); }
  return new RegExp(regex, extraFlags + (/\\[pP]\{/.test(regex) ? 'u' : ''));
}
/** String.matches(regex): whole-string match. */
export function matches(s, regex) { const r = toRegExp(regex); return new RegExp('^(?:' + r.source + ')$', r.flags.replace(/[gy]/g, '')).test(s); }
/** String.split(regex, limit) with Java semantics (trailing empties removed when limit == 0). */
export function split(s, regex, limit = 0) {
  const re = toRegExp(regex, 'g'); re.lastIndex = 0;
  const list = []; let index = 0; const limited = limit > 0; let m;
  while ((m = re.exec(s)) !== null) {
    const start = m.index, end = start + m[0].length;
    if (end === start) re.lastIndex = start + 1;
    if (!limited || list.length < limit - 1) {
      if (index === 0 && start === 0 && end === 0) continue;
      list.push(s.substring(index, start)); index = end;
    } else if (list.length === limit - 1) { list.push(s.substring(index)); index = end; }
    if (re.lastIndex > s.length) break;
  }
  if (index === 0) return [s];
  if (!limited || list.length < limit) list.push(s.substring(index));
  let n = list.length; if (limit === 0) while (n > 0 && list[n - 1].length === 0) n--;
  return list.slice(0, n);
}
/** Java replacement string ($n, ${name}, \x) -> function for String.replace. */
function javaReplacement(rep) {
  return (...args) => {
    const hasGroups = typeof args[args.length - 1] === 'object'; const groups = hasGroups ? args[args.length - 1] : undefined;
    const caps = args.slice(0, hasGroups ? -3 : -2);
    let out = '';
    for (let i = 0; i < rep.length; i++) {
      const c = rep[i];
      if (c === '\\') { i++; if (i >= rep.length) throw new IllegalArgumentException('character to be escaped is missing'); out += rep[i]; }
      else if (c === '$') {
        i++; if (i >= rep.length) throw new IllegalArgumentException('Illegal group reference: group index is missing');
        if (rep[i] === '{') { const e = rep.indexOf('}', i); const name = rep.substring(i + 1, e); if (!groups || !(name in groups)) throw new IllegalArgumentException('No group with name {' + name + '}'); out += groups[name] ?? ''; i = e; }
        else {
          if (!/\d/.test(rep[i])) throw new IllegalArgumentException('Illegal group reference');
          let g = Number(rep[i]); if (g >= caps.length) throw new IndexOutOfBoundsException('No group ' + g);
          while (i + 1 < rep.length && /\d/.test(rep[i + 1]) && g * 10 + Number(rep[i + 1]) < caps.length) { g = g * 10 + Number(rep[i + 1]); i++; }
          out += caps[g] ?? '';
        }
      } else out += c;
    }
    return out;
  };
}
/** String.replaceAll(regex, replacement) / replaceFirst with Java replacement syntax. */
export const replaceAll = (s, regex, rep) => s.replace(toRegExp(regex, 'g'), javaReplacement(rep));
export const replaceFirst = (s, regex, rep) => { const r = toRegExp(regex); return s.replace(new RegExp(r.source, r.flags.replace('g', '')), javaReplacement(rep)); };
/** Pattern.quote for use inside RegExp source. */
export const quoteRegExp = s => s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');

/** String.format(Locale.ROOT, ...) for %s %d %x %X %f %c %b %n %% with flags [-0+ ,] width and precision. */
export function format(fmt, ...args) {
  let ai = 0;
  return fmt.replace(/%(\d+\$)?([-#+ 0,(]*)(\d+)?(?:\.(\d+))?([a-zA-Z%])/g, (all, pos, flags, width, prec, conv) => {
    if (conv === '%') return '%'; if (conv === 'n') return '\n';
    const arg = pos ? args[parseInt(pos, 10) - 1] : args[ai++];
    let s;
    switch (conv) {
      case 's': case 'S': s = arg == null ? 'null' : typeof arg === 'number' ? (Number.isInteger(arg) ? String(arg) : javaDoubleToString(arg)) : String(arg); if (prec !== undefined) s = s.substring(0, +prec); if (conv === 'S') s = s.toUpperCase(); break;
      case 'b': case 'B': s = String(arg != null && arg !== false); break;
      case 'c': s = typeof arg === 'number' ? String.fromCharCode(arg) : String(arg); break;
      case 'd': { const v = typeof arg === 'bigint' ? arg : BigInt(Math.trunc(arg)); s = (v < 0n ? -v : v).toString(); if (flags.includes(',')) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); s = signed(v < 0n, s, flags); break; }
      case 'x': case 'X': { const v = typeof arg === 'bigint' ? BigInt.asUintN(64, arg) : Number.isInteger(arg) && arg >= INT_MIN && arg <= INT_MAX ? BigInt(arg >>> 0) : BigInt.asUintN(64, BigInt(Math.trunc(arg))); s = v.toString(16); if (conv === 'X') s = s.toUpperCase(); break; }
      case 'f': { const p = prec === undefined ? 6 : +prec; if (!Number.isFinite(arg)) { s = Number.isNaN(arg) ? 'NaN' : arg > 0 ? 'Infinity' : '-Infinity'; break; } const neg = arg < 0 || Object.is(arg, -0); s = fixedHalfUp(Math.abs(arg), p); if (flags.includes(',')) { const [ip, fp] = s.split('.'); s = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fp !== undefined ? '.' + fp : ''); } s = signed(neg, s, flags); break; }
      default: throw new IllegalArgumentException('Unsupported format conversion: ' + all);
    }
    if (width !== undefined && s.length < +width) {
      if (flags.includes('-')) s = s.padEnd(+width, ' ');
      else if (flags.includes('0') && 'dxXf'.includes(conv)) { const sign = /^[-+ ]/.test(s) ? s[0] : ''; s = sign + s.substring(sign.length).padStart(+width - sign.length, '0'); }
      else s = s.padStart(+width, ' ');
    }
    return s;
  });
  /** Java's %.Nf rounds the shortest decimal digits HALF_UP (1.005 -> "1.01", unlike toFixed). */
  function fixedHalfUp(v, p) {
    if (v === 0) return p > 0 ? '0.' + '0'.repeat(p) : '0';
    const [, digits, exp] = splitExp(v.toExponential());
    let n = BigInt(digits); const scale = p + exp - (digits.length - 1);
    if (scale >= 0) n *= 10n ** BigInt(scale);
    else { const div = 10n ** BigInt(-scale), r = n % div; n /= div; if (r * 2n >= div) n += 1n; }
    let t = n.toString().padStart(p + 1, '0');
    return p > 0 ? t.slice(0, t.length - p) + '.' + t.slice(t.length - p) : t;
  }
  function signed(neg, s, flags) { return neg ? '-' + s : flags.includes('+') ? '+' + s : flags.includes(' ') ? ' ' + s : s; }
}

// ---------------------------------------------------------------- Character
const code = c => (typeof c === 'number' ? c : c.charCodeAt(0));
const same = (c, v) => (typeof c === 'number' ? v : String.fromCharCode(v));
const test = (re, c) => re.test(String.fromCharCode(code(c)));
const CATS = [['Lu', 1], ['Ll', 2], ['Lt', 3], ['Lm', 4], ['Lo', 5], ['Mn', 6], ['Me', 7], ['Mc', 8], ['Nd', 9], ['Nl', 10], ['No', 11], ['Zs', 12], ['Zl', 13], ['Zp', 14], ['Cc', 15], ['Cf', 16], ['Co', 18], ['Cs', 19], ['Pd', 20], ['Ps', 21], ['Pe', 22], ['Pc', 23], ['Po', 24], ['Sm', 25], ['Sc', 26], ['Sk', 27], ['So', 28], ['Pi', 29], ['Pf', 30]].map(([c, v]) => [new RegExp('^\\p{' + c + '}$', 'u'), v]);
const RE_L = /^\p{L}$/u, RE_ND = /^\p{Nd}$/u, RE_UP = /^\p{Uppercase}$/u, RE_LO = /^\p{Lowercase}$/u, RE_SP = /^[\p{Zs}\p{Zl}\p{Zp}]$/u, RE_ALPHA = /^\p{Alphabetic}$/u;
/** java.lang.Character for BMP chars; accepts a char code or 1-char string, returns the same kind. */
export const Character = {
  UNASSIGNED: 0, UPPERCASE_LETTER: 1, LOWERCASE_LETTER: 2, TITLECASE_LETTER: 3, MODIFIER_LETTER: 4, OTHER_LETTER: 5, NON_SPACING_MARK: 6, ENCLOSING_MARK: 7, COMBINING_SPACING_MARK: 8, DECIMAL_DIGIT_NUMBER: 9, LETTER_NUMBER: 10, OTHER_NUMBER: 11, SPACE_SEPARATOR: 12, LINE_SEPARATOR: 13, PARAGRAPH_SEPARATOR: 14, CONTROL: 15, FORMAT: 16, PRIVATE_USE: 18, SURROGATE: 19, DASH_PUNCTUATION: 20, START_PUNCTUATION: 21, END_PUNCTUATION: 22, CONNECTOR_PUNCTUATION: 23, OTHER_PUNCTUATION: 24, MATH_SYMBOL: 25, CURRENCY_SYMBOL: 26, MODIFIER_SYMBOL: 27, OTHER_SYMBOL: 28, INITIAL_QUOTE_PUNCTUATION: 29, FINAL_QUOTE_PUNCTUATION: 30,
  isLetter: c => test(RE_L, c),
  isDigit: c => test(RE_ND, c),
  isLetterOrDigit: c => test(RE_L, c) || test(RE_ND, c),
  isAlphabetic: c => test(RE_ALPHA, c),
  isUpperCase: c => test(RE_UP, c),
  isLowerCase: c => test(RE_LO, c),
  isSpaceChar: c => test(RE_SP, c),
  isWhitespace: c => { const v = code(c); if ((v >= 9 && v <= 13) || (v >= 0x1C && v <= 0x1F)) return true; if (v === 0xA0 || v === 0x2007 || v === 0x202F) return false; return test(RE_SP, v); },
  isISOControl: c => { const v = code(c); return v <= 0x1F || (v >= 0x7F && v <= 0x9F); },
  /** Simple (1:1) case mapping like Character.toUpperCase(char). */
  toUpperCase: c => { const s = String.fromCharCode(code(c)), u = s.toUpperCase(); return same(c, u.length === 1 ? u.charCodeAt(0) : code(c)); },
  toLowerCase: c => { const v = code(c); if (v === 0x130) return same(c, 0x69); const s = String.fromCharCode(v), u = s.toLowerCase(); return same(c, u.length === 1 ? u.charCodeAt(0) : v); },
  getType: c => { const s = String.fromCharCode(code(c)); for (const [re, v] of CATS) if (re.test(s)) return v; return 0; },
  /** Character.digit(char, radix) incl. Unicode decimal digits and full-width Latin letters. */
  digit: (c, radix) => {
    const v = code(c); let d = -1;
    if (v >= 48 && v <= 57) d = v - 48;
    else if (v >= 97 && v <= 122) d = v - 87; else if (v >= 65 && v <= 90) d = v - 55;
    else if (v >= 0xFF41 && v <= 0xFF5A) d = v - 0xFF41 + 10; else if (v >= 0xFF21 && v <= 0xFF3A) d = v - 0xFF21 + 10;
    else if (test(RE_ND, v)) { let s = v; while (s - 1 >= 0 && test(RE_ND, s - 1) && v - s < 9) s--; d = (v - s) % 10; }
    return d >= 0 && d < radix ? d : -1;
  },
  hashCode: c => code(c),
  compare: (a, b) => code(a) - code(b),
};

// ---------------------------------------------------------------- Objects / hashing / equality
const identity = new WeakMap(); let identitySeq = 0x1234567;
/** Object.hashCode() of a key as Java would compute it (String, Integer/Long, Double, Boolean, objects with hashCode()). */
export function hashCodeOf(k) {
  if (k == null) return 0;
  switch (typeof k) {
    case 'string': return javaStringHash(k);
    case 'number':
      if (Number.isInteger(k)) return k >= INT_MIN && k <= INT_MAX ? k | 0 : Long.hashCode(k);
      { const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, Number.isNaN(k) ? NaN : k); return (dv.getInt32(0) ^ dv.getInt32(4)) | 0; }
    case 'boolean': return k ? 1231 : 1237;
    case 'bigint': return Number(BigInt.asIntN(32, BigInt.asUintN(64, k) ^ (BigInt.asUintN(64, k) >> 32n)));
    default:
      if (typeof k.hashCode === 'function') return k.hashCode() | 0;
      if (!identity.has(k)) { identitySeq = (Math.imul(identitySeq, 1103515245) + 12345) | 0; identity.set(k, identitySeq & 0x7FFFFFFF); }
      return identity.get(k);
  }
}
/** Object.equals(): primitives by value (NaN equals NaN like boxed Double), objects via equals(). */
export function javaEquals(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (typeof a === 'object' && typeof a.equals === 'function') return !!a.equals(b);
  return false;
}
export const Objects = {
  equals: javaEquals,
  hashCode: hashCodeOf,
  requireNonNull: (o, msg) => { if (o == null) throw new NullPointerException(msg); return o; },
  toString: (o, nullDefault = 'null') => (o == null ? nullDefault : String(o)),
};
/** Natural ordering (Comparable): strings by compareTo, numbers, booleans, objects with compareTo(). */
export function naturalCompare(a, b) {
  if (typeof a === 'string') return compareTo(a, b);
  if (typeof a === 'number') return javaNumberCompare(a, b);
  if (typeof a === 'boolean') return a === b ? 0 : a ? 1 : -1;
  if (a != null && typeof a.compareTo === 'function') return a.compareTo(b);
  throw new ClassCastException('not Comparable: ' + a);
}

// ---------------------------------------------------------------- java.util collections
/** Java Iterator over an array snapshot / generator with hasNext()/next()/remove(). */
class JIterator {
  constructor(items, remover) { this.items = items; this.i = 0; this.remover = remover; }
  hasNext() { return this.i < this.items.length; }
  next() { if (this.i >= this.items.length) throw new NoSuchElementException(); return this.items[this.i++]; }
  remove() { if (!this.remover || this.i === 0) throw new IllegalStateException(); this.remover(this.items[this.i - 1]); }
  [Symbol.iterator]() { return { next: () => (this.hasNext() ? { value: this.next(), done: false } : { value: undefined, done: true }) }; }
}
/** Live collection view (keySet/values/entrySet) of a map. */
class CollectionView {
  constructor(list, contains, remove, isSet) { this._list = list; this._contains = contains; this._remove = remove; this._isSet = isSet; }
  size() { return this._list().length; }
  isEmpty() { return this.size() === 0; }
  contains(x) { return this._contains(x); }
  remove(x) { return this._remove(x); }
  iterator() { return new JIterator(this._list(), x => this._remove(x)); }
  [Symbol.iterator]() { return this._list()[Symbol.iterator](); }
  forEach(fn) { for (const x of this._list()) fn(x); }
  toArray() { return this._list(); }
  stream() { return this._list(); }
  removeIf(pred) { let changed = false; for (const x of this._list()) if (pred(x)) { this._remove(x); changed = true; } return changed; }
  containsAll(c) { for (const x of c) if (!this.contains(x)) return false; return true; }
  equals(o) { if (o === this) return true; if (!o || typeof o.size !== 'function' || o.size() !== this.size()) return false; return this.containsAll(o); }
  toString() { return '[' + this._list().map(javaToString).join(', ') + ']'; }
}
/** String.valueOf(Object) for collection toString. */
export function javaToString(o) { if (o == null) return 'null'; if (typeof o === 'number') return Number.isInteger(o) ? String(o) : javaDoubleToString(o); return String(o); }

class HNode {
  constructor(hash, key, value, next) { this.hash = hash; this.key = key; this.value = value; this.next = next; this.before = null; this.after = null; }
  getKey() { return this.key; }
  getValue() { return this.value; }
  setValue(v) { const o = this.value; this.value = v; return o; }
  equals(o) { return o != null && typeof o.getKey === 'function' && javaEquals(this.key, o.getKey()) && javaEquals(this.value, o.getValue()); }
  hashCode() { return hashCodeOf(this.key) ^ hashCodeOf(this.value); }
  toString() { return javaToString(this.key) + '=' + javaToString(this.value); }
}
const MAXIMUM_CAPACITY = 1 << 30, TREEIFY_THRESHOLD = 8, MIN_TREEIFY_CAPACITY = 64;
const spread = h => h ^ (h >>> 16);
function tableSizeFor(cap) { if (cap <= 1) return 1; const n = (-1 >>> Math.clz32(cap - 1)) | 0; return n < 0 ? 1 : n >= MAXIMUM_CAPACITY ? MAXIMUM_CAPACITY : n + 1; }
const isMapLike = o => o != null && typeof o === 'object' && (o instanceof Map || typeof o.entrySet === 'function');
const entriesOf = m => (m instanceof Map ? [...m.entries()] : m.entrySet().toArray().map(e => [e.getKey(), e.getValue()]));

/**
 * java.util.HashMap (JDK 17) with identical iteration order: hash spread h^(h>>>16), power-of-two table,
 * tail insertion for put, head insertion for compute/computeIfAbsent/merge, resize at 0.75 with lo/hi split,
 * resize instead of treeify for small tables. Tree bins (table >= 64 and a chain of 9+) are not modelled.
 */
export class JavaHashMap {
  constructor(arg) {
    this._table = null; this._size = 0; this._threshold = 0;
    if (typeof arg === 'number') { if (arg < 0) throw new IllegalArgumentException('Illegal initial capacity: ' + arg); this._threshold = tableSizeFor(Math.min(arg, MAXIMUM_CAPACITY)); }
    else if (arg != null) this._putMapEntries(arg);
  }
  _putMapEntries(m) {
    const entries = entriesOf(m); const s = entries.length;
    if (s > 0) {
      if (this._table === null) { const ft = Math.fround(Math.fround(s / Math.fround(0.75)) + 1); const t = ft < MAXIMUM_CAPACITY ? Math.trunc(ft) : MAXIMUM_CAPACITY; if (t > this._threshold) this._threshold = tableSizeFor(t); }
      else if (s > this._threshold) this._resize();
      for (const [k, v] of entries) this._putVal(hashCodeOf(k), k, v, false);
    }
  }
  _hash(k) { return k == null ? 0 : spread(hashCodeOf(k)); }
  _resize() {
    const oldTab = this._table, oldCap = oldTab ? oldTab.length : 0, oldThr = this._threshold;
    let newCap, newThr = 0;
    if (oldCap > 0) {
      if (oldCap >= MAXIMUM_CAPACITY) { this._threshold = INT_MAX; return oldTab; }
      newCap = oldCap << 1; if (newCap < MAXIMUM_CAPACITY && oldCap >= 16) newThr = oldThr << 1;
    } else if (oldThr > 0) newCap = oldThr;
    else { newCap = 16; newThr = 12; }
    if (newThr === 0) { const ft = Math.fround(newCap * Math.fround(0.75)); newThr = newCap < MAXIMUM_CAPACITY && ft < MAXIMUM_CAPACITY ? Math.trunc(ft) : INT_MAX; }
    this._threshold = newThr;
    const tab = new Array(newCap).fill(null); this._table = tab;
    if (oldTab) for (let j = 0; j < oldCap; j++) {
      let e = oldTab[j]; if (!e) continue;
      if (!e.next) { tab[e.hash & (newCap - 1)] = e; continue; }
      let loH = null, loT = null, hiH = null, hiT = null;
      for (; e; e = e.next) {
        if ((e.hash & oldCap) === 0) { if (loT) loT.next = e; else loH = e; loT = e; }
        else { if (hiT) hiT.next = e; else hiH = e; hiT = e; }
      }
      if (loT) { loT.next = null; tab[j] = loH; }
      if (hiT) { hiT.next = null; tab[j + oldCap] = hiH; }
    }
    return tab;
  }
  _treeifyBin() { if (this._table.length < MIN_TREEIFY_CAPACITY) this._resize(); }
  _newNode(hash, key, value, next) { return new HNode(hash, key, value, next); }
  _afterInsert() {} _afterRemove() {}
  _putVal(rawHash, key, value, onlyIfAbsent) {
    const hash = key == null ? 0 : spread(rawHash);
    let tab = this._table; if (!tab || tab.length === 0) tab = this._resize();
    const n = tab.length, i = (n - 1) & hash; let p = tab[i], e = null;
    if (!p) { tab[i] = this._newNode(hash, key, value, null); this._afterInsert(tab[i]); } else {
      if (p.hash === hash && javaEquals(p.key, key)) e = p;
      else for (let binCount = 0; ; ++binCount) {
        e = p.next;
        if (!e) { p.next = this._newNode(hash, key, value, null); this._afterInsert(p.next); if (binCount >= TREEIFY_THRESHOLD - 1) this._treeifyBin(); e = null; break; }
        if (e.hash === hash && javaEquals(e.key, key)) break;
        p = e;
      }
      if (e) { const old = e.value; if (!onlyIfAbsent || old == null) e.value = value; return old; }
    }
    if (++this._size > this._threshold) this._resize();
    return null;
  }
  _getNode(key) {
    const tab = this._table; if (!tab) return null; const hash = this._hash(key);
    for (let e = tab[(tab.length - 1) & hash]; e; e = e.next) if (e.hash === hash && javaEquals(e.key, key)) return e;
    return null;
  }
  _removeNode(key) {
    const tab = this._table; if (!tab) return null; const hash = this._hash(key), i = (tab.length - 1) & hash;
    let prev = null;
    for (let e = tab[i]; e; prev = e, e = e.next) if (e.hash === hash && javaEquals(e.key, key)) {
      if (prev) prev.next = e.next; else tab[i] = e.next;
      this._size--; this._afterRemove(e); return e;
    }
    return null;
  }
  /** Shared prologue of compute/computeIfAbsent/merge (resize check first, then bucket scan). */
  _scan(key) {
    const hash = this._hash(key); let tab = this._table;
    if (this._size > this._threshold || !tab || tab.length === 0) tab = this._resize();
    const i = (tab.length - 1) & hash; let old = null, binCount = 0;
    for (let e = tab[i]; e; e = e.next) { if (e.hash === hash && javaEquals(e.key, key)) { old = e; break; } ++binCount; }
    return { hash, tab, i, old, binCount };
  }
  _headInsert(s, key, value) {
    const node = this._newNode(s.hash, key, value, s.tab[s.i]); s.tab[s.i] = node; this._afterInsert(node);
    if (s.binCount >= TREEIFY_THRESHOLD - 1) this._treeifyBin();
    ++this._size;
  }
  _nodes() { const out = []; const tab = this._table; if (tab) for (let i = 0; i < tab.length; i++) for (let e = tab[i]; e; e = e.next) out.push(e); return out; }

  size() { return this._size; }
  isEmpty() { return this._size === 0; }
  get(key) { const e = this._getNode(key); return e ? e.value : null; }
  getOrDefault(key, def) { const e = this._getNode(key); return e ? e.value : def; }
  containsKey(key) { return this._getNode(key) !== null; }
  containsValue(v) { return this._nodes().some(e => javaEquals(e.value, v)); }
  put(key, value) { return this._putVal(hashCodeOf(key), key, value, false); }
  putIfAbsent(key, value) { return this._putVal(hashCodeOf(key), key, value, true); }
  putAll(m) { this._putMapEntries(m); }
  remove(key) { const e = this._removeNode(key); return e ? e.value : null; }
  clear() { if (this._table && this._size > 0) { this._size = 0; this._table.fill(null); this._clearLinks(); } }
  _clearLinks() {}
  computeIfAbsent(key, fn) {
    const s = this._scan(key); if (s.old && s.old.value != null) return s.old.value;
    const v = fn(key); if (v == null) return null;
    if (s.old) { s.old.value = v; return v; }
    this._headInsert(s, key, v); return v;
  }
  computeIfPresent(key, fn) { const e = this._getNode(key); if (e && e.value != null) { const v = fn(key, e.value); if (v != null) { e.value = v; return v; } this._removeNode(key); } return null; }
  compute(key, fn) {
    const s = this._scan(key); const oldValue = s.old ? s.old.value : null; const v = fn(key, oldValue);
    if (s.old) { if (v != null) s.old.value = v; else this._removeNode(key); }
    else if (v != null) this._headInsert(s, key, v);
    return v;
  }
  merge(key, value, fn) {
    if (value == null) throw new NullPointerException();
    const s = this._scan(key);
    if (s.old) { const v = s.old.value != null ? fn(s.old.value, value) : value; if (v != null) s.old.value = v; else this._removeNode(key); return v; }
    this._headInsert(s, key, value); return value;
  }
  forEach(fn) { for (const e of this._nodes()) fn(e.key, e.value); }
  keySet() { return new CollectionView(() => this._nodes().map(e => e.key), k => this.containsKey(k), k => this._removeNode(k) !== null, true); }
  values() { return new CollectionView(() => this._nodes().map(e => e.value), v => this.containsValue(v), v => { const e = this._nodes().find(n => javaEquals(n.value, v)); return e ? this._removeNode(e.key) !== null : false; }, false); }
  entrySet() { return new CollectionView(() => this._nodes(), e => { const n = this._getNode(e.getKey()); return !!n && javaEquals(n.value, e.getValue()); }, e => this._removeNode(e.getKey()) !== null, true); }
  /** JS iteration yields [key, value] pairs in Java order. */
  *[Symbol.iterator]() { for (const e of this._nodes()) yield [e.key, e.value]; }
  keys() { return this._nodes().map(e => e.key)[Symbol.iterator](); }
  equals(o) {
    if (o === this) return true; if (!isMapLike(o)) return false;
    const other = entriesOf(o); if (other.length !== this._size) return false;
    for (const [k, v] of other) { const e = this._getNode(k); if (!e || !javaEquals(e.value, v)) return false; }
    return true;
  }
  hashCode() { let h = 0; for (const e of this._nodes()) h = (h + e.hashCode()) | 0; return h; }
  toString() { return '{' + this._nodes().map(e => e.toString()).join(', ') + '}'; }
}

/** java.util.LinkedHashMap (insertion order) with Java key equality — use when keys are objects (LocalDate…). */
export class JavaLinkedHashMap extends JavaHashMap {
  constructor(arg) { super(typeof arg === 'number' ? arg : undefined); this._head = null; this._tail = null; if (arg != null && typeof arg !== 'number') this._putMapEntries(arg); }
  _afterInsert(n) { n.before = this._tail; n.after = null; if (this._tail) this._tail.after = n; else this._head = n; this._tail = n; }
  _afterRemove(n) { if (n.before) n.before.after = n.after; else this._head = n.after; if (n.after) n.after.before = n.before; else this._tail = n.before; n.before = n.after = null; }
  _clearLinks() { this._head = this._tail = null; }
  _nodes() { const out = []; for (let e = this._head; e; e = e.after) out.push(e); return out; }
}

/** java.util.HashSet backed by JavaHashMap (same iteration order as Java). */
export class JavaHashSet {
  constructor(arg) {
    if (arg == null) this._map = this._newMap();
    else if (typeof arg === 'number') this._map = this._newMap(arg);
    else { const items = [...iterableOf(arg)]; this._map = this._newMap(Math.max(Math.trunc(Math.fround(items.length / Math.fround(0.75))) + 1, 16)); for (const x of items) this.add(x); }
  }
  _newMap(cap) { return new JavaHashMap(cap); }
  add(x) { return this._map.put(x, true) === null; }
  addAll(c) { let ch = false; for (const x of iterableOf(c)) if (this.add(x)) ch = true; return ch; }
  contains(x) { return this._map.containsKey(x); }
  containsAll(c) { for (const x of iterableOf(c)) if (!this.contains(x)) return false; return true; }
  remove(x) { return this._map._removeNode(x) !== null; }
  removeAll(c) { let ch = false; for (const x of iterableOf(c)) if (this.remove(x)) ch = true; return ch; }
  retainAll(c) { const keep = c instanceof JavaHashSet || c instanceof Set ? c : new JavaHashSet(c); let ch = false; for (const x of this.toArray()) if (!(keep.contains ? keep.contains(x) : keep.has(x))) { this.remove(x); ch = true; } return ch; }
  removeIf(pred) { let ch = false; for (const x of this.toArray()) if (pred(x)) { this.remove(x); ch = true; } return ch; }
  size() { return this._map.size(); }
  isEmpty() { return this._map.isEmpty(); }
  clear() { this._map.clear(); }
  toArray() { return this._map._nodes().map(e => e.key); }
  iterator() { return new JIterator(this.toArray(), x => this.remove(x)); }
  [Symbol.iterator]() { return this.toArray()[Symbol.iterator](); }
  forEach(fn) { for (const x of this.toArray()) fn(x); }
  stream() { return this.toArray(); }
  equals(o) { if (o === this) return true; if (o == null || typeof o !== 'object') return false; const items = [...iterableOf(o)]; return items.length === this.size() && items.every(x => this.contains(x)); }
  hashCode() { let h = 0; for (const x of this.toArray()) h = (h + hashCodeOf(x)) | 0; return h; }
  toString() { return '[' + this.toArray().map(javaToString).join(', ') + ']'; }
}
export class JavaLinkedHashSet extends JavaHashSet {
  _newMap(cap) { return new JavaLinkedHashMap(cap); }
}
/** Iterates JS iterables and Java-style collections. */
export function iterableOf(c) {
  if (c == null) throw new NullPointerException();
  if (typeof c[Symbol.iterator] === 'function') return c;
  if (typeof c.toArray === 'function') return c.toArray();
  throw new ClassCastException('not a collection');
}

/** java.util.TreeMap (sorted by comparator or natural order); sorted-array implementation. */
export class JavaTreeMap {
  constructor(arg) {
    this._cmp = typeof arg === 'function' ? arg : naturalCompare; this._keys = []; this._vals = [];
    if (arg != null && typeof arg !== 'function') { if (arg instanceof JavaTreeMap) this._cmp = arg._cmp; for (const [k, v] of entriesOf(arg)) this.put(k, v); }
  }
  _find(k) { let lo = 0, hi = this._keys.length - 1; while (lo <= hi) { const mid = (lo + hi) >>> 1, c = this._cmp(this._keys[mid], k); if (c < 0) lo = mid + 1; else if (c > 0) hi = mid - 1; else return mid; } return -(lo + 1); }
  comparator() { return this._cmp === naturalCompare ? null : this._cmp; }
  size() { return this._keys.length; }
  isEmpty() { return this._keys.length === 0; }
  get(k) { const i = this._find(k); return i >= 0 ? this._vals[i] : null; }
  getOrDefault(k, d) { const i = this._find(k); return i >= 0 ? this._vals[i] : d; }
  containsKey(k) { return this._find(k) >= 0; }
  containsValue(v) { return this._vals.some(x => javaEquals(x, v)); }
  put(k, v) { if (k == null) throw new NullPointerException(); const i = this._find(k); if (i >= 0) { const o = this._vals[i]; this._vals[i] = v; return o; } const at = -i - 1; this._keys.splice(at, 0, k); this._vals.splice(at, 0, v); return null; }
  putIfAbsent(k, v) { const i = this._find(k); if (i >= 0 && this._vals[i] != null) return this._vals[i]; return this.put(k, v); }
  putAll(m) { for (const [k, v] of entriesOf(m)) this.put(k, v); }
  remove(k) { const i = this._find(k); if (i < 0) return null; const o = this._vals[i]; this._keys.splice(i, 1); this._vals.splice(i, 1); return o; }
  clear() { this._keys = []; this._vals = []; }
  computeIfAbsent(k, fn) { const i = this._find(k); if (i >= 0 && this._vals[i] != null) return this._vals[i]; const v = fn(k); if (v != null) this.put(k, v); return v; }
  merge(k, v, fn) { const i = this._find(k); const nv = i >= 0 && this._vals[i] != null ? fn(this._vals[i], v) : v; if (nv == null) this.remove(k); else this.put(k, nv); return nv; }
  compute(k, fn) { const i = this._find(k); const nv = fn(k, i >= 0 ? this._vals[i] : null); if (nv == null) { if (i >= 0) this.remove(k); } else this.put(k, nv); return nv; }
  _entry(i) { const m = this, key = this._keys[i]; return { key, value: this._vals[i], getKey: () => key, getValue: () => m.get(key), setValue: v => m.put(key, v), toString: () => javaToString(key) + '=' + javaToString(m.get(key)) }; }
  _rel(k, mode) { // floor / ceiling / lower / higher index
    const i = this._find(k);
    if (i >= 0) return mode === 'floor' || mode === 'ceiling' ? i : mode === 'lower' ? i - 1 : i + 1;
    const ins = -i - 1; return mode === 'floor' || mode === 'lower' ? ins - 1 : ins;
  }
  _keyAt(i) { return i >= 0 && i < this._keys.length ? this._keys[i] : null; }
  _entryAt(i) { return i >= 0 && i < this._keys.length ? this._entry(i) : null; }
  firstKey() { if (!this._keys.length) throw new NoSuchElementException(); return this._keys[0]; }
  lastKey() { if (!this._keys.length) throw new NoSuchElementException(); return this._keys[this._keys.length - 1]; }
  firstEntry() { return this._entryAt(0); }
  lastEntry() { return this._entryAt(this._keys.length - 1); }
  pollFirstEntry() { const e = this.firstEntry(); if (e) { const snap = { ...e, getValue: () => e.value }; this.remove(e.key); return snap; } return null; }
  pollLastEntry() { const e = this.lastEntry(); if (e) { const snap = { ...e, getValue: () => e.value }; this.remove(e.key); return snap; } return null; }
  floorKey(k) { return this._keyAt(this._rel(k, 'floor')); }
  ceilingKey(k) { return this._keyAt(this._rel(k, 'ceiling')); }
  lowerKey(k) { return this._keyAt(this._rel(k, 'lower')); }
  higherKey(k) { return this._keyAt(this._rel(k, 'higher')); }
  floorEntry(k) { return this._entryAt(this._rel(k, 'floor')); }
  ceilingEntry(k) { return this._entryAt(this._rel(k, 'ceiling')); }
  lowerEntry(k) { return this._entryAt(this._rel(k, 'lower')); }
  higherEntry(k) { return this._entryAt(this._rel(k, 'higher')); }
  forEach(fn) { for (const k of [...this._keys]) fn(k, this.get(k)); }
  keySet() { return new CollectionView(() => [...this._keys], k => this.containsKey(k), k => { const had = this.containsKey(k); this.remove(k); return had; }, true); }
  navigableKeySet() { return this.keySet(); }
  descendingKeySet() { return new CollectionView(() => [...this._keys].reverse(), k => this.containsKey(k), k => { const had = this.containsKey(k); this.remove(k); return had; }, true); }
  values() { return new CollectionView(() => [...this._vals], v => this.containsValue(v), v => { const i = this._vals.findIndex(x => javaEquals(x, v)); if (i < 0) return false; this.remove(this._keys[i]); return true; }, false); }
  entrySet() { return new CollectionView(() => this._keys.map((_, i) => this._entry(i)), e => this.containsKey(e.getKey()) && javaEquals(this.get(e.getKey()), e.getValue()), e => { const had = this.containsKey(e.getKey()); this.remove(e.getKey()); return had; }, true); }
  *[Symbol.iterator]() { const ks = [...this._keys], vs = [...this._vals]; for (let i = 0; i < ks.length; i++) yield [ks[i], vs[i]]; }
  equals(o) { if (!isMapLike(o)) return false; const other = entriesOf(o); if (other.length !== this.size()) return false; for (const [k, v] of other) { const i = this._find(k); if (i < 0 || !javaEquals(this._vals[i], v)) return false; } return true; }
  toString() { return '{' + this._keys.map((k, i) => javaToString(k) + '=' + javaToString(this._vals[i])).join(', ') + '}'; }
}
/** java.util.TreeSet. */
export class JavaTreeSet {
  constructor(arg) { if (typeof arg === 'function' || arg == null) this._m = new JavaTreeMap(arg); else { this._m = new JavaTreeMap(arg instanceof JavaTreeSet ? arg._m._cmp : undefined); this.addAll(arg); } }
  add(x) { if (this._m.containsKey(x)) return false; this._m.put(x, true); return true; }
  addAll(c) { let ch = false; for (const x of iterableOf(c)) if (this.add(x)) ch = true; return ch; }
  contains(x) { return this._m.containsKey(x); }
  remove(x) { if (!this._m.containsKey(x)) return false; this._m.remove(x); return true; }
  removeAll(c) { let ch = false; for (const x of iterableOf(c)) if (this.remove(x)) ch = true; return ch; }
  removeIf(pred) { let ch = false; for (const x of this.toArray()) if (pred(x)) { this.remove(x); ch = true; } return ch; }
  size() { return this._m.size(); }
  isEmpty() { return this._m.isEmpty(); }
  clear() { this._m.clear(); }
  first() { return this._m.firstKey(); }
  last() { return this._m.lastKey(); }
  pollFirst() { if (this.isEmpty()) return null; const k = this.first(); this.remove(k); return k; }
  pollLast() { if (this.isEmpty()) return null; const k = this.last(); this.remove(k); return k; }
  floor(x) { return this._m.floorKey(x); }
  ceiling(x) { return this._m.ceilingKey(x); }
  lower(x) { return this._m.lowerKey(x); }
  higher(x) { return this._m.higherKey(x); }
  descendingSet() { return this.toArray().reverse(); }
  toArray() { return [...this._m._keys]; }
  iterator() { return new JIterator(this.toArray(), x => this.remove(x)); }
  [Symbol.iterator]() { return this.toArray()[Symbol.iterator](); }
  forEach(fn) { for (const x of this.toArray()) fn(x); }
  stream() { return this.toArray(); }
  containsAll(c) { for (const x of iterableOf(c)) if (!this.contains(x)) return false; return true; }
  equals(o) { if (o == null || typeof o !== 'object') return false; const items = [...iterableOf(o)]; return items.length === this.size() && items.every(x => this.contains(x)); }
  toString() { return '[' + this.toArray().map(javaToString).join(', ') + ']'; }
}

// ---------------------------------------------------------------- charsets, Base64, digests, UUID
const ENC = new TextEncoder(), DEC = new TextDecoder('utf-8');
/** String.getBytes(StandardCharsets.UTF_8). */
export const utf8Encode = s => ENC.encode(s);
/** new String(bytes, StandardCharsets.UTF_8) (optionally offset/length). */
export const utf8Decode = (b, off = 0, len = b.length - off) => DEC.decode(b.subarray(off, off + len));
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64encode(bytes) {
  let out = ''; let i = 0;
  for (; i + 2 < bytes.length; i += 3) { const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]; out += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]; }
  if (i < bytes.length) { const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8); out += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + '='; }
  return out;
}
function b64decode(s, lenient) {
  let clean = String(s); if (lenient) clean = clean.replace(/[\r\n\t ]/g, '');
  clean = clean.replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(clean) || clean.length % 4 === 1) throw new IllegalArgumentException('Illegal base64 character or length');
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4)); let o = 0, buf = 0, bits = 0;
  for (const ch of clean) { buf = (buf << 6) | B64.indexOf(ch); bits += 6; if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 0xFF; } }
  return out.subarray(0, o);
}
/** java.util.Base64 (basic encoder/decoder). */
export const Base64 = {
  getEncoder: () => ({ encodeToString: b => b64encode(b), encode: b => ENC.encode(b64encode(b)) }),
  getDecoder: () => ({ decode: s => b64decode(typeof s === 'string' ? s : utf8Decode(s), false) }),
};
/** android.util.Base64 (flags: DEFAULT adds a trailing newline every 76 chars; NO_WRAP none). */
export const AndroidBase64 = {
  DEFAULT: 0, NO_PADDING: 1, NO_WRAP: 2, CRLF: 4, URL_SAFE: 8,
  encodeToString(bytes, flags) {
    let s = b64encode(bytes);
    if (flags & 8) s = s.replace(/\+/g, '-').replace(/\//g, '_');
    if (flags & 1) s = s.replace(/=+$/, '');
    if (!(flags & 2)) { const nl = flags & 4 ? '\r\n' : '\n'; s = (s.match(/.{1,76}/g) || []).join(nl) + (s.length ? nl : ''); }
    return s;
  },
  decode(s, flags) { let t = String(s); if (flags & 8) t = t.replace(/-/g, '+').replace(/_/g, '/'); return b64decode(t, true); },
};

const K256 = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
function sha256Block(H, W, b, o) {
  for (let i = 0; i < 16; i++) W[i] = (b[o + 4 * i] << 24) | (b[o + 4 * i + 1] << 16) | (b[o + 4 * i + 2] << 8) | b[o + 4 * i + 3];
  for (let i = 16; i < 64; i++) { const x = W[i - 15], y = W[i - 2]; const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3), s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10); W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0; }
  let [a, bb, c, d, e, ff, g, h] = H;
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7)), ch = (e & ff) ^ (~e & g), t1 = (h + S1 + ch + K256[i] + W[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10)), mj = (a & bb) ^ (a & c) ^ (bb & c), t2 = (S0 + mj) | 0;
    h = g; g = ff; ff = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
  }
  H[0] += a; H[1] += bb; H[2] += c; H[3] += d; H[4] += e; H[5] += ff; H[6] += g; H[7] += h;
}
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21], MD5_K = new Int32Array(64).map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);
function md5Block(H, W, b, o) {
  for (let i = 0; i < 16; i++) W[i] = b[o + 4 * i] | (b[o + 4 * i + 1] << 8) | (b[o + 4 * i + 2] << 16) | (b[o + 4 * i + 3] << 24);
  let a = H[0], bb = H[1], c = H[2], d = H[3];
  for (let i = 0; i < 64; i++) {
    let F, g; const r = i >> 4;
    if (r === 0) { F = (bb & c) | (~bb & d); g = i; } else if (r === 1) { F = (d & bb) | (~d & c); g = (5 * i + 1) & 15; } else if (r === 2) { F = bb ^ c ^ d; g = (3 * i + 5) & 15; } else { F = c ^ (bb | ~d); g = (7 * i) & 15; }
    const s = MD5_S[(r << 2) | (i & 3)], t = (a + F + MD5_K[i] + W[g]) | 0;
    a = d; d = c; c = bb; bb = (bb + ((t << s) | (t >>> (32 - s)))) | 0;
  }
  H[0] += a; H[1] += bb; H[2] += c; H[3] += d;
}
/** java.security.MessageDigest for "SHA-256" and "MD5" (synchronous, streaming). */
export class MessageDigest {
  static getInstance(alg) { const a = String(alg).toUpperCase(); if (a !== 'SHA-256' && a !== 'MD5') throw new NoSuchAlgorithmException(alg + ' MessageDigest not available'); return new MessageDigest(a); }
  constructor(alg) { this.alg = alg; this.reset(); }
  reset() { this._H = this.alg === 'MD5' ? new Int32Array([0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476]) : new Int32Array([0x6a09e667, 0xbb67ae85 | 0, 0x3c6ef372, 0xa54ff53a | 0, 0x510e527f, 0x9b05688c | 0, 0x1f83d9ab, 0x5be0cd19]); this._buf = new Uint8Array(64); this._n = 0; this._len = 0; this._W = new Int32Array(64); }
  _block(b, o) { (this.alg === 'MD5' ? md5Block : sha256Block)(this._H, this._W, b, o); }
  update(bytes, off = 0, len = bytes.length - off) {
    if (typeof bytes === 'number') { bytes = Uint8Array.of(bytes & 0xFF); off = 0; len = 1; }
    this._len += len; let i = off; const end = off + len;
    if (this._n > 0) { while (this._n < 64 && i < end) this._buf[this._n++] = bytes[i++]; if (this._n === 64) { this._block(this._buf, 0); this._n = 0; } }
    for (; i + 64 <= end; i += 64) this._block(bytes, i);
    while (i < end) this._buf[this._n++] = bytes[i++];
  }
  digest(bytes) {
    if (bytes) this.update(bytes);
    const bitLen = BigInt(this._len) * 8n, md5 = this.alg === 'MD5';
    const pad = new Uint8Array(((this._n < 56 ? 56 : 120) - this._n) + 8); pad[0] = 0x80;
    for (let i = 0; i < 8; i++) pad[pad.length - 8 + i] = Number((md5 ? bitLen >> BigInt(8 * i) : bitLen >> BigInt(56 - 8 * i)) & 0xFFn);
    const total = this._len; this.update(pad); this._len = total;
    const out = new Uint8Array(this._H.length * 4);
    this._H.forEach((h, i) => { for (let j = 0; j < 4; j++) out[4 * i + j] = md5 ? (h >>> (8 * j)) & 0xFF : (h >>> (24 - 8 * j)) & 0xFF; });
    this.reset(); return out;
  }
}
const hex2 = b => b.toString(16).padStart(2, '0');
/** java.util.UUID: randomUUID() (v4) and nameUUIDFromBytes() (MD5, v3); toString() lower-case. */
export class UUID {
  constructor(bytes) { this._b = bytes; }
  static randomUUID() { const b = new Uint8Array(16); globalThis.crypto.getRandomValues(b); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; return new UUID(b); }
  static nameUUIDFromBytes(name) { const b = MessageDigest.getInstance('MD5').digest(name); b[6] = (b[6] & 0x0f) | 0x30; b[8] = (b[8] & 0x3f) | 0x80; return new UUID(b); }
  static fromString(s) { const h = String(s).replace(/-/g, ''); if (!/^[0-9a-fA-F]{32}$/.test(h)) throw new IllegalArgumentException('Invalid UUID string: ' + s); return new UUID(Uint8Array.from(h.match(/../g), x => parseInt(x, 16))); }
  toString() { const h = Array.from(this._b, hex2).join(''); return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20); }
  equals(o) { return o instanceof UUID && o.toString() === this.toString(); }
  hashCode() { return javaStringHash(this.toString()); }
}
/** CRC32 (java.util.zip.CRC32). */
const CRC_TABLE = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
export class CRC32 {
  constructor() { this._c = -1; }
  update(b, off = 0, len = b.length - off) { let c = this._c; for (let i = off; i < off + len; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8); this._c = c; }
  getValue() { return (~this._c) >>> 0; }
  reset() { this._c = -1; }
}

// ---------------------------------------------------------------- clocks
let clockOverride = null;
/** Tests can pin "now" (epoch ms) for System.currentTimeMillis and java.time now(); pass null to restore. */
export function setClockForTesting(fnOrMillis) { clockOverride = fnOrMillis == null ? null : typeof fnOrMillis === 'function' ? fnOrMillis : () => fnOrMillis; }
const perf = globalThis.performance;
export const System = {
  currentTimeMillis: () => (clockOverride ? clockOverride() : Date.now()),
  nanoTime: () => Math.round(perf.now() * 1e6),
  lineSeparator: () => '\n',
};
/** android.os.SystemClock. */
export const SystemClock = { elapsedRealtime: () => Math.floor(perf.now()), uptimeMillis: () => Math.floor(perf.now()) };

// ---------------------------------------------------------------- java.text.Collator, java.lang.Thread
/** java.text.Collator.getInstance(locale) (default TERTIARY strength) over Intl.Collator; locale is a BCP 47 tag ("vi"). */
export const Collator = { getInstance: locale => { const c = new Intl.Collator(locale); return { compare: (a, b) => c.compare(a, b) }; } };
/**
 * java.lang.Thread subset. The page itself is the thread "main". A job submitted to an ExecutorService of
 * Executors.newSingleThreadExecutor() runs as that executor's worker thread ("pool-N-thread-1"): while the job runs
 * (from its start until its promise settles), Thread.currentThread() is the worker, so the readers' Java check points
 * (isInterrupted(), Thread.interrupted(), Tasks.await) see the job's own interrupt flag, set by Future.cancel(true) or
 * shutdownNow(). JavaScript has no per-async-context thread, so code of the page that runs between the job's awaits
 * also sees the worker as current; jobs are expected to run one at a time (the app runs one reader at a time; with
 * two overlapping jobs the latest started is current). The default uncaught-exception handler, handler(thread,
 * failure), is called for the page's uncaught errors and unhandled promise rejections (browser only; nothing is
 * installed under Node so the test runner keeps its own handling) and for exceptions of execute()d jobs.
 */
let uncaughtHandler = null, uncaughtInstalled = false;
class JavaThread {
  constructor(name) { this._name = name; this._interrupted = false; this._listeners = new Set(); }
  getName() { return this._name; }
  isInterrupted() { return this._interrupted; }
  /** Sets the interrupt flag and wakes the thread's interruptible waits (Tasks.await). */
  interrupt() { this._interrupted = true; for (const fn of [...this._listeners]) fn(); }
  /** For interruptible waits: fn() runs on interrupt; returns the function that unregisters it. */
  _onInterrupt(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  toString() { return 'Thread[' + this._name + ',5,main]'; }
}
const MAIN_THREAD = new JavaThread('main');
/** Worker threads whose job is running, most recently started last. */
const runningThreads = [];
export const Thread = {
  currentThread: () => (runningThreads.length ? runningThreads[runningThreads.length - 1] : MAIN_THREAD),
  /** Tests and clears the current thread's interrupt flag. */
  interrupted() { const t = Thread.currentThread(); const was = t._interrupted; t._interrupted = false; return was; },
  getDefaultUncaughtExceptionHandler: () => uncaughtHandler,
  setDefaultUncaughtExceptionHandler(handler) {
    uncaughtHandler = handler ?? null;
    if (uncaughtInstalled || typeof globalThis.addEventListener !== 'function' || typeof globalThis.document === 'undefined') return;
    uncaughtInstalled = true;
    const toError = x => (x instanceof Error ? x : new Error(String(x)));
    globalThis.addEventListener('error', ev => { if (uncaughtHandler) uncaughtHandler(MAIN_THREAD, toError(ev.error ?? ev.message)); });
    globalThis.addEventListener('unhandledrejection', ev => { if (uncaughtHandler) uncaughtHandler(MAIN_THREAD, toError(ev.reason)); });
  },
};
export const CancellationException = ex('java.util.concurrent.CancellationException', IllegalStateException);
export const ExecutionException = ex('java.util.concurrent.ExecutionException', JavaException);
export const TimeoutException = ex('java.util.concurrent.TimeoutException', JavaException);
export const RejectedExecutionException = ex('java.util.concurrent.RejectedExecutionException', RuntimeException);
const removeLast = (list, x) => { const i = list.lastIndexOf(x); if (i >= 0) list.splice(i, 1); };
/** java.util.concurrent.FutureTask: get() is a Promise (CancellationException when cancelled, ExecutionException(cause)
 *  when the task threw). cancel(true) on a running task interrupts its worker; the task itself goes on until it
 *  notices, as in Java, and the worker takes no other task before that. */
class FutureTask {
  constructor(task) {
    this._task = task; this._state = 'NEW'; this._thread = null;
    this._result = new Promise((resolve, reject) => { this._resolve = resolve; this._reject = reject; }); this._result.catch(() => {});
  }
  cancel(mayInterruptIfRunning) {
    if (this._state !== 'NEW' && this._state !== 'RUNNING') return false;
    const running = this._state === 'RUNNING'; this._state = 'CANCELLED';
    if (running && mayInterruptIfRunning) this._thread.interrupt();
    this._reject(new CancellationException('Task was cancelled.')); return true;
  }
  isCancelled() { return this._state === 'CANCELLED'; }
  isDone() { return this._state !== 'NEW' && this._state !== 'RUNNING'; }
  get() { return this._result; }
  /** Runs the task as `thread` (Thread.currentThread() while it runs); the future settles after the thread left. */
  async _run(thread) {
    if (this._state !== 'NEW') return; this._state = 'RUNNING'; this._thread = thread; let value, failed = false;
    runningThreads.push(thread);
    try { value = await this._task(); } catch (failure) { failed = true; this._failure = failure; } finally { removeLast(runningThreads, thread); }
    if (this._state !== 'RUNNING') return;
    if (!failed) { this._state = 'DONE'; this._resolve(value); }
    else { this._state = 'FAILED'; const f = this._failure; this._reject(new ExecutionException(f instanceof Error ? f : new JavaException(String(f)))); }
  }
}
let poolSequence = 0;
/** Executors.newSingleThreadExecutor(): one worker thread, tasks (functions, sync or async) run one after another,
 *  each starting after the call that queued it returns. */
class SingleThreadExecutor {
  constructor() { this._thread = new JavaThread('pool-' + (++poolSequence) + '-thread-1'); this._queue = []; this._busy = false; this._shutdown = false; this._stopped = false; }
  /** submit(task) → Future. */
  submit(task) { if (task == null) throw new NullPointerException(); const future = new FutureTask(task); this._enqueue(future, false); return future; }
  /** execute(command): an exception of the command goes to the default uncaught-exception handler (worker thread). */
  execute(command) { if (command == null) throw new NullPointerException(); this._enqueue(new FutureTask(command), true); }
  _enqueue(future, uncaught) {
    if (this._shutdown) throw new RejectedExecutionException('Task rejected from ' + this._thread.getName());
    this._queue.push({ future, uncaught }); if (!this._busy) { this._busy = true; Promise.resolve().then(() => this._drain()); }
  }
  async _drain() {
    while (this._queue.length) {
      const { future, uncaught } = this._queue.shift();
      // ThreadPoolExecutor.runWorker: a pool that is not stopping clears the interrupt left by the previous task.
      if (!this._stopped) this._thread._interrupted = false;
      await future._run(this._thread);
      // A throwing handler ends only that worker in Java (the pool starts a new one): the queue keeps draining.
      if (uncaught && future._state === 'FAILED') { try { if (uncaughtHandler) uncaughtHandler(this._thread, future._failure); else console.error(future._failure); } catch (e) { console.error(e); } } // eslint-disable-line no-console
    }
    this._busy = false;
  }
  shutdown() { this._shutdown = true; }
  /** Stops taking tasks, interrupts the running one and returns the commands that never started. */
  shutdownNow() {
    this._shutdown = true; this._stopped = true; const pending = this._queue.map(q => q.future._task); this._queue = [];
    if (this._busy) this._thread.interrupt(); return pending;
  }
  isShutdown() { return this._shutdown; }
  isTerminated() { return this._shutdown && !this._busy; }
}
export const Executors = Object.freeze({ newSingleThreadExecutor: () => new SingleThreadExecutor() });

/** java.util.Locale subset: the default locale is the runtime's (browser) locale. */
export const Locale = Object.freeze({ getDefault: () => { let tag = 'und'; try { tag = Intl.DateTimeFormat().resolvedOptions().locale || 'und'; } catch { /* keep und */ } return Object.freeze({ toLanguageTag: () => tag, toString: () => tag.replace(/-/g, '_') }); } });
