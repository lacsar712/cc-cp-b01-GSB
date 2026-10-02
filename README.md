# 冷链探头超温台

记录员上报探头编号与摄氏温度，后台工人用数据库行锁认领待处理队列，按 **8℃** 上限判定 **合格** 或 **超温**。

记录员还可给探头挂**对外别名**：顶栏「别名墙」落地页左侧维护代号与别名、右侧展示**卡片墙**、下方挂**改名流水**。卡片墙与读数列表接口同库 JOIN 别名，由服务端统一给出 `display_name`（有别名显示别名、无别名回显代号），浏览器不私下换字。

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
| logger | log123456 | 记录员，可提交读数、增改删探头别名 |
| watcher | watch123456 | 值班员，只读：可看读数、卡片墙与改名流水，不能改别名 |

## 启动

```bash
cd projects/18-coldchain-probe-desk
docker compose up --build
```

健康检查：`GET http://localhost:8197/api/health` → `{"status":"ok","service":"coldchain-probe-desk"}`

## 接口（均需 Bearer 登录）

| 方法与路径 | 权限 | 说明 |
|------------|------|------|
| `GET /api/readings` | 登录即可 | 读数列表，LEFT JOIN 别名，返回 `alias` 与服务端计算的 `display_name` |
| `POST /api/readings` | 记录员 | 提交读数 |
| `GET /api/probe-cards` | 登录即可 | 卡片墙：每个探头最新一条读数 + 别名 + `display_name` + 读数条数 |
| `GET /api/aliases` | 登录即可 | 别名清单（代号 ↔ 别名） |
| `PUT /api/aliases` | 记录员 | 新增/改名别名，body `{"probe_id","alias"}`；与流水同事务，别名占用返回 409 |
| `DELETE /api/aliases/{probe_id}` | 记录员 | 删别名；删除与流水同事务，不存在返回 404 |
| `GET /api/alias-logs` | 登录即可 | 改名流水（create/rename/delete，含旧/新别名、操作人、时间） |

显示名只来自接口返回的 `display_name`，前端不做任何本地替换；别名增、改、删与流水写入在同一数据库事务内完成（冲突整体回滚）。

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
