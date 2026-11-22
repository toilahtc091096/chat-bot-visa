"""Chatbot trả lời dựa trên sổ lỗi."""
from . import db
from .config import config
from .llm import chat_text

MAX_ERRORS_IN_CONTEXT = 400

SYSTEM = """Bạn là trợ lý cho nhân viên làm hồ sơ (visa và giấy tờ) của văn phòng.
Bạn có "Sổ lỗi": các lỗi hồ sơ đã từng gặp, rút ra từ nhóm chat xử lý hồ sơ lỗi.
Nhiệm vụ:
1. Khi người dùng sắp làm một hồ sơ (cho biết loại hồ sơ hoặc mô tả hồ sơ), đưa ra checklist các điểm cần lưu ý, ưu tiên lỗi hay gặp và lỗi nghiêm trọng.
2. Khi người dùng hỏi về một tình huống, tìm lỗi cũ tương tự và nói cách tránh hoặc xử lý.
3. Giúp người mới học: giải thích vì sao lỗi xảy ra.
Quy tắc:
- Chỉ dựa vào Sổ lỗi. Nếu Sổ lỗi không có thông tin liên quan, nói rõ là chưa có lỗi nào được ghi nhận cho trường hợp này, rồi mới được gợi ý chung (ghi rõ là gợi ý chung).
- Trích mã lỗi dạng #12 để người dùng tra lại trên bảng lỗi.
- Lỗi có nhãn [đã duyệt] đáng tin hơn lỗi [AI đoán].
- Trả lời bằng tiếng Việt, ngắn gọn, dùng gạch đầu dòng."""


def _load_errors(ho_so_type: str | None) -> list[dict]:
    where = "status <> 'rejected' AND (status = 'reviewed' OR COALESCE(confidence, 0) >= 0.5)"
    params: list = []
    if ho_so_type:
        where += " AND (ho_so_type = %s OR ho_so_type = 'Chung')"
        params.append(ho_so_type)
    return db.query(
        f"""SELECT id, ho_so_type, title, meaning, cause, fix, prevention, severity, status FROM errors
            WHERE {where} ORDER BY (status = 'reviewed') DESC, first_ts DESC NULLS LAST LIMIT {MAX_ERRORS_IN_CONTEXT}""",
        params,
    )


def _format(errors: list[dict]) -> str:
    out = []
    for e in errors:
        lines = [f"#{e['id']} [{e['ho_so_type'] or '?'}] [{'đã duyệt' if e['status'] == 'reviewed' else 'AI đoán'}] [mức: {e['severity'] or '?'}] {e['title']}"]
        for label, key in (("Lỗi", "meaning"), ("Nguyên nhân", "cause"), ("Cách xử lý", "fix"), ("Lưu ý", "prevention")):
            if e[key]:
                lines.append(f"  {label}: {e[key]}")
        out.append("\n".join(lines))
    return "\n".join(out)


def answer(ho_so_type: str | None, history: list[dict]) -> dict:
    if not config.has_api_key:
        raise RuntimeError("Chưa cấu hình ANTHROPIC_API_KEY trong file .env")
    errors = _load_errors(ho_so_type or None)
    system = (
        f"{SYSTEM}\n\n=== SỔ LỖI{f' (loại hồ sơ: {ho_so_type} + lỗi chung)' if ho_so_type else ''}, {len(errors)} lỗi ===\n"
        f"{_format(errors) or '(Sổ lỗi đang trống)'}"
    )
    messages = [
        {"role": m["role"], "content": m["content"][:8000]}
        for m in history[-12:]
        if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str) and m["content"].strip()
    ]
    if not messages or messages[-1]["role"] != "user":
        raise ValueError("Thiếu câu hỏi")
    text = chat_text(purpose="chat", model=config.model_chat, system=system, messages=messages)
    return {"text": text, "errorsUsed": len(errors)}
