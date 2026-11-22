"""Gọi Claude (Anthropic API)."""
import re

import anthropic
from pydantic import BaseModel

from . import db

_client: anthropic.Anthropic | None = None


def client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic()  # đọc ANTHROPIC_API_KEY từ môi trường
    return _client


def set_client(c) -> None:
    """Dùng trong test để thay client thật."""
    global _client
    _client = c


class LlmRefusalError(Exception):
    pass


def _record_usage(purpose: str, model: str, usage) -> None:
    if usage is None:
        return
    db.execute(
        "INSERT INTO llm_usage(purpose, model, input_tokens, output_tokens, cache_read_tokens) VALUES (%s,%s,%s,%s,%s)",
        (
            purpose,
            model,
            getattr(usage, "input_tokens", 0) or 0,
            getattr(usage, "output_tokens", 0) or 0,
            getattr(usage, "cache_read_input_tokens", 0) or 0,
        ),
    )


def _system(text: str) -> list[dict]:
    return [{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}]


def structured(*, purpose: str, model: str, system: str, content, output: type[BaseModel], effort: str = "medium", max_tokens: int = 16000):
    """Gọi Claude và nhận kết quả đúng schema Pydantic. Trả về (dữ liệu, usage)."""
    response = client().messages.parse(
        model=model,
        max_tokens=max_tokens,
        system=_system(system),
        output_format=output,
        output_config={"effort": effort},
        messages=[{"role": "user", "content": content}],
    )
    _record_usage(purpose, model, response.usage)
    if response.stop_reason == "refusal":
        category = getattr(getattr(response, "stop_details", None), "category", None)
        raise LlmRefusalError(f"Model từ chối yêu cầu ({category or 'không rõ'})")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("Kết quả bị cắt vì vượt max_tokens, hãy giảm EXTRACT_CHUNK_SIZE")
    if response.parsed_output is None:
        raise RuntimeError("Không đọc được JSON từ model")
    return response.parsed_output, response.usage


def chat_text(*, purpose: str, model: str, system: str, messages: list[dict], effort: str = "low", max_tokens: int = 8000) -> str:
    response = client().messages.create(
        model=model,
        max_tokens=max_tokens,
        system=_system(system),
        output_config={"effort": effort},
        messages=messages,
    )
    _record_usage(purpose, model, response.usage)
    if response.stop_reason == "refusal":
        raise LlmRefusalError("Model từ chối trả lời câu hỏi này")
    return "\n".join(b.text for b in response.content if b.type == "text").strip()


_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_PHONE = re.compile(r"(?<!\d)(?:\+?84|0)(?:[\s.-]?\d){9,10}(?!\d)")
_ID_NUMBER = re.compile(r"(?<![\w])(?:\d{12}|\d{9})(?!\d)")
_PASSPORT = re.compile(r"\b[A-Z]\d{7,8}\b")


def mask_pii(text: str | None) -> str | None:
    """Che số CCCD, hộ chiếu, SĐT, email trước khi gửi lên AI."""
    if not text:
        return text
    text = _EMAIL.sub("[email]", text)
    text = _PHONE.sub("[sđt]", text)
    text = _ID_NUMBER.sub("[số giấy tờ]", text)
    return _PASSPORT.sub("[số hộ chiếu]", text)
