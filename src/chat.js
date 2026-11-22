import { config } from "./config.js";
import { db } from "./db.js";
import { chatText } from "./llm.js";

const MAX_ERRORS_IN_CONTEXT = 400;

const SYSTEM = `Bạn là trợ lý cho nhân viên làm hồ sơ (visa và giấy tờ) của văn phòng.
Bạn có "Sổ lỗi": các lỗi hồ sơ đã từng gặp, rút ra từ nhóm chat xử lý hồ sơ lỗi.
Nhiệm vụ:
1. Khi người dùng sắp làm một hồ sơ (cho biết loại hồ sơ hoặc mô tả hồ sơ), đưa ra checklist các điểm cần lưu ý, ưu tiên lỗi hay gặp và lỗi nghiêm trọng.
2. Khi người dùng hỏi về một tình huống, tìm lỗi cũ tương tự và nói cách tránh hoặc xử lý.
3. Giúp người mới học: giải thích vì sao lỗi xảy ra.
Quy tắc:
- Chỉ dựa vào Sổ lỗi. Nếu Sổ lỗi không có thông tin liên quan, nói rõ là chưa có lỗi nào được ghi nhận cho trường hợp này, rồi mới được gợi ý chung (ghi rõ là gợi ý chung).
- Trích mã lỗi dạng #12 để người dùng tra lại trên bảng lỗi.
- Lỗi có nhãn [đã duyệt] đáng tin hơn lỗi [AI đoán].
- Trả lời bằng tiếng Việt, ngắn gọn, dùng gạch đầu dòng.`;

function loadErrors(hoSoType) {
  const params = [];
  let where = "status != 'rejected' AND (status = 'reviewed' OR COALESCE(confidence, 0) >= 0.5)";
  if (hoSoType) {
    where += " AND (ho_so_type = ? OR ho_so_type = 'Chung')";
    params.push(hoSoType);
  }
  return db
    .prepare(
      `SELECT id, ho_so_type, title, meaning, cause, fix, prevention, severity, status, first_ts FROM errors
       WHERE ${where}
       ORDER BY (status = 'reviewed') DESC, first_ts DESC LIMIT ${MAX_ERRORS_IN_CONTEXT}`,
    )
    .all(...params);
}

function formatErrors(errors) {
  return errors
    .map((e) =>
      [
        `#${e.id} [${e.ho_so_type || "?"}] [${e.status === "reviewed" ? "đã duyệt" : "AI đoán"}] [mức: ${e.severity || "?"}] ${e.title}`,
        e.meaning && `  Lỗi: ${e.meaning}`,
        e.cause && `  Nguyên nhân: ${e.cause}`,
        e.fix && `  Cách xử lý: ${e.fix}`,
        e.prevention && `  Lưu ý: ${e.prevention}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
}

/**
 * @param {{hoSoType?: string, history: {role: 'user'|'assistant', content: string}[]}} input
 */
export async function answer({ hoSoType, history }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("Chưa cấu hình ANTHROPIC_API_KEY trong file .env");
  const errors = loadErrors(hoSoType || null);
  const system = `${SYSTEM}\n\n=== SỔ LỖI${hoSoType ? ` (loại hồ sơ: ${hoSoType} + lỗi chung)` : ""}, ${errors.length} lỗi ===\n${formatErrors(errors) || "(Sổ lỗi đang trống)"}`;
  const messages = history
    .slice(-12)
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
  if (!messages.length || messages.at(-1).role !== "user") throw new Error("Thiếu câu hỏi");
  const text = await chatText({ purpose: "chat", model: config.modelChat, system, messages });
  return { text, errorsUsed: errors.length };
}
