# Nối Sổ lỗi hồ sơ với dự án đang đăng nhập Zalo

## Vì sao cần

Mỗi tài khoản Zalo chỉ giữ được **một kết nối nghe tin (listener)** tại một thời điểm. Nếu Sổ lỗi cũng đăng nhập cùng tài khoản đó, hai bên sẽ đá nhau ra liên tục (lỗi `3000 DuplicateConnection`).

Vì vậy, khi tài khoản Zalo đã được dự án khác (dự án lọc hồ sơ) dùng để nghe tin:

- **Dự án kia** vẫn giữ đăng nhập Zalo như hiện tại, chỉ thêm vài dòng để **chuyển tin** của nhóm "Xử lý hồ sơ lỗi" sang Sổ lỗi.
- **Sổ lỗi** chạy ở chế độ `external`: không đăng nhập Zalo, chỉ nhận tin qua `POST /api/ingest`, rồi phân loại ảnh, trích xuất lỗi, hiện bảng lỗi và chatbot như bình thường.

```
Zalo ──► Dự án lọc hồ sơ (listener sẵn có) ──► POST /api/ingest ──► Sổ lỗi hồ sơ (web + AI)
                     └─ xử lý hồ sơ như cũ
```

Cách này không phải trộn code hai dự án vào nhau: mỗi bên cập nhật, khởi động lại, hay hỏng đều không kéo bên kia theo.

## Bước 1: chạy Sổ lỗi ở chế độ external

Làm theo phần "Cài lên VPS" trong [README.md](README.md). Trong file `.env`, thêm:

```bash
ZALO_MODE=external
INGEST_TOKEN=<chuỗi ngẫu nhiên>   # tạo bằng: openssl rand -hex 32
```

Rồi chạy `docker compose up -d --build`. Trang **Zalo & hệ thống** sẽ ghi "Nhận tin từ dự án khác".

Kiểm tra nhanh trên VPS (thay `<token>`):

```bash
curl -s -X POST http://127.0.0.1:3000/api/ingest \
  -H "Content-Type: application/json" -H "X-Ingest-Token: <token>" \
  -d '{"messages":[]}'
# Kết quả mong đợi: {"received":0,"accepted":0,"added":0,"groupId":""}
```

## Bước 2: lấy id nhóm Zalo

Trong dự án kia, in id nhóm ra một lần, ví dụ thêm tạm vào listener:

```js
listener.on("message", (m) => console.log(m.threadId, m.data.dName, m.data.content));
```

Gửi một tin vào nhóm "Xử lý hồ sơ lỗi" và ghi lại `threadId` in ra. Đó là `SO_LOI_GROUP_ID`.

## Bước 3: thêm bộ chuyển tin vào dự án kia

> Hướng dẫn này dành cho dự án dùng **zca-js** (Node.js). Nếu dự án kia dùng thư viện khác (ví dụ zlapi của Python), xem mục "Dự án dùng ngôn ngữ khác" ở cuối.

1. Chép file [`integration/zalo-forwarder.js`](integration/zalo-forwarder.js) vào dự án kia.
2. Thêm biến môi trường cho dự án kia:

   ```bash
   SO_LOI_URL=http://127.0.0.1:3000   # xem ghi chú mạng bên dưới
   SO_LOI_TOKEN=<giống INGEST_TOKEN>
   SO_LOI_GROUP_ID=<id nhóm ở bước 2>
   ```

3. Ở chỗ dự án kia đang nghe tin, thêm **một dòng** (giữ nguyên xử lý cũ):

   ```js
   import { forwardToSoLoi } from "./zalo-forwarder.js";

   api.listener.on("message", (message) => {
     forwardToSoLoi(message);   // ← thêm dòng này
     // ... code lọc hồ sơ hiện có giữ nguyên ...
   });
   ```

   Hàm này chỉ chuyển tin của đúng nhóm `SO_LOI_GROUP_ID`, gửi theo lô mỗi 5 giây, và tự thử lại nếu Sổ lỗi đang tắt. Nó không chặn hay làm chậm code hiện có.

4. Gửi lịch sử cũ **một lần** (ví dụ 30 ngày), dùng luôn `api` đã đăng nhập, không cần quét QR lại:

   ```js
   import { backfillToSoLoi } from "./zalo-forwarder.js";

   // chạy 1 lần sau khi đăng nhập xong, rồi có thể xóa dòng này
   backfillToSoLoi(api, 30).then((n) => console.log("Đã gửi lịch sử:", n, "tin"));
   ```

   Gửi trùng không sao, Sổ lỗi tự bỏ tin đã có.

5. Khởi động lại dự án kia.

## Bước 4: xử lý và kiểm tra

Mở Sổ lỗi, vào **Zalo & hệ thống**. Bạn sẽ thấy số tin đã lưu và "Lần nhận tin gần nhất". Bấm **Xử lý tin mới ngay** để AI phân loại ảnh và trích xuất lỗi lần đầu. Sau đó hệ thống tự xử lý mỗi 30 phút.

## Ghi chú mạng (SO_LOI_URL)

| Dự án kia chạy ở đâu | SO_LOI_URL |
|---|---|
| Cùng VPS, chạy trực tiếp (node/pm2) | `http://127.0.0.1:3000` |
| Cùng VPS, chạy trong Docker | `http://host.docker.internal:3000` và thêm `extra_hosts: ["host.docker.internal:host-gateway"]` vào service của dự án kia. Đồng thời đổi cổng của Sổ lỗi trong `docker-compose.yml` từ `127.0.0.1:3000:3000` thành `172.17.0.1:3000:3000`. |
| Máy khác | `https://<tên miền của Sổ lỗi>` (đi qua HTTPS của Caddy) |

## Dự án dùng ngôn ngữ khác

Chỉ cần gửi HTTP:

```
POST <SO_LOI_URL>/api/ingest
Header: X-Ingest-Token: <INGEST_TOKEN>
Body:   { "messages": [ { "threadId": "<id nhóm>", "data": { ...tin nhắn gốc... } } ] }
```

`data` cần có tối thiểu: `msgId`, `ts` (mili giây), `uidFrom`, `dName` (tên người gửi), `msgType` (`webchat` cho chữ, `chat.photo` cho ảnh), `content` (chuỗi với tin chữ; với ảnh là object có `href`, `thumb`, `title`). Có thể kèm `quote` (`{ globalMsgId, msg }`) nếu là tin trả lời.
