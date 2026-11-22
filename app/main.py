"""Web + API của Sổ lỗi hồ sơ."""
import logging
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Body, Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from fastapi.staticfiles import StaticFiles

from . import db
from .chat import answer
from .config import config
from .extract import list_ho_so_types
from .images import classify_image, list_categories, set_image_category, update_category
from .pipeline import run_in_background, start_scheduler
from .pipeline import state as pipeline_state
from .store import current_group_id, ingest
from .store import state as store_state

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")
PUBLIC_DIR = Path(__file__).resolve().parent.parent / "public"


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    if app.state.scheduler:
        start_scheduler()
    yield


def create_app(scheduler: bool = True) -> FastAPI:
    app = FastAPI(title="Sổ lỗi hồ sơ", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.scheduler = scheduler
    security = HTTPBasic(realm="So loi ho so")

    def user(credentials: HTTPBasicCredentials = Depends(security)) -> str:
        if not config.users:
            raise HTTPException(500, "Chưa cấu hình APP_USERS trong file .env")
        expected = config.users.get(credentials.username)
        if expected is None or not secrets.compare_digest(credentials.password.encode(), expected.encode()):
            raise HTTPException(401, "Sai tài khoản hoặc mật khẩu", headers={"WWW-Authenticate": 'Basic realm="So loi ho so"'})
        return credentials.username

    @app.exception_handler(Exception)
    async def on_error(request: Request, exc: Exception):
        logging.getLogger("web").exception("Lỗi xử lý %s", request.url.path)
        return JSONResponse({"error": str(exc)}, status_code=500)

    # ---------- nhận tin từ dự án đang đăng nhập Zalo (không dùng tài khoản web) ----------
    @app.post("/api/ingest")
    def api_ingest(body: dict = Body(...), x_ingest_token: str = Header(default="")):
        if not config.ingest_token:
            raise HTTPException(503, "Chưa cấu hình INGEST_TOKEN")
        if not secrets.compare_digest(x_ingest_token.encode(), config.ingest_token.encode()):
            raise HTTPException(401, "Sai INGEST_TOKEN")
        messages = body.get("messages")
        if not isinstance(messages, list):
            raise HTTPException(400, "Cần { messages: [...] }")
        group_id = body.get("groupId")
        return ingest(messages, str(group_id) if group_id else None)

    # ---------- trạng thái ----------
    @app.get("/api/status")
    def api_status(u: str = Depends(user)):
        group_id = current_group_id()
        stats = db.one("SELECT COUNT(*) AS n, MIN(ts) AS min_ts, MAX(ts) AS max_ts FROM messages WHERE group_id = %s", (group_id,))
        return {
            "user": u,
            "zaloMode": "external",
            "zalo": {"status": "external", "lastIngestAt": store_state["last_ingest_at"]},
            "groupId": group_id,
            "groupName": db.get_setting("zalo_group_name"),
            "messages": stats if group_id else None,
            "pendingMessages": db.one("SELECT COUNT(*) AS n FROM messages WHERE NOT processed")["n"],
            "pendingImages": db.one("SELECT COUNT(*) AS n FROM images WHERE method IS NULL")["n"],
            "errors": db.query("SELECT status, COUNT(*) AS n FROM errors GROUP BY status"),
            "pipeline": pipeline_state,
            "usage30d": db.query(
                """SELECT model, SUM(input_tokens)::int AS input_tokens, SUM(output_tokens)::int AS output_tokens, COUNT(*) AS calls
                   FROM llm_usage WHERE created_at > now() - interval '30 days' GROUP BY model"""
            ),
            "hasApiKey": config.has_api_key,
        }

    @app.post("/api/pipeline/run")
    def api_run(body: dict = Body(default={}), u: str = Depends(user)):
        run_in_background(force=bool(body.get("force")))
        return {"ok": True, "started": True}

    # ---------- lỗi ----------
    @app.get("/api/types")
    def api_types(u: str = Depends(user)):
        return list_ho_so_types()

    @app.get("/api/errors")
    def api_errors(type: str = "", status: str = "", q: str = "", u: str = Depends(user)):
        where, params = [], []
        if type:
            where.append("ho_so_type = %s")
            params.append(type)
        if status:
            where.append("status = %s")
            params.append(status)
        if q:
            where.append("(title ILIKE %s OR meaning ILIKE %s OR cause ILIKE %s OR fix ILIKE %s OR prevention ILIKE %s)")
            params += [f"%{q}%"] * 5
        return db.query(
            f"SELECT * FROM errors {'WHERE ' + ' AND '.join(where) if where else ''} ORDER BY COALESCE(first_ts, 0) DESC, id DESC LIMIT 1000",
            params,
        )

    editable = {"ho_so_type", "title", "meaning", "cause", "fix", "prevention", "severity", "status"}

    @app.patch("/api/errors/{error_id}")
    def api_patch_error(error_id: int, body: dict = Body(...), u: str = Depends(user)):
        fields = {k: v for k, v in body.items() if k in editable}
        if not fields:
            raise HTTPException(400, "Không có trường nào để sửa")
        if "status" in fields and fields["status"] not in ("ai", "reviewed", "rejected"):
            raise HTTPException(400, "status không hợp lệ")
        sets = [f"{k} = %({k})s" for k in fields]
        if "status" not in fields:
            sets.append("status = 'reviewed'")  # sửa nội dung = coi như đã duyệt
        db.execute(
            f"UPDATE errors SET {', '.join(sets)}, reviewed_by = %(user)s, updated_at = now() WHERE id = %(id)s",
            {**fields, "user": u, "id": error_id},
        )
        row = db.one("SELECT * FROM errors WHERE id = %s", (error_id,))
        if not row:
            raise HTTPException(404, "Không tìm thấy")
        return row

    @app.post("/api/errors")
    def api_add_error(body: dict = Body(...), u: str = Depends(user)):
        if not body.get("title"):
            raise HTTPException(400, "Thiếu tên lỗi")
        return db.one(
            """INSERT INTO errors (group_id, ho_so_type, title, meaning, cause, fix, prevention, severity, confidence, status, reviewed_by, first_ts)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,1,'reviewed',%s,%s) RETURNING *""",
            (
                current_group_id() or None,
                body.get("ho_so_type") or "Chung",
                body["title"],
                body.get("meaning", ""),
                body.get("cause", ""),
                body.get("fix", ""),
                body.get("prevention", ""),
                body.get("severity") or "trung_binh",
                u,
                int(time.time() * 1000),
            ),
        )

    @app.get("/api/errors/{error_id}/messages")
    def api_error_messages(error_id: int, u: str = Depends(user)):
        err = db.one("SELECT source_msg_ids FROM errors WHERE id = %s", (error_id,))
        if not err:
            raise HTTPException(404, "Không tìm thấy")
        if not err["source_msg_ids"]:
            return []
        return db.query(
            """SELECT m.id, m.ts, m.sender_name, m.msg_type, m.text, m.quote_text, i.id AS image_id,
                      i.description AS image_description, c.name AS image_category
               FROM messages m LEFT JOIN images i ON i.message_id = m.id LEFT JOIN image_categories c ON c.id = i.category_id
               WHERE m.id = ANY(%s) ORDER BY m.ts""",
            (list(err["source_msg_ids"]),),
        )

    # ---------- ảnh ----------
    @app.get("/api/categories")
    def api_categories(u: str = Depends(user)):
        return list_categories()

    @app.patch("/api/categories/{category_id}")
    def api_patch_category(category_id: int, body: dict = Body(...), u: str = Depends(user)):
        update_category(category_id, body.get("name"), body.get("description"), body.get("hints"))
        return {"ok": True}

    @app.get("/api/images")
    def api_images(category_id: str = "", method: str = "", u: str = Depends(user)):
        where, params = [], []
        if category_id == "none":
            where.append("i.category_id IS NULL")
        elif category_id:
            where.append("i.category_id = %s")
            params.append(int(category_id))
        if method:
            where.append("i.method = %s")
            params.append(method)
        return db.query(
            f"""SELECT i.id, i.message_id, i.method, i.confidence, i.description, i.category_id, c.name AS category,
                       m.ts, m.sender_name, m.text AS caption
                FROM images i JOIN messages m ON m.id = i.message_id LEFT JOIN image_categories c ON c.id = i.category_id
                {'WHERE ' + ' AND '.join(where) if where else ''} ORDER BY m.ts DESC LIMIT 300""",
            params,
        )

    @app.get("/api/images/{image_id}/file")
    def api_image_file(image_id: int, u: str = Depends(user)):
        img = db.one("SELECT local_path FROM images WHERE id = %s", (image_id,))
        if not img or not img["local_path"] or not Path(img["local_path"]).exists():
            raise HTTPException(404)
        return FileResponse(img["local_path"])

    @app.patch("/api/images/{image_id}")
    def api_patch_image(image_id: int, body: dict = Body(...), u: str = Depends(user)):
        if not body.get("category"):
            raise HTTPException(400, "Thiếu category")
        set_image_category(image_id, body["category"], body.get("hint"))
        return {"ok": True}

    @app.post("/api/images/{image_id}/reclassify")
    def api_reclassify(image_id: int, u: str = Depends(user)):
        db.execute("UPDATE images SET method = NULL, category_id = NULL WHERE id = %s", (image_id,))
        return {"method": classify_image(image_id)}

    # ---------- chatbot ----------
    @app.post("/api/chat")
    def api_chat(body: dict = Body(...), u: str = Depends(user)):
        if not isinstance(body.get("history"), list):
            raise HTTPException(400, "Thiếu history")
        try:
            return answer(body.get("hoSoType"), body["history"])
        except ValueError as e:
            raise HTTPException(400, str(e)) from e

    # ---------- giao diện ----------
    @app.get("/", include_in_schema=False)
    def index(u: str = Depends(user)):
        return FileResponse(PUBLIC_DIR / "index.html")

    app.mount("/", StaticFiles(directory=PUBLIC_DIR), name="static")
    return app


app = create_app()
