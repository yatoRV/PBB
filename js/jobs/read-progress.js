// Percent and time left of a reading job (web only, Task A2), from real work: the readers' own progress messages
// (the APK strings, unchanged) say which stage runs; inside a stage, every finished OCR call and the time spent move
// the bar towards the stage's end without ever reaching it. Each stage starts at the share of the whole read it
// started at in a measured read (READ_STAGES), and the time a stage is expected to take is that share of the measured
// read, scaled by how fast this device was on the stages before. The percent never goes back and is 100 only when the
// read is done: a message of an earlier stage (the photo tried turned) holds the bar until the work catches up.
// Pure logic (no DOM): js/ui/ReadProgressBar.js draws it.

/** One stage: the message pattern, where it starts (0–1 of the read; of one photo for pipe sheets), how many OCR calls
 *  it usually makes, and `count`: the message says "i / n" (the i-th n-th of the stage). */
const stage = (key, re, at, calls, count = false) => ({ key, re, at, calls, count });

/**
 * Calibration (Task A2, node 24 + onnxruntime-node, the 25/10 photos, first read with checkpoints on):
 *  work roster, first person (34.2 s, 13 OCR calls): scan 0.0 s, grid 2.3 s, STT 3.6 s, names 11.1 s (6 OCR calls,
 *  then 10 s of VietOCR), match 31.4 s, days 31.8 s, day checks 33.7 s. The day stages get more room than measured
 *  (0.84–1): a blurred photo re-reads many cells there; on a sharp photo the bar then finishes quickly.
 *  pipe sheet t5 (93.7 s, 189 OCR calls): prepare 0.0 s, table 1.0 s, straightened 1.8 s (55 calls), cells 27.1 s
 *  (134 calls, one message per staff row), glyphs 93.7 s. A page read before ("dùng dữ liệu đã lưu") is done at once.
 */
export const READ_STAGES = Object.freeze({
  work: [
    stage('scan', /^Đang tạo bản quét 4K|^Đang thử ảnh xoay/, 0, 0),
    stage('grid', /^Đang tách các cột ngày/, 0.06, 0),
    stage('serials', /^Đang tìm số thứ tự|^Đang đọc cột số thứ tự/, 0.1, 2),
    stage('names', /^Đang đọc họ tên/, 0.3, 8),
    stage('match', /^Đang đối chiếu hàng/, 0.82, 2),
    stage('days', /^Đang đọc ca cho/, 0.84, 6),
    stage('check', /^Đang kiểm tra kỹ ô ngày (\d+) \/ (\d+)/, 0.88, 16, true),
  ],
  pipe: [
    stage('prepare', /tự cân kích thước/, 0, 0),
    stage('table', /tự tìm chiều chữ, viền bảng/, 0.01, 4),
    stage('straight', /đã tìm thấy bảng/, 0.02, 30),
    stage('cells', /đang đọc từng cột ca và phân ống/, 0.28, 70),
    stage('glyphs', /so mẫu chữ/, 0.97, 4),
    stage('cached', /dùng dữ liệu đã lưu/, 0.97, 0),
  ],
});
/** Measured length of the calibration reads (ms; pipe: one photo). */
export const CALIBRATED_MS = Object.freeze({ work: 34_000, pipe: 94_000 });
const PAGE = /^Ảnh (\d+)(?: \/ (\d+))?/;
/** Inside a stage the bar goes at most this far towards the next stage before its message arrives. */
const STAGE_CAP = 0.96;

export class ReadProgress {
  /** type: 'work' | 'pipe'; pages: photos of a pipe import; atOnce: photos read at the same time (Task A4,
   *  js/core/PipeRosterReader.js pipePagesAtOnce; 1 = one after another); now(): ms clock. */
  constructor(type, { pages = 1, atOnce = 1, now = () => Date.now() } = {}) {
    this.type = type in READ_STAGES ? type : 'work'; this.stages = READ_STAGES[this.type]; this.pages = Math.max(1, pages); this.atOnce = Math.max(1, atOnce); this._now = now;
    this.message = ''; this.finished = false; this.value = 0; this._speed = null;
    this._pageStates = []; this._page = 0; this._started = 0;
    this._workStart = null; this._workValue = 0; this._lastHit = -Infinity;
  }
  _end(i) { const a = this.stages[i].at; let end = 1; for (const s of this.stages) if (s.at > a && s.at < end) end = s.at; return end; }
  /** The state of one photo (the work roster has one): its stage, OCR calls in the stage, and when it started. */
  _state(page) { const t = this._now(); return this._pageStates[page] ??= { index: -1, calls: 0, sub: 0, pageStart: t, stageStart: t }; }
  /** A reader progress message (Progress.update). Pipe messages say their photo ("Ảnh 2 · …"): each photo has its own
   *  stage, as photos may be read at the same time. */
  stage(message) {
    this.message = String(message ?? ''); const t = this._now();
    if (this.type === 'pipe') {
      const p = PAGE.exec(this.message);
      if (p != null) { this._page = Math.max(0, parseInt(p[1], 10) - 1); if (p[2] != null) this.pages = Math.max(this.pages, parseInt(p[2], 10)); this._started = Math.max(this._started, this._page + 1); }
    }
    const st = this._state(this._page);
    const i = this.stages.findIndex(s => s.re.test(this.message));
    if (i >= 0) {
      const s = this.stages[i];
      if (i !== st.index) {
        // How fast this device is: time to reach this stage against the calibration read (from the 2nd stage on).
        if (s.at >= 0.05 && i > st.index) this._speed = Math.min(6, Math.max(0.2, (t - st.pageStart) / (s.at * CALIBRATED_MS[this.type])));
        st.index = i; st.calls = 0; st.sub = 0; st.stageStart = t;
      }
      const m = s.count ? s.re.exec(this.message) : null;
      if (m != null) { const n = parseInt(m[2], 10); if (n > 0) st.sub = Math.max(st.sub, Math.min(1, (parseInt(m[1], 10) - 1) / n)); }
    }
    return this._update();
  }
  /** An OCR call of the job finished (counted for the photo of the latest message); hit: answered from the
   *  checkpoints (no real work, not counted for the ETA). */
  call(hit = false) {
    this._state(this._page).calls++; const t = this._now();
    if (hit) this._lastHit = t; else if (this._workStart == null) { this._workStart = t; this._workValue = this.value; }
    return this._update();
  }
  /** Time passed (a long OCR call): the bar creeps on within the stage. */
  tick() { return this._update(); }
  /** The read finished: 100 %. */
  done() { this.finished = true; this.value = 1; return 100; }
  /** Share of one photo done (0–1), from its stage, OCR calls and time. */
  _inPage(st) {
    if (st == null || st.index < 0) return 0;
    const s = this.stages[st.index], a = s.at, b = this._end(st.index);
    const byCalls = s.calls > 0 ? 1 - Math.exp(-st.calls / s.calls) : 0;
    const expected = (b - a) * CALIBRATED_MS[this.type] * (this._speed ?? 1.5);
    const byTime = expected > 0 ? 0.85 * (1 - Math.exp(-(this._now() - st.stageStart) / expected)) : 0;
    return a + (b - a) * Math.min(STAGE_CAP, Math.max(byCalls, byTime, st.sub));
  }
  _update() {
    if (this.finished) return 100;
    let overall;
    if (this.type === 'pipe') {
      // A photo starts only when another has finished (atOnce at a time, started in order): that many photos are done,
      // taken as the first ones (exact one at a time; photos started earlier mostly finish earlier); the others count
      // by their own progress.
      const done = Math.max(0, this._started - this.atOnce); let sum = 0;
      for (let k = 0; k < this._started; k++) sum += k < done ? 1 : this._inPage(this._pageStates[k]);
      overall = sum / this.pages;
    } else overall = this._inPage(this._pageStates[0]);
    this.value = Math.max(this.value, Math.min(0.99, overall)); // never back, never 100 before done()
    return this.percent();
  }
  /** Whole percent shown (0–100). */
  percent() { return this.finished ? 100 : Math.min(99, Math.floor(this.value * 100)); }
  /**
   * Seconds left from the measured rate of the real work since the first OCR call the engine had to make (time
   * spent answering from checkpoints does not count), or null while there is too little to measure (under 10 s or
   * 3 % of real work) or while checkpoints are being replayed.
   */
  eta() {
    if (this.finished || this._workStart == null) return null;
    const t = this._now(), spent = t - this._workStart, done = this.value - this._workValue;
    if (t - this._lastHit < 1500 || spent < 10_000 || done < 0.03) return null;
    return Math.max(0, Math.round((spent / done) * (1 - this.value) / 1000));
  }
}

/** "còn khoảng N phút" / "còn dưới 1 phút" (null: nothing shown). */
export function etaText(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return 'còn dưới 1 phút';
  return 'còn khoảng ' + Math.ceil(seconds / 60) + ' phút';
}
