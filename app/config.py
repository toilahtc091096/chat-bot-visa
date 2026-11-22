"""Cấu hình đọc từ biến môi trường (file .env)."""
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def _users(raw: str) -> dict[str, str]:
    users = {}
    for pair in raw.split(","):
        pair = pair.strip()
        if ":" in pair:
            name, password = pair.split(":", 1)
            users[name.strip()] = password
    return users


class Config:
    def __init__(self) -> None:
        self.host = _env("HOST", "127.0.0.1")
        self.port = int(_env("PORT", "3000"))
        self.data_dir = Path(_env("DATA_DIR", "./data")).resolve()
        self.images_dir = self.data_dir / "images"
        self.images_dir.mkdir(parents=True, exist_ok=True)
        self.timezone = _env("TZ", "Asia/Ho_Chi_Minh")

        # Postgres. Bảng nằm trong schema riêng (mặc định so_loi) nên dùng chung database với dự án khác được.
        self.database_url = _env("DATABASE_URL", "postgresql://localhost/so_loi")
        self.db_schema = _env("DB_SCHEMA", "so_loi")

        # "ten:matkhau,ten2:matkhau2" – tài khoản đăng nhập web
        self.users = _users(_env("APP_USERS"))

        # Dự án đang đăng nhập Zalo gửi tin sang qua POST /api/ingest với header X-Ingest-Token
        self.ingest_token = _env("INGEST_TOKEN")
        self.zalo_group_id = _env("ZALO_GROUP_ID")  # để trống: nhận nhóm của tin đầu tiên

        # Model AI
        self.model_extract = _env("LLM_MODEL_EXTRACT", "claude-sonnet-5-5")
        self.model_chat = _env("LLM_MODEL_CHAT", "claude-haiku-5-5")
        self.model_image_cheap = _env("LLM_MODEL_IMAGE_CHEAP", "claude-haiku-5-5")
        self.model_image_full = _env("LLM_MODEL_IMAGE_FULL", "claude-sonnet-5-5")
        self.mask_pii = _env("MASK_PII", "true") != "false"

        # Xử lý tự động
        self.process_interval_min = float(_env("PROCESS_INTERVAL_MIN", "30"))
        self.process_quiet_min = float(_env("PROCESS_QUIET_MIN", "15"))
        self.chunk_size = int(_env("EXTRACT_CHUNK_SIZE", "120"))
        self.context_size = int(_env("EXTRACT_CONTEXT_SIZE", "20"))

        # Ảnh
        self.image_hash_max_distance = int(_env("IMAGE_HASH_MAX_DISTANCE", "6"))
        self.image_cheap_min_confidence = float(_env("IMAGE_CHEAP_MIN_CONFIDENCE", "0.75"))

    @property
    def has_api_key(self) -> bool:
        return bool(os.environ.get("ANTHROPIC_API_KEY"))


config = Config()
