"""Chuyển tin nhắn Zalo (định dạng của zlapi / zca-js, giống nhau) thành 1 dòng trong bảng messages."""
import json


def _params(raw) -> dict:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            value = json.loads(raw)
            return value if isinstance(value, dict) else {}
        except ValueError:
            return {}
    return {}


def normalize_message(data: dict, group_id: str) -> dict:
    """data: message_object của zlapi (hoặc message.data của zca-js)."""
    quote = data.get("quote") or None
    row = {
        "id": str(data["msgId"]),
        "group_id": str(group_id),
        "sender_id": str(data.get("uidFrom") or ""),
        "sender_name": data.get("dName") or None,
        "ts": int(float(data["ts"])),
        "msg_type": data.get("msgType") or None,
        "text": None,
        "attachment_url": None,
        "thumb_url": None,
        "quote_msg_id": str(quote.get("globalMsgId")) if isinstance(quote, dict) and quote.get("globalMsgId") is not None else None,
        "quote_text": (quote.get("msg") or quote.get("attach") or None) if isinstance(quote, dict) else None,
        "raw": data,
    }
    content = data.get("content")
    if isinstance(content, str):
        row["text"] = content
    elif isinstance(content, dict):
        params = _params(content.get("params"))
        row["attachment_url"] = params.get("hd") or content.get("href") or None
        row["thumb_url"] = content.get("thumb") or None
        parts = [content.get(k) for k in ("title", "description")]
        row["text"] = " - ".join(p.strip() for p in parts if isinstance(p, str) and p.strip()) or None
    if isinstance(row["quote_text"], str):
        row["quote_text"] = row["quote_text"][:2000]
    return row


def is_image(row: dict) -> bool:
    return row.get("msg_type") == "chat.photo" and bool(row.get("attachment_url") or row.get("thumb_url"))
