# Sổ lỗi hồ sơ (chat-bot-visa)

Nhận tin nhắn từ nhóm Zalo "Xử lý hồ sơ lỗi", dùng AI tách ra từng lỗi hồ sơ, cho người dùng sửa trên một bảng web, và có chatbot nhắc người làm hồ sơ cần lưu ý gì để không lặp lại lỗi cũ.

**Công nghệ:** Python 3.10+, FastAPI, PostgreSQL, Claude (Anthropic API). Giao diện là HTML/JS thuần, không cần build.

Tài khoản Zalo đăng nhập ở **dự án lọc hồ sơ** (zlapi). Dự án đó chuyển tin của nhóm sang đây qua `POST /api/ingest` ([INTEGRATION.md](INTEGRATION.md)), vì mỗi tài khoản Zalo chỉ nghe tin được ở một nơi.

## Tính năng

| Phần | Làm gì |
|---|---|
| **Nhận tin** | Dự án lọc hồ sơ gửi tin mới theo thời gian thực, và gửi lịch sử N ngày một lần. |
| **Phân loại ảnh** | Ảnh được xếp vào category theo 3 tầng để tiết kiệm token (xem bên dưới). Category và hint sửa được trên web. |
| **Trích xuất lỗi** | AI đọc từng đoạn chat, rút ra: loại hồ sơ, tên lỗi, meaning, nguyên nhân, cách xử lý, lưu ý tránh lỗi, mức độ, độ tin cậy, tin nhắn gốc. |
| **Bảng lỗi** | Lọc theo loại hồ sơ, trạng thái, tìm kiếm. Bấm vào ô để sửa; sửa xong lỗi thành "Đã duyệt". Nguyên nhân AI đoán ban đầu vẫn được giữ để so sánh. |
| **Chatbot** | Chọn loại hồ sơ, bấm "Cần lưu ý gì?" để có checklist, hoặc hỏi tự do. Bot chỉ trả lời dựa trên sổ lỗi và ưu tiên lỗi đã duyệt. |

### Phân loại ảnh tiết kiệm token

1. **Ảnh gần giống** (0 token): tính "dấu vân tay" (dHash). Nếu gần giống một ảnh đã phân loại thì dùng lại kết quả.
2. **Theo hint** (model rẻ): gửi ảnh thu nhỏ 384px cùng danh sách category và hint ("ảnh có X thì là loại này") cho Claude Haiku. Đủ chắc chắn thì dùng luôn.
3. **Xem ảnh đầy đủ** (model mạnh): chỉ khi 2 tầng trên không chắc. Claude Sonnet xếp loại hoặc tạo category mới, và **viết thêm hint** để ảnh sau rẻ hơn.

Khi trích xuất lỗi, AI không xem lại ảnh mà chỉ đọc category và mô tả ngắn của ảnh.

## Cài đặt

- Chạy trên VPS: [DEPLOY.md](DEPLOY.md)
- Nối dự án lọc hồ sơ: [INTEGRATION.md](INTEGRATION.md)

## Chi phí AI ước tính

| Việc | Model mặc định | Ghi chú |
|---|---|---|
| Trích xuất lỗi | `claude-sonnet-5-5` | Lần đầu cho vài tuần lịch sử thường dưới vài đô |
| Ảnh tầng 2 | `claude-haiku-5-5` | Ảnh thu nhỏ, rất rẻ |
| Ảnh tầng 3 | `claude-sonnet-5-5` | Chỉ khi cần |
| Chatbot | `claude-haiku-5-5` | 3 đến 5 người dùng: vài đô mỗi tháng |

Tab **Zalo & hệ thống** hiện số token và chi phí ước tính 30 ngày. Đổi model trong `.env` (các biến `LLM_MODEL_*`).

## Lưu ý

- Thư viện Zalo (zlapi) là thư viện không chính thức; tài khoản phụ có thể bị khóa. Sổ lỗi chỉ đọc tin do dự án kia chuyển sang, không gọi Zalo.
- **Dữ liệu cá nhân:** trước khi gửi chữ lên AI, ứng dụng che số CCCD, hộ chiếu, số điện thoại, email (`MASK_PII=true`). Ảnh vẫn được gửi lên AI để phân loại.
- Không commit `.env` và thư mục `data/`.

## Phát triển

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
cp .env.example .env            # điền DATABASE_URL, APP_USERS...
.venv/bin/python run.py         # http://127.0.0.1:3000

# test cần một Postgres (tạo schema tạm rồi xóa)
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres .venv/bin/python -m pytest
```

Cấu trúc:

```
app/
  main.py        API, đăng nhập web, nhận tin (/api/ingest)
  store.py       lưu tin nhắn
  images.py      phân loại ảnh 3 tầng
  extract.py     trích xuất lỗi bằng AI
  chat.py        chatbot dựa trên sổ lỗi
  pipeline.py    chạy phân loại ảnh + trích xuất theo lịch
  db.py          Postgres (schema so_loi)
integration/
  zlapi_forwarder.py   chép sang dự án lọc hồ sơ
public/          giao diện web
```
