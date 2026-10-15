# zdashboard

> **当前版本：v0.1.6** · [路线图](docs/ROADMAP.md) · [v0.1.6 更新记录](docs/v0.1.6.md) · [v0.1.5 更新记录](docs/v0.1.5.md) · [v0.1.4 更新记录](docs/v0.1.4.md) · [v0.1.3 更新记录](docs/v0.1.3.md) · [v0.1.2 更新记录](docs/v0.1.2.md) · [v0.1.1 更新记录](docs/v0.1.1.md) · [v0.1.0 更新记录](docs/v0.1.0.md)

个人多功能仪表盘，深色主题，横竖屏自适应，单文件 SPA。

## 功能模块

### 项目台账

Tools 里的 **📋 项目台账**：把 zpa 仓库的项目组合清单落进 `zdb.db`，在面板里看/改/跟踪。

- 表 `zproject`（126 条 = 工程·基建·上游·数据 32 + 想法 94）；页面按板块分组，显示状态/层/git 状态/风险
- **事实源 = `zpa` 的清单**（`PROJECTS.md` / `IDEAS-RANKING.md` / `PORTFOLIO.md`）→「从清单导入」按名字幂等 upsert，**不覆盖**你在库里改的状态/下一步/备注
- 「同步 git」刷新 19 个仓库的最近提交/脏文件/未推送
- 想法带 F/C/I 评分与 A/B/C/D 档 + **判决按钮（活/搁/死）**，Tools 角标 = 待判想法数

### 信息聚合

Tools 里的 **📡 信息聚合**：每个关注对象一个**独立探针**，结果落库并标注「新」条目——打开即知「有没有新东西」。

| 分组 | 源 | 关注点 |
|---|---|---|
| HuggingFace | `Qwen` / `ornith-ai` / `Accio-Lab` | 是否发了新模型 |
| civarchive | `minimax h3` / `qwen image 2.1` | 是否出了新 LoRA（按底模归一化匹配） |
| 中文热榜 | bilibili 热门 / 微博热搜 / 知乎热榜 / 抖音热榜 | 头条热帖（官方接口，按榜单排名显示前 10） |
| 外网趋势 | Google Trends / Reddit / Bluesky / Mastodon / Hacker News / Wikipedia / GitHub | 免 key 直接可用；YouTube 待配置（只差 API key） |

> 可行性结论（实测）：国内四家可用官方接口免凭据跑通；**小红书不可行**（无公开接口，只有签名逆向）；
> 外网以官方免费源为准：Google Trends/HN/Wikipedia/GitHub/Bluesky/Mastodon 免 key 直接可用，
> Reddit 免 OAuth 会被限流（有免费 app 凭据则走 OAuth），**X/Twitter 是唯一硬付费墙**——
> 用「Google Trends + Bluesky + Mastodon」组合近似替代。逐条证据见 `docs/v0.1.5.md`。

- 「新」= 本地库里**首次见到**（`agg_item.first_seen == last_seen`）；第一次探测全部为「新」，之后只有真新增才算
- 缓存 30 分钟；进入页面若过期/未探测会自动跑一次（只自动一次）
- 某源超时/改版只影响它自己（卡片显示 `探针失败: …`），其余照常
- 加源：在 `src/agg/sources.js` 加一条 `{ id, group, label, note, homepage, probe }` 即可，前端自动多一张卡

### 服务导航（黄页）

本机各服务的导航页，也是打开 `https://192.168.0.102:18100/` 的**默认落地页**（取代原 nginx 静态导航页）。

- **内容全部在 `public/nav.json`**：标题 / 分组 / 卡片 / 底部说明；增删服务只改 JSON，刷新即生效
- 卡片字段：`name` / `url` / `desc` / `port`（**对外入口 181xx**）/ `upstream`（**回环上游 28xxx**）/ `tags`
  —— 卡片直接显示端口对，如 `18104 ↳28104`（规范见 zpa 仓库 `PORTS.md`）
- 渲染：`renderNavApp()`（`public/app.js`）；样式：`style.css` 的「服务导航（黄页）模块」段
- 窄屏自动单列（网格 `minmax(210px,1fr)` → ≤768px 单列）

### 音频播放器

浏览器端音频队列播放，配合 ComfyUI + CosyVoice 语音合成使用。

- **播放队列**：POST `/api/play {"path":"..."}` 入队，自动依次播放
- **控制**：跳过（POST `/api/skip`）、清空（POST `/api/clear`）
- **文件列表**：GET `/api/audio` 浏览音频目录
- **WebSocket**：`/ws` 实时推送 play / queued / cleared 事件

### 英语学习（Vocab）

基于文章的英语单词学习工具。粘贴英文文章，自动分词并标注单词掌握状态，点击单词即可切换状态。

#### 工作流

1. 粘贴英文文章 → 点击「分析文章」
2. 后端自动分词、统计词频、入库
3. 文章中的单词按掌握状态着色（红=不认识 / 黄=眼熟 / 白=已掌握）
4. 点击单词切换状态：红→黄→白（循环）
5. 左侧栏查看词汇统计和文章历史

#### 单词状态

| 状态 | 颜色 | 含义 |
|------|------|------|
| unknown | 红色 | 不认识，首次出现 |
| familiar | 黄色 | 眼熟，正在学习 |
| mastered | 白色（无色） | 已掌握 |

#### 状态切换逻辑

- unknown / mastered → familiar（标为学习中）
- familiar → mastered（标为已掌握）

#### API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/articles` | 文章列表 |
| POST | `/api/articles` | 提交文章（自动分词入库） |
| GET | `/api/articles/:id` | 文章详情（含单词和词频） |
| DELETE | `/api/articles/:id` | 删除文章 |
| PUT | `/api/words` | 更新单词掌握状态 `{"word":"...", "status":"mastered/familiar/unknown"}` |
| GET | `/api/words/:word/articles` | 单词详情（含出现过的文章列表） |
| GET | `/api/vocab/stats` | 词汇统计（总数/各状态数量/文章数） |

#### 数据模型

- **zVocab**：单词表（word, status, first_seen, last_seen, click_count）
- **zArticles**：文章表（title, content, created）
- **zWordArticles**：单词-文章关联表（word, article_id, count）

## 部署

### zmain 本机常驻部署（当前生产）

```bash
# systemd 单元：/etc/systemd/system/zdashboard.service
sudo systemctl restart zdashboard      # 重启
sudo journalctl -u zdashboard -f       # 看日志

# nginx 18100 反代到本服务（/etc/nginx/conf.d/zports-external.conf）
curl -k https://192.168.0.102:18100/api/health
```

- 监听 `127.0.0.1:28100`（仅本机；端口规范：18xxx 对外 18100 ↔ 28xxx 上游 28100，见 zpa 仓库 `PORTS.md`）
- 数据库 `DB_PATH=/home/tony/zdata/zdb.db`（权威库）、音频 `AUDIO_DIR=/home/tony/zdata/zdashboard/audio`
- 依赖已 `npm install`（含 `better-sqlite3` 原生绑定；npm 12 需 `allowScripts` 放行，见 `package.json`）

### .run 便携部署

```bash
# 构建
bash deploy/build_run.sh

# 运行
export ZDB_PATH=/path/to/zdb.db
export ZAUDIO_DIR=/path/to/audio
export ZDASHBOARD_PORT=3100
./zbuild/zdashboard.run
```

### Docker Compose

```bash
docker compose -f deploy/docker-compose.yml up -d
```

### 本地开发

```bash
npm install
node server.js
```

## 目录结构

```
zDashboard/
├── server.js           # 入口
├── src/
│   ├── config.js       # 配置（环境变量 > config.json > 默认值）
│   ├── db.js           # SQLite 初始化
│   ├── agg/
│   │   ├── sources.js  # 信息聚合：各源定义与探针（每源独立逻辑）
│   │   └── store.js    # 信息聚合：落库 + 「新」判定
│   ├── projects/
│   │   ├── store.js        # 项目台账：zproject 表 + CRUD
│   │   └── fromMarkdown.js # 从 zpa 清单生成 seed.json（清单是事实源）
│   └── routes/
│       ├── audio.js    # 音频播放路由
│       ├── articles.js # 文章管理路由
│       ├── vocab.js    # 词汇学习路由
│       ├── agg.js      # 信息聚合路由
│       └── projects.js # 项目台账路由
├── public/
│   ├── index.html      # 单文件 SPA 前端
│   ├── nav.json        # 服务导航（黄页）数据源
│   ├── app.js
│   └── style.css
├── deploy/             # Docker 部署
│   ├── Dockerfile
│   ├── docker-compose.yml  # c2r 打包 & compose 部署共用
│   └── build_run.sh    # .run 构建脚本（调用 c2r）
├── docs/               # 项目文档
│   ├── ROADMAP.md      # 路线图
│   └── v0.1.0.md       # 版本更新记录
├── package.json
└── .gitignore
```
