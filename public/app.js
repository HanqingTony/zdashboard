// ========== 音频播放器 ==========
const audioBar = document.getElementById('audioBar');
const abDot = document.getElementById('abDot');
const abName = document.getElementById('abName');
const abBadge = document.getElementById('abBadge');
const abWs = document.getElementById('abWs');

// 隐藏的 <audio> 元素
const audioEl = new Audio();
let currentPlayId = null;
let wsQueueCount = 0;

// 更新队列角标
function updateBadge(count) {
    wsQueueCount = count;
    if (count > 0) {
        abBadge.textContent = `队列 ${count}`;
        abBadge.style.display = '';
    } else {
        abBadge.style.display = 'none';
    }
}

// 播放音频
function playAudio(id, url, fileName) {
    currentPlayId = id;
    abName.textContent = fileName;
    abDot.classList.add('playing');
    audioBar.classList.add('visible');
    audioEl.src = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
    audioEl.play().catch(e => console.warn('[audio] 自动播放被阻止:', e));
}

// 音频播放结束 → 通知后端播放下一首
audioEl.addEventListener('ended', () => {
    abDot.classList.remove('playing');
    abName.textContent = '--';
    if (ws && ws.readyState === 1 && currentPlayId !== null) {
        ws.send(JSON.stringify({ event: 'ended', data: { id: currentPlayId } }));
        currentPlayId = null;
    }
});

// ========== WebSocket 连接 ==========
function wsUrl() {
    const p = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${p}//${location.host}/ws`;
}

let ws;
let wsRetryTimer = null;

function connectWs() {
    ws = new WebSocket(wsUrl());
    abWs.textContent = 'connecting...';

    ws.addEventListener('open', () => {
        abWs.textContent = 'live';
        abWs.style.color = 'var(--grn)';
        if (wsRetryTimer) { clearTimeout(wsRetryTimer); wsRetryTimer = null; }
    });

    ws.addEventListener('message', (e) => {
        const msg = JSON.parse(e.data);
        switch (msg.event) {
            case 'play':
                playAudio(msg.data.id, msg.data.url, msg.data.fileName);
                break;
            case 'queued':
                updateBadge(msg.data.position);
                break;
            case 'sync':
                updateBadge(msg.data.queue?.length || 0);
                break;
            case 'cleared':
                updateBadge(0);
                break;
        }
    });

    ws.addEventListener('close', () => {
        abWs.textContent = 'offline';
        abWs.style.color = 'var(--red)';
        wsRetryTimer = setTimeout(connectWs, 3000);
    });

    ws.addEventListener('error', () => {});
}

connectWs();

// ========== 时钟 ==========
function tick(){
    const n=new Date,p=v=>String(v).padStart(2,'0');
    const t=`${n.getFullYear()}-${p(n.getMonth()+1)}-${p(n.getDate())} ${p(n.getHours())}:${p(n.getMinutes())}`;
    document.getElementById('clockP').textContent=t;
    document.getElementById('clockL').textContent=t;
}
tick();setInterval(tick,15000);

// ========== DOM引用 ==========
const scroller=document.getElementById('scroller');
const landscape=document.getElementById('landscape');
const panelP=document.getElementById('panelP');
const screenP=document.getElementById('screenP');
const screenL=document.getElementById('screenL');
const lsRight=document.getElementById('lsRight');
const spacer=document.getElementById('portSpacer');

// ========== 应用切换框架 ==========
// currentApp: 当前激活的应用 ID（null 表示空）
let currentApp = null;

// 获取当前活跃的主显示区 DOM
function getActiveScreen() {
    return isMobile() ? screenP : screenL;
}

// 切换应用
// app: 'vocab' | null | 其他模块名
function switchApp(app) {
    currentApp = app;
    const screen = getActiveScreen();

    // 更新所有 .tl 的激活状态
    document.querySelectorAll('.tl[data-app]').forEach(el => {
        el.classList.toggle('active', el.dataset.app === app);
    });

    // 清空主显示区
    screen.innerHTML = '';

    if (app === 'vocab') {
        screen.style.background = 'var(--bg)';
        screen.style.border = '1px solid rgba(108,92,231,.35)';
        renderVocabApp(screen);
    } else if (app === 'nav') {
        screen.style.background = 'var(--bg)';
        screen.style.border = '1px solid var(--bdr)';
        renderNavApp(screen);
    } else if (app === 'agg') {
        screen.style.background = 'var(--bg)';
        screen.style.border = '1px solid var(--bdr)';
        renderAggApp(screen);
    } else if (app === null) {
        // 空状态
        screen.style.background = '#000';
        screen.innerHTML = '<div class="ms-ph"><span class="b">&#x25A1;</span>1 : 1</div>';
    } else {
        screen.style.background = '#000';
        screen.innerHTML = `<div class="ms-ph"><span class="b">&#x25A1;</span>${app}</div>`;
    }

    // 切换应用后重新布局（因为内容高度可能变化）
    requestAnimationFrame(layout);
}

// ========== 英语学习模块 ==========

// 模块状态
const vocabState = {
    articles: [],          // 文章列表
    currentArticle: null,  // 当前加载的文章详情 {id, title, content, words}
    loading: false,
};

// 渲染整个英语学习模块
function renderVocabApp(container) {
    container.innerHTML = `
        <div class="vocab-app">
            <div class="vocab-header">
                <span class="vh-title">&#x1F4DA; Vocab Builder</span>
                <div class="vh-stats" id="vocabStats"></div>
                <div class="vh-spacer"></div>
            </div>
            <div class="vocab-body">
                <div class="vocab-sidebar">
                    <div class="vs-header">
                        <span>Articles</span>
                        <button class="vb" style="padding:2px 8px;font-size:9px" onclick="showInputArea()">+ 新建</button>
                    </div>
                    <div class="vs-list" id="articleList"></div>
                </div>
                <div class="vocab-reader" id="vocabReader">
                    <div class="vocab-empty">
                        <div class="ve-icon">&#x1F4DA;</div>
                        <p>点击左侧「+ 新建」粘贴文章<br>或选择已有文章继续学习</p>
                    </div>
                </div>
            </div>
        </div>
    `;

    // 加载文章列表和统计
    loadArticles();
    loadVocabStats();
}

// 加载词汇统计
async function loadVocabStats() {
    try {
        const res = await fetch('/api/vocab/stats');
        const s = await res.json();
        const el = document.getElementById('vocabStats');
        if (el) {
            el.innerHTML = `
                <span>词 <span class="num">${s.total||0}</span></span>
                <span style="color:var(--grn)">+${s.mastered||0}</span>
                <span style="color:var(--org)">~${s.familiar||0}</span>
                <span style="color:var(--red)">?${s.unknown||0}</span>
            `;
        }
    } catch(e) { console.warn('[vocab] stats加载失败:', e); }
}

// 加载文章列表
async function loadArticles() {
    try {
        const res = await fetch('/api/articles');
        vocabState.articles = await res.json();
        renderArticleList();
    } catch(e) { console.warn('[vocab] 文章列表加载失败:', e); }
}

// 渲染文章列表侧栏
function renderArticleList() {
    const el = document.getElementById('articleList');
    if (!el) return;

    if (vocabState.articles.length === 0) {
        el.innerHTML = '<div style="padding:12px;color:var(--tx3);font-size:10px;text-align:center">暂无文章</div>';
        return;
    }

    el.innerHTML = vocabState.articles.map(a => `
        <div class="vs-item ${vocabState.currentArticle && vocabState.currentArticle.id === a.id ? 'active' : ''}"
             onclick="loadArticle(${a.id})">
            <div class="vs-title">${escHtml(a.title)}</div>
            <div class="vs-meta">
                <span>${a.word_count||0} 词</span>
                <span>${formatDate(a.created)}</span>
                <button class="vs-del" onclick="event.stopPropagation();deleteArticle(${a.id})" title="删除">&times;</button>
            </div>
        </div>
    `).join('');
}

// 加载单篇文章
async function loadArticle(id) {
    try {
        const res = await fetch(`/api/articles/${id}`);
        const article = await res.json();
        vocabState.currentArticle = article;
        renderArticleContent(article);
        renderArticleList();  // 刷新列表高亮
    } catch(e) {
        console.warn('[vocab] 文章加载失败:', e);
    }
}

// 删除文章
async function deleteArticle(id) {
    if (!confirm('确定删除这篇文章？关联的词汇记录也会被清理。')) return;
    try {
        await fetch(`/api/articles/${id}`, { method: 'DELETE' });
        // 如果删除的是当前文章，清空阅读区
        if (vocabState.currentArticle && vocabState.currentArticle.id === id) {
            vocabState.currentArticle = null;
            renderEmptyReader();
        }
        await loadArticles();
        await loadVocabStats();
    } catch(e) { console.warn('[vocab] 删除失败:', e); }
}

// 渲染文章阅读区（空状态提示）
function renderEmptyReader() {
    const reader = document.getElementById('vocabReader');
    if (!reader) return;
    reader.innerHTML = `
        <div class="vocab-empty">
            <div class="ve-icon">&#x1F4DA;</div>
            <p>点击左侧「+ 新建」粘贴文章<br>或选择已有文章继续学习</p>
        </div>
    `;
}

// 渲染文章内容（分词 + 着色）
function renderArticleContent(article) {
    const reader = document.getElementById('vocabReader');
    if (!reader) return;

    // 构建单词状态查找表
    const wordMap = {};
    if (article.words) {
        for (const w of article.words) {
            wordMap[w.word] = w.status;
        }
    }

    // 分词：正则匹配字母数字（含撇号、连字符），标点自动忽略
    // 预处理：统一全角/弯引号标点为半角（常见于从 Word/PDF 复制的文本）
    const normalized = article.content
        .replace(/[\u2019\u2018\u201A\uFF07]/g, "'")
        .replace(/[\u2013\u2014\u2010\uFF0D]/g, "-");
    const WORD_RE = /[a-zA-Z0-9]+(?:['\-][a-zA-Z0-9]+)*/g;
    const words = normalized.match(WORD_RE) || [];
    // 记录每个匹配的索引位置，用于渲染时还原原始文本格式
    let matchPos = 0;
    const tokens = [];
    for (const w of words) {
        // 找到该词在原文中的实际位置
        const idx = normalized.indexOf(w, matchPos);
        if (idx === -1) break;
        // 词之前的文本作为分隔符
        if (idx > matchPos) {
            tokens.push({ type: 'sep', text: normalized.slice(matchPos, idx) });
        }
        tokens.push({ type: 'word', text: w, key: w.toLowerCase() });
        matchPos = idx + w.length;
    }
    // 尾部剩余文本
    if (matchPos < normalized.length) {
        tokens.push({ type: 'sep', text: normalized.slice(matchPos) });
    }

    // 构建渲染 HTML
    let html = `<div class="vocab-article-title">${escHtml(article.title)}</div>`;
    html += '<div class="vocab-text">';
    for (const t of tokens) {
        if (t.type === 'sep') {
            html += `<span class="vw-sep">${escHtml(t.text)}</span>`;
        } else {
            const status = wordMap[t.key] || 'unknown';
            html += `<span class="vw ${status}" data-word="${escHtml(t.key)}" data-original="${escHtml(t.text)}" onclick="onWordClick(this, event)">${escHtml(t.text)}</span>`;
        }
    }
    html += '</div>';

    reader.innerHTML = html;
}

// 渲染输入区（新文章）
function showInputArea() {
    const reader = document.getElementById('vocabReader');
    if (!reader) return;
    reader.innerHTML = `
        <div class="vocab-input">
            <textarea id="newArticleText" placeholder="粘贴英文文章到这里..."></textarea>
            <div class="vi-actions">
                <button class="vb" onclick="analyzeArticle()">分析文章</button>
            </div>
        </div>
    `;
    document.getElementById('newArticleText').focus();
}

// 分析新文章（提交到后端保存，然后加载显示）
async function analyzeArticle() {
    const textarea = document.getElementById('newArticleText');
    if (!textarea) return;
    const content = textarea.value.trim();
    if (!content) return;

    try {
        const res = await fetch('/api/articles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
        const data = await res.json();
        if (data.id) {
            // 保存成功，加载并显示
            await loadArticles();
            await loadVocabStats();
            await loadArticle(data.id);
        } else {
            alert('保存失败: ' + (data.error || '未知错误'));
        }
    } catch(e) {
        console.warn('[vocab] 分析失败:', e);
        alert('网络错误');
    }
}

// 单词点击：切换状态
// mastered → familiar → mastered（白↔黄循环）
// unknown → familiar（红→黄，再点黄→白）
async function onWordClick(el, event) {
    const word = el.dataset.word;
    const isMastered = el.classList.contains('mastered');
    const isFamiliar = el.classList.contains('familiar');
    const isUnknown = el.classList.contains('unknown');

    // 状态切换：白→黄→白，红→黄→白
    let nextStatus;
    if (isMastered || isUnknown) {
        nextStatus = 'familiar';
    } else {
        nextStatus = 'mastered';
    }

    // 全局更新：文章中所有同名单词一起变色
    document.querySelectorAll(`.vw[data-word="${CSS.escape(word)}"]`).forEach(span => {
        span.classList.remove('mastered', 'familiar', 'unknown');
        span.classList.add(nextStatus);
    });

    // 发送到后端持久化
    try {
        await fetch('/api/words', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ word, status: nextStatus })
        });
        loadVocabStats();
    } catch(e) { console.warn('[vocab] 状态更新失败:', e); }
}

// ========== 服务导航（黄页）模块 ==========
// 数据源：public/nav.json（纯静态；增删服务只改那个文件，不必动代码）
const NAV_URL = 'nav.json';
let navData = null;

async function loadNavData() {
    if (navData) return navData;
    const res = await fetch(NAV_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    navData = await res.json();
    return navData;
}

function navItemHtml(it) {
    const tags = (it.tags || []).map(t => `<span class="ni-tag">${escHtml(t)}</span>`).join('');
    const shown = String(it.url || '').replace(/^https?:\/\//, '');
    // 端口：对外入口（port）与回环上游（upstream）都直接显示在卡片上
    const ports = (it.port || it.upstream)
        ? `<span class="ni-ports">${it.port ? `<b>${escHtml(it.port)}</b>` : ''}${it.upstream ? `<i>\u21b3${escHtml(it.upstream)}</i>` : ''}</span>`
        : '';
    return `<a class="ni" href="${escHtml(it.url || '#')}" target="_blank" rel="noopener">
        <span class="ni-top"><span class="ni-name">${escHtml(it.name || '')}${tags}</span>${ports}</span>
        <span class="ni-desc">${escHtml(it.desc || '')}</span>
        <span class="ni-url">${escHtml(shown)}</span>
    </a>`;
}

// 渲染服务导航（黄页）：本分组卡片 + 底部端口约定
async function renderNavApp(container) {
    container.innerHTML = '<div class="nav-app"><div class="nav-loading">载入服务导航…</div></div>';

    let data;
    try {
        data = await loadNavData();
    } catch (e) {
        container.innerHTML = `<div class="nav-app"><div class="nav-loading">加载 nav.json 失败：${escHtml(e.message)}</div></div>`;
        return;
    }
    if (currentApp !== 'nav') return;   // 期间已切到别的应用，丢弃过期渲染

    const groups = (data.groups || []).map(g => `
        <section class="nav-group">
            <h2 class="ng-title">${escHtml(g.name || '')}${g.note ? `<span class="ng-note">${escHtml(g.note)}</span>` : ''}</h2>
            <div class="ng-grid">${(g.items || []).map(navItemHtml).join('')}</div>
        </section>`).join('');

    container.innerHTML = `
        <div class="nav-app">
            <header class="nav-head">
                <h1>${escHtml(data.title || '服务导航')}</h1>
                ${data.subtitle ? `<p class="nav-sub">${escHtml(data.subtitle)}</p>` : ''}
            </header>
            ${groups}
            ${data.footer ? `<footer class="nav-foot">${escHtml(data.footer)}</footer>` : ''}
        </div>`;
}

// ========== 信息聚合模块 ==========
// 每条信息源在后端各有独立探针（src/agg/sources.js）；前端只负责展示 + 触发刷新。
// “新”= 该条目在本地库里首次出现（后端 agg_item 表的 first_seen）。
const aggState = { autoRefreshed: false, busy: false };

function updateAggBadge(n) {
    const txt = n > 0 ? String(n) : '';
    ['badgeAgg', 'badgeAggL'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = txt;
    });
}

function aggTimeAgo(iso) {
    if (!iso) return '从未';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
    return `${Math.floor(s / 86400)} 天前`;
}

async function aggFetch(refresh, source) {
    const qs = source ? `?source=${encodeURIComponent(source)}` : '';
    const res = await fetch(`/api/agg${refresh ? '/refresh' : ''}${qs}`, {
        method: refresh ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
}

// 板块定义：探针（新模型/新 LoRA）在上，热门话题（热榜/趋势）在下
const AGG_BOARDS = [
    { id: 'probe', name: '探针', sub: 'HuggingFace · civarchive —— 有没有新模型 / 新 LoRA' },
    { id: 'topic', name: '热门话题', sub: '中文热榜 · 外网趋势 —— 头条热帖与最热趋势' },
];

// 探针卡片的上色：最新条目是今天 → 绿框；一周内 → 黄框；更早 → 默认
function aggFreshness(items) {
    const newest = (items || []).map(i => i.createdAt).filter(Boolean).sort().pop();
    if (!newest) return '';
    const d = new Date(newest);
    if (isNaN(d)) return '';
    const now = new Date();
    const dayOf = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((dayOf(now) - dayOf(d)) / 86400000);
    if (diff <= 0) return 'fresh';      // 今天
    if (diff < 7) return 'recent';      // 一周内
    return '';
}

// 条目日期按**本地时区**显示（与绿框/黄框的判定口径一致）
function aggLocalDay(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso).slice(5, 10);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function aggItemHtml(it) {
    // 紧凑单行：新标 + 标题（截断） + 日期/关键元信息靠右
    const meta = (it.meta || []).slice(0, 2).map(m => `<span class="agg-mt">${escHtml(m)}</span>`).join('');
    const when = aggLocalDay(it.createdAt);
    const rank = it.ord != null ? `<span class="agg-rank">${it.ord}</span>` : '';
    return `<a class="agg-it" href="${escHtml(it.url || '#')}" target="_blank" rel="noopener" title="${escHtml((it.meta || []).join(' · '))}">
        ${rank}${it.isNew ? '<span class="agg-new">新</span>' : ''}
        <span class="agg-t">${escHtml(it.title || it.id)}</span>
        <span class="agg-meta"><span class="agg-mt dim">${when}</span>${meta}</span>
    </a>`;
}

function aggSourceHtml(s) {
    const badge = s.status === 'unconfigured' ? '<span class="agg-st idle">待配置</span>'
        : s.status === 'error' ? '<span class="agg-st err">失败</span>'
            : s.status === 'idle' ? '<span class="agg-st idle">未探测</span>'
                : (s.newCount > 0 ? `<span class="agg-st new">${s.newCount} 新</span>` : '<span class="agg-st ok">无新</span>');
    const body = s.status === 'unconfigured'
        ? `<div class="agg-cfg">需配置 ${escHtml((s.requires?.missing || []).join(', '))}<br>${escHtml(s.requires?.hint || '')}</div>`
        : s.status === 'error'
            ? `<div class="agg-err" title="${escHtml(s.error || '')}">${escHtml(s.error || '未知错误')}</div>`
            : (s.items.length
                ? s.items.map(aggItemHtml).join('')
                : '<div class="agg-empty">暂无条目</div>');
    const fresh = s.board === 'topic' ? '' : aggFreshness(s.items);
    return `<section class="agg-src${fresh ? ' ' + fresh : ''}">
        <header class="agg-hd" title="${escHtml(s.note || '')}">
            <span class="agg-nm">${escHtml(s.label)}</span>${badge}
            <span class="agg-grow"></span>
            <span class="agg-ts">${aggTimeAgo(s.fetchedAt)}</span>
            <button class="agg-rf" onclick="refreshAgg('${s.id}')" title="只刷新这一项">&#x21BB;</button>
        </header>
        <div class="agg-list">${body}</div>
        ${s.itemCount > (s.items.length) ? `<div class="agg-more">共 ${s.itemCount} 条，显示${s.ranked ? '前' : '最新'} ${s.items.length}</div>` : ''}
    </section>`;
}

function drawAgg(container, data) {
    const totalNew = data.sources.reduce((n, s) => n + (s.newCount || 0), 0);
    container.innerHTML = `<div class="agg-app">
        <header class="agg-top">
            <span class="agg-title">&#x1F4E1; 信息聚合</span>
            <span class="agg-sub">${totalNew > 0 ? totalNew + ' 条新' : '暂无新条目'} · 上次刷新 ${aggTimeAgo(data.lastRefreshAt)}</span>
            <span class="agg-grow"></span>
            <button class="vb" onclick="refreshAgg()">全部刷新</button>
        </header>
        ${AGG_BOARDS.map(board => {
            const inBoard = data.sources.filter(s => (s.board || 'probe') === board.id);
            if (inBoard.length === 0) return '';
            const subs = [];
            for (const s of inBoard) {
                let g = subs.find(x => x.name === s.group);
                if (!g) { g = { name: s.group, items: [] }; subs.push(g); }
                g.items.push(s);
            }
            return `<section class="agg-board">
                <h2 class="agg-bt">${escHtml(board.name)}<span class="agg-bs">${escHtml(board.sub)}</span></h2>
                ${subs.map(g => `<div class="agg-group"><h3 class="agg-gt">${escHtml(g.name)}</h3><div class="agg-grid">${g.items.map(aggSourceHtml).join('')}</div></div>`).join('')}
            </section>`;
        }).join('')}
    </div>`;
}

async function renderAggApp(container) {
    container.innerHTML = '<div class="agg-app"><div class="agg-loading">载入信息聚合…</div></div>';
    let data;
    try {
        data = await aggFetch(false);
    } catch (e) {
        container.innerHTML = `<div class="agg-app"><div class="agg-loading">读取失败：${escHtml(e.message)}</div></div>`;
        return;
    }
    if (currentApp !== 'agg') return;
    drawAgg(container, data);
    updateAggBadge(data.sources.reduce((n, s) => n + (s.newCount || 0), 0));

    // 首次进入且数据过期/未探测 → 自动跑一次（只自动一次，避免反复打外部站点）
    const need = data.sources.some(s => s.stale || s.status === 'idle');
    if (need && !aggState.autoRefreshed) {
        aggState.autoRefreshed = true;
        try {
            const fresh = await aggFetch(true);
            if (currentApp === 'agg') {
                drawAgg(container, fresh);
                updateAggBadge(fresh.sources.reduce((n, s) => n + (s.newCount || 0), 0));
            }
        } catch (e) { /* 自动刷新失败就保留缓存视图 */ }
    }
}

async function refreshAgg(source) {
    if (aggState.busy) return;
    aggState.busy = true;
    const screen = getActiveScreen();
    screen.querySelectorAll('.agg-rf').forEach(b => { b.disabled = true; b.textContent = '…'; });
    try {
        const data = await aggFetch(true, source || null);
        drawAgg(screen, data);
        updateAggBadge(data.sources.reduce((n, s) => n + (s.newCount || 0), 0));
    } catch (e) {
        alert('刷新失败: ' + e.message);
    } finally {
        aggState.busy = false;
        layout();
    }
}

// ========== 工具函数 ==========
// HTML 转义
function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// 日期格式化（ISO → 短格式）
function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const m = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
    return `${m}-${day}`;
}

// ========== 方向检测 ==========
function isMobile(){return window.innerWidth<769}

// ========== 布局切换 ==========
function layout(){
    const screen = getActiveScreen();

    if(isMobile()){
        scroller.style.display='flex';
        landscape.style.display='none';
        fitPortrait();
    }else{
        scroller.style.display='none';
        landscape.style.display='flex';
        fitLandscape();
    }
}

// ========== 竖屏布局计算 ==========
// 有应用时：主显示区宽度=视口宽，高度自适应内容（最小360px）
// 无应用时：保持 1:1 正方形
function fitPortrait(){
    const vw=window.innerWidth;
    const vh=window.innerHeight;
    const screen = screenP;

    if (currentApp) {
        // 有应用：宽度撑满，高度自适应（最小360px）
        screen.style.width = (vw - 16) + 'px';
        screen.style.height = Math.max(360, vh - 100) + 'px';
        screen.style.margin = '8px auto';
        screen.style.position = 'relative';
        screen.style.top = '';
        screen.style.left = '';
        // 调整 spacer 确保能滚动
        spacer.style.height = Math.max(0, vh - panelP.getBoundingClientRect().height - screen.offsetHeight + 100) + 'px';
    } else {
        // 无应用：1:1 正方形
        const s = Math.min(vw, vh) - 16;
        if (s <= 0) return;
        screen.style.width = s + 'px';
        screen.style.height = s + 'px';
        screen.style.margin = '8px auto';
        screen.style.position = 'relative';
        screen.style.top = '';
        screen.style.left = '';
        const totalNeeded = 32 + s + 16 + panelP.getBoundingClientRect().height;
        spacer.style.height = Math.max(0, vh - totalNeeded + 100) + 'px';
    }
}

// ========== 横屏布局计算 ==========
// 有应用时：主显示区撑满右栏
// 无应用时：1:1 正方形居中
function fitLandscape(){
    const vw=window.innerWidth;
    const vh=window.innerHeight;
    const screen = screenL;

    if (currentApp) {
        // 有应用：撑满右栏（减去 padding）
        const w = lsRight.clientWidth - 16;
        const h = lsRight.clientHeight - 16;
        screen.style.width = w + 'px';
        screen.style.height = h + 'px';
        screen.style.position = 'absolute';
        screen.style.top = '8px';
        screen.style.left = '8px';
        screen.style.margin = '0';
    } else {
        // 无应用：1:1 居中
        const s = Math.min(vw, vh) - 16;
        if (s <= 0) return;
        screen.style.width = s + 'px';
        screen.style.height = s + 'px';
        screen.style.position = 'absolute';
        screen.style.top = Math.max(0, Math.floor((lsRight.clientHeight - s) / 2)) + 'px';
        screen.style.left = '8px';
        screen.style.margin = '0';
    }
}

// ========== 竖屏滚动收起面板 ==========
let panelCollapsed=false;
let savedPanelH=0;

scroller.addEventListener('scroll',()=>{
    if(!isMobile())return;
    if(!savedPanelH) savedPanelH=panelP.scrollHeight||panelP.getBoundingClientRect().height;
    if(scroller.scrollTop>savedPanelH && !panelCollapsed){
        panelCollapsed=true;
        panelP.classList.add('collapsed');
    }else if(scroller.scrollTop<=savedPanelH && panelCollapsed){
        panelCollapsed=false;
        panelP.classList.remove('collapsed');
    }
});

// ========== 初始化 ==========
// 默认落地页：服务导航（黄页）——18100 打开即见
switchApp('nav');
layout();

// Tools 角标：信息聚合的「新条目」数（本地接口，很快；失败静默）
aggFetch(false).then(d => updateAggBadge(d.sources.reduce((n, s) => n + (s.newCount || 0), 0))).catch(() => {});
window.addEventListener('resize',()=>{
    panelCollapsed=false;savedPanelH=0;
    panelP.classList.remove('collapsed');
    layout();
});
new ResizeObserver(layout).observe(document.documentElement);
