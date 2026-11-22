import os
import tempfile
import uuid

# Cấu hình trước khi import app. Cần một Postgres để chạy test:
#   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres pytest
os.environ["DATABASE_URL"] = os.environ.get("TEST_DATABASE_URL", "postgresql://postgres@127.0.0.1:5432/postgres")
os.environ["DB_SCHEMA"] = "test_" + uuid.uuid4().hex[:8]
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="so-loi-")
os.environ["APP_USERS"] = "lan:matkhau1,minh:matkhau2"
os.environ["INGEST_TOKEN"] = "bi-mat"
os.environ["ANTHROPIC_API_KEY"] = "test"
os.environ["PROCESS_QUIET_MIN"] = "15"

import pytest  # noqa: E402

from app import db  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def database():
    db.init_db()
    yield
    db.execute(f"DROP SCHEMA {os.environ['DB_SCHEMA']} CASCADE")
    db.pool.close()


@pytest.fixture()
def clean():
    db.execute("TRUNCATE settings, messages, images, image_categories, errors, llm_usage RESTART IDENTITY CASCADE")
