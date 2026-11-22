import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "./config.js";
import { db, getSetting, parseJson, setSetting } from "./db.js";
import { answer } from "./chat.js";
import { listHoSoTypes } from "./extract.js";
import { listCategories, setImageCategory, updateCategory, classifyImage } from "./images.js";
import { runPipeline, pipelineState } from "./pipeline.js";
import { zaloState, startQrLogin, listGroups, currentGroupId, messageCount, ingestMessages } from "./zalo/client.js";
import { backfillGroup, backfillState } from "./zalo/backfill.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------- đăng nhập web (HTTP Basic, dùng kèm HTTPS) ----------
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function basicAuth(req, res, next) {
  if (!Object.keys(config.users).length) {
    return res.status(500).send("Chưa cấu hình APP_USERS trong file .env");
  }
  const [scheme, encoded] = (req.headers.authorization || "").split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString();
    const i = decoded.indexOf(":");
    const user = decoded.slice(0, i);
    const pass = decoded.slice(i + 1);
    if (config.users[user] !== undefined && safeEqual(config.users[user], pass)) {
      req.user = user;
      return next();
    }
  }
  res.set("WWW-Authenticate", 'Basic realm="So loi ho so", charset="UTF-8"').status(401).send("Cần đăng nhập");
}

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    res.status(500).json({ error: err.message });
  });

function rowToError(r) {
  return { ...r, source_msg_ids: parseJson(r.source_msg_ids, []) };
}

export function createApp() {
  const app = express();

  // Dự án khác (đang đăng nhập Zalo) gửi tin sang. Xác thực bằng INGEST_TOKEN, không dùng tài khoản web.
  app.post("/api/ingest", express.json({ limit: "10mb" }), (req, res) => {
    if (!config.ingestToken) return res.status(503).json({ error: "Chưa cấu hình INGEST_TOKEN" });
    const token = req.get("x-ingest-token") || "";
    if (!safeEqual(token, config.ingestToken)) return res.status(401).json({ error: "Sai INGEST_TOKEN" });
    const { messages, groupId } = req.body || {};
    if (!Array.isArray(messages)) return res.status(400).json({ error: "Cần { messages: [...] }" });
    res.json(ingestMessages(messages, groupId ? String(groupId) : undefined));
  });

  app.use(basicAuth);
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(here, "..", "public")));

  // ---------- trạng thái + Zalo ----------
  app.get("/api/status", (req, res) => {
    const groupId = currentGroupId();
    const usage = db
      .prepare(
        `SELECT model, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, COUNT(*) AS calls
         FROM llm_usage WHERE created_at > ? GROUP BY model`,
      )
      .all(Date.now() - 30 * 24 * 3600 * 1000);
    res.json({
      user: req.user,
      zalo: zaloState,
      groupId,
      groupName: getSetting("zalo_group_name"),
      messages: groupId ? messageCount(groupId) : null,
      pendingMessages: db.prepare("SELECT COUNT(*) AS n FROM messages WHERE processed = 0").get().n,
      pendingImages: db.prepare("SELECT COUNT(*) AS n FROM images WHERE method IS NULL").get().n,
      errors: db.prepare("SELECT status, COUNT(*) AS n FROM errors GROUP BY status").all(),
      backfill: backfillState,
      pipeline: pipelineState,
      usage30d: usage,
      hasApiKey: !!process.env.ANTHROPIC_API_KEY,
      zaloMode: config.zaloMode,
    });
  });

  app.post("/api/zalo/login-qr", wrap(async (req, res) => {
    await startQrLogin();
    res.json({ ok: true });
  }));

  app.get("/api/zalo/qr.png", (req, res) => {
    if (!fs.existsSync(config.zaloQrPath)) return res.status(404).end();
    res.set("Cache-Control", "no-store").sendFile(config.zaloQrPath);
  });

  app.get("/api/zalo/groups", wrap(async (req, res) => res.json(await listGroups())));

  app.post("/api/zalo/group", (req, res) => {
    const { id, name } = req.body || {};
    if (!id) return res.status(400).json({ error: "Thiếu id nhóm" });
    setSetting("zalo_group_id", String(id));
    setSetting("zalo_group_name", name || null);
    res.json({ ok: true });
  });

  app.post("/api/zalo/backfill", (req, res) => {
    const days = Number(req.body?.days) || config.backfillDays;
    backfillGroup(currentGroupId(), days)
      .then(() => runPipeline({ force: true }))
      .catch((err) => console.error("[backfill]", err.message));
    res.json({ ok: true, started: true });
  });

  app.post("/api/pipeline/run", (req, res) => {
    runPipeline({ force: !!req.body?.force }).catch(() => {});
    res.json({ ok: true, started: true });
  });

  // ---------- lỗi ----------
  app.get("/api/types", (req, res) => res.json(listHoSoTypes()));

  app.get("/api/errors", (req, res) => {
    const { type, status, q } = req.query;
    const where = [];
    const params = [];
    if (type) where.push("ho_so_type = ?") && params.push(type);
    if (status) where.push("status = ?") && params.push(status);
    if (q) {
      where.push("(title LIKE ? OR meaning LIKE ? OR cause LIKE ? OR fix LIKE ? OR prevention LIKE ?)");
      params.push(...Array(5).fill(`%${q}%`));
    }
    const rows = db
      .prepare(`SELECT * FROM errors ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY COALESCE(first_ts, created_at) DESC LIMIT 1000`)
      .all(...params);
    res.json(rows.map(rowToError));
  });

  const EDITABLE = ["ho_so_type", "title", "meaning", "cause", "fix", "prevention", "severity", "status"];

  app.patch("/api/errors/:id", (req, res) => {
    const fields = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => EDITABLE.includes(k)));
    if (!Object.keys(fields).length) return res.status(400).json({ error: "Không có trường nào để sửa" });
    if (fields.status && !["ai", "reviewed", "rejected"].includes(fields.status)) return res.status(400).json({ error: "status không hợp lệ" });
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`);
    // Sửa nội dung = coi như đã duyệt, trừ khi người dùng đặt status khác
    if (!fields.status) sets.push("status = 'reviewed'");
    db.prepare(`UPDATE errors SET ${sets.join(", ")}, reviewed_by = @user, updated_at = @now WHERE id = @id`).run({
      ...fields,
      user: req.user,
      now: Date.now(),
      id: Number(req.params.id),
    });
    res.json(rowToError(db.prepare("SELECT * FROM errors WHERE id = ?").get(Number(req.params.id))));
  });

  app.post("/api/errors", (req, res) => {
    const b = req.body || {};
    if (!b.title) return res.status(400).json({ error: "Thiếu tên lỗi" });
    const info = db
      .prepare(
        `INSERT INTO errors (group_id, ho_so_type, title, meaning, cause, fix, prevention, severity, confidence, status, reviewed_by, first_ts)
         VALUES (?,?,?,?,?,?,?,?,1,'reviewed',?,?)`,
      )
      .run(currentGroupId() || null, b.ho_so_type || "Chung", b.title, b.meaning || "", b.cause || "", b.fix || "", b.prevention || "", b.severity || "trung_binh", req.user, Date.now());
    res.json(rowToError(db.prepare("SELECT * FROM errors WHERE id = ?").get(info.lastInsertRowid)));
  });

  // Tin nhắn gốc của 1 lỗi (để người duyệt đối chiếu)
  app.get("/api/errors/:id/messages", (req, res) => {
    const err = db.prepare("SELECT source_msg_ids FROM errors WHERE id = ?").get(Number(req.params.id));
    if (!err) return res.status(404).json({ error: "Không tìm thấy" });
    const ids = parseJson(err.source_msg_ids, []);
    if (!ids.length) return res.json([]);
    const rows = db
      .prepare(
        `SELECT m.id, m.ts, m.sender_name, m.msg_type, m.text, m.quote_text, i.id AS image_id, i.description AS image_description, c.name AS image_category
         FROM messages m LEFT JOIN images i ON i.message_id = m.id LEFT JOIN image_categories c ON c.id = i.category_id
         WHERE m.id IN (${ids.map(() => "?").join(",")}) ORDER BY m.ts`,
      )
      .all(...ids);
    res.json(rows);
  });

  // ---------- ảnh ----------
  app.get("/api/categories", (req, res) => res.json(listCategories()));

  app.patch("/api/categories/:id", (req, res) => {
    updateCategory(Number(req.params.id), req.body || {});
    res.json({ ok: true });
  });

  app.get("/api/images", (req, res) => {
    const { category_id, method } = req.query;
    const where = [];
    const params = [];
    if (category_id === "none") where.push("i.category_id IS NULL");
    else if (category_id) where.push("i.category_id = ?") && params.push(Number(category_id));
    if (method) where.push("i.method = ?") && params.push(method);
    res.json(
      db
        .prepare(
          `SELECT i.id, i.message_id, i.method, i.confidence, i.description, i.category_id, c.name AS category, m.ts, m.sender_name, m.text AS caption
           FROM images i JOIN messages m ON m.id = i.message_id LEFT JOIN image_categories c ON c.id = i.category_id
           ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY m.ts DESC LIMIT 300`,
        )
        .all(...params),
    );
  });

  app.get("/api/images/:id/file", (req, res) => {
    const img = db.prepare("SELECT local_path FROM images WHERE id = ?").get(Number(req.params.id));
    if (!img?.local_path || !fs.existsSync(img.local_path)) return res.status(404).end();
    res.sendFile(img.local_path);
  });

  app.patch("/api/images/:id", (req, res) => {
    const { category, hint } = req.body || {};
    if (!category) return res.status(400).json({ error: "Thiếu category" });
    setImageCategory(Number(req.params.id), category, hint);
    res.json({ ok: true });
  });

  app.post("/api/images/:id/reclassify", wrap(async (req, res) => {
    db.prepare("UPDATE images SET method = NULL, category_id = NULL WHERE id = ?").run(Number(req.params.id));
    res.json(await classifyImage(Number(req.params.id)));
  }));

  // ---------- chatbot ----------
  app.post("/api/chat", wrap(async (req, res) => {
    const { hoSoType, history } = req.body || {};
    if (!Array.isArray(history)) return res.status(400).json({ error: "Thiếu history" });
    res.json(await answer({ hoSoType, history }));
  }));

  return app;
}
