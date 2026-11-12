// Port of vn.lichdilam.BundledToneUris (APK 4.5).
import { IllegalArgumentException } from '../platform/java.js';

const AUTHORITY = 'vn.lichdilam.bundled-tones';
const RESOURCE = /^tone_[a-z0-9_]+$/;

/** Stable names for public, bundled notification sounds; no private/imported file paths. */
export class BundledToneUris {
  static AUTHORITY = AUTHORITY;
  static validResource(name) { return name != null && RESOURCE.test(name); }
  static uri(resource) {
    if (!BundledToneUris.validResource(resource)) throw new IllegalArgumentException('Tên âm không hợp lệ.');
    return 'content://' + AUTHORITY + '/' + resource;
  }
  static canonical(uri) {
    const prefix = 'android.resource://vn.lichdilam/raw/';
    if (uri != null && uri.startsWith(prefix) && BundledToneUris.validResource(uri.substring(prefix.length))) return BundledToneUris.uri(uri.substring(prefix.length));
    return uri;
  }
}
