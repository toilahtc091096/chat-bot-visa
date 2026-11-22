# Chạy Sổ lỗi hồ sơ trên VPS Windows

Hướng dẫn cho VPS **Windows Server / Windows 10-11** đã có PostgreSQL (của dự án lọc hồ sơ). Mọi lệnh chạy trong **PowerShell** (bấm Start, gõ `PowerShell`, chuột phải → **Run as administrator**).

Muốn thử trên máy cá nhân trước? Xem [LOCAL.md](LOCAL.md).

## 1. Cài Python và Git (một lần)

Kiểm tra đã có chưa:

```powershell
py --version     # cần 3.10 trở lên
git --version
```

Chưa có thì cài:

- **Python**: tải tại https://www.python.org/downloads/windows/ . Lúc cài **tick "Add python.exe to PATH"**.
- **Git**: tải tại https://git-scm.com/download/win , cài mặc định.

Cài xong **đóng PowerShell và mở lại** rồi kiểm tra lại 2 lệnh trên.

## 2. Lấy code

```powershell
cd C:\
git clone https://github.com/toilahtc091096/chat-bot-visa.git
cd C:\chat-bot-visa
py -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

## 3. Chuẩn bị Postgres

Tìm `psql.exe` (thường ở `C:\Program Files\PostgreSQL\<phiên bản>\bin\`). Mở psql bằng user `postgres`, vào database của dự án lọc hồ sơ:

```powershell
& "C:\Program Files\PostgreSQL\16\bin\psql.exe" -U postgres -d <ten_database_du_an_kia>
```

(Đổi `16` thành phiên bản trên máy. Nó sẽ hỏi mật khẩu của user `postgres`.)

Trong psql gõ:

```sql
CREATE USER so_loi WITH PASSWORD 'mat-khau-manh';
GRANT CREATE ON DATABASE <ten_database_du_an_kia> TO so_loi;
\q
```

Bảng của Sổ lỗi nằm trong schema `so_loi`, không đụng bảng của dự án kia, và được tạo tự động lần chạy đầu. Muốn tách hẳn thì dùng `CREATE DATABASE so_loi OWNER so_loi;` thay cho dòng `GRANT`.

## 4. Tạo file `.env`

```powershell
copy .env.example .env
notepad .env
```

Sửa các dòng sau rồi lưu (Ctrl+S):

```bash
ANTHROPIC_API_KEY=sk-ant-...
APP_USERS=lan:MatKhauManh1,minh:MatKhauManh2
DATABASE_URL=postgresql://so_loi:mat-khau-manh@127.0.0.1:5432/<ten_database>
HOST=127.0.0.1
PORT=3000
INGEST_TOKEN=<chuỗi ngẫu nhiên>
```

Tạo chuỗi ngẫu nhiên cho `INGEST_TOKEN`:

```powershell
.venv\Scripts\python -c "import secrets; print(secrets.token_hex(32))"
```

Kiểm tra cổng 3000 còn trống (không in gì là trống; nếu có thì đổi `PORT`):

```powershell
netstat -ano | findstr :3000
```

## 5. Chạy thử

```powershell
.venv\Scripts\python run.py
```

Thấy `Uvicorn running on http://127.0.0.1:3000` là được. Mở trình duyệt **ngay trên VPS** (qua Remote Desktop) và vào http://127.0.0.1:3000 , đăng nhập bằng tài khoản trong `APP_USERS`.

Muốn xem thử với dữ liệu mẫu trước khi nối Zalo, mở thêm một cửa sổ PowerShell:

```powershell
cd C:\chat-bot-visa
.venv\Scripts\python -m app.cli demo
.venv\Scripts\python -m app.cli process --force
```

Tải lại trang web, tab **Bảng lỗi** sẽ có các lỗi AI tìm được từ chat mẫu. Xem xong thì xóa dữ liệu mẫu: `.venv\Scripts\python -m app.cli clear-demo`.

Ctrl+C ở cửa sổ đang chạy `run.py` để dừng, rồi chuyển sang bước 6.

## 6. Chạy nền, tự khởi động cùng Windows (NSSM)

Dùng **NSSM** để biến Sổ lỗi thành một Windows Service.

1. Tải NSSM tại https://nssm.cc/download , giải nén, chép `win64\nssm.exe` vào `C:\nssm\nssm.exe`.
2. Chạy trong PowerShell (administrator):

   ```powershell
   mkdir C:\chat-bot-visa\logs -Force
   C:\nssm\nssm.exe install SoLoi "C:\chat-bot-visa\.venv\Scripts\python.exe" "run.py"
   C:\nssm\nssm.exe set SoLoi AppDirectory "C:\chat-bot-visa"
   C:\nssm\nssm.exe set SoLoi AppStdout "C:\chat-bot-visa\logs\so-loi.log"
   C:\nssm\nssm.exe set SoLoi AppStderr "C:\chat-bot-visa\logs\so-loi.log"
   C:\nssm\nssm.exe set SoLoi Start SERVICE_AUTO_START
   C:\nssm\nssm.exe start SoLoi
   ```

3. Kiểm tra:

   ```powershell
   Get-Service SoLoi                                       # Status phải là Running
   Get-Content C:\chat-bot-visa\logs\so-loi.log -Tail 20   # xem log
   ```

Dự án lọc hồ sơ đang chạy bằng cách khác (Task Scheduler, pm2...)? Dùng cùng cách cũng được; lệnh cần chạy là `C:\chat-bot-visa\.venv\Scripts\python.exe run.py` trong thư mục `C:\chat-bot-visa`.

## 7. Kiểm tra đường nhận tin

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3000/api/ingest `
  -Headers @{ "X-Ingest-Token" = "<INGEST_TOKEN>" } `
  -ContentType "application/json" -Body '{"messages":[]}'
```

Đúng thì in ra `received 0, accepted 0, added 0`.

## 8. Nối dự án lọc hồ sơ

Làm theo [INTEGRATION.md](INTEGRATION.md): chép `integration\zlapi_forwarder.py` sang dự án kia, đặt `SO_LOI_URL=http://127.0.0.1:3000`, `SO_LOI_TOKEN`, `SO_LOI_GROUP_ID`, thêm 1 dòng vào `onMessage`, gửi lịch sử cũ một lần, rồi khởi động lại dự án kia.

Sau đó vào web, tab **Zalo & hệ thống** sẽ thấy số tin tăng. Bấm **Xử lý tin mới ngay**, rồi xem **Bảng lỗi**.

## Cập nhật phiên bản mới

```powershell
cd C:\chat-bot-visa
git pull
.venv\Scripts\pip install -r requirements.txt
C:\nssm\nssm.exe restart SoLoi
```

## Cho cả nhóm truy cập từ máy khác

Mặc định (`HOST=127.0.0.1`) chỉ mở được ngay trên VPS. Để 3 đến 5 người dùng từ máy của họ:

1. Sửa `.env`: `HOST=0.0.0.0`, rồi `C:\nssm\nssm.exe restart SoLoi`.
2. Mở cổng trên tường lửa Windows:

   ```powershell
   New-NetFirewallRule -DisplayName "So loi ho so" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
   ```

3. Mọi người vào `http://<IP VPS>:3000`. Nếu nhà cung cấp VPS có tường lửa riêng trên trang quản lý, mở thêm cổng 3000 ở đó.

Lưu ý: cách này dùng HTTP, mật khẩu không được mã hóa trên đường truyền. Khi dùng lâu dài nên có tên miền + HTTPS (ví dụ Caddy cho Windows hoặc IIS reverse proxy), mình có thể hướng dẫn thêm khi cần.

## Sao lưu

```powershell
& "C:\Program Files\PostgreSQL\16\bin\pg_dump.exe" -U postgres -n so_loi <ten_database> -f C:\backup\so-loi-$(Get-Date -Format yyyy-MM-dd).sql
```

Và chép thư mục ảnh `C:\chat-bot-visa\data\images`.

## Lỗi hay gặp

| Hiện tượng | Cách xử lý |
|---|---|
| `py` / `python` không nhận | Cài lại Python và tick "Add python.exe to PATH", rồi mở lại PowerShell |
| `pip install` lỗi | Kiểm tra `py --version` là 3.10 trở lên; thử `.venv\Scripts\python -m pip install --upgrade pip` rồi cài lại |
| `PoolTimeout` / `connection refused` | Postgres chưa chạy (`Get-Service postgresql*`) hoặc sai mật khẩu/cổng trong `DATABASE_URL` |
| `permission denied for database` | Chưa chạy lệnh `GRANT CREATE ...` ở bước 3 |
| `address already in use` / `[WinError 10048]` | Cổng đã bị chiếm, đổi `PORT` (và `SO_LOI_URL` bên dự án kia) |
| Service SoLoi dừng liên tục | Xem `C:\chat-bot-visa\logs\so-loi.log` |
| Dự án kia log `[so-loi] Chưa gửi được ... 401` | `SO_LOI_TOKEN` không giống `INGEST_TOKEN` |
| Web báo "Chưa cấu hình ANTHROPIC_API_KEY" | Thêm key vào `.env` rồi `C:\nssm\nssm.exe restart SoLoi` |
