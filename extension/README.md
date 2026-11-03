# ZVocab 网页词析扩展

把网页正文变成可点击的单词标注层；可单独使用，也可直接写入 zdashboard 的同一个 SQLite。

## 安装

Chrome / Edge：

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 打开「开发者模式」
3. 「加载已解压的扩展程序」→ 选择本目录 `extension/`
4. 把工具栏的 Z 图标固定出来

没有构建步骤，也没有远程脚本。

## 使用

1. 打开一个正文页面（例如新闻、博客、文档）
2. 点 Z 图标 → 当前页面开启词析
3. 点击单词：无记录 → 黄（不熟）→ 红（不认识）→ 无色（已掌握）→ 黄……
4. 在正文段落上右键 →「本段分析完成」：本段未标记的词一次性设为已掌握
5. 再点 Z 图标关闭；高亮只作用于文字，滚动、视频、图标按钮不受影响

## 两种模式

### 本地模式

- 数据保存在扩展 IndexedDB
- 用 JSON / CSV 导入导出；可在设置里选择数据目录
- 不依赖 zdashboard，适合单独使用

### API 模式

- 设置 zdashboard 地址（默认 `http://127.0.0.1:28100`）
- 可选 `X-ZToken`（zdashboard 开启 `AUTH_TOKEN` 时）
- 点击/段落完成会直接调用：

```text
GET  /api/vocab/words?words=a,b
POST /api/vocab/occurrences
GET  /api/vocab/occurrences
```

写的是 zdashboard 正在使用的同一个 SQLite，没有同步过程，也不会生成第二份数据。

## 数据语义

- 初始未标记 = **没有记录**，不是 `unknown`（红）
- 黄 = `familiar`
- 红 = `unknown`
- 已掌握 = `mastered`
- 段落完成只处理本段没有记录的词；已有黄/红不动

## 保守处理

只处理确定的正文块：`p / li / blockquote / dd / dt / td / th / figcaption`，并跳过导航、页眉页脚、按钮、输入框、代码、图片/视频、iframe、`contenteditable`，以及过短的标签。首版不处理 iframe、Shadow DOM、PDF、canvas 文本。

## 目录

```text
extension/
├── manifest.json
├── background.js   # IndexedDB / API 转发 / 右键菜单 / 导入导出
├── content.js      # 文本扫描、单词命中、状态循环、段落完成
├── content.css     # CSS Custom Highlight + toast
├── options.html
├── options.css
├── options.js
└── icons/
```
