# Đưa lên GitHub Pages — danh sách tệp

Các bước bấm chi tiết (GitHub Desktop, bật Pages, Google Cloud): xem `README.md`, mục 2 và 3.

## Bắt buộc (trang web cần đủ các mục này)

```
index.html
sw.js
app.webmanifest
.nojekyll
css/
js/
assets/
```

Khoảng 370 tệp, 65 MB. Tệp lớn nhất: `assets/vietocr/encoder.onnx` (24 MB, dưới giới hạn 100 MB của GitHub).

## Nên có

```
README.md
DEPLOY.md
```

`bench.html` (cùng `css/bench.css`, `js/bench.js` đã có trong `css/`, `js/`): trang đo tốc độ đọc ảnh trên máy người
xem, chỉ dùng ảnh mẫu vẽ sẵn, không đăng nhập — https://yatorv.github.io/PBB/bench.html (Task A3, `docs/PERF.md`).
Từ Task A5, app đọc bằng chip (WASM) mặc định; trang này có nút "Bật thử WebGPU trong app" cho máy đang xem (GPU chỉ
phụ đọc chữ, có kiểm tra bằng chip) và dòng đo "WASM 2 worker + WebGPU đọc chữ" cho biết GPU của máy lệch bao nhiêu.

## Không bắt buộc (chỉ dành cho người lập trình; trang web không dùng)

```
docs/
tests/
tests-e2e/
tools/
package.json
package-lock.json
playwright.config.mjs
```

`tools/ui-harness.html` tự từ chối chạy khi không ở trên máy (localhost), nên đưa lên cũng không mở được app khi chưa đăng nhập.

## Không bao giờ đưa lên

```
node_modules/
.eval/
.superpowers/
.git/            (của thư mục này — kho clone từ GitHub có .git riêng, giữ nguyên)
test-results/, playwright-report/
```

## Kiểm tra sau khi đăng

1. https://yatorv.github.io/PBB/ hiện màn hình "Lịch đi làm" và nút **Đăng nhập bằng Google**.
2. Đăng nhập được, vào màn hình chính.
3. Google Drive có thư mục `App-Lich-Di-Lam` với `du-lieu.json` sau thay đổi đầu tiên.
4. Trên iPhone: Safari → Chia sẻ → **Thêm vào MH chính**, mở từ biểu tượng, vào **Nhắc lịch** → **Thử ngay**.

## Quay lại bản trước nếu bản mới lỗi

GitHub Desktop → thẻ **History** → bấm chuột phải vào lần commit lỗi → **Revert changes in commit** → **Push origin**.
Khoảng 1 phút sau trang trở lại bản trước. Dữ liệu trên Google Drive không bị ảnh hưởng.
