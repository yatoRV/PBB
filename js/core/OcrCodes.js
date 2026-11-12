// Port of vn.lichdilam.OcrCodes (APK 4.5).
import { trim, Character } from '../platform/java.js';
import { Schedule } from './Schedule.js';
import { PipeDay } from './PipeDay.js';

/** OCR-only visual substitutions. Missing characters never get filled from a work pattern. */
export class OcrCodes {
  static pipeCodeCandidate(raw) {
    // Preserve the explicitly printed D23 in assignment sheets. Never turn
    // it into C23, nor broaden the separate work-roster code recognizer.
    const value = trim(raw).toUpperCase();
    if (value === 'D23' || value === 'DZ3') return 'D23';
    if (value === 'CZ3') return 'C23';
    return OcrCodes.candidate(raw);
  }
  static pipeCandidate(raw) {
    const value = OcrCodes.pipeObservation(raw);
    // The supplied sheets use pipes 9–22. A partial "2" is not evidence for 20 or 22 and must retry.
    return value != null && /^[0-9]+$/.test(value) && !/^(?:9|1[0-9]|2[0-2])$/.test(value) ? null : value;
  }
  /** Preserve out-of-range numbers as observations for conflict voting, but never commit them as pipes. */
  static pipeObservation(raw) {
    const exact = PipeDay.pipeValue(raw); if (exact != null) return exact;
    const s = trim(raw).toUpperCase();
    // Only a letter in an otherwise numeric, single assignment. Do not join
    // multiple numbers, invent a missing digit, or reverse 6 and 9.
    if (/^[0-9][0-9SIL]{1,2}$/.test(s)) return PipeDay.pipeValue(s.replace(/S/g, '5').replace(/I/g, '1').replace(/L/g, '1'));
    return null;
  }
  static dutyCandidate(raw) {
    let s = trim(raw).toUpperCase().replace(/[ \t\n\x0B\f\r]+/g, '');
    if (s === 'TCI' || s === 'TCL') s = 'TC1';
    return PipeDay.dutyValue(s, true);
  }
  /** Vietnamese uses only grave, acute, tilde, hook, dot below, circumflex, breve and horn. Any other mark
   *  (ü, ä, ö, å, č…) in a name is an OCR artefact; it is removed, never replaced by a guessed Vietnamese mark. */
  static vietnameseName(raw) {
    if (raw == null) return ''; const decomposed = raw.normalize('NFD'); const out = [];
    for (let i = 0; i < decomposed.length; i++) { const c = decomposed.charAt(i);
      if (Character.getType(c) === Character.NON_SPACING_MARK && '\u0300\u0301\u0303\u0309\u0323\u0302\u0306\u031B'.indexOf(c) < 0) continue;
      out.push(c); }
    // A person's name has no digits: a 0 touching letters ("Ng0c") is the letter o. Its accent stays unknown.
    for (let i = 0; i < out.length; i++) { if (out[i] !== '0') continue;
      const before = i > 0 ? out[i - 1] : ' ', after = i + 1 < out.length ? out[i + 1] : ' ';
      if (!Character.isLetter(before) && !Character.isLetter(after)) continue;
      const upper = Character.isLetter(before) ? Character.isUpperCase(before) && (!Character.isLetter(after) || Character.isUpperCase(after)) : Character.isUpperCase(after) && i + 2 < out.length && Character.isUpperCase(out[i + 2]);
      out[i] = upper ? 'O' : 'o'; }
    return out.join('').normalize('NFC');
  }
  static initialResult(raw, blank) {
    const code = Schedule.normalizeShift(raw);
    if (code != null) return code;
    // Non-code letters are evidence of text, even if the pixel check sees little contrast.
    return blank && raw.replace(/[ \t\n\x0B\f\r|_[\]]/g, '') === '' ? '' : null;
  }

  /** Work-roster votes (3.0, 26/10): the bold 6 of D6 read as G. Measured over every OCR variant of 17 work-roster
   *  scans (25/10 photo, its re-shot copies, the user's half sheet): "DG" 28× — all on D6 cells, never another code.
   *  Only a vote, like the S17 forms: without an exact code it needs four agreeing variants. */
  static workCandidate(raw) {
    const code = OcrCodes.candidate(raw); if (code != null) return code;
    const s = raw.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return s === 'DG' ? 'D6' : null;
  }
  static candidate(raw) {
    const exact = Schedule.normalizeShift(raw); if (exact != null) return exact;
    const s = raw.normalize('NFD').replace(/\p{M}/gu, '')
      .toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (/^[S5][1IL][0ODQC]$/.test(s)) return 'S10';
    if (/^[S5][1IL]7$/.test(s)) return 'S17';
    // 3.0, measured on the 25/10 work roster (~35 rows, every OCR variant): the bold/italic 7 of S17 is read as
    // Z, 2, 1 or I ("SIZ" 26×, "SI1" 20×, "S11" 14×, "S12" 8×, "SI2" 7×, "SII" 5×), never by any S10 cell, whose
    // round 0 reads as O/D/Q/A/U. Only a vote: without an exact code it needs four agreeing variants.
    if (/^(?:[S5][1IL][Z2]|[S5][1IL][1I])$/.test(s)) return 'S17';
    if (/^[S5]26$/.test(s)) return 'S26';
    return null;
  }
}
