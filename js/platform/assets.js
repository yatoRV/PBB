// Context.getAssets().open(path) replacement. Assets live in WEB/assets/ (copied unchanged from the APK's
// src/main/assets, plus tones/ = res/raw/*.ogg and icon.png). Browser: fetch; Node: fs. Async.
import { FileNotFoundException } from './java.js';
import { ByteArrayInputStream } from './files.js';

const isNode = typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined';
let base = new URL('../../assets/', import.meta.url);
/** Overrides the assets base URL (must end with '/'). */
export function setAssetBase(url) { base = new URL(url, typeof location !== 'undefined' ? location.href : undefined); }
export function assetUrl(path) { return new URL(String(path).replace(/^\/+/, ''), base); }

/** Bytes of an asset; rejects with FileNotFoundException(path) when missing (like AssetManager.open). */
export async function openAsset(path) {
  const url = assetUrl(path);
  if (isNode && url.protocol === 'file:') {
    const fs = await import('node:fs/promises');
    try { return new Uint8Array(await fs.readFile(url)); } catch { throw new FileNotFoundException(String(path)); }
  }
  const res = await fetch(url);
  if (!res.ok) throw new FileNotFoundException(String(path));
  return new Uint8Array(await res.arrayBuffer());
}
/** InputStream over an asset, for line-by-line ports of `context.getAssets().open(name)`. */
export async function openAssetStream(path) { return new ByteArrayInputStream(await openAsset(path)); }
/** Asset decoded as UTF-8 text. */
export async function openAssetText(path) { return new TextDecoder('utf-8').decode(await openAsset(path)); }
