# zdashboard

> **当前版本：v0.4.4** · [v0.4.4 更新记录](docs/v0.4.4.md) · [v0.4.3 更新记录](docs/v0.4.3.md) · [v0.4.2 更新记录](docs/v0.4.2.md) · [v0.4.1 更新记录](docs/v0.4.1.md) · [v0.4.0 更新记录](docs/v0.4.0.md) · [v0.3.0 更新记录](docs/v0.3.0.md) · [v0.2.2 更新记录](docs/v0.2.2.md) · [v0.2.1 更新记录](docs/v0.2.1.md) · [v0.2.0 更新记录](docs/v0.2.0.md) · [路线图](docs/ROADMAP.md) · 历史版本：[v0.1.7](docs/v0.1.7.md) · [v0.1.6](docs/v0.1.6.md) · [v0.1.5](docs/v0.1.5.md) · [v0.1.4](docs/v0.1.4.md) · [v0.1.3](docs/v0.1.3.md) · [v0.1.2](docs/v0.1.2.md) · [v0.1.1](docs/v0.1.1.md) · [v0.1.0](docs/v0.1.0.md)

个人多功能仪表盘：深色主题、横竖屏自适应、**无构建步骤**的单页前端（`public/app.js` 为 ES module，`public/tokenize.js` 前后端共用）。

## 功能模块

### 服务导航（黄页）

打开 `https://<host>:18100/` 的默认落地页。

- **内容全部在 `public/nav.json`**：标题/分组/卡片/底部说明；增删服务只改 JSON
- 卡片字段：`name` / `url` / `desc` / `port`（对外入口 181xx）/ `upstream`（回环上游 28xxx）/ `tags`
- 渲染：`renderNavApp()`；样式：`style.css` 的「服务导航（黄页）模块」段
- 端口规范见 zpa 仓库 `PORTS.md`；新增服务三处同步：nginx conf / `nav.json` / anm facts「nginx」

### 信息聚合

每个关注对象一个**独立探针**，结果落库；某个源超时/改版只影响它自己。

| 板块 | 分组 | 源 |
|---|---|---|
| 探针 | HuggingFace | Qwen / ornith-ai / Accio-Lab 最新模型 |
| 探针 | civarchive | MiniMax H3 / Qwen Image 2.1 新 LoRA（按底模归一化匹配） |
| 探针 | 版本更新 | llama.cpp releases / fastllm tags（atom feed）+ 本地 `git describe` 对比 |
| 热门话题 | 中文热榜 | bilibili / 微博 / 知乎 / 抖音（官方接口，按排名显示前 10） |
| 热门话题 | 外网趋势 | Google Trends / Reddit / Bluesky / Mastodon / HN / Wikipedia / GitHub（+ YouTube 待配 key） |

**「新」= 未读，不是「上次探测时第一次见到」**：

- 每个源在 `agg_state.opened_at` 记录**已读水位**；条目的 `first_seen >= opened_at` 才算未读
- 打开聚合页时显示未读标记；**离开聚合页**时调用 `POST /api/agg/open {all:true}` 打水位，Tools 角标清零
- 因此「上午没看、中午刷新」不会把新内容悄悄吃掉

其它行为：

- 缓存 30 分钟；进入页面先渲染缓存，再对过期/未探测的源**逐源增量刷新**（并发 3，单卡回填，不整页重绘）
- 页面持续打开时每 5 分钟更新未读数；在聚合页会顺便刷新过期源
- 关闭标签页 / 手机锁屏也会通过 `pagehide` / `visibilitychange` + `keepalive` 打已读水位（不再永远未读）
- 失败按 `fail_count` 指数退避（60s → 30min 封顶），不会每次开页面都重打坏源；成功时间与失败时间分开记录（`last_ok_at` / `fetched_at`）
- 全量刷新有并发上限 4；`?force=1` 才强制刷新未过期源
- 保留策略：热榜类每源保留最近 200 条（按 `last_seen`，长期在榜不会被误删），其余源删除 90 天未再见的条目；**任何刷新后最多每小时清理一次**（不再只依赖「全部刷新」）
- 每日榜（Google Trends / Wikipedia / Mastodon / Bluesky）与微博/抖音热搜的 `item_id` 带日期，同一话题隔天再上榜会重新提醒
- 版本探针的本地 `git describe` 已异步化，不会阻塞事件循环
- 加源：`src/agg/sources.js` 加一条 `{ id, group, label, note, homepage, probe }` 即可
- 需要 key 的源用 `requires: { env: [...], hint }` 声明；缺变量时状态为 `unconfigured`
- 网络约定：国内平台与 hf-mirror/civarchive 走直连；出境源声明 `proxyMode`（`on` 必走 / `auto` 先直连再代理，地址 `AGG_PROXY`，默认 `http://127.0.0.1:12809`）

凭据只放 `/home/tony/zdata/zdashboard/agg.env`（600，不进仓库）；systemd 单元用 `EnvironmentFile=-` 读取。

### 项目管理器

Tools 里的 **🛠 项目管理器**：左栏「仓库管理」、右栏「端口管理」，两个功能独立；条目可以只有仓库、只有端口，或两者都有。

- **左右分栏**：左侧仓库管理（有端口的行显示 `127xx↳181xx` + 监听绿灯），右侧**端口映射注册表**（nginx/主页/打开/移除端口）
- **注册表状态**：有端口就显示；上游监听 → 绿色边框；nginx 实际反向代理 → 绿灯「转发中」（手工映射标「手工转发」）；待应用/冲突/未转发各有颜色
- **新建项目**：顶部「+ 新建项目」默认同时建仓 + 注册端口；也可在左右栏分别新建
- **解耦**：删除仓库不删端口，移除端口不删仓库；两边都没了才删整条（ComfyUI = 两者都有；MinIO = 只有端口）
- **端口**：自动上游 `12710–12799`、对外 `18130–18189`；成品软件可直接填已有端口（如 8188）；自动跳过 `ss` 监听、活动 nginx conf、`nav.json`、数据库已用端口
- **建仓/附着仓库**：新建仓库在 `/home/tony/zrepo/<slug>`，默认同时自动分配一组 `127xx ↳ 181xx` 并注册到右栏（可取消）；「扫描本机」会把已有仓库以 `repo_created=0` 导入
- **双远端**：`origin` fetch GitHub，pushurl 配 GitHub + Gitee；远端仓库需先在平台创建
- **扫描**：左栏「扫描仓库」只导仓库；右栏「扫描运行服务」只导已知服务/成品软件；也可 `npm run pm:scan` 全扫；已有手工映射的服务只登记、不重复 listen
- **同步 git**：刷新 last commit / 脏文件 / 未推送 / 双远端
- **nginx**：启用后由 root 的 `zdashboard-nginx-apply.path/service` 校验并安装 `/etc/nginx/conf.d/zdashboard-projects.conf`，`nginx -t` 失败自动回滚
- **主页挂载**：`GET /api/nav` 合并静态黄页与托管项目；**左上「当前项目」**也来自 PM
- **开关**：nginx / 主页 / 置顶独立；删除只删管理记录，仓库保留
- **安全**：写操作需要 `PM_TOKEN`（`X-PM-Token`）或全局 `AUTH_TOKEN`；未配置时写接口 403，只读可用
- 上游未监听时映射仍可打开，但会 502；管理器不启动项目进程

### 英语学习（Vocab）

粘贴英文文章 → 分词入库 → 按状态着色 → 点击切换状态。

- **前后端共用 `public/tokenize.js`**：前端能点的词一定在后端词库里（数字 token 不当作单词）
- URL / 邮箱 / 行内代码 / 围栏代码块不会进入词库（仍原样显示，但不可点、不计数），避免污染 Vocab
- 大文章按 12000 token 分段渲染，先显示前一段，其余点「继续显示」——不会一次插入十万级 DOM 节点
- 词状态：`unknown`（红 + 波浪下划线）/ `familiar`（黄 + 点状下划线）/ `mastered`（白）；点击循环 红/白 → 黄 → 白
- 键盘选词模式：点「⌨ 键盘选词」后，单词可 Tab 聚焦，Enter/空格切换状态
- 删除文章会级联删除词-文章关联，并清理**不再属于任何文章**的孤立词（确认框文案与实际一致）
- 统计：`GET /api/vocab/stats`

### 已删除：音频播放器

v0.2.0 按 `docs/DESIGN.md` 的决议删除：路由、WebSocket、前端播放条、`AUDIO_DIR` 配置、`ws` 依赖全部移除。
原因：没有文件流路由、WS 载荷与前端长期不一致、队列只播第一首——保留坏代码没有意义，后续重做。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 探活：`{ok,service,version,uptime}`（免鉴权） |
| GET | `/api/articles` | 文章列表（`content_length` + 去重 `word_count`） |
| POST | `/api/articles` | 提交文章 `{title?,content}`（≤500k 字符） |
| GET | `/api/articles/:id` | 文章详情 + 单词状态 |
| DELETE | `/api/articles/:id` | 删除文章 + 清理孤立词 |
| PUT | `/api/words` | `{word,status}` 更新掌握状态 |
| GET | `/api/words/:word/articles` | 单词详情（出现过的文章） |
| GET | `/api/vocab/stats` | 词汇统计 |
| GET | `/api/agg` | 聚合快照（缓存 + 未读数 + stale） |
| POST | `/api/agg/refresh` | `?source=<id>` 刷一个；不带则刷过期源；`?force=1` 强制全部 |
| POST | `/api/agg/open` | `{all:true}` 或 `{source:"<id>"}` 标记已读水位 |
| GET | `/api/pm` | 项目管理器列表 + nginx 应用状态 |
| POST | `/api/pm` | 新建：分配端口/建仓/双远端（写保护） |
| PATCH | `/api/pm/:id` | nginx/主页开关、名称、端口（写保护） |
| DELETE | `/api/pm/:id` | 删除整条管理记录（写保护） |
| DELETE | `/api/pm/:id/repo` | 解绑仓库（保留端口，写保护） |
| DELETE | `/api/pm/:id/ports` | 移除端口（保留仓库，写保护） |
| POST | `/api/pm/apply` | 重新写 nginx 期望状态（写保护） |
| POST | `/api/pm/scan` | 扫描并补建条目：`?what=repos\|ports\|all`（写保护） |
| POST | `/api/pm/sync` | 刷新 git 派生字段（写保护） |
| GET | `/api/nav` | 黄页 + 托管项目（主页用） |

所有错误（含坏 JSON、未知 API）统一返回 JSON：`{ "error": "..." }`。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `3100` | 监听端口（`ZDASHBOARD_PORT` 作为兼容别名） |
| `HOST` | `127.0.0.1` | 绑定地址 |
| `DB_PATH` | `./zdb.db` | SQLite 路径（生产：`/home/tony/zdata/zdb.db`） |
| `CHECKPOINT` | `throttle` | WAL 策略：`always`（每次写）/ `throttle`（500ms 合并）/ `off`；容器用 `always` |
| `AUTH_TOKEN` | 空 | 设置后除 `/api/health` 外的 `/api/*` 需要 `X-ZToken` 或 `Authorization: Bearer` |
| `ZREPO_DIR` | `/home/tony/zrepo` | 仓库根目录（猜 `repo_path`） |
| `PM_TOKEN` | 空 | 项目管理器写操作口令（`X-PM-Token`）；未配置且未启用 `AUTH_TOKEN` 时写接口 403 |
| `PM_UPSTREAM_MIN/MAX` | `12710` / `12799` | 新建项目分配的上游端口段 |
| `PM_EXTERNAL_MIN/MAX` | `18130` / `18189` | nginx 对外端口段 |
| `PM_PUBLIC_HOST` | `192.168.0.102` | 主页项目卡片的 URL 主机 |
| `PM_REPO_ROOT` | `/home/tony/zrepo` | 新仓库根目录 |
| `PM_GIT_OWNER` | `HanqingTony` | 双远端 owner |
| `PM_STATE_DIR` | `<DB 目录>/zdashboard` | nginx 期望状态/状态文件目录 |
| `PM_NGINX_DIR` | `/etc/nginx` | 端口扫描用 nginx 目录 |
| `AGG_PROXY` | `http://127.0.0.1:12809` | 出境源代理 |
| `ALLOWED_HOSTS` | 空 | 可选 Host 白名单（逗号分隔、不含端口）；设置后拒绝其它 Host（防 DNS rebinding） |
| `BACKUP_DIR` | `<DB 目录>/backup/zdashboard` | `npm run backup` 的输出目录 |
| `BACKUP_KEEP` | `7` | 备份保留份数 |
| `YOUTUBE_API_KEY` | — | YouTube Data API v3 |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | — | Reddit OAuth（缺省退回 RSS，可能被 429） |

`AUTH_TOKEN` 用法：浏览器打开一次 `https://host:18100/?token=xxx`（token 存入 localStorage 并自动从 URL 清除）；curl 用 `-H "X-ZToken: xxx"`。更稳妥的方式仍是 nginx `auth_basic` + `AUTH_TOKEN`，或不要让 18100 出内网。

`PM_TOKEN` 放在 `/home/tony/zdata/zdashboard/agg.env`（600）；首次在项目管理器里点写操作会提示输入，存 localStorage。

其它默认安全行为：

- 鉴权在 body 解析之前；未认证请求不会先吃掉 2MB 内存
- `/api` 固定窗口限流（180 次/分钟/IP），超出返回 429
- 响应头带 CSP（只允许本站脚本/样式）、`X-Frame-Options: DENY`、`nosniff`、`no-referrer`
- 生产环境 500 不再回传内部错误文本（可能含 SQL 细节）

## 数据库约定

- **迁移**：`src/migrations.js` 用 `PRAGMA user_version` 顺序执行；新增表/字段只加迁移，不要在各 store 里散落 DDL
- SQLite WAL 模式、`wal_autocheckpoint = 100`、`busy_timeout = 5000`
- **每次写事务结束后调用 `checkpoint()`**（`src/db.js`），不要直接写 `db.pragma(...)`：
  - 本机默认 `throttle`：写后 500ms 合并一次，避免每点一个单词都 fsync
  - 容器/单文件 bind-mount 用 `CHECKPOINT=always`：每次写立刻把 WAL 合回主 `.db`
  - 关机时 `flushCheckpoint()` 强制落盘；`busy=1` 会打 warn 而不是静默吞掉
- 时间统一 ISO 8601 UTC（`src/lib/time.js` 的 `nowIso()`），不再与 SQLite `localtime` 混用
- 历史表 `zInfra` / `zObjects` 已由 `npm run archive-legacy -- --drop` 归档并从主库删除（归档文件在 `BACKUP_DIR/legacy/`）

## 部署

### zmain 本机常驻部署（当前生产）

```bash
# 单元模板在仓库：deploy/zdashboard.service（已启用最小权限 hardening）
sudo cp deploy/zdashboard.service /etc/systemd/system/zdashboard.service
sudo systemctl daemon-reload
sudo systemctl restart zdashboard
sudo journalctl -u zdashboard -f

# nginx 18100 反代到本服务（/etc/nginx/conf.d/zports-external.conf）
curl -k https://192.168.0.102:18100/api/health
```

- 监听 `127.0.0.1:28100`（端口规范：18xxx 对外 18100 ↔ 28xxx 上游 28100）
- `DB_PATH=/home/tony/zdata/zdb.db`（权威库）
- ExecStart 使用 pnpm 的 node（`/home/tony/.local/share/pnpm/bin/node`，与已编译的 better-sqlite3 ABI 一致）
- 单元启用 `ProtectSystem=strict` / `ProtectHome=read-only` + `ReadWritePaths=/home/tony/zdata`（只允许写数据库/备份目录）
- 已删除 `AUDIO_DIR=`；`CHECKPOINT=throttle` 显式声明

### 备份（systemd timer）

```bash
# 手动备份一次
npm run backup

# 每天 04:00 自动备份（保留 7 份）
sudo cp deploy/zdashboard-backup.service deploy/zdashboard-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zdashboard-backup.timer
systemctl list-timers zdashboard-backup.timer
```

备份使用 SQLite 在线备份 API（`db.backup()`），无需停服；默认写到 `/home/tony/zdata/backup/zdashboard`。

### 项目管理器 nginx 应用（root）

```bash
# 主服务 unit 已含 ReadWritePaths=/home/tony/zrepo（建仓需要）
sudo cp deploy/zdashboard.service /etc/systemd/system/zdashboard.service

# root 侧：安装期望状态应用器 + path unit
sudo install -m 755 deploy/zdashboard-nginx-apply.sh /usr/local/sbin/zdashboard-nginx-apply
sudo cp deploy/zdashboard-nginx-apply.service deploy/zdashboard-nginx-apply.path /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zdashboard-nginx-apply.path

# PM_TOKEN（写在 agg.env，600）
# PM_TOKEN=<随机串>
sudo systemctl restart zdashboard
```

- App 只写 `/home/tony/zdata/zdashboard/pm-nginx.conf`；root 脚本校验端口段、`nginx -t`、reload，失败自动回滚。
- 状态文件 `pm-nginx-status.json` 由 app 读取并在项目管理器里显示。

### .run 便携部署

要求：Docker + Docker Compose（v2 插件或独立的 `docker-compose`；c2r 会自动回退）+ `makeself`。

```bash
bash deploy/build_run.sh

export ZDB_PATH=/path/to/zdb.db      # 宿主机上的库文件（compose 插值）
export ZDASHBOARD_PORT=3100          # 宿主机端口
./zbuild/zdashboard.run
```

容器内使用 `DB_PATH=/data/zdb.db` 与 `CHECKPOINT=always`；音频目录已不需要。

### Docker Compose

```bash
docker compose -f deploy/docker-compose.yml up -d
```

首次部署如果 `ZDB_PATH` 指向的文件不存在，Docker 会把它建成目录——先 `touch` 一个空文件。
镜像内 `/data` 已 `chown node`，单文件挂载时 WAL/SHM 可正常创建；容器使用 `CHECKPOINT=always`。

### 本地开发

```bash
npm install
npm run dev        # node --env-file-if-exists=.env --watch server.js
npm test           # node:test（内存库，不碰生产数据；30 个用例）
npm run backup     # SQLite 在线备份
npm run archive-legacy            # 只归档历史表（zInfra/zObjects/zproject）
npm run archive-legacy -- --drop  # 归档后从主库删除
npm run pm:scan    # 扫描本机仓库/运行服务，补建项目管理器条目
```

## 目录结构

```
zdashboard/
├── server.js               # 入口：HTTP + 优雅关闭
├── src/
│   ├── app.js              # Express 装配（测试可直接 import）
│   ├── config.js           # 环境变量（无 config.json）
│   ├── db.js               # SQLite + checkpoint 策略
│   ├── migrations.js       # PRAGMA user_version 版本化迁移
│   ├── lib/
│   │   ├── time.js         # ISO 时间工具
│   │   └── rate-limit.js   # /api 限流
│   ├── agg/
│   │   ├── sources.js      # 各源探针
│   │   └── store.js        # 落库 / 未读水位 / 退避 / 保留策略
│   ├── pm/
│   │   ├── ports.js        # 端口扫描/分配
│   │   ├── repo.js         # 建仓 + 双远端
│   │   ├── scan.js         # 扫描本机仓库/服务
│   │   ├── nginx.js        # nginx 期望状态
│   │   └── store.js        # managed_project
│   └── routes/             # articles / vocab / agg / pm
├── public/
│   ├── index.html          # 单页骨架（资产带 ?v=<版本>）
│   ├── app.js              # 启动入口（注册应用 + 角标）
│   ├── core.js             # 工具/侧栏/应用注册表/布局/状态栏
│   ├── vocab.js            # 英语学习模块
│   ├── nav.js              # 服务导航模块
│   ├── agg.js              # 信息聚合模块
│   ├── pm.js               # 项目管理器模块
│   ├── tokenize.js         # 前后端共用分词器
│   ├── nav.json            # 黄页数据源
│   └── style.css
├── scripts/
│   ├── backup.js           # SQLite 在线备份
│   ├── archive-legacy.js   # 历史表归档/删除
│   └── scan-projects.js    # 扫描本机仓库/服务
├── test/                   # node:test（tokenize / agg / pm / api / auth / rate-limit / migrations）
├── deploy/                 # Dockerfile / compose / systemd 单元 /
│                           # nginx apply script + path/service / build_run.sh / c2r.sh
├── .github/workflows/      # CI：npm ci + npm test
└── docs/                   # 路线图与逐版本记录
```
