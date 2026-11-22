# Chạy thử trên máy cá nhân

Chạy Sổ lỗi trên máy của bạn với **dữ liệu chat mẫu** (không cần Zalo), để xem bảng lỗi, chatbot và AI hoạt động thế nào trước khi cài lên VPS.

Cần có: **Python 3.10+**, **Git**, một **Postgres**, và **ANTHROPIC_API_KEY**.

## 1. Có Postgres

Chọn **một** cách:

- **Máy đã có Postgres** (ví dụ đang chạy dự án lọc hồ sơ ở máy): dùng luôn, bỏ qua bước này.
- **Có Docker Desktop**: chạy một lệnh

  ```bash
  docker run -d --name so-loi-pg -e POSTGRES_PASSWORD=matkhau -p 5432:5432 postgres:16
  ```

- **Không có cả hai**: cài Postgres từ https://www.postgresql.org/download/ (Windows: bộ cài EDB, nhớ mật khẩu user `postgres` đặt lúc cài).

## 2. Lấy code và cài thư viện

**macOS / Linux** (Terminal):

```bash
git clone https://github.com/toilahtc091096/chat-bot-visa.git
cd chat-bot-visa
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env
```

**Windows** (PowerShell):

```powershell
git clone https://github.com/toilahtc091096/chat-bot-visa.git
cd chat-bot-visa
py -m venv .venv
.venv\Scripts\pip install -r requirements.txt
copy .env.example .env
```

## 3. Sửa file `.env`

Mở file `.env` bằng trình soạn thảo bất kỳ, sửa 3 dòng:

```bash
ANTHROPIC_API_KEY=sk-ant-...
APP_USERS=admin:123456
DATABASE_URL=postgresql://postgres:matkhau@127.0.0.1:5432/postgres
```

(`matkhau` là mật khẩu Postgres ở bước 1. Bảng sẽ nằm trong schema `so_loi`, không đụng gì khác.)

## 4. Nạp dữ liệu mẫu và cho AI xử lý

macOS / Linux:

```bash
.venv/bin/python -m app.cli demo
.venv/bin/python -m app.cli process --force
```

Windows:

```powershell
.venv\Scripts\python -m app.cli demo
.venv\Scripts\python -m app.cli process --force
```

Lệnh thứ nhất nạp 15 tin chat mẫu (lỗi visa Mỹ, Nhật, Schengen, Hàn). Lệnh thứ hai gọi Claude để trích xuất lỗi; kết quả in ra dạng `"created": 5` là AI đã tìm được 5 lỗi. Tốn chưa tới 1 xu.

## 5. Mở web

macOS / Linux: `.venv/bin/python run.py` · Windows: `.venv\Scripts\python run.py`

Mở http://127.0.0.1:3000, đăng nhập `admin` / `123456`, rồi thử:

1. **Bảng lỗi**: xem các lỗi AI tìm được, bấm vào ô để sửa, bấm 💬 xem tin nhắn gốc.
2. **Chatbot**: chọn "Visa Mỹ", bấm **Cần lưu ý gì cho loại hồ sơ này?**
3. **Zalo & hệ thống**: xem chi phí AI đã dùng.

Ctrl+C trong cửa sổ dòng lệnh để tắt.

## Thử với tin nhắn của bạn

Muốn thử nhanh với vài tin thật mà chưa nối Zalo: sửa danh sách `CHAT` trong `app/demo.py` (mỗi dòng: số phút trước, tên người gửi, nội dung), xóa dữ liệu cũ bằng `python -m app.cli clear-demo`, rồi chạy lại bước 4.

## Xóa dữ liệu mẫu

Trước khi nối dự án lọc hồ sơ thật: `python -m app.cli clear-demo`.

## Lỗi hay gặp

| Hiện tượng | Cách xử lý |
|---|---|
| `connection refused` / `PoolTimeout` | Postgres chưa chạy, hoặc sai mật khẩu/cổng trong `DATABASE_URL` |
| `'python3' is not recognized` (Windows) | Dùng `py` thay cho `python3`, hoặc cài Python từ python.org và tick "Add to PATH" |
| `"skipped": true, "reason": "Chưa có ANTHROPIC_API_KEY"` | Chưa điền key trong `.env` |
| Lỗi `authentication_error` từ Anthropic | Key sai hoặc tài khoản Anthropic chưa nạp tiền |
