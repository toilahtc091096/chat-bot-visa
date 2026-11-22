import io
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from types import SimpleNamespace

import pytest

from app import db, llm
from app.chat import answer
from app.extract import ExtractResult, process_all
from app.images import CheapResult, FullResult, classify_pending_images, list_categories
from app.store import save_messages
from tests.test_unit import gradient

# ---- client Claude giả ----
calls, queue = [], []
usage = SimpleNamespace(input_tokens=100, output_tokens=20, cache_read_input_tokens=0)


class FakeMessages:
    def parse(self, **req):
        calls.append(req)
        out = queue.pop(0)
        assert isinstance(out, req["output_format"])
        return SimpleNamespace(stop_reason="end_turn", usage=usage, parsed_output=out)

    def create(self, **req):
        calls.append(req)
        return SimpleNamespace(stop_reason="end_turn", usage=usage, content=[SimpleNamespace(type="text", text="Lưu ý: #1")])


llm.set_client(SimpleNamespace(messages=FakeMessages()))


# ---- server ảnh giả ----
def _png(img):
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=60)
    return buf.getvalue()


IMAGES = {"/a.jpg": _png(gradient()), "/a2.jpg": _png(gradient().resize((150, 100))), "/b.jpg": _png(gradient(flip=True))}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = IMAGES.get(self.path)
        self.send_response(200 if body else 404)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def log_message(self, *a):
        pass


@pytest.fixture(scope="module")
def image_host():
    srv = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


OLD = int(time.time() * 1000) - 2 * 3600 * 1000


def msg(id, i, **extra):
    return {
        "id": id, "group_id": "g1", "sender_id": "u", "sender_name": "Lan", "ts": OLD + i * 60000, "msg_type": "webchat", "text": None,
        "attachment_url": None, "thumb_url": None, "quote_msg_id": None, "quote_text": None, "raw": {}, **extra,
    }


def test_full_pipeline(clean, image_host):
    calls.clear()
    # --- ảnh: vision tạo category, ảnh giống dùng hash, ảnh khác dùng hint ---
    save_messages([
        msg("p1", 0, msg_type="chat.photo", attachment_url=image_host + "/a.jpg", text="tờ khai sai"),
        msg("p2", 1, msg_type="chat.photo", attachment_url=image_host + "/a2.jpg"),
        msg("p3", 2, msg_type="chat.photo", attachment_url=image_host + "/b.jpg"),
    ])
    queue.extend([
        FullResult(category="Ảnh chụp tờ khai", is_new=True, category_description="Tờ khai online",
                   new_hints=["Ảnh có bảng ô nhập liệu thì là tờ khai"], description="Ô ngày sinh bị khoanh đỏ", confidence=0.9),
        CheapResult(category="Ảnh chụp tờ khai", confidence=0.9, description="Tờ khai, ô tên sai"),
    ])
    assert classify_pending_images() == {"hash": 1, "hint": 1, "vision": 1, "failed": 0}
    cats = list_categories()
    assert len(cats) == 1 and cats[0]["hints"] == ["Ảnh có bảng ô nhập liệu thì là tờ khai"] and cats[0]["image_count"] == 3
    assert calls[0]["model"] == "claude-sonnet-5-5" and calls[1]["model"] == "claude-haiku-5-5"

    # --- trích xuất lỗi ---
    save_messages([
        msg("t1", 3, text="Hồ sơ visa Mỹ của chị A bị sai ngày sinh, SĐT 0912345678"),
        msg("t2", 4, text="Do nhập theo kiểu ngày/tháng"),
        {**msg("t3", 0, text="tin mới chưa yên"), "ts": int(time.time() * 1000)},
    ])
    queue.append(ExtractResult(errors=[dict(
        existing_error_id=None, source_msg_ids=["p1", "t1", "t2"], ho_so_type="Visa Mỹ", title="Sai ngày sinh", meaning="m",
        cause="Nhập sai định dạng", fix="Sửa lại", prevention="Kiểm tra MM/DD", severity="cao", confidence=0.9)]))
    r1 = process_all("g1")
    assert r1["created"] == 1
    prompt = calls[-1]["messages"][0]["content"]
    assert "[ẢNH - loại: Ảnh chụp tờ khai] Ô ngày sinh bị khoanh đỏ" in prompt
    assert "0912345678" not in prompt and "tin mới chưa yên" not in prompt
    assert db.one("SELECT COUNT(*) AS n FROM messages WHERE NOT processed")["n"] == 1

    # --- người duyệt sửa lỗi; tin mới bàn tiếp không được ghi đè ---
    db.execute("UPDATE errors SET status='reviewed', cause='Người sửa' WHERE id=1")
    queue.append(ExtractResult(errors=[dict(
        existing_error_id=1, source_msg_ids=["t3"], ho_so_type="Visa Mỹ", title="X", meaning="X", cause="AI mới",
        fix="", prevention="", severity="thap", confidence=0.5)]))
    assert process_all("g1", force=True)["updated"] == 1
    e = db.one("SELECT * FROM errors WHERE id=1")
    assert e["cause"] == "Người sửa" and e["source_msg_ids"] == ["p1", "t1", "t2", "t3"]

    # --- chatbot ---
    r = answer("Visa Mỹ", [{"role": "user", "content": "Làm visa Mỹ cần lưu ý gì?"}])
    assert r["errorsUsed"] == 1
    assert calls[-1]["model"] == "claude-haiku-5-5"
    assert "#1 [Visa Mỹ] [đã duyệt]" in calls[-1]["system"][0]["text"]
    with pytest.raises(ValueError):
        answer(None, [])
    assert db.one("SELECT COUNT(*) AS n FROM llm_usage")["n"] == 5  # 2 ảnh + 2 trích xuất + 1 chat
