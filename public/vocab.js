// public/vocab.js — 英语学习模块
import { tokenize } from './tokenize.js';
import { apiFetch, escHtml, formatDate, registerApp } from './core.js';

// ========== 英语学习模块 ==========
const vocabState = {
    articles: [],
    currentArticle: null,
    keyboard: false,   // 键盘选词模式（Tab 聚焦单词，Enter/空格切换状态）
};

function wordAttrs() {
    return vocabState.keyboard ? ' tabindex="0" role="button"' : '';
}

function toggleKeyboardMode() {
    vocabState.keyboard = !vocabState.keyboard;
    const btn = document.getElementById('vocabKbBtn');
    if (btn) btn.classList.toggle('on', vocabState.keyboard);
    const reader = document.getElementById('vocabReader');
    if (!reader) return;
    reader.querySelectorAll('.vw').forEach(el => {
        if (vocabState.keyboard) {
            el.setAttribute('tabindex', '0');
            el.setAttribute('role', 'button');
        } else {
            el.removeAttribute('tabindex');
            el.removeAttribute('role');
        }
    });
}

function renderVocabApp(container) {
    container.innerHTML = `
        <div class="vocab-app">
            <div class="vocab-header">
                <span class="vh-title">&#x1F4DA; Vocab Builder</span>
                <div class="vh-stats" id="vocabStats"></div>
                <div class="vh-spacer"></div>
                <button class="vb" id="vocabKbBtn" onclick="toggleKeyboardMode()"
                        title="开启后可用 Tab 聚焦单词，Enter / 空格切换状态">⌨ 键盘选词</button>
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
    const kbBtn = document.getElementById('vocabKbBtn');
    if (kbBtn) kbBtn.classList.toggle('on', vocabState.keyboard);
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
    vocabState.reader = null;
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
// 大文章分段渲染：每段最多 READ_CHUNK_TOKENS 个 token，避免一次插入十万级 DOM 节点
const READ_CHUNK_TOKENS = 12000;

function renderArticleContent(article) {
    const reader = document.getElementById('vocabReader');
    if (!reader) return;

    const wordMap = {};
    for (const w of article.words || []) wordMap[w.word] = w.status;

    vocabState.reader = { tokens: tokenize(article.content), wordMap, index: 0 };
    reader.innerHTML = `
        <div class="vocab-article-title">${escHtml(article.title)}</div>
        <div class="vocab-text" id="vocabText"></div>
        <div class="vocab-more" id="vocabMore"></div>
    `;
    renderNextChunk();
}

function renderNextChunk() {
    const state = vocabState.reader;
    if (!state) return;
    const textEl = document.getElementById('vocabText');
    if (!textEl) return;

    const end = Math.min(state.index + READ_CHUNK_TOKENS, state.tokens.length);
    let html = '';
    for (let i = state.index; i < end; i++) {
        const t = state.tokens[i];
        if (t.type === 'sep') {
            html += `<span class="vw-sep">${escHtml(t.text)}</span>`;
        } else {
            const raw = state.wordMap[t.key];
            const status = raw === 'mastered' ? 'mastered' : raw === 'familiar' ? 'familiar' : 'unknown';
            html += `<span class="vw ${status}" data-word="${escHtml(t.key)}"${wordAttrs()} onclick="onWordClick(this, event)">${escHtml(t.text)}</span>`;
        }
    }
    state.index = end;
    textEl.insertAdjacentHTML('beforeend', html);

    const more = document.getElementById('vocabMore');
    if (!more) return;
    if (state.index < state.tokens.length) {
        const left = state.tokens.slice(state.index).filter(t => t.type === 'word').length;
        more.innerHTML = `<button class="vb" onclick="renderNextChunk()">继续显示剩余 ${left} 词</button>`;
    } else {
        more.innerHTML = '';
    }
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

    // 词 key 只含 [a-z0-9'-]，没有引号/反斜杠；CSS.escape 不可用时可直接拼
    const escaped = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(word) : word;
    const spans = document.querySelectorAll(`.vw[data-word="${escaped}"]`);
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


registerApp('vocab', { render: renderVocabApp });

// 键盘选词：单词获得焦点后 Enter / 空格 = 点击
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target;
    if (!el || !el.classList || !el.classList.contains('vw')) return;
    e.preventDefault();
    onWordClick(el);
});

Object.assign(window, {
    showInputArea, loadArticle, deleteArticle, analyzeArticle, onWordClick, renderNextChunk,
    toggleKeyboardMode,
});
