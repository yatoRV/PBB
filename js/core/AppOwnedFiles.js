// Port of vn.lichdilam.AppOwnedFiles (APK 4.5), over the virtual app storage (js/platform/files.js).
import { IOException } from '../platform/java.js';
import { Files, SimpleFileVisitor, FileVisitResult } from '../platform/files.js';

const EMPTY_SET = Object.freeze(new Set());
const containsName = (keep, name) => (typeof keep.has === 'function' ? keep.has(name) : keep.contains(name));

class DeleteVisitor extends SimpleFileVisitor {
  visitFile(file) { Files.delete(file); return FileVisitResult.CONTINUE; }
  postVisitDirectory(dir, error) { if (error != null) throw error; Files.delete(dir); return FileVisitResult.CONTINUE; }
}

/** Caller passes an Android app-owned directory, never a user's photo URI. */
export class AppOwnedFiles {
  /** Deletes every child except the named direct children (a Set of names), which are kept untouched. */
  static clearContents(directory, keep = EMPTY_SET) {
    if (directory == null || !directory.exists()) return;
    const root = directory.toPath().toAbsolutePath().normalize();
    if (Files.isSymbolicLink(root)) throw new IOException('Không xóa thư mục liên kết ngoài ứng dụng.');
    const children = Files.newDirectoryStream(root);
    try { for (const child of children) if (!containsName(keep, child.getFileName().toString())) AppOwnedFiles.deleteInside(root, child); } finally { children.close(); }
  }
  static deleteInside(root, target) {
    const boundary = root.toAbsolutePath().normalize(), path = target.toAbsolutePath().normalize();
    if (path.equals(boundary) || !path.startsWith(boundary)) throw new IOException('Đường dẫn nằm ngoài dữ liệu ứng dụng.');
    // walkFileTree does not follow symbolic links. Reject linked ancestors too.
    for (let parent = path.getParent(); parent != null && parent.startsWith(boundary); parent = parent.getParent())
      if (Files.isSymbolicLink(parent)) throw new IOException('Đường dẫn chứa liên kết ngoài ứng dụng.');
    Files.walkFileTree(path, new DeleteVisitor());
  }
}
