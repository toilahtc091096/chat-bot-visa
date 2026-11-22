"""Lưu tin nhắn nhận từ dự án đang đăng nhập Zalo."""
import time

from . import db
from .config import config
from .db import Jsonb
from .normalize import normalize_message

state = {"last_ingest_at": None}

_INSERT = """
INSERT INTO messages (id, group_id, sender_id, sender_name, ts, msg_type, text, attachment_url, thumb_url, quote_msg_id, quote_text, raw)
VALUES (%(id)s, %(group_id)s, %(sender_id)s, %(sender_name)s, %(ts)s, %(msg_type)s, %(text)s, %(attachment_url)s, %(thumb_url)s,
        %(quote_msg_id)s, %(quote_text)s, %(raw)s)
ON CONFLICT (id) DO NOTHING
"""


def save_messages(rows: list[dict]) -> int:
    added = 0
    with db.transaction() as conn:
        for row in rows:
            added += conn.execute(_INSERT, {**row, "raw": Jsonb(row["raw"])}).rowcount
    return added


def current_group_id() -> str:
    return db.get_setting("zalo_group_id") or config.zalo_group_id or ""


def ingest(items: list, group_hint: str | None = None) -> dict:
    """
    items: mỗi phần tử là {"threadId": ..., "data": {...tin nhắn...}} hoặc chỉ phần tin nhắn (có idTo = id nhóm).
    Chỉ lưu tin của nhóm đang theo dõi; nếu chưa có nhóm thì lấy nhóm của tin đầu tiên.
    """
    rows = []
    for item in items:
        if not isinstance(item, dict):
            continue
        if isinstance(item.get("data"), dict):
            data, group_id = item["data"], item.get("threadId") or group_hint
        else:
            data, group_id = item, group_hint or item.get("idTo")
        if not data.get("msgId") or not data.get("ts") or not group_id:
            continue
        rows.append(normalize_message(data, str(group_id)))

    group_id = current_group_id()
    if not group_id and rows:
        group_id = rows[0]["group_id"]
        db.set_setting("zalo_group_id", group_id)
    accepted = [r for r in rows if r["group_id"] == group_id]
    added = save_messages(accepted)
    state["last_ingest_at"] = int(time.time() * 1000)
    return {"received": len(items), "accepted": len(accepted), "added": added, "groupId": group_id}
