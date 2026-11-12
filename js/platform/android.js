// Android constants used by the ported classes: BuildConfig (versionName/versionCode of APK 4.5), android.os.Build
// and android.os.Process (described from the browser instead of the phone), and android.provider.Settings.
const nav = typeof navigator !== 'undefined' ? navigator : null;

/** vn.lichdilam.BuildConfig of APK 4.5. */
export const BuildConfig = Object.freeze({ APPLICATION_ID: 'vn.lichdilam', VERSION_NAME: '4.5', VERSION_CODE: 42, DEBUG: false });

/** android.os.Build: the web app has no Android release or SDK level; RELEASE is the browser's user agent,
 *  SDK_INT is 0, MANUFACTURER/MODEL describe the browser platform. */
export const Build = Object.freeze({
  VERSION: Object.freeze({ RELEASE: nav?.userAgent ?? '', SDK_INT: 0 }),
  MANUFACTURER: 'web',
  BRAND: 'web',
  MODEL: nav?.userAgentData?.platform ?? nav?.platform ?? '',
});

/** android.os.Process: a web page has no process id. */
export const Process = Object.freeze({ myPid: () => 0 });

/** android.provider.Settings (the URI constants only). */
export const Settings = Object.freeze({
  AUTHORITY: 'settings',
  System: Object.freeze({ DEFAULT_NOTIFICATION_URI: 'content://settings/system/notification_sound' }),
});

/**
 * android.content.Intent subset for the web router: an action, a target screen (the Activity's class name, e.g.
 * "PipeTableActivity", since screens are addressed by name), extras and optional data. new Intent(action) |
 * new Intent(context, screenName) | new Intent().
 */
export class Intent {
  static ACTION_MAIN = 'android.intent.action.MAIN';
  static FLAG_GRANT_READ_URI_PERMISSION = 1; static FLAG_GRANT_WRITE_URI_PERMISSION = 2;
  constructor(a, b) {
    this._action = null; this._component = null; this._extras = new Map(); this._data = null; this._clipData = null;
    if (b !== undefined) this._component = typeof b === 'string' ? b : b?.name ?? null;
    else if (typeof a === 'string') this._action = a;
  }
  getAction() { return this._action; }
  setAction(action) { this._action = action; return this; }
  /** The target screen name, or null. */
  getComponent() { return this._component; }
  /** setComponent / setClassName: the target screen name. */
  setComponent(name) { this._component = name; return this; }
  getData() { return this._data; }
  setData(data) { this._data = data; return this; }
  getClipData() { return this._clipData; }
  setClipData(clip) { this._clipData = clip; return this; }
  putExtra(name, value) { this._extras.set(name, value); return this; }
  hasExtra(name) { return this._extras.has(name); }
  getStringExtra(name) { const v = this._extras.get(name); return typeof v === 'string' ? v : null; }
  getBooleanExtra(name, defaultValue) { const v = this._extras.get(name); return typeof v === 'boolean' ? v : defaultValue; }
  getIntExtra(name, defaultValue) { const v = this._extras.get(name); return typeof v === 'number' ? v : defaultValue; }
  /** Intent.toUri(0): "#Intent;action=…;component=vn.lichdilam/.Screen;S.key=value;B.key=true;end". */
  toUri(flags) { // eslint-disable-line no-unused-vars
    const enc = s => encodeURIComponent(String(s)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    let uri = (this._data == null ? '' : String(this._data)) + '#Intent;';
    if (this._action != null) uri += 'action=' + enc(this._action) + ';';
    if (this._component != null) uri += 'component=' + BuildConfig.APPLICATION_ID + '/.' + this._component + ';';
    for (const [k, v] of this._extras) uri += (typeof v === 'string' ? 'S.' : typeof v === 'boolean' ? 'B.' : Number.isInteger(v) ? 'i.' : 'd.') + enc(k) + '=' + enc(v) + ';';
    return uri + 'end';
  }
}

/**
 * android.os.Bundle: string keys to strings, numbers, booleans, null, arrays of those, and nested Bundles.
 * Screens write their state into it in onSaveInstanceState(bundle) and read it back on restore.
 */
export class Bundle {
  constructor() { this._map = new Map(); }
  _put(key, value) { this._map.set(key, value); }
  putString(key, value) { this._put(key, value); }
  getString(key, defaultValue = null) { const v = this._map.get(key); return typeof v === 'string' ? v : defaultValue; }
  putInt(key, value) { this._put(key, value | 0); }
  getInt(key, defaultValue = 0) { const v = this._map.get(key); return typeof v === 'number' ? v : defaultValue; }
  putLong(key, value) { this._put(key, Math.trunc(value)); }
  getLong(key, defaultValue = 0) { const v = this._map.get(key); return typeof v === 'number' ? v : defaultValue; }
  putBoolean(key, value) { this._put(key, !!value); }
  getBoolean(key, defaultValue = false) { const v = this._map.get(key); return typeof v === 'boolean' ? v : defaultValue; }
  putStringArrayList(key, value) { this._put(key, value == null ? null : [...value]); }
  getStringArrayList(key) { const v = this._map.get(key); return Array.isArray(v) ? v : null; }
  putIntArray(key, value) { this._put(key, value == null ? null : Array.from(value, x => x | 0)); }
  getIntArray(key) { const v = this._map.get(key); return Array.isArray(v) ? v : null; }
  putBooleanArray(key, value) { this._put(key, value == null ? null : Array.from(value, x => !!x)); }
  getBooleanArray(key) { const v = this._map.get(key); return Array.isArray(v) ? v : null; }
  putStringArray(key, value) { this._put(key, value == null ? null : [...value]); }
  getStringArray(key) { const v = this._map.get(key); return Array.isArray(v) ? v : null; }
  putBundle(key, value) { this._put(key, value); }
  getBundle(key) { const v = this._map.get(key); return v instanceof Bundle ? v : null; }
  containsKey(key) { return this._map.has(key); }
  remove(key) { this._map.delete(key); }
  keySet() { return new Set(this._map.keys()); }
  size() { return this._map.size; }
  isEmpty() { return this._map.size === 0; }
  _toJson() { const o = {}; for (const [k, v] of this._map) o[k] = v instanceof Bundle ? { $bundle: v._toJson() } : v; return o; }
  static _fromJson(o) { const b = new Bundle(); for (const [k, v] of Object.entries(o)) b._map.set(k, v != null && typeof v === 'object' && !Array.isArray(v) && '$bundle' in v ? Bundle._fromJson(v.$bundle) : v); return b; }
}
/** android.os.Parcel, only for flattening a Bundle to bytes and back (UTF-8 JSON on the web). */
export class Parcel {
  static obtain() { return new Parcel(); }
  constructor() { this._bytes = new Uint8Array(0); }
  writeBundle(bundle) { this._bytes = new TextEncoder().encode(JSON.stringify(bundle._toJson())); }
  marshall() { return this._bytes.slice(); }
  unmarshall(bytes, offset, length) { this._bytes = bytes.slice(offset, offset + length); }
  setDataPosition() {}
  /** Throws a RuntimeException-like Error for bytes that are not a flattened Bundle. */
  readBundle() { const o = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this._bytes)); if (o == null || typeof o !== 'object' || Array.isArray(o)) throw new TypeError('Bad bundle'); return Bundle._fromJson(o); }
  recycle() { this._bytes = new Uint8Array(0); }
}

/** android.content.ClipData subset: the URIs of a multiple pick (ACTION_OPEN_DOCUMENT + EXTRA_ALLOW_MULTIPLE). */
export class ClipData {
  constructor(uris) { this._uris = [...uris]; Object.freeze(this); }
  /** ClipData of several URIs (the web picker's files). */
  static ofUris(uris) { return new ClipData(uris); }
  getItemCount() { return this._uris.length; }
  getItemAt(i) { const uri = this._uris[i]; return Object.freeze({ getUri: () => uri }); }
}
/**
 * android.net.Uri subset. Uri.fromFile(file) names a file of the app's virtual storage (toString "file://<path>",
 * like Android); Uri.fromBlob(blob) names an image the user picked (a File/Blob of <input type=file>), whose
 * toString is "content://picked/<file name>" (the web has no document provider URI). Both are opened by
 * Context.getContentResolver().openInputStream(uri).
 */
export class Uri {
  constructor(scheme, file, blob) { this._scheme = scheme; this._file = file; this._blob = blob; Object.freeze(this); }
  static fromFile(file) { if (file == null) throw new TypeError('file'); return new Uri('file', file, null); }
  static fromBlob(blob) { if (blob == null) throw new TypeError('blob'); return new Uri('content', null, blob); }
  getScheme() { return this._scheme; }
  getPath() { return this._file != null ? this._file.getAbsolutePath() : '/' + (this._blob.name ?? ''); }
  toString() { return this._file != null ? 'file://' + encodeURI(this._file.getAbsolutePath()) : 'content://picked/' + encodeURIComponent(this._blob.name ?? ''); }
  equals(o) { return o instanceof Uri && (this._file != null ? o._file != null && this._file.getAbsolutePath() === o._file.getAbsolutePath() : this._blob === o._blob); }
}
