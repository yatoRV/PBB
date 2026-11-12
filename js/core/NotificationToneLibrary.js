// Port of vn.lichdilam.NotificationToneLibrary (APK 4.5). Reading the bundled catalogue is async (asset fetch).
import { IllegalArgumentException, CASE_INSENSITIVE_ORDER, trim } from '../platform/java.js';
import { JSONArray } from '../platform/json.js';
import { ByteArrayOutputStream } from '../platform/files.js';
import { BundledToneUris } from './BundledToneUris.js';

const IDS = Object.freeze(['aosp', 'kenney_interface', 'kenney_ui']);
const LABELS = Object.freeze(['Android (AOSP)', 'Kenney · Interface Sounds', 'Kenney · UI Audio']);
const SOURCES = Object.freeze(['Android Open Source Project · Apache 2.0 · 75 âm', 'Kenney · Interface Sounds · CC0 · 100 âm', 'Kenney · UI Audio · CC0 · 51 âm']);

class Tone { constructor(uri, name) { this.uri = uri; this.name = name; Object.freeze(this); } }

/** Bundled notification sounds with their actual source names and licenses. */
export class NotificationToneLibrary {
  static IDS = IDS; static LABELS = LABELS; static SOURCES = SOURCES;
  static Tone = Tone;
  static async assetText(context, file) {
    const input = await context.getAssets().open(file); const out = new ByteArrayOutputStream();
    try { const bytes = new Uint8Array(8192); let n; while ((n = input.read(bytes)) !== -1) out.write(bytes, 0, n); return out.toString(); } finally { try { out.close(); } finally { input.close(); } }
  }
  static decode(raw, group, packageName) { // eslint-disable-line no-unused-vars
    if (!IDS.includes(group)) throw new IllegalArgumentException('Bộ âm không tồn tại.');
    const array = new JSONArray(raw); const tones = []; const resources = new Set();
    for (let i = 0; i < array.length(); i++) {
      const entry = array.getJSONObject(i); if (group !== entry.getString('group')) continue;
      const name = entry.getString('name'), resource = entry.getString('resource');
      if (trim(name) === '' || !/^tone_[a-z0-9_]+$/.test(resource) || resources.has(resource)) throw new IllegalArgumentException('Danh sách âm không hợp lệ.');
      resources.add(resource);
      tones.push(new Tone(BundledToneUris.uri(resource), name));
    }
    tones.sort((a, b) => CASE_INSENSITIVE_ORDER(a.name, b.name)); return tones;
  }
  static async load(context, group) {
    return NotificationToneLibrary.decode(await NotificationToneLibrary.assetText(context, 'notification_tones.json'), group, 'vn.lichdilam');
  }
}
