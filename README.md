# zdashboard

> **当前版本：v0.1.1** · [路线图](docs/ROADMAP.md) · [v0.1.1 更新记录](docs/v0.1.1.md) · [v0.1.0 更新记录](docs/v0.1.0.md)

个人多功能仪表盘，深色主题，横竖屏自适应，单文件 SPA。

## 功能模块

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

### .run 便携部署（推荐）

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
│   └── routes/
│       ├── audio.js    # 音频播放路由
│       ├── articles.js # 文章管理路由
│       └── vocab.js    # 词汇学习路由
├── public/
│   └── index.html      # 单文件 SPA 前端
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
