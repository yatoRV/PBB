// Google Drive v3 REST calls used by the autosave. The app asks only for the drive.file scope, so Drive shows it
// nothing but the files and folders this app created. Every call carries the current access token; a 401 becomes
// AuthError (a new token is needed), a rejected fetch becomes NetworkError (offline), any other failure DriveError.
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
/** Above this size an upload uses a resumable session (multipart/media uploads are limited to 5 MB). */
export const SIMPLE_UPLOAD_LIMIT = 5 * 1024 * 1024;

export class AuthError extends Error { constructor(message) { super(message); this.name = 'AuthError'; } }
export class NetworkError extends Error { constructor(message) { super(message); this.name = 'NetworkError'; } }
export class DriveError extends Error {
  constructor(status, body) { super('Drive ' + status + (body ? ': ' + String(body).slice(0, 300) : '')); this.name = 'DriveError'; this.status = status; }
}

/** Drive query string literal: backslash and quote escaped. */
const quote = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
const utf8 = s => new TextEncoder().encode(s);

export class DriveApi {
  /** fetch: the fetch function; getToken(): the current access token or null. */
  constructor({ fetch, getToken }) { this._fetch = fetch; this._getToken = getToken; }

  async _call(url, init = {}) {
    const token = this._getToken();
    if (!token) throw new AuthError('no token');
    let res;
    try { res = await this._fetch(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: 'Bearer ' + token } }); }
    catch (e) { throw new NetworkError(e?.message ?? String(e)); }
    if (res.status === 401) throw new AuthError('401');
    if (!res.ok) { let body = ''; try { body = await res.text(); } catch (e) { /* no body */ } throw new DriveError(res.status, body); }
    return res;
  }
  async _json(url, init) { const res = await this._call(url, init); try { return await res.json(); } catch (e) { throw new NetworkError(e?.message ?? String(e)); } }

  /** Every file matching the query (all pages), oldest first. */
  async list(q, fields = 'id,name,version,modifiedTime,createdTime') {
    const out = []; let page = null;
    do {
      const params = new URLSearchParams({ q, spaces: 'drive', orderBy: 'createdTime', pageSize: '1000', fields: 'nextPageToken,files(' + fields + ')' });
      if (page) params.set('pageToken', page);
      const r = await this._json(API + '?' + params.toString());
      out.push(...(r.files ?? [])); page = r.nextPageToken ?? null;
    } while (page);
    return out;
  }
  /** Folders with this name the app can see (not trashed), oldest first. */
  listFolders(name) { return this.list('name = ' + quote(name) + ' and mimeType = ' + quote(FOLDER_MIME) + ' and trashed = false'); }
  /** Id of the oldest folder with this name the app can see, created if there is none. */
  async findOrCreateFolder(name) {
    const found = await this.listFolders(name);
    if (found.length) return found[0].id;
    const r = await this._json(API + '?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ name, mimeType: FOLDER_MIME }) });
    return r.id;
  }
  /** Files (not trashed) directly inside a folder. */
  listFolder(folderId) { return this.list(quote(folderId) + ' in parents and trashed = false'); }
  /** Metadata of a file (e.g. fields 'id,version,trashed'); DriveError 404 when it no longer exists. */
  get(id, fields = 'id,version,trashed') { return this._json(API + '/' + encodeURIComponent(id) + '?fields=' + encodeURIComponent(fields)); }
  /** Content of a file. */
  async download(id) {
    const res = await this._call(API + '/' + encodeURIComponent(id) + '?alt=media');
    try { return new Uint8Array(await res.arrayBuffer()); } catch (e) { throw new NetworkError(e?.message ?? String(e)); }
  }
  /**
   * Creates (id == null, inside `parent`) or overwrites (id given) a file's content; resolves to { id, version, trashed }
   * (version: Drive's change counter of the file, as a string; trashed: the file is in the Drive trash).
   * Up to 5 MB: one multipart (create) or media (update) request; above: a resumable session, sent in one PUT.
   */
  async upload({ id = null, name, parent, bytes, mime }) {
    if (bytes.length > SIMPLE_UPLOAD_LIMIT) return this._resumable({ id, name, parent, bytes, mime });
    if (id != null) {
      const r = await this._json(UPLOAD + '/' + encodeURIComponent(id) + '?uploadType=media&fields=id,version,trashed', { method: 'PATCH', headers: { 'Content-Type': mime }, body: bytes });
      return { id: r.id, version: String(r.version), trashed: r.trashed === true };
    }
    const boundary = 'lichdilam' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const head = utf8('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({ name, parents: [parent] })
      + '\r\n--' + boundary + '\r\nContent-Type: ' + mime + '\r\n\r\n');
    const tail = utf8('\r\n--' + boundary + '--\r\n');
    const body = new Uint8Array(head.length + bytes.length + tail.length); body.set(head, 0); body.set(bytes, head.length); body.set(tail, head.length + bytes.length);
    const r = await this._json(UPLOAD + '?uploadType=multipart&fields=id,version,trashed', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body });
    return { id: r.id, version: String(r.version), trashed: r.trashed === true };
  }
  async _resumable({ id, name, parent, bytes, mime }) {
    const start = await this._call(id != null ? UPLOAD + '/' + encodeURIComponent(id) + '?uploadType=resumable&fields=id,version,trashed' : UPLOAD + '?uploadType=resumable&fields=id,version,trashed', {
      method: id != null ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(bytes.length) },
      body: JSON.stringify(id != null ? {} : { name, parents: [parent] }),
    });
    const session = start.headers.get('Location');
    if (!session) throw new DriveError(start.status, 'no upload session');
    const r = await this._json(session, { method: 'PUT', headers: { 'Content-Type': mime }, body: bytes });
    return { id: r.id, version: String(r.version), trashed: r.trashed === true };
  }
  /** Moves a file (or a folder with its content) to the Drive trash (recoverable for 30 days). */
  async trash(id) {
    await this._call(API + '/' + encodeURIComponent(id) + '?fields=id', { method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ trashed: true }) });
  }
}
