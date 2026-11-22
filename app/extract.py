"""Đọc tin chưa xử lý theo từng đoạn, nhờ Claude rút ra các lỗi hồ sơ.
Ảnh không gửi lại ở bước này: dùng category + mô tả đã có từ bước phân loại ảnh."""
import logging
import time
from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field

from . import db
from .config import config
from .db import Jsonb
from .llm import mask_pii, structured

log = logging.getLogger("extract")


class ExtractedError(BaseModel):
    existing_error_id: int | None = Field(
        description="Nếu đoạn chat đang tiếp tục bàn về một lỗi trong danh sách 'Lỗi đã ghi nhận gần đây' thì điền id đó, nếu không thì null"
    )
    source_msg_ids: list[str] = Field(description="Id các tin nhắn (trong ngoặc vuông) nói về lỗi này")
    ho_so_type: str = Field(description="Loại hồ sơ, dùng lại tên trong danh sách có sẵn nếu khớp; 'Chung' nếu áp dụng cho mọi loại")
    title: str = Field(description="Tên lỗi ngắn gọn, dưới 15 từ")
    meaning: str = Field(description="Lỗi này là gì, xảy ra ở đâu trong hồ sơ")
    cause: str = Field(description="Nguyên nhân có khả năng nhất. Nếu chat không nói rõ thì suy luận và ghi 'Dự đoán: ...'")
    fix: str = Field(description="Cách đã xử lý hoặc nên xử lý; rỗng nếu chưa rõ")
    prevention: str = Field(description="Lưu ý ngắn cho người làm hồ sơ để không mắc lại lỗi này")
    severity: Literal["thap", "trung_binh", "cao"]
    confidence: float = Field(description="0..1, mức chắc chắn đây thật sự là một lỗi hồ sơ và thông tin trên đúng")


class ExtractResult(BaseModel):
    errors: list[ExtractedError]


SYSTEM = """Bạn là trợ lý của một văn phòng làm hồ sơ (visa và giấy tờ). Nhóm chat "Xử lý hồ sơ lỗi" là nơi mọi người báo và xử lý lỗi hồ sơ.
Nhiệm vụ: đọc đoạn chat và liệt kê các LỖI HỒ SƠ được nêu, mỗi lỗi một mục.
- Chỉ ghi lỗi thật (sai thông tin, thiếu giấy tờ, sai quy cách ảnh, nộp sai mẫu, bị trả hồ sơ...). Bỏ qua chào hỏi, nhắc việc, trao đổi không phải lỗi.
- Gộp các tin cùng nói về một lỗi thành một mục. Một tin có thể thuộc nhiều lỗi.
- Phần "NGỮ CẢNH TRƯỚC" chỉ để hiểu, không trích lỗi chỉ dựa trên phần đó.
- Viết tiếng Việt, ngắn gọn, khái quát hóa để người khác học được (không nêu tên khách, số giấy tờ, số điện thoại).
- Không có lỗi nào thì trả về danh sách rỗng."""


def _fmt_time(ts: int) -> str:
    return datetime.fromtimestamp(ts / 1000, ZoneInfo(config.timezone)).strftime("%Y-%m-%d %H:%M")


def _format_message(m: dict, images: dict) -> str:
    img = images.get(m["id"])
    if img:
        body = f"[ẢNH{' - loại: ' + img['category'] if img['category'] else ''}] {img['description'] or '(chưa có mô tả)'}"
        if m["text"]:
            body += f" Chú thích: {m['text']}"
    elif m["msg_type"] == "share.file":
        body = f"[FILE] {m['text'] or ''}"
    elif m["msg_type"] and m["msg_type"] != "webchat" and not m["text"]:
        body = f"[{m['msg_type']}]"
    else:
        body = m["text"] or ""
    line = f"[{m['id']}] {_fmt_time(m['ts'])} {m['sender_name'] or m['sender_id']}: {body}"
    if m["quote_text"]:
        line += f'  (trả lời tin: "{m["quote_text"][:200]}")'
    return mask_pii(line) if config.mask_pii else line


def _images_for(ids: list[str]) -> dict:
    if not ids:
        return {}
    rows = db.query(
        """SELECT i.message_id, i.description, c.name AS category FROM images i
           LEFT JOIN image_categories c ON c.id = i.category_id WHERE i.message_id = ANY(%s)""",
        (ids,),
    )
    return {r["message_id"]: r for r in rows}


def list_ho_so_types() -> list[dict]:
    return db.query(
        """SELECT ho_so_type AS name, COUNT(*) AS n FROM errors
           WHERE status <> 'rejected' AND ho_so_type IS NOT NULL GROUP BY ho_so_type ORDER BY n DESC"""
    )


def _save_errors(group_id: str, extracted: list[ExtractedError], chunk: list[dict]) -> tuple[int, int]:
    ts_by_id = {m["id"]: m["ts"] for m in chunk}
    created = updated = 0
    with db.transaction() as conn:
        for e in extracted:
            ids = [i for i in e.source_msg_ids if i in ts_by_id]
            first_ts = min((ts_by_id[i] for i in ids), default=chunk[0]["ts"])
            existing = (
                conn.execute("SELECT * FROM errors WHERE id = %s", (e.existing_error_id,)).fetchone() if e.existing_error_id else None
            )
            if existing:
                merged = list(dict.fromkeys([*existing["source_msg_ids"], *ids]))
                if existing["status"] == "ai":
                    # Chưa ai duyệt: cập nhật theo thông tin mới nhất
                    conn.execute(
                        """UPDATE errors SET ho_so_type=%s, title=%s, meaning=%s, cause_ai=%s, cause=%s, fix=%s, prevention=%s,
                           severity=%s, confidence=%s, source_msg_ids=%s, updated_at=now() WHERE id=%s""",
                        (e.ho_so_type, e.title, e.meaning, e.cause, e.cause, e.fix, e.prevention, e.severity, e.confidence, Jsonb(merged), existing["id"]),
                    )
                else:
                    # Đã có người duyệt: không ghi đè, chỉ nối thêm tin nhắn nguồn
                    conn.execute("UPDATE errors SET source_msg_ids=%s, updated_at=now() WHERE id=%s", (Jsonb(merged), existing["id"]))
                updated += 1
                continue
            conn.execute(
                """INSERT INTO errors (group_id, ho_so_type, title, meaning, cause_ai, cause, fix, prevention, severity, confidence, source_msg_ids, first_ts)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (group_id, e.ho_so_type, e.title, e.meaning, e.cause, e.cause, e.fix, e.prevention, e.severity, e.confidence, Jsonb(ids), first_ts),
            )
            created += 1
    return created, updated


def process_next_chunk(group_id: str, force: bool = False) -> dict | None:
    now = int(time.time() * 1000)
    cutoff = now + 1 if force else now - int(config.process_quiet_min * 60_000)
    chunk = db.query(
        "SELECT * FROM messages WHERE group_id = %s AND NOT processed AND ts < %s ORDER BY ts LIMIT %s",
        (group_id, cutoff, config.chunk_size),
    )
    if not chunk:
        return None
    context = db.query(
        "SELECT * FROM messages WHERE group_id = %s AND ts < %s ORDER BY ts DESC LIMIT %s",
        (group_id, chunk[0]["ts"], config.context_size),
    )[::-1]
    images = _images_for([m["id"] for m in context + chunk])
    recent = db.query(
        """SELECT id, ho_so_type, title FROM errors WHERE group_id = %s AND status <> 'rejected'
           ORDER BY COALESCE(first_ts, 0) DESC LIMIT 40""",
        (group_id,),
    )
    types = [t["name"] for t in list_ho_so_types()]

    parts = [
        f"Loại hồ sơ đã có: {', '.join(types) if types else '(chưa có)'}",
        "Lỗi đã ghi nhận gần đây:\n" + ("\n".join(f"#{e['id']} [{e['ho_so_type']}] {e['title']}" for e in recent) or "(chưa có)"),
    ]
    if context:
        parts.append("=== NGỮ CẢNH TRƯỚC (chỉ để tham khảo) ===\n" + "\n".join(_format_message(m, images) for m in context))
    parts.append("=== ĐOẠN CHAT CẦN PHÂN TÍCH ===\n" + "\n".join(_format_message(m, images) for m in chunk))

    data, _ = structured(
        purpose="extract_errors",
        model=config.model_extract,
        system=SYSTEM,
        effort="medium",
        output=ExtractResult,
        content="\n\n".join(parts),
    )
    created, updated = _save_errors(group_id, data.errors, chunk)
    db.execute("UPDATE messages SET processed = TRUE WHERE id = ANY(%s)", ([m["id"] for m in chunk],))
    return {"messages": len(chunk), "created": created, "updated": updated}


def process_all(group_id: str, force: bool = False) -> dict:
    total = {"chunks": 0, "messages": 0, "created": 0, "updated": 0}
    while (r := process_next_chunk(group_id, force)) is not None:
        total["chunks"] += 1
        for k in ("messages", "created", "updated"):
            total[k] += r[k]
        log.info("Đoạn %s: %s tin, +%s lỗi mới, %s lỗi cập nhật", total["chunks"], r["messages"], r["created"], r["updated"])
    return total
