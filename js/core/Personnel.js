// Port of vn.lichdilam.Personnel (APK 4.5).
// Lists are JS arrays (unmodifiable lists are frozen). Personnel.load is async because the bundled asset is
// fetched; ensureLoaded (called by ScheduleStore) stays synchronous and uses the asset text kept by the last
// load() — the web app awaits Personnel.load(context) once at start-up before any screen opens a ScheduleStore.
import { IllegalStateException, IndexOutOfBoundsException, trim, split } from '../platform/java.js';
import { JSONObject, JSONArray } from '../platform/json.js';
import { ByteArrayOutputStream } from '../platform/files.js';
import { Schedule } from './Schedule.js';
import { StaffCorrections } from './StaffCorrections.js';

class Person {
  constructor(workStt, name, aliases) { this.workStt = workStt; this.name = StaffCorrections.name(name); this.aliases = Object.freeze([...aliases]); Object.freeze(this); }
  forms() { const f = []; f.push(this.name); f.push(...this.aliases); return f; }
  toString() { return (this.workStt > 0 ? 'STT ' + this.workStt + ' · ' : '') + this.name; }
}
/** TYPED: accents written by the user are meant (Tuyền is not Tuyến). PRINTED: OCR accents are unreliable,
 *  so they only separate people whose names are otherwise identical. */
class SourceValue {
  constructor(name, ordinal) { this._name = name; this._ordinal = ordinal; Object.freeze(this); }
  name() { return this._name; }
  ordinal() { return this._ordinal; }
  toString() { return this._name; }
}
const TYPED = new SourceValue('TYPED', 0), PRINTED = new SourceValue('PRINTED', 1);
const Source = Object.freeze({ TYPED, PRINTED, values: () => [TYPED, PRINTED], valueOf: n => ({ TYPED, PRINTED })[n] });

/** LinkedHashMap(256,.75f,true) with removeEldestEntry(size() > size): least-recently-used memo. */
class Memo {
  constructor(size) { this.size = size; this.map = new Map(); }
  get(k) { if (!this.map.has(k)) return null; const v = this.map.get(k); this.map.delete(k); this.map.set(k, v); return v; }
  put(k, v) { this.map.delete(k); this.map.set(k, v); if (this.map.size > this.size) this.map.delete(this.map.keys().next().value); }
}
/** 3.0: names are compared hundreds of times while a sheet is imported; the pure text steps are remembered
 *  (an ANR on the emulator came from repeating them on the main thread). */
const memo = size => new Memo(size);
const FOLDED = memo(8192);
const WORDS = memo(4096);

// ---- A=B=C=D ----
const GLUED = /^(\p{Lu}{2,3})(\p{Lu}\p{Ll}+)?$/u;
const TONES = String.fromCharCode(0x300, 0x301, 0x303, 0x309, 0x323);
const SEP = String.fromCharCode(0);
const isLetterOrMark = c => /[\p{L}\p{M}]/u.test(c);
/** String.codePointBefore(index). */
const codePointBefore = (s, i) => { const lo = s.charCodeAt(i - 1); if (lo >= 0xDC00 && lo <= 0xDFFF && i >= 2) { const hi = s.charCodeAt(i - 2); if (hi >= 0xD800 && hi <= 0xDBFF) return s.codePointAt(i - 2); } return lo; };

const ASSET = 'personnel-3.0.json', PREFS = 'personnel', KEY_LIST = 'list', KEY_BUNDLE = 'bundleVersion';
let current = null;
/** Text of the bundled asset as read by the last load(); null = not read (or missing). */
let bundledText = null;

/** The staff list confirmed by the user (full names) and every printed form that belongs to each person.
 *  Displayed names come only from this list: OCR text selects a person, it never writes a name.
 *  A=B=C=D: a typed name, the name printed on the work roster, on a pipe photo and the OCR reading of
 *  either resolve to the same person, or to nobody / several people, and then the user is asked. */
export class Personnel {
  static Person = Person;
  static Source = Source;
  static ASSET = ASSET; static PREFS = PREFS; static KEY_LIST = KEY_LIST; static KEY_BUNDLE = KEY_BUNDLE;
  constructor(people) {
    this.people = Object.freeze([...people]);
    /** Every person a name can mean, in the order of the strongest rule that matched. Empty = nobody. */
    this._resolved = memo(2048);
  }
  static current() { return current; }
  static install(personnel) { current = personnel == null ? new Personnel([]) : personnel; }
  isEmpty() { return this.people.length === 0; }
  /** Every screen, the widget and reminders reach saved schedules through ScheduleStore, which calls this first. */
  static ensureLoaded(context) { if (current.isEmpty()) Personnel._loadWith(context.getApplicationContext() == null ? context : context.getApplicationContext(), bundledText); return context; }

  /** Loads the list saved on this phone; the bundled list seeds it once per bundle version and never
   *  overwrites a list the user edited later. */
  static async load(context) {
    let json = null;
    try { const input = await context.getAssets().open(ASSET); json = Personnel._read(input); } catch (missing) { json = null; /* no bundled list */ }
    bundledText = json;
    return Personnel._loadWith(context, json);
  }
  /** The synchronous part of load(context): `asset` is the bundled file's text, or null when it is missing. */
  static _loadWith(context, asset) {
    const prefs = context.getSharedPreferences(PREFS, 0); let bundled = null; let version = 0;
    try { if (asset == null) throw new Error('missing'); bundled = Personnel.fromJson(asset); version = new JSONObject(asset).optInt('version', 0); } catch (missing) { /* no bundled list */ }
    const saved = prefs.getString(KEY_LIST, null); let result = null;
    if (saved != null) try { result = Personnel.fromJson(saved); } catch (damaged) { result = null; }
    if (bundled != null && (result == null || prefs.getInt(KEY_BUNDLE, 0) < version)) {
      result = result == null ? bundled : result.mergeBundled(bundled);
      prefs.edit().putString(KEY_LIST, result.toJson()).putInt(KEY_BUNDLE, version).apply();
    }
    if (!StaffCorrections.migrate(context.getSharedPreferences('schedules', 0))) throw new IllegalStateException('Không lưu được đính chính họ tên.');
    Personnel.install(result); return current;
  }
  /** Keeps the user's edits and confirmed aliases; adds people and printed forms that are new in the bundle. */
  mergeBundled(bundled) {
    const merged = [...this.people];
    for (const b of bundled.people) { let mine = null; for (const p of merged) if (Personnel.fold(p.name) === Personnel.fold(b.name)) { mine = p; break; }
      if (mine == null) { merged.push(b); continue; }
      const aliases = [...mine.aliases]; for (const a of b.aliases) if (!aliases.includes(a)) aliases.push(a);
      merged[merged.indexOf(mine)] = new Person(mine.workStt > 0 ? mine.workStt : b.workStt, mine.name, aliases);
    }
    return new Personnel(merged);
  }
  save(context) { context.getSharedPreferences(PREFS, 0).edit().putString(KEY_LIST, this.toJson()).apply(); Personnel.install(this); }
  /** A printed form confirmed by the user for one person (never for two). */
  withAlias(person, printed) {
    const form = Schedule.normalizePerson(printed); if (form === '' || Personnel.fold(form) === Personnel.fold(person.name)) return this;
    const list = [];
    for (const p of this.people) { const aliases = []; for (const a of p.aliases) if (Personnel._key(a) !== Personnel._key(form)) aliases.push(a);
      if (p === person || p.name === person.name) aliases.push(form); list.push(new Person(p.workStt, p.name, aliases)); }
    return new Personnel(list);
  }
  withPeople(list) { return new Personnel(list); }
  static person(stt, name, aliases) { return new Person(stt, name, aliases); }

  static fromJson(json) {
    const a = new JSONObject(json).getJSONArray('people'); const list = [];
    for (let i = 0; i < a.length(); i++) { const p = a.getJSONObject(i); const aliases = []; const al = p.optJSONArray('aliases');
      if (al != null) for (let j = 0; j < al.length(); j++) aliases.push(al.getString(j));
      const name = StaffCorrections.name(p.getString('name')); if (name !== '') {
        let existing = null; for (const known of list) if (Personnel.fold(known.name) === Personnel.fold(name)) { existing = known; break; }
        if (existing == null) list.push(new Person(p.optInt('workStt', 0), name, aliases));
        else { const merged = [...existing.aliases]; for (const alias of aliases) if (!merged.includes(alias)) merged.push(alias); list[list.indexOf(existing)] = new Person(existing.workStt > 0 ? existing.workStt : p.optInt('workStt', 0), existing.name, merged); }
      } }
    return new Personnel(list);
  }
  toJson() {
    const a = new JSONArray(); for (const p of this.people) { const al = new JSONArray(); for (const s of p.aliases) al.put(s); a.put(new JSONObject().put('workStt', p.workStt).put('name', p.name).put('aliases', al)); }
    return new JSONObject().put('version', 1).put('people', a).toString();
  }
  static _read(input) { const out = new ByteArrayOutputStream(); const b = new Uint8Array(8192); let n; while ((n = input.read(b)) > 0) out.write(b, 0, n); return new TextDecoder('utf-8').decode(out.toByteArray()); }

  /** Letters only, lower case, no accents; đ → d. */
  static fold(s) {
    const k = s == null ? '' : s; const cached = FOLDED.get(k); if (cached != null) return cached;
    const f = trim(k.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z ]/g, '')).replace(/ +/g, ' '); FOLDED.put(k, f); return f;
  }
  static _vowel(c) { return 'aeiouy'.indexOf(c) >= 0; }
  /** Words of a printed or typed name. "Đ.S." → Đ S, "LM" → L M, "NHMinh" → N H Minh; "NG" stays Nguyễn. */
  static words(raw) {
    const key = raw == null ? '' : raw; const cached = WORDS.get(key); if (cached != null) return cached;
    const result = Object.freeze(Personnel._splitWords(key)); WORDS.put(key, result); return result;
  }
  static _splitWords(raw) {
    const s = trim(raw.normalize('NFC').replace(/[.,;:_|/\\()[\]"“”'’*+-]+/g, ' ')); const out = [];
    if (s === '') return out;
    for (const w of split(s, /[ \t\n\x0B\f\r]+/)) {
      const m = GLUED.exec(w); const initials = m != null ? m[1] : null; const glued = m != null && m[2] !== undefined ? m[2] : null;
      // Standalone Tr/Kh are printed word prefixes even in an all-capitals name. Splitting TR into
      // T R would change "NG TR TUYẾN" into four words. Explicit T.R. stays two words, and grouped
      // initials (NHMinh, LM, KM, ĐM, PH Linh) keep their existing splitting rule. Mixed-case Ph
      // remains a word prefix as before; uppercase PH can be the genuine initials Phạm Hoàng.
      const prefix = initials == null ? '' : Personnel.fold(initials); const wordPrefix = initials != null && glued == null && (prefix === 'tr' || prefix === 'kh');
      if (initials != null && !prefix.startsWith('ng') && !wordPrefix) { let consonants = true; for (let i = 0; i < prefix.length; i++) if (Personnel._vowel(prefix.charAt(i))) consonants = false;
        if (consonants) { for (let i = 0; i < initials.length; i++) out.push(initials.charAt(i)); if (glued != null) out.push(glued); continue; } }
      if (Personnel.fold(w) !== '') out.push(w);
    }
    return out;
  }
  /** Base letters with their vowel-quality marks, and the tone, ignoring where the tone was typed (Qúy = Quý). */
  static marks(word) {
    let base = ''; let tone = '';
    const d = word.toLowerCase().normalize('NFD');
    for (let i = 0; i < d.length; i++) { const c = d.charAt(i); if (TONES.indexOf(c) >= 0) tone = c; else base += c; }
    return base.normalize('NFC') + '|' + tone;
  }
  static _marked(word) { return Personnel.marks(word) !== Personnel.fold(word) + '|'; }
  static _key(name) { let k = ''; for (const w of Personnel.words(name)) { if (k.length > 0) k += ' '; k += Personnel.fold(w); } return k; }
  static _initialOf(shortWord, full, first) {
    const a = Personnel.fold(shortWord), b = Personnel.fold(full);
    if (first && (a === 'ng' || a === 'n') && b === 'nguyen') return true;
    return a.length >= 1 && a.length <= 3 && a.length < b.length && b.startsWith(a);
  }
  /** Word i of raw aligned with word j of the form: 0 = no, 1 = initial, 2 = same word. */
  static _fit(raw, i, form, j) { const a = Personnel.fold(raw[i]), b = Personnel.fold(form[j]); if (a === b) return 2; return Personnel._initialOf(raw[i], form[j], i === 0 && j === 0) ? 1 : 0; }
  /** Same words, words replaced by their initials (never the last word), or the last ≥ 2 words of the form. */
  static compatible(raw, form) {
    if (raw.length === 0 || form.length === 0) return false;
    if (raw.length === form.length) { for (let i = 0; i < raw.length; i++) { const f = Personnel._fit(raw, i, form, i); if (f === 0 || f === 1 && i === raw.length - 1) return false; } return true; }
    if (raw.length >= 2 && raw.length < form.length) { const o = form.length - raw.length; for (let i = 0; i < raw.length; i++) if (Personnel._fit(raw, i, form, o + i) !== 2) return false; return true; }
    return false;
  }
  /** Typed accents that contradict the person's own accents (Tuyền typed for Tuyến). A word typed without a
   *  tone (Tuyen, Trân) does not contradict a toned word; a typed tone or vowel mark must be the person's. */
  static conflicts(raw, form) {
    const o = raw.length < form.length ? form.length - raw.length : 0; if (raw.length > form.length) return true;
    for (let i = 0; i < raw.length; i++) { const a = raw[i], b = form[raw.length === form.length ? i : o + i]; if (Personnel.fold(a) !== Personnel.fold(b) || !Personnel._marked(a)) continue;
      const x = split(Personnel.marks(a), /\|/, -1), y = split(Personnel.marks(b), /\|/, -1);
      if (x[1] !== '' && x[1] !== y[1]) return true;
      if (x[0] !== Personnel.fold(a) && x[0] !== y[0]) return true; }
    return false;
  }
  static _exact(raw, form) { if (raw.length !== form.length) return false; for (let i = 0; i < raw.length; i++) if (Personnel.marks(raw[i]) !== Personnel.marks(form[i])) return false; return true; }
  static _markScore(raw, form) { let s = 0; const o = raw.length < form.length ? form.length - raw.length : 0; for (let i = 0; i < raw.length && o + i < form.length; i++) { const a = raw[i], b = form[raw.length === form.length ? i : o + i]; if (Personnel._marked(a) && Personnel.marks(a) === Personnel.marks(b)) s++; } return s; }

  resolve(raw, source) {
    const key = source + SEP + (raw == null ? '' : raw); const cached = this._resolved.get(key); if (cached != null) return [...cached];
    const result = this._resolveOnce(raw, source); this._resolved.put(key, [...result]); return result;
  }
  _resolveOnce(raw, source) {
    raw = StaffCorrections.name(raw);
    const result = this._resolveWords(raw, source, Personnel.words(raw));
    // Standalone PH can be two initials (Phạm Hoàng Linh -> PH Linh) or a word prefix
    // (Nguyễn Phú Đạt -> NGUYỄN PH ĐẠT). Both exact structural interpretations contribute
    // candidates; neither is preferred when they refer to different people. Passing the
    // alternate text as well as its words keeps exact-form and accent checks consistent.
    const prefixed = Personnel._standalonePh(raw);
    if (prefixed !== raw) for (const p of this._resolveWords(prefixed, source, Personnel.words(prefixed))) if (!result.includes(p)) result.push(p);
    return result;
  }
  /** raw.replaceAll("(?<![\\p{L}\\p{M}])PH(?![\\p{L}\\p{M}])","Ph") without lookbehind (Safari 15). */
  static _standalonePh(raw) {
    let out = '', from = 0;
    for (let i = raw.indexOf('PH'); i >= 0; i = raw.indexOf('PH', i + 1)) {
      const before = i > 0 ? String.fromCodePoint(codePointBefore(raw, i)) : '';
      const after = i + 2 < raw.length ? String.fromCodePoint(raw.codePointAt(i + 2)) : '';
      if ((before !== '' && isLetterOrMark(before)) || (after !== '' && isLetterOrMark(after))) continue;
      out += raw.substring(from, i) + 'Ph'; from = i + 2;
    }
    return from === 0 ? raw : out + raw.substring(from);
  }
  _resolveWords(raw, source, rw) {
    let result = []; if (rw.length === 0) return result;
    // 1. A known form with the same letters and accents.
    for (const p of this.people) for (const f of p.forms()) if (Personnel._exact(rw, Personnel.words(f)) && !result.includes(p)) result.push(p);
    if (result.length !== 0) return result;
    // 2. A known form with the same letters; typed accents must agree.
    for (const p of this.people) for (const f of p.forms()) if (Personnel._key(raw) === Personnel._key(f) && !(source === Source.TYPED && Personnel.conflicts(rw, Personnel.words(f))) && !result.includes(p)) result.push(p);
    if (result.length === 0) {
      // 3. Initials by position or the last ≥ 2 words ("Ng H T Phương", "Minh Huy").
      for (const p of this.people) for (const f of p.forms()) { const fw = Personnel.words(f); if (Personnel.compatible(rw, fw) && !(source === Source.TYPED && Personnel.conflicts(rw, fw)) && !result.includes(p)) result.push(p); }
    }
    if (result.length === 0 && rw.length === 1 && source === Source.TYPED) {
      // 4. A typed given name alone ("Tuyền"): every person with that given name.
      for (const p of this.people) { const fw = Personnel.words(p.name); if (fw.length === 0) throw new IndexOutOfBoundsException('fromIndex = -1'); const last = fw.slice(fw.length - 1); if (Personnel.fold(rw[0]) === Personnel.fold(last[0]) && !Personnel.conflicts(rw, last)) result.push(p); }
    }
    if (result.length > 1 && source === Source.PRINTED) {
      // OCR accents may only separate people whose letters are identical: keep the best accent agreement if it is unique.
      let best = -1; let top = [];
      for (const p of result) { let s = 0; for (const f of p.forms()) s = Math.max(s, Personnel._markScore(rw, Personnel.words(f))); if (s > best) { best = s; top = []; } if (s === best) top.push(p); }
      if (best > 0 && top.length === 1) return top;
    }
    return result;
  }
  static edits(a, b) {
    let prev = new Int32Array(b.length + 1), cur = new Int32Array(b.length + 1); for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) { cur[0] = i; for (let j = 1; j <= b.length; j++) cur[j] = Math.min(Math.min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1)); const t = prev; prev = cur; cur = t; }
    return prev[b.length];
  }
  /** Letters wrong in a printed name read word by word against a form of the same length: initials must fit
   *  as in compatible(), every full word may be one letter off. 99 = not this form. */
  static distance(raw, form) {
    if (raw.length < 2 || raw.length !== form.length) return 99; let total = 0;
    for (let i = 0; i < raw.length; i++) { const a = Personnel.fold(raw[i]), b = Personnel.fold(form[i]); if (a === b) continue;
      if (a.length <= 3 || b.length <= 3) { if (i < raw.length - 1 && Personnel._fit(raw, i, form, i) > 0) continue; return 99; }
      const d = Personnel.edits(a, b); if (d > 1) return 99; total += d; }
    return total;
  }
  /** An OCR name with misread letters ("Mai Đ Nguvên"): the one person it is closest to, only when nobody else is
   *  as close. A weak sign for the user to confirm, never a name to display or a confirmed identity. */
  closest(raw) {
    const rw = Personnel.words(raw); let best = 99, second = 99; let found = null;
    for (const p of this.people) { let d = 99; for (const f of p.forms()) d = Math.min(d, Personnel.distance(rw, Personnel.words(f)));
      if (d < best) { second = best; best = d; found = p; } else if (d < second) second = d; }
    return best <= 2 && second > best ? found : null;
  }
  /** The single person a name means, or null when it means nobody or several people. */
  unique(raw, source) { const r = this.resolve(raw, source); return r.length === 1 ? r[0] : null; }
  byStt(stt) { let found = null; for (const p of this.people) if (p.workStt === stt) { if (found != null) return null; found = p; } return found; }
  /** The confirmed full name for a printed or stored name, else the name itself. */
  display(raw) { const p = this.unique(raw, Source.PRINTED); return p == null ? Schedule.normalizePerson(raw) : p.name; }
  /** Same person under A=B=C=D, or null when the list cannot decide (then the caller keeps its own rule). */
  samePerson(a, b) {
    if (this.people.length === 0) return null; const pa = this.unique(a, Source.PRINTED), pb = this.unique(b, Source.PRINTED);
    if (pa != null && pb != null) return pa === pb;
    return null;
  }
}
current = new Personnel([]);
