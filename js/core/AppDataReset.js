// Port of vn.lichdilam.AppDataReset (APK 4.5). A page has one thread, so the Java LOCK is not needed for mutual
// exclusion: reset() and a task's action are synchronous and cannot interleave.
import { IOException, JavaHashMap } from '../platform/java.js';
import { File } from '../platform/files.js';
import { Intent } from '../platform/android.js';
import { AppLog } from './AppLog.js';
import { AppOwnedFiles } from './AppOwnedFiles.js';
import { OwnerProfile } from './OwnerProfile.js';
import { ErrorLedger } from './ErrorLedger.js';
import { Personnel } from './Personnel.js';
import { ThemeSettings } from './ThemeSettings.js';
import { ReminderSettings } from './ReminderSettings.js';
import { ReminderEngine } from './ReminderEngine.js';
import { ColorThemeStore } from './ColorThemeStore.js';

let generation = 0;
const XML = /\.xml(?:\.bak)?$/;

// 3.0: the error ledger and the confirmed staff list (with the user's aliases) are what the app has learned; Reset keeps them.
function preserve(name, keepPresets) { return OwnerProfile.PREFERENCES === name || ErrorLedger.PREFERENCES === name || Personnel.PREFS === name || (keepPresets && ThemeSettings.PRESETS === name); }

/** Serialize reset with image workers so a cancelled scan cannot repopulate storage. */
export class AppDataReset {
  static generation() { return generation; }
  static current(value) { return value === generation; }
  static invalidatePending() { generation++; }
  static task(action) {
    const expected = generation;
    // An async action's promise is returned, so an executor job lasts until it settles.
    return () => (AppDataReset.current(expected) ? action() : undefined);
  }
  /** preferences: a Map or Java-style map of name → SharedPreferences. */
  static clearPreferences(preferences, keepPresets = true) {
    for (const [name, prefs] of preferences)
      if (!preserve(name, keepPresets) && !prefs.edit().clear().commit())
        throw new IOException('Chưa xóa hết cài đặt ' + name + '. Hãy Reset lại.');
  }
  static reset(context, keepPresets = true) {
    AppLog.event('app.reset.begin', AppLog.data('keepPresets', keepPresets));
    ReminderEngine.reset(context);
    const prefs = new JavaHashMap();
    // Include these even if their first asynchronous write has not reached disk.
    for (const name of ['schedules', 'widgets', ReminderSettings.PREFS, ThemeSettings.PREFS, ThemeSettings.PRESETS]) prefs.put(name, context.getSharedPreferences(name, 0));
    const directory = new File(context.getApplicationInfo().dataDir, 'shared_prefs');
    let files = directory.listFiles();
    if (files != null) for (const file of files) if (file.getName().endsWith('.xml') || file.getName().endsWith('.xml.bak')) {
      const name = file.getName().replace(XML, '');
      prefs.put(name, context.getSharedPreferences(name, 0));
    }
    AppDataReset.clearPreferences(prefs, keepPresets);
    for (const name of prefs.keySet()) if (!preserve(name, keepPresets)) context.deleteSharedPreferences(name);
    files = directory.listFiles();
    if (files != null) for (const file of files) if (!preserve(file.getName().replace(XML, ''), keepPresets))
      AppOwnedFiles.deleteInside(directory.toPath(), file.toPath());
    for (const database of context.databaseList()) {
      const path = context.getDatabasePath(database);
      // Android deletes the database and its journal/WAL together. A later name
      // from databaseList() may already be gone; that is successful cleanup.
      if (path.exists() && !context.deleteDatabase(database) && path.exists())
        throw new IOException('Chưa xóa được dữ liệu ' + database);
    }
    // Saved color sets live in files/color-themes; keep that folder when the user keeps them.
    AppOwnedFiles.clearContents(context.getFilesDir(), keepPresets ? new Set([ColorThemeStore.DIRECTORY, ErrorLedger.DIRECTORY, AppLog.DIRECTORY]) : new Set([ErrorLedger.DIRECTORY, AppLog.DIRECTORY]));
    for (const root of [context.getCacheDir(), context.getCodeCacheDir(), context.getNoBackupFilesDir()]) AppOwnedFiles.clearContents(root);
    for (const root of context.getExternalFilesDirs(null)) AppOwnedFiles.clearContents(root);
    for (const root of context.getExternalCacheDirs()) AppOwnedFiles.clearContents(root);
    for (const permission of context.getContentResolver().getPersistedUriPermissions()) {
      const flags = (permission.isReadPermission() ? Intent.FLAG_GRANT_READ_URI_PERMISSION : 0) | (permission.isWritePermission() ? Intent.FLAG_GRANT_WRITE_URI_PERMISSION : 0);
      context.getContentResolver().releasePersistableUriPermission(permission.getUri(), flags);
    }
    AppLog.event('app.reset.complete', AppLog.data('keepPresets', keepPresets));
  }
}
