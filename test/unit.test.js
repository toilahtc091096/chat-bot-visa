import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import sharp from "sharp";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sổ-lỗi-"));
const { normalizeMessage, isImageMessage } = await import("../src/zalo/normalize.js");
const { maskPii } = await import("../src/llm.js");
const { dHash, hamming } = await import("../src/images.js");

test("chuẩn hóa tin nhắn chữ", () => {
  const row = normalizeMessage({
    threadId: "123",
    data: { msgId: "m1", uidFrom: "u1", dName: "Lan", ts: "1700000000000", msgType: "webchat", content: "Hồ sơ A thiếu ảnh" },
  });
  assert.equal(row.id, "m1");
  assert.equal(row.group_id, "123");
  assert.equal(row.ts, 1700000000000);
  assert.equal(row.text, "Hồ sơ A thiếu ảnh");
  assert.equal(isImageMessage(row), false);
});

test("chuẩn hóa tin nhắn ảnh, lấy link HD trong params", () => {
  const row = normalizeMessage({
    threadId: "123",
    data: {
      msgId: "m2", uidFrom: "u1", ts: "1", msgType: "chat.photo",
      content: { title: "ảnh tờ khai sai", href: "https://x/a.jpg", thumb: "https://x/t.jpg", params: JSON.stringify({ hd: "https://x/hd.jpg" }) },
      quote: { globalMsgId: 99, msg: "lỗi gì vậy" },
    },
  });
  assert.equal(row.attachment_url, "https://x/hd.jpg");
  assert.equal(row.thumb_url, "https://x/t.jpg");
  assert.equal(row.text, "ảnh tờ khai sai");
  assert.equal(row.quote_msg_id, "99");
  assert.equal(isImageMessage(row), true);
});

test("che thông tin cá nhân", () => {
  const s = maskPii("Khách 0912345678, CCCD 001203004567, hộ chiếu C1234567, mail a.b@gmail.com, hồ sơ 3 bộ");
  assert.ok(!s.includes("0912345678"));
  assert.ok(!s.includes("001203004567"));
  assert.ok(!s.includes("C1234567"));
  assert.ok(!s.includes("a.b@gmail.com"));
  assert.ok(s.includes("hồ sơ 3 bộ"));
});

test("dHash: ảnh gần giống có khoảng cách nhỏ, ảnh khác có khoảng cách lớn", async () => {
  const gradient = (w, h, flip) => {
    const buf = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = Math.round(((flip ? w - x : x) / w) * 255 * 0.5 + (y / h) * 255 * 0.5);
      buf.fill(v, (y * w + x) * 3, (y * w + x) * 3 + 3);
    }
    return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  };
  const a = await dHash(await gradient(300, 200, false));
  const aSmall = await dHash(await sharp(await gradient(300, 200, false)).resize(120).jpeg({ quality: 50 }).toBuffer());
  const b = await dHash(await gradient(300, 200, true));
  assert.ok(hamming(a, aSmall) <= 6, `gần giống: ${hamming(a, aSmall)}`);
  assert.ok(hamming(a, b) > 20, `khác nhau: ${hamming(a, b)}`);
});
