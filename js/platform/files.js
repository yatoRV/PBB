// Virtual app storage replacing the Android data directory: java.io.File, java.nio.file.{Path,Paths,Files},
// byte streams, RandomAccessFile and ZipOutputStream over an in-memory Map<path, bytes>. All operations are
// synchronous (like the Java code); persistence is done elsewhere via exportState()/importState()/onFilesChange.
import { IOException, FileNotFoundException, IllegalArgumentException, NullPointerException, IndexOutOfBoundsException, UnsupportedOperationException, compareTo, javaStringHash, utf8Encode, utf8Decode, System, CRC32, Base64, javaToString } from './java.js';
import { Log } from './log.js';
import { prefsNames, deleteSharedPreferences, exportState as exportPrefsState, prefsLastModified } from './prefs.js';

export { IOException, FileNotFoundException };
export class FileSystemException extends IOException {
  static javaName = 'java.nio.file.FileSystemException';
  constructor(file, other = null, reason = null) { super(reason == null && other == null ? file : (file ?? '') + (other != null ? ' -> ' + other : '') + (reason != null ? ': ' + reason : '')); this.file = file; this.other = other; this.reason = reason; }
  getFile() { return this.file; }
  getReason() { return this.reason; }
}
export class NoSuchFileException extends FileSystemException { static javaName = 'java.nio.file.NoSuchFileException'; }
export class FileAlreadyExistsException extends FileSystemException { static javaName = 'java.nio.file.FileAlreadyExistsException'; }
export class DirectoryNotEmptyException extends FileSystemException { static javaName = 'java.nio.file.DirectoryNotEmptyException'; }
export class NotDirectoryException extends FileSystemException { static javaName = 'java.nio.file.NotDirectoryException'; }
export class AtomicMoveNotSupportedException extends FileSystemException { static javaName = 'java.nio.file.AtomicMoveNotSupportedException'; }
export class EOFException extends IOException { static javaName = 'java.io.EOFException'; }
export class ZipException extends IOException { static javaName = 'java.util.zip.ZipException'; }

// ------------------------------------------------------------------ store
/** Android data directory of the app (Context.getDataDir()). */
export const DATA_DIR = '/data/user/0/vn.lichdilam';
const store = { files: new Map(), dirs: new Set(['/']) }; // path -> { data: Uint8Array, mtime }
const listeners = new Set();
const emit = ev => { for (const l of listeners) l(ev); };
/** fn({type: 'write'|'delete'|'mkdir'|'rmdir'|'rename', path, to?}). Returns an unsubscribe function. */
export function onFilesChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const now = () => System.currentTimeMillis();

/** java.io.File path normalisation (collapse '//', drop trailing '/'). */
function normalize(p) { let s = String(p).replace(/\/{2,}/g, '/'); if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1); return s; }
/** Canonical absolute path (user.dir is "/", resolves "." and ".."). */
function canon(p) {
  const abs = p.startsWith('/') ? p : '/' + p; const out = [];
  for (const seg of abs.split('/')) { if (seg === '' || seg === '.') continue; if (seg === '..') out.pop(); else out.push(seg); }
  return '/' + out.join('/');
}
const parentOf = k => (k === '/' ? null : k.substring(0, k.lastIndexOf('/')) || '/');
const baseName = k => k.substring(k.lastIndexOf('/') + 1);
/**
 * <dataDir>/shared_prefs is virtual: it always exists and lists one "<name>.xml" per preference file of prefs.js;
 * deleting such a file deletes those preferences (Context.deleteSharedPreferences).
 */
const PREFS_DIR = DATA_DIR + '/shared_prefs';
function prefsFileName(k) {
  if (parentOf(k) !== PREFS_DIR || !k.endsWith('.xml')) return null;
  const name = baseName(k).slice(0, -4); return prefsNames().includes(name) ? name : null;
}
/** Content of a virtual preference file: the JSON entries of that file (not Android's XML). */
const prefsBytes = name => utf8Encode(JSON.stringify(exportPrefsState()[name] ?? []));
const isDir = k => store.dirs.has(k) || k === PREFS_DIR;
const isFile = k => store.files.has(k) || prefsFileName(k) !== null;
const exists = k => isDir(k) || isFile(k);
function children(k) {
  const prefix = k === '/' ? '/' : k + '/'; const names = new Set();
  if (k === PREFS_DIR) for (const n of prefsNames()) names.add(n + '.xml');
  if (k === DATA_DIR) names.add('shared_prefs');
  for (const map of [store.files.keys(), store.dirs.keys()]) for (const p of map) if (p !== k && p.startsWith(prefix) && p.indexOf('/', prefix.length) === -1) names.add(p.substring(prefix.length));
  return [...names].sort(compareTo);
}
function writeKey(k, data, append) {
  const e = store.files.get(k);
  const bytes = append && e ? concat(e.data, data) : data;
  store.files.set(k, { data: bytes, mtime: now() }); emit({ type: 'write', path: k });
}
function concat(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }
function keyOf(x) { if (x == null) throw new NullPointerException(); return x instanceof File ? x._key : x instanceof Path ? x._file._key : canon(normalize(String(x))); }
function moveTree(from, to) {
  const fromPrefix = from + '/';
  for (const [p, e] of [...store.files]) if (p === from || p.startsWith(fromPrefix)) { store.files.delete(p); store.files.set(to + p.substring(from.length), e); }
  for (const p of [...store.dirs]) if (p === from || p.startsWith(fromPrefix)) { store.dirs.delete(p); store.dirs.add(to + p.substring(from.length)); }
  emit({ type: 'rename', path: from, to });
}

/** Plain snapshot: { dirs: string[], files: [path, Uint8Array, mtime][] } (callers serialise; bytes are copies). */
export function exportState() {
  return { dirs: [...store.dirs].sort(compareTo), files: [...store.files].sort((a, b) => compareTo(a[0], b[0])).map(([p, e]) => [p, e.data.slice(), e.mtime]) };
}
/** Replaces the whole store. File data may be a Uint8Array, a number array or a Base64 string. */
export function importState(state) {
  store.files.clear(); store.dirs.clear(); store.dirs.add('/');
  for (const d of state?.dirs ?? []) for (let p = d; p && !store.dirs.has(p); p = parentOf(p)) store.dirs.add(p);
  for (const [p, data, mtime] of state?.files ?? []) {
    const bytes = typeof data === 'string' ? Base64.getDecoder().decode(data) : Uint8Array.from(data);
    for (let d = parentOf(p); d && !store.dirs.has(d); d = parentOf(d)) store.dirs.add(d);
    store.files.set(p, { data: bytes, mtime: mtime ?? 0 });
  }
  emit({ type: 'import', path: '/' });
}

// ------------------------------------------------------------------ java.io.File
export class File {
  static separator = '/'; static separatorChar = '/'; static pathSeparator = ':';
  /** new File(path) | new File(parent: File|string|null, child). */
  constructor(a, b) {
    if (b === undefined) { if (a == null) throw new NullPointerException(); this.path = normalize(a); }
    else {
      if (b == null) throw new NullPointerException();
      const parent = a instanceof File ? a.path : a;
      this.path = parent == null ? normalize(b) : parent === '' ? normalize('/' + b) : normalize(normalize(parent) + '/' + b);
    }
    this._key = canon(this.path);
  }
  getPath() { return this.path; }
  toString() { return this.path; }
  getName() { return this.path.substring(this.path.lastIndexOf('/') + 1); }
  getParent() { const i = this.path.lastIndexOf('/'); if (i < 0) return null; if (i === 0) return this.path.length > 1 ? '/' : null; return this.path.substring(0, i); }
  getParentFile() { const p = this.getParent(); return p == null ? null : new File(p); }
  isAbsolute() { return this.path.startsWith('/'); }
  getAbsolutePath() { return this.isAbsolute() ? this.path : normalize('/' + this.path); }
  getAbsoluteFile() { return new File(this.getAbsolutePath()); }
  getCanonicalPath() { return this._key; }
  getCanonicalFile() { return new File(this._key); }
  toPath() { return new Path(this); }
  exists() { return exists(this._key); }
  isFile() { return isFile(this._key); }
  isDirectory() { return isDir(this._key); }
  canRead() { return this.exists(); }
  canWrite() { return this.exists(); }
  length() { const e = store.files.get(this._key); if (e) return e.data.length; const n = prefsFileName(this._key); return n ? prefsBytes(n).length : 0; }
  lastModified() { const e = store.files.get(this._key); if (e) return e.mtime; const n = prefsFileName(this._key); return n ? prefsLastModified(n) : 0; }
  setLastModified(t) { if (t < 0) throw new IllegalArgumentException('Negative time'); const e = store.files.get(this._key); if (!e) return isDir(this._key); e.mtime = t; emit({ type: 'write', path: this._key }); return true; }
  createNewFile() {
    if (exists(this._key)) return false;
    if (!isDir(parentOf(this._key))) throw new IOException('No such file or directory');
    writeKey(this._key, new Uint8Array(0), false); return true;
  }
  mkdir() { const k = this._key; if (exists(k) || !isDir(parentOf(k))) return false; store.dirs.add(k); emit({ type: 'mkdir', path: k }); return true; }
  mkdirs() {
    if (this.exists()) return false; if (this.mkdir()) return true;
    const parent = this.getCanonicalFile().getParentFile();
    return parent != null && (parent.mkdirs() || parent.exists()) && this.mkdir();
  }
  delete() {
    const k = this._key; const pref = prefsFileName(k);
    if (pref !== null) return deleteSharedPreferences(pref);
    if (isFile(k)) { store.files.delete(k); emit({ type: 'delete', path: k }); return true; }
    if (isDir(k) && k !== '/' && children(k).length === 0) { store.dirs.delete(k); emit({ type: 'rmdir', path: k }); return true; }
    return false;
  }
  /** Java runs this at VM exit; the web app never exits, so it is a no-op. */
  deleteOnExit() {}
  renameTo(dest) {
    if (dest == null) throw new NullPointerException();
    const from = this._key, to = dest._key;
    if (!exists(from) || !isDir(parentOf(to)) || from === '/' || to.startsWith(from + '/')) return false;
    if (from === to) return true;
    if (isDir(from)) { if (isFile(to) || (isDir(to) && children(to).length)) return false; store.dirs.delete(to); moveTree(from, to); return true; }
    if (isDir(to)) return false;
    const e = store.files.get(from); store.files.delete(from); store.files.set(to, e); emit({ type: 'rename', path: from, to }); return true;
  }
  /** Child names (sorted) or null when not a directory. */
  list(filter) { if (!isDir(this._key)) return null; const names = children(this._key); return filter ? names.filter(n => filter(this, n)) : names; }
  /** File[] (sorted by name) or null; filter is a FilenameFilter (dir, name) or a FileFilter (file). */
  listFiles(filter) {
    const names = this.list(); if (names == null) return null;
    const files = names.map(n => new File(this, n));
    if (!filter) return files;
    return filter.length >= 2 ? files.filter(f => filter(this, f.getName())) : files.filter(f => filter(f));
  }
  equals(o) { return o instanceof File && o.path === this.path; }
  hashCode() { return javaStringHash(this.path) ^ 1234321; }
  compareTo(o) { return compareTo(this.path, o.path); }
  /** File.createTempFile(prefix, suffix, directory). */
  static createTempFile(prefix, suffix, directory) {
    if (prefix.length < 3) throw new IllegalArgumentException('Prefix string "' + prefix + '" too short: length must be at least 3');
    const dir = directory ?? new File(DATA_DIR + '/cache'); if (!dir.isDirectory()) throw new IOException('No such file or directory');
    for (;;) {
      const n = BigInt.asUintN(63, globalThis.crypto.getRandomValues(new BigUint64Array(1))[0]);
      const f = new File(dir, prefix + n.toString() + (suffix ?? '.tmp'));
      if (f.createNewFile()) return f;
    }
  }
}

/** Context directories (created on demand like Android). */
function appDir(name) { const f = new File(DATA_DIR + '/' + name); if (!f.exists()) f.mkdirs(); return f; }
export const getDataDir = () => appDir('').getCanonicalFile();
export const getFilesDir = () => appDir('files');
export const getCacheDir = () => appDir('cache');
export const getNoBackupFilesDir = () => appDir('no_backup');
export const getCodeCacheDir = () => appDir('code_cache');
export const getDatabasePath = name => new File(appDir('databases'), name);
export const getDir = name => appDir('app_' + name);

// ------------------------------------------------------------------ java.nio.file
export class Path {
  constructor(file) { this._file = file; }
  toFile() { return this._file; }
  toString() { return this._file.getPath(); }
  getFileName() { const n = this._file.getName(); return n ? new Path(new File(n)) : null; }
  getParent() { const p = this._file.getParentFile(); return p ? new Path(p) : null; }
  resolve(other) { const o = String(other); return o.startsWith('/') ? new Path(new File(o)) : new Path(new File(this._file, o)); }
  toAbsolutePath() { return new Path(this._file.getAbsoluteFile()); }
  normalize() { return new Path(new File(this._file._key)); }
  startsWith(o) { const a = this._file._key, b = keyOf(o); return a === b || a.startsWith(b === '/' ? '/' : b + '/'); }
  equals(o) { return o instanceof Path && o._file.path === this._file.path; }
  hashCode() { return javaStringHash(this._file.path); }
  compareTo(o) { return compareTo(this.toString(), o.toString()); }
}
export const Paths = { get: (first, ...more) => new Path(new File([first, ...more].join('/'))) };
export const StandardCopyOption = { REPLACE_EXISTING: 'REPLACE_EXISTING', COPY_ATTRIBUTES: 'COPY_ATTRIBUTES', ATOMIC_MOVE: 'ATOMIC_MOVE' };
export const StandardOpenOption = { READ: 'READ', WRITE: 'WRITE', APPEND: 'APPEND', TRUNCATE_EXISTING: 'TRUNCATE_EXISTING', CREATE: 'CREATE', CREATE_NEW: 'CREATE_NEW' };
export const LinkOption = { NOFOLLOW_LINKS: 'NOFOLLOW_LINKS' };
export const FileVisitResult = { CONTINUE: 'CONTINUE', TERMINATE: 'TERMINATE', SKIP_SUBTREE: 'SKIP_SUBTREE', SKIP_SIBLINGS: 'SKIP_SIBLINGS' };
/** java.nio.file.SimpleFileVisitor: override visitFile / preVisitDirectory / postVisitDirectory / visitFileFailed. */
export class SimpleFileVisitor {
  preVisitDirectory() { return FileVisitResult.CONTINUE; }
  visitFile() { return FileVisitResult.CONTINUE; }
  visitFileFailed(file, exc) { throw exc; }
  postVisitDirectory(dir, exc) { if (exc) throw exc; return FileVisitResult.CONTINUE; }
}
function attrs(k) { const e = store.files.get(k); return { isDirectory: () => isDir(k), isRegularFile: () => !!e, isSymbolicLink: () => false, isOther: () => false, size: () => (e ? e.data.length : 0), lastModifiedTime: () => ({ toMillis: () => (e ? e.mtime : 0) }) }; }
const pathOf = x => (x instanceof Path ? x : new Path(x instanceof File ? x : new File(String(x))));

export const Files = {
  exists: p => exists(keyOf(p)),
  notExists: p => !exists(keyOf(p)),
  isDirectory: p => isDir(keyOf(p)),
  isRegularFile: p => isFile(keyOf(p)),
  /** No symbolic links exist in the virtual storage. */
  isSymbolicLink: () => false,
  size(p) { const k = keyOf(p); if (!exists(k)) throw new NoSuchFileException(pathOf(p).toString()); return isFile(k) ? store.files.get(k).data.length : 4096; },
  readAllBytes(p) {
    const k = keyOf(p); const pref = prefsFileName(k); if (pref !== null) return prefsBytes(pref);
    if (isDir(k)) throw new IOException('Is a directory');
    const e = store.files.get(k); if (!e) throw new NoSuchFileException(pathOf(p).toString());
    return e.data.slice();
  },
  readString: p => utf8Decode(Files.readAllBytes(p)),
  write(p, bytes, ...options) {
    const k = keyOf(p);
    if (!isDir(parentOf(k))) throw new NoSuchFileException(pathOf(p).toString());
    if (isDir(k)) throw new FileSystemException(pathOf(p).toString(), null, 'Is a directory');
    if (options.includes('CREATE_NEW') && exists(k)) throw new FileAlreadyExistsException(pathOf(p).toString());
    writeKey(k, Uint8Array.from(bytes), options.includes('APPEND')); return pathOf(p);
  },
  writeString: (p, s, ...options) => Files.write(p, utf8Encode(s), ...options),
  createDirectory(p) { const k = keyOf(p); if (exists(k)) throw new FileAlreadyExistsException(pathOf(p).toString()); if (!isDir(parentOf(k))) throw new NoSuchFileException(pathOf(p).toString()); store.dirs.add(k); emit({ type: 'mkdir', path: k }); return pathOf(p); },
  createDirectories(p) { const k = keyOf(p); if (isFile(k)) throw new FileAlreadyExistsException(pathOf(p).toString()); new File(k).mkdirs(); return pathOf(p); },
  delete(p) {
    const k = keyOf(p);
    if (!exists(k)) throw new NoSuchFileException(pathOf(p).toString());
    if (isDir(k) && children(k).length) throw new DirectoryNotEmptyException(pathOf(p).toString());
    new File(k).delete();
  },
  deleteIfExists(p) { if (!exists(keyOf(p))) return false; Files.delete(p); return true; },
  /** move(source, target, options…); REPLACE_EXISTING / ATOMIC_MOVE replace an existing target. */
  move(src, dst, ...options) {
    const a = keyOf(src), b = keyOf(dst);
    if (!exists(a)) throw new NoSuchFileException(pathOf(src).toString());
    if (a === b) return pathOf(dst);
    const replace = options.includes('REPLACE_EXISTING') || options.includes('ATOMIC_MOVE');
    if (exists(b)) {
      if (!replace) throw new FileAlreadyExistsException(pathOf(dst).toString());
      if (isDir(b) && children(b).length) throw new DirectoryNotEmptyException(pathOf(dst).toString());
      if (isDir(b)) store.dirs.delete(b); else store.files.delete(b);
    }
    if (!isDir(parentOf(b))) throw new NoSuchFileException(pathOf(dst).toString());
    if (isDir(a)) moveTree(a, b); else { const e = store.files.get(a); store.files.delete(a); store.files.set(b, e); emit({ type: 'rename', path: a, to: b }); }
    return pathOf(dst);
  },
  /** copy(Path, Path, options…) | copy(Path, OutputStream) -> bytes | copy(InputStream, Path, options…) -> bytes. */
  copy(src, dst, ...options) {
    if (src instanceof InputStream) {
      const k = keyOf(dst);
      if (exists(k)) { if (!options.includes('REPLACE_EXISTING')) throw new FileAlreadyExistsException(pathOf(dst).toString()); if (isDir(k) && children(k).length) throw new DirectoryNotEmptyException(pathOf(dst).toString()); }
      if (!isDir(parentOf(k))) throw new NoSuchFileException(pathOf(dst).toString());
      const data = src.readAllBytes(); store.dirs.delete(k); writeKey(k, data, false); return data.length;
    }
    if (dst instanceof OutputStream) { const data = Files.readAllBytes(src); dst.write(data, 0, data.length); return data.length; }
    const a = keyOf(src), b = keyOf(dst);
    if (!exists(a)) throw new NoSuchFileException(pathOf(src).toString());
    if (a === b) return pathOf(dst);
    if (exists(b)) { if (!options.includes('REPLACE_EXISTING')) throw new FileAlreadyExistsException(pathOf(dst).toString()); if (isDir(b) && children(b).length) throw new DirectoryNotEmptyException(pathOf(dst).toString()); store.dirs.delete(b); store.files.delete(b); }
    if (!isDir(parentOf(b))) throw new NoSuchFileException(pathOf(dst).toString());
    if (isDir(a)) { store.dirs.add(b); emit({ type: 'mkdir', path: b }); } else writeKey(b, store.files.get(a).data.slice(), false);
    return pathOf(dst);
  },
  /** DirectoryStream<Path>: iterable, close(). */
  newDirectoryStream(dir) {
    const k = keyOf(dir); if (!exists(k)) throw new NoSuchFileException(pathOf(dir).toString()); if (!isDir(k)) throw new NotDirectoryException(pathOf(dir).toString());
    const base = pathOf(dir); const list = children(k).map(n => base.resolve(n));
    return { [Symbol.iterator]: () => list[Symbol.iterator](), iterator: () => list[Symbol.iterator](), close() {} };
  },
  list(dir) { return [...Files.newDirectoryStream(dir)]; },
  /** Depth-first walk (children in name order) calling the visitor like java.nio.file.Files.walkFileTree. */
  walkFileTree(start, visitor) {
    const walk = p => {
      const k = keyOf(p);
      if (!exists(k)) return visitor.visitFileFailed ? visitor.visitFileFailed(p, new NoSuchFileException(p.toString())) : FileVisitResult.CONTINUE;
      if (!isDir(k)) return visitor.visitFile(p, attrs(k));
      const pre = visitor.preVisitDirectory ? visitor.preVisitDirectory(p, attrs(k)) : FileVisitResult.CONTINUE;
      if (pre === FileVisitResult.TERMINATE) return pre;
      if (pre === FileVisitResult.SKIP_SUBTREE || pre === FileVisitResult.SKIP_SIBLINGS) return FileVisitResult.CONTINUE;
      for (const n of children(k)) {
        const r = walk(p.resolve(n));
        if (r === FileVisitResult.TERMINATE) return r;
        if (r === FileVisitResult.SKIP_SIBLINGS) break;
      }
      return visitor.postVisitDirectory ? visitor.postVisitDirectory(p, null) : FileVisitResult.CONTINUE;
    };
    walk(pathOf(start)); return pathOf(start);
  },
  readAttributes: p => { const k = keyOf(p); if (!exists(k)) throw new NoSuchFileException(pathOf(p).toString()); return attrs(k); },
  getLastModifiedTime: p => Files.readAttributes(p).lastModifiedTime(),
  newInputStream: p => new FileInputStream(pathOf(p).toFile()),
  newOutputStream: (p, ...options) => new FileOutputStream(pathOf(p).toFile(), options.includes('APPEND')),
};

// ------------------------------------------------------------------ streams
/** java.io.InputStream; subclasses implement _readInto(b, off, len) -> count | -1. */
export class InputStream {
  read(b, off = 0, len) {
    if (b === undefined) { const one = new Uint8Array(1); return this._readInto(one, 0, 1) === -1 ? -1 : one[0]; }
    if (len === undefined) len = b.length - off;
    if (off < 0 || len < 0 || len > b.length - off) throw new IndexOutOfBoundsException();
    if (len === 0) return 0;
    return this._readInto(b, off, len);
  }
  readAllBytes() { const chunks = []; let total = 0; const buf = new Uint8Array(65536); let n; while ((n = this.read(buf, 0, buf.length)) !== -1) { chunks.push(buf.slice(0, n)); total += n; } const out = new Uint8Array(total); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out; }
  readNBytes(b, off, len) { if (typeof b === 'number') { const out = new Uint8Array(b); const n = this.readNBytes(out, 0, b); return out.slice(0, n); } let n = 0; while (n < len) { const c = this.read(b, off + n, len - n); if (c < 0) break; n += c; } return n; }
  skip(n) { let s = 0; const buf = new Uint8Array(Math.min(n, 8192)); while (s < n) { const c = this.read(buf, 0, Math.min(buf.length, n - s)); if (c < 0) break; s += c; } return s; }
  available() { return 0; }
  transferTo(out) { const b = this.readAllBytes(); out.write(b, 0, b.length); return b.length; }
  close() {}
  _readInto() { return -1; }
}
export class ByteArrayInputStream extends InputStream {
  constructor(buf, offset = 0, length = buf.length - offset) { super(); this.buf = buf; this.pos = offset; this.count = Math.min(offset + length, buf.length); }
  _readInto(b, off, len) { if (this.pos >= this.count) return -1; const n = Math.min(len, this.count - this.pos); b.set(this.buf.subarray(this.pos, this.pos + n), off); this.pos += n; return n; }
  available() { return this.count - this.pos; }
}
const fnf = (f, why) => new FileNotFoundException(f.getPath() + ' (' + why + ')');
/** Reads a snapshot of the file taken when the stream is opened. */
export class FileInputStream extends ByteArrayInputStream {
  constructor(file) {
    const f = file instanceof File ? file : new File(String(file));
    if (isDir(f._key)) throw fnf(f, 'Is a directory');
    const e = store.files.get(f._key); if (!e) throw fnf(f, 'No such file or directory');
    super(e.data);
  }
}
export class BufferedInputStream extends InputStream {
  constructor(input) { super(); this.in = input; }
  _readInto(b, off, len) { return this.in.read(b, off, len); }
  available() { return this.in.available(); }
  close() { this.in.close(); }
}
/** java.io.OutputStream; write(int) | write(bytes[, off, len]). Subclasses implement _writeBytes(b, off, len). */
export class OutputStream {
  write(b, off, len) {
    if (typeof b === 'number') { this._writeBytes(Uint8Array.of(b & 0xFF), 0, 1); return; }
    if (b == null) throw new NullPointerException();
    if (off === undefined) { off = 0; len = b.length; }
    if (off < 0 || len < 0 || off + len > b.length) throw new IndexOutOfBoundsException();
    this._writeBytes(b instanceof Uint8Array ? b : Uint8Array.from(b), off, len);
  }
  flush() {}
  close() {}
  _writeBytes() {}
}
/** Growable byte buffer shared by ByteArrayOutputStream / FileOutputStream. */
class ByteSink {
  constructor(initial) { this.buf = initial && initial.length ? Uint8Array.from(initial) : new Uint8Array(32); this.count = initial ? initial.length : 0; }
  push(b, off, len) { if (this.count + len > this.buf.length) { const n = new Uint8Array(Math.max(this.buf.length * 2, this.count + len)); n.set(this.buf.subarray(0, this.count)); this.buf = n; } this.buf.set(b.subarray(off, off + len), this.count); this.count += len; }
  bytes() { return this.buf.slice(0, this.count); }
}
export class ByteArrayOutputStream extends OutputStream {
  constructor() { super(); this._sink = new ByteSink(); }
  _writeBytes(b, off, len) { this._sink.push(b, off, len); }
  toByteArray() { return this._sink.bytes(); }
  size() { return this._sink.count; }
  reset() { this._sink.count = 0; }
  writeTo(out) { out.write(this._sink.buf, 0, this._sink.count); }
  /** toString() / toString(StandardCharsets.UTF_8) decode UTF-8. */
  toString() { return utf8Decode(this._sink.buf, 0, this._sink.count); }
}
/** Opening truncates (or appends); every write is visible in the file immediately (like an unbuffered FD). */
export class FileOutputStream extends OutputStream {
  constructor(file, append = false) {
    super();
    const f = file instanceof File ? file : new File(String(file));
    if (isDir(f._key)) throw fnf(f, 'Is a directory');
    if (!isDir(parentOf(f._key))) throw fnf(f, 'No such file or directory');
    this._key = f._key; this._closed = false;
    const existing = store.files.get(f._key);
    this._sink = new ByteSink(append && existing ? existing.data : null);
    store.files.set(this._key, { data: this._sink.buf.subarray(0, this._sink.count), mtime: now() }); emit({ type: 'write', path: this._key });
  }
  _writeBytes(b, off, len) {
    if (this._closed) throw new IOException('Stream Closed');
    this._sink.push(b, off, len);
    store.files.set(this._key, { data: this._sink.buf.subarray(0, this._sink.count), mtime: now() });
  }
  flush() { if (!this._closed) emit({ type: 'write', path: this._key }); }
  /** getFD().sync(): data is already in the store, so sync() is a no-op. */
  getFD() { const self = this; return { sync() {}, valid: () => !self._closed }; }
  close() { if (this._closed) return; this._closed = true; if (store.files.has(this._key)) { store.files.set(this._key, { data: this._sink.bytes(), mtime: store.files.get(this._key).mtime }); emit({ type: 'write', path: this._key }); } }
}
export class BufferedOutputStream extends OutputStream {
  constructor(out) { super(); this.out = out; }
  _writeBytes(b, off, len) { this.out.write(b, off, len); }
  flush() { this.out.flush(); }
  close() { this.flush(); this.out.close(); }
}

/** java.io.RandomAccessFile ("r" or "rw"). */
export class RandomAccessFile {
  constructor(file, mode) {
    const f = file instanceof File ? file : new File(String(file));
    if (mode !== 'r' && mode !== 'rw' && mode !== 'rws' && mode !== 'rwd') throw new IllegalArgumentException('Illegal mode "' + mode + '" must be one of "r", "rw", "rws", or "rwd"');
    if (isDir(f._key)) throw fnf(f, 'Is a directory');
    if (!isFile(f._key)) { if (mode === 'r' || !isDir(parentOf(f._key))) throw fnf(f, 'No such file or directory'); writeKey(f._key, new Uint8Array(0), false); }
    this._key = f._key; this._mode = mode; this._pos = 0;
  }
  _data() { return store.files.get(this._key).data; }
  length() { return this._data().length; }
  getFilePointer() { return this._pos; }
  seek(pos) { if (pos < 0) throw new IOException('Negative seek offset'); this._pos = pos; }
  read(b, off = 0, len) {
    const d = this._data();
    if (b === undefined) return this._pos < d.length ? d[this._pos++] : -1;
    if (len === undefined) len = b.length - off;
    if (len === 0) return 0; if (this._pos >= d.length) return -1;
    const n = Math.min(len, d.length - this._pos); b.set(d.subarray(this._pos, this._pos + n), off); this._pos += n; return n;
  }
  readFully(b, off = 0, len = b.length - off) { let n = 0; while (n < len) { const c = this.read(b, off + n, len - n); if (c < 0) throw new EOFException(); n += c; } }
  write(b, off = 0, len) {
    if (this._mode === 'r') throw new IOException('Bad file descriptor');
    const bytes = typeof b === 'number' ? Uint8Array.of(b & 0xFF) : b; if (typeof b === 'number') { off = 0; len = 1; } else if (len === undefined) len = bytes.length - off;
    const d = this._data(); const end = this._pos + len; const out = new Uint8Array(Math.max(d.length, end)); out.set(d); out.set(bytes.subarray(off, off + len), this._pos);
    writeKey(this._key, out, false); this._pos = end;
  }
  setLength(n) { const d = this._data(); const out = new Uint8Array(n); out.set(d.subarray(0, Math.min(n, d.length))); writeKey(this._key, out, false); if (this._pos > n) this._pos = n; }
  close() {}
}

// ------------------------------------------------------------------ character writers
/** java.io.StringWriter. */
export class StringWriter {
  constructor() { this.buf = ''; }
  write(x, off, len) { const t = typeof x === 'number' ? String.fromCharCode(x) : String(x); this.buf += off === undefined ? t : t.substr(off, len); }
  append(x) { this.buf += x == null ? 'null' : String(x); return this; }
  getBuffer() { return this.buf; }
  flush() {}
  close() {}
  toString() { return this.buf; }
}
/** java.io.PrintWriter over a StringWriter (or any writer with write(String)) or an OutputStream (UTF-8). */
export class PrintWriter {
  constructor(out) { if (out == null) throw new NullPointerException(); this.out = out; }
  _w(t) { if (this.out instanceof OutputStream) { const b = utf8Encode(t); this.out.write(b, 0, b.length); } else this.out.write(t); }
  write(x, off, len) { const t = typeof x === 'number' ? String.fromCharCode(x) : String(x); this._w(off === undefined ? t : t.substr(off, len)); }
  print(x) { this._w(typeof x === 'string' ? x : javaToString(x)); }
  println(x) { if (x !== undefined) this.print(x); this._w('\n'); }
  append(x) { this._w(x == null ? 'null' : String(x)); return this; }
  flush() { if (this.out.flush) this.out.flush(); }
  close() { if (this.out.close) this.out.close(); }
}

// ------------------------------------------------------------------ java.util.zip (STORED entries)
export class ZipEntry {
  static STORED = 0; static DEFLATED = 8;
  constructor(name) { if (name == null) throw new NullPointerException('name'); if (utf8Encode(name).length > 0xFFFF) throw new IllegalArgumentException('entry name too long'); this.name = name; this.time = -1; }
  getName() { return this.name; }
  setTime(t) { this.time = t; }
  getTime() { return this.time; }
  isDirectory() { return this.name.endsWith('/'); }
  toString() { return this.name; }
}
/**
 * java.util.zip.ZipOutputStream. Entries are written with method STORED (no compression; the browser has no
 * synchronous deflate). Extracted contents are byte-identical to Java's DEFLATED archive.
 */
export class ZipOutputStream extends OutputStream {
  constructor(out) { super(); this.out = out; this._entries = []; this._cur = null; this._names = new Set(); this._offset = 0; this._finished = false; }
  putNextEntry(e) {
    if (this._cur) this.closeEntry();
    if (this._names.has(e.name)) throw new ZipException('duplicate entry: ' + e.name);
    this._names.add(e.name); if (e.time === -1) e.time = System.currentTimeMillis();
    this._cur = { entry: e, data: new ByteSink() };
  }
  _writeBytes(b, off, len) { if (!this._cur) throw new ZipException('no current ZIP entry'); this._cur.data.push(b, off, len); }
  closeEntry() {
    if (!this._cur) return;
    const { entry, data } = this._cur; this._cur = null;
    const bytes = data.bytes(), name = utf8Encode(entry.name), crc = new CRC32(); crc.update(bytes);
    const [dosTime, dosDate] = dos(entry.time);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 10, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dosTime, true); h.setUint16(12, dosDate, true); h.setUint32(14, crc.getValue(), true);
    h.setUint32(18, bytes.length, true); h.setUint32(22, bytes.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    this._entries.push({ name, crc: crc.getValue(), size: bytes.length, dosTime, dosDate, offset: this._offset });
    this._emit(new Uint8Array(h.buffer)); this._emit(name); this._emit(bytes);
  }
  _emit(b) { this.out.write(b, 0, b.length); this._offset += b.length; }
  finish() {
    if (this._finished) return; if (this._cur) this.closeEntry();
    const start = this._offset;
    for (const e of this._entries) {
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 10, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, e.dosTime, true); c.setUint16(14, e.dosDate, true); c.setUint32(16, e.crc, true); c.setUint32(20, e.size, true); c.setUint32(24, e.size, true);
      c.setUint16(28, e.name.length, true); c.setUint32(42, e.offset, true);
      this._emit(new Uint8Array(c.buffer)); this._emit(e.name);
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, this._entries.length, true); end.setUint16(10, this._entries.length, true);
    end.setUint32(12, this._offset - start, true); end.setUint32(16, start, true);
    this._emit(new Uint8Array(end.buffer)); this._finished = true;
  }
  close() { this.finish(); this.out.close(); }
  setMethod(m) { if (m !== ZipEntry.STORED && m !== ZipEntry.DEFLATED) throw new IllegalArgumentException('invalid compression method'); }
  setLevel() {}
  setComment() { throw new UnsupportedOperationException('zip comments are not supported'); }
}
function dos(ms) { const d = new Date(ms); const y = d.getFullYear(); if (y < 1980) return [0, (1 << 5) | 1]; return [(d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()]; }

/**
 * android.util.AtomicFile (API 30+ behaviour): startWrite() writes "<name>.new"; finishWrite() closes it and renames
 * it over the base file (a failed rename is logged, as on Android); failWrite() closes and deletes it. A leftover "<name>.new" is ignored by readFully().
 */
export class AtomicFile {
  constructor(baseName) { this._base = baseName; this._new = new File(baseName.getPath() + '.new'); }
  getBaseFile() { return this._base; }
  startWrite() { return new FileOutputStream(this._new); }
  finishWrite(str) { if (str == null) return; str.close(); if (!this._new.renameTo(this._base)) Log.e('AtomicFile', 'Failed to rename ' + this._new + ' to ' + this._base); }
  failWrite(str) { if (str == null) return; str.close(); this._new.delete(); }
  delete() { this._base.delete(); this._new.delete(); }
  readFully() { const input = new FileInputStream(this._base); try { return input.readAllBytes(); } finally { input.close(); } }
}
