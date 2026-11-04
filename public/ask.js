// public/ask.js — Ask：一个输入框为核心的咨询入口
//
// 外部引擎：把问题带进 URL / 复制到剪贴板后打开官网。
// 本地 Pi：通过 /api/ask/pi 读取选中的 session 上下文回答，不写回原 session。

import { apiFetch, escHtml, formatDate, isActive, registerApp } from './core.js';

const ENGINES = [
    { id: 'deepseek', label: 'DeepSeek', short: 'DS', color: '#4d8dff',
      hint: '官网对话 · 打开后自动带问题（不支持时会复制）', url: 'https://chat.deepseek.com/' },
    { id: 'zhihu', label: '知乎', short: '知', color: '#4d8dff',
      hint: '站内搜索 · 直接带关键词', url: 'https://www.zhihu.com/' },
    { id: 'grok', label: 'Grok', short: 'G', color: '#f2f3f7',
      hint: '官网对话 · 打开后自动带问题（不支持时会复制）', url: 'https://grok.com/' },
    { id: 'claude', label: 'Claude', short: 'C', color: '#d97757',
      hint: '官网对话 · 支持 ?q= 预填时自动带入', url: 'https://claude.ai/new' },
    { id: 'pi', label: '本地 Pi', short: 'π', color: '#00d2a8',
      hint: '优先发送到正在运行的 Herdr TUI；没有实时 TUI 时回退到只读副本回答', url: '' },
    { id: 'searxng', label: 'SearXNG', short: 'S', color: '#f0b429',
      hint: '本地元搜索 · 直接带关键词', url: 'https://192.168.0.102:18102/' },
];
const ENGINE_MAP = Object.fromEntries(ENGINES.map(e => [e.id, e]));
const HISTORY_KEY = 'zdbAskEngine';
const PI_SESSION_KEY = 'zdbAskPiSession';
const MAX_Q = 4000;

const state = {
    engine: readKey(HISTORY_KEY) || 'deepseek',
    draft: '',
    piSessions: [],
    piLoading: false,
    piSelected: readKey(PI_SESSION_KEY) || '',
    history: [],
    historyLoading: false,
    busy: false,
    answer: '',
    answerError: '',
    answerNote: '',
    piSeconds: 0,
    timer: null,
    toast: '',
    toastTimer: null,
};

function readKey(key) {
    try { return localStorage.getItem(key) || ''; } catch { return ''; }
}
function saveKey(key, value) {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
}
function engineOf(id) { return ENGINE_MAP[id] || ENGINES[0]; }
function isPi() { return state.engine === 'pi'; }

async function apiJson(path, opts = {}) {
    const init = { ...opts };
    if (init.body) init.headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
    const res = await apiFetch(path, init);
    return res.json().catch(() => ({}));
}

function toast(text, bad = false) {
    state.toast = text;
    state.toastBad = bad;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
        state.toast = '';
        document.querySelector('.ak-toast')?.classList.remove('is-on');
    }, 3800);
    const el = document.querySelector('.ak-toast');
    if (el) {
        el.textContent = text;
        el.classList.toggle('is-bad', bad);
        el.classList.add('is-on');
    }
}

function setAnswer(text, error = '', note = '') {
    state.answer = text || '';
    state.answerError = error || '';
    state.answerNote = note || '';
    const box = document.getElementById('akAnswer');
    if (!box) return;
    box.hidden = !state.answer && !state.answerError && !state.answerNote;
    const pre = box.querySelector('.ak-answer-text');
    const err = box.querySelector('.ak-answer-error');
    if (pre) {
        pre.textContent = state.answer;
        pre.hidden = !state.answer;
    }
    if (err) {
        err.textContent = state.answerError;
        err.hidden = !state.answerError;
    }
    const noteEl = box.querySelector('.ak-answer-note');
    if (noteEl) {
        noteEl.textContent = state.answerNote;
        noteEl.hidden = !state.answerNote;
    }
}

function answerHtml() {
    return `<section class="ak-answer" id="akAnswer" ${state.answer || state.answerError || state.answerNote ? '' : 'hidden'}>
        <div class="ak-answer-head">
            <span><i class="ak-dot"></i> PI ANSWER</span>
            <button class="ak-mini" type="button" data-ak="copy-answer">复制</button>
        </div>
        <div class="ak-answer-note"></div>
        <pre class="ak-answer-text"></pre>
        <div class="ak-answer-error"></div>
    </section>`;
}

function engineHtml(e) {
    return `<button type="button" class="ak-engine ${state.engine === e.id ? 'is-on' : ''}" data-engine="${e.id}"
        style="--ec:${e.color}" aria-pressed="${state.engine === e.id}">
        <span class="ak-engine-mark">${escHtml(e.short)}</span>
        <span class="ak-engine-name">${escHtml(e.label)}</span>
        ${state.engine === e.id ? '<span class="ak-engine-check">✓</span>' : ''}
    </button>`;
}

function piPanelHtml() {
    if (!isPi()) {
        const e = engineOf(state.engine);
        return `<div class="ak-target"><span class="ak-target-label">将打开</span>
            <span class="ak-target-host">${escHtml(e.url.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</span>
            <span class="ak-target-hint">${escHtml(e.hint)}</span></div>`;
    }
    const options = state.piSessions.map(s => `<option value="${escHtml(s.id)}" ${s.id === state.piSelected ? 'selected' : ''}>${escHtml(s.label)} · ${escHtml(s.cwd)}${s.live ? ' · TUI' : ''}</option>`).join('');
    return `<div class="ak-pi">
        <label class="ak-pi-label" for="akPiSession">PI SESSION</label>
        <select id="akPiSession" class="ak-select" ${state.piLoading || !state.piSessions.length ? 'disabled' : ''}>
            ${state.piLoading ? '<option>读取 session…</option>' : ''}
            ${!state.piLoading && !state.piSessions.length ? '<option>没有找到本机 Pi session</option>' : ''}
            ${options}
        </select>
        <button class="ak-mini" type="button" data-ak="reload-pi" ${state.piLoading ? 'disabled' : ''}>刷新</button>
        <span class="ak-pi-hint">优先发往 Herdr TUI · 无实时 TUI 时只读回答</span>
    </div>`;
}

function historyHtml() {
    if (state.historyLoading) return '<div class="ak-empty-small">读取中…</div>';
    if (!state.history.length) return '<div class="ak-empty-small">还没有记录。问第一个问题。</div>';
    return state.history.map(q => {
        const e = engineOf(q.engine);
        return `<button type="button" class="ak-history-item" data-history="${q.id}">
            <span class="ak-history-top"><b style="--ec:${e.color}">${escHtml(e.label)}</b><time>${escHtml(formatDate(q.createdAt))}</time></span>
            <span class="ak-history-q">${escHtml(q.question)}</span>
        </button>`;
    }).join('');
}

function appHtml() {
    return `<div class="ak-app">
        <div class="ak-top">
            <div>
                <div class="ak-eyebrow"><span class="ak-pulse"></span> ASK / CONSULT</div>
                <h1>问出去，记下来。</h1>
                <p>一个问题，多个引擎。选择入口，Send 之后会自动留档。</p>
            </div>
            <div class="ak-top-meta"><span id="akCount">0</span><small> 条记录</small></div>
        </div>
        <div class="ak-grid">
            <main class="ak-main">
                <section class="ak-composer">
                    <textarea id="akQuestion" maxlength="${MAX_Q}" rows="3"
                        placeholder="写下你想问的问题……例如：一个人做自媒体自动化，第一步应该先搭什么？"></textarea>
                    <div class="ak-composer-foot">
                        <span class="ak-counter"><span id="akChars">0</span> / ${MAX_Q}</span>
                        <span class="ak-shortcut">⌘ / Ctrl + Enter</span>
                        <button type="button" class="ak-send" id="akSend">发送 <span>↗</span></button>
                    </div>
                </section>
                <section class="ak-engine-section">
                    <div class="ak-section-label">选择引擎</div>
                    <div class="ak-engines">${ENGINES.map(engineHtml).join('')}</div>
                    <div id="akEnginePanel">${piPanelHtml()}</div>
                </section>
                ${answerHtml()}
                <div class="ak-toast" role="status"></div>
            </main>
            <aside class="ak-side">
                <div class="ak-side-head"><span>最近问题</span><button type="button" class="ak-mini" data-ak="reload-history">刷新</button></div>
                <div class="ak-history" id="akHistory">${historyHtml()}</div>
                <div class="ak-side-note">本地 Pi 会优先把问题送进该 session 正在运行的 Herdr TUI；没有实时 TUI 时读取最近上下文回答。外部引擎会把问题带进官网或复制到剪贴板。</div>
            </aside>
        </div>
    </div>`;
}

function setBusy(busy) {
    state.busy = busy;
    const btn = document.getElementById('akSend');
    if (btn) {
        btn.disabled = busy;
        btn.classList.toggle('is-busy', busy);
        btn.innerHTML = busy ? '处理中 <span class="ak-spin">◌</span>' : '发送 <span>↗</span>';
    }
}

function updateCounter() {
    const q = document.getElementById('akQuestion');
    const c = document.getElementById('akChars');
    if (q && c) c.textContent = q.value.length;
}

function renderPiPanel() {
    const el = document.getElementById('akEnginePanel');
    if (el) el.innerHTML = piPanelHtml();
}

function setEngine(id) {
    if (!ENGINE_MAP[id]) return;
    state.engine = id;
    saveKey(HISTORY_KEY, id);
    state.answer = '';
    state.answerError = '';
    state.answerNote = '';
    setAnswer('', '');
    document.querySelectorAll('.ak-engine').forEach(el => {
        const on = el.dataset.engine === id;
        el.classList.toggle('is-on', on);
        el.setAttribute('aria-pressed', String(on));
        const mark = el.querySelector('.ak-engine-check');
        if (on && !mark) el.insertAdjacentHTML('beforeend', '<span class="ak-engine-check">✓</span>');
        if (!on && mark) mark.remove();
    });
    renderPiPanel();
    if (id === 'pi' && !state.piSessions.length) loadPiSessions();
    const q = document.getElementById('akQuestion');
    if (q) q.focus();
}

async function loadPiSessions() {
    if (state.piLoading) return;
    state.piLoading = true;
    renderPiPanel();
    try {
        const data = await apiJson('/api/ask/pi/sessions?limit=60');
        state.piSessions = Array.isArray(data.sessions) ? data.sessions : [];
        if (!state.piSessions.some(s => s.id === state.piSelected)) {
            state.piSelected = state.piSessions[0]?.id || '';
            if (state.piSelected) saveKey(PI_SESSION_KEY, state.piSelected);
        }
    } catch (e) {
        state.piSessions = [];
        toast('读取 Pi session 失败：' + e.message, true);
    } finally {
        state.piLoading = false;
        renderPiPanel();
    }
}

async function loadHistory() {
    if (state.historyLoading) return;
    state.historyLoading = true;
    const el = document.getElementById('akHistory');
    if (el) el.innerHTML = historyHtml();
    try {
        const data = await apiJson('/api/ask?limit=30');
        state.history = Array.isArray(data.questions) ? data.questions : [];
        const count = document.getElementById('akCount');
        if (count) count.textContent = String(state.history.length);
    } catch (e) {
        state.history = [];
        toast('读取问题记录失败：' + e.message, true);
    } finally {
        state.historyLoading = false;
        const box = document.getElementById('akHistory');
        if (box) box.innerHTML = historyHtml();
    }
}

function buildUrl(engine, question) {
    const q = encodeURIComponent(question);
    if (engine === 'deepseek') return `https://chat.deepseek.com/?q=${q}`;
    if (engine === 'grok') return `https://grok.com/?q=${q}`;
    if (engine === 'claude') return `https://claude.ai/new?q=${q}`;
    if (engine === 'zhihu') return `https://www.zhihu.com/search?type=content&q=${q}`;
    if (engine === 'searxng') return `https://192.168.0.102:18102/search?q=${q}`;
    return '';
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
        } catch { return false; }
    }
}

async function recordQuestion(engine, question, sessionId) {
    const data = await apiJson('/api/ask', {
        method: 'POST',
        body: JSON.stringify({ question, engine, sessionId }),
    });
    if (data.question) {
        state.history.unshift(data.question);
        state.history = state.history.slice(0, 30);
        const box = document.getElementById('akHistory');
        if (box) box.innerHTML = historyHtml();
        const count = document.getElementById('akCount');
        if (count) count.textContent = String(state.history.length);
    }
    return data.question;
}

async function submit() {
    if (state.busy) return;
    const input = document.getElementById('akQuestion');
    const question = (input?.value || state.draft || '').trim();
    if (!question) {
        toast('先写一个问题。', true);
        input?.focus();
        return;
    }
    if (question.length > MAX_Q) return toast('问题太长了。', true);

    if (isPi()) {
        const select = document.getElementById('akPiSession');
        const sessionId = select?.value || state.piSelected;
        if (!sessionId) {
            toast('没有可用的 Pi session。', true);
            return;
        }
        state.piSelected = sessionId;
        saveKey(PI_SESSION_KEY, sessionId);
        setBusy(true);
        setAnswer('', '');
        state.piSeconds = 0;
        clearInterval(state.timer);
        state.timer = setInterval(() => {
            state.piSeconds++;
            const el = document.getElementById('akAnswer');
            if (el && state.busy) {
                el.hidden = false;
                const pre = el.querySelector('.ak-answer-text');
                if (pre) {
                    pre.hidden = false;
                    pre.textContent = `Pi 正在读取 session 上下文… ${state.piSeconds}s`;
                }
            }
        }, 1000);
        try {
            const rec = await recordQuestion('pi', question, sessionId);
            if (!rec) throw new Error('问题记录失败');
            const data = await apiJson('/api/ask/pi', {
                method: 'POST',
                body: JSON.stringify({ questionId: rec.id, sessionId, question }),
            });
            clearInterval(state.timer);
            state.timer = null;
            if (data.forwarded) {
                setAnswer('', '', `已发送到本地 Pi TUI（${data.paneId}）。请回到终端查看并继续会话。`);
                toast('已发送到本地 Pi TUI。');
            } else {
                setAnswer(
                    data.answer || '',
                    data.error || '',
                    data.compacted ? '所选 session 较大，已自动截取最近上下文后继续回答（不回写原 session）。' : '',
                );
                if (!data.error) toast('Pi 已回答，已记录。');
            }
        } catch (e) {
            setAnswer('', e.message || 'Pi 回答失败');
            toast(e.message || 'Pi 回答失败', true);
        } finally {
            clearInterval(state.timer);
            state.timer = null;
            setBusy(false);
        }
        return;
    }

    const engine = state.engine;
    const e = engineOf(engine);
    const url = buildUrl(engine, question);
    // 必须在用户手势里同步打开；否则会被弹窗拦截。
    let win = null;
    try {
        win = window.open(url, '_blank');
        if (win) win.opener = null;
    } catch { /* ignore */ }
    const copied = await copyText(question);
    try {
        await recordQuestion(engine, question, null);
        toast(`${e.label} 已打开${copied ? '，问题已复制' : ''}。${win ? '' : ' 弹窗被拦截。'}`, !win);
    } catch (err) {
        toast('已打开，但记录失败：' + err.message, true);
    }
}

function showHistoryItem(id) {
    const q = state.history.find(x => x.id === id);
    if (!q) return;
    const input = document.getElementById('akQuestion');
    if (input) {
        input.value = q.question;
        state.draft = q.question;
        input.focus();
    }
    setEngine(q.engine);
    if (q.sessionId && q.engine === 'pi') {
        state.piSelected = q.sessionId;
        saveKey(PI_SESSION_KEY, q.sessionId);
        renderPiPanel();
    }
    if (q.answer) setAnswer(q.answer);
}

function bind(screen) {
    const q = screen.querySelector('#akQuestion');
    if (q) {
        q.value = state.draft;
        updateCounter();
        q.addEventListener('input', () => {
            state.draft = q.value;
            updateCounter();
            q.style.height = 'auto';
            q.style.height = Math.min(220, q.scrollHeight) + 'px';
        });
        q.addEventListener('keydown', ev => {
            if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
                ev.preventDefault();
                submit();
            }
        });
        setTimeout(() => {
            q.style.height = 'auto';
            q.style.height = Math.min(220, q.scrollHeight) + 'px';
            q.focus();
        }, 20);
    }
    screen.querySelector('#akSend')?.addEventListener('click', submit);
    screen.querySelectorAll('.ak-engine').forEach(el => {
        el.addEventListener('click', () => setEngine(el.dataset.engine));
    });
    screen.querySelector('#akEnginePanel')?.addEventListener('change', ev => {
        if (ev.target?.id === 'akPiSession') {
            state.piSelected = ev.target.value;
            saveKey(PI_SESSION_KEY, state.piSelected);
        }
    });
    screen.querySelector('#akEnginePanel')?.addEventListener('click', ev => {
        if (ev.target.closest('[data-ak="reload-pi"]')) loadPiSessions();
    });
    screen.querySelector('#akHistory')?.addEventListener('click', ev => {
        const item = ev.target.closest('[data-history]');
        if (item) showHistoryItem(Number(item.dataset.history));
    });
    screen.querySelector('[data-ak="reload-history"]')?.addEventListener('click', loadHistory);
    screen.querySelector('[data-ak="copy-answer"]')?.addEventListener('click', async () => {
        if (!state.answer) return;
        const ok = await copyText(state.answer);
        toast(ok ? '答案已复制。' : '复制失败。', !ok);
    });
}

function renderAsk(screen) {
    screen.innerHTML = appHtml();
    bind(screen);
    // 进入页面时刷新记录；Pi session 只在选中时加载，避免每次打开都扫目录。
    loadHistory();
    if (isPi() && !state.piSessions.length) loadPiSessions();
    // 重渲染后恢复答案
    if (state.answer || state.answerError) setAnswer(state.answer, state.answerError);
}

registerApp('ask', { render: renderAsk });
