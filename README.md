# Lịch đi làm — bản web (theo APK 4.5)

Bản web của app Android **Lịch đi làm 4.5** (versionName 4.5, versionCode 42): cùng chức năng, cùng chữ, cùng nút, cùng
thuật toán và mô hình đọc ảnh như APK. Giao diện làm lại cho điện thoại (ưu tiên iPhone Safari), có chế độ Sáng / Tối / Auto.

- Địa chỉ: **https://yatorv.github.io/PBB/**
- Mở ra là màn hình **Đăng nhập bằng Google**. Chưa đăng nhập thì không vào được bên trong.
- Mọi thay đổi tự lưu vào **Google Drive của chính tài khoản đó**, trong thư mục `App-Lich-Di-Lam`. Đăng nhập lại (máy nào
  cũng được) là có lại toàn bộ dữ liệu. Mỗi tài khoản Google chỉ thấy dữ liệu của mình.
- Miễn phí hoàn toàn: trang tĩnh trên GitHub Pages, không có máy chủ, không cần "build". Chỉ cần đưa thư mục lên GitHub.

---

## 1. Cấu trúc thư mục

| Thư mục / tệp | Dùng để | Cần đưa lên GitHub? |
|---|---|---|
| `index.html` | Trang chính (màn hình đăng nhập, khung app) | **Có** |
| `sw.js` | Service worker, **chỉ** để hiện thông báo nhắc ca. Không lưu đệm gì | **Có** |
| `app.webmanifest` | Thông tin "app" khi thêm vào Màn hình chính | **Có** |
| `.nojekyll` | Tệp rỗng, báo GitHub Pages phục vụ nguyên trạng, không xử lý Jekyll | **Có** |
| `css/` | Giao diện | **Có** |
| `js/` | Mã nguồn. `js/core/` = các lớp Java của APK chuyển sang JavaScript (cùng tên tệp); `js/ui/` = các màn hình; `js/platform/` = phần thay cho Android/Java; `js/cloud/` = đăng nhập Google, Google Drive; `js/ocr/` = bộ đọc chữ; `js/shell/` = đăng nhập, giao diện sáng/tối | **Có** |
| `assets/` | Mô hình ONNX của APK, mô hình đọc chữ PaddleOCR, 226 âm báo (`assets/tones`), danh sách nhân viên, biểu tượng (`assets/icon.png` gốc và `assets/icons/` các cỡ nhỏ) | **Có** |
| `README.md`, `DEPLOY.md` | Hướng dẫn | Nên có |
| `docs/` | Tài liệu kỹ thuật: đo OCR (`docs/DO-OCR.md`), bản đồ giao diện | Không bắt buộc |
| `tests/`, `tools/`, `package.json`, `package-lock.json` | Kiểm thử và công cụ cho người lập trình (chạy bằng Node.js). Trang web không dùng | Không bắt buộc |
| `node_modules/`, `.eval/`, `.superpowers/`, `.git/` | Tệp tạm trên máy này | **Không** đưa lên |

Danh sách chính xác các tệp cần đưa lên: xem **`DEPLOY.md`**.

---

## 2. Đưa lên GitHub Pages

GitHub **không** cho kéo-thả quá 100 tệp một lần trên trang web, trong khi trang này có khoảng 370 tệp (65 MB; tệp lớn nhất
`assets/vietocr/encoder.onnx` 24 MB). Vì vậy hãy dùng **GitHub Desktop** (cách A, dễ nhất) hoặc dòng lệnh `git` (cách B).

### Cách A — GitHub Desktop (khuyên dùng)

1. Tải và cài **GitHub Desktop**: https://desktop.github.com — đăng nhập tài khoản GitHub `yatoRV`.
2. Menu **File → Clone repository…** → thẻ **GitHub.com** → chọn `yatoRV/PBB` → ô **Local path** chọn một thư mục trống,
   ví dụ `D:\GitHub\PBB` → bấm **Clone**.
3. Mở thư mục vừa clone (`D:\GitHub\PBB`) bằng File Explorer.
   - Nếu trong đó còn tệp của bản web cũ: **xóa hết**, chỉ giữ lại thư mục ẩn `.git`.
4. Chép vào đó các tệp/thư mục ghi trong `DEPLOY.md` (tối thiểu: `index.html`, `sw.js`, `app.webmanifest`, `.nojekyll`,
   `css`, `js`, `assets`, `README.md`, `DEPLOY.md`).
   - Không chép `node_modules`, `.eval`, `.superpowers`, `.git` của máy này.
5. Quay lại GitHub Desktop: cột trái hiện danh sách thay đổi. Ô **Summary** (góc dưới trái) gõ ví dụ `Ban web 4.5` → bấm
   **Commit to main**.
6. Bấm **Push origin** (thanh trên cùng). Chờ tải lên xong (65 MB, vài phút).

### Cách B — dòng lệnh git

```
git clone https://github.com/yatoRV/PBB.git
cd PBB
(xóa tệp cũ nếu có, chép các tệp trong DEPLOY.md vào đây)
git add -A
git commit -m "Ban web 4.5"
git push
```

### Bật GitHub Pages (chỉ làm một lần)

1. Mở https://github.com/yatoRV/PBB → **Settings** → mục **Pages** (cột trái).
2. **Build and deployment → Source**: chọn **Deploy from a branch**.
3. **Branch**: chọn **main**, thư mục **/ (root)** → **Save**.
4. Chờ khoảng 1 phút, trang hiện dòng "Your site is live at https://yatorv.github.io/PBB/".

> Tài khoản GitHub miễn phí chỉ bật được Pages với kho **Public**. Khi đó ai cũng xem được mã nguồn và các tệp trong kho
> (xem mục 8, "Dữ liệu công khai").

---

## 3. Cài đặt Google Cloud (đăng nhập Google + Google Drive)

App dùng sẵn OAuth Client ID:
`869075013345-2tvq9ci9lf6s2s7flccu29nr1t7e78c6.apps.googleusercontent.com` (nằm trong `js/config.js`).
Client ID không phải là bí mật; app **không** có và **không cần** "client secret".

Vào https://console.cloud.google.com, chọn đúng **dự án chứa Client ID trên** (ô chọn dự án ở thanh trên cùng), rồi:

1. **Bật Google Drive API**
   - Menu ☰ → **APIs & Services → Library** → tìm **Google Drive API** → **Enable**.
2. **Cho phép địa chỉ trang web**
   - Menu ☰ → **Google Auth Platform → Clients** (giao diện cũ: **APIs & Services → Credentials**) → bấm vào client
     loại **Web application** có ID trên.
   - **Authorized JavaScript origins** → **Add URI** → gõ đúng: `https://yatorv.github.io`
     (không có `/PBB`, không có dấu `/` ở cuối).
   - **Authorized redirect URIs**: không cần.
   - Bấm **Save**. Thay đổi có thể mất 5 phút đến vài giờ mới có hiệu lực.
3. **Màn hình xin quyền (consent screen)**
   - **Google Auth Platform → Branding**: tên app (ví dụ "Lịch đi làm"), email hỗ trợ. Không cần tải logo lên
     (tải logo lên thì Google bắt xác minh thương hiệu).
   - **Data access** → **Add or remove scopes**: thêm `.../auth/drive.file`, `openid`, `.../auth/userinfo.email`,
     `.../auth/userinfo.profile` → **Update** → **Save**.
     `drive.file` chỉ cho app thấy các tệp do chính app tạo ra, và là quyền **không nhạy cảm**: không cần Google xác minh.
4. **Ai được đăng nhập** (**Google Auth Platform → Audience**), chọn một trong hai:
   - **Publish app** (Publishing status → **In production**): mọi tài khoản Google đều đăng nhập được. Với các quyền ở
     bước 3 thì không cần gửi Google xét duyệt.
   - Hoặc giữ **Testing** và thêm từng email vào **Test users** (tối đa 100 người). Tài khoản không có trong danh sách sẽ
     bị Google chặn.

Kiểm tra: mở https://yatorv.github.io/PBB/ → **Đăng nhập bằng Google** → chọn tài khoản → cho phép quyền Google Drive.
Nếu thấy lỗi `redirect_uri_mismatch` hoặc `origin_mismatch`: kiểm tra lại bước 2.

---

## 4. Dữ liệu trên Google Drive

- App tạo thư mục **`App-Lich-Di-Lam`** trong "Drive của tôi" của tài khoản đã đăng nhập:
  - `du-lieu.json`: toàn bộ cài đặt, lịch, ghi chú, sửa tay… (tự lưu sau mỗi thay đổi, khoảng 1,5 giây);
  - các tệp ảnh lớn (ảnh lịch, ảnh phân ống), mỗi ảnh một tệp, tên như `files__…`.
- Nhật ký phiên (log) và bộ nhớ đệm chỉ nằm trên từng máy, không đưa lên Drive.
- Máy cũng giữ một bản sao trong trình duyệt (IndexedDB) để mở nhanh và để không mất thay đổi khi mất mạng.
- Hai máy cùng một tài khoản: thay đổi được gộp lại; máy kia nhận khi mở lại app hoặc quay lại tab.

**Xóa / làm lại từ đầu:**
1. Trong app, bấm **Đăng xuất** (cạnh nút Log, có hiện email) trên **mọi** máy đang dùng. Đăng xuất sẽ lưu nốt thay đổi,
   xóa bản sao trên máy đó và thu hồi quyền truy cập của phiên.
2. Vào https://drive.google.com → xóa thư mục `App-Lich-Di-Lam` → vào **Thùng rác** → xóa vĩnh viễn thư mục đó.
3. Đăng nhập lại: app bắt đầu với dữ liệu trống.

Muốn gỡ hẳn quyền của app với tài khoản Google: https://myaccount.google.com/permissions → chọn app → **Xóa quyền truy cập**.

---

## 5. Dùng trên iPhone

1. Mở **Safari** (không phải Chrome) → vào https://yatorv.github.io/PBB/.
2. Bấm nút **Chia sẻ** (ô vuông có mũi tên lên) → **Thêm vào MH chính** → **Thêm**.
3. Mở app từ biểu tượng mới trên Màn hình chính.

Vì sao nên thêm vào Màn hình chính: trên iPhone, **thông báo nhắc ca chỉ hoạt động** khi trang được mở từ Màn hình chính và
máy chạy **iOS 16.4 trở lên** (vào **Nhắc lịch**, bật thông báo, cho phép khi iPhone hỏi). App mở toàn màn hình như app thật.

Android: mở bằng Chrome → menu ⋮ → **Thêm vào màn hình chính** / **Cài đặt ứng dụng**.

---

## 6. Sửa mã và cập nhật về sau

1. Sửa tệp trong thư mục đã clone (ví dụ `D:\GitHub\PBB`), hoặc sửa ở máy này rồi chép tệp đã sửa sang đó.
2. GitHub Desktop → gõ Summary → **Commit to main** → **Push origin**.
3. Khoảng 1 phút sau GitHub Pages đăng bản mới (xem tiến độ ở thẻ **Actions** của kho).
4. `sw.js` không lưu đệm gì, nên bản mới có hiệu lực ngay khi trang tải lại. GitHub Pages cho trình duyệt giữ tệp tối đa
   10 phút, nên nếu chưa thấy thay đổi: đợi vài phút rồi đóng hẳn app và mở lại.
5. **Sau mỗi lần đưa bản mới lên:** đóng hẳn app (vuốt tắt trên iPhone) và chỉ mở lại sau khoảng **10 phút**, để máy không
   chạy lẫn tệp cũ (GitHub Pages cho giữ tệp tối đa 10 phút) với tệp mới.

Cho người lập trình (cần Node.js 20 trở lên):
- Kiểm thử: `npm install` (một lần) rồi `npm test`.
- Chạy thử trên máy: `node tools/serve-site.mjs` → mở http://127.0.0.1:8770/PBB/. Đăng nhập Google thật chỉ chạy được
  từ địa chỉ đã thêm ở mục 3, bước 2. Trang thử giao diện không cần Google: http://127.0.0.1:8770/PBB/tools/ui-harness.html
  (chỉ chạy trên máy này, tự từ chối khi ở trên mạng).
- Kiểm thử trên trình duyệt (Playwright, WebKit giả lập iPhone 13 và Chromium giả lập Pixel 7, có quét trợ năng axe):
  `npx playwright install webkit chromium` (một lần, tải khoảng 900 MB vào `%LOCALAPPDATA%\ms-playwright`) rồi
  `npm run e2e`. Bài chạy đủ luồng đọc ảnh thật cần đặt `E2E_FIXTURES` = thư mục ảnh mẫu `androidTest/assets` của mã APK
  (mất nhiều phút); không có biến này thì bài đó được bỏ qua.
- Tạo lại các cỡ biểu tượng sau khi đổi `assets/icon.png`: `node tools/make-icons.mjs`.
- Nếu thêm một trang web bên ngoài mới (CDN, API) hoặc đổi phiên bản một thư viện trên jsDelivr, phải thêm nó vào dòng `Content-Security-Policy` trong `index.html`,
  nếu không trình duyệt sẽ chặn.

---

## 7. Bảo mật

- Không có mật khẩu, khóa bí mật hay "client secret" nào trong mã.
- Đăng nhập bằng Google Identity Services. Mã truy cập (access token) chỉ có hạn khoảng 1 giờ, chỉ giữ trong tab đang mở
  (`sessionStorage`), và chỉ có quyền `drive.file` (chỉ các tệp app tự tạo; app không đọc được tệp khác trong Drive).
- `index.html` có Content-Security-Policy: chỉ chạy mã của chính trang, của đúng các gói cố định phiên bản trên
  `cdn.jsdelivr.net` (onnxruntime-web 1.23.2 / 1.18.0, bộ giải mã âm thanh 0.1.20) và của Google (đăng nhập, Drive, thu hồi
  quyền khi đăng xuất). Không có mã nội tuyến. Trang không chạy khi bị nhúng
  vào trang khác (chống clickjacking).
- Bộ giải mã âm thanh từ jsDelivr được kiểm tra toàn vẹn (SRI).

---

## 8. Giới hạn (nói thẳng)

**Đọc ảnh (OCR)** — ML Kit của Android không có trên web, nên thay bằng PaddleOCR (đo trên chính bộ ảnh mẫu của APK, chi
tiết trong `docs/DO-OCR.md`):
- **Lịch đi làm: 0 ô sai** (4 ảnh gốc: 1.517 đúng / 2 "?" / 0 sai; cả 15 ảnh: 4.550 / 7 / 0).
- **Phân ống: có ô sai, APK thì không.** 4 ảnh gốc: 456 đúng / 7 "?" / **12 sai** / 27 thiếu (APK: 499 / 3 / 0 / 0).
  Cả 15 ảnh: 19 ô sai. 10 trong 12 ô sai là một hàng bị gán nhầm người. **Hãy kiểm tra lại bảng phân ống sau khi đọc.**
- Mã ca có dấu thanh (ví dụ "LỘC") có thể bị đọc sai hoặc để "?".
- **Tốc độ**: trên máy tính (Chromium) đọc một tờ phân ống mất khoảng 3 phút. **Chưa đo trên iPhone thật**; ước tính
  lịch đi làm người đầu tiên 2–3 phút, mỗi người sau 10–20 giây, một tờ phân ống 6–12 phút. Trong lúc đọc phải để app mở.
- Một lần đọc cả trang (tìm kỳ in trên tờ ống) trên iPhone có thể **quá giới hạn 60 giây** của APK: khi đó app bỏ phần
  chữ đó (như APK khi quá giờ) và người dùng phải chờ thêm.
- Lần đọc đầu tiên tải mô hình đọc chữ (khoảng 20–60 MB tùy việc), nên cần mạng ổn định. iPhone có ít bộ nhớ cho trang
  web: đóng bớt tab khác nếu app bị tải lại giữa chừng.

**Nhắc ca**
- Chỉ nhắc khi app đang mở (hoặc vừa mở lại). Trình duyệt không cho trang web tự chạy nền như Android.
- iPhone: chỉ có thông báo hệ thống khi app được thêm vào Màn hình chính và iOS 16.4+. Âm báo phát bằng bộ giải mã trong
  trang; iPhone ở chế độ im lặng có thể không phát tiếng.
- Mở app ở hai tab cùng lúc trên trình duyệt quá cũ (không có Web Locks) có thể báo trùng.

**Đăng nhập**
- Phiên đăng nhập chỉ giữ trong tab đang mở: đóng hẳn app/trình duyệt rồi mở lại thì phải bấm đăng nhập lại.
- Mã truy cập hết hạn sau khoảng 1 giờ: lần chạm tiếp theo sẽ mở lại cửa sổ Google để gia hạn (dữ liệu chờ lưu không mất).

**Không có trên web (theo quyết định khi chuyển đổi)**
- Widget màn hình chính; màn hình chẩn đoán nhắc lịch, cài đặt pin, kênh thông báo, báo thức chính xác của Android.
- Xuất log: thay "chia sẻ" của Android bằng tải tệp ZIP về máy.

**Dữ liệu công khai**
- Kho GitHub và trang web là công khai. Tệp `assets/personnel-3.0.json` (danh sách 49 nhân viên lấy từ APK) tải được bởi bất
  kỳ ai biết địa chỉ trang, như khi nằm trong tệp APK. Dữ liệu riêng của từng người (lịch, ảnh) **chỉ** nằm trong Google
  Drive của họ.
- Các thư mục không bắt buộc `tests/`, `tools/`, `docs/` **cũng có tên nhân viên** (tên tệp ảnh mẫu như `pipe-vinh-…`,
  `pipe-tohoai-…`, kết quả đo, dữ liệu kiểm thử; không có ảnh thật). **Khuyên không đưa chúng lên** kho công khai — danh
  sách trong `DEPLOY.md` đã bỏ chúng ra.

**Đã thử ở đâu**
- Mới chạy thử trên máy tính: **Chromium** giả lập Android 412×915 và **WebKit** (lõi của Safari, bản Playwright cho
  Windows) giả lập iPhone 13 390×844, cùng 733 bài kiểm thử tự động. Bản WebKit này không có Web Audio, nên phần phát
  âm báo chỉ kiểm được đến bước giải mã.
  **Chưa thử trên iPhone Safari hay Android Chrome thật**, chưa thử hộp thoại xin quyền thông báo thật, chưa thử iOS
  15.0–15.3. Hãy thử từng chức năng chính trên iPhone trước khi dùng thật.

**Ghi chú kỹ thuật (cho người lập trình)** — các điểm nhỏ đã biết, không ảnh hưởng kết quả đã đo:
- `js/platform/bitmap.js` vẽ bằng canvas của trình duyệt, không trùng từng điểm ảnh với Skia của Android (ảnh dựng cho
  OCR có thể khác rất ít). Đường dự phòng onnxruntime-web 1.18.0 (máy không có WASM SIMD, Safari < 16.4) mới thử trên Chromium.
- Đồng bộ Drive: trong lúc chờ áp dụng thay đổi từ máy khác, việc tải lên bị giữ đến khi người dùng rời ô đang gõ; trường
  hợp hiếm có thể tạo hai `du-lieu.json` khi tệp cũ nằm trong Thùng rác; một lần tải lên đang chạy vẫn chạy nốt sau khi
  đăng xuất bắt đầu.
- `PipeBook`, `PipeTable.names`, `PipeFieldVotes.all` trả bản sao cố định thay cho "live view" của Java; `Collator` tiếng
  Việt dùng `Intl.Collator`; ô nhập dùng sự kiện `input` thay cho `TextWatcher`; `Uri.toString` mã hóa hơi khác Android
  (chỉ thấy trong log). Những chỗ này không đổi kết quả hiển thị.
- `Content-Security-Policy` còn `'unsafe-eval'` chỉ vì Safari trước 16 (iOS 15) chặn WebAssembly nếu thiếu nó. Khi không
  cần hỗ trợ iOS 15 nữa có thể bỏ. Bảng điều khiển trình duyệt báo 2 lỗi "inline style" từ thư viện đăng nhập Google:
  đó là kiểu chữ cho nút Google mà app không dùng, bị chặn có chủ ý, vô hại.
- Kiểm thử Node có `onnxruntime-node` (chỉ để chạy test) kéo theo `adm-zip` có cảnh báo bảo mật mức cao; gói này không
  nằm trong trang web.
