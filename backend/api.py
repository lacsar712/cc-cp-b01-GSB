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


def require_writer(request: web.Request, action: str = "此操作") -> dict:
    user = require_user(request)
    if user["role"] != "writer":
        raise web.HTTPForbidden(
            text=json.dumps({"detail": f"仅记录员可{action}"}, ensure_ascii=False),
            content_type="application/json",
        )
    return user


READING_FIELDS = (
    "r.id, r.probe_id, a.alias, COALESCE(a.alias, r.probe_id) AS display_name, "
    "r.temp_c, r.verdict, r.reason, r.status, r.created_by, r.created_at, r.processed_at"
)


def reading_to_dict(r) -> dict:
    return {
        "id": r["id"],
        "probe_id": r["probe_id"],
        "alias": r["alias"],
        "display_name": r["display_name"],
        "temp_c": r["temp_c"],
        "verdict": r["verdict"],
        "reason": r["reason"],
        "status": r["status"],
        "created_by": r["created_by"],
        "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        "processed_at": r["processed_at"].isoformat() if r["processed_at"] else None,
    }


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


async def list_readings(request: web.Request) -> web.Response:
    require_user(request)
    pool: asyncpg.Pool = request.app["pool"]
    rows = await pool.fetch(
        f"""
        SELECT {READING_FIELDS}
        FROM probe_readings r
        LEFT JOIN probe_aliases a ON a.probe_id = r.probe_id
        ORDER BY r.id DESC
        """
    )
    return web.json_response([reading_to_dict(r) for r in rows])


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
    inserted = await pool.fetchrow(
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
        SELECT {READING_FIELDS}
        FROM probe_readings r
        LEFT JOIN probe_aliases a ON a.probe_id = r.probe_id
        WHERE r.id = $1
        """,
        inserted["id"],
    )
    payload = reading_to_dict(row)
    payload["message"] = "已入队，后台工人将认领并判定"
    return web.json_response(payload, status=201)


async def list_probes_with_alias(pool: asyncpg.Pool) -> list[dict]:
    rows = await pool.fetch(
        """
        SELECT p.probe_id, a.alias, a.updated_by, a.updated_at
        FROM (
            SELECT probe_id FROM probe_aliases
            UNION
            SELECT DISTINCT probe_id FROM probe_readings
        ) p
        LEFT JOIN probe_aliases a ON a.probe_id = p.probe_id
        ORDER BY a.updated_at DESC NULLS LAST, p.probe_id
        """
    )
    out = []
    for r in rows:
        out.append(
            {
                "probe_id": r["probe_id"],
                "alias": r["alias"],
                "display_name": r["alias"] or r["probe_id"],
                "updated_by": r["updated_by"],
                "updated_at": r["updated_at"].isoformat() if r["updated_at"] else None,
            }
        )
    return out


async def probe_wall(request: web.Request) -> web.Response:
    """卡片墙：每个探头一张卡，展示名与 /api/readings 同源同结果。"""
    require_user(request)
    pool: asyncpg.Pool = request.app["pool"]
    probes = await list_probes_with_alias(pool)
    latest_by_probe: dict[str, dict] = {}
    rows = await pool.fetch(
        f"""
        SELECT {READING_FIELDS}
        FROM probe_readings r
        LEFT JOIN probe_aliases a ON a.probe_id = r.probe_id
        ORDER BY r.id DESC
        """
    )
    readings = [reading_to_dict(r) for r in rows]
    for item in readings:
        latest_by_probe.setdefault(item["probe_id"], item)
    cards = []
    for probe in probes:
        latest = latest_by_probe.get(probe["probe_id"])
        cards.append({**probe, "latest": latest})
    return web.json_response(cards)


async def list_aliases(request: web.Request) -> web.Response:
    require_user(request)
    pool: asyncpg.Pool = request.app["pool"]
    return web.json_response(await list_probes_with_alias(pool))


async def upsert_alias(request: web.Request) -> web.Response:
    """记录员新增或修改别名，并写一条改名流水（同一事务）。"""
    user = require_writer(request, "维护别名")
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        raise web.HTTPBadRequest(text="invalid json") from exc
    probe_id = str(body.get("probe_id", "")).strip()
    alias = str(body.get("alias", "")).strip()
    if not probe_id:
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "探头代号不能为空"}, ensure_ascii=False),
            content_type="application/json",
        )
    if not alias:
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "别名不能为空"}, ensure_ascii=False),
            content_type="application/json",
        )

    pool: asyncpg.Pool = request.app["pool"]
    async with pool.acquire() as conn:
        try:
            async with conn.transaction():
                old = await conn.fetchrow(
                    "SELECT alias FROM probe_aliases WHERE probe_id = $1 FOR UPDATE",
                    probe_id,
                )
                old_alias = old["alias"] if old else None
                if old_alias == alias:
                    action = None
                else:
                    await conn.execute(
                        """
                        INSERT INTO probe_aliases (probe_id, alias, updated_by, updated_at)
                        VALUES ($1, $2, $3, now())
                        ON CONFLICT (probe_id)
                        DO UPDATE SET alias = $2, updated_by = $3, updated_at = now()
                        """,
                        probe_id,
                        alias,
                        user["username"],
                    )
                    action = "rename" if old_alias else "add"
                    await conn.execute(
                        """
                        INSERT INTO probe_alias_logs
                            (probe_id, action, old_alias, new_alias, operator, created_at)
                        VALUES ($1, $2, $3, $4, $5, now())
                        """,
                        probe_id,
                        action,
                        old_alias,
                        alias,
                        user["username"],
                    )
        except asyncpg.UniqueViolationError as exc:
            raise web.HTTPBadRequest(
                text=json.dumps({"detail": "该别名已被其他探头占用"}, ensure_ascii=False),
                content_type="application/json",
            ) from exc

    row = await pool.fetchrow(
        """
        SELECT probe_id, alias, updated_by, updated_at
        FROM probe_aliases
        WHERE probe_id = $1
        """,
        probe_id,
    )
    return web.json_response(
        {
            "probe_id": row["probe_id"],
            "alias": row["alias"],
            "display_name": row["alias"],
            "updated_by": row["updated_by"],
            "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
            "message": "别名已保存",
        },
        status=200,
    )


async def delete_alias(request: web.Request) -> web.Response:
    """记录员删除别名，删除与留痕必须同一事务：失败则一起回滚。"""
    user = require_writer(request, "维护别名")
    probe_id = str(request.match_info.get("probe_id", "")).strip()
    if not probe_id:
        raise web.HTTPBadRequest(
            text=json.dumps({"detail": "探头代号不能为空"}, ensure_ascii=False),
            content_type="application/json",
        )

    pool: asyncpg.Pool = request.app["pool"]
    async with pool.acquire() as conn:
        async with conn.transaction():
            old = await conn.fetchrow(
                "SELECT alias FROM probe_aliases WHERE probe_id = $1 FOR UPDATE",
                probe_id,
            )
            if not old:
                raise web.HTTPNotFound(
                    text=json.dumps({"detail": "该探头未设置别名"}, ensure_ascii=False),
                    content_type="application/json",
                )
            await conn.execute("DELETE FROM probe_aliases WHERE probe_id = $1", probe_id)
            await conn.execute(
                """
                INSERT INTO probe_alias_logs
                    (probe_id, action, old_alias, new_alias, operator, created_at)
                VALUES ($1, 'remove', $2, NULL, $3, now())
                """,
                probe_id,
                old["alias"],
                user["username"],
            )
    return web.json_response(
        {"probe_id": probe_id, "display_name": probe_id, "message": "别名已删除，卡片回显代号"}
    )


async def list_alias_logs(request: web.Request) -> web.Response:
    require_user(request)
    pool: asyncpg.Pool = request.app["pool"]
    rows = await pool.fetch(
        """
        SELECT id, probe_id, action, old_alias, new_alias, operator, created_at
        FROM probe_alias_logs
        ORDER BY id DESC
        """
    )
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "probe_id": r["probe_id"],
                "action": r["action"],
                "old_alias": r["old_alias"],
                "new_alias": r["new_alias"],
                "operator": r["operator"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            }
        )
    return web.json_response(out)


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
    app.router.add_get("/api/probes/wall", probe_wall)
    app.router.add_get("/api/probes/aliases", list_aliases)
    app.router.add_post("/api/probes/aliases", upsert_alias)
    app.router.add_delete("/api/probes/{probe_id}/alias", delete_alias)
    app.router.add_get("/api/probes/alias-logs", list_alias_logs)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host="0.0.0.0", port=8000)
