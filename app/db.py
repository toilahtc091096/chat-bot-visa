"""Kết nối Postgres và tạo bảng."""
import json
import re
from contextlib import contextmanager

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

from .config import config

if not re.fullmatch(r"[a-z_][a-z0-9_]*", config.db_schema):
    raise ValueError("DB_SCHEMA chỉ được chứa chữ thường, số và dấu gạch dưới")

SCHEMA_SQL = f"""
CREATE SCHEMA IF NOT EXISTS {config.db_schema};
SET search_path TO {config.db_schema};

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB
);

-- Tin nhắn gốc từ nhóm Zalo
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,               -- msgId của Zalo
  group_id TEXT NOT NULL,
  sender_id TEXT,
  sender_name TEXT,
  ts BIGINT NOT NULL,                -- epoch ms
  msg_type TEXT,
  text TEXT,                         -- nội dung chữ / chú thích ảnh / tên file
  attachment_url TEXT,
  thumb_url TEXT,
  quote_msg_id TEXT,
  quote_text TEXT,
  raw JSONB,
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_group_ts ON messages(group_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_pending ON messages(group_id, ts) WHERE NOT processed;

-- Category ảnh + hint ("ảnh có X thì là loại này") để phân loại ảnh sau rẻ hơn
CREATE TABLE IF NOT EXISTS image_categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  hints JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS images (
  id SERIAL PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  local_path TEXT,
  phash TEXT,                        -- dHash 64 bit (hex)
  category_id INT REFERENCES image_categories(id) ON DELETE SET NULL,
  confidence REAL,
  method TEXT,                       -- hash | hint | vision | manual | failed
  description TEXT,
  tokens_in INT DEFAULT 0,
  tokens_out INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lỗi hồ sơ
CREATE TABLE IF NOT EXISTS errors (
  id SERIAL PRIMARY KEY,
  group_id TEXT,
  ho_so_type TEXT,
  title TEXT NOT NULL,
  meaning TEXT,
  cause_ai TEXT,                     -- nguyên nhân AI đoán ban đầu (giữ nguyên)
  cause TEXT,                        -- nguyên nhân (người dùng sửa)
  fix TEXT,
  prevention TEXT,
  severity TEXT,                     -- thap | trung_binh | cao
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'ai', -- ai | reviewed | rejected
  source_msg_ids JSONB NOT NULL DEFAULT '[]',
  first_ts BIGINT,
  reviewed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_errors_type ON errors(ho_so_type);

CREATE TABLE IF NOT EXISTS llm_usage (
  id SERIAL PRIMARY KEY,
  purpose TEXT,
  model TEXT,
  input_tokens INT,
  output_tokens INT,
  cache_read_tokens INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""

pool = ConnectionPool(
    config.database_url,
    min_size=1,
    max_size=8,
    open=False,
    kwargs={"row_factory": dict_row, "autocommit": True, "options": f"-c search_path={config.db_schema}"},
)


def init_db() -> None:
    if pool.closed:
        pool.open(wait=True)
    with pool.connection() as conn:
        conn.execute(SCHEMA_SQL)


def query(sql: str, params=None) -> list[dict]:
    with pool.connection() as conn:
        return conn.execute(sql, params).fetchall()


def one(sql: str, params=None) -> dict | None:
    with pool.connection() as conn:
        return conn.execute(sql, params).fetchone()


def execute(sql: str, params=None) -> int:
    with pool.connection() as conn:
        return conn.execute(sql, params).rowcount


@contextmanager
def transaction():
    """Dùng: with transaction() as conn: conn.execute(...)"""
    with pool.connection() as conn:
        with conn.transaction():
            yield conn


def get_setting(key: str, default=None):
    row = one("SELECT value FROM settings WHERE key = %s", (key,))
    return row["value"] if row else default


def set_setting(key: str, value) -> None:
    execute(
        "INSERT INTO settings(key, value) VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        (key, Jsonb(value)),
    )


__all__ = ["Jsonb", "json", "init_db", "query", "one", "execute", "transaction", "get_setting", "set_setting", "pool"]
