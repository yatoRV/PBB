// Port of vn.lichdilam.PipeFieldVotes (APK 4.5). LinkedHashMap<String,Integer> → Map (insertion order).
// Java \s is ASCII-only: written as [ \t\n\x0B\f\r].
import { trim, split } from '../platform/java.js';
import { OcrCodes } from './OcrCodes.js';
import { Schedule } from './Schedule.js';

const Field = Object.freeze({ CODE: 'CODE', PIPE: 'PIPE', DUTY: 'DUTY', values: () => ['CODE', 'PIPE', 'DUTY'] });
const TWO_NUMBERS = /^[0-9]+[ \t\n\x0B\f\r,;/.-]+[0-9]+$/;
const NUMBER_GAP = /[ \t\n\x0B\f\r,;/.-]+/;
const candidate = (field, text) => (field === Field.CODE ? OcrCodes.pipeCodeCandidate(text) : field === Field.PIPE ? OcrCodes.pipeObservation(text) : OcrCodes.dutyCandidate(text));

/** Independent OCR views of one physical cell. Never borrow a value from another date. */
export class PipeFieldVotes {
  static Field = Field;
  constructor(field) { this._field = field; this._readings = []; }
  add(raw) { this._readings.push(raw == null ? '' : raw); }
  value() {
    const field = this._field; const votes = new Map();
    for (const raw of this._readings) {
      let text = trim(raw);
      if (field === Field.PIPE && TWO_NUMBERS.test(text)) {
        // Two different numbers in one cell ("17, 19") never select a position. The same number read
        // twice by one pass ("21 21") is one reading of that number.
        const numbers = split(text, NUMBER_GAP); if (numbers.length !== 2 || numbers[0] !== numbers[1]) return null; text = numbers[0];
      }
      const value = candidate(field, text);
      // Silence is not evidence of a blank: that is decided from pixels separately.
      if (value != null && value !== '') votes.set(value, (votes.get(value) ?? 0) + 1);
    }
    if (votes.size === 0) return null;
    let topKey = null, topValue = 0; let others = 0, conflicting = 0;
    for (const [k, v] of votes) if (topKey === null || v > topValue) { topKey = k; topValue = v; }
    for (const [k, v] of votes) if (k !== topKey) {
      if (v === topValue) return null;
      // A reading that only lost characters of the leading value (11 → 1) is a partial view of the same
      // print; a reading with a different character (16 vs 15) conflicts with it.
      if (!topKey.includes(k)) conflicting += v;
      others += v;
    }
    // A conflict keeps the field unresolved unless the leading value is overwhelming: one upside-down 6
    // among eight 9s, measured on the real October scan, must not discard the eight agreeing readings.
    if (conflicting > 0 && (topValue < 4 || topValue < 4 * conflicting)) return null;
    if (others > 0 && (topValue < 3 || topValue < 2 * others)) return null;
    // Printed "TC" is also what a TC1–TC3 read with a lost digit looks like: require a clear majority.
    if (field === Field.DUTY && topKey === 'TC' && topValue < 3) return null;
    return topValue >= 2 ? (field === Field.PIPE ? OcrCodes.pipeCandidate(topKey) : topKey) : null;
  }
  readings() { return this._readings.length; }
  all() { return Object.freeze([...this._readings]); }
  /** What the separate readings of one stored field said, most frequent first ("9 ×8, 6 ×1"), for the user. */
  static summary(field, rawField) {
    const count = new Map();
    for (const r of split(rawField, / \/ /, -1)) { const t = trim(r); const v = candidate(field, t); if (v != null && v !== '') { const k = Schedule.displayCode(v); count.set(k, (count.get(k) ?? 0) + 1); } }
    const list = [...count.entries()]; list.sort((a, b) => b[1] - a[1]); let s = '';
    for (const [k, v] of list) s += (s.length === 0 ? '' : ', ') + k + ' ×' + v; return s;
  }
  /** Some reading held two different numbers: the cell may print two positions and must stay unresolved. */
  static twoNumbers(rawField) { for (const r of split(rawField, / \/ /, -1)) { const t = trim(r); if (TWO_NUMBERS.test(t)) { const n = split(t, NUMBER_GAP); if (n.length !== 2 || n[0] !== n[1]) return true; } } return false; }
  hasText() { for (const raw of this._readings) if (raw.replace(/[ \t\n\x0B\f\r|_[\]]/g, '') !== '') return true; return false; }
  raw() { return this._readings.join(' / '); }
}
