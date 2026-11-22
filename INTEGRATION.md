# Nối Sổ lỗi hồ sơ với dự án lọc hồ sơ (Python + zlapi)

## Vì sao cần

Mỗi tài khoản Zalo chỉ giữ được **một kết nối nghe tin** tại một thời điểm. Tài khoản phụ đang đăng nhập ở dự án lọc hồ sơ, nên Sổ lỗi **không đăng nhập Zalo**. Thay vào đó, dự án kia chuyển tin của nhóm "Xử lý hồ sơ lỗi" sang:

```
Zalo ──► Dự án lọc hồ sơ (zlapi, onMessage sẵn có) ──► POST /api/ingest ──► Sổ lỗi hồ sơ (FastAPI + AI)
                     └─ lọc hồ sơ như cũ                                         └─ Postgres, schema so_loi
```

Hai dự án chạy riêng (cập nhật, khởi động lại, hay lỗi bên này không kéo bên kia), nhưng có thể dùng **chung một Postgres**: bảng của Sổ lỗi nằm trong schema `so_loi`, nên kiểm tra bằng cùng công cụ, cùng kết nối được.

## Bước 1: chạy Sổ lỗi

Làm theo [DEPLOY.md](DEPLOY.md). Ghi lại `INGEST_TOKEN` đã đặt trong `.env`.

## Bước 2: lấy id nhóm Zalo

Trong `onMessage` của dự án kia, in tạm ra:

```python
print(thread_id, thread_type, message)
```

Gửi một tin vào nhóm "Xử lý hồ sơ lỗi", ghi lại `thread_id` in ra. Đó là `SO_LOI_GROUP_ID`. Xong thì xóa dòng in.

## Bước 3: thêm bộ chuyển tin vào dự án kia

1. Chép file [`integration/zlapi_forwarder.py`](integration/zlapi_forwarder.py) vào cạnh file bot của dự án kia. File chỉ dùng thư viện chuẩn, không cần cài thêm gì.
2. Thêm biến môi trường cho dự án kia (file `.env` hoặc cấu hình service):

   ```bash
   SO_LOI_URL=http://127.0.0.1:3000
   SO_LOI_TOKEN=<giống INGEST_TOKEN>
   SO_LOI_GROUP_ID=<id nhóm ở bước 2>
   ```

   Nếu dự án kia đọc `.env` bằng python-dotenv thì phải `load_dotenv()` **trước** dòng `import zlapi_forwarder`.

3. Trong `onMessage`, thêm **một dòng** (giữ nguyên code lọc hồ sơ):

   ```python
   from zlapi_forwarder import forward_to_so_loi

   class Bot(ZaloAPI):
       def onMessage(self, mid, author_id, message, message_object, thread_id, thread_type):
           forward_to_so_loi(message_object, thread_id)   # ← thêm dòng này
           # ... code lọc hồ sơ hiện có giữ nguyên ...
   ```

   Hàm chỉ chuyển tin của đúng nhóm `SO_LOI_GROUP_ID`, gửi theo lô mỗi 5 giây ở luồng riêng, tự thử lại nếu Sổ lỗi đang tắt. Không chặn và không làm chậm code hiện có.

4. Gửi lịch sử cũ **một lần**, dùng luôn phiên đăng nhập của bot (không quét QR lại). Ví dụ thêm tạm sau khi bot đăng nhập, trước `bot.listen()`:

   ```python
   from zlapi_forwarder import backfill_to_so_loi

   print("Đã gửi lịch sử:", backfill_to_so_loi(bot, days=30), "tin")
   ```

   Chạy xong thì xóa dòng này. Gửi trùng không sao, Sổ lỗi tự bỏ tin đã có. Hàm nghỉ 2 giây giữa mỗi trang 50 tin.

5. Khởi động lại dự án kia.

> Dự án kia dùng bản async của zlapi (`zlapi.Async`)? `forward_to_so_loi` vẫn dùng được nguyên như trên. Riêng `backfill_to_so_loi` viết cho bản thường; báo lại để chỉnh nếu cần.

## Bước 4: kiểm tra

- Log dự án kia không có dòng `[so-loi] Chưa gửi được`.
- Web Sổ lỗi, tab **Zalo & hệ thống**: số tin đã lưu tăng, có "Lần nhận tin gần nhất".
- Hoặc kiểm tra thẳng trong Postgres:

  ```sql
  SELECT COUNT(*), to_timestamp(MAX(ts)/1000) FROM so_loi.messages;
  ```

Bấm **Xử lý tin mới ngay** để AI phân loại ảnh và trích xuất lỗi lần đầu, rồi xem tab **Bảng lỗi** và **Ảnh**. Sau đó hệ thống tự xử lý mỗi 30 phút.

## Gửi từ chỗ khác

API chỉ cần HTTP:

```
POST <SO_LOI_URL>/api/ingest
Header: X-Ingest-Token: <INGEST_TOKEN>
Body:   { "messages": [ { "threadId": "<id nhóm>", "data": { ...message_object của zlapi... } } ] }
```

`data` cần tối thiểu: `msgId`, `ts` (mili giây), `uidFrom`, `dName`, `msgType` (`webchat` cho chữ, `chat.photo` cho ảnh), `content` (chuỗi với tin chữ; với ảnh là object có `href`, `thumb`, `title`), và `quote` nếu là tin trả lời.
