from PIL import Image

from app.images import dhash, hamming
from app.llm import mask_pii
from app.normalize import is_image, normalize_message


def gradient(flip=False, size=(300, 200)):
    w, h = size
    img = Image.new("L", size)
    img.putdata([int(((w - x if flip else x) / w) * 127 + (y / h) * 127) for y in range(h) for x in range(w)])
    return img


def test_normalize_text():
    row = normalize_message({"msgId": "m1", "uidFrom": "u1", "dName": "Lan", "ts": "1700000000000", "msgType": "webchat", "content": "Thiếu ảnh"}, "123")
    assert row["id"] == "m1" and row["group_id"] == "123" and row["ts"] == 1700000000000
    assert row["text"] == "Thiếu ảnh" and not is_image(row)


def test_normalize_photo_with_hd_and_quote():
    row = normalize_message(
        {
            "msgId": "m2", "uidFrom": "u1", "ts": 1, "msgType": "chat.photo",
            "content": {"title": "tờ khai sai", "href": "https://x/a.jpg", "thumb": "https://x/t.jpg", "params": '{"hd": "https://x/hd.jpg"}'},
            "quote": {"globalMsgId": 99, "msg": "lỗi gì vậy"},
        },
        "123",
    )
    assert row["attachment_url"] == "https://x/hd.jpg" and row["thumb_url"] == "https://x/t.jpg"
    assert row["text"] == "tờ khai sai" and row["quote_msg_id"] == "99" and is_image(row)


def test_mask_pii():
    s = mask_pii("Khách 0912345678, CCCD 001203004567, hộ chiếu C1234567, mail a.b@gmail.com, hồ sơ 3 bộ")
    for secret in ("0912345678", "001203004567", "C1234567", "a.b@gmail.com"):
        assert secret not in s
    assert "hồ sơ 3 bộ" in s


def test_dhash_similar_and_different():
    a = dhash(gradient())
    small = gradient().resize((120, 80))
    assert hamming(a, dhash(small)) <= 6
    assert hamming(a, dhash(gradient(flip=True))) > 20
