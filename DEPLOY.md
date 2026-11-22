# Chạy Sổ lỗi hồ sơ trên VPS (Python + Postgres, không cần Docker)

Hướng dẫn cho VPS Ubuntu/Debian đã có Postgres (của dự án lọc hồ sơ). Lấy code bằng `git pull`, chạy bằng systemd.

## 1. Cài gói hệ thống (một lần)

```bash
python3 --version          # cần 3.10 trở lên
sudo apt-get update
sudo apt-get install -y python3-venv git
```

## 2. Lấy code

```bash
cd ~
git clone https://github.com/toilahtc091096/chat-bot-visa.git
cd chat-bot-visa
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## 3. Chuẩn bị Postgres

Khuyên dùng **chung database** với dự án lọc hồ sơ nhưng **user riêng**. Bảng của Sổ lỗi nằm trong schema `so_loi` nên không đụng bảng của dự án kia.

```bash
sudo -u postgres psql -d <ten_database_du_an_kia>
```

```sql
CREATE USER so_loi WITH PASSWORD 'mat-khau-manh';
GRANT CREATE ON DATABASE <ten_database_du_an_kia> TO so_loi;   -- để tạo schema so_loi
\q
```

Muốn tách hẳn thì tạo database riêng: `CREATE DATABASE so_loi OWNER so_loi;`.

Bảng được tạo tự động ở lần chạy đầu.

## 4. Tạo file `.env`

```bash
cp .env.example .env
nano .env
```

Sửa các dòng:

```bash
ANTHROPIC_API_KEY=sk-ant-...
APP_USERS=lan:MatKhauManh1,minh:MatKhauManh2
DATABASE_URL=postgresql://so_loi:mat-khau-manh@127.0.0.1:5432/<ten_database>
HOST=127.0.0.1
PORT=3000                 # đổi nếu cổng 3000 đã có dự án khác dùng (kiểm tra: ss -ltnp | grep :3000)
INGEST_TOKEN=             # dán kết quả của: openssl rand -hex 32
```

## 5. Chạy thử

```bash
.venv/bin/python run.py
```

Thấy `Uvicorn running on http://127.0.0.1:3000` là được. Mở cửa sổ SSH khác và thử (thay `<token>`):

```bash
curl -s -X POST http://127.0.0.1:3000/api/ingest \
  -H "Content-Type: application/json" -H "X-Ingest-Token: <token>" \
  -d '{"messages":[]}'
# Đúng: {"received":0,"accepted":0,"added":0,"groupId":""}
```

Kiểm tra bảng đã được tạo: `psql "<DATABASE_URL>" -c '\dt so_loi.*'`

Ctrl+C để dừng, chuyển sang chạy nền ở bước 6.

## 6. Chạy nền bằng systemd

```bash
sudo tee /etc/systemd/system/so-loi.service > /dev/null <<UNIT
[Unit]
Description=So loi ho so
After=network.target postgresql.service

[Service]
User=$USER
WorkingDirectory=$HOME/chat-bot-visa
ExecStart=$HOME/chat-bot-visa/.venv/bin/python run.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now so-loi
sudo systemctl status so-loi          # phải là active (running)
journalctl -u so-loi -f               # xem log, Ctrl+C để thoát
```

Dự án kia đang dùng pm2 hoặc supervisor? Dùng cùng công cụ cũng được, ví dụ với pm2:
`pm2 start run.py --name so-loi --interpreter .venv/bin/python && pm2 save`.

## 7. Mở web từ máy của bạn

Không cần mở cổng ra Internet, dùng đường hầm SSH:

```bash
ssh -L 3000:127.0.0.1:3000 <user>@<IP VPS>
```

Giữ cửa sổ đó, vào `http://localhost:3000`, đăng nhập bằng tài khoản trong `APP_USERS`. Tab **Zalo & hệ thống** phải ghi "Nhận tin từ dự án khác" và không có cảnh báo thiếu API key.

## 8. Nối dự án lọc hồ sơ

Làm theo [INTEGRATION.md](INTEGRATION.md) (thêm 1 dòng vào `onMessage`, gửi lịch sử cũ một lần). Sau đó bấm **Xử lý tin mới ngay** và xem **Bảng lỗi**.

## Cập nhật phiên bản mới

```bash
cd ~/chat-bot-visa
git pull
.venv/bin/pip install -r requirements.txt
sudo systemctl restart so-loi
```

## Cho cả nhóm truy cập (khi đã chạy ổn)

Nên có tên miền + HTTPS qua nginx:

```nginx
server {
    server_name hoso.congty.vn;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        client_max_body_size 20m;
    }
}
```

Rồi `sudo certbot --nginx -d hoso.congty.vn`. Không có tên miền thì tạm đặt `HOST=0.0.0.0` và mở cổng (`sudo ufw allow 3000`), nhưng mật khẩu sẽ đi qua mạng không mã hóa.

## Sao lưu

- Dữ liệu: `pg_dump -n so_loi <ten_database> > so-loi-$(date +%F).sql`
- Ảnh: thư mục `~/chat-bot-visa/data/images/`

## Lỗi hay gặp

| Hiện tượng | Cách xử lý |
|---|---|
| `permission denied for database` khi khởi động | Chưa `GRANT CREATE ON DATABASE ... TO so_loi` (bước 3) |
| `connection refused` tới Postgres | Sai host/cổng trong `DATABASE_URL`, kiểm tra `sudo ss -ltnp \| grep 5432` |
| `address already in use` | Cổng đã có dự án khác dùng, đổi `PORT` (và `SO_LOI_URL` bên dự án kia) |
| Dự án kia log `[so-loi] Chưa gửi được ... 401` | `SO_LOI_TOKEN` không giống `INGEST_TOKEN` |
| Dự án kia log `Connection refused` | Sổ lỗi chưa chạy (`systemctl status so-loi`) hoặc sai `SO_LOI_URL` |
| Web báo "Chưa cấu hình ANTHROPIC_API_KEY" | Thêm key vào `.env` rồi `sudo systemctl restart so-loi` |

## Muốn dùng Docker?

```bash
cp .env.example .env && nano .env    # như bước 4, nhưng DATABASE_URL dùng host.docker.internal thay cho 127.0.0.1
docker compose up -d --build
docker compose logs -f app
```

Khi đó Postgres phải cho phép kết nối từ mạng Docker (`listen_addresses` và `pg_hba.conf`), nên cách chạy trực tiếp ở trên đơn giản hơn.
