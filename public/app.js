// public/app.js — 单文件 SPA（type="module"；共享 public/tokenize.js）
import { tokenize } from './tokenize.js';

// ========== 可选写保护 token ==========
// 设置 AUTH_TOKEN 后：打开一次 https://host/?token=xxx 即可（存 localStorage 并清掉 URL 参数）
const ZDB_TOKEN = readToken();

function readToken() {
    try {
        const u = new URL(location.href);
        const t = u.searchParams.get('token');
        if (t) {
            localStorage.setItem('zdbToken', t);
            u.searchParams.delete('token');
            history.replaceState(null, '', u.pathname + u.search + u.hash);
        }
        return localStorage.getItem('zdbToken') || '';
    } catch { return ''; }
}

async function apiFetch(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (ZDB_TOKEN && path.startsWith('/api')) headers['X-ZToken'] = ZDB_TOKEN;
    const res = await fetch(path, { ...opts, headers });
    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* 非 JSON */ }
        throw new Error(msg);
    }
    return res;
}

// ========== 工具函数 ==========
const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// 注意：必须转义引号——项目备注/外部 feed 标题都会进属性（value="…" / title="…"）
function escHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => HTML_ESC[c]);
}

// 外链只允许 http(s) 或站内绝对路径，挡掉 javascript: / data: 之类
function safeUrl(value) {
    const s = String(value ?? '').trim();
    return /^(https?:\/\/|\/(?!\/))/i.test(s) ? s : '#';
}

function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(5, 10);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${m}-${day}`;
}

// ========== 时钟 ==========
function tick() {
    const n = new Date(), p = v => String(v).padStart(2, '0');
    const t = `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())} ${p(n.getHours())}:${p(n.getMinutes())}`;
    document.getElementById('clockP').textContent = t;
    document.getElementById('clockL').textContent = t;
}
tick();
setInterval(tick, 15000);

// ========== DOM 引用 ==========
const scroller = document.getElementById('scroller');
const landscape = document.getElementById('landscape');
const panelP = document.getElementById('panelP');
const screenP = document.getElementById('screenP');
const screenL = document.getElementById('screenL');
const lsRight = document.getElementById('lsRight');
const spacer = document.getElementById('portSpacer');

// ========== 侧栏（Projects / Tools）==========
// 竖屏和横屏用同一份配置生成，避免两份硬编码漂移
const PROJECTS = [
    { i: 'D', n: 'zDashboard', s: 'a' },
    { i: 'A', n: 'agent_properties', s: 'm' },
    { i: 'W', n: 'WASM Classics', s: 'p' },
    { i: 'V', n: 'Vocab Builder', s: 'p' },
];

const APPS = [
    { app: 'nav', label: '🧭 服务导航', badge: '18100' },
    { app: 'agg', label: '📡 信息聚合', badgeId: 'badgeAgg' },
    { app: 'projects', label: '📋 项目台账', badgeId: 'badgePj' },
    { app: 'vocab', label: '📚 Vocab Builder', badgeId: 'badgeVocab' },
    { app: null, label: '✖ Empty' },
    { label: '📝 Diary', badge: '3' },
    { label: '💰 Finance' },
    { label: '⏰ Reminders', badge: '2' },
    { label: '📊 Data Browser' },
];

function renderPanels() {
    const projectsHtml = PROJECTS.map(p =>
        `<div class="pr"><div class="pr-i">${escHtml(p.i)}</div><span class="pr-n">${escHtml(p.n)}</span><span class="pr-s ${escHtml(p.s)}"></span></div>`
    ).join('');

    const toolsHtml = (suffix) => APPS.map(t => {
        const badge = t.badgeId
            ? `<span class="bd" id="${t.badgeId}${suffix}"></span>`
            : t.badge ? `<span class="bd">${escHtml(t.badge)}</span>` : '';
        if (t.app === undefined) return `<div class="tl">${escHtml(t.label)} ${badge}</div>`;
        const dataApp = t.app === null ? '' : t.app;
        const onclick = t.app === null ? "switchApp(null)" : `switchApp('${t.app}')`;
        return `<div class="tl" data-app="${dataApp}" onclick="${onclick}">${escHtml(t.label)} ${badge}</div>`;
    }).join('');

    for (const [id, suffix] of [['projectsP', ''], ['projectsL', 'L']]) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = projectsHtml;
    }
    for (const [id, suffix] of [['toolsP', ''], ['toolsL', 'L']]) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = toolsHtml(suffix);
    }
}

// ========== 应用切换框架 ==========
let currentApp = null;

function getActiveScreen() {
    return isMobile() ? screenP : screenL;
}

function renderApp(screen, app) {
    screen.innerHTML = '';
    if (app === null) {
        screen.style.background = '#000';
        screen.style.border = 'none';
        screen.innerHTML = '<div class="ms-ph"><span class="b">&#x25A1;</span>1 : 1</div>';
        return;
    }
    screen.style.background = 'var(--bg)';
    screen.style.border = app === 'vocab' ? '1px solid rgba(108,92,231,.35)' : '1px solid var(--bdr)';
    if (app === 'vocab') renderVocabApp(screen);
    else if (app === 'nav') renderNavApp(screen);
    else if (app === 'agg') renderAggApp(screen);
    else if (app === 'projects') renderProjectsApp(screen);
    else screen.innerHTML = `<div class="ms-ph"><span class="b">&#x25A1;</span>${escHtml(app)}</div>`;
}

function switchApp(app) {
    // 离开聚合页 → 记下已读水位（Tools 角标清零）
    if (currentApp === 'agg' && app !== 'agg') ackAggRead();

    currentApp = app;
    document.querySelectorAll('#toolsP .tl[data-app], #toolsL .tl[data-app]').forEach(el => {
        el.classList.toggle('active', (el.dataset.app || null) === app);
    });

    renderApp(getActiveScreen(), app);
    requestAnimationFrame(layout);
}

// ========== 英语学习模块 ==========
const vocabState = {
    articles: [],
    currentArticle: null,
};

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
    // 旋转/切屏重渲染时保留当前文章
    if (vocabState.currentArticle) renderArticleContent(vocabState.currentArticle);
    loadArticles();
    loadVocabStats();
}

async function loadVocabStats() {
    try {
        const s = await (await apiFetch('/api/vocab/stats')).json();
        const el = document.getElementById('vocabStats');
        if (el) {
            el.innerHTML = `
                <span>词 <span class="num">${s.total || 0}</span></span>
                <span style="color:var(--grn)">+${s.mastered || 0}</span>
                <span style="color:var(--org)">~${s.familiar || 0}</span>
                <span style="color:var(--red)">?${s.unknown || 0}</span>
            `;
        }
    } catch (e) { console.warn('[vocab] stats 加载失败:', e.message); }
}

let statsTimer = null;
function loadVocabStatsSoon() {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(loadVocabStats, 150);
}

async function loadArticles() {
    try {
        vocabState.articles = await (await apiFetch('/api/articles')).json();
        renderArticleList();
    } catch (e) { console.warn('[vocab] 文章列表加载失败:', e.message); }
}

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
                <span>${a.word_count || 0} 词</span>
                <span>${formatDate(a.created)}</span>
                <button class="vs-del" onclick="event.stopPropagation();deleteArticle(${a.id})" title="删除">&times;</button>
            </div>
        </div>
    `).join('');
}

async function loadArticle(id) {
    try {
        const article = await (await apiFetch(`/api/articles/${id}`)).json();
        vocabState.currentArticle = article;
        renderArticleContent(article);
        renderArticleList();
    } catch (e) { console.warn('[vocab] 文章加载失败:', e.message); }
}

async function deleteArticle(id) {
    if (!confirm('确定删除这篇文章？不再属于任何文章的词汇记录也会被清理。')) return;
    try {
        await apiFetch(`/api/articles/${id}`, { method: 'DELETE' });
        if (vocabState.currentArticle && vocabState.currentArticle.id === id) {
            vocabState.currentArticle = null;
            renderEmptyReader();
        }
        await loadArticles();
        loadVocabStats();
    } catch (e) { alert('删除失败: ' + e.message); }
}

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

// 渲染文章（分词与后端共用 public/tokenize.js，保证可点的词都在库里）
function renderArticleContent(article) {
    const reader = document.getElementById('vocabReader');
    if (!reader) return;

    const wordMap = {};
    for (const w of article.words || []) wordMap[w.word] = w.status;

    let html = `<div class="vocab-article-title">${escHtml(article.title)}</div><div class="vocab-text">`;
    for (const t of tokenize(article.content)) {
        if (t.type === 'sep') {
            html += `<span class="vw-sep">${escHtml(t.text)}</span>`;
        } else {
            const status = wordMap[t.key] || 'unknown';
            html += `<span class="vw ${status}" data-word="${escHtml(t.key)}" onclick="onWordClick(this, event)">${escHtml(t.text)}</span>`;
        }
    }
    html += '</div>';
    reader.innerHTML = html;
}

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

async function analyzeArticle() {
    const textarea = document.getElementById('newArticleText');
    if (!textarea) return;
    const content = textarea.value.trim();
    if (!content) return;
    try {
        const data = await (await apiFetch('/api/articles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content }),
        })).json();
        await loadArticles();
        loadVocabStats();
        await loadArticle(data.id);
    } catch (e) {
        alert('保存失败: ' + e.message);
    }
}

// 状态切换：unknown/mastered → familiar → mastered（红/白 → 黄 → 白）
async function onWordClick(el) {
    const word = el.dataset.word;
    const prev = el.classList.contains('mastered') ? 'mastered'
        : el.classList.contains('familiar') ? 'familiar' : 'unknown';
    const next = (prev === 'familiar') ? 'mastered' : 'familiar';

    const spans = document.querySelectorAll(`.vw[data-word="${CSS.escape(word)}"]`);
    const paint = (s) => spans.forEach(span => {
        span.classList.remove('mastered', 'familiar', 'unknown');
        span.classList.add(s);
    });
    paint(next);

    try {
        await apiFetch('/api/words', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ word, status: next }),
        });
        loadVocabStatsSoon();
    } catch (e) {
        paint(prev);   // 失败回滚，避免界面撒谎
        console.warn('[vocab] 状态更新失败:', e.message);
    }
}

// ========== 服务导航（黄页）==========
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
    const ports = (it.port || it.upstream)
        ? `<span class="ni-ports">${it.port ? `<b>${escHtml(it.port)}</b>` : ''}${it.upstream ? `<i>\u21b3${escHtml(it.upstream)}</i>` : ''}</span>`
        : '';
    return `<a class="ni" href="${escHtml(safeUrl(it.url))}" target="_blank" rel="noopener">
        <span class="ni-top"><span class="ni-name">${escHtml(it.name || '')}${tags}</span>${ports}</span>
        <span class="ni-desc">${escHtml(it.desc || '')}</span>
        <span class="ni-url">${escHtml(shown)}</span>
    </a>`;
}

async function renderNavApp(container) {
    container.innerHTML = '<div class="nav-app"><div class="nav-loading">载入服务导航…</div></div>';
    let data;
    try {
        data = await loadNavData();
    } catch (e) {
        container.innerHTML = `<div class="nav-app"><div class="nav-loading">加载 nav.json 失败：${escHtml(e.message)}</div></div>`;
        return;
    }
    if (currentApp !== 'nav') return;   // 期间已切走，丢弃过期渲染

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

// ========== 信息聚合 ==========
const aggState = { data: null, autoRefreshed: false, busy: false, sourceBusy: new Set() };

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
    if (!Number.isFinite(s)) return '从未';
    if (s < 60) return '刚刚';
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
    return `${Math.floor(s / 86400)} 天前`;
}

async function aggFetch(refresh = false, source = null, force = false) {
    const qs = new URLSearchParams();
    if (source) qs.set('source', source);
    if (force) qs.set('force', '1');
    const url = `/api/agg${refresh ? '/refresh' : ''}${qs.toString() ? '?' + qs : ''}`;
    const res = await apiFetch(url, { method: refresh ? 'POST' : 'GET' });
    return res.json();
}

const AGG_BOARDS = [
    { id: 'probe', name: '探针', sub: 'HuggingFace · civarchive · 版本更新 —— 新模型 / 新 LoRA / llama.cpp·fastllm 版本' },
    { id: 'topic', name: '热门话题', sub: '中文热榜 · 外网趋势 —— 头条热帖与最热趋势' },
];

function aggFreshness(items) {
    const newest = (items || []).map(i => i.createdAt).filter(Boolean).sort().pop();
    if (!newest) return '';
    const d = new Date(newest);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const dayOf = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((dayOf(now) - dayOf(d)) / 86400000);
    if (diff <= 0) return 'fresh';
    if (diff < 7) return 'recent';
    return '';
}

function aggLocalDay(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).slice(5, 10);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function aggItemHtml(it) {
    const meta = (it.meta || []).slice(0, 2).map(m => `<span class="agg-mt">${escHtml(m)}</span>`).join('');
    const when = aggLocalDay(it.createdAt);
    const rank = it.ord != null ? `<span class="agg-rank">${escHtml(it.ord)}</span>` : '';
    return `<a class="agg-it" href="${escHtml(safeUrl(it.url))}" target="_blank" rel="noopener" title="${escHtml((it.meta || []).join(' · '))}">
        ${rank}${it.isNew ? '<span class="agg-new">新</span>' : ''}
        <span class="agg-t">${escHtml(it.title || it.id)}</span>
        <span class="agg-meta"><span class="agg-mt dim">${escHtml(when)}</span>${meta}</span>
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
    return `<section class="agg-src${fresh ? ' ' + fresh : ''}" data-src="${escHtml(s.id)}">
        <header class="agg-hd" title="${escHtml(s.note || '')}">
            <span class="agg-nm">${escHtml(s.label)}</span>${badge}
            <span class="agg-grow"></span>
            <span class="agg-ts">${aggTimeAgo(s.lastOkAt || s.fetchedAt)}</span>
            <button class="agg-rf" onclick="refreshAgg('${s.id}')" title="只刷新这一项">&#x21BB;</button>
        </header>
        <div class="agg-list">${body}</div>
        ${s.itemCount > (s.items.length) ? `<div class="agg-more">共 ${s.itemCount} 条，显示${s.ranked ? '前' : '最新'} ${s.items.length}</div>` : ''}
    </section>`;
}

function aggHeaderText(data) {
    const totalNew = data.totalNew || 0;
    return `${totalNew > 0 ? totalNew + ' 条未读' : '暂无未读'} · 上次刷新 ${aggTimeAgo(data.lastRefreshAt)}`;
}

function drawAgg(container, data) {
    aggState.data = data;
    container.innerHTML = `<div class="agg-app">
        <header class="agg-top">
            <span class="agg-title">&#x1F4E1; 信息聚合</span>
            <span class="agg-sub" id="aggSub">${escHtml(aggHeaderText(data))}</span>
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
    updateAggBadge(data.totalNew || 0);
}

// 单源刷新后只替换那一张卡，避免整页重绘/滚动跳回顶部
function replaceAggSourceCard(src) {
    const screen = getActiveScreen();
    const el = screen.querySelector(`.agg-src[data-src="${CSS.escape(src.id)}"]`);
    if (el) el.outerHTML = aggSourceHtml(src);
}

function applyAggSnapshot(data, only) {
    aggState.data = data;
    if (currentApp !== 'agg') return;   // 已离开聚合页：不要把未读数写回角标
    for (const s of data.sources) {
        if (!only || s.id === only) replaceAggSourceCard(s);
    }
    const sub = document.getElementById('aggSub');
    if (sub) sub.textContent = aggHeaderText(data);
    updateAggBadge(data.totalNew || 0);
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

    // 先渲染缓存，再按源增量刷新（并发 3），每完成一个就回填一张卡
    const need = data.sources
        .filter(s => s.status !== 'unconfigured' && (s.stale || s.status === 'idle'))
        .map(s => s.id);
    if (need.length && !aggState.autoRefreshed) {
        aggState.autoRefreshed = true;
        const queue = [...need];
        await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
            for (;;) {
                const id = queue.shift();
                if (!id) return;
                await refreshAgg(id);
            }
        }));
    }
}

async function refreshAgg(source) {
    if (source) {
        if (aggState.sourceBusy.has(source)) return;
        aggState.sourceBusy.add(source);
        const btn = getActiveScreen().querySelector(`.agg-src[data-src="${CSS.escape(source)}"] .agg-rf`);
        if (btn) { btn.disabled = true; btn.textContent = '…'; }
        try {
            applyAggSnapshot(await aggFetch(true, source), source);
        } catch (e) {
            const cached = aggState.data?.sources.find(s => s.id === source);
            if (cached) replaceAggSourceCard(cached);   // 恢复按钮状态
            console.warn(`[agg] ${source} 刷新失败:`, e.message);
        } finally {
            aggState.sourceBusy.delete(source);
        }
        return;
    }

    if (aggState.busy) return;
    aggState.busy = true;
    const screen = getActiveScreen();
    screen.querySelectorAll('.agg-rf').forEach(b => { b.disabled = true; b.textContent = '…'; });
    try {
        const data = await aggFetch(true, null, true);
        if (currentApp === 'agg') drawAgg(screen, data);
    } catch (e) {
        if (aggState.data && currentApp === 'agg') drawAgg(screen, aggState.data);
        alert('刷新失败: ' + e.message);
    } finally {
        aggState.busy = false;
        layout();
    }
}

function ackAggRead() {
    if (!aggState.data) return;
    apiFetch('/api/agg/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
    }).catch(() => {});
    aggState.data.sources.forEach(s => { s.newCount = 0; });
    updateAggBadge(0);
}

// ========== 项目台账 ==========
const pjState = { data: null, filter: { kind: '', layer: '', grade: '', q: '' }, busy: false };
const PJ_STATUS = ['🟢活跃', '🟡按需', '🔵完成待维护', '⚪暂停', '🔴欠账', '🧩上游', '📦归档', '💭想法'];
const PJ_LAYERS = ['L0 在做', 'L1 活跃', 'L2 按需', 'L3 想法', 'L4 归档'];
const PJ_KINDS = [['', '全部'], ['repo', '工程'], ['infra', '基建'], ['upstream', '上游'], ['data', '数据'], ['idea', '想法']];

async function pjApi(path, method = 'GET', body) {
    const res = await apiFetch(`/api/projects${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
}

function pjChip(txt, cls) {
    return txt ? `<span class="pj-chip ${cls || ''}">${escHtml(txt)}</span>` : '';
}

function pjRowHtml(it) {
    const sub = [it.stack, it.deploy, it.ports, it.next_step].filter(Boolean).join(' · ');
    const git = it.repo_path
        ? `<span class="pj-git">${escHtml(it.last_commit_at || '—')}${it.dirty ? ` · 脏${it.dirty}` : ''}${it.ahead ? ` · 未推${it.ahead}` : ''}${it.remote ? ` · ${escHtml(it.remote)}` : ''}</span>`
        : '';
    const score = it.kind === 'idea' && it.score != null
        ? `<span class="pj-score" title="F${it.feasibility} + C${it.completeness} + I${it.importance}">${it.score}</span>` : '';
    const verdictBtn = it.kind === 'idea'
        ? `<button class="pj-v ${it.verdict === 'alive' ? 'on' : ''}" onclick="pjVerdict(${it.id},'alive')" title="活（继续留着）">活</button>
           <button class="pj-v ${it.verdict === 'parked' ? 'on' : ''}" onclick="pjVerdict(${it.id},'parked')" title="搁置">搁</button>
           <button class="pj-v ${it.verdict === 'killed' ? 'on' : ''}" onclick="pjVerdict(${it.id},'killed')" title="判死">死</button>` : '';
    return `<div class="pj-row" id="pj-row-${it.id}">
        <div class="pj-main">
            ${it.grade ? `<span class="pj-grade g${escHtml(it.grade)}">${escHtml(it.grade)}</span>` : ''}
            <span class="pj-name">${escHtml(it.name)}</span>
            ${pjChip(it.status)}
            ${it.layer ? pjChip(it.layer, 'dim') : ''}
            ${it.pinned ? '<span class="pj-pin">📌</span>' : ''}
            <span class="pj-grow"></span>
            ${score}${verdictBtn}
            <button class="agg-rf" onclick="pjEdit(${it.id})" title="编辑">✎</button>
        </div>
        ${sub ? `<div class="pj-sub2">${escHtml(sub)}</div>` : ''}
        ${it.risk ? `<div class="pj-risk">⚠️ ${escHtml(it.risk)}</div>` : ''}
        ${git ? `<div class="pj-sub2">${git}</div>` : ''}
        ${it.note ? `<div class="pj-note">${escHtml(it.note)}</div>` : ''}
        <div id="pj-edit-${it.id}"></div>
    </div>`;
}

function drawProjects() {
    const box = document.getElementById('pjBody');
    if (!box || !pjState.data) return;
    const f = pjState.filter;
    let items = pjState.data.items;
    if (f.kind) items = items.filter(i => i.kind === f.kind);
    if (f.layer) items = items.filter(i => i.layer === f.layer);
    if (f.grade) items = items.filter(i => i.grade === f.grade);
    if (f.q) {
        const q = f.q.toLowerCase();
        items = items.filter(i => JSON.stringify(i).toLowerCase().includes(q));
    }

    const groups = [];
    for (const it of items) {
        const g = it.board || '其它';
        let x = groups.find(y => y.name === g);
        if (!x) { x = { name: g, items: [] }; groups.push(x); }
        x.items.push(it);
    }
    const st = pjState.data.stats;
    const el = document.getElementById('pjSub');
    if (el) el.textContent =
        `${st.total} 条 · 在办 ${(st.byLayer.find(x => x.k === 'L0 在做') || {}).n || 0} · 想法 ${st.ideas}（待判 ${st.ideasNoVerdict}）· 风险 ${st.reposWithRisk}`;
    box.innerHTML = groups.map(g =>
        `<div class="pj-group"><h3 class="pj-gt">${escHtml(g.name)} <span class="pj-cnt">${g.items.length}</span></h3>${g.items.map(pjRowHtml).join('')}</div>`
    ).join('') || '<div class="agg-loading">没有匹配的条目</div>';
}

async function renderProjectsApp(container) {
    container.innerHTML = '<div class="pj-app"><div class="agg-loading">载入项目台账…</div></div>';
    let data;
    try {
        data = await pjApi('');
    } catch (e) {
        container.innerHTML = `<div class="pj-app"><div class="agg-loading">读取失败：${escHtml(e.message)}</div></div>`;
        return;
    }
    if (currentApp !== 'projects') return;
    pjState.data = data;
    container.innerHTML = `<div class="pj-app">
        <header class="agg-top">
            <span class="pj-title">&#x1F4CB; 项目台账</span>
            <span class="pj-sub" id="pjSub"></span>
            <span class="agg-grow"></span>
            <button class="vb" onclick="pjSync()">同步 git</button>
            <button class="vb" onclick="pjImport()">从清单导入</button>
        </header>
        <div class="pj-filters">
            <select class="vb" onchange="pjSet('kind', this.value)">${PJ_KINDS.map(([v, t]) => `<option value="${escHtml(v)}" ${pjState.filter.kind === v ? 'selected' : ''}>${escHtml(t)}</option>`).join('')}</select>
            <select class="vb" onchange="pjSet('layer', this.value)"><option value="">全部层</option>${PJ_LAYERS.map(l => `<option ${pjState.filter.layer === l ? 'selected' : ''}>${escHtml(l)}</option>`).join('')}</select>
            <select class="vb" onchange="pjSet('grade', this.value)"><option value="">全部档</option>${['A', 'B', 'C', 'D'].map(g => `<option ${pjState.filter.grade === g ? 'selected' : ''}>${g}</option>`).join('')}</select>
            <input class="pj-q" placeholder="搜索名称/备注/下一步…" value="${escHtml(pjState.filter.q)}" oninput="pjSet('q', this.value)">
        </div>
        <div id="pjBody"></div>
    </div>`;
    drawProjects();
    updatePjBadge(data.stats.ideasNoVerdict);
}

function pjSet(k, v) {
    pjState.filter[k] = v;
    drawProjects();
}

function updatePjBadge(n) {
    const txt = n > 0 ? String(n) : '';
    ['badgePj', 'badgePjL'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = txt;
    });
}

async function pjReload() {
    pjState.data = await pjApi('');
    drawProjects();
    updatePjBadge(pjState.data.stats.ideasNoVerdict);
}

async function pjVerdict(id, v) {
    try {
        await pjApi('/' + id, 'PATCH', { verdict: v });
        const it = pjState.data.items.find(x => x.id === id);
        if (it) it.verdict = v;
        const row = document.getElementById('pj-row-' + id);
        if (row && it) row.outerHTML = pjRowHtml(it);
        updatePjBadge(pjState.data.items.filter(x => x.kind === 'idea' && !x.verdict).length);
    } catch (e) { alert('更新失败: ' + e.message); }
}

async function pjSync() {
    if (pjState.busy) return;
    pjState.busy = true;
    try {
        const r = await pjApi('/sync', 'POST');
        await pjReload();
        alert(`已同步 ${r.synced} 个仓库的 git 状态${r.failed?.length ? `（失败 ${r.failed.length}: ${r.failed.join(', ')}）` : ''}`);
    } catch (e) { alert('同步失败: ' + e.message); } finally { pjState.busy = false; }
}

async function pjImport() {
    if (pjState.busy) return;
    pjState.busy = true;
    try {
        const r = await pjApi('/import', 'POST');
        await pjReload();
        alert(`已导入 ${r.imported} 条（按名字幂等）\n来源：${r.source}`);
    } catch (e) { alert('导入失败: ' + e.message); } finally { pjState.busy = false; }
}

function pjEdit(id) {
    const it = pjState.data.items.find(x => x.id === id);
    const box = document.getElementById('pj-edit-' + id);
    if (!it || !box) return;
    if (box.dataset.open === '1') { box.innerHTML = ''; box.dataset.open = '0'; return; }
    box.dataset.open = '1';

    const sel = (name, cur, opts0) => {
        const opts = [...opts0];
        if (cur && !opts.includes(cur)) opts.unshift(cur);   // 兼容库里的历史值
        return `<select data-f="${name}">${opts.map(o => `<option ${o === cur ? 'selected' : ''}>${escHtml(o)}</option>`).join('')}</select>`;
    };
    box.innerHTML = `<div class="pj-editor">
        <label>下一步 / 交付物<input data-f="next_step" value="${escHtml(it.next_step || '')}"></label>
        <label>状态 ${sel('status', it.status || '', PJ_STATUS)}</label>
        <label>层 ${sel('layer', it.layer || '', PJ_LAYERS)}</label>
        ${it.kind === 'idea' ? `<label>评估 F/C/I
            <input data-f="feasibility" type="number" min="1" max="5" value="${it.feasibility ?? ''}" style="width:44px">
            <input data-f="completeness" type="number" min="1" max="5" value="${it.completeness ?? ''}" style="width:44px">
            <input data-f="importance" type="number" min="1" max="5" value="${it.importance ?? ''}" style="width:44px"></label>` : ''}
        <label>风险 <input data-f="risk" value="${escHtml(it.risk || '')}"></label>
        <label>备注 <textarea data-f="note" rows="2">${escHtml(it.note || '')}</textarea></label>
        <div class="pj-actions">
            <button class="vb" onclick="pjSave(${id})">保存</button>
            <button class="vb danger" onclick="pjDelete(${id})">删除</button>
        </div>
    </div>`;
}

async function pjSave(id) {
    const box = document.getElementById('pj-edit-' + id);
    if (!box) return;
    const patch = {};
    box.querySelectorAll('[data-f]').forEach(el => {
        patch[el.dataset.f] = el.value === '' ? null : el.value;
    });
    for (const k of ['feasibility', 'completeness', 'importance']) {
        if (patch[k] != null) patch[k] = Number(patch[k]);
    }
    try {
        await pjApi('/' + id, 'PATCH', patch);
        box.dataset.open = '0';
        box.innerHTML = '';
        await pjReload();
    } catch (e) { alert('保存失败: ' + e.message); }
}

async function pjDelete(id) {
    if (!confirm('确认从台账删除这一条？（只删库里的记录，不影响仓库/笔记）')) return;
    try {
        await pjApi('/' + id, 'DELETE');
        await pjReload();
    } catch (e) { alert('删除失败: ' + e.message); }
}

// ========== 方向检测与布局 ==========
function isMobile() { return window.innerWidth < 769; }

let lastMobile = null;

function layout() {
    const mobile = isMobile();
    const crossed = lastMobile !== null && lastMobile !== mobile;
    lastMobile = mobile;

    if (mobile) {
        scroller.style.display = 'flex';
        landscape.style.display = 'none';
    } else {
        scroller.style.display = 'none';
        landscape.style.display = 'flex';
    }

    // 跨断点（手机旋转/窗口缩放）后，新活跃的那块屏可能是空的 → 重渲染当前应用
    if (crossed && currentApp) renderApp(getActiveScreen(), currentApp);

    if (mobile) fitPortrait();
    else fitLandscape();
}

function fitPortrait() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const screen = screenP;

    if (currentApp) {
        screen.style.width = (vw - 16) + 'px';
        screen.style.height = Math.max(360, vh - 100) + 'px';
        screen.style.margin = '8px auto';
        screen.style.position = 'relative';
        screen.style.top = '';
        screen.style.left = '';
        spacer.style.height = Math.max(0, vh - panelP.getBoundingClientRect().height - screen.offsetHeight + 100) + 'px';
    } else {
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

function fitLandscape() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const screen = screenL;

    if (currentApp) {
        screen.style.width = (lsRight.clientWidth - 16) + 'px';
        screen.style.height = (lsRight.clientHeight - 16) + 'px';
        screen.style.position = 'absolute';
        screen.style.top = '8px';
        screen.style.left = '8px';
        screen.style.margin = '0';
    } else {
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
let panelCollapsed = false;
let savedPanelH = 0;

scroller.addEventListener('scroll', () => {
    if (!isMobile()) return;
    if (!savedPanelH) savedPanelH = panelP.scrollHeight || panelP.getBoundingClientRect().height;
    if (scroller.scrollTop > savedPanelH && !panelCollapsed) {
        panelCollapsed = true;
        panelP.classList.add('collapsed');
    } else if (scroller.scrollTop <= savedPanelH && panelCollapsed) {
        panelCollapsed = false;
        panelP.classList.remove('collapsed');
    }
});

// ========== 初始化 ==========
renderPanels();
lastMobile = isMobile();
switchApp('nav');
layout();

// Tools 角标：聚合未读数 + 项目待判想法数（失败静默）
aggFetch(false).then(d => updateAggBadge(d.totalNew || 0)).catch(() => {});
pjApi('').then(d => updatePjBadge(d.stats.ideasNoVerdict)).catch(() => {});

window.addEventListener('resize', () => {
    panelCollapsed = false;
    savedPanelH = 0;
    panelP.classList.remove('collapsed');
    layout();
});
new ResizeObserver(layout).observe(document.documentElement);

// inline onclick 需要全局可见（module 作用域默认不挂 window）
Object.assign(window, {
    switchApp,
    showInputArea,
    loadArticle,
    deleteArticle,
    analyzeArticle,
    onWordClick,
    refreshAgg,
    pjSet,
    pjVerdict,
    pjEdit,
    pjSave,
    pjDelete,
    pjSync,
    pjImport,
});
