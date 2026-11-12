// Port of vn.lichdilam.SessionJournal (APK 4.5). Files live in the virtual app storage (js/platform/files.js);
// the zip is written with ZipOutputStream from files.js (STORED entries, same extracted bytes).
import { IOException, UUID, compareTo, utf8Encode, utf8Decode } from '../platform/java.js';
import { JSONObject, JSONException } from '../platform/json.js';
import { File, Files, FileOutputStream, BufferedOutputStream, RandomAccessFile, ZipOutputStream, ZipEntry } from '../platform/files.js';
import { Instant, ZoneId, DateTimeFormatter } from '../platform/time.js';

/** The README.txt text block of the Java export, byte-for-byte. */
const README = 'Lịch đi làm · log đầy đủ từ phiên bản 3.6\nsessions/: từng sự kiện JSONL, thời gian UTC, số thứ tự và mã phiên.\napp-state.json: dữ liệu/cài đặt tại thời điểm xuất; reminderDiagnostics giữ trạng thái thông báo cũ, alarmDeliveryDiagnostics bổ sung phép đo từ 3.9.\nsources/: ảnh nguồn còn được app lưu.\n3.8: reminder.arm/due/delivery ghi giờ hẹn, độ trễ và đường receiver/catchUp; postAttempt ghi âm thật của kênh, âm lượng/DND; audio.requested là yêu cầu, audio.playbackObserved là tín hiệu Android, audio.result là kết quả quan sát 7 giây. Tín hiệu hệ thống không đo trực tiếp loa hoặc xác định riêng player của app; thiếu tín hiệu chưa chứng minh loa im lặng.\n3.9: registration.attempt/result ghi id hẹn, registrationId, cách đặt, cờ broadcast, đồng hồ wall/elapsed, bootCount, API trả về và báo thức tiếp theo. API trả về/PendingIntent còn tồn tại chưa chứng minh toàn bộ hàng đợi AlarmManager.\nreminder.cancel/reschedule/test.rearm/pending.saved ghi ai hủy/đặt lại hẹn và kết quả lưu. receiver.entry/handlerFinished ghi tiếp nhận và thời gian xử lý. delivery.decision ghi vì sao gửi/bỏ qua/trùng/đổi lịch. notification.enqueue/state/spacing ghi thời gian enqueue, trạng thái thông báo, kênh/nhóm, onlyAlertOnce và khoảng cách các lần gửi.\nreminder.checkpoint/environment.change/process.history ghi trước khi rearm, màn hình, pin, AppOps, standby bucket và lịch sử tiến trình mà Android cho đọc. Android trước 35 không có start history/wasForceStopped; lịch sử có thể thiếu. wasForceStopped không tự chứng minh người dùng đã bấm Buộc dừng.\nreminder.sound.providerOpen ghi UID/PID và selfRead: mở được descriptor chưa chứng minh đã phát âm. audioState ghi các đầu ra có sẵn, không bảo đảm đó là đường phát thông báo thực tế. audio.userReport là nhận xét người dùng, tách khỏi callback hệ thống.\nLD39_* là mã chẩn đoán do app tạo, không phải mã lỗi OPPO/Android. diagnostic.error có exception/cause và systemErrno nếu hệ thống cung cấp. REGISTER_API_RETURNED/NEXT_CLOCK_MATCH là bằng chứng quan sát; OVERDUE_NO_RECEIVER_OBSERVED, RECEIVER_LATE hoặc CATCH_UP chưa đủ quy nguyên nhân cho OPPO. Cần đối chiếu trace AlarmManager/broadcast hệ thống khi app còn đóng; ứng dụng không được quyền đọc toàn bộ dữ liệu này.\nDòng test.stagedFault hoặc test.userReportSimulation chỉ dữ liệu tổng hợp từ kiểm thử, không phải lỗi thực tế trên điện thoại người dùng.\ndisplay.pipeTable.render ghi chữ thực tế được vẽ, kích thước, dấu … và tràn ô.\nLog có dữ liệu người dùng đã nhập và nội dung lịch.\n';

function copy(zip, name, file) { zip.putNextEntry(new ZipEntry(name)); Files.copy(file.toPath(), zip); zip.closeEntry(); }

/** Append-only UTF-8 sessions. No automatic eviction or truncation of recorded events. */
export class SessionJournal {
  constructor(directory) {
    this.directory = directory;
    if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException('Không tạo được thư mục log.');
    this.session = DateTimeFormatter.ofPattern('yyyyMMdd-HHmmss-SSS').withZone(ZoneId.systemDefault()).format(Instant.now()) + '-' + UUID.randomUUID().toString().substring(0, 8);
    this.file = new File(directory, 'session-' + this.session + '.jsonl');
    this._sequence = 0;
    if (!this.file.createNewFile()) throw new IOException('Không tạo được phiên log.');
  }
  append(type, details, occurredAt, elapsed, thread) {
    try {
      const event = new JSONObject().put('schema', 1).put('session', this.session).put('seq', ++this._sequence)
        .put('time', Instant.ofEpochMilli(occurredAt).toString()).put('elapsedMs', elapsed)
        .put('thread', thread).put('type', type).put('data', details);
      const out = new FileOutputStream(this.file, true);
      try { out.write(utf8Encode(event.toString() + '\n')); out.flush(); } finally { out.close(); }
    } catch (invalid) { if (!(invalid instanceof JSONException)) throw invalid; throw new IOException(invalid); }
  }
  sessions() {
    const found = this.directory.listFiles((d, n) => n.startsWith('session-') && n.endsWith('.jsonl'));
    const files = found == null ? [] : [...found];
    files.sort((a, b) => compareTo(a.getName(), b.getName())); return files;
  }
  tail(selected, maximumBytes) {
    const actual = selected.getCanonicalFile();
    if (!this.directory.getCanonicalFile().equals(actual.getParentFile()) || !/^session-[a-zA-Z0-9-]+\.jsonl$/.test(actual.getName())) throw new IOException('Phiên log không hợp lệ.');
    const input = new RandomAccessFile(actual, 'r');
    try {
      const start = Math.max(0, input.length() - maximumBytes); input.seek(start);
      if (start > 0) while (input.getFilePointer() < input.length() && input.read() !== 10) { /* skip the partial line */ }
      const bytes = new Uint8Array(input.length() - input.getFilePointer()); input.readFully(bytes);
      return utf8Decode(bytes);
    } finally { input.close(); }
  }
  /** attachments: a Map (insertion order) or a Java-style map of zip entry name → File. */
  export(destination, state, attachments) {
    const zip = new ZipOutputStream(new BufferedOutputStream(destination));
    try {
      zip.putNextEntry(new ZipEntry('README.txt'));
      zip.write(utf8Encode(README)); zip.closeEntry();
      zip.putNextEntry(new ZipEntry('app-state.json')); zip.write(utf8Encode(state.toString())); zip.closeEntry();
      for (const session of this.sessions()) copy(zip, 'sessions/' + session.getName(), session);
      for (const [name, file] of attachments) {
        if (name.startsWith('/') || name.includes('..') || name.includes('\\')) throw new IOException('Tên tệp log không hợp lệ.');
        if (file.isFile()) copy(zip, name, file);
      }
    } finally { zip.close(); }
  }
}
