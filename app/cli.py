"""Lệnh chạy tay: python -m app.cli process [--force]"""
import json
import logging
import sys

from . import db
from .pipeline import run_pipeline

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")

if __name__ == "__main__":
    args = sys.argv[1:]
    db.init_db()
    if args[:1] == ["process"]:
        print(json.dumps(run_pipeline(force="--force" in args), ensure_ascii=False, indent=2))
    else:
        print("Lệnh: process [--force]")
