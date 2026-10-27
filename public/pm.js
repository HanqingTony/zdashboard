// public/pm.js — 项目管理器
//
// 一个条目可以只有仓库、只有端口映射，或两者都有（如 ComfyUI：仓库 + 8188→181xx）。
// 主页数据 = /api/nav（静态黄页 + 启用且挂主页的项目）。
import {
    apiFetch, escHtml, safeUrl, isActive, getActiveScreen, registerApp,
    renderProjectSidebar, setStat,
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
    setStat('Db', n || 0);
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
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { hour12: false }).slice(5);
}

function applyBadge(a) {
    if (!a || a.ok == null) return '<span class="agg-st idle">nginx 等待应用</span>';
    if (a.ok) return `<span class="agg-st ok">nginx 已应用</span><span class="pm-ts">${escHtml(fmtTime(a.at))}</span>`;
    return `<span class="agg-st err" title="${escHtml(a.message || '')}">nginx 应用失败</span>`;
}

const KIND_LABEL = { repo: '仓库', software: '软件', service: '服务', infra: '基建', project: '项目' };

function repoText(p) {
    if (!p.repo_path) return '<span class="pm-dim">无仓库</span>';
    const r = p.repo || {};
    if (!r.exists) return `${escHtml(p.repo_path)} · <span class="pm-bad">目录缺失</span>`;
    const bits = [escHtml(p.repo_path)];
    if (r.last_commit_at) bits.push(`${escHtml(r.last_commit_at)}${r.last_commit_subject ? ' ' + escHtml(r.last_commit_subject) : ''}`);
    else bits.push('<span class="pm-dim">未同步 git</span>');
    if (r.dirty) bits.push(`脏${r.dirty}`);
    if (r.ahead) bits.push(`未推${r.ahead}`);
    if (r.dualPush) bits.push('双远端');
    return bits.join(' · ');
}

function pmRowHtml(p) {
    const on = v => v ? 'on' : '';
    const hasPorts = p.upstream_port != null && p.external_port != null;
    const ports = hasPorts
        ? `<span class="pm-ports"><b>127.0.0.1:${p.upstream_port}</b><i>↳</i><b>${p.external_port}</b></span>`
        : '<span class="pm-dim pm-ports">无端口映射</span>';
    const up = hasPorts
        ? `<span class="pm-up ${p.upstreamListening ? 'on' : 'off'}">${p.upstreamListening ? '上游监听中' : '上游未监听'}</span>`
        : '';

    return `<div class="pj-row pm-row" id="pm-row-${p.id}">
        <div class="pj-main">
            <span class="pj-name">${escHtml(p.name)}</span>
            <code class="pm-slug">${escHtml(p.slug)}</code>
            <span class="pm-kind">${escHtml(KIND_LABEL[p.kind] || p.kind || '项目')}</span>
            ${ports}${up}
            <span class="pj-grow"></span>
            <button class="pj-v ${on(p.nginx_enabled)}" ${hasPorts ? '' : 'disabled'} onclick="pmToggle(${p.id},'nginxEnabled',${!!p.nginx_enabled})" title="nginx 映射开关">nginx ${p.nginx_enabled ? '开' : '关'}</button>
            <button class="pj-v ${on(p.web_enabled)}" ${hasPorts ? '' : 'disabled'} onclick="pmToggle(${p.id},'webEnabled',${!!p.web_enabled})" title="是否挂到主页">主页 ${p.web_enabled ? '开' : '关'}</button>
            <button class="pj-v ${on(p.pinned)}" onclick="pmToggle(${p.id},'pinned',${!!p.pinned})" title="置顶到左上当前项目">★</button>
            ${p.url ? `<a class="vb pm-open ${p.nginx_enabled && p.web_enabled ? '' : 'disabled'}" href="${escHtml(safeUrl(p.url))}" target="_blank" rel="noopener">打开</a>` : ''}
            <button class="agg-rf" onclick="pmDelete(${p.id})" title="删除管理记录">🗑</button>
        </div>
        <div class="pj-sub2">${repoText(p)}</div>
        ${p.note ? `<div class="pj-note">${escHtml(p.note)}</div>` : ''}
    </div>`;
}

function drawPm() {
    const screen = getActiveScreen();
    if (!screen || !isActive('pm') || !pmState.data) return;
    const d = pmState.data;
    const writeAuth = d.writeAuth;
    const disabled = writeAuth == null;

    screen.innerHTML = `<div class="pm-app">
        <header class="agg-top">
            <span class="pj-title">🛠 项目管理器</span>
            <span class="agg-sub">${d.projects.length} 条 · 上游 ${d.ranges.upstream[0]}-${d.ranges.upstream[1]} · 对外 ${d.ranges.external[0]}-${d.ranges.external[1]}</span>
            <span class="agg-grow"></span>
            ${applyBadge(d.apply)}
            <button class="vb" onclick="pmScan()" title="扫描本机仓库与正在运行的服务">扫描本机</button>
            <button class="vb" onclick="pmSync()" title="刷新所有仓库的 git 状态">同步 git</button>
            <button class="vb" onclick="pmApply()">重新应用 nginx</button>
            <button class="vb" onclick="pmShowForm()">+ 新建</button>
        </header>
        ${pmState.notice ? `<div class="pm-notice">${escHtml(pmState.notice)}</div>` : ''}
        ${disabled ? '<div class="pm-warn">写操作未启用：请在 agg.env 配置 <code>PM_TOKEN</code>（或启用全局 AUTH_TOKEN）后重启。</div>' : ''}
        ${writeAuth === 'pm_token' && !pmState.token ? '<div class="pm-warn">首次写操作会提示输入 PM 口令（PM_TOKEN）。</div>' : ''}
        ${pmState.showForm ? pmFormHtml() : ''}
        <div class="pm-list">${d.projects.length ? d.projects.map(pmRowHtml).join('') : '<div class="agg-loading">还没有条目。点「扫描本机」导入现有仓库/服务，或「+ 新建」。</div>'}</div>
        <div class="pm-foot">仓库与端口映射是两个独立功能：可以只有仓库、只有端口，或两者都有。删除只删管理记录，仓库保留。远端仓库需先在 GitHub/Gitee 创建，管理器只配置双推地址。</div>
    </div>`;
}

function pmFormHtml() {
    return `<div class="pj-editor pm-form">
        <div class="pm-form-grid">
            <label>名称<input id="pmName" placeholder="例如 zfoo" oninput="pmSlugSync(this.value)"></label>
            <label>slug<input id="pmSlug" placeholder="自动" oninput="this.dataset.auto='0'"></label>
            <label>类型<select id="pmKind">
                <option value="project">项目</option><option value="repo">仓库</option>
                <option value="software">成品软件</option><option value="service">服务</option><option value="infra">基建</option>
            </select></label>
            <label>上游端口<input id="pmUp" type="number" placeholder="留空自动 127xx"></label>
            <label>对外端口<input id="pmExt" type="number" placeholder="留空自动 181xx"></label>
        </div>
        <div class="pm-checks">
            <label><input type="checkbox" id="pmCreateRepo" checked> 建本地仓库 + 双远端</label>
            <label><input type="checkbox" id="pmPorts" checked> 分配端口 + nginx 映射</label>
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

export function applyPmData(data) {
    pmState.data = data;
    updatePmBadge(data.projects.length);
    renderProjectSidebar(data.projects);
    if (isActive('pm')) drawPm();
}

async function pmReload() {
    const d = await (await apiFetch('/api/pm')).json();
    applyPmData(d);
}

function pmReloadSoon() {
    setTimeout(() => pmReload().catch(() => {}), 800);
    setTimeout(() => pmReload().catch(() => {}), 2400);
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
    applyPmData(d);
    if (d.apply && d.apply.ok == null) pmReloadSoon();
}

function pmShowForm() { pmState.showForm = true; pmState.notice = ''; drawPm(); }
function pmHideForm() { pmState.showForm = false; drawPm(); }

async function pmCreate() {
    if (pmState.busy) return;
    const name = document.getElementById('pmName')?.value.trim();
    const slug = document.getElementById('pmSlug')?.value.trim();
    const kind = document.getElementById('pmKind')?.value || 'project';
    const upstreamPort = document.getElementById('pmUp')?.value;
    const externalPort = document.getElementById('pmExt')?.value;
    const createRepo = document.getElementById('pmCreateRepo')?.checked;
    const managePorts = document.getElementById('pmPorts')?.checked;
    const webEnabled = document.getElementById('pmWeb')?.checked;
    const nginxEnabled = document.getElementById('pmNginx')?.checked;
    if (!name) { alert('请填写名称'); return; }
    if (!createRepo && !managePorts) { alert('至少选择「建仓库」或「端口映射」之一'); return; }

    pmState.busy = true;
    try {
        const res = await pmWrite('', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name, slug: slug || undefined, kind,
                upstreamPort: upstreamPort || undefined,
                externalPort: externalPort || undefined,
                createRepo, managePorts, webEnabled, nginxEnabled,
            }),
        });
        const data = await res.json();
        pmState.showForm = false;
        pmState.notice = `已创建 ${data.project.slug}${data.project.upstream_port ? `：127.0.0.1:${data.project.upstream_port} ↳ ${data.project.external_port}` : ''}`;
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
    if (!confirm('删除这条管理记录？会移除 nginx 映射和主页卡片，仓库目录保留。')) return;
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

async function pmScan() {
    if (pmState.busy) return;
    pmState.busy = true;
    pmState.notice = '扫描中…';
    drawPm();
    try {
        const res = await pmWrite('/scan', { method: 'POST' });
        const r = await res.json();
        pmState.notice = `扫描完成：新增 ${r.created.length} 条，跳过 ${r.skipped.length} 条${r.synced ? `，同步 git ${r.synced} 个` : ''}`;
        await pmReload();
        pmReloadSoon();
    } catch (e) {
        pmState.notice = '扫描失败: ' + e.message;
        drawPm();
    } finally {
        pmState.busy = false;
    }
}

async function pmSync() {
    if (pmState.busy) return;
    pmState.busy = true;
    pmState.notice = '同步 git…';
    drawPm();
    try {
        const res = await pmWrite('/sync', { method: 'POST' });
        const r = await res.json();
        pmState.notice = `git 同步完成：${r.synced}/${r.total}`;
        await pmReload();
        pmReloadSoon();
    } catch (e) {
        pmState.notice = '同步失败: ' + e.message;
        drawPm();
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
    pmShowForm, pmHideForm, pmCreate, pmToggle, pmDelete, pmApply, pmScan, pmSync, pmReload, pmSlugSync,
});
