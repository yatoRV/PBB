// Port of vn.lichdilam.ImageFiles (APK 4.5). Async: the picked image (a File/Blob on the web) is read through the
// ContentResolver shim and decoded by BitmapFactory, both asynchronous in the browser.
import { IOException } from '../platform/java.js';
import { File, FileOutputStream } from '../platform/files.js';
import { Bitmap, BitmapFactory, ExifInterface, Matrix } from '../platform/bitmap.js';

export class ImageFiles {
  static async load(context, uri, maxEdge) {
    const f = File.createTempFile('source-', '.image', context.getCacheDir());
    try {
      const input = await context.getContentResolver().openInputStream(uri); const out = new FileOutputStream(f);
      try {
        if (input == null) throw new IOException('Không mở được ảnh.'); const bytes = new Uint8Array(65536); let n; let total = 0;
        while ((n = input.read(bytes)) !== -1) { total += n; if (total > 80 * 1024 * 1024) throw new IOException('Chọn ảnh dưới 80 MB.'); out.write(bytes, 0, n); }
      } finally { try { out.close(); } finally { if (input != null) input.close(); } }
      const opt = new BitmapFactory.Options(); opt.inJustDecodeBounds = true; await BitmapFactory.decodeFile(f.toString(), opt);
      if (opt.outWidth <= 0 || opt.outHeight <= 0) throw new IOException('Định dạng ảnh không hợp lệ.'); let sample = 1; while (Math.trunc(Math.max(opt.outWidth, opt.outHeight) / sample) > maxEdge) sample *= 2;
      opt.inJustDecodeBounds = false; opt.inSampleSize = sample; let bitmap = await BitmapFactory.decodeFile(f.toString(), opt); if (bitmap == null) throw new IOException('Không giải mã được ảnh.');
      const exif = new ExifInterface(f); const m = new Matrix(); if (exif.isFlipped()) m.postScale(-1, 1); m.postRotate(exif.getRotationDegrees());
      if (!m.isIdentity()) { const rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), m, true); if (rotated !== bitmap) bitmap.recycle(); bitmap = rotated; } return bitmap;
    } finally { f.delete(); }
  }
}
