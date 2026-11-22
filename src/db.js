import Database from "better-sqlite3";
import { config } from "./config.js";

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Tin nhắn gốc từ nhóm Zalo
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,            -- msgId của Zalo
  group_id TEXT NOT NULL,
  sender_id TEXT,
  sender_name TEXT,
  ts INTEGER NOT NULL,            -- epoch ms
  msg_type TEXT,
  text TEXT,                      -- nội dung chữ / chú thích ảnh / tên file
  attachment_url TEXT,
  thumb_url TEXT,
  quote_msg_id TEXT,
  quote_text TEXT,
  raw_json TEXT,
  processed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_messages_group_ts ON messages(group_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_processed ON messages(processed, ts);

-- Danh mục ảnh + "hint" để phân loại ảnh sau rẻ hơn
CREATE TABLE IF NOT EXISTS image_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  hints TEXT NOT NULL DEFAULT '[]',  -- JSON: ["ảnh có X thì là loại này", ...]
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
  local_path TEXT,
  phash TEXT,                       -- dHash 64 bit (hex) để bắt ảnh gần giống
  category_id INTEGER REFERENCES image_categories(id) ON DELETE SET NULL,
  confidence REAL,
  method TEXT,                      -- hash | hint | vision | manual | failed
  description TEXT,                 -- mô tả ngắn nội dung ảnh (dùng thay cho ảnh khi trích xuất lỗi)
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Lỗi hồ sơ đã trích xuất
CREATE TABLE IF NOT EXISTS errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT,
  ho_so_type TEXT,                  -- loại hồ sơ
  title TEXT NOT NULL,              -- tên lỗi ngắn
  meaning TEXT,                     -- mô tả / ý nghĩa lỗi
  cause_ai TEXT,                    -- nguyên nhân AI đoán (giữ nguyên để so sánh)
  cause TEXT,                       -- nguyên nhân (người dùng sửa)
  fix TEXT,                         -- cách xử lý
  prevention TEXT,                  -- lưu ý để tránh lần sau
  severity TEXT,                    -- thap | trung_binh | cao
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'ai',-- ai | reviewed | rejected
  source_msg_ids TEXT NOT NULL DEFAULT '[]',
  first_ts INTEGER,
  reviewed_by TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_errors_type ON errors(ho_so_type);

-- Ghi lại chi phí gọi LLM
CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
`);

export function getSetting(key, fallback = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, JSON.stringify(value));
}

export function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
