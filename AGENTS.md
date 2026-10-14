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
| `PORT` | `3100` | Server port |
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
| `server.js` | `/api/health` | 探活：`{ok,service,version,uptime}`（在 server.js 内联，不单独建文件） |

## 服务导航（黄页）
- 数据源：`public/nav.json`（静态文件，路由不参与）——**改导航只改这个 JSON**，不必改代码
- 渲染：`public/app.js` 的 `renderNavApp()`；`switchApp('nav')` 是初始化默认应用
- 样式：`public/style.css` 尾部「服务导航（黄页）模块」段
- 部署：zmain 上由 systemd `zdashboard.service`（127.0.0.1:3100）+ nginx 18100 反代对外

## Frontend Quirks
- Dual layout: portrait (`#scroller`) and landscape (`#landscape`) both exist in DOM, CSS toggles `display` via `@media (orientation: ...)`
- Many UI items (Projects, Tools) are hardcoded HTML, not data-driven
- Vocab app is the only functional tool; others are static placeholders
- 服务导航（黄页）是唯一由数据文件驱动的模块（`public/nav.json`），且是默认落地应用（`switchApp('nav')`）
- 音频播放是遗留半成品：无文件流路由，且 `/ws` 的 `play` 载荷形状与前端不一致（v0.2.0 计划删除音频模块）

## Deploy
- Production: `bash deploy/build_run.sh` produces a self-contained `zbuild/zdashboard.run` binary (uses Docker + c2r)
- zmain 本机（当前实际部署）：systemd `zdashboard.service` → `127.0.0.1:3100`，nginx **18100** 反代给 LAN
  - `DB_PATH=/home/tony/zdata/zdb.db`（权威库）、`AUDIO_DIR=/home/tony/zdata/zdashboard/audio`
  - ExecStart 用 pnpm 的 node（`/home/tony/.local/share/pnpm/bin/node`，系统 `/usr/bin/node` 是 20.x，与已编译的 better-sqlite3 绑定 ABI 不符）
