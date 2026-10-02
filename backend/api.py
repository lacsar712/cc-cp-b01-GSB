import json
import os
from datetime import datetime, timedelta, timezone

import asyncpg
import jwt
from aiohttp import web
from passlib.context import CryptContext

from db import create_pool, ensure_schema_async, seed_if_empty
from rules import judge_temp

SECRET = os.environ.get("JWT_SECRET", "coldchain-probe-dev-secret")
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

USERS = {
    "logger": {"role": "writer", "password_hash": pwd.hash("log123456")},
    "watcher": {"role": "reader", "password_hash": pwd.hash("watch123456")},
}


def _auth_header(request: web.Request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None


def _decode_user(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        return None
    sub = payload.get("sub")
    if sub not in USERS:
        return None
    return {"username": sub, "role": payload.get("role")}


def require_user(request: web.Request) -> dict:
    user = _decode_user(_auth_header(request))
    if not user:
        raise web.HTTPUnauthorized(text=json.dumps({"detail": "未登录"}, ensure_ascii=False), content_type="application/json")
    return user


def require_writer(request: web.Request, detail: str = "仅记录员可执行此操作") -> dict:
    user = require_user(request)
    if user["role"] != "writer":
        raise web.HTTPForbidden(
            text=json.dumps({"detail": detail}, ensure_ascii=False),
            content_type="application/json",
        )
    return user


def json_error(status: int, detail: str) -> web.HTTPException:
    cls = {
        400: web.HTTPBadRequest,
        404: web.HTTPNotFound,
        409: web.HTTPConflict,
    }[status]
    return cls(
        text=json.dumps({"detail": detail}, ensure_ascii=False),
        content_type="application/json",
    )


async def health(_request: web.Request) -> web.Response:
    return web.json_response({"status": "ok", "service": "coldchain-probe-desk"})


async def login(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        raise web.HTTPBadRequest(text="invalid json") from exc
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    user = USERS.get(username)
    if not user or not pwd.verify(password, user["password_hash"]):
        raise web.HTTPUnauthorized(
            text=json.dumps({"detail": "用户名或密码错误"}, ensure_ascii=False),
            content_type="application/json",
        )
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode(
        {"sub": username, "role": user["role"], "exp": exp},
        SECRET,
        algorithm="HS256",
    )
    return web.json_response(
        {"access_token": token, "username": username, "role": user["role"]}
    )


READING_COLUMNS = """
    r.id, r.probe_id, a.alias, r.temp_c, r.verdict, r.reason,
    r.status, r.created_by, r.created_at, r.processed_at
"""


def reading_payload(r) -> dict:
    alias = r["alias"]
    probe_id = r["probe_id"]
    return {
        "id": r["id"],
        "probe_id": probe_id,
        "alias": alias,
        "display_name": alias or probe_id,
        "temp_c": r["temp_c"],
        "verdict": r["verdict"],
        "reason": r["reason"],
        "status": r["status"],
        "created_by": r["created_by"],
        "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        "processed_at": r["processed_at"].isoformat() if r["processed_at"] else None,
    }


async def list_readings(request: web.Request) -> web.Response:
    require_user(request)
    pool: asyncpg.Pool = request.app["pool"]
    rows = await pool.fetch(
        f"""
        SELECT {READING_COLUMNS}
        FROM probe_readings r
        LEFT JOIN probe_aliases a ON a.probe_id = r.probe_id
        ORDER BY r.id DESC
        """
    )
    return web.json_response([reading_payload(r) for r in rows])


async def create_reading(request: web.Request) -> web.Response:
    user = require_writer(request)
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        raise web.HTTPBadRequest(text="invalid json") from exc
    probe_id = str(body.get("probe_id", "")).strip()
    if not probe_id:
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "探头编号不能为空"}, ensure_ascii=False),
            content_type="application/json",
        )
    try:
        temp_c = float(body.get("temp_c"))
    except (TypeError, ValueError) as exc:
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "温度必须是数字"}, ensure_ascii=False),
            content_type="application/json",
        ) from exc

    pool: asyncpg.Pool = request.app["pool"]
    reading_id = await pool.fetchval(
        """
        INSERT INTO probe_readings (probe_id, temp_c, status, created_by, created_at)
        VALUES ($1, $2, 'pending', $3, now())
        RETURNING id
        """,
        probe_id,
        temp_c,
        user["username"],
    )
    row = await pool.fetchrow(
        f"""
        SELECT {READING_COLUMNS}
        FROM probe_readings r
        LEFT JOIN probe_aliases a ON a.probe_id = r.probe_id
        WHERE r.id = $1
        """,
        reading_id,
    )
    payload = reading_payload(row)
    payload["message"] = "已入队，后台工人将认领并判定"
    return web.json_response(payload, status=201)


async def list_aliases(request: web.Request) -> web.Response:
    require_user(request)
    pool: asyncpg.Pool = request.app["pool"]
    rows = await pool.fetch(
        """
        SELECT probe_id, alias, created_by, created_at, updated_at
        FROM probe_aliases
        ORDER BY probe_id
        """
    )
    return web.json_response(
        [
            {
                "probe_id": r["probe_id"],
                "alias": r["alias"],
                "created_by": r["created_by"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
            }
            for r in rows
        ]
    )


async def list_alias_logs(request: web.Request) -> web.Response:
    require_user(request)
    pool: asyncpg.Pool = request.app["pool"]
    rows = await pool.fetch(
        """
        SELECT id, probe_id, action, old_alias, new_alias, operator, created_at
        FROM probe_alias_log
        ORDER BY id DESC
        LIMIT 200
        """
    )
    return web.json_response(
        [
            {
                "id": r["id"],
                "probe_id": r["probe_id"],
                "action": r["action"],
                "old_alias": r["old_alias"],
                "new_alias": r["new_alias"],
                "operator": r["operator"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            }
            for r in rows
        ]
    )


async def list_probe_cards(request: web.Request) -> web.Response:
    """卡片墙：与列表接口同库同源 JOIN 别名，服务端决定显示名，浏览器不私下换字。"""
    require_user(request)
    pool: asyncpg.Pool = request.app["pool"]
    rows = await pool.fetch(
        """
        SELECT DISTINCT ON (r.probe_id)
            r.probe_id, a.alias, r.temp_c, r.verdict, r.reason,
            r.status, r.created_at, r.processed_at,
            COUNT(*) OVER (PARTITION BY r.probe_id)::int AS reading_count
        FROM probe_readings r
        LEFT JOIN probe_aliases a ON a.probe_id = r.probe_id
        ORDER BY r.probe_id, r.id DESC
        """
    )
    cards = []
    for r in rows:
        alias = r["alias"]
        cards.append(
            {
                "probe_id": r["probe_id"],
                "alias": alias,
                "display_name": alias or r["probe_id"],
                "temp_c": r["temp_c"],
                "verdict": r["verdict"],
                "reason": r["reason"],
                "status": r["status"],
                "reading_count": r["reading_count"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "processed_at": r["processed_at"].isoformat() if r["processed_at"] else None,
            }
        )
    return web.json_response(cards)


async def put_alias(request: web.Request) -> web.Response:
    """记录员新增或改名别名；别名写入与流水同一事务。"""
    user = require_writer(request, "仅记录员可维护探头别名")
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        raise web.HTTPBadRequest(text="invalid json") from exc
    probe_id = str(body.get("probe_id", "")).strip()
    alias = str(body.get("alias", "")).strip()
    if not probe_id:
        raise json_error(400, "探头代号不能为空")
    if not alias:
        raise json_error(400, "别名不能为空")

    pool: asyncpg.Pool = request.app["pool"]
    async with pool.acquire() as conn:
        async with conn.transaction():
            old = await conn.fetchrow(
                "SELECT alias FROM probe_aliases WHERE probe_id = $1 FOR UPDATE",
                probe_id,
            )
            old_alias = old["alias"] if old else None
            if old_alias == alias:
                action = "noop"
            elif old_alias is None:
                action = "create"
            else:
                action = "rename"
            try:
                await conn.execute(
                    """
                    INSERT INTO probe_aliases (probe_id, alias, created_by, created_at, updated_at)
                    VALUES ($1, $2, $3, now(), now())
                    ON CONFLICT (probe_id) DO UPDATE
                    SET alias = $2, updated_at = now()
                    """,
                    probe_id,
                    alias,
                    user["username"],
                )
            except asyncpg.UniqueViolationError as exc:
                raise json_error(409, "该别名已被其他探头占用") from exc
            if action != "noop":
                await conn.execute(
                    """
                    INSERT INTO probe_alias_log
                        (probe_id, action, old_alias, new_alias, operator, created_at)
                    VALUES ($1, $2, $3, $4, $5, now())
                    """,
                    probe_id,
                    action,
                    old_alias,
                    alias,
                    user["username"],
                )

    status = 201 if action == "create" else 200
    return web.json_response(
        {"probe_id": probe_id, "alias": alias, "action": action}, status=status
    )


async def delete_alias(request: web.Request) -> web.Response:
    """记录员删别名；删除别名与流水同一事务，流水留下痕迹。"""
    user = require_writer(request, "仅记录员可维护探头别名")
    probe_id = request.match_info["probe_id"].strip()
    pool: asyncpg.Pool = request.app["pool"]
    async with pool.acquire() as conn:
        async with conn.transaction():
            old = await conn.fetchrow(
                "SELECT alias FROM probe_aliases WHERE probe_id = $1 FOR UPDATE",
                probe_id,
            )
            if not old:
                raise json_error(404, "该探头没有别名")
            await conn.execute("DELETE FROM probe_aliases WHERE probe_id = $1", probe_id)
            await conn.execute(
                """
                INSERT INTO probe_alias_log
                    (probe_id, action, old_alias, new_alias, operator, created_at)
                VALUES ($1, 'delete', $2, NULL, $3, now())
                """,
                probe_id,
                old["alias"],
                user["username"],
            )
    return web.json_response(
        {"probe_id": probe_id, "action": "delete", "message": "别名已删除，卡片回显代号"}
    )


async def on_startup(app: web.Application) -> None:
    pool = await create_pool()
    app["pool"] = pool
    await ensure_schema_async(pool)
    await seed_if_empty(pool)


async def on_cleanup(app: web.Application) -> None:
    pool: asyncpg.Pool = app.get("pool")
    if pool:
        await pool.close()


def create_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/api/health", health)
    app.router.add_post("/api/auth/login", login)
    app.router.add_get("/api/readings", list_readings)
    app.router.add_post("/api/readings", create_reading)
    app.router.add_get("/api/aliases", list_aliases)
    app.router.add_put("/api/aliases", put_alias)
    app.router.add_delete("/api/aliases/{probe_id}", delete_alias)
    app.router.add_get("/api/alias-logs", list_alias_logs)
    app.router.add_get("/api/probe-cards", list_probe_cards)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host="0.0.0.0", port=8000)
