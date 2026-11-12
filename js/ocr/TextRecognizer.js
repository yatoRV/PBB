// Replacement for the ML Kit text-recognition API used by RosterReader and PipeRosterReader
// (com.google.mlkit.vision.text.*, InputImage, Tasks.await). The readers keep their Java shape:
//
//   Text result = await Tasks.await(recognizer.process(InputImage.fromBitmap(b, 0)), 60, TimeUnit.SECONDS);
//   for (const block of result.getTextBlocks()) for (const line of block.getLines()) for (const element of line.getElements()) {
//     const box = element.getBoundingBox(); … element.getText() …
//   }
//
// The recognition itself is done by an injected engine (TextRecognition.setEngine). An engine is any object with
//   async process(bitmap, { signal }) → TextResult   (bitmap: js/platform/bitmap.js Bitmap, RGBA, read-only, not
//                                        kept; signal: AbortSignal, aborted when Tasks.await stops waiting — an engine
//                                        may then stop its work and reject; the result is not read any more)
//   close()                              (optional; releases the engine)
// where TextResult is a Text, or a plain object
//   { text?, textBlocks: [ { text?, boundingBox, lines: [ { text?, boundingBox, elements: [ { text, boundingBox } ] } ] } ] }
// and boundingBox is a Rect, { left, top, right, bottom } in pixels of the given bitmap (integers), or null.
// Missing texts are derived like ML Kit: a line is its elements joined by " ", a block its lines joined by "\n",
// the whole Text its blocks joined by "\n". Only the API surface the readers use is reproduced (no corner points,
// confidences or languages: the APK never reads them).
// Engine obligations:
//  - Order as ML Kit: blocks and the lines of a block top to bottom, the elements of a line left to right. The
//    readers concatenate words of one tile/cell/field in that order (only readNames sorts by left edge).
//  - Copy the pixels it needs before its first await. A reader stops waiting after 60 s (TimeoutException) or when
//    its job is interrupted (InterruptedException), and may then recycle the bitmap while the engine still runs.
import { JavaException, IllegalStateException, InterruptedException, TimeoutException, ExecutionException, Thread } from '../platform/java.js';
import { Rect } from '../platform/bitmap.js';

/** java.util.concurrent.TimeoutException (Tasks.await ran out of time) and ExecutionException (the recognition task
 *  failed; the cause is the engine's error), from js/platform/java.js. */
export { TimeoutException, ExecutionException };

/** For engines: the bitmap's RGBA pixels (its own array, read synchronously — copy what is needed before the first
 *  await). A recycled bitmap throws IllegalStateException, as ML Kit refuses a recycled Bitmap. */
export function checkedPixels(bitmap) {
  if (bitmap == null || (typeof bitmap.isRecycled === 'function' && bitmap.isRecycled()) || bitmap.data == null) throw new IllegalStateException("Can't process a recycled bitmap");
  return bitmap.data;
}

function rect(box) {
  if (box == null) return null;
  if (box instanceof Rect) return new Rect(box);
  return new Rect(box.left, box.top, box.right, box.bottom);
}
const textOf = (value, parts, separator) => (value != null ? String(value) : parts.map(p => p.getText()).join(separator));

/** Text.Element: one word. */
class Element {
  constructor(text, boundingBox) { this._text = text == null ? '' : String(text); this._box = rect(boundingBox); Object.freeze(this); }
  getText() { return this._text; }
  /** android.graphics.Rect, or null. */
  getBoundingBox() { return this._box == null ? null : new Rect(this._box); }
}
/** Text.Line: words of one line. */
class Line {
  constructor(text, boundingBox, elements) { this._elements = Object.freeze(elements); this._text = textOf(text, elements, ' '); this._box = rect(boundingBox); Object.freeze(this); }
  getText() { return this._text; }
  getBoundingBox() { return this._box == null ? null : new Rect(this._box); }
  getElements() { return this._elements; }
}
/** Text.TextBlock: a paragraph of lines. */
class TextBlock {
  constructor(text, boundingBox, lines) { this._lines = Object.freeze(lines); this._text = textOf(text, lines, '\n'); this._box = rect(boundingBox); Object.freeze(this); }
  getText() { return this._text; }
  getBoundingBox() { return this._box == null ? null : new Rect(this._box); }
  getLines() { return this._lines; }
}
/** com.google.mlkit.vision.text.Text: the result of one recognition. */
export class Text {
  static TextBlock = TextBlock; static Line = Line; static Element = Element;
  constructor(text, textBlocks) { this._blocks = Object.freeze(textBlocks); this._text = textOf(text, textBlocks, '\n'); Object.freeze(this); }
  getText() { return this._text; }
  getTextBlocks() { return this._blocks; }
  /** A Text from an engine's plain result (see the file header); a Text is returned unchanged. */
  static from(result) {
    if (result instanceof Text) return result;
    if (result == null) throw new IllegalStateException('Text recognizer returned no result');
    const blocks = (result.textBlocks ?? []).map(b => new TextBlock(b.text, b.boundingBox,
      (b.lines ?? []).map(l => new Line(l.text, l.boundingBox, (l.elements ?? []).map(e => new Element(e.text, e.boundingBox))))));
    return new Text(result.text, blocks);
  }
}

/** InputImage.fromBitmap(bitmap, rotationDegrees): the readers always pass 0. */
export const InputImage = Object.freeze({
  fromBitmap(bitmap, rotationDegrees) { return Object.freeze({ bitmap, rotationDegrees }); },
});
/** TextRecognizerOptions.DEFAULT_OPTIONS (Latin script). */
export const TextRecognizerOptions = Object.freeze({ DEFAULT_OPTIONS: Object.freeze({ script: 'latin' }) });

let engine = null;
/** The client of TextRecognition.getClient: forwards each image to the installed engine. */
export class TextRecognizer {
  constructor(options) { this.options = options; this._closed = false; }
  /** Promise of the Text of the image (the Task of ML Kit). Rejects when no engine is installed or it fails.
   *  task.cancel() (called by Tasks.await when it stops waiting) aborts the engine's signal. */
  process(image) {
    if (this._closed) return Promise.reject(new IllegalStateException('Text recognizer is closed'));
    const current = engine;
    if (current == null) return Promise.reject(new IllegalStateException('No text recognition engine installed'));
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const task = Promise.resolve().then(() => current.process(image.bitmap, { signal: ac?.signal })).then(Text.from);
    task.cancel = () => ac?.abort();
    return task;
  }
  /** The client is closed; the shared engine stays loaded for the next reader (it is created once per page). */
  close() { this._closed = true; }
}
export const TextRecognition = Object.freeze({
  getClient(options) { return new TextRecognizer(options); },
  /** Installs the engine used by every client (null removes it). The previous engine is not closed. */
  setEngine(e) { engine = e ?? null; },
  getEngine() { return engine; },
});

/** java.util.concurrent.TimeUnit (the units Tasks.await is given). */
export const TimeUnit = Object.freeze({
  MILLISECONDS: Object.freeze({ toMillis: d => d }),
  SECONDS: Object.freeze({ toMillis: d => d * 1000 }),
  MINUTES: Object.freeze({ toMillis: d => d * 60000 }),
});
/** com.google.android.gms.tasks.Tasks.await(task, timeout, unit): the task's result, ExecutionException when the
 *  task failed, TimeoutException when it took longer than the timeout, InterruptedException when the calling thread
 *  (js/platform/java.js Thread.currentThread(), a worker of an ExecutorService) is interrupted before or while it
 *  waits — like the CountDownLatch.await underneath, the interrupt flag is then cleared. */
export const Tasks = Object.freeze({
  await(task, timeout, unit) {
    const thread = Thread.currentThread();
    // Giving up (interrupt, timeout) cancels the task when it can be (TextRecognizer: the engine may drop the work).
    const giveUp = () => { try { task?.cancel?.(); } catch { /* not cancellable */ } };
    if (thread.isInterrupted()) { Thread.interrupted(); Promise.resolve(task).catch(() => {}); giveUp(); return Promise.reject(new InterruptedException()); }
    let timer = null, unregister = null;
    const limit = new Promise((resolve, reject) => { timer = setTimeout(() => { giveUp(); reject(new TimeoutException('Timed out waiting for Task')); }, unit.toMillis(timeout)); });
    const interrupt = new Promise((resolve, reject) => { unregister = thread._onInterrupt(() => { thread._interrupted = false; giveUp(); reject(new InterruptedException()); }); });
    const result = Promise.resolve(task).then(v => v, failure => { throw new ExecutionException(failure instanceof Error ? failure : new JavaException(String(failure))); });
    return Promise.race([result, limit, interrupt]).finally(() => { clearTimeout(timer); unregister(); });
  },
});
