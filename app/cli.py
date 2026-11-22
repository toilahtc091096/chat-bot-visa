"""Lệnh chạy tay:
    python -m app.cli demo             nạp tin chat mẫu (chạy thử không cần Zalo)
    python -m app.cli process --force  phân loại ảnh + trích xuất lỗi ngay
    python -m app.cli clear-demo       xóa dữ liệu mẫu
"""
import json
import logging
import sys

from . import db
from .demo import clear_demo, load_demo
from .pipeline import run_pipeline

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")

if __name__ == "__main__":
    args = sys.argv[1:]
    db.init_db()
    cmd = args[0] if args else ""
    if cmd == "demo":
        print(json.dumps(load_demo(), ensure_ascii=False))
    elif cmd == "clear-demo":
        clear_demo()
        print("Đã xóa dữ liệu mẫu")
    elif cmd == "process":
        print(json.dumps(run_pipeline(force="--force" in args), ensure_ascii=False, indent=2))
    else:
        print(__doc__)
