// Port of vn.lichdilam.ReminderSettings (APK 4.5).
import { IllegalStateException } from '../platform/java.js';
import { Settings } from '../platform/android.js';
import { ReminderRule } from './ReminderRule.js';
import { BundledToneUris } from './BundledToneUris.js';

const PREFS = 'reminders';

export class ReminderSettings {
  static PREFS = PREFS;
  /** new ReminderSettings(context) | new ReminderSettings(prefs). */
  constructor(contextOrPrefs) { this.prefs = typeof contextOrPrefs.getSharedPreferences === 'function' ? contextOrPrefs.getSharedPreferences(PREFS, 0) : contextOrPrefs; }
  rules() { return ReminderRule.decode(this.prefs.getString('rules', '[]')); }
  enabled() { return this.prefs.getBoolean('enabled', false); }
  sound() { return BundledToneUris.canonical(this.prefs.getString('sound', Settings.System.DEFAULT_NOTIFICATION_URI)); }
  channelRevision() { return this.prefs.getInt('channelRevision', 0); }
  renewChannel() { if (!this.prefs.edit().putInt('channelRevision', this.channelRevision() + 1).commit()) throw new IllegalStateException('Không cập nhật được kênh thông báo.'); }
  soundName() { return this.prefs.getString('soundName', 'Âm thông báo mặc định'); }
  vibrate() { return this.prefs.getBoolean('vibrate', true); }
  saveSound(uri, name) {
    if (!this.prefs.edit().putString('sound', uri).putString('soundName', name).commit()) throw new IllegalStateException('Không lưu được âm thông báo.');
  }
  save(rules, enabled, sound, soundName, vibrate) {
    if (!this.prefs.edit().putString('rules', ReminderRule.encode(rules)).putBoolean('enabled', enabled).putString('sound', sound).putString('soundName', soundName).putBoolean('vibrate', vibrate).commit()) throw new IllegalStateException('Không lưu được cài đặt thông báo.');
  }
}
