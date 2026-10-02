# 冷链探头超温台

记录员上报探头编号与摄氏温度，后台工人用数据库行锁认领待处理队列，按 **8℃** 上限判定 **合格** 或 **超温**。

探头可挂**对外别名**：顶栏「别名墙」落地页左侧维护代号与别名、右侧卡片墙展示、下挂改名流水。卡片墙与读数列表的展示名均由接口在数据库端 JOIN 解析，前端不做任何私下换字。


## 技术栈

| 层 | 选型 |
|----|------|
| 接口 | Python aiohttp + asyncpg |
| 工人 | `worker.py`（psycopg，`FOR UPDATE SKIP LOCKED`） |
| 页面 | Preact + Vite，nginx 反代 `/api` |
| 数据库 | PostgreSQL 16 |

## 端口

| 服务 | 地址 |
|------|------|
| 页面 | http://localhost:3197 |
| 接口 | http://localhost:8197 |
| PostgreSQL | localhost:54397（库名 `coldchain`） |

## 账号

| 用户 | 密码 | 权限 |
|------|------|------|
| logger | log123456 | 记录员，可提交读数、增改删别名 |
| watcher | watch123456 | 值班员，只读：读数列表、卡片墙、改名流水 |

## 别名与卡片墙

- `GET /api/probes/wall`：卡片墙，每探头一张卡（`probe_id`、`alias`、`display_name`、最近一条读数）
- `GET /api/probes/aliases`：代号与别名列表
- `POST /api/probes/aliases`：记录员新增/改名（同代号重复提交即改名），与流水同事务
- `DELETE /api/probes/{probe_id}/alias`：记录员删除别名，删除与流水同事务；删后 `display_name` 回显代号
- `GET /api/probes/alias-logs`：改名流水（add / rename / remove，含旧、新别名与操作人）
- `GET /api/readings` 每条读数带 `alias` 与 `display_name`（`COALESCE(别名, 代号)`），与卡片墙同源

别名全局唯一；空代号、空别名返回 400；值班员写/删返回 403。

## 启动

```bash
cd projects/18-coldchain-probe-desk
docker compose up --build
```

健康检查：`GET http://localhost:8197/api/health` → `{"status":"ok","service":"coldchain-probe-desk"}`

## 种子数据

| 探头 | 温度 | 结论 |
|------|------|------|
| 探头A01 | 4.2℃ | 合格 |
| 探头B02 | 12.5℃ | 超温 |

## 本地开发（可选）

```bash
# 需本机 PostgreSQL 或仅起 db 容器
cd backend && pip install -r requirements.txt && python api.py
cd backend && python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8197**。
