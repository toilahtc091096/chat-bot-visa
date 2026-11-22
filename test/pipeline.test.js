import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import sharp from "sharp";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sổ-lỗi-"));
process.env.PROCESS_QUIET_MIN = "15";
process.env.ANTHROPIC_API_KEY = "test";
const { db } = await import("../src/db.js");
const { setLlmClient } = await import("../src/llm.js");
const { saveMessages } = await import("../src/zalo/store.js");
const { processAll } = await import("../src/extract.js");
const { classifyPendingImages, listCategories } = await import("../src/images.js");
const { answer } = await import("../src/chat.js");

// ---- client LLM giả: trả lời theo hàng đợi, ghi lại request ----
const calls = [];
const queue = [];
const usage = { input_tokens: 100, output_tokens: 20 };
setLlmClient({
  messages: {
    parse: async (req) => {
      calls.push(req);
      return { stop_reason: "end_turn", usage, parsed_output: queue.shift() };
    },
    create: async (req) => {
      calls.push(req);
      return { stop_reason: "end_turn", usage, content: [{ type: "text", text: "Lưu ý: #1" }] };
    },
  },
});

// ---- server ảnh giả ----
const png = (flip) => {
  const w = 200, h = 120, buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) buf.fill(Math.round(((flip ? w - x : x) / w) * 200 + (y / h) * 55), (y * w + x) * 3, (y * w + x) * 3 + 3);
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
};
const imgs = { "/a.png": await png(false), "/a2.png": await sharp(await png(false)).jpeg({ quality: 40 }).toBuffer(), "/b.png": await png(true) };
const srv = http.createServer((req, res) => (imgs[req.url] ? res.end(imgs[req.url]) : res.writeHead(404).end())).listen(0);
const host = `http://127.0.0.1:${srv.address().port}`;
after(() => srv.close());

const G = "g1";
const old = Date.now() - 2 * 3600 * 1000;
const msg = (id, i, extra) => ({
  id, group_id: G, sender_id: "u", sender_name: "Lan", ts: old + i * 60000, msg_type: "webchat", text: null,
  attachment_url: null, thumb_url: null, quote_msg_id: null, quote_text: null, raw_json: "{}", ...extra,
});

test("ảnh: tầng vision tạo category, ảnh giống dùng hash, ảnh khác dùng hint", async () => {
  saveMessages([
    msg("p1", 0, { msg_type: "chat.photo", attachment_url: host + "/a.png", text: "tờ khai sai" }),
    msg("p2", 1, { msg_type: "chat.photo", attachment_url: host + "/a2.png" }),
    msg("p3", 2, { msg_type: "chat.photo", attachment_url: host + "/b.png" }),
  ]);
  queue.push(
    { category: "Ảnh chụp tờ khai", is_new: true, category_description: "Tờ khai online", new_hints: ["Ảnh có bảng ô nhập liệu thì là tờ khai"], description: "Ô ngày sinh bị khoanh đỏ", confidence: 0.9 },
    { category: "Ảnh chụp tờ khai", confidence: 0.9, description: "Tờ khai, ô tên sai" },
  );
  const stats = await classifyPendingImages({ log: () => {} });
  assert.deepEqual(stats, { hash: 1, hint: 1, vision: 1, failed: 0 });
  const cats = listCategories();
  assert.equal(cats.length, 1);
  assert.deepEqual(cats[0].hints, ["Ảnh có bảng ô nhập liệu thì là tờ khai"]);
  // tầng hint dùng model rẻ + ảnh thu nhỏ
  assert.equal(calls[1].model, "claude-haiku-5-5");
  assert.equal(calls[0].model, "claude-sonnet-5-5");
});

test("trích xuất lỗi: tạo mới, gộp vào lỗi cũ, không ghi đè lỗi đã duyệt", async () => {
  saveMessages([
    msg("t1", 3, { text: "Hồ sơ visa Mỹ của chị A bị sai ngày sinh, SĐT 0912345678" }),
    msg("t2", 4, { text: "Do nhập theo kiểu ngày/tháng" }),
    { ...msg("t3", 0, { text: "tin mới chưa yên" }), ts: Date.now() }, // quá mới, chưa xử lý
  ]);
  queue.push({
    errors: [{ existing_error_id: null, source_msg_ids: ["p1", "t1", "t2"], ho_so_type: "Visa Mỹ", title: "Sai ngày sinh", meaning: "m", cause: "Nhập sai định dạng", fix: "Sửa lại", prevention: "Kiểm tra MM/DD", severity: "cao", confidence: 0.9 }],
  });
  const r1 = await processAll(G, { log: () => {} });
  assert.equal(r1.created, 1);
  const prompt = calls.at(-1).messages[0].content;
  assert.ok(prompt.includes("[ẢNH - loại: Ảnh chụp tờ khai] Ô ngày sinh bị khoanh đỏ"), "ảnh được thay bằng mô tả");
  assert.ok(!prompt.includes("0912345678"), "đã che số điện thoại");
  assert.ok(!prompt.includes("tin mới chưa yên"));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE processed = 0").get().n, 1);

  // người dùng duyệt lỗi, sau đó có tin mới bàn tiếp về lỗi đó
  db.prepare("UPDATE errors SET status='reviewed', cause='Người sửa' WHERE id=1").run();
  queue.push({
    errors: [{ existing_error_id: 1, source_msg_ids: ["t3"], ho_so_type: "Visa Mỹ", title: "X", meaning: "X", cause: "AI mới", fix: "", prevention: "", severity: "thap", confidence: 0.5 }],
  });
  const r2 = await processAll(G, { force: true, log: () => {} });
  assert.equal(r2.updated, 1);
  const e = db.prepare("SELECT * FROM errors WHERE id=1").get();
  assert.equal(e.cause, "Người sửa");
  assert.deepEqual(JSON.parse(e.source_msg_ids), ["p1", "t1", "t2", "t3"]);
});

test("chatbot đưa sổ lỗi theo loại hồ sơ vào system prompt", async () => {
  const r = await answer({ hoSoType: "Visa Mỹ", history: [{ role: "user", content: "Làm visa Mỹ cần lưu ý gì?" }] });
  assert.equal(r.errorsUsed, 1);
  const req = calls.at(-1);
  assert.equal(req.model, "claude-haiku-5-5");
  assert.ok(req.system[0].text.includes("#1 [Visa Mỹ] [đã duyệt]"));
  await assert.rejects(answer({ history: [] }));
});
