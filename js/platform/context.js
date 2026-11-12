// android.content.Context subset used by the ported classes: one application context whose preferences live in
// prefs.js and whose assets come from assets.js. getAssets().open(name) is async (resolves to an InputStream),
// so code that reads an asset awaits it; everything else stays synchronous.
// The web app has no SQLite databases, no external storage and no persisted document-URI grants: databaseList(),
// getExternalFilesDirs() / getExternalCacheDirs() and getPersistedUriPermissions() are empty.
import { getSharedPreferences, deleteSharedPreferences } from './prefs.js';
import { openAssetStream } from './assets.js';
import { DATA_DIR, getFilesDir, getCacheDir, getDataDir, getCodeCacheDir, getNoBackupFilesDir, getDatabasePath, ByteArrayInputStream, FileInputStream } from './files.js';
import { BuildConfig, Uri } from './android.js';

const ASSETS = Object.freeze({ open: path => openAssetStream(path) });
const APPLICATION_INFO = Object.freeze({ dataDir: DATA_DIR, packageName: BuildConfig.APPLICATION_ID });
/**
 * ContentResolver. openInputStream(uri) is async: a web "uri" is what the page was given by the user (a File/Blob
 * from <input type=file> or drag-and-drop, or a Uri of android.js) or raw bytes; it resolves to an InputStream
 * (FileNotFoundException for a missing file), or null for anything else.
 */
const CONTENT_RESOLVER = Object.freeze({
  async openInputStream(uri) {
    if (uri == null) return null;
    if (uri instanceof Uint8Array) return new ByteArrayInputStream(uri);
    if (uri instanceof Uri) { if (uri._file != null) return new FileInputStream(uri._file); uri = uri._blob; }
    if (typeof uri.arrayBuffer === 'function') return new ByteArrayInputStream(new Uint8Array(await uri.arrayBuffer()));
    return null;
  },
  getPersistedUriPermissions: () => [],
  releasePersistableUriPermission() {},
});

export class Context {
  static MODE_PRIVATE = 0;
  getApplicationContext() { return this; }
  getApplicationInfo() { return APPLICATION_INFO; }
  getPackageName() { return BuildConfig.APPLICATION_ID; }
  getSharedPreferences(name, mode = 0) { return getSharedPreferences(name, mode); }
  deleteSharedPreferences(name) { return deleteSharedPreferences(name); }
  /** AssetManager: open(name) returns a Promise of an InputStream (rejects with FileNotFoundException). */
  getAssets() { return ASSETS; }
  getContentResolver() { return CONTENT_RESOLVER; }
  getFilesDir() { return getFilesDir(); }
  getCacheDir() { return getCacheDir(); }
  getCodeCacheDir() { return getCodeCacheDir(); }
  getNoBackupFilesDir() { return getNoBackupFilesDir(); }
  getDataDir() { return getDataDir(); }
  getExternalFilesDirs(type) { return []; } // eslint-disable-line no-unused-vars
  getExternalCacheDirs() { return []; }
  databaseList() { return []; }
  getDatabasePath(name) { return getDatabasePath(name); }
  deleteDatabase(name) { return false; } // eslint-disable-line no-unused-vars
}
/** The single application context of the web app. */
export const appContext = new Context();
