"""
Chép file này vào dự án ĐANG đăng nhập Zalo bằng zlapi (dự án lọc hồ sơ).
Nó chuyển tin nhắn của nhóm "Xử lý hồ sơ lỗi" sang Sổ lỗi hồ sơ qua POST /api/ingest.
Chỉ dùng thư viện chuẩn của Python, không cần cài thêm gì.

Biến môi trường trong dự án kia:
    SO_LOI_URL=http://127.0.0.1:3000      địa chỉ Sổ lỗi hồ sơ
    SO_LOI_TOKEN=...                      giống INGEST_TOKEN bên Sổ lỗi
    SO_LOI_GROUP_ID=...                   id nhóm Zalo "Xử lý hồ sơ lỗi"

Cách dùng (trong class bot kế thừa ZaloAPI):

    from zlapi_forwarder import forward_to_so_loi

    def onMessage(self, mid, author_id, message, message_object, thread_id, thread_type):
        forward_to_so_loi(message_object, thread_id)   # thêm dòng này
        ...  # code lọc hồ sơ hiện có giữ nguyên
"""
import json
import logging
import os
import threading
import time
import urllib.request
from collections import deque

log = logging.getLogger("so_loi")

URL = os.environ.get("SO_LOI_URL", "http://127.0.0.1:3000").rstrip("/") + "/api/ingest"
TOKEN = os.environ.get("SO_LOI_TOKEN", "")
GROUP_ID = os.environ.get("SO_LOI_GROUP_ID", "")
BATCH = 50

_queue: deque = deque(maxlen=5000)  # Sổ lỗi tắt lâu quá thì bỏ tin cũ nhất
_lock = threading.Lock()


def _post(messages: list) -> dict:
    body = json.dumps({"messages": messages}, ensure_ascii=False, default=str).encode()
    req = urllib.request.Request(URL, data=body, method="POST", headers={"Content-Type": "application/json", "X-Ingest-Token": TOKEN})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read())


def _flush() -> None:
    with _lock:
        while _queue:
            batch = [_queue[i] for i in range(min(BATCH, len(_queue)))]
            try:
                _post(batch)
            except Exception as e:  # noqa: BLE001 – Sổ lỗi tắt hoặc lỗi mạng: giữ lại, thử lại sau
                log.warning("[so-loi] Chưa gửi được, sẽ thử lại: %s", e)
                return
            for _ in batch:
                _queue.popleft()


def _loop() -> None:
    while True:
        time.sleep(5)
        _flush()


threading.Thread(target=_loop, daemon=True, name="so-loi-forwarder").start()


def forward_to_so_loi(message_object, thread_id) -> None:
    """Gọi trong onMessage. Không chặn, không làm chậm xử lý hiện có."""
    if not GROUP_ID or str(thread_id) != GROUP_ID:
        return
    _queue.append({"threadId": str(thread_id), "data": dict(message_object)})


# ---------------------------------------------------------------------------
# Gửi lịch sử cũ (chạy 1 lần). Dùng chính phiên đăng nhập của bot, không cần quét QR lại.
# zlapi chỉ có sẵn hàm lấy 50 tin mới nhất (getRecentGroup), nên đoạn dưới gọi thẳng API
# lịch sử của Zalo giống cách zlapi làm, để lấy được nhiều trang.
# ---------------------------------------------------------------------------

_RECENT = "https://tt-group-cm.chat.zalo.me/api/cm/getrecentv2"
_OLD = "https://tt-group-cm.chat.zalo.me/api/cm/getoldv2"


def _history_page(bot, last_msg_id=None, is_old=False) -> dict:
    params = {
        "params": bot._encode({
            "groupId": GROUP_ID,
            "globalMsgId": last_msg_id or 10000000000000000,
            "count": 50,
            "msgIds": [],
            "imei": bot._imei,
            "src": 3 if last_msg_id else 1,
        }),
        "zpw_ver": 647,
        "zpw_type": 30,
        "nretry": 0,
    }
    data = bot._get(_OLD if is_old else _RECENT, params=params).json()
    if data.get("error_code") != 0:
        raise RuntimeError(f"Zalo trả lỗi {data.get('error_code')}: {data.get('error_message')}")
    decoded = bot._decode(data["data"])
    if decoded.get("error_code") != 0:
        raise RuntimeError(f"Zalo trả lỗi {decoded.get('error_code')}: {decoded.get('error_message')}")
    result = decoded.get("data")
    return json.loads(result) if isinstance(result, str) else result


def backfill_to_so_loi(bot, days: int = 30, delay: float = 2.0) -> int:
    """
    Gửi lịch sử `days` ngày của nhóm sang Sổ lỗi. `bot` là đối tượng ZaloAPI đã đăng nhập.
    Gửi trùng không sao, Sổ lỗi tự bỏ tin đã có.
    """
    if not GROUP_ID:
        raise RuntimeError("Chưa đặt SO_LOI_GROUP_ID")
    stop_before = (time.time() - days * 86400) * 1000
    page = _history_page(bot)
    total = 0
    while True:
        msgs = page.get("groupMsgs") or []
        keep = [{"threadId": GROUP_ID, "data": m} for m in msgs if float(m.get("ts", 0)) >= stop_before]
        if keep:
            total += _post(keep)["added"]
        oldest = min((float(m.get("ts", 0)) for m in msgs), default=0)
        log.info("[so-loi] Đã gửi %s tin, tới %s", total, time.strftime("%d/%m/%Y %H:%M", time.localtime(oldest / 1000)) if oldest else "?")
        if not page.get("hasMore") or not msgs or oldest < stop_before:
            break
        time.sleep(delay)
        nxt = _history_page(bot, page.get("lastMsgId"), bool(page.get("isOld")))
        if not (nxt.get("groupMsgs") or []) and (nxt.get("isFiltered") or nxt.get("lastMsgId") == page.get("lastMsgId")):
            break
        page = nxt
    return total
