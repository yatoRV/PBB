// android.content.SharedPreferences emulation. All preference files live in one in-memory store that can be
// exported/imported as JSON (autosave to Drive happens elsewhere through onPrefsChange).
// Mirrors SharedPreferencesImpl: typed values (ClassCastException on type mismatch), getAll() returns a HashMap
// copy (Java iteration order), getStringSet values are HashSets, editor applies clear() first then the edits,
// listeners get the changed keys (last modification first) and only for keys whose value really changed.
import { JavaHashMap, JavaHashSet, ClassCastException, NullPointerException, javaEquals, System } from './java.js';

const files = new Map(); // name -> SharedPreferences
const changeListeners = new Set();
const modified = new Map(); // name -> ms of the last committed change
const TYPE_NAMES = { s: 'java.lang.String', i: 'java.lang.Integer', l: 'java.lang.Long', f: 'java.lang.Float', b: 'java.lang.Boolean', set: 'java.util.HashSet' };

/** Typed value as stored: { t: 's'|'i'|'l'|'f'|'b'|'set', v }. */
const tv = (t, v) => ({ t, v });
function sameValue(a, b) { if (!a || !b || a.t !== b.t) return false; return a.t === 'set' ? a.v.equals(b.v) : javaEquals(a.v, b.v); }

export class SharedPreferences {
  constructor(name) { this.name = name; this._map = new JavaHashMap(); this._listeners = []; }
  _typed(key, t, def) {
    const e = this._map.get(key);
    if (e == null) return def;
    if (e.t !== t) throw new ClassCastException(TYPE_NAMES[e.t] + ' cannot be cast to ' + TYPE_NAMES[t]);
    return e.v;
  }
  getString(key, defValue = null) { return this._typed(key, 's', defValue); }
  getInt(key, defValue = 0) { return this._typed(key, 'i', defValue); }
  getLong(key, defValue = 0) { return this._typed(key, 'l', defValue); }
  getFloat(key, defValue = 0) { return this._typed(key, 'f', defValue); }
  getBoolean(key, defValue = false) { return this._typed(key, 'b', defValue); }
  /** Returns the stored HashSet itself (as Android does; do not modify it). */
  getStringSet(key, defValues = null) { return this._typed(key, 'set', defValues); }
  contains(key) { return this._map.containsKey(key); }
  /** new HashMap<>(mMap): String -> String/Integer/Long/Float/Boolean/Set<String>. */
  getAll() { return new JavaHashMap(new Map([...this._map].map(([k, e]) => [k, e.v]))); }
  edit() { return new Editor(this); }
  registerOnSharedPreferenceChangeListener(l) { if (!this._listeners.includes(l)) this._listeners.push(l); }
  unregisterOnSharedPreferenceChangeListener(l) { const i = this._listeners.indexOf(l); if (i >= 0) this._listeners.splice(i, 1); }
}

export class Editor {
  constructor(prefs) { this._prefs = prefs; this._modified = new JavaHashMap(); this._clear = false; }
  putString(key, value) { this._modified.put(key, value == null ? REMOVE : tv('s', String(value))); return this; }
  putInt(key, value) { this._modified.put(key, tv('i', value | 0)); return this; }
  putLong(key, value) { this._modified.put(key, tv('l', Math.trunc(value))); return this; }
  putFloat(key, value) { this._modified.put(key, tv('f', Math.fround(value))); return this; }
  putBoolean(key, value) { this._modified.put(key, tv('b', !!value)); return this; }
  putStringSet(key, values) {
    if (values == null) { this._modified.put(key, REMOVE); return this; }
    const set = new JavaHashSet(values); for (const s of set) if (s != null && typeof s !== 'string') throw new ClassCastException('Set values must be Strings');
    this._modified.put(key, tv('set', set)); return this;
  }
  remove(key) { this._modified.put(key, REMOVE); return this; }
  clear() { this._clear = true; return this; }
  /** Applies synchronously; returns true (in-memory store cannot fail). */
  commit() {
    const p = this._prefs, map = p._map; const keysModified = []; const cleared = this._clear; let changesMade = false;
    if (this._clear) { if (!map.isEmpty()) { changesMade = true; map.clear(); } this._clear = false; }
    for (const [k, v] of this._modified) {
      if (k == null) throw new NullPointerException('key == null');
      if (v === REMOVE) { if (!map.containsKey(k)) continue; map.remove(k); }
      else { if (map.containsKey(k) && sameValue(map.get(k), v)) continue; map.put(k, v); }
      changesMade = true; keysModified.push(k);
    }
    this._modified.clear();
    if (cleared || keysModified.length) { // API 30+: clear() reports a null key first
      if (cleared) for (const l of [...p._listeners]) l(p, null);
      for (let i = keysModified.length - 1; i >= 0; i--) for (const l of [...p._listeners]) l(p, keysModified[i]);
    }
    if (changesMade) modified.set(p.name, System.currentTimeMillis());
    if (changesMade) for (const l of changeListeners) l({ name: p.name, keys: keysModified, cleared });
    return true;
  }
  apply() { this.commit(); }
}
const REMOVE = Object.freeze({ remove: true });

/** Context.getSharedPreferences(name, mode): one instance per name. */
export function getSharedPreferences(name, mode = 0) { // eslint-disable-line no-unused-vars
  let p = files.get(name); if (!p) { p = new SharedPreferences(name); files.set(name, p); } return p;
}
/** Names of all preference files that exist. */
export function prefsNames() { return [...files.keys()]; }
/** Time of the last committed change of a preference file (0 if unknown), for the virtual shared_prefs files. */
export function prefsLastModified(name) { return modified.get(name) ?? 0; }
/** Deletes a preference file (Context.deleteSharedPreferences). */
export function deleteSharedPreferences(name) {
  const p = files.get(name); if (!p) return true;
  p._map.clear(); files.delete(name);
  for (const l of changeListeners) l({ name, keys: [], cleared: true, deleted: true });
  return true;
}
/** Listener for any committed change: fn({name, keys, cleared}). Returns an unsubscribe function. */
export function onPrefsChange(fn) { changeListeners.add(fn); return () => changeListeners.delete(fn); }

/** Plain JSON-able snapshot: { name: [[key, type, value], …] } in each file's HashMap order (like the XML file). */
export function exportState() {
  const out = {};
  for (const [name, p] of files) out[name] = [...p._map].map(([k, e]) => [k, e.t, e.t === 'set' ? e.v.toArray() : e.v]);
  return out;
}
/** Replaces the whole store (as on a fresh process start: each file reloaded into a new HashMap in file order). */
export function importState(state) {
  const live = new Map(files); files.clear();
  for (const [name, entries] of Object.entries(state ?? {})) {
    const p = live.get(name) ?? new SharedPreferences(name); p._map = new JavaHashMap();
    for (const [k, t, v] of entries) {
      if (!(t in TYPE_NAMES)) throw new TypeError('bad preference type ' + t + ' for ' + name + '/' + k);
      p._map.put(k, t === 'set' ? tv('set', new JavaHashSet(v)) : tv(t, v));
    }
    files.set(name, p);
  }
  for (const [name, p] of live) if (!files.has(name)) { p._map = new JavaHashMap(); files.set(name, p); }
  for (const l of changeListeners) l({ name: null, keys: [], cleared: false, imported: true });
}
