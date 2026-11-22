"""Dữ liệu chat mẫu (hư cấu) để chạy thử trên máy mà không cần Zalo."""
import time

from . import db
from .store import ingest

DEMO_GROUP = "demo"

# (phút trước, người gửi, nội dung)
CHAT = [
    (300, "Hương", "Hồ sơ visa Mỹ khách Nguyễn Văn A bị lãnh sự trả, lý do ngày sinh trên DS-160 không khớp hộ chiếu"),
    (298, "Tuấn", "Em xem lại thì bên mình nhập 05/03/1990 theo kiểu ngày/tháng, form Mỹ hiểu là tháng 5"),
    (295, "Hương", "Lần sau ô ngày tháng trên DS-160 phải chọn từ dropdown, đối chiếu lại với hộ chiếu trước khi submit nhé"),
    (240, "Lan", "Visa Nhật của chị B bị yêu cầu bổ sung: ảnh thẻ nền xanh, Nhật yêu cầu nền trắng 4.5x4.5"),
    (238, "Minh", "Khách tự chụp ở tiệm gần nhà, mình không kiểm tra lại"),
    (235, "Lan", "Từ giờ nhận ảnh của khách phải kiểm tra nền trắng, kích thước 4.5x4.5, chụp trong 6 tháng"),
    (200, "Tuấn", "Mọi người nhớ họp 3h chiều nay nha"),
    (150, "Minh", "Hồ sơ Schengen (Pháp) bị thiếu sao kê ngân hàng 3 tháng gần nhất, khách chỉ đưa 1 tháng"),
    (148, "Hương", "Checklist Schengen có ghi 3 tháng mà, chắc lúc nhận hồ sơ không đối chiếu checklist"),
    (145, "Minh", "Đã gọi khách bổ sung, nộp lại thứ 2"),
    (90, "Lan", "Visa Mỹ thêm 1 ca: tên trên DS-160 có dấu tiếng Việt, hệ thống không nhận"),
    (88, "Hương", "Tên phải viết không dấu, đúng như dòng MRZ trên hộ chiếu"),
    (60, "Tuấn", "Visa Hàn khách C: thư mời công ty Hàn hết hạn trước ngày nộp"),
    (58, "Tuấn", "Thư mời chỉ có hiệu lực 3 tháng, bên mình để hồ sơ tồn lâu quá"),
    (55, "Lan", "Phải kiểm tra ngày hiệu lực thư mời ngay khi nhận và ưu tiên nộp sớm"),
]


def load_demo() -> dict:
    """Nạp tin mẫu vào nhóm 'demo'. Chỉ dùng khi chưa nhận tin thật nào."""
    current = db.get_setting("zalo_group_id")
    if current and current != DEMO_GROUP:
        raise RuntimeError("Đã có nhóm thật, không nạp dữ liệu mẫu để tránh lẫn dữ liệu")
    db.set_setting("zalo_group_id", DEMO_GROUP)
    db.set_setting("zalo_group_name", "Nhóm mẫu (dữ liệu thử)")
    now = int(time.time() * 1000)
    messages = [
        {"threadId": DEMO_GROUP, "data": {"msgId": f"demo-{i}", "ts": now - minutes * 60_000, "uidFrom": f"u-{name}",
                                           "dName": name, "msgType": "webchat", "content": text}}
        for i, (minutes, name, text) in enumerate(CHAT)
    ]
    return ingest(messages)


def clear_demo() -> None:
    """Xóa toàn bộ dữ liệu mẫu (trước khi nối dự án thật)."""
    with db.transaction() as conn:
        conn.execute("DELETE FROM errors WHERE group_id = %s", (DEMO_GROUP,))
        conn.execute("DELETE FROM messages WHERE group_id = %s", (DEMO_GROUP,))
        conn.execute("DELETE FROM settings WHERE key IN ('zalo_group_id', 'zalo_group_name') AND value = to_jsonb(%s::text)", (DEMO_GROUP,))
        conn.execute("DELETE FROM settings WHERE key = 'zalo_group_name' AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'zalo_group_id')")
