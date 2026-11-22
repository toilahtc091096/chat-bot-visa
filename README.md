# Sổ lỗi hồ sơ (chat-bot-visa)

Lấy tin nhắn từ nhóm Zalo "Xử lý hồ sơ lỗi", dùng AI tách ra từng lỗi hồ sơ, cho người dùng sửa trên một bảng web, và có chatbot nhắc người làm hồ sơ cần lưu ý gì để không lặp lại lỗi cũ.

## Tính năng

| Phần | Làm gì |
|---|---|
| **Kết nối Zalo** | Đăng nhập tài khoản Zalo phụ bằng mã QR hiển thị trên web. Lấy lịch sử nhóm N ngày gần nhất, sau đó chạy nền để nhận tin mới theo thời gian thực. |
| **Phân loại ảnh** | Ảnh được xếp vào category theo 3 tầng để tiết kiệm token (xem bên dưới). Category và hint sửa được trên web. |
| **Trích xuất lỗi** | AI đọc từng đoạn chat, rút ra: loại hồ sơ, tên lỗi, meaning, nguyên nhân, cách xử lý, lưu ý tránh lỗi, mức độ, độ tin cậy, tin nhắn gốc. |
| **Bảng lỗi** | Lọc theo loại hồ sơ, trạng thái, tìm kiếm. Bấm vào ô để sửa. Sửa xong lỗi chuyển thành "Đã duyệt". Nguyên nhân AI đoán ban đầu vẫn được giữ lại để so sánh. |
| **Chatbot** | Chọn loại hồ sơ, bấm "Cần lưu ý gì?" để có checklist, hoặc hỏi tự do. Bot chỉ trả lời dựa trên sổ lỗi và ưu tiên lỗi đã duyệt. |

### Phân loại ảnh tiết kiệm token

1. **Ảnh gần giống** (0 token): tính "dấu vân tay" (dHash) của ảnh. Nếu ảnh gần giống một ảnh đã phân loại thì dùng lại kết quả đó.
2. **Theo hint** (model rẻ): gửi ảnh thu nhỏ 384px cùng danh sách category và hint ("ảnh có X thì là loại này") cho Claude Haiku. Kết quả đủ chắc chắn thì dùng luôn.
3. **Xem ảnh đầy đủ** (model mạnh): chỉ khi 2 tầng trên không chắc. Claude Sonnet xem ảnh đầy đủ, xếp loại hoặc tạo category mới, và **viết thêm hint** để những ảnh sau rẻ hơn.

Khi trích xuất lỗi, AI không xem lại ảnh mà chỉ đọc category và mô tả ngắn của ảnh.

## Cài lên VPS

Không dùng Docker (Node.js + pm2)? Xem [DEPLOY.md](DEPLOY.md). Phần dưới đây là cách chạy bằng Docker.

Yêu cầu: VPS Linux (Ubuntu 22.04/24.04), từ 2 GB RAM, đã cài Docker. Nếu chưa có Docker:

```bash
curl -fsSL https://get.docker.com | sh
```

1. Lấy code và tạo file cấu hình:

   ```bash
   git clone https://github.com/toilahtc091096/chat-bot-visa.git
   cd chat-bot-visa
   cp .env.example .env
   nano .env
   ```

   Điền ít nhất:
   - `ANTHROPIC_API_KEY`: khóa API từ console.anthropic.com
   - `APP_USERS`: tài khoản đăng nhập web, ví dụ `lan:MatKhauManh1,minh:MatKhauManh2`
   - `DOMAIN`: tên miền trỏ về IP của VPS (ví dụ `hoso.congty.vn`) để có HTTPS tự động. Chưa có tên miền thì để `:80`.

2. Chạy:

   ```bash
   docker compose up -d --build
   docker compose logs -f app   # xem log, Ctrl+C để thoát
   ```

3. Mở `https://<tên miền>` (hoặc `http://<IP VPS>` nếu dùng `:80`) và đăng nhập.

4. Vào tab **Zalo & hệ thống**:
   1. Bấm **Đăng nhập bằng QR**, mở Zalo trên điện thoại của **tài khoản phụ** và quét mã, rồi xác nhận trên điện thoại.
   2. Bấm **Chọn nhóm**, chọn nhóm "Xử lý hồ sơ lỗi", bấm **Lưu nhóm**.
   3. Nhập số ngày (ví dụ 30) rồi bấm **Lấy lịch sử**. Hệ thống tải tin nhắn, phân loại ảnh và trích xuất lỗi. Theo dõi tiến độ ngay trên trang.

Từ đó tin nhắn mới được lưu tự động. Cứ 30 phút hệ thống xử lý những tin đã "yên" ít nhất 15 phút (chỉnh trong `.env`). Muốn xử lý ngay thì bấm **Xử lý tin mới ngay**.

Cập nhật phiên bản mới:

```bash
git pull && docker compose up -d --build
```

Dữ liệu (cơ sở dữ liệu, ảnh, cookie Zalo) nằm trong thư mục `data/`. Hãy sao lưu thư mục này định kỳ.

## Tài khoản Zalo đang dùng ở dự án khác?

Mỗi tài khoản Zalo chỉ nghe tin được ở một nơi. Nếu tài khoản phụ đã đăng nhập ở dự án khác, chạy Sổ lỗi với `ZALO_MODE=external` và cho dự án kia chuyển tin sang. Xem [INTEGRATION.md](INTEGRATION.md).

## Chi phí AI ước tính

| Việc | Model mặc định | Ghi chú |
|---|---|---|
| Trích xuất lỗi | `claude-sonnet-5-5` | Lần đầu cho vài tuần lịch sử thường dưới vài đô |
| Ảnh tầng 2 | `claude-haiku-5-5` | Ảnh thu nhỏ, rất rẻ |
| Ảnh tầng 3 | `claude-sonnet-5-5` | Chỉ khi cần |
| Chatbot | `claude-haiku-5-5` | 3 đến 5 người dùng: vài đô mỗi tháng |

Tab **Zalo & hệ thống** hiện số token đã dùng và chi phí ước tính trong 30 ngày. Đổi model trong `.env` (các biến `LLM_MODEL_*`).

## Rủi ro và lưu ý

- **zca-js là thư viện không chính thức** và vi phạm điều khoản của Zalo. Tài khoản phụ có thể bị khóa, và thư viện có thể hỏng khi Zalo đổi API. Ứng dụng chỉ **đọc** tin nhắn, không gửi gì, và kéo lịch sử chậm (mặc định nghỉ 2 giây mỗi trang 50 tin).
- Mỗi tài khoản Zalo chỉ có **một phiên Zalo Web** tại một thời điểm. Nếu mở Zalo Web hoặc Zalo PC bằng tài khoản phụ ở nơi khác, ứng dụng có thể bị ngắt và trang hệ thống sẽ báo lỗi. Khi đó hãy đăng nhập QR lại.
- Đăng nhập từ IP của VPS có thể bị Zalo nghi ngờ hơn đăng nhập từ máy nhà. Nếu bị chặn, có thể chạy ứng dụng trên máy cá nhân để quét QR, rồi chép file `data/zalo-credentials.json` lên VPS.
- **Dữ liệu cá nhân**: trước khi gửi chữ lên AI, ứng dụng che số CCCD, hộ chiếu, số điện thoại, email (`MASK_PII=true`). Ảnh thì vẫn được gửi lên AI để phân loại.
- Không commit `.env` và thư mục `data/` lên GitHub (đã có trong `.gitignore`).

## Phát triển

```bash
npm install
cp .env.example .env   # điền giá trị
npm run dev            # http://localhost:3000
npm test
```

Cấu trúc:

```
src/
  index.js        khởi động web + Zalo + lịch xử lý
  server.js       API và đăng nhập web
  zalo/           đăng nhập QR, nghe tin mới, lấy lịch sử
  images.js       phân loại ảnh 3 tầng
  extract.js      trích xuất lỗi bằng AI
  chat.js         chatbot dựa trên sổ lỗi
  pipeline.js     chạy phân loại ảnh + trích xuất theo lịch
public/           giao diện web (HTML/JS thuần, không cần build)
```
