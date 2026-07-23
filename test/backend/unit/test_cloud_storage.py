"""
Cloud accounts + storage (fork feature): auth flows, project/chat CRUD,
per-user isolation. Uses a throwaway VELXIO_DATA_DIR so the real DB is
untouched.
"""

import importlib
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "backend"))


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("VELXIO_DATA_DIR", str(tmp_path))
    from app.services import cloud_db

    importlib.reload(cloud_db)
    from app.api.routes import auth, cloud

    importlib.reload(auth)
    importlib.reload(cloud)

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(auth.router, prefix="/api/auth")
    app.include_router(cloud.router, prefix="/api/cloud")
    return TestClient(app)


def _register(client, email="kid@school.cn", password="secret1", name="小明"):
    r = client.post(
        "/api/auth/register", json={"email": email, "password": password, "name": name}
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


def test_auth_flows(client):
    token = _register(client)
    # duplicate email
    assert client.post(
        "/api/auth/register", json={"email": "kid@school.cn", "password": "x" * 8}
    ).status_code == 409
    # weak password / bad email
    assert client.post(
        "/api/auth/register", json={"email": "a@b.cn", "password": "123"}
    ).status_code == 422
    assert client.post(
        "/api/auth/register", json={"email": "not-an-email", "password": "123456"}
    ).status_code == 422
    # login (case-insensitive email) and failures
    assert client.post(
        "/api/auth/login", json={"email": "KID@school.cn", "password": "secret1"}
    ).status_code == 200
    assert client.post(
        "/api/auth/login", json={"email": "kid@school.cn", "password": "wrong"}
    ).status_code == 401
    # token gate
    h = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/auth/me", headers=h).json()["user"]["name"] == "小明"
    assert client.get("/api/auth/me").status_code == 401
    assert client.get(
        "/api/auth/me", headers={"Authorization": "Bearer bogus"}
    ).status_code == 401


def test_project_crud_and_isolation(client):
    h = {"Authorization": f"Bearer {_register(client)}"}
    data = {"format": "vlx", "boards": [{"id": "arduino-uno"}], "components": [], "wires": []}
    pid = client.post(
        "/api/cloud/projects", json={"name": "红绿灯", "data": data}, headers=h
    ).json()["id"]
    lst = client.get("/api/cloud/projects", headers=h).json()["projects"]
    assert [p["name"] for p in lst] == ["红绿灯"]
    assert (
        client.get(f"/api/cloud/projects/{pid}", headers=h).json()["data"]["boards"][0]["id"]
        == "arduino-uno"
    )
    assert client.put(
        f"/api/cloud/projects/{pid}", json={"name": "v2"}, headers=h
    ).json()["ok"]
    assert client.get(f"/api/cloud/projects/{pid}", headers=h).json()["name"] == "v2"

    # another user sees nothing
    h2 = {"Authorization": f"Bearer {_register(client, email='b@b.cn', password='secret2')}"}
    assert client.get(f"/api/cloud/projects/{pid}", headers=h2).status_code == 404
    assert client.get("/api/cloud/projects", headers=h2).json()["projects"] == []

    assert client.delete(f"/api/cloud/projects/{pid}", headers=h).json()["ok"]
    assert client.get(f"/api/cloud/projects/{pid}", headers=h).status_code == 404


def test_chat_upsert_flow(client):
    h = {"Authorization": f"Bearer {_register(client)}"}
    cid = client.post(
        "/api/cloud/chats",
        json={"title": "对话1", "messages": [{"id": "m1"}], "api_messages": []},
        headers=h,
    ).json()["id"]
    # update in place keeps the id
    assert (
        client.post(
            "/api/cloud/chats",
            json={
                "id": cid,
                "title": "对话1改",
                "messages": [{"id": "m1"}, {"id": "m2"}],
                "api_messages": [{"role": "user"}],
            },
            headers=h,
        ).json()["id"]
        == cid
    )
    full = client.get(f"/api/cloud/chats/{cid}", headers=h).json()
    assert full["title"] == "对话1改" and len(full["messages"]) == 2
    # unknown id → 404 (client falls back to create)
    assert client.post(
        "/api/cloud/chats", json={"id": "nope", "title": "x"}, headers=h
    ).status_code == 404
    assert client.delete(f"/api/cloud/chats/{cid}", headers=h).json()["ok"]
