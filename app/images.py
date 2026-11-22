"""
Phân loại ảnh theo 3 tầng để tiết kiệm token:
  1. hash   – ảnh gần giống (dHash) một ảnh đã phân loại -> dùng lại, 0 token
  2. hint   – ảnh thu nhỏ + danh sách category kèm hint -> model rẻ (Haiku)
  3. vision – ảnh đầy đủ -> model mạnh (Sonnet), có thể tạo category mới và viết thêm hint
"""
import base64
import io
import logging
from typing import Literal

import httpx
from PIL import Image, ImageOps
from pydantic import BaseModel, Field

from . import db
from .config import config
from .db import Jsonb
from .llm import structured

log = logging.getLogger("images")
MAX_HINTS_PER_CATEGORY = 12

# ---------- tải ảnh, hash ----------


def download(url: str, path) -> None:
    r = httpx.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30, follow_redirects=True)
    r.raise_for_status()
    path.write_bytes(r.content)


def dhash(image: Image.Image) -> str:
    """dHash 64 bit: so sánh độ sáng các điểm ảnh liền kề trên ảnh 9x8 xám."""
    small = image.convert("L").resize((9, 8), Image.Resampling.LANCZOS)
    px = small.tobytes()
    bits = 0
    for y in range(8):
        for x in range(8):
            bits = (bits << 1) | (1 if px[y * 9 + x] > px[y * 9 + x + 1] else 0)
    return f"{bits:016x}"


def hamming(a: str, b: str) -> int:
    return bin(int(a, 16) ^ int(b, 16)).count("1")


def jpeg_b64(image: Image.Image, max_side: int, quality: int) -> str:
    img = image.convert("RGB")
    img.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode()


def open_image(path) -> Image.Image:
    return ImageOps.exif_transpose(Image.open(path))


# ---------- category ----------


def list_categories() -> list[dict]:
    return db.query(
        """SELECT c.*, (SELECT COUNT(*) FROM images i WHERE i.category_id = c.id) AS image_count
           FROM image_categories c ORDER BY c.name"""
    )


def _categories_prompt(categories: list[dict]) -> str:
    if not categories:
        return "(chưa có category nào)"
    return "\n".join(
        f"- {c['name']}: {c['description'] or ''}\n  Hint: {' | '.join(c['hints']) if c['hints'] else '(chưa có)'}" for c in categories
    )


def upsert_category(name: str, description: str | None, new_hints: list[str]) -> int:
    name = name.strip()
    existing = db.one("SELECT * FROM image_categories WHERE name = %s", (name,))
    if not existing:
        row = db.one(
            "INSERT INTO image_categories(name, description, hints) VALUES (%s,%s,%s) RETURNING id",
            (name, description or None, Jsonb(new_hints[:MAX_HINTS_PER_CATEGORY])),
        )
        return row["id"]
    hints = list(existing["hints"])
    for h in new_hints:
        if len(hints) >= MAX_HINTS_PER_CATEGORY:
            break
        if h and h.lower() not in (x.lower() for x in hints):
            hints.append(h)
    db.execute(
        "UPDATE image_categories SET hints = %s, description = COALESCE(description, %s), updated_at = now() WHERE id = %s",
        (Jsonb(hints), description or None, existing["id"]),
    )
    return existing["id"]


def update_category(category_id: int, name=None, description=None, hints=None) -> None:
    db.execute(
        """UPDATE image_categories SET name = COALESCE(%s, name), description = COALESCE(%s, description),
           hints = COALESCE(%s, hints), updated_at = now() WHERE id = %s""",
        (
            name or None,
            description,
            Jsonb([h for h in hints if h][:MAX_HINTS_PER_CATEGORY]) if hints is not None else None,
            category_id,
        ),
    )


def set_image_category(image_id: int, category: str, hint: str | None = None) -> None:
    category_id = upsert_category(category, None, [hint] if hint else [])
    db.execute(
        "UPDATE images SET category_id = %s, method = 'manual', confidence = 1, updated_at = now() WHERE id = %s",
        (category_id, image_id),
    )


# ---------- 3 tầng ----------


class CheapResult(BaseModel):
    category: str = Field(description="Tên category khớp nhất trong danh sách, hoặc chuỗi rỗng nếu không khớp cái nào")
    confidence: float = Field(description="Độ chắc chắn 0..1")
    description: str = Field(description="Mô tả ngắn 1-2 câu nội dung ảnh, nêu chi tiết liên quan tới lỗi hồ sơ nếu thấy")


class FullResult(BaseModel):
    category: str = Field(description="Tên category (dùng lại tên có sẵn nếu phù hợp, nếu không thì đặt tên mới ngắn gọn bằng tiếng Việt)")
    is_new: bool
    category_description: str = Field(description="Category này là loại ảnh gì")
    new_hints: list[str] = Field(
        description="0-3 dấu hiệu nhìn thấy được để lần sau nhận ra loại ảnh này mà không cần xem ảnh đầy đủ, dạng 'Ảnh có ... thì là loại này'"
    )
    description: str = Field(description="Mô tả 1-3 câu nội dung ảnh, nêu rõ chi tiết liên quan tới lỗi hồ sơ (ô bị khoanh, chữ sai, thiếu dấu...)")
    confidence: float


SYSTEM_IMAGE = """Bạn phân loại ảnh được gửi trong nhóm chat "Xử lý hồ sơ lỗi" (hồ sơ visa, giấy tờ).
Category là loại ảnh (ví dụ: ảnh chụp tờ khai, ảnh hộ chiếu, ảnh chụp màn hình thông báo lỗi, ảnh thẻ sai quy cách...).
Ưu tiên dùng category có sẵn. Chỉ tạo category mới khi ảnh thật sự khác các loại hiện có.
Không chép lại số giấy tờ, số điện thoại hay thông tin cá nhân vào mô tả."""

Method = Literal["hash", "hint", "vision", "failed"]


def _update(image_id: int, **fields) -> None:
    sets = ", ".join(f"{k} = %({k})s" for k in fields)
    db.execute(f"UPDATE images SET {sets}, updated_at = now() WHERE id = %(id)s", {**fields, "id": image_id})


def _find_similar(phash: str, exclude_id: int) -> dict | None:
    rows = db.query(
        """SELECT id, phash, category_id, description FROM images
           WHERE phash IS NOT NULL AND category_id IS NOT NULL AND id <> %s AND method <> 'failed'""",
        (exclude_id,),
    )
    best = None
    for r in rows:
        d = hamming(phash, r["phash"])
        if d <= config.image_hash_max_distance and (best is None or d < best["distance"]):
            best = {**r, "distance": d}
    return best


def classify_image(image_id: int) -> Method:
    img = db.one(
        """SELECT i.*, m.attachment_url, m.thumb_url, m.text AS caption
           FROM images i JOIN messages m ON m.id = i.message_id WHERE i.id = %s""",
        (image_id,),
    )
    if not img:
        raise ValueError("Không tìm thấy ảnh")

    # Tải ảnh về máy (link Zalo có thể hết hạn)
    from pathlib import Path

    path = Path(img["local_path"]) if img["local_path"] else config.images_dir / f"{img['message_id']}.jpg"
    if not path.exists():
        try:
            download(img["attachment_url"] or img["thumb_url"], path)
        except Exception as e:  # noqa: BLE001
            _update(image_id, method="failed", description=f"Không tải được ảnh: {e}")
            return "failed"
    image = open_image(path)
    phash = img["phash"] or dhash(image)
    _update(image_id, local_path=str(path), phash=phash)

    # Tầng 1: ảnh gần giống
    similar = _find_similar(phash, image_id)
    if similar:
        _update(
            image_id,
            category_id=similar["category_id"],
            confidence=1 - similar["distance"] / 64,
            method="hash",
            description=similar["description"],
        )
        return "hash"

    categories = list_categories()
    caption = f"Chú thích kèm ảnh: {img['caption']}\n" if img["caption"] else ""

    # Tầng 2: ảnh nhỏ + hint, model rẻ
    if categories:
        data, usage = structured(
            purpose="image_hint",
            model=config.model_image_cheap,
            system=SYSTEM_IMAGE,
            effort="low",
            max_tokens=2000,
            output=CheapResult,
            content=[
                {"type": "text", "text": f"Danh sách category và hint:\n{_categories_prompt(categories)}"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": jpeg_b64(image, 384, 70)}},
                {"type": "text", "text": f"{caption}Ảnh trên (đã thu nhỏ) thuộc category nào? Nếu không chắc thì để category rỗng."},
            ],
        )
        match = next((c for c in categories if c["name"] == data.category), None)
        if match and data.confidence >= config.image_cheap_min_confidence:
            _update(
                image_id,
                category_id=match["id"],
                confidence=data.confidence,
                method="hint",
                description=data.description,
                tokens_in=usage.input_tokens,
                tokens_out=usage.output_tokens,
            )
            return "hint"

    # Tầng 3: ảnh đầy đủ, model mạnh, học thêm hint
    data, usage = structured(
        purpose="image_vision",
        model=config.model_image_full,
        system=SYSTEM_IMAGE,
        effort="low",
        max_tokens=4000,
        output=FullResult,
        content=[
            {"type": "text", "text": f"Danh sách category hiện có:\n{_categories_prompt(categories)}"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": jpeg_b64(image, 1568, 85)}},
            {"type": "text", "text": f"{caption}Phân loại ảnh này và viết hint giúp nhận ra loại ảnh này lần sau."},
        ],
    )
    category_id = upsert_category(data.category, data.category_description, data.new_hints)
    _update(
        image_id,
        category_id=category_id,
        confidence=data.confidence,
        method="vision",
        description=data.description,
        tokens_in=usage.input_tokens,
        tokens_out=usage.output_tokens,
    )
    return "vision"


def classify_pending_images() -> dict:
    db.execute(
        """INSERT INTO images(message_id)
           SELECT id FROM messages WHERE msg_type = 'chat.photo' AND (attachment_url IS NOT NULL OR thumb_url IS NOT NULL)
           ON CONFLICT (message_id) DO NOTHING"""
    )
    pending = db.query("SELECT id FROM images WHERE method IS NULL ORDER BY id")
    stats = {"hash": 0, "hint": 0, "vision": 0, "failed": 0}
    for row in pending:
        try:
            stats[classify_image(row["id"])] += 1
        except Exception as e:  # noqa: BLE001
            stats["failed"] += 1
            log.warning("Lỗi phân loại ảnh %s: %s", row["id"], e)
    if pending:
        log.info("Đã phân loại %s ảnh: %s", len(pending), stats)
    return stats
