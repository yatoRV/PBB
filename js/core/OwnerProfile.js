// Port of vn.lichdilam.OwnerProfile (APK 4.5).
import { IllegalArgumentException, IllegalStateException } from '../platform/java.js';
import { Schedule } from './Schedule.js';

const PREFERENCES = 'owner-profile';

/** Only the explicit Save Name action writes here. Importing schedules never changes it. */
export class OwnerProfile {
  static PREFERENCES = PREFERENCES;
  /** new OwnerProfile(context) or new OwnerProfile(sharedPreferences). */
  constructor(contextOrPrefs) { this._prefs = typeof contextOrPrefs.getSharedPreferences === 'function' ? contextOrPrefs.getSharedPreferences(PREFERENCES, 0) : contextOrPrefs; }
  name() { return this._prefs.getString('default-name', ''); }
  defaultName(fallback) { return this.name() === '' ? fallback : this.name(); }
  save(input) {
    const name = Schedule.normalizePerson(input);
    if (name === '' || name.length > 60 || !/^[\p{L}\p{M} \t\n\x0B\f\r.'’-]+$/u.test(name))
      throw new IllegalArgumentException('Nhập tên từ 1–60 ký tự; chỉ dùng chữ, dấu cách hoặc dấu viết tắt.');
    if (!this._prefs.edit().putString('default-name', name).commit())
      throw new IllegalStateException('Chưa lưu được tên. Hãy thử lại.');
  }
}
