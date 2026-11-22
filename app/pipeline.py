"""Chạy phân loại ảnh + trích xuất lỗi, theo lịch hoặc khi bấm nút."""
import logging
import threading
import time

from .config import config
from .extract import process_all
from .images import classify_pending_images
from .store import current_group_id

log = logging.getLogger("pipeline")
state = {"running": False, "lastRun": None, "lastResult": None, "error": None}
_lock = threading.Lock()


def run_pipeline(force: bool = False) -> dict:
    group_id = current_group_id()
    if not group_id:
        return {"skipped": True, "reason": "Chưa có nhóm (chưa nhận tin nào)"}
    if not config.has_api_key:
        return {"skipped": True, "reason": "Chưa có ANTHROPIC_API_KEY"}
    if not _lock.acquire(blocking=False):
        return {"skipped": True, "reason": "Đang chạy"}
    state.update(running=True, error=None)
    try:
        result = {"images": classify_pending_images(), "extract": process_all(group_id, force)}
        state["lastResult"] = result
        return result
    except Exception as e:
        state["error"] = str(e)
        log.exception("Pipeline lỗi")
        raise
    finally:
        state.update(running=False, lastRun=int(time.time() * 1000))
        _lock.release()


def run_in_background(force: bool = False) -> None:
    threading.Thread(target=lambda: _safe(force), daemon=True).start()


def _safe(force: bool) -> None:
    try:
        run_pipeline(force)
    except Exception:  # noqa: BLE001 (đã ghi log)
        pass


def start_scheduler() -> None:
    if config.process_interval_min <= 0:
        return

    def loop():
        while True:
            time.sleep(config.process_interval_min * 60)
            _safe(False)

    threading.Thread(target=loop, daemon=True).start()
    log.info("Tự động xử lý mỗi %s phút", config.process_interval_min)
