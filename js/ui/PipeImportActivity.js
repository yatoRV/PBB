// Port of vn.lichdilam.PipeImportActivity (APK 4.5): import assignment photos by name; image preparation is
// automatic. docs/UI-MAP-PipeImport-PipeTable-PhotoViewer.md (PI1–PI23) lists every view and text.
// Web adaptations (each marked where it happens):
//  - ACTION_OPEN_DOCUMENT image/* with EXTRA_ALLOW_MULTIPLE (request 210) is an <input type=file multiple>;
//  - the decoded 1600 px bitmap only proves the photo opens and is released at once; the card preview shows the
//    stored copy through an <img> (iPhone memory: no full-size bitmaps kept while the form is open);
//  - the OCR read runs only as an executor job (leaving the screen → shutdownNow(), which interrupts it);
//  - resumable reading (user request, Task A2): the read is a job (js/jobs/read-jobs.js; same photos + settings =
//    same job, its OCR calls checkpointed), opened with the extra "readJob" its photos and settings come back and it
//    continues (or, done, goes straight to the review); a segmented progress bar shows the percent.
import { Integer, Executors, IllegalArgumentException, RuntimeException, utf8Encode } from '../platform/java.js';
import { YearMonth } from '../platform/time.js';
import { File, FileOutputStream } from '../platform/files.js';
import { Intent, Uri, ClipData } from '../platform/android.js';
import { AppLog } from '../core/AppLog.js';
import { AppDataReset } from '../core/AppDataReset.js';
import { Schedule } from '../core/Schedule.js';
import { ScheduleStore } from '../core/ScheduleStore.js';
import { PipeSourceCache } from '../core/PipeSourceCache.js';
import { PipeRosterReader, pipePagesAtOnce } from '../core/PipeRosterReader.js';
import { ImageFiles } from '../core/ImageFiles.js';
import { OwnerProfile } from '../core/OwnerProfile.js';
import { Personnel } from '../core/Personnel.js';
import { ThemedActivity } from './ThemedActivity.js';
import { ThemeUi } from './ThemeUi.js';
import { UiResume } from './UiResume.js';
import { ExpandPhotoButton } from './ExpandPhotoButton.js';
import { InterruptedException } from '../platform/java.js';
import { PipeBook } from '../core/PipeBook.js';
import { ReadJobs, PIPE } from '../jobs/read-jobs.js';
import { ReadProgress, etaText } from '../jobs/read-progress.js';
import { ReadProgressBar } from './ReadProgressBar.js';
import { runJob, staffFingerprint, pipeJobRead, pipeContextFingerprint } from './ReadJobUi.js';
import { el, textView, buttonView, editText, imageView, describe } from './Views.js';

const OPEN_DOCUMENT = 'android.intent.action.OPEN_DOCUMENT';
/** Uri.parse of a saved "file://…" source (the only kind this screen saves). */
const parseUri = s => Uri.fromFile(new File(decodeURI(String(s).replace(/^file:\/\//, ''))));
/** Lets the browser paint the line just written before a job's synchronous image work starts (a hidden page has no
 *  frames, so it also goes on after 100 ms). */
const nextFrame = () => new Promise(resolve => { setTimeout(resolve, 100); if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0)); });

export class PipeImportActivity extends ThemedActivity {
  constructor() {
    super();
    this.images = []; this.sourceUris = []; this.worker = Executors.newSingleThreadExecutor();
    this.content = null; this.photos = null; this.name = null; this.month = null; this.year = null; this.progress = null; this.read = null;
    this.busy = false; this.scanned = null; this.primaryIndex = -1; this.primaryExplicit = false; this._picker = null;
  }
  uiBusy() { return this.busy; }
  text(s, size) { const v = textView(s, size, ThemeUi.TEXT); v.classList.add('pi-text'); return v; }
  button(s, action) {
    const b = buttonView(s, false); b.classList.add('btn--block', 'pi-button');
    b.addEventListener('click', () => { AppLog.event('user.action', AppLog.data('screen', 'PipeImportActivity', 'action', s, 'busy', this.busy)); if (!this.busy) action(); });
    return b;
  }
  field(label, hint, value, digits) {
    this.content.append(this.text(label, 14)); const e = editText({ hint, value, numeric: digits, capWords: !digits }); e.classList.add('field--form', 'pi-field');
    const wrap = el('div', 'field-wrap'); wrap.append(e); this.content.append(wrap); return e;
  }
  async onCreate(state) {
    if (state == null) state = UiResume.restoreBundle(this); super.onCreate(state); const store = new ScheduleStore(this, Schedule.PIPE); const selected = YearMonth.now();
    const scroll = el('div', 'scroll'); this.content = el('div', 'page'); scroll.append(this.content); this.setContentView(scroll);
    const title = this.text('Thêm ảnh phân ống', 27); title.classList.add('pi-title'); this.content.append(title);
    this.photos = el('div', 'col pi-photos'); this.content.append(this.photos); this.content.append(this.button('+ Thêm ảnh Lịch ống (tối đa 3)', () => this.pick()));
    const work = new ScheduleStore(this);
    this.name = this.field('Họ tên hoặc STT của bạn trong ảnh', 'Ví dụ: Nguyen A', new OwnerProfile(this).defaultName(work.name() === '' ? store.name() : work.name()), false);
    this.month = this.field('Tháng', '1–12', String(selected.getMonthValue()), true); this.year = this.field('Năm', String(selected.getYear()), String(selected.getYear()), true);
    this.progress = this.text('Chưa chọn ảnh.', 13); this.progress.setAttribute('role', 'status'); this.progress.setAttribute('aria-live', 'polite'); this.content.append(this.progress);
    this.read = this.button('Đọc ảnh & ghép vào lịch', () => this.start()); this.read.classList.add('btn--primary'); this.content.append(this.read); this.content.append(this.button('Hủy', () => this.finish()));
    const job = this.getIntent().hasExtra('readJob') ? new ReadJobs(this).get(this.getIntent().getStringExtra('readJob')) : null;
    if (job != null) {
      // Web (Task A2): the job's photos (the APK's own source copies) and settings, then the read goes on by itself.
      const p = job.params ?? {}, m = YearMonth.parse(p.month); this.name.value = p.name ?? ''; this.month.value = String(m.getMonthValue()); this.year.value = String(m.getYear());
      this.primaryIndex = p.primary ?? 0; this.primaryExplicit = true; this._autoStart = true;
      this.loadPhotos((job.photos ?? []).map(ph => Uri.fromFile(new File(ph.path))), false);
    } else if (state != null) {
      this.name.value = state.getString('owner', this.name.value); this.month.value = state.getString('month', this.month.value); this.year.value = state.getString('year', this.year.value);
      const paths = state.getStringArrayList('images'); if (paths != null) { const saved = []; for (const path of paths) saved.push(parseUri(path)); this.primaryIndex = state.getInt('primary', -1); this.primaryExplicit = state.getBoolean('explicit'); this.loadPhotos(saved, false); }
    } else try {
      const saved = store.pipeBook(selected);
      if (saved != null) { const uris = []; for (const file of new PipeSourceCache(this.getFilesDir()).sourcesFor(saved)) uris.push(Uri.fromFile(file)); if (uris.length <= 3) { this.primaryIndex = saved.primaryIndex(); this.primaryExplicit = saved.hasPrimary(); this.loadPhotos(uris, false); } }
    } catch (missing) { AppLog.failure('PipeImportActivity', missing); this.progress.textContent = 'Ảnh gốc đã lưu không còn. Chọn lại ảnh; lịch hiện tại vẫn được giữ.'; }
  }
  pick() { if (this.images.length >= 3) { this.message('Đã đủ 3 ảnh. Xóa một ảnh nếu muốn thay.'); return; } this.startActivityForResult(new Intent(OPEN_DOCUMENT).putExtra('android.intent.extra.ALLOW_MULTIPLE', true), 210); }
  /** Web: ACTION_OPEN_DOCUMENT image/* (multiple) is the browser's file picker. */
  startActivityForResult(intent, request) {
    if (intent.getAction() !== OPEN_DOCUMENT) { super.startActivityForResult(intent, request); return; }
    AppLog.event('navigation.start', AppLog.data('screen', this.constructor.name, 'request', request, 'intent', intent.toUri(0)));
    if (this._picker == null) {
      const input = this._picker = document.createElement('input'); input.type = 'file'; input.accept = 'image/*'; input.multiple = true; input.className = 'picker'; input.tabIndex = -1; input.setAttribute('aria-hidden', 'true');
      input.addEventListener('change', () => { const files = [...(input.files ?? [])]; input.value = ''; if (files.length === 0) this.onActivityResult(input._request, ThemedActivity.RESULT_CANCELED, null); else { const data = new Intent().setClipData(ClipData.ofUris(files.map(f => Uri.fromBlob(f)))); this.onActivityResult(input._request, ThemedActivity.RESULT_OK, data); } });
      input.addEventListener('cancel', () => this.onActivityResult(input._request, ThemedActivity.RESULT_CANCELED, null));
      document.body.append(input);
    }
    this._picker._request = request; this._picker.click();
  }
  onActivityResult(request, result, data) {
    super.onActivityResult(request, result, data); if (request !== 210 || result !== ThemedActivity.RESULT_OK || data == null) return;
    const uris = []; if (data.getClipData() != null) for (let i = 0; i < data.getClipData().getItemCount(); i++) uris.push(data.getClipData().getItemAt(i).getUri()); else if (data.getData() != null) uris.push(data.getData());
    this.loadPhotos(uris, true);
  }
  loadPhotos(uris, append) { // eslint-disable-line no-unused-vars
    if (uris.length === 0) return;
    if (this.images.length + uris.length > 3) { this.message('Chỉ chọn tối đa 3 ảnh, gồm cả ảnh đã thêm.'); return; } this.busy = true; this.progress.textContent = 'Đang mở bản sao ảnh gốc…';
    const epoch = AppDataReset.generation();
    this.worker.execute(AppDataReset.task(async () => {
      const loaded = [], retained = [];
      try {
        await nextFrame(); const cache = new PipeSourceCache(this.getFilesDir());
        for (const uri of uris) {
          const source = cache.copy(await this.getContentResolver().openInputStream(uri)); AppLog.source('pipe', source); const local = Uri.fromFile(source);
          if (this.sourceUris.some(u => u.equals(local)) || retained.some(u => u.equals(local))) continue;
          // Web: the decode proves the photo opens (as in the APK); the pixels are released at once (iPhone memory).
          const bitmap = await ImageFiles.load(this, local, 1600); bitmap.recycle(); loaded.push(source); retained.push(local);
        }
        this.runOnUiThread(() => {
          if (this.isDestroyed() || !AppDataReset.current(epoch)) return;
          this.images.push(...loaded); this.sourceUris.push(...retained); this.scanned = null; this.busy = false;
          if (this.images.length === 1) this.primaryIndex = 0; else if (!this.primaryExplicit) this.primaryIndex = -1;
          this.renderPhotos(); this.progress.textContent = 'Đã thêm ' + this.images.length + ' / 3 ảnh.' + (this.primaryIndex < 0 ? ' Chọn ảnh phân ống chính có tên bạn.' : '');
          if (this._autoStart) { this._autoStart = false; this.start(); } // web: a job opened again goes on
        });
      } catch (e) { AppLog.failure('PipeImportActivity', e); this.runOnUiThread(() => { if (!AppDataReset.current(epoch)) return; this.busy = false; this._autoStart = false; this.message(e.message); }); }
    }));
  }
  choosePrimary(index) {
    AppLog.event('user.primaryPhoto', AppLog.data('index', index, 'busy', this.busy, 'source', this.sourceUris[index].toString()));
    if (this.busy) { this.renderPhotos(); this.message('Đang xử lý ảnh, hãy chờ hoàn tất trước khi đổi ảnh chính.'); return; }
    this.primaryIndex = index; this.primaryExplicit = true; this.scanned = null; this.renderPhotos(); this.progress.textContent = 'Đã chọn ảnh chính: ' + (index + 1) + '.';
  }
  openPhoto(index) { this.startActivity(new Intent(this, 'PhotoViewerActivity').putExtra('path', this.sourceUris[index].getPath())); }
  removePhoto(index) {
    this.images.splice(index, 1); this.sourceUris.splice(index, 1);
    if (this.primaryIndex === index) { this.primaryIndex = -1; this.primaryExplicit = false; } else if (this.primaryIndex > index) this.primaryIndex--;
    if (this.images.length === 1) this.primaryIndex = 0; this.scanned = null; this.renderPhotos();
    this.progress.textContent = this.images.length === 0 ? 'Chưa chọn ảnh.' : this.primaryIndex < 0 ? 'Chọn ảnh phân ống chính có hàng tên của bạn.' : 'Ảnh ' + (this.primaryIndex + 1) + ' là ảnh phân ống chính.';
  }
  renderPhotos() {
    this.photos.replaceChildren();
    for (let i = 0; i < this.images.length; i++) {
      const index = i; const card = el('div', 'col pi-card'); ThemeUi.bg(card, ThemeUi.PANEL, 14);
      const preview = el('div', 'pi-preview'); const image = imageView(this.images[i], 'Ảnh phân ống ' + (i + 1), 150, 'img pi-image'); image.addEventListener('click', () => this.openPhoto(index)); preview.append(image);
      const expand = new ExpandPhotoButton(this); expand.setContentDescription('Mở ảnh ' + (i + 1) + ' toàn màn hình'); expand.setOnClickListener(() => this.openPhoto(index)); expand.view.classList.add('pi-expand'); preview.append(expand.view); card.append(preview);
      const actions = el('div', 'row pi-actions'); const label = this.text('Ảnh ' + (i + 1), 13); label.classList.add('pi-label'); actions.append(label);
      const primary = el('label', 'check pi-primary'); const radio = el('input'); radio.type = 'radio'; radio.name = 'pi-primary'; radio.checked = i === this.primaryIndex; describe(radio, 'Chọn ảnh ' + (i + 1) + ' làm ảnh phân ống chính');
      radio.addEventListener('click', () => this.choosePrimary(index)); const span = el('span', null, 'Ảnh phân ống chính'); span.style.fontSize = '12px'; ThemeUi.text(span, ThemeUi.TEXT); primary.append(radio, span); actions.append(primary);
      const remove = buttonView('×', false); remove.classList.add('pi-remove'); describe(remove, 'Xóa ảnh ' + (i + 1));
      remove.addEventListener('click', () => { AppLog.event('user.action', AppLog.data('screen', 'PipeImportActivity', 'action', '×', 'busy', this.busy)); if (!this.busy) this.removePhoto(index); });
      actions.append(remove); card.append(actions); this.photos.append(card);
    }
  }
  onSaveInstanceState(state) {
    super.onSaveInstanceState(state); if (this.name == null) return;
    state.putString('owner', this.name.value); state.putString('month', this.month.value); state.putString('year', this.year.value);
    state.putStringArrayList('images', this.sourceUris.map(u => u.toString())); state.putInt('primary', this.primaryIndex); state.putBoolean('explicit', this.primaryExplicit);
  }
  start() {
    let selected;
    try { selected = YearMonth.of(Integer.parseInt(this.year.value), Integer.parseInt(this.month.value)); if (selected.getYear() < 2000 || selected.getYear() > 2100 || this.name.value.trim() === '') throw new IllegalArgumentException(); }
    catch (e) { AppLog.failure('PipeImportActivity', e); this.message('Nhập họ tên hoặc STT, tháng 1–12 và năm 4 số.'); return; }
    if (this.images.length === 0) { this.message('Thêm ảnh Lịch ống trước.'); return; }
    if (this.primaryIndex < 0 || this.primaryIndex >= this.images.length) { this.message('Chọn một ảnh phân ống chính có hàng tên của bạn trước khi ghép lịch.'); return; }
    const work = new ScheduleStore(this).load(selected); if (work == null) { this.message('Thêm và lưu lịch đi làm tháng ' + selected + ' trước khi ghép phân ống.'); return; }
    if (this.scanned != null && this.scanned.month.equals(selected)) { this.finishImport(this.name.value); return; }
    this.busy = true; this.read.disabled = true; const sources = []; for (let i = 0; i < this.images.length; i++) sources.push(new PipeRosterReader.Source(this.sourceUris[i], i === this.primaryIndex)); const inputName = this.name.value;
    const epoch = AppDataReset.generation(); const images = this.images.slice(), primary = this.primaryIndex;
    // Web (Task A2): the read is a job with a progress bar above the APK's progress line.
    if (this._bar != null) this._bar.element.remove();
    const bar = this._bar = new ReadProgressBar({ variant: 'segments' }); this.progress.before(bar.element); this.progress.setAttribute('aria-live', 'off'); bar.reveal();
    const model = new ReadProgress('pipe', { pages: sources.length, atOnce: pipePagesAtOnce() }); let stageText = '';
    const show = () => { if (!this.isDestroyed()) bar.set(model.percent(), stageText, etaText(model.eta())); };
    this.readJob = this.worker.submit(AppDataReset.task(async () => {
      let job = null;
      try {
        const jobs = new ReadJobs(this);
        const update = { update: s => { model.stage(s); stageText = s; show(); this.runOnUiThread(() => { if (!this.isDestroyed() && AppDataReset.current(epoch)) this.progress.textContent = s; }); } };
        const pipe = pipeJobRead({ context: this, sources, images, month: selected, name: inputName, progress: update, before: nextFrame });
        if (ReadJobs.supported()) job = await jobs.open(PIPE, images.map(file => ({ file })), { month: selected.toString(), name: inputName, primary, staff: await staffFingerprint(), context: await pipeContextFingerprint(this) });
        let book;
        if (job != null && job.state === 'done') book = PipeBook.fromJson(job.result.book);
        else {
          if (job != null) jobs.started(job.id);
          book = job == null ? await pipe.read(0) : await runJob({ id: job.id, progress: model, onProgress: show, read: pipe.read, degraded: pipe.degraded });
          book.applyStaffList(Personnel.current());
          if (job != null) jobs.finish(job.id, { book: book.toJson() });
        }
        model.done(); show(); this.readJobId = job?.id ?? null;
        this.runOnUiThread(() => { if (this.isDestroyed() || !AppDataReset.current(epoch)) return; this.busy = false; this.read.disabled = false; this.scanned = book; this.read.textContent = 'Dùng dữ liệu đã quét'; this.finishImport(inputName); });
      } catch (e) {
        AppLog.failure('PipeImportActivity', e);
        if (job != null && !(e instanceof InterruptedException)) new ReadJobs(this).fail(job.id, e?.message);
        // A failed read is not a roster. Keep the saved calendar and the selected photos for retry.
        this.runOnUiThread(() => { if (this.isDestroyed() || !AppDataReset.current(epoch)) return; this.busy = false; this.read.disabled = false; this.scanned = null; bar.element.remove(); this._bar = null; this.progress.setAttribute('aria-live', 'polite'); this.message('Chưa ghép được ảnh. Lịch đã lưu được giữ nguyên. ' + (e?.message == null ? 'Hãy chọn lại ảnh rõ bảng và số ngày.' : e.message)); });
      }
    }));
  }
  finishImport(inputName) { // eslint-disable-line no-unused-vars
    const work = new ScheduleStore(this).load(this.scanned.month); if (work == null) { this.message('Thêm và lưu lịch đi làm tháng ' + this.scanned.month + ' trước khi ghép phân ống.'); return; }
    // The saved work roster decides whose row it is; never save a synthetic unknown row on failure.
    let person = null; try { person = this.scanned.owner(work.employeeName); } catch (notOnThePhoto) { if (!(notOnThePhoto instanceof RuntimeException) && !(notOnThePhoto instanceof Error)) throw notOnThePhoto; person = null; }
    if (person == null) { this.message('Chưa tìm được ' + work.employeeName + ' trong ảnh phân ống chính. Chọn đúng ảnh chính rồi đọc lại; lịch đã lưu được giữ nguyên.'); return; }
    try {
      const file = File.createTempFile('pipe-book-', '.json', this.getCacheDir()); const out = new FileOutputStream(file); try { out.write(utf8Encode(this.scanned.toJson())); } finally { out.close(); }
      this.setResult(ThemedActivity.RESULT_OK, new Intent().putExtra('bookFile', file.getAbsolutePath()).putExtra('number', person.number).putExtra('name', work.employeeName).putExtra('readJob', this.readJobId ?? null)); this.finish();
    } catch (e) { AppLog.failure('PipeImportActivity', e); this.message('Chưa lưu được bản đọc: ' + e.message); }
  }
  // 26/10 (user): no dialog, notice or warning on this screen — guidance is a line under the photos.
  message(text) { AppLog.message('pipe.import', text); if (!this.isFinishing() && !this.isDestroyed() && text != null) this.progress.textContent = text; }
  onBackPressed() { if (this.busy) { this.message('Đang xử lý ảnh, hãy chờ hoàn tất.'); return; } super.onBackPressed(); }
  onDestroy() { super.onDestroy(); this.worker.shutdownNow(); if (this._picker != null) this._picker.remove(); this.images = []; }
}
