// android.util.Log replacement. Writes to the console by default; setLogSink() redirects (tests, in-app log).
import { javaStackTrace } from './java.js';

const NAMES = { 2: 'V', 3: 'D', 4: 'I', 5: 'W', 6: 'E', 7: 'A' };
const CONSOLE = { 2: 'debug', 3: 'debug', 4: 'info', 5: 'warn', 6: 'error', 7: 'error' };
let sink = (priority, tag, msg) => console[CONSOLE[priority]](NAMES[priority] + '/' + tag + ': ' + msg); // eslint-disable-line no-console
/** fn(priority, tag, message) or null to restore the console sink. */
export function setLogSink(fn) { sink = fn ?? ((p, t, m) => console[CONSOLE[p]](NAMES[p] + '/' + t + ': ' + m)); } // eslint-disable-line no-console

function println(priority, tag, msg, tr) {
  const text = String(msg) + (tr ? '\n' + Log.getStackTraceString(tr) : '');
  sink(priority, String(tag), text);
  return text.length;
}
export const Log = {
  VERBOSE: 2, DEBUG: 3, INFO: 4, WARN: 5, ERROR: 6, ASSERT: 7,
  v: (tag, msg, tr) => println(2, tag, msg, tr),
  d: (tag, msg, tr) => println(3, tag, msg, tr),
  i: (tag, msg, tr) => println(4, tag, msg, tr),
  /** w(tag, msg[, tr]) or w(tag, tr). */
  w: (tag, msg, tr) => (msg instanceof Error ? println(5, tag, '', msg) : println(5, tag, msg, tr)),
  e: (tag, msg, tr) => println(6, tag, msg, tr),
  wtf: (tag, msg, tr) => (msg instanceof Error ? println(7, tag, '', msg) : println(7, tag, msg, tr)),
  isLoggable: () => true,
  println: (priority, tag, msg) => println(priority, tag, msg),
  /** Same text as Android: printStackTrace into a StringWriter (ends with a newline). */
  getStackTraceString(tr) { return tr == null ? '' : javaStackTrace(tr) + '\n'; }
};
