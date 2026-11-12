// org.json as shipped in Android (AOSP libcore implementation): JSONObject, JSONArray, JSONTokener, JSONStringer.
// Key order = insertion order (LinkedHashMap). Lenient tokener, '/' escaped as "\/", numbers printed like
// JSONObject.numberToString. Numbers: a JS integer behaves as Integer/Long, a non-integer as Double.
// jfloat(v) / jdouble(v) box a value that Java boxes as Float / integral Double (affects toString/getString).
import { JavaException, NoSuchElementException, javaDoubleToString, javaFloatToString, parseDouble, d2i, d2l, INT_MIN, INT_MAX, equalsIgnoreCase, JavaHashMap, JavaTreeMap, javaEquals } from './java.js';

export class JSONException extends JavaException { static javaName = 'org.json.JSONException'; }

/** Boxed Float (kind 'F') or integral Double (kind 'D'). get()/opt() return the plain number. */
class NumBox {
  constructor(kind, v) { this.kind = kind; this.v = kind === 'F' ? Math.fround(v) : v; }
  valueOf() { return this.v; }
  toString() { return this.kind === 'F' ? javaFloatToString(this.v) : javaDoubleToString(this.v); }
}
/** Marks a number that the Java code boxes as java.lang.Float (e.g. float[] in new JSONArray, Object varargs). */
export const jfloat = v => new NumBox('F', v);
/** Marks an integral number that Java holds as java.lang.Double (getString gives "5.0"). */
export const jdouble = v => new NumBox('D', v);

const NULL_OBJ = Object.freeze({ toString: () => 'null', equals: o => o == null || o === NULL_OBJ, hashCode: () => 0 });
const unbox = v => (v instanceof NumBox ? v.v : v);
const isNumber = v => typeof v === 'number' || v instanceof NumBox;

function className(v) {
  if (typeof v === 'string') return 'java.lang.String';
  if (typeof v === 'boolean') return 'java.lang.Boolean';
  if (v instanceof NumBox) return v.kind === 'F' ? 'java.lang.Float' : 'java.lang.Double';
  if (typeof v === 'number') return Number.isInteger(v) ? (v >= INT_MIN && v <= INT_MAX ? 'java.lang.Integer' : 'java.lang.Long') : 'java.lang.Double';
  if (v === NULL_OBJ) return 'org.json.JSONObject$1';
  if (v instanceof JSONObject) return 'org.json.JSONObject';
  if (v instanceof JSONArray) return 'org.json.JSONArray';
  return v?.constructor?.name ?? typeof v;
}
/** String.valueOf(value) as org.json's JSON.toString sees it. */
function valueString(v) {
  if (v instanceof NumBox) return v.toString();
  if (typeof v === 'number') return Number.isInteger(v) ? String(Object.is(v, -0) ? 0 : v) : javaDoubleToString(v);
  return String(v);
}
function checkDouble(d) { if (!Number.isFinite(d)) throw new JSONException('Forbidden numeric value: ' + javaDoubleToString(d)); return d; }
function typeMismatch3(indexOrName, actual, required) {
  if (actual == null) throw new JSONException('Value at ' + indexOrName + ' is null.');
  throw new JSONException('Value ' + valueString(actual) + ' at ' + indexOrName + ' of type ' + className(actual) + ' cannot be converted to ' + required);
}
function typeMismatch2(actual, required) {
  if (actual == null) throw new JSONException('Value is null.');
  throw new JSONException('Value ' + valueString(actual) + ' of type ' + className(actual) + ' cannot be converted to ' + required);
}
// org.json JSON.toXxx coercions (null result = cannot coerce).
function toBoolean(v) { if (typeof v === 'boolean') return v; if (typeof v === 'string') { if (equalsIgnoreCase('true', v)) return true; if (equalsIgnoreCase('false', v)) return false; } return null; }
function toDouble(v) { if (isNumber(v)) return unbox(v); if (typeof v === 'string') { try { return parseDouble(v); } catch { /* not a number */ } } return null; }
function toInteger(v) {
  if (isNumber(v)) { const n = unbox(v); if (Number.isInteger(n) && (n < INT_MIN || n > INT_MAX)) return Number(BigInt.asIntN(32, BigInt(n))); return d2i(n); }
  if (typeof v === 'string') { try { return d2i(parseDouble(v)); } catch { /* not a number */ } }
  return null;
}
function toLong(v) { if (isNumber(v)) return d2l(unbox(v)); if (typeof v === 'string') { try { return d2l(parseDouble(v)); } catch { /* not a number */ } } return null; }
function toStr(v) { if (typeof v === 'string') return v; if (v != null) return valueString(v); return null; }

/** JSONObject.numberToString. */
function numberToString(n) {
  const isBox = n instanceof NumBox; const d = unbox(n);
  if (!Number.isFinite(d)) throw new JSONException('Forbidden numeric value: ' + javaDoubleToString(d));
  if (Object.is(d, -0) && !(isBox && n.kind === 'F')) return '-0';
  if (Number.isInteger(d) && Math.abs(d) < 9223372036854775807) return BigInt(d).toString();
  return isBox && n.kind === 'F' ? javaFloatToString(d) : javaDoubleToString(d);
}

/** Recursively wraps JS/Java collections the way JSONObject.wrap does. */
function wrap(o) {
  if (o == null) return NULL_OBJ;
  if (o instanceof JSONArray || o instanceof JSONObject || o === NULL_OBJ || o instanceof NumBox) return o;
  if (typeof o === 'string' || typeof o === 'number' || typeof o === 'boolean') return o;
  if (o instanceof Float32Array) return JSONArray._from(Array.from(o, jfloat));
  if (Array.isArray(o) || ArrayBuffer.isView(o) || o instanceof Set || (typeof o.toArray === 'function' && typeof o.contains === 'function' && typeof o.containsKey !== 'function')) return new JSONArray(o);
  if (o instanceof Map || o instanceof JavaHashMap || o instanceof JavaTreeMap) return new JSONObject(o);
  if (typeof o === 'object' && Object.getPrototypeOf(o) !== Object.prototype && typeof o.toString === 'function' && o.toString !== Object.prototype.toString) return o.toString();
  return null;
}

// ------------------------------------------------------------------ JSONStringer
const S = { EMPTY_ARRAY: 1, NONEMPTY_ARRAY: 2, EMPTY_OBJECT: 3, DANGLING_KEY: 4, NONEMPTY_OBJECT: 5, NULL: 6 };
export class JSONStringer {
  constructor(indentSpaces) { this.out = ''; this.stack = []; this.indent = indentSpaces > 0 ? ' '.repeat(indentSpaces) : null; }
  array() { return this._open(S.EMPTY_ARRAY, '['); }
  endArray() { return this._close(S.EMPTY_ARRAY, S.NONEMPTY_ARRAY, ']'); }
  object() { return this._open(S.EMPTY_OBJECT, '{'); }
  endObject() { return this._close(S.EMPTY_OBJECT, S.NONEMPTY_OBJECT, '}'); }
  _open(empty, bracket) { if (this.stack.length === 0 && this.out.length > 0) throw new JSONException('Nesting problem: multiple top-level roots'); this._beforeValue(); this.stack.push(empty); this.out += bracket; return this; }
  _close(empty, nonempty, bracket) {
    const ctx = this._peek(); if (ctx !== nonempty && ctx !== empty) throw new JSONException('Nesting problem');
    this.stack.pop(); if (ctx === nonempty) this._newline(); this.out += bracket; return this;
  }
  _peek() { if (this.stack.length === 0) throw new JSONException('Nesting problem'); return this.stack[this.stack.length - 1]; }
  _replaceTop(s) { this.stack[this.stack.length - 1] = s; }
  _newline() { if (this.indent === null) return; this.out += '\n' + this.indent.repeat(this.stack.length); }
  value(v) {
    if (this.stack.length === 0) throw new JSONException('Nesting problem');
    if (v instanceof JSONArray) { v._writeTo(this); return this; }
    if (v instanceof JSONObject) { v._writeTo(this); return this; }
    this._beforeValue();
    if (v == null || typeof v === 'boolean' || v === NULL_OBJ) this.out += String(v ?? 'null');
    else if (isNumber(v)) this.out += numberToString(v);
    else this._string(String(v));
    return this;
  }
  key(name) { if (name == null) throw new JSONException('Names must be non-null'); this._beforeKey(); this._string(name); return this; }
  _string(value) {
    let o = '"';
    for (let i = 0; i < value.length; i++) {
      const c = value[i];
      switch (c) {
        case '"': case '\\': case '/': o += '\\' + c; break;
        case '\t': o += '\\t'; break; case '\b': o += '\\b'; break; case '\n': o += '\\n'; break; case '\r': o += '\\r'; break; case '\f': o += '\\f'; break;
        default: o += c.charCodeAt(0) <= 0x1F ? '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0') : c;
      }
    }
    this.out += o + '"';
  }
  _beforeKey() { const ctx = this._peek(); if (ctx === S.NONEMPTY_OBJECT) this.out += ','; else if (ctx !== S.EMPTY_OBJECT) throw new JSONException('Nesting problem'); this._newline(); this._replaceTop(S.DANGLING_KEY); }
  _beforeValue() {
    if (this.stack.length === 0) return;
    const ctx = this._peek();
    if (ctx === S.EMPTY_ARRAY) { this._replaceTop(S.NONEMPTY_ARRAY); this._newline(); }
    else if (ctx === S.NONEMPTY_ARRAY) { this.out += ','; this._newline(); }
    else if (ctx === S.DANGLING_KEY) { this.out += this.indent === null ? ':' : ': '; this._replaceTop(S.NONEMPTY_OBJECT); }
    else if (ctx !== S.NULL) throw new JSONException('Nesting problem');
  }
  toString() { return this.out.length === 0 ? null : this.out; }
}

// ------------------------------------------------------------------ JSONTokener (lenient, as Android)
export class JSONTokener {
  constructor(input) { if (input != null && input.startsWith('﻿')) input = input.substring(1); this.in = input; this.pos = 0; }
  nextValue() {
    const c = this._nextCleanInternal();
    switch (c) {
      case -1: throw this.syntaxError('End of input');
      case '{': return this._readObject();
      case '[': return this._readArray();
      case "'": case '"': return this.nextString(c);
      default: this.pos--; return this._readLiteral();
    }
  }
  _nextCleanInternal() {
    const s = this.in;
    while (this.pos < s.length) {
      const c = s[this.pos++];
      switch (c) {
        case '\t': case ' ': case '\n': case '\r': continue;
        case '/': {
          if (this.pos === s.length) return c;
          const peek = s[this.pos];
          if (peek === '*') { this.pos++; const end = s.indexOf('*/', this.pos); if (end === -1) throw this.syntaxError('Unterminated comment'); this.pos = end + 2; continue; }
          if (peek === '/') { this.pos++; this._skipToEndOfLine(); continue; }
          return c;
        }
        case '#': this._skipToEndOfLine(); continue;
        default: return c;
      }
    }
    return -1;
  }
  _skipToEndOfLine() { for (; this.pos < this.in.length; this.pos++) { const c = this.in[this.pos]; if (c === '\r' || c === '\n') { this.pos++; break; } } }
  nextString(quote) {
    const s = this.in; let builder = null, start = this.pos;
    while (this.pos < s.length) {
      const c = s[this.pos++];
      if (c === quote) return builder === null ? s.substring(start, this.pos - 1) : builder + s.substring(start, this.pos - 1);
      if (c === '\\') {
        if (this.pos === s.length) throw this.syntaxError('Unterminated escape sequence');
        builder = (builder ?? '') + s.substring(start, this.pos - 1) + this._readEscapeCharacter(); start = this.pos;
      }
    }
    throw this.syntaxError('Unterminated string');
  }
  _readEscapeCharacter() {
    const e = this.in[this.pos++];
    switch (e) {
      case 'u': {
        if (this.pos + 4 > this.in.length) throw this.syntaxError('Unterminated escape sequence');
        const hex = this.in.substring(this.pos, this.pos + 4); this.pos += 4;
        if (!/^[+-]?[0-9a-fA-F]+$/.test(hex)) throw this.syntaxError('Invalid escape sequence: ' + hex);
        return String.fromCharCode(parseInt(hex, 16) & 0xFFFF);
      }
      case 't': return '\t'; case 'b': return '\b'; case 'n': return '\n'; case 'r': return '\r'; case 'f': return '\f';
      default: return e;
    }
  }
  _readLiteral() {
    const literal = this._nextToInternal('{}[]/\\:,=;# \t\f');
    if (literal.length === 0) throw this.syntaxError('Expected literal value');
    if (equalsIgnoreCase('null', literal)) return NULL_OBJ;
    if (equalsIgnoreCase('true', literal)) return true;
    if (equalsIgnoreCase('false', literal)) return false;
    if (literal.indexOf('.') === -1) {
      let base = 10, number = literal;
      if (number.startsWith('0x') || number.startsWith('0X')) { number = number.substring(2); base = 16; }
      else if (number.startsWith('0') && number.length > 1) { number = number.substring(1); base = 8; }
      const v = parseLongStrict(number, base);
      if (v !== null) return Number(v);
    }
    try { const d = parseDouble(literal); return Number.isInteger(d) ? jdouble(d) : d; } catch { /* unquoted string */ }
    return literal;
  }
  _nextToInternal(excluded) {
    const s = this.in, start = this.pos;
    for (; this.pos < s.length; this.pos++) { const c = s[this.pos]; if (c === '\r' || c === '\n' || excluded.indexOf(c) !== -1) return s.substring(start, this.pos); }
    return s.substring(start);
  }
  _readArray() {
    const result = new JSONArray(); let trailing = false;
    for (;;) {
      switch (this._nextCleanInternal()) {
        case -1: throw this.syntaxError('Unterminated array');
        case ']': if (trailing) result._values.push(null); return result;
        case ',': case ';': result._values.push(null); trailing = true; continue;
        default: this.pos--;
      }
      result._values.push(this.nextValue());
      switch (this._nextCleanInternal()) {
        case ']': return result;
        case ',': case ';': trailing = true; continue;
        default: throw this.syntaxError('Unterminated array');
      }
    }
  }
  _readObject() {
    const result = new JSONObject();
    const first = this._nextCleanInternal();
    if (first === '}') return result; else if (first !== -1) this.pos--;
    for (;;) {
      const name = this.nextValue();
      if (typeof name !== 'string') { if (name == null) throw this.syntaxError('Names cannot be null'); throw this.syntaxError('Names must be strings, but ' + valueString(name) + ' is of type ' + className(name)); }
      const sep = this._nextCleanInternal();
      if (sep !== ':' && sep !== '=') throw this.syntaxError("Expected ':' after " + name);
      if (this.pos < this.in.length && this.in[this.pos] === '>') this.pos++;
      result._put(name, this.nextValue());
      switch (this._nextCleanInternal()) {
        case '}': return result;
        case ';': case ',': continue;
        default: throw this.syntaxError('Unterminated object');
      }
    }
  }
  syntaxError(message) { return new JSONException(message + this.toString()); }
  toString() { return ' at character ' + this.pos + ' of ' + this.in; }
  more() { return this.pos < this.in.length; }
}
/** Long.parseLong(number, base) or null on NumberFormatException. */
function parseLongStrict(s, base) {
  const digits = base === 16 ? /^[+-]?[0-9a-fA-F]+$/ : base === 8 ? /^[+-]?[0-7]+$/ : /^[+-]?[0-9]+$/;
  if (!digits.test(s)) return null;
  const neg = s[0] === '-'; const body = s.replace(/^[+-]/, '');
  let v = 0n; const B = BigInt(base); for (const ch of body) v = v * B + BigInt(parseInt(ch, base));
  if (neg) v = -v;
  if (v > 9223372036854775807n || v < -9223372036854775808n) return null;
  return v;
}

// ------------------------------------------------------------------ JSONObject
export class JSONObject {
  static NULL = NULL_OBJ;
  /** new JSONObject() | (String json) | (JSONTokener) | (Map / JavaHashMap / plain object of name -> value) | (JSONObject copyFrom, String[] names). */
  constructor(arg, names) {
    this._map = new Map();
    if (arg === undefined) return;
    if (arg instanceof JSONObject && Array.isArray(names)) { for (const n of names) { const v = arg.opt(n); if (v != null) this._map.set(n, arg._map.get(n)); } return; }
    if (typeof arg === 'string' || arg instanceof JSONTokener) {
      const t = typeof arg === 'string' ? new JSONTokener(arg) : arg;
      const o = t.nextValue();
      if (o instanceof JSONObject) this._map = o._map; else throw typeMismatch2(o, 'JSONObject');
      return;
    }
    if (arg === null) throw new TypeError('JSONObject(null)');
    const entries = arg instanceof Map ? arg.entries() : typeof arg.entrySet === 'function' ? arg.entrySet().toArray().map(e => [e.getKey(), e.getValue()]) : Object.entries(arg);
    for (const [k, v] of entries) { if (k == null) throw new TypeError('key == null'); this._map.set(String(k), wrap(v)); }
  }
  /** JSONObject.quote(String). */
  static quote(data) { if (data == null) return '""'; const s = new JSONStringer(); s.stack.push(S.NULL); s.value(data); return s.out; }
  static wrap(o) { return wrap(o); }
  static numberToString(n) { if (n == null) throw new JSONException('Number must be non-null'); return numberToString(n); }
  _put(name, value) { if (value == null) { this._map.delete(name); return this; } this._map.set(name, value); return this; }
  length() { return this._map.size; }
  /** put(name, boolean|int|long|double|String|JSONObject|JSONArray|NULL|Object); null removes the mapping. */
  put(name, value) {
    if (value === undefined || value === null) { this._map.delete(name); return this; }
    if (isNumber(value)) checkDouble(unbox(value));
    if (name == null) throw new JSONException('Names must be non-null');
    this._map.set(name, value); return this;
  }
  /** putOpt: no-op when name or value is null. */
  putOpt(name, value) { if (name == null || value == null) return this; return this.put(name, value); }
  accumulate(name, value) {
    const current = this._map.get(name); if (current === undefined) return this.put(name, value);
    if (current instanceof JSONArray) current._values.push(value); else { const a = new JSONArray(); a._values.push(current, value); this._map.set(name, a); }
    return this;
  }
  remove(name) { const v = this._map.get(name); this._map.delete(name); return v === undefined ? null : unbox(v); }
  isNull(name) { const v = this._map.get(name); return v === undefined || v === NULL_OBJ; }
  has(name) { return this._map.has(name); }
  get(name) { const v = this._map.get(name); if (v === undefined) throw new JSONException('No value for ' + name); return unbox(v); }
  opt(name) { const v = this._map.get(name); return v === undefined ? null : unbox(v); }
  _raw(name) { const v = this._map.get(name); if (v === undefined) throw new JSONException('No value for ' + name); return v; }
  getBoolean(name) { const o = this._raw(name), r = toBoolean(o); if (r === null) throw typeMismatch3(name, o, 'boolean'); return r; }
  optBoolean(name, fallback = false) { const r = toBoolean(this._map.get(name)); return r !== null ? r : fallback; }
  getDouble(name) { const o = this._raw(name), r = toDouble(o); if (r === null) throw typeMismatch3(name, o, 'double'); return r; }
  optDouble(name, fallback = NaN) { const r = toDouble(this._map.get(name)); return r !== null ? r : fallback; }
  getInt(name) { const o = this._raw(name), r = toInteger(o); if (r === null) throw typeMismatch3(name, o, 'int'); return r; }
  optInt(name, fallback = 0) { const r = toInteger(this._map.get(name)); return r !== null ? r : fallback; }
  getLong(name) { const o = this._raw(name), r = toLong(o); if (r === null) throw typeMismatch3(name, o, 'long'); return r; }
  optLong(name, fallback = 0) { const r = toLong(this._map.get(name)); return r !== null ? r : fallback; }
  getString(name) { const o = this._raw(name), r = toStr(o); if (r === null) throw typeMismatch3(name, o, 'String'); return r; }
  /** Note (Android): a JSON null value yields "null", not the fallback. */
  optString(name, fallback = '') { const r = toStr(this._map.get(name) ?? null); return r !== null ? r : fallback; }
  getJSONArray(name) { const o = this._raw(name); if (o instanceof JSONArray) return o; throw typeMismatch3(name, o, 'JSONArray'); }
  optJSONArray(name) { const o = this._map.get(name); return o instanceof JSONArray ? o : null; }
  getJSONObject(name) { const o = this._raw(name); if (o instanceof JSONObject) return o; throw typeMismatch3(name, o, 'JSONObject'); }
  optJSONObject(name) { const o = this._map.get(name); return o instanceof JSONObject ? o : null; }
  toJSONArray(names) { const r = new JSONArray(); if (names == null) return null; const n = names.length(); if (n === 0) return null; for (let i = 0; i < n; i++) r.put(this.opt(toStr(names.opt(i)))); return r; }
  /** Java Iterator<String> over the names (hasNext/next, also JS-iterable). */
  keys() { const ks = [...this._map.keys()]; let i = 0; const self = this; return { hasNext: () => i < ks.length, next: () => { if (i >= ks.length) throw new NoSuchElementException(); return ks[i++]; }, remove: () => self._map.delete(ks[i - 1]), [Symbol.iterator]: () => ks.slice(i)[Symbol.iterator]() }; }
  /** keySet() snapshot as a JS Set (insertion order). */
  keySet() { return new Set(this._map.keys()); }
  names() { return this._map.size === 0 ? null : JSONArray._from([...this._map.keys()]); }
  toString(indentSpaces) {
    try { const s = new JSONStringer(indentSpaces); this._writeTo(s); return s.out; } catch (e) { if (indentSpaces !== undefined) throw e; return null; }
  }
  _writeTo(s) { s.object(); for (const [k, v] of this._map) s.key(k).value(v); s.endObject(); }
}

// ------------------------------------------------------------------ JSONArray
export class JSONArray {
  /** new JSONArray() | (String json) | (JSONTokener) | (array / typed array / Set / Java collection). Float32Array elements become Floats. */
  constructor(arg) {
    this._values = [];
    if (arg === undefined) return;
    if (typeof arg === 'string' || arg instanceof JSONTokener) {
      const t = typeof arg === 'string' ? new JSONTokener(arg) : arg;
      const o = t.nextValue();
      if (o instanceof JSONArray) this._values = o._values; else throw typeMismatch2(o, 'JSONArray');
      return;
    }
    if (arg === null) return;
    if (arg instanceof Float32Array) { for (const v of arg) this._values.push(jfloat(v)); return; }
    const items = typeof arg[Symbol.iterator] === 'function' ? arg : typeof arg.toArray === 'function' ? arg.toArray() : null;
    if (items === null) throw new JSONException('Not a primitive array: ' + className(arg));
    for (const v of items) this._values.push(wrap(v));
  }
  static _from(values) { const a = new JSONArray(); a._values = values; return a; }
  length() { return this._values.length; }
  /** put(value) appends; put(index, value) sets (padding with nulls). */
  put(a, b) {
    if (arguments.length >= 2) {
      const index = a, value = b; if (isNumber(value)) checkDouble(unbox(value));
      if (index < 0) throw new JSONException('Index ' + index + ' out of range [0..' + this._values.length + ')');
      while (this._values.length <= index) this._values.push(null);
      this._values[index] = value === undefined ? null : value; return this;
    }
    if (isNumber(a)) checkDouble(unbox(a));
    this._values.push(a === undefined ? null : a); return this;
  }
  isNull(index) { const v = this._optRaw(index); return v == null || v === NULL_OBJ; }
  _optRaw(index) { return index < 0 || index >= this._values.length ? null : this._values[index]; }
  _raw(index) {
    if (index < 0 || index >= this._values.length) throw new JSONException('Index ' + index + ' out of range [0..' + this._values.length + ')');
    const v = this._values[index]; if (v == null) throw new JSONException('Value at ' + index + ' is null.'); return v;
  }
  get(index) { return unbox(this._raw(index)); }
  opt(index) { return unbox(this._optRaw(index)); }
  remove(index) { if (index < 0 || index >= this._values.length) return null; return unbox(this._values.splice(index, 1)[0]); }
  getBoolean(i) { const o = this._raw(i), r = toBoolean(o); if (r === null) throw typeMismatch3(i, o, 'boolean'); return r; }
  optBoolean(i, fallback = false) { const r = toBoolean(this._optRaw(i)); return r !== null ? r : fallback; }
  getDouble(i) { const o = this._raw(i), r = toDouble(o); if (r === null) throw typeMismatch3(i, o, 'double'); return r; }
  optDouble(i, fallback = NaN) { const r = toDouble(this._optRaw(i)); return r !== null ? r : fallback; }
  getInt(i) { const o = this._raw(i), r = toInteger(o); if (r === null) throw typeMismatch3(i, o, 'int'); return r; }
  optInt(i, fallback = 0) { const r = toInteger(this._optRaw(i)); return r !== null ? r : fallback; }
  getLong(i) { const o = this._raw(i), r = toLong(o); if (r === null) throw typeMismatch3(i, o, 'long'); return r; }
  optLong(i, fallback = 0) { const r = toLong(this._optRaw(i)); return r !== null ? r : fallback; }
  getString(i) { const o = this._raw(i), r = toStr(o); if (r === null) throw typeMismatch3(i, o, 'String'); return r; }
  optString(i, fallback = '') { const r = toStr(this._optRaw(i)); return r !== null ? r : fallback; }
  getJSONArray(i) { const o = this._raw(i); if (o instanceof JSONArray) return o; throw typeMismatch3(i, o, 'JSONArray'); }
  optJSONArray(i) { const o = this._optRaw(i); return o instanceof JSONArray ? o : null; }
  getJSONObject(i) { const o = this._raw(i); if (o instanceof JSONObject) return o; throw typeMismatch3(i, o, 'JSONObject'); }
  optJSONObject(i) { const o = this._optRaw(i); return o instanceof JSONObject ? o : null; }
  toJSONObject(names) { const r = new JSONObject(); const n = Math.min(names.length(), this._values.length); if (n === 0) return null; for (let i = 0; i < n; i++) r.put(toStr(names.opt(i)), this.opt(i)); return r; }
  /** join(separator): values JSON-encoded (strings quoted). */
  join(separator) {
    const s = new JSONStringer(); s.stack.push(S.NULL);
    for (let i = 0; i < this._values.length; i++) { if (i > 0) s.out += separator; s.value(this._values[i]); }
    return s.out;
  }
  equals(o) { return o instanceof JSONArray && o._values.length === this._values.length && o._values.every((v, i) => javaEquals(unbox(v), unbox(this._values[i]))); }
  [Symbol.iterator]() { return this._values.map(unbox)[Symbol.iterator](); }
  toString(indentSpaces) {
    try { const s = new JSONStringer(indentSpaces); this._writeTo(s); return s.out; } catch (e) { if (indentSpaces !== undefined) throw e; return null; }
  }
  _writeTo(s) { s.array(); for (const v of this._values) s.value(v); s.endArray(); }
}
