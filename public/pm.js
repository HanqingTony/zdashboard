// public/pm.js — 项目管理器
//
// 建项目 = 分配 127xx/181xx + 建本地仓库 + 配双远端 + 写 nginx 期望状态
// 主页展示 = /api/nav 合并 managed_project（nginx + 主页开关都开）
import {
    apiFetch, escHtml, safeUrl, isActive, getActiveScreen, registerApp,
} from './core.js';

const pmState = {
    data: null,
    busy: false,
    showForm: false,
    notice: '',
    token: (() => { try { return localStorage.getItem('pmToken') || ''; } catch { return ''; } })(),
};

function updatePmBadge(n) {
    const txt = n > 0 ? String(n) : '';
    for (const id of ['badgePm', 'badgePmL']) {
        const el = document.getElementById(id);
        if (el) el.textContent = txt;
    }
}

function pmApi(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (pmState.token) headers['X-PM-Token'] = pmState.token;
    return apiFetch('/api/pm' + path, { ...opts, headers });
}

async function pmWrite(path, opts = {}) {
    try {
        return await pmApi(path, opts);
    } catch (e) {
        if (!/口令|写操作未启用|unauthorized/i.test(e.message) || /未启用/.test(e.message)) throw e;
        const t = prompt('输入 PM 管理口令（PM_TOKEN，见 /home/tony/zdata/zdashboard/agg.env）');
        if (!t) throw e;
        pmState.token = t;
        try { localStorage.setItem('pmToken', t); } catch { /* ignore */ }
        return pmApi(path, opts);
    }
}

function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('zh-CN', { hour12: false });
}

function applyBadge(a) {
    if (!a || a.ok == null) return '<span class="agg-st idle">nginx 等待应用</span>';
    if (a.ok) return `<span class="agg-st ok">nginx 已应用</span><span class="pm-ts">${escHtml(fmtTime(a.at))}</span>`;
    return `<span class="agg-st err" title="${escHtml(a.message || '')}">nginx 应用失败</span>`;
}

function pmRowHtml(p) {
    const on = (v) => v ? 'on' : '';
    const repo = p.repo || {};
    const repoText = p.repo_created
        ? (repo.exists
            ? `${escHtml(p.repo_path)} · ${repo.dualPush ? '双远端' : '远端未配齐'}${repo.head ? ' · ' + escHtml(repo.head) : ''}${repo.dirty ? ' · 脏' + repo.dirty : ''}`
            : `${escHtml(p.repo_path)} · 仓库缺失`)
        : `${escHtml(p.repo_path || '')} · 未创建仓库`;

    return `<div class="pj-row pm-row" id="pm-row-${p.id}">
        <div class="pj-main">
            <span class="pj-name">${escHtml(p.name)}</span>
            <code class="pm-slug">${escHtml(p.slug)}</code>
            <span class="pm-ports"><b>127.0.0.1:${p.upstream_port}</b><i>↳</i><b>${p.external_port}</b></span>
            <span class="pm-up ${p.upstreamListening ? 'on' : 'off'}">${p.upstreamListening ? '上游监听中' : '上游未监听'}</span>
            <span class="pj-grow"></span>
            <button class="pj-v ${on(p.nginx_enabled)}" onclick="pmToggle(${p.id},'nginxEnabled',${!!p.nginx_enabled})" title="nginx 映射开关">nginx ${p.nginx_enabled ? '开' : '关'}</button>
            <button class="pj-v ${on(p.web_enabled)}" onclick="pmToggle(${p.id},'webEnabled',${!!p.web_enabled})" title="是否挂到主页">主页 ${p.web_enabled ? '开' : '关'}</button>
            <a class="vb pm-open ${p.nginx_enabled && p.web_enabled ? '' : 'disabled'}" href="${escHtml(safeUrl(p.url))}" target="_blank" rel="noopener">打开</a>
            <button class="agg-rf" onclick="pmDelete(${p.id})" title="删除管理记录">🗑</button>
        </div>
        <div class="pj-sub2">${repoText}</div>
        ${repo.error ? `<div class="pj-risk">仓库读取失败: ${escHtml(repo.error)}</div>` : ''}
        ${repo.remotes?.length ? `<div class="pj-sub2 pm-git">${repo.remotes.map(r => `${escHtml(r.kind)} ${escHtml(r.url)}`).join(' · ')}</div>` : ''}
    </div>`;
}

function drawPm() {
    const screen = getActiveScreen();
    if (!screen || !isActive('pm')) return;
    const d = pmState.data;
    if (!d) return;
    const ranges = d.ranges || {};
    const writeAuth = d.writeAuth;
    const disabled = writeAuth == null;

    screen.innerHTML = `<div class="pm-app">
        <header class="agg-top">
            <span class="pj-title">🛠 项目管理器</span>
            <span class="agg-sub">${d.projects.length} 个托管项目 · 上游 ${ranges.upstream?.[0]}-${ranges.upstream?.[1]} · 对外 ${ranges.external?.[0]}-${ranges.external?.[1]}</span>
            <span class="agg-grow"></span>
            ${applyBadge(d.apply)}
            <button class="vb" onclick="pmApply()">重新应用 nginx</button>
            <button class="vb" onclick="pmShowForm()">+ 新建项目</button>
        </header>
        ${pmState.notice ? `<div class="pm-notice">${escHtml(pmState.notice)}</div>` : ''}
        ${disabled ? '<div class="pm-warn">写操作未启用：请在 agg.env 配置 <code>PM_TOKEN</code>（或启用全局 AUTH_TOKEN）后重启。</div>' : ''}
        ${writeAuth === 'pm_token' && !pmState.token ? '<div class="pm-warn">首次写操作会提示输入 PM 口令（PM_TOKEN）。</div>' : ''}
        ${pmState.showForm ? pmFormHtml() : ''}
        <div class="pm-list">${d.projects.length ? d.projects.map(pmRowHtml).join('') : '<div class="agg-loading">还没有托管项目。点右上角「+ 新建项目」。</div>'}</div>
        <div class="pm-foot">新建项目会在 <code>/home/tony/zrepo/&lt;slug&gt;</code> 建本地仓库，并配置 GitHub + Gitee 双推；远端仓库需你先在平台上创建。删除只删管理记录，仓库保留。</div>
    </div>`;
}

function pmFormHtml() {
    return `<div class="pj-editor pm-form">
        <div class="pm-form-grid">
            <label>项目名<input id="pmName" placeholder="例如 zfoo" oninput="pmSlugSync(this.value)"></label>
            <label>slug<input id="pmSlug" placeholder="自动" oninput="this.dataset.auto='0'"></label>
            <label>上游端口<input id="pmUp" type="number" placeholder="自动 127xx"></label>
            <label>对外端口<input id="pmExt" type="number" placeholder="自动 181xx"></label>
        </div>
        <div class="pm-checks">
            <label><input type="checkbox" id="pmCreateRepo" checked> 建本地 git 仓库</label>
            <label><input type="checkbox" id="pmDual" checked> 配置双远端（GitHub + Gitee）</label>
            <label><input type="checkbox" id="pmWeb" checked> 挂到主页</label>
            <label><input type="checkbox" id="pmNginx" checked> 启用 nginx</label>
        </div>
        <div class="pj-actions">
            <button class="vb" onclick="pmCreate()">创建</button>
            <button class="vb" onclick="pmHideForm()">取消</button>
        </div>
    </div>`;
}

function pmSlugSync(name) {
    const el = document.getElementById('pmSlug');
    if (!el || el.dataset.auto === '0') return;
    el.value = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

async function pmReload() {
    if (!isActive('pm')) return;
    const d = await (await apiFetch('/api/pm')).json();
    pmState.data = d;
    updatePmBadge(d.projects.length);
    drawPm();
}

function pmReloadSoon() {
    setTimeout(() => pmReload().catch(() => {}), 700);
    setTimeout(() => pmReload().catch(() => {}), 2200);
}

async function renderPmApp(container) {
    container.innerHTML = '<div class="pm-app"><div class="agg-loading">载入项目管理器…</div></div>';
    let d;
    try {
        d = await (await apiFetch('/api/pm')).json();
    } catch (e) {
        container.innerHTML = `<div class="pm-app"><div class="agg-loading">读取失败：${escHtml(e.message)}</div></div>`;
        return;
    }
    if (!isActive('pm')) return;
    pmState.data = d;
    updatePmBadge(d.projects.length);
    drawPm();
    if (d.apply && d.apply.ok == null) pmReloadSoon();
}

function pmShowForm() { pmState.showForm = true; pmState.notice = ''; drawPm(); }
function pmHideForm() { pmState.showForm = false; drawPm(); }

async function pmCreate() {
    if (pmState.busy) return;
    const name = document.getElementById('pmName')?.value.trim();
    const slug = document.getElementById('pmSlug')?.value.trim();
    const upstreamPort = document.getElementById('pmUp')?.value;
    const externalPort = document.getElementById('pmExt')?.value;
    const createRepo = document.getElementById('pmCreateRepo')?.checked;
    const dualRemote = document.getElementById('pmDual')?.checked;
    const webEnabled = document.getElementById('pmWeb')?.checked;
    const nginxEnabled = document.getElementById('pmNginx')?.checked;
    if (!name) { alert('请填写项目名'); return; }

    pmState.busy = true;
    try {
        const res = await pmWrite('', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name, slug: slug || undefined,
                upstreamPort: upstreamPort || undefined,
                externalPort: externalPort || undefined,
                createRepo, dualRemote, webEnabled, nginxEnabled,
            }),
        });
        const data = await res.json();
        pmState.showForm = false;
        pmState.notice = `已创建 ${data.project.slug}：127.0.0.1:${data.project.upstream_port} ↳ ${data.project.external_port}`;
        await pmReload();
        pmReloadSoon();
    } catch (e) {
        alert('创建失败: ' + e.message);
    } finally {
        pmState.busy = false;
    }
}

async function pmToggle(id, field, current) {
    if (pmState.busy) return;
    pmState.busy = true;
    try {
        await pmWrite('/' + id, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [field]: !current }),
        });
        await pmReload();
        pmReloadSoon();
    } catch (e) {
        alert('更新失败: ' + e.message);
    } finally {
        pmState.busy = false;
    }
}

async function pmDelete(id) {
    if (!confirm('删除这条托管记录？会立即移除 nginx 映射和主页卡片，仓库目录保留。')) return;
    if (pmState.busy) return;
    pmState.busy = true;
    try {
        await pmWrite('/' + id, { method: 'DELETE' });
        pmState.notice = '已删除管理记录（仓库未删）';
        await pmReload();
        pmReloadSoon();
    } catch (e) {
        alert('删除失败: ' + e.message);
    } finally {
        pmState.busy = false;
    }
}

async function pmApply() {
    if (pmState.busy) return;
    pmState.busy = true;
    try {
        await pmWrite('/apply', { method: 'POST' });
        pmReloadSoon();
    } catch (e) {
        alert('应用失败: ' + e.message);
    } finally {
        pmState.busy = false;
    }
}

registerApp('pm', { render: renderPmApp });

Object.assign(window, {
    pmShowForm, pmHideForm, pmCreate, pmToggle, pmDelete, pmApply, pmReload, pmSlugSync,
});
