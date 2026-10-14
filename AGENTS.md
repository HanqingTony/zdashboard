# AGENTS.md — zdashboard

## Tech Stack
- Backend: Node.js (ESM `"type": "module"`), Express 4.x, better-sqlite3, ws
- Frontend: single-file SPA at `public/index.html`, no build step, no bundler
- No tests, no lint, no typecheck configuration exists

## Commands
```bash
npm start          # node server.js
npm run dev        # node --watch server.js (auto-restart on changes)
```

## Environment Variables
Config is in `src/config.js` using `process.env.*` with defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `28100` | Server port（生产；回环上游，配对对外 18100） |
| `HOST` | `127.0.0.1` | Bind address |
| `DB_PATH` | `./zdb.db` | SQLite database path |
| `AUDIO_DIR` | `./audio/` | Audio files directory |

For `.run` deployment, the deploy script uses different env names: `ZDB_PATH`, `ZAUDIO_DIR`, `ZDASHBOARD_PORT`.

## Database Conventions
- SQLite with WAL mode, `wal_autocheckpoint = 100`
- **Critical convention**: After every write transaction (insert/update/delete), code explicitly calls `db.pragma('wal_checkpoint(TRUNCATE)')`. This ensures the WAL is merged into the main `.db` file immediately — required for single-file bind mounts where `-wal`/`-shm` are not mapped to the host. Follow this pattern for all new write operations.
- Auto-create on first write (zVocab, zArticles are static tables — no migration system).

## Server Architecture
- Entry: `server.js` — sets up Express + WebSocket server on same HTTP port
- WebSocket: `/ws` broadcasts `play`/`status` events for the audio queue
- Graceful shutdown: `SIGINT`/`SIGTERM` → WAL checkpoint → close DB → exit
- `audioState` (queue, isPlaying, currentFile) is a mutable object shared between the audio router and server.js via import

## Routes
| File | Prefix | Purpose |
|------|--------|---------|
| `src/routes/audio.js` | `/api/audio`, `/api/play`, `/api/skip`, `/api/clear` | Audio file browser + playback queue |
| `src/routes/articles.js` | `/api/articles` | Article CRUD with word extraction |
| `src/routes/vocab.js` | `/api/words`, `/api/vocab/stats` | Word learning status management |
| `src/routes/agg.js` | `/api/agg`, `/api/agg/refresh` | 信息聚合：读缓存 / 跑探针（每源独立失败隔离） |
| `server.js` | `/api/health` | 探活：`{ok,service,version,uptime}`（在 server.js 内联，不单独建文件） |

## 信息聚合
- 每源一段探针逻辑：`src/agg/sources.js`（HF 组织最新模型 / civarchive 按底模筛 LoRA）；加源 = 加一条 `SOURCES` 条目
- 落库与「新」判定：`src/agg/store.js`（`agg_item` 表：`first_seen == last_seen` 即「新」）；写完 `wal_checkpoint(TRUNCATE)`
- 路由：`src/routes/agg.js`（TTL 30 分钟、同源并发去重、失败只影响自己）
- 网络约定：**只走直连**（`civarchive.com`、`hf-mirror.com` 实测直连可用；`huggingface.co`/`civitai.com` 直连不通）→ 单元无需代理环境变量
- 前端：`public/app.js` 的 `renderAggApp()` / `refreshAgg()`；Tools 角标 `#badgeAgg(L)` 显示新条目数

## 服务导航（黄页）
- 数据源：`public/nav.json`（静态文件，路由不参与）——**改导航只改这个 JSON**，不必改代码
- 渲染：`public/app.js` 的 `renderNavApp()`；`switchApp('nav')` 是初始化默认应用
- 样式：`public/style.css` 尾部「服务导航（黄页）模块」段
- 部署：zmain 上由 systemd `zdashboard.service`（`127.0.0.1:28100`）+ nginx **18100** 反代对外

## Frontend Quirks
- Dual layout: portrait (`#scroller`) and landscape (`#landscape`) both exist in DOM, CSS toggles `display` via `@media (orientation: ...)`
- Many UI items (Projects, Tools) are hardcoded HTML, not data-driven
- Vocab app is the only functional tool; others are static placeholders
- 服务导航（黄页）是唯一由数据文件驱动的模块（`public/nav.json`），且是默认落地应用（`switchApp('nav')`）
- 黄页卡片字段：`name`/`url`/`desc`/`port`（**对外入口，181xx**）/`upstream`（**回环上游，28xxx**）/`tags`；端口规范见 zpa 仓库 `PORTS.md`
- 上游端口只绑 `127.0.0.1`（生产由 systemd 设 `PORT=28100`），对外一律经 nginx 18100 —— **新增服务三处同步：nginx conf / `nav.json` / anm facts「nginx」**
- 音频播放是遗留半成品：无文件流路由，且 `/ws` 的 `play` 载荷形状与前端不一致（v0.2.0 计划删除音频模块）

## Deploy
- Production: `bash deploy/build_run.sh` produces a self-contained `zbuild/zdashboard.run` binary (uses Docker + c2r)
- zmain 本机（当前实际部署）：systemd `zdashboard.service` → `127.0.0.1:28100`，nginx **18100** 反代给 LAN
  - `PORT=28100`（回环上游，配对对外 18100）、`DB_PATH=/home/tony/zdata/zdb.db`（权威库）、`AUDIO_DIR=/home/tony/zdata/zdashboard/audio`
  - ExecStart 用 pnpm 的 node（`/home/tony/.local/share/pnpm/bin/node`，系统 `/usr/bin/node` 是 20.x，与已编译的 better-sqlite3 绑定 ABI 不符）
