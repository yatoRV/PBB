// Google sign-in with the Google Identity Services token client (accounts.google.com/gsi/client).
// A session is an access token (about one hour) plus the account's profile from the userinfo endpoint; the app
// opens only with both. The session is kept in sessionStorage (this tab only) so a reload inside the hour does not
// ask again. GIS opens a popup, so signIn() and refresh() must run inside a user gesture (tap/click/key).
// Task A8 (signed in until "Đăng xuất"): the account alone — sub, email, name; never the token — is also kept in
// accountStorage (localStorage). A new tab, a restart or a token past its hour then restores that account without a
// token: the app opens on this device's copy and asks for a token at the next gesture (refresh(), same account
// only). signOut() forgets it.
const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SESSION_KEY = 'lich-di-lam.session';
/** accountStorage key of the remembered account (Task A8). */
export const ACCOUNT_KEY = 'lich-di-lam.account';
/** The remembered account read back, checked (it is outside data: shape and lengths), or null. */
export function checkedAccount(value) {
  const ok = (v, max, min = 0) => typeof v === 'string' && v.length >= min && v.length <= max;
  if (value == null || typeof value !== 'object' || !ok(value.sub, 255, 1) || /\s/.test(value.sub) || !ok(value.email, 320) || !ok(value.name, 200)) return null;
  return { sub: value.sub, email: value.email, name: value.name };
}
/** A token is treated as expired this long before Google's expiry, so a save never starts with a dying token. */
const EXPIRY_MARGIN_MS = 60 * 1000;
const GIS_URL = 'https://accounts.google.com/gsi/client';

/** Why sign-in failed: 'cancelled' (popup closed / access denied), 'scope' (Drive not allowed), 'account'
 *  (another Google account was chosen while renewing), 'failed' (anything else). */
export class SignInError extends Error { constructor(kind, message) { super(message ?? kind); this.name = 'SignInError'; this.kind = kind; } }

/** Loads the GIS script once; resolves to google.accounts.oauth2. */
let gisLoading = null;
export function loadGis(doc = globalThis.document) {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve(globalThis.google.accounts.oauth2);
  if (gisLoading) return gisLoading;
  gisLoading = new Promise((resolve, reject) => {
    const s = doc.createElement('script'); s.src = GIS_URL; s.async = true;
    s.onload = () => (globalThis.google?.accounts?.oauth2 ? resolve(globalThis.google.accounts.oauth2) : reject(new SignInError('failed', 'GIS missing')));
    s.onerror = () => { gisLoading = null; s.remove(); reject(new SignInError('failed', 'GIS not loaded')); };
    doc.head.appendChild(s);
  });
  return gisLoading;
}

export class GoogleAuth {
  /** gis: google.accounts.oauth2 (may be attached later with attachGis); storage: sessionStorage (or null);
   *  accountStorage: localStorage for the remembered account (Task A8; null: none); now(): epoch ms. */
  constructor({ gis = null, fetch, clientId, scopes, storage = null, accountStorage = null, now = () => Date.now() }) {
    this._fetch = fetch; this._storage = storage; this._accounts = accountStorage; this._now = now; this._clientId = clientId; this._scopes = scopes;
    this._gis = null; this._client = null; this._pending = null; this._token = null; this._expiresAt = 0; this.profile = null;
    if (gis) this.attachGis(gis);
  }
  /** Gives the loaded GIS library (restore() works without it; signIn/refresh need it). */
  attachGis(gis) {
    if (this._gis) return;
    this._gis = gis;
    this._client = gis.initTokenClient({
      client_id: this._clientId, scope: this._scopes,
      callback: r => this._settle(r, null),
      error_callback: e => this._settle(null, e),
    });
  }
  _settle(response, error) {
    const p = this._pending; this._pending = null; if (!p) return;
    if (error) p.reject(new SignInError(error.type === 'popup_closed' ? 'cancelled' : 'failed', error.type ?? 'error'));
    else if (response?.error) p.reject(new SignInError(response.error === 'access_denied' ? 'cancelled' : 'failed', response.error));
    else p.resolve(response);
  }
  /** Opens the GIS popup (inside a user gesture) and resolves to the token response. */
  _request(options) {
    if (!this._client) return Promise.reject(new SignInError('failed', 'GIS not loaded'));
    if (this._pending) this._pending.reject(new SignInError('cancelled', 'superseded'));
    return new Promise((resolve, reject) => { this._pending = { resolve, reject }; this._client.requestAccessToken(options); });
  }
  async _profile(token) {
    let res;
    try { res = await this._fetch(USERINFO, { headers: { Authorization: 'Bearer ' + token } }); } catch (e) { throw new SignInError('failed', 'network'); }
    if (!res.ok) throw new SignInError('failed', 'userinfo ' + res.status);
    const p = await res.json();
    if (!p || typeof p.sub !== 'string' || !p.sub) throw new SignInError('failed', 'no account id');
    return { sub: p.sub, email: p.email ?? '', name: p.name ?? '', picture: p.picture ?? '' };
  }
  async _accept(response, expectedSub) {
    if (!this._gis.hasGrantedAllScopes(response, DRIVE_SCOPE)) throw new SignInError('scope');
    const profile = await this._profile(response.access_token);
    if (expectedSub != null && profile.sub !== expectedSub) {
      try { this._gis.revoke(response.access_token, () => {}); } catch (e) { /* best effort */ }
      throw new SignInError('account');
    }
    this._token = response.access_token; this._expiresAt = this._now() + Number(response.expires_in ?? 3599) * 1000; this.profile = profile;
    this._store(); this._remember(profile);
    return profile;
  }
  _store() {
    try { this._storage?.setItem(SESSION_KEY, JSON.stringify({ token: this._token, expiresAt: this._expiresAt, profile: this.profile })); } catch (e) { /* storage blocked */ }
  }

  _remember(profile) {
    const account = checkedAccount({ sub: profile.sub, email: profile.email ?? '', name: profile.name ?? '' });
    try { if (account != null) this._accounts?.setItem(ACCOUNT_KEY, JSON.stringify(account)); } catch (e) { /* storage blocked: this tab only */ }
  }
  /** The remembered account (Task A8), checked; a damaged entry is removed. */
  rememberedAccount() {
    let raw = null; try { raw = this._accounts?.getItem(ACCOUNT_KEY) ?? null; } catch (e) { return null; }
    if (raw == null) return null;
    let account = null; try { account = checkedAccount(JSON.parse(raw)); } catch (e) { account = null; }
    if (account == null) this._forget();
    return account;
  }
  _forget() { try { this._accounts?.removeItem(ACCOUNT_KEY); } catch (e) { /* storage blocked */ } }
  /** Sign-in button: lets the user pick an account, then reads the profile. Resolves to the profile. */
  async signIn() { return this._accept(await this._request({ prompt: 'select_account' }), null); }
  /**
   * Session of this tab kept from before a reload, if its token is still valid: the profile is checked again with
   * userinfo (when that cannot be reached, the unexpired token and stored profile are kept). Otherwise the remembered
   * account (Task A8), without a token (token() is null until refresh()). Resolves to the profile or null.
   */
  async restore() {
    const session = await this._restoreSession();
    if (session != null) return session;
    const account = this.rememberedAccount(); if (account == null) return null;
    this._token = null; this._expiresAt = 0; this.profile = { ...account, picture: '' };
    return this.profile;
  }
  async _restoreSession() {
    let saved = null;
    try { saved = JSON.parse(this._storage?.getItem(SESSION_KEY) ?? 'null'); } catch (e) { saved = null; }
    if (!saved?.token || !saved.profile?.sub || saved.expiresAt - EXPIRY_MARGIN_MS <= this._now()) { this._clearStored(); return null; }
    let profile = saved.profile;
    try { profile = await this._profile(saved.token); } catch (e) { if (e.message !== 'network') { this._clearStored(); return null; } }
    if (profile.sub !== saved.profile.sub) { this._clearStored(); this._forget(); return null; }
    this._token = saved.token; this._expiresAt = saved.expiresAt; this.profile = profile;
    this._remember(profile); // a tab signed in before Task A8 is remembered too
    return profile;
  }
  /** The access token while it is valid, else null. */
  token() { return this._token && this._expiresAt - EXPIRY_MARGIN_MS > this._now() ? this._token : null; }
  /** Forgets the token after Drive answered 401. */
  invalidate() { this._token = null; this._expiresAt = 0; this._store(); }
  /** New token for the same account, inside a user gesture, without the account chooser. */
  async refresh() {
    if (!this.profile) throw new SignInError('failed', 'not signed in');
    const response = await this._request({ prompt: '', login_hint: this.profile.email });
    return this._accept(response, this.profile.sub);
  }
  /** Revokes the token and forgets the session of this tab. */
  async signOut() {
    const token = this._token; this._token = null; this._expiresAt = 0; this.profile = null; this._clearStored(); this._forget();
    if (token && this._gis) await new Promise(resolve => { try { this._gis.revoke(token, () => resolve()); } catch (e) { resolve(); } });
  }
  _clearStored() { try { this._storage?.removeItem(SESSION_KEY); } catch (e) { /* storage blocked */ } }
}
