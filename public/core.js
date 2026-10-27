// public/core.js — 应用外壳：工具函数、侧栏、应用注册表、布局、状态栏

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
const APPS = [
    { app: 'nav', label: '🧭 服务导航', badge: '18100' },
    { app: 'agg', label: '📡 信息聚合', badgeId: 'badgeAgg' },
    { app: 'pm', label: '🛠 项目管理器', badgeId: 'badgePm' },
    { app: 'vocab', label: '📚 Vocab Builder', badgeId: 'badgeVocab' },
    { app: null, label: '✖ Empty' },
    { label: '📝 Diary' },
    { label: '💰 Finance' },
    { label: '⏰ Reminders' },
    { label: '📊 Data Browser' },
];

// 主界面左上的「当前项目」：来自项目管理器（/api/pm）
function pmSidebarDot(p) {
    if (p.nginx_enabled && p.upstreamListening) return 'a';   // 对外在线
    if (p.nginx_enabled) return 'p';                          // 映射开、上游未监听
    if (p.repo_path) return 'm';                              // 仅仓库
    return 'x';                                               // 仅登记
}

function renderProjectSidebar(projects) {
    const list = (projects || []).slice(0, 5);
    const html = list.length
        ? list.map(p => {
            const initial = String(p.name || '?').trim().slice(0, 1).toUpperCase() || '?';
            const title = [p.name, p.upstream_port ? `127.0.0.1:${p.upstream_port}` : '', p.external_port ? `↳${p.external_port}` : '']
                .filter(Boolean).join(' · ');
            return `<div class="pr" onclick="switchApp('pm')" title="${escHtml(title)}">
                <div class="pr-i">${escHtml(initial)}</div>
                <span class="pr-n">${escHtml(p.name)}</span>
                <span class="pr-s ${pmSidebarDot(p)}"></span>
            </div>`;
        }).join('')
        : '<div class="pr"><span class="pr-n" style="color:var(--tx3)">暂无项目</span></div>';
    for (const id of ['projectsP', 'projectsL']) {
        const el = document.getElementById(id);
        if (el) el.innerHTML = html;
    }
}

function renderPanels() {
    renderProjectSidebar([]);

    const toolsHtml = (suffix) => APPS.map(t => {
        const badge = t.badgeId
            ? `<span class="bd" id="${t.badgeId}${suffix}"></span>`
            : t.badge ? `<span class="bd">${escHtml(t.badge)}</span>` : '';
        if (t.app === undefined) return `<div class="tl">${escHtml(t.label)} ${badge}</div>`;
        const dataApp = t.app === null ? '' : t.app;
        const onclick = t.app === null ? "switchApp(null)" : `switchApp('${t.app}')`;
        return `<div class="tl" data-app="${dataApp}" onclick="${onclick}">${escHtml(t.label)} ${badge}</div>`;
    }).join('');

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
    const def = registry.get(app);
    if (def) def.render(screen);
    else screen.innerHTML = `<div class="ms-ph"><span class="b">&#x25A1;</span>${escHtml(app)}</div>`;
}

function switchApp(app) {
    // 离开当前应用（聚合页借此打已读水位）
    if (currentApp && currentApp !== app) registry.get(currentApp)?.onLeave?.();

    currentApp = app;
    document.querySelectorAll('#toolsP .tl[data-app], #toolsL .tl[data-app]').forEach(el => {
        el.classList.toggle('active', (el.dataset.app || null) === app);
    });

    renderApp(getActiveScreen(), app);
    requestAnimationFrame(layout);
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



// ========== 顶栏 / Tools 角标 ==========
function setStat(key, value) {
    for (const suffix of ['P', 'L']) {
        const el = document.getElementById(`stat${key}${suffix}`);
        if (el) el.textContent = value == null || value === '' ? '—' : String(value);
    }
}

function updateAggBadge(n) {
    const txt = n > 0 ? String(n) : '';
    ['badgeAgg', 'badgeAggL'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = txt;
    });
    setStat('Unread', n || 0);
}

// ========== 应用注册表与启动 ==========
const registry = new Map();

export function registerApp(id, handlers) {
    registry.set(id, handlers);
}

export function getCurrentApp() {
    return currentApp;
}

export function isActive(app) {
    return currentApp === app;
}

export function startApp() {
    renderPanels();
    lastMobile = isMobile();
    switchApp('nav');
    layout();

    window.addEventListener('resize', () => {
        panelCollapsed = false;
        savedPanelH = 0;
        panelP.classList.remove('collapsed');
        layout();
    });
    new ResizeObserver(layout).observe(document.documentElement);
}

export {
    apiFetch, escHtml, safeUrl, formatDate,
    getActiveScreen, switchApp, layout,
    updateAggBadge, renderProjectSidebar, setStat,
};

// inline onclick 需要全局可见
Object.assign(window, { switchApp });
