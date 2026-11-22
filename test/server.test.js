import { test, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sổ-lỗi-"));
process.env.APP_USERS = "lan:matkhau1,minh:matkhau2";
const { createApp } = await import("../src/server.js");
const { db } = await import("../src/db.js");

const server = createApp().listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());
const auth = "Basic " + Buffer.from("lan:matkhau1").toString("base64");
const call = (p, opts = {}) =>
  fetch(base + p, { ...opts, headers: { Authorization: auth, "Content-Type": "application/json", ...(opts.headers || {}) } });

test("chặn khi chưa đăng nhập hoặc sai mật khẩu", async () => {
  assert.equal((await fetch(base + "/api/status")).status, 401);
  const bad = await fetch(base + "/api/status", { headers: { Authorization: "Basic " + Buffer.from("lan:sai").toString("base64") } });
  assert.equal(bad.status, 401);
});

test("trạng thái hệ thống", async () => {
  const s = await (await call("/api/status")).json();
  assert.equal(s.user, "lan");
  assert.equal(s.zalo.status, "disconnected");
});

test("thêm, lọc, sửa lỗi; sửa nội dung thì thành đã duyệt", async () => {
  db.prepare("INSERT INTO errors (ho_so_type, title, meaning, cause_ai, cause, status, confidence) VALUES ('Visa Mỹ','Sai ngày sinh trên DS-160','m','AI đoán','AI đoán','ai',0.8)").run();
  const created = await (await call("/api/errors", { method: "POST", body: JSON.stringify({ title: "Ảnh thẻ nền xanh", ho_so_type: "Visa Nhật" }) })).json();
  assert.equal(created.status, "reviewed");
  assert.equal(created.reviewed_by, "lan");

  const types = await (await call("/api/types")).json();
  assert.deepEqual(types.map((t) => t.name).sort(), ["Visa Mỹ", "Visa Nhật"]);

  const list = await (await call("/api/errors?type=" + encodeURIComponent("Visa Mỹ"))).json();
  assert.equal(list.length, 1);
  const patched = await (await call(`/api/errors/${list[0].id}`, { method: "PATCH", body: JSON.stringify({ cause: "Nhân viên nhập theo định dạng MM/DD" }) })).json();
  assert.equal(patched.status, "reviewed");
  assert.equal(patched.cause_ai, "AI đoán");
  assert.equal(patched.cause, "Nhân viên nhập theo định dạng MM/DD");

  const rejected = await (await call(`/api/errors/${list[0].id}`, { method: "PATCH", body: JSON.stringify({ status: "rejected" }) })).json();
  assert.equal(rejected.status, "rejected");

  const search = await (await call("/api/errors?q=" + encodeURIComponent("nền xanh"))).json();
  assert.equal(search.length, 1);
});

test("không cho sửa trường ngoài danh sách", async () => {
  const r = await call("/api/errors/1", { method: "PATCH", body: JSON.stringify({ cause_ai: "x" }) });
  assert.equal(r.status, 400);
});
