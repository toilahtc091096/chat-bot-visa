import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { config } from "./config.js";
import { db, parseJson } from "./db.js";
import { structured } from "./llm.js";

/*
 * Phân loại ảnh theo 3 tầng để tiết kiệm token:
 *   1. hash   – ảnh gần giống (dHash) một ảnh đã phân loại -> dùng lại, 0 token
 *   2. hint   – ảnh thu nhỏ + danh sách category kèm "hint" -> model rẻ (Haiku)
 *   3. vision – ảnh đầy đủ -> model mạnh (Sonnet), có thể tạo category mới và viết thêm hint
 * Hint là các câu kiểu "ảnh có X thì là loại này", người dùng sửa được trên web.
 */

const MAX_HINTS_PER_CATEGORY = 12;

// ---------- tải ảnh + hash ----------

async function download(url, file) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Tải ảnh lỗi HTTP ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/** dHash 64 bit: so sánh độ sáng các điểm ảnh liền kề trên ảnh 9x8 xám. */
export async function dHash(input) {
  const { data } = await sharp(input).grayscale().resize(9, 8, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (data[y * 9 + x] > data[y * 9 + x + 1] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, "0");
}

export function hamming(a, b) {
  let x = BigInt("0x" + a) ^ BigInt("0x" + b);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

async function toJpegBase64(file, maxSide, quality) {
  const buf = await sharp(file).rotate().resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true }).jpeg({ quality }).toBuffer();
  return buf.toString("base64");
}

// ---------- category ----------

export function listCategories() {
  return db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM images i WHERE i.category_id = c.id) AS image_count
       FROM image_categories c ORDER BY c.name`,
    )
    .all()
    .map((c) => ({ ...c, hints: parseJson(c.hints, []) }));
}

function categoriesPrompt(categories) {
  if (!categories.length) return "(chưa có category nào)";
  return categories
    .map((c) => `- ${c.name}: ${c.description || ""}\n  Hint: ${c.hints.length ? c.hints.join(" | ") : "(chưa có)"}`)
    .join("\n");
}

function upsertCategory(name, description, newHints) {
  const existing = db.prepare("SELECT * FROM image_categories WHERE name = ?").get(name);
  if (!existing) {
    const info = db
      .prepare("INSERT INTO image_categories(name, description, hints) VALUES (?,?,?)")
      .run(name, description || null, JSON.stringify(newHints.slice(0, MAX_HINTS_PER_CATEGORY)));
    return info.lastInsertRowid;
  }
  const hints = parseJson(existing.hints, []);
  for (const h of newHints) {
    if (hints.length >= MAX_HINTS_PER_CATEGORY) break;
    if (!hints.some((x) => x.toLowerCase() === h.toLowerCase())) hints.push(h);
  }
  db.prepare("UPDATE image_categories SET hints = ?, description = COALESCE(description, ?), updated_at = ? WHERE id = ?").run(
    JSON.stringify(hints),
    description || null,
    Date.now(),
    existing.id,
  );
  return existing.id;
}

// ---------- 3 tầng phân loại ----------

function findSimilarByHash(phash, excludeId) {
  const rows = db
    .prepare(
      `SELECT id, phash, category_id, description FROM images
       WHERE phash IS NOT NULL AND category_id IS NOT NULL AND id != ? AND method != 'failed'`,
    )
    .all(excludeId);
  let best = null;
  for (const r of rows) {
    const d = hamming(phash, r.phash);
    if (d <= config.imageHashMaxDistance && (!best || d < best.distance)) best = { ...r, distance: d };
  }
  return best;
}

const CheapSchema = z.object({
  category: z.string().describe("Tên category khớp nhất trong danh sách, hoặc chuỗi rỗng nếu không khớp cái nào"),
  confidence: z.number().describe("Độ chắc chắn 0..1"),
  description: z.string().describe("Mô tả ngắn 1-2 câu nội dung ảnh, nêu chi tiết liên quan tới lỗi hồ sơ nếu thấy"),
});

const FullSchema = z.object({
  category: z.string().describe("Tên category (dùng lại tên có sẵn nếu phù hợp, nếu không thì đặt tên mới ngắn gọn bằng tiếng Việt)"),
  is_new: z.boolean(),
  category_description: z.string().describe("Mô tả category này là loại ảnh gì"),
  new_hints: z
    .array(z.string())
    .describe("0-3 dấu hiệu nhìn thấy được để lần sau nhận ra loại ảnh này mà không cần xem ảnh đầy đủ, dạng 'Ảnh có ... thì là loại này'"),
  description: z.string().describe("Mô tả 1-3 câu nội dung ảnh, nêu rõ chi tiết liên quan tới lỗi hồ sơ (ô bị khoanh, chữ sai, thiếu dấu...)"),
  confidence: z.number(),
});

const SYSTEM_IMAGE = `Bạn phân loại ảnh được gửi trong nhóm chat "Xử lý hồ sơ lỗi" (hồ sơ visa, giấy tờ).
Category là loại ảnh (ví dụ: ảnh chụp tờ khai, ảnh hộ chiếu, ảnh chụp màn hình thông báo lỗi, ảnh thẻ sai quy cách...).
Ưu tiên dùng category có sẵn. Chỉ tạo category mới khi ảnh thật sự khác các loại hiện có.
Không chép lại số giấy tờ, số điện thoại hay thông tin cá nhân vào mô tả.`;

/** Phân loại 1 ảnh (theo id trong bảng images). */
export async function classifyImage(imageId) {
  const img = db
    .prepare("SELECT i.*, m.attachment_url, m.thumb_url, m.text AS caption FROM images i JOIN messages m ON m.id = i.message_id WHERE i.id = ?")
    .get(imageId);
  if (!img) throw new Error("Không tìm thấy ảnh");

  const update = (fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE images SET ${keys.map((k) => `${k} = @${k}`).join(", ")}, updated_at = @now WHERE id = @id`).run({
      ...fields,
      now: Date.now(),
      id: imageId,
    });
  };

  // Tải ảnh về máy (link Zalo có thể hết hạn)
  let file = img.local_path;
  if (!file || !fs.existsSync(file)) {
    file = path.join(config.imagesDir, `${img.message_id}.jpg`);
    try {
      await download(img.attachment_url || img.thumb_url, file);
    } catch (err) {
      update({ method: "failed", description: `Không tải được ảnh: ${err.message}` });
      return { method: "failed" };
    }
  }
  const phash = img.phash || (await dHash(file));
  update({ local_path: file, phash });

  // Tầng 1: ảnh gần giống
  const similar = findSimilarByHash(phash, imageId);
  if (similar) {
    update({ category_id: similar.category_id, confidence: 1 - similar.distance / 64, method: "hash", description: similar.description });
    return { method: "hash" };
  }

  const categories = listCategories();
  const caption = img.caption ? `Chú thích kèm ảnh: ${img.caption}\n` : "";

  // Tầng 2: ảnh nhỏ + hint, model rẻ
  if (categories.length) {
    const { data, usage } = await structured({
      purpose: "image_hint",
      model: config.modelImageCheap,
      system: SYSTEM_IMAGE,
      effort: "low",
      maxTokens: 2000,
      schema: CheapSchema,
      content: [
        { type: "text", text: `Danh sách category và hint:\n${categoriesPrompt(categories)}` },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: await toJpegBase64(file, 384, 70) } },
        { type: "text", text: `${caption}Ảnh trên (đã thu nhỏ) thuộc category nào? Nếu không chắc thì để category rỗng.` },
      ],
    });
    const cat = categories.find((c) => c.name === data.category);
    if (cat && data.confidence >= config.imageCheapMinConfidence) {
      update({
        category_id: cat.id,
        confidence: data.confidence,
        method: "hint",
        description: data.description,
        tokens_in: usage.input_tokens,
        tokens_out: usage.output_tokens,
      });
      return { method: "hint" };
    }
  }

  // Tầng 3: ảnh đầy đủ, model mạnh, học thêm hint
  const { data, usage } = await structured({
    purpose: "image_vision",
    model: config.modelImageFull,
    system: SYSTEM_IMAGE,
    effort: "low",
    maxTokens: 4000,
    schema: FullSchema,
    content: [
      { type: "text", text: `Danh sách category hiện có:\n${categoriesPrompt(categories)}` },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: await toJpegBase64(file, 1568, 85) } },
      { type: "text", text: `${caption}Phân loại ảnh này và viết hint giúp nhận ra loại ảnh này lần sau.` },
    ],
  });
  const categoryId = upsertCategory(data.category.trim(), data.category_description, data.new_hints);
  update({
    category_id: categoryId,
    confidence: data.confidence,
    method: "vision",
    description: data.description,
    tokens_in: usage.input_tokens,
    tokens_out: usage.output_tokens,
  });
  return { method: "vision" };
}

/** Tạo dòng images cho các tin nhắn ảnh mới rồi phân loại lần lượt. */
export async function classifyPendingImages({ log = console.log } = {}) {
  db.exec(`INSERT OR IGNORE INTO images(message_id)
           SELECT id FROM messages WHERE msg_type = 'chat.photo' AND (attachment_url IS NOT NULL OR thumb_url IS NOT NULL)`);
  const pending = db.prepare("SELECT id FROM images WHERE method IS NULL ORDER BY id").all();
  const stats = { hash: 0, hint: 0, vision: 0, failed: 0 };
  for (const { id } of pending) {
    try {
      const { method } = await classifyImage(id);
      stats[method]++;
    } catch (err) {
      stats.failed++;
      log(`[images] Lỗi phân loại ảnh ${id}: ${err.message}`);
    }
  }
  if (pending.length) log(`[images] Đã phân loại ${pending.length} ảnh`, stats);
  return stats;
}

/** Người dùng đổi category thủ công; có thể kèm 1 hint mới. */
export function setImageCategory(imageId, categoryName, hint) {
  const categoryId = upsertCategory(categoryName.trim(), null, hint ? [hint] : []);
  db.prepare("UPDATE images SET category_id = ?, method = 'manual', confidence = 1, updated_at = ? WHERE id = ?").run(categoryId, Date.now(), imageId);
}

export function updateCategory(id, { name, description, hints }) {
  db.prepare("UPDATE image_categories SET name = COALESCE(?, name), description = COALESCE(?, description), hints = COALESCE(?, hints), updated_at = ? WHERE id = ?").run(
    name ?? null,
    description ?? null,
    hints ? JSON.stringify(hints.filter(Boolean).slice(0, MAX_HINTS_PER_CATEGORY)) : null,
    Date.now(),
    id,
  );
}
