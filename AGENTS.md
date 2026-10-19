# AGENTS.md — zdashboard

## Tech Stack
- Backend: Node.js 22（ESM `"type": "module"`）、Express 4.x、better-sqlite3、undici、fast-xml-parser
- Frontend: `public/index.html` + ES modules（`app.js` 入口 / `core.js` 外壳 / `vocab|nav|agg|projects.js` 模块）+ `tokenize.js` / `projects-meta.js`（前后端共用）
- Tests: `node:test`（`npm test`，内存库，不碰生产数据）

## Commands
```bash
npm start          # node server.js
npm run dev        # node --env-file-if-exists=.env --watch server.js
npm test           # node --test（27 用例，内存库）
npm run seed       # 手动重新生成 src/projects/seed.json（可选；导入不再依赖它）
npm run backup     # SQLite 在线备份（db.backup + 保留 N 份）
npm run archive-legacy -- --drop   # 历史表归档后删除（默认只归档）
```

## Environment Variables
Config 在 `src/config.js`，**没有 config.json**（README 旧版写错，已修正）：

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | 监听端口（`ZDASHBOARD_PORT` 是 .run/compose 时代的兼容别名） |
| `HOST` | `127.0.0.1` | Bind address |
| `DB_PATH` | `./zdb.db` | SQLite database path（生产 `/home/tony/zdata/zdb.db`） |
| `CHECKPOINT` | `throttle` | WAL 策略：`always` / `throttle` / `off`；容器用 `always` |
| `AUTH_TOKEN` | 空 | 可选写保护；设置后除 `/api/health` 外的 `/api/*` 需 `X-ZToken` 或 Bearer |
| `ZPA_DIR` | `/home/tony/zrepo/zpa` | 项目清单事实源 |
| `ZREPO_DIR` | `/home/tony/zrepo` | 仓库根目录（猜 `repo_path`） |
| `AGG_PROXY` | `http://127.0.0.1:12809` | 出境源代理 |
| `ALLOWED_HOSTS` | 空 | 可选 Host 白名单（防 DNS rebinding，默认关闭） |
| `BACKUP_DIR` | `<DB 目录>/backup/zdashboard` | 备份输出目录 |
| `BACKUP_KEEP` | `7` | 备份保留份数 |

`.run` 部署的历史变量名：`ZDB_PATH`（compose 宿主机路径插值）、`ZDASHBOARD_PORT`（宿主机端口）；容器内部仍用 `DB_PATH`。`AUDIO_DIR` 已随音频模块删除。

## Database Conventions
- **迁移**：只用 `src/migrations.js`（`PRAGMA user_version`）；新增表/字段加一条 `MIGRATIONS`，不要在 store 里散落 DDL
- SQLite WAL、`wal_autocheckpoint = 100`、`busy_timeout = 5000`
- **每次写事务后调用 `checkpoint()`（`src/db.js`），不要直接写 `db.pragma('wal_checkpoint(...)')`**
  - `throttle`（本机默认）：写后 500ms 合并，避免每次点词都 fsync
  - `always`（容器/单文件 bind-mount）：每次写立刻 TRUNCATE
  - 关机 `flushCheckpoint()` 强制落盘；`busy=1` 会 warn
- 时间统一 ISO 8601 UTC（`src/lib/time.js` 的 `nowIso()`）；不要混用 SQLite `localtime`
- 历史表 `zInfra` / `zObjects` 已归档到 `BACKUP_DIR/legacy/` 并从主库删除（`scripts/archive-legacy.js`）

## Server Architecture
- 入口 `server.js`：创建 HTTP server、启动/优雅关闭（SIGINT/SIGTERM → close → flush → db.close）
- `src/app.js`：`createApp()` 装配 Express（测试直接 import，不监听端口）
  - `/` 注入 `?v=<version>` 到 `app.js` / `style.css`（部署后缓存自动失效）
  - JS/CSS 用 `Cache-Control: no-cache` 重校验（ES module import 不带版本号）；其它静态 1h；`/index.html` 301 → `/`
  - 统一 JSON 错误处理（坏 JSON / URIError / async 抛错）；生产 500 不回传内部错误文本
  - 可选 `AUTH_TOKEN`（health 免鉴权），鉴权在 body 解析之前；`ALLOWED_HOSTS` 可选 Host 白名单
  - `/api` 限流 180 次/分钟/IP；CSP / X-Frame-Options / nosniff / no-referrer 安全头
- 音频模块与 WebSocket 已于 v0.2.0 删除（`docs/DESIGN.md` 的决议）

## Routes
| File | Prefix | Purpose |
|------|--------|---------|
| `src/routes/articles.js` | `/api/articles` | 文章 CRUD；分词入库；删除后清理孤立词 |
| `src/routes/vocab.js` | `/api/words`, `/api/vocab/stats` | 单词状态与统计 |
| `src/routes/agg.js` | `/api/agg`, `/api/agg/refresh`, `/api/agg/open` | 信息聚合：快照 / 探针 / 已读水位 |
| `src/routes/projects.js` | `/api/projects[/import,/sync,/:id]` | 项目台账：CRUD + 清单导入 + 异步 git |
| `src/app.js` | `/api/health` | 探活 `{ok,service,version,uptime}` |

所有路由的错误响应统一 `{error}`；参数/枚举校验在 `src/projects/store.js`。

## 信息聚合
- 每源一段探针：`src/agg/sources.js`；加源 = 加一条 `SOURCES` 条目
- 落库/已读/退避/保留：`src/agg/store.js`
  - **「新」= 未读**：`agg_item.first_seen >= agg_state.opened_at`（不要回到 `first_seen == last_seen` 的旧语义）
  - 离开聚合页时前端 `POST /api/agg/open {all:true}` 打水位 → Tools 角标清零
  - `last_ok_at` 与 `fetched_at` 分开：stale 基于上次成功；失败按 `fail_count` 指数退避
  - 保留：热榜类每源最近 200 条（按 `last_seen`）；其余源 90 天；**任何刷新后最多每小时清理一次**
  - 每日榜/热搜的 `item_id` 带日期（同话题隔天再上榜会重新提醒）
- 路由：TTL 30 分钟、同源并发去重、全量刷新并发上限 4、`force=1` 强制
- 版本探针的本地 `git describe` 用异步 `execFile`，禁止再用 `execFileSync` 阻塞事件循环
- 前端每 5 分钟拉未读；`pagehide`/`visibilitychange` 用 keepalive 打已读水位
- 网络：国内平台与 hf-mirror/civarchive 只走直连；出境源声明 `proxyMode`：`'on'` 必走代理 / `'auto'` 先直连失败再代理，不依赖系统代理 env
- **代理坑**：Node 内置 `fetch` 与外装 `undici` 版本不同，混用 dispatcher 会报 `fetch failed / invalid onRequestStart method` → 代理请求必须用 `undici` 自带的 `fetch`
- 凭据只放 `/home/tony/zdata/zdashboard/agg.env`（600，不进仓库），单元用 `EnvironmentFile=-` 读；缺变量为 `unconfigured`

## 项目台账
- 事实源是 zpa 清单（`PROJECTS.md`/`IDEAS-RANKING.md`/`PORTFOLIO.md`）
- `fromMarkdown.js` 导出 `buildSeed()`：**进程内解析**，不再 spawn `node`、不再重写 seed.json；表格列数不足带文件名+行号报错
- `/api/projects/import` 按 `name` 幂等 upsert；操作字段（status/layer/next_step/note/risk/verdict）**不覆盖**，其余清单字段以 seed 为准
- `/api/projects/sync`：异步 + 并发 4，每仓库 3 次 git 调用（`status --porcelain=v2 --branch`、`log -1`、`remote -v`）
- 想法判决 `verdict`：alive/parked/killed（Tools 角标 = 待判想法数）

## 服务导航（黄页）
- 数据源：`public/nav.json`（静态文件）——**改导航只改这个 JSON**
- 渲染：`public/app.js` 的 `renderNavApp()`；默认落地应用 `switchApp('nav')`
- 卡片端口：`port`（对外 181xx）/ `upstream`（回环 28xxx）
- 新增服务三处同步：nginx conf / `nav.json` / anm facts「nginx」

## Frontend Quirks
- `public/app.js` 是启动入口（**ES module**）；各模块各自 `registerApp()` 并 `Object.assign(window, {...})` 暴露 inline onclick 函数
- `core.js` 提供 `apiFetch / escHtml / safeUrl / getActiveScreen / layout / isActive / registerApp / 状态栏 helpers`；不要反向 import 具体模块
- 竖屏/横屏两块屏都在 DOM 里；`layout()` 在跨 768px 断点时**重渲染当前应用**（修复旋转后空白）
- 顶栏台账/未读/版本是真实数据（`setStat`）；侧栏项目列表来自 `/api/projects`（前 5 条）
- 侧栏 Projects/Tools 由 `renderPanels()` 从 `APPS` 配置生成（不再两份硬编码）
- `escHtml()` 转义 `& < > " '`；外链一律走 `safeUrl()`（只放行 http(s)/站内路径）
- 分词必须用 `public/tokenize.js`（`tokenize` / `wordCounts`），不要在任一端另写正则；URL/邮箱/代码块已被自动排除
- 台账枚举必须从 `public/projects-meta.js` 取（前后端共用）；存储用 code（`active` / `l0`），展示用 `statusLabel()/layerLabel()`
- 前端模块通过 `registerApp(id, { render, onLeave? })` 注册；新页面加一个模块并在 `app.js` import
- 文章按 12000 token 分段渲染（`renderNextChunk()`）；新增渲染逻辑不要绕过这个上限
- 词状态渲染只允许 `mastered/familiar`，其余按 `unknown`（防 class 注入）
- 聚合页先渲染缓存，再逐源增量刷新（并发 3、单卡回填）；`refreshAgg(id)` 单源、`refreshAgg()` 全量
- 每 5 分钟轮询未读；离开聚合页 / `pagehide` / 页面隐藏时打已读水位（keepalive）
- Vocab 文章按 12000 token 分段渲染（`renderNextChunk`），不要一次性 innerHTML 整篇
- Vocab 是唯一有完整交互的工具；Diary/Finance/Reminders/Data Browser 保持硬编码占位

## Deploy
- 生产：zmain 上 systemd `zdashboard.service`（单元模板在 `deploy/`，含最小权限 hardening）→ `127.0.0.1:28100`，nginx **18100** 反代
- 备份：`deploy/zdashboard-backup.service/.timer`（每天 04:00，保留 7 份到 `/home/tony/zdata/backup/zdashboard`）
- 生产 unit 从 `deploy/zdashboard.service` 安装；含 `ProtectHome=read-only` + `ReadWritePaths=/home/tony/zdata`，git 调用统一 `GIT_OPTIONAL_LOCKS=0`
  - `PORT=28100`、`DB_PATH=/home/tony/zdata/zdb.db`、`CHECKPOINT=throttle`
  - ExecStart 用 pnpm 的 node（系统 node 的 ABI 可能与已编译 better-sqlite3 不符）
- `.run`：`bash deploy/build_run.sh`（Docker + c2r）；compose 设 `CHECKPOINT=always`
- 改动后必须重启 systemd 服务才生效（生产直接跑仓库代码）
- 发布前跑 `npm test`；CI 在 `.github/workflows/test.yml`
- 提交/推送用 `git push origin main`（origin 配了 GitHub + Gitee 两条 pushurl）
