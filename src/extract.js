import { z } from "zod";
import { config } from "./config.js";
import { db, parseJson } from "./db.js";
import { structured, maskPii } from "./llm.js";

/*
 * Đọc tin nhắn chưa xử lý theo từng đoạn, nhờ LLM rút ra các lỗi hồ sơ.
 * Ảnh không gửi lại cho LLM ở bước này: dùng category + mô tả đã có từ bước phân loại ảnh.
 */

const ErrorSchema = z.object({
  existing_error_id: z
    .number()
    .nullable()
    .describe("Nếu đoạn chat đang tiếp tục bàn về một lỗi trong danh sách 'Lỗi đã ghi nhận gần đây' thì điền id đó, nếu không thì null"),
  source_msg_ids: z.array(z.string()).describe("Id các tin nhắn (trong ngoặc vuông) nói về lỗi này"),
  ho_so_type: z.string().describe("Loại hồ sơ, dùng lại tên trong danh sách có sẵn nếu khớp; 'Chung' nếu áp dụng cho mọi loại"),
  title: z.string().describe("Tên lỗi ngắn gọn, dưới 15 từ"),
  meaning: z.string().describe("Lỗi này là gì, xảy ra ở đâu trong hồ sơ"),
  cause: z.string().describe("Nguyên nhân có khả năng nhất. Nếu chat không nói rõ thì suy luận và ghi 'Dự đoán: ...'"),
  fix: z.string().describe("Cách đã xử lý hoặc nên xử lý; rỗng nếu chưa rõ"),
  prevention: z.string().describe("Lưu ý ngắn cho người làm hồ sơ để không mắc lại lỗi này"),
  severity: z.enum(["thap", "trung_binh", "cao"]),
  confidence: z.number().describe("0..1, mức chắc chắn đây thật sự là một lỗi hồ sơ và thông tin trên đúng"),
});

const ExtractSchema = z.object({ errors: z.array(ErrorSchema) });

const SYSTEM = `Bạn là trợ lý của một văn phòng làm hồ sơ (visa và giấy tờ). Nhóm chat "Xử lý hồ sơ lỗi" là nơi mọi người báo và xử lý lỗi hồ sơ.
Nhiệm vụ: đọc đoạn chat và liệt kê các LỖI HỒ SƠ được nêu, mỗi lỗi một mục.
- Chỉ ghi lỗi thật (sai thông tin, thiếu giấy tờ, sai quy cách ảnh, nộp sai mẫu, bị trả hồ sơ...). Bỏ qua chào hỏi, nhắc việc, trao đổi không phải lỗi.
- Gộp các tin cùng nói về một lỗi thành một mục. Một tin có thể thuộc nhiều lỗi.
- Phần "NGỮ CẢNH TRƯỚC" chỉ để hiểu, không trích lỗi chỉ dựa trên phần đó.
- Viết tiếng Việt, ngắn gọn, khái quát hóa để người khác học được (không nêu tên khách, số giấy tờ, số điện thoại).
- Không có lỗi nào thì trả về danh sách rỗng.`;

function fmtTime(ts) {
  return new Date(ts).toLocaleString("sv-SE", { timeZone: config.timezone }).slice(0, 16);
}

function formatMessage(m, imagesByMsg) {
  const parts = [];
  const img = imagesByMsg.get(m.id);
  if (img) {
    parts.push(`[ẢNH${img.category ? " - loại: " + img.category : ""}] ${img.description || "(chưa có mô tả)"}`);
    if (m.text) parts.push(`Chú thích: ${m.text}`);
  } else if (m.msg_type === "share.file") {
    parts.push(`[FILE] ${m.text || ""}`);
  } else if (m.msg_type && m.msg_type !== "webchat" && !m.text) {
    parts.push(`[${m.msg_type}]`);
  } else {
    parts.push(m.text || "");
  }
  let line = `[${m.id}] ${fmtTime(m.ts)} ${m.sender_name || m.sender_id}: ${parts.join(" ")}`;
  if (m.quote_text) line += `  (trả lời tin: "${m.quote_text.slice(0, 200)}")`;
  return config.maskPii ? maskPii(line) : line;
}

function imagesFor(messageIds) {
  const map = new Map();
  if (!messageIds.length) return map;
  const rows = db
    .prepare(
      `SELECT i.message_id, i.description, c.name AS category FROM images i
       LEFT JOIN image_categories c ON c.id = i.category_id
       WHERE i.message_id IN (${messageIds.map(() => "?").join(",")})`,
    )
    .all(...messageIds);
  for (const r of rows) map.set(r.message_id, r);
  return map;
}

export function listHoSoTypes() {
  return db
    .prepare("SELECT ho_so_type AS name, COUNT(*) AS n FROM errors WHERE status != 'rejected' AND ho_so_type IS NOT NULL GROUP BY ho_so_type ORDER BY n DESC")
    .all();
}

function saveErrors(groupId, extracted, chunkMsgs) {
  const tsById = new Map(chunkMsgs.map((m) => [m.id, m.ts]));
  const now = Date.now();
  let created = 0;
  let updated = 0;
  for (const e of extracted) {
    const ids = e.source_msg_ids.filter((id) => tsById.has(id));
    const firstTs = ids.length ? Math.min(...ids.map((id) => tsById.get(id))) : chunkMsgs[0].ts;
    const existing = e.existing_error_id ? db.prepare("SELECT * FROM errors WHERE id = ?").get(e.existing_error_id) : null;

    if (existing) {
      const mergedIds = [...new Set([...parseJson(existing.source_msg_ids, []), ...ids])];
      if (existing.status === "ai") {
        // Lỗi chưa ai duyệt: cập nhật theo thông tin mới nhất
        db.prepare(
          `UPDATE errors SET ho_so_type=?, title=?, meaning=?, cause_ai=?, cause=?, fix=?, prevention=?, severity=?, confidence=?,
           source_msg_ids=?, updated_at=? WHERE id=?`,
        ).run(e.ho_so_type, e.title, e.meaning, e.cause, e.cause, e.fix, e.prevention, e.severity, e.confidence, JSON.stringify(mergedIds), now, existing.id);
      } else {
        // Đã có người duyệt: không ghi đè, chỉ nối thêm tin nhắn nguồn
        db.prepare("UPDATE errors SET source_msg_ids=?, updated_at=? WHERE id=?").run(JSON.stringify(mergedIds), now, existing.id);
      }
      updated++;
      continue;
    }

    db.prepare(
      `INSERT INTO errors (group_id, ho_so_type, title, meaning, cause_ai, cause, fix, prevention, severity, confidence, source_msg_ids, first_ts)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(groupId, e.ho_so_type, e.title, e.meaning, e.cause, e.cause, e.fix, e.prevention, e.severity, e.confidence, JSON.stringify(ids), firstTs);
    created++;
  }
  return { created, updated };
}

/** Xử lý 1 đoạn tin nhắn chưa xử lý của nhóm. Trả về null nếu không còn gì để xử lý. */
export async function processNextChunk(groupId, { force = false } = {}) {
  const cutoff = force ? Date.now() + 1 : Date.now() - config.processQuietMin * 60 * 1000;
  const chunk = db
    .prepare("SELECT * FROM messages WHERE group_id = ? AND processed = 0 AND ts < ? ORDER BY ts LIMIT ?")
    .all(groupId, cutoff, config.chunkSize);
  if (!chunk.length) return null;

  const context = db
    .prepare("SELECT * FROM messages WHERE group_id = ? AND ts < ? ORDER BY ts DESC LIMIT ?")
    .all(groupId, chunk[0].ts, config.contextSize)
    .reverse();
  const images = imagesFor([...context, ...chunk].map((m) => m.id));

  const recentErrors = db
    .prepare("SELECT id, ho_so_type, title FROM errors WHERE group_id = ? AND status != 'rejected' ORDER BY COALESCE(first_ts, created_at) DESC LIMIT 40")
    .all(groupId);
  const types = listHoSoTypes().map((t) => t.name);

  const prompt = [
    `Loại hồ sơ đã có: ${types.length ? types.join(", ") : "(chưa có)"}`,
    `Lỗi đã ghi nhận gần đây:\n${recentErrors.map((e) => `#${e.id} [${e.ho_so_type}] ${e.title}`).join("\n") || "(chưa có)"}`,
    context.length ? `=== NGỮ CẢNH TRƯỚC (chỉ để tham khảo) ===\n${context.map((m) => formatMessage(m, images)).join("\n")}` : "",
    `=== ĐOẠN CHAT CẦN PHÂN TÍCH ===\n${chunk.map((m) => formatMessage(m, images)).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const { data } = await structured({
    purpose: "extract_errors",
    model: config.modelExtract,
    system: SYSTEM,
    effort: "medium",
    schema: ExtractSchema,
    content: prompt,
  });

  const result = saveErrors(groupId, data.errors, chunk);
  const mark = db.prepare("UPDATE messages SET processed = 1 WHERE id = ?");
  db.transaction(() => chunk.forEach((m) => mark.run(m.id)))();
  return { messages: chunk.length, ...result };
}

/** Xử lý hết tin chưa xử lý. */
export async function processAll(groupId, { force = false, log = console.log } = {}) {
  const total = { chunks: 0, messages: 0, created: 0, updated: 0 };
  while (true) {
    const r = await processNextChunk(groupId, { force });
    if (!r) break;
    total.chunks++;
    total.messages += r.messages;
    total.created += r.created;
    total.updated += r.updated;
    log(`[extract] Đoạn ${total.chunks}: ${r.messages} tin, +${r.created} lỗi mới, ${r.updated} lỗi cập nhật`);
  }
  return total;
}
