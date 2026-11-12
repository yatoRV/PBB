// android.media.MediaPlayer subset for the notification tones (ReminderActivity, NotificationTonePicker and the
// in-page reminder runner). The 226 bundled tones are Ogg Vorbis files (assets/tones/<resource>.ogg, the APK's
// res/raw, unconverted). A tone is fetched and decoded lazily when it is played:
//   1. the browser's own decoder (AudioContext.decodeAudioData) where it reads Ogg Vorbis (Chrome, Firefox);
//   2. otherwise the pinned in-browser decoder @wasm-audio-decoders/ogg-vorbis 0.1.20 from jsDelivr (iOS Safari);
// and played through WebAudio. Without WebAudio an <audio> element plays the file where the browser can.
// iOS lets a page start sound only after a user gesture: installUnlock(doc) resumes the shared AudioContext on the
// first tap, so a reminder that fires later (page open) can still sound.
// Nothing here touches the document at import; under Node every player fails with onError (no audio).
import { assetUrl } from './assets.js';

const DECODER_URL = 'https://cdn.jsdelivr.net/npm/@wasm-audio-decoders/ogg-vorbis@0.1.20/dist/ogg-vorbis-decoder.min.js';
/** Subresource Integrity of that exact file (sha384 of the npm package file, identical to the jsDelivr copy). */
const DECODER_SRI = 'sha384-sdxz6qCuF82t3WXLw64JQQQV+ZWn2xEeS4QBBwtjTnDoexf2ik71oUbw7gwlYjAi';
const BUNDLED = 'content://vn.lichdilam.bundled-tones/';
const RESOURCE = /^tone_[a-z0-9_]+$/;
const CACHE_SIZE = 8;

let context = null, decoderScript = null;
const buffers = new Map(); // url → Promise<AudioBuffer>

/** Asset URL of a bundled tone URI ("content://vn.lichdilam.bundled-tones/tone_x"), else null (no web file). */
export function toneUrl(uri) {
  const s = uri == null ? '' : String(uri); if (!s.startsWith(BUNDLED)) return null;
  const resource = s.substring(BUNDLED.length); return RESOURCE.test(resource) ? assetUrl('tones/' + resource + '.ogg').href : null;
}
/** The shared AudioContext (created on first use), or null without WebAudio. */
export function audioContext() {
  if (context != null) return context; const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext; if (typeof Ctor !== 'function') return null;
  try { context = new Ctor(); } catch (e) { context = null; } return context;
}
/** Resumes audio on the first user gesture(s), as iOS requires. */
export function installUnlock(doc = globalThis.document) {
  if (doc == null) return () => {};
  const unlock = () => { const ctx = audioContext(); if (ctx == null) return; if (ctx.state !== 'running') ctx.resume().catch(() => {});
    else { // a silent buffer started inside the gesture keeps iOS audio unlocked
      try { const b = ctx.createBuffer(1, 1, 22050); const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0); } catch (ignored) { /* nothing */ }
    } };
  const events = ['pointerdown', 'touchend', 'keydown']; for (const e of events) doc.addEventListener(e, unlock, { passive: true, capture: true });
  return () => { for (const e of events) doc.removeEventListener(e, unlock, { capture: true }); };
}
function loadDecoder() {
  const ready = () => globalThis['ogg-vorbis-decoder']?.OggVorbisDecoder;
  if (ready()) return Promise.resolve(ready());
  if (decoderScript == null) decoderScript = new Promise((resolve, reject) => {
    const doc = globalThis.document; if (doc == null) { reject(new Error('no document')); return; }
    const s = doc.createElement('script'); s.src = DECODER_URL; s.async = true; s.crossOrigin = 'anonymous'; s.integrity = DECODER_SRI;
    s.onload = () => (ready() ? resolve(ready()) : reject(new Error('decoder missing'))); s.onerror = () => { decoderScript = null; reject(new Error('decoder not loaded')); };
    doc.head.append(s);
  });
  return decoderScript;
}
/** Decodes Ogg Vorbis bytes with the wasm decoder into an AudioBuffer of ctx. */
export async function decodeOgg(ctx, bytes) {
  const Decoder = await loadDecoder(); const decoder = new Decoder();
  try {
    await decoder.ready; const r = await decoder.decodeFile(bytes);
    if (r.samplesDecoded <= 0 || r.channelData.length === 0) throw new Error('no samples');
    const buffer = ctx.createBuffer(r.channelData.length, r.samplesDecoded, r.sampleRate);
    r.channelData.forEach((data, i) => buffer.copyToChannel(data.subarray(0, r.samplesDecoded), i)); return buffer;
  } finally { decoder.free(); }
}
async function decodeTone(ctx, url) {
  const response = await fetch(url); if (!response.ok) throw new Error('HTTP ' + response.status);
  const bytes = new Uint8Array(await response.arrayBuffer());
  try { return await ctx.decodeAudioData(bytes.slice().buffer); } catch (native) { return decodeOgg(ctx, bytes); }
}
function buffer(ctx, url) {
  let p = buffers.get(url);
  if (p == null) { p = decodeTone(ctx, url); buffers.set(url, p); p.catch(() => buffers.delete(url)); while (buffers.size > CACHE_SIZE) buffers.delete(buffers.keys().next().value); }
  else { buffers.delete(url); buffers.set(url, p); }
  return p;
}

/** android.media.MediaPlayer: setDataSource → prepareAsync → onPrepared → start → onCompletion; release(). */
export class MediaPlayer {
  /** Number of tones started in this page (the web counterpart of the audio mixer's playback callback). */
  static startCount = 0;
  constructor() { this._url = null; this._prepared = null; this._completion = null; this._error = null; this._source = null; this._audio = null; this._buffer = null; this._released = false; }
  setAudioAttributes(ignored) {} // eslint-disable-line no-unused-vars
  setOnPreparedListener(fn) { this._prepared = fn; }
  setOnCompletionListener(fn) { this._completion = fn; }
  setOnErrorListener(fn) { this._error = fn; }
  setDataSource(contextOrUri, maybeUri) { const uri = maybeUri === undefined ? contextOrUri : maybeUri; this._url = toneUrl(uri); if (this._url == null) throw new Error('Tệp âm không đọc được.'); }
  _fail() { if (this._released) return; if (this._error != null) this._error(this, 1, 0); }
  prepareAsync() {
    const ctx = audioContext(); const url = this._url;
    if (ctx == null) {
      const audio = typeof Audio === 'function' ? new Audio() : null;
      if (audio == null || audio.canPlayType('audio/ogg; codecs="vorbis"') === '') { Promise.resolve().then(() => this._fail()); return; }
      this._audio = audio; audio.preload = 'auto'; audio.src = url;
      audio.addEventListener('canplaythrough', () => { if (!this._released && this._prepared != null) this._prepared(this); }, { once: true });
      audio.addEventListener('error', () => this._fail(), { once: true }); audio.addEventListener('ended', () => { if (!this._released && this._completion != null) this._completion(this); });
      audio.load(); return;
    }
    buffer(ctx, url).then(b => { if (this._released) return; this._buffer = b; if (this._prepared != null) this._prepared(this); }, () => this._fail());
  }
  start() {
    if (this._released) return;
    if (this._audio != null) { this._audio.play().then(() => { MediaPlayer.startCount++; }, () => this._fail()); return; }
    const ctx = audioContext(); if (ctx == null || this._buffer == null) throw new Error('not prepared');
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    const source = this._source = ctx.createBufferSource(); source.buffer = this._buffer; source.connect(ctx.destination);
    source.onended = () => { if (this._source === source && !this._released && this._completion != null) this._completion(this); };
    source.start(0); MediaPlayer.startCount++;
  }
  /** True while the audio output is actually running (an iOS page without a prior tap stays suspended). */
  isAudible() { if (this._audio != null) return !this._audio.paused; const ctx = audioContext(); return ctx != null && ctx.state === 'running' && this._source != null; }
  release() {
    this._released = true;
    if (this._source != null) { try { this._source.onended = null; this._source.stop(); } catch (ignored) { /* not started */ } try { this._source.disconnect(); } catch (ignored) { /* gone */ } this._source = null; }
    if (this._audio != null) { this._audio.pause(); this._audio.removeAttribute('src'); this._audio.load(); this._audio = null; }
    this._buffer = null;
  }
}
