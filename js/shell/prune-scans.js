// Task A6 (web only): every pipe reading writes its evidence crops to files/pipe-scans/<random id>/ (about 580 PNGs,
// 12 MB) and nothing ever deletes the folders of earlier readings — the APK keeps them too, on the phone only. On the
// web every app file goes to Google Drive, the small ones inside du-lieu.json: after 7 readings 3,977 files (83 MB, about
// 110 MB as base64) were downloaded at every sign-in and uploaded with every save. At sign-in, before any reading
// can run, the folders that nothing refers to are deleted. Kept: every folder whose id appears in any preference
// (the saved books' evidence paths, UI drafts) or in any JSON file of the app (a finished reading waiting in the cache,
// reading jobs), whatever escaping wrote it.
import { File, Files, DATA_DIR, getFilesDir } from '../platform/files.js';
import { exportState as exportPrefs } from '../platform/prefs.js';
import { utf8Decode } from '../platform/java.js';

const REFERENCE = /pipe-scans[\\/]+([0-9A-Za-z-]+)/g;

/** Ids of the pipe-scans folders referred to by the preferences or by a JSON file under the app's data directory. */
export function referencedScanIds({ prefs = exportPrefs(), root = new File(DATA_DIR) } = {}) {
  const ids = new Set(); const add = text => { for (const m of text.matchAll(REFERENCE)) ids.add(m[1]); };
  add(JSON.stringify(prefs));
  const walk = dir => {
    for (const f of dir.listFiles() ?? []) {
      const name = f.getName();
      if (f.isDirectory()) { if (name !== 'pipe-scans' && name !== 'shared_prefs') walk(f); }
      else if (name.endsWith('.json')) add(utf8Decode(Files.readAllBytes(f.toPath())));
    }
  };
  walk(root);
  return ids;
}

/** Deletes the pipe-scans folders nothing refers to: { removed, kept, files, bytes }. */
export function prunePipeScans({ filesDir = getFilesDir(), ...where } = {}) {
  const result = { removed: 0, kept: 0, files: 0, bytes: 0 };
  const folders = new File(filesDir, 'pipe-scans').listFiles();
  if (folders == null || folders.length === 0) return result;
  const keep = referencedScanIds(where);
  const remove = dir => {
    for (const f of dir.listFiles() ?? []) {
      if (f.isDirectory()) remove(f); else { result.bytes += f.length(); if (f.delete()) result.files++; }
    }
    dir.delete();
  };
  for (const folder of folders) {
    if (!folder.isDirectory() || keep.has(folder.getName())) { result.kept++; continue; }
    remove(folder); result.removed++;
  }
  return result;
}
