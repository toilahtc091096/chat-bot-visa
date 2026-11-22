# Chạy Sổ lỗi hồ sơ trên VPS (không dùng Docker)

Hướng dẫn cho VPS Ubuntu/Debian, chạy bằng Node.js + pm2, lấy code bằng `git pull`.
Giả sử tài khoản Zalo **đang đăng nhập ở dự án lọc hồ sơ**, nên Sổ lỗi chạy ở chế độ `external` (xem [INTEGRATION.md](INTEGRATION.md)).

## 1. Cài Node.js 22 và pm2 (một lần)

```bash
node -v   # nếu đã có v22 trở lên thì bỏ qua 2 lệnh dưới
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git build-essential python3

sudo npm install -g pm2   # nếu dự án kia đã dùng pm2 thì bỏ qua
```

## 2. Lấy code

```bash
cd ~
git clone https://github.com/toilahtc091096/chat-bot-visa.git
cd chat-bot-visa
npm ci --omit=dev
```

> Nếu code chưa có trên GitHub, dùng file `chat-bot-visa.bundle` (bản đóng gói của git): chép lên VPS bằng
> `scp chat-bot-visa.bundle <user>@<IP VPS>:~/` rồi chạy
> `git clone -b feat/mvp ~/chat-bot-visa.bundle ~/chat-bot-visa && cd ~/chat-bot-visa && npm ci --omit=dev`.
> Khi code đã lên GitHub: `git remote set-url origin https://github.com/toilahtc091096/chat-bot-visa.git && git pull origin main`.

## 3. Tạo file `.env`

```bash
cp .env.example .env
nano .env
```

Sửa các dòng sau (các dòng khác để mặc định):

```bash
ANTHROPIC_API_KEY=sk-ant-...
APP_USERS=lan:MatKhauManh1,minh:MatKhauManh2
PORT=3000                 # đổi nếu cổng 3000 đã có dự án khác dùng
HOST=127.0.0.1            # chỉ mở trong VPS
ZALO_MODE=external
INGEST_TOKEN=             # dán kết quả của: openssl rand -hex 32
```

Kiểm tra cổng còn trống: `ss -ltnp | grep :3000` (không in gì là trống).

## 4. Chạy bằng pm2

```bash
pm2 start src/index.js --name so-loi
pm2 logs so-loi --lines 20      # Ctrl+C để thoát
pm2 save                        # tự chạy lại khi VPS khởi động lại
pm2 startup                     # chỉ cần nếu pm2 chưa được cài tự khởi động; làm theo lệnh nó in ra
```

Log đúng sẽ có:

```
[zalo] Chế độ external: nhận tin từ dự án khác qua POST /api/ingest
[web] Đang chạy tại http://127.0.0.1:3000
```

## 5. Kiểm tra

**Trên VPS**, thử gửi tin rỗng (thay `<token>` bằng INGEST_TOKEN):

```bash
curl -s -X POST http://127.0.0.1:3000/api/ingest \
  -H "Content-Type: application/json" -H "X-Ingest-Token: <token>" \
  -d '{"messages":[]}'
# Đúng: {"received":0,"accepted":0,"added":0,"groupId":""}
```

**Mở web từ máy tính của bạn** (không cần mở cổng ra Internet), dùng đường hầm SSH:

```bash
ssh -L 3000:127.0.0.1:3000 <user>@<IP VPS>
```

Giữ cửa sổ đó mở, rồi vào `http://localhost:3000` trên trình duyệt, đăng nhập bằng tài khoản trong `APP_USERS`. Tab **Zalo & hệ thống** phải ghi "Nhận tin từ dự án khác" và không có cảnh báo thiếu API key.

## 6. Nối dự án lọc hồ sơ

Làm bước 2 và 3 trong [INTEGRATION.md](INTEGRATION.md): chép `integration/zalo-forwarder.js` sang dự án kia, đặt `SO_LOI_URL=http://127.0.0.1:3000`, `SO_LOI_TOKEN`, `SO_LOI_GROUP_ID`, thêm dòng `forwardToSoLoi(message)`, chạy `backfillToSoLoi(api, 30)` một lần, rồi `pm2 restart <tên dự án kia>`.

Sau đó trên web Sổ lỗi, tab **Zalo & hệ thống**: số tin đã lưu phải tăng. Bấm **Xử lý tin mới ngay**, đợi vài phút rồi xem tab **Bảng lỗi** và **Ảnh**.

## 7. Cập nhật phiên bản mới

```bash
cd ~/chat-bot-visa
git pull
npm ci --omit=dev
pm2 restart so-loi
```

## 8. Cho cả nhóm truy cập (khi đã chạy ổn)

Đường hầm SSH chỉ hợp để kiểm tra. Để 3 đến 5 người dùng hằng ngày, nên có tên miền và HTTPS. Nếu VPS đã có nginx:

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

Rồi cấp HTTPS miễn phí: `sudo certbot --nginx -d hoso.congty.vn`.

Không có tên miền thì có thể đặt `HOST=0.0.0.0` và mở cổng (`sudo ufw allow 3000`), nhưng khi đó mật khẩu đi qua mạng không mã hóa, chỉ nên dùng tạm.

## Sao lưu

Toàn bộ dữ liệu nằm trong `~/chat-bot-visa/data/`. Sao lưu định kỳ, ví dụ:

```bash
tar czf ~/so-loi-backup-$(date +%F).tgz -C ~/chat-bot-visa data
```

## Lỗi hay gặp

| Hiện tượng | Cách xử lý |
|---|---|
| `npm ci` lỗi khi build `better-sqlite3` hoặc `sharp` | Cài `build-essential python3`, kiểm tra `node -v` là 22 trở lên |
| `EADDRINUSE` trong log | Cổng đã có dự án khác dùng, đổi `PORT` trong `.env` (và `SO_LOI_URL` bên dự án kia) |
| Dự án kia log `Sổ lỗi trả về HTTP 401` | `SO_LOI_TOKEN` không giống `INGEST_TOKEN` |
| Dự án kia log `fetch failed` | Sổ lỗi chưa chạy (`pm2 status`) hoặc sai `SO_LOI_URL` |
| Web báo "Chưa cấu hình ANTHROPIC_API_KEY" | Thêm key vào `.env` rồi `pm2 restart so-loi --update-env` |

---

## Muốn dùng Docker thay pm2?

```bash
curl -fsSL https://get.docker.com | sh
cd ~/chat-bot-visa && cp .env.example .env && nano .env   # như bước 3
docker compose up -d --build app      # chỉ chạy app, bỏ Caddy nếu VPS đã có nginx
docker compose logs -f app
```

Lưu ý khi dùng Docker: dự án kia (chạy ngoài Docker) vẫn gọi `http://127.0.0.1:3000` được vì cổng đã được mở trên 127.0.0.1. Nếu muốn có cả HTTPS tự động bằng Caddy thì đặt `DOMAIN` trong `.env` và chạy `docker compose up -d --build` (cần cổng 80/443 còn trống).
