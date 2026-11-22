import base64

import pytest
from fastapi.testclient import TestClient

from app import db
from app.main import create_app

AUTH = {"Authorization": "Basic " + base64.b64encode(b"lan:matkhau1").decode()}


@pytest.fixture()
def client(clean):
    with TestClient(create_app(scheduler=False)) as c:
        yield c


def test_auth_required(client):
    assert client.get("/api/status").status_code == 401
    bad = {"Authorization": "Basic " + base64.b64encode(b"lan:sai").decode()}
    assert client.get("/api/status", headers=bad).status_code == 401
    s = client.get("/api/status", headers=AUTH).json()
    assert s["user"] == "lan" and s["zaloMode"] == "external"
    assert client.get("/", headers=AUTH).status_code == 200


def test_ingest(client):
    send = lambda token, body: client.post("/api/ingest", json=body, headers={"X-Ingest-Token": token})  # noqa: E731
    assert send("sai", {"messages": []}).status_code == 401
    r = send(
        "bi-mat",
        {
            "messages": [
                {"threadId": "G1", "data": {"msgId": "i1", "uidFrom": "u", "dName": "Lan", "ts": "1700000000000", "msgType": "webchat", "content": "Thiếu ảnh"}},
                {"msgId": "i2", "idTo": "G1", "uidFrom": "u", "ts": 1700000001000, "msgType": "webchat", "content": "Chỉ có data"},
                {"threadId": "G2", "data": {"msgId": "i3", "ts": "1700000002000", "content": "Nhóm khác"}},
            ]
        },
    ).json()
    assert r == {"received": 3, "accepted": 2, "added": 2, "groupId": "G1"}
    assert send("bi-mat", {"messages": [{"threadId": "G1", "data": {"msgId": "i1", "ts": "1", "content": "x"}}]}).json()["added"] == 0
    assert client.get("/api/status", headers=AUTH).json()["messages"]["n"] == 2


def test_errors_crud(client):
    db.execute(
        "INSERT INTO errors (ho_so_type, title, meaning, cause_ai, cause, status, confidence) VALUES ('Visa Mỹ','Sai ngày sinh','m','AI đoán','AI đoán','ai',0.8)"
    )
    created = client.post("/api/errors", json={"title": "Ảnh thẻ nền xanh", "ho_so_type": "Visa Nhật"}, headers=AUTH).json()
    assert created["status"] == "reviewed" and created["reviewed_by"] == "lan"
    assert sorted(t["name"] for t in client.get("/api/types", headers=AUTH).json()) == ["Visa Mỹ", "Visa Nhật"]

    rows = client.get("/api/errors", params={"type": "Visa Mỹ"}, headers=AUTH).json()
    assert len(rows) == 1
    patched = client.patch(f"/api/errors/{rows[0]['id']}", json={"cause": "Nhập MM/DD"}, headers=AUTH).json()
    assert patched["status"] == "reviewed" and patched["cause_ai"] == "AI đoán" and patched["cause"] == "Nhập MM/DD"
    assert client.patch(f"/api/errors/{rows[0]['id']}", json={"status": "rejected"}, headers=AUTH).json()["status"] == "rejected"
    assert client.patch(f"/api/errors/{rows[0]['id']}", json={"cause_ai": "x"}, headers=AUTH).status_code == 400
    assert len(client.get("/api/errors", params={"q": "nền xanh"}, headers=AUTH).json()) == 1
    assert client.get(f"/api/errors/{created['id']}/messages", headers=AUTH).json() == []
