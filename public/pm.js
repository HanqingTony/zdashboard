// public/pm.js — 项目管理器：左「仓库管理」 / 右「端口管理」
//
// 一个 managed_project 行可以只有仓库、只有端口，或两者都有。
// 左侧只改仓库字段，右侧只改端口字段；删除一侧不会连带删除另一侧。
import {
    apiFetch, escHtml, safeUrl, isActive, getActiveScreen, registerApp,
    renderProjectSidebar, setStat,
} from './core.js';

const pmState = {
    data: null,
    busy: false,
    notice: '',
    showRepoForm: false,
    showPortForm: false,
    showProjectForm: false,
    portTarget: null,
};

const KIND_LABEL = { repo: '仓库', software: '软件', service: '服务', infra: '基建', project: '项目' };

function updatePmBadge(n) {
    const txt = n > 0 ? String(n) : '';
    for (const id of ['badgePm', 'badgePmL']) {
        const el = document.getElementById(id);
        if (el) el.textContent = txt;
    }
    setStat('Db', n || 0);
}

function pmWrite(path, opts = {}) {
    return apiFetch('/api/pm' + path, opts);
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

function starBtn(p, cls = 'pj-v') {
    return `<button class="${cls} ${p.pinned ? 'on' : ''}" onclick="pmToggle(${p.id},'pinned',${!!p.pinned})" title="置顶到左上当前项目">★</button>`;
}

function repoText(p) {
    const r = p.repo || {};
    const bits = [escHtml(p.repo_path)];
    if (!r.exists) bits.push('<span class="pm-bad">目录缺失</span>');
    if (r.last_commit_at) bits.push(`${escHtml(r.last_commit_at)}${r.last_commit_subject ? ' ' + escHtml(r.last_commit_subject) : ''}`);
    else bits.push('<span class="pm-dim">未同步 git</span>');
    if (r.dirty) bits.push(`脏${r.dirty}`);
    if (r.ahead) bits.push(`未推${r.ahead}`);
    if (r.dualPush) bits.push('双推地址');
    return bits.join(' · ');
}

function repoRowHtml(p) {
    const hasPorts = p.upstream_port != null && p.external_port != null;
    const ports = hasPorts
        ? `<span class="pm-ports"><b>127.0.0.1:${p.upstream_port}</b><i>↳</i><b>${p.external_port}</b></span>`
        : '';
    const listenLed = p.upstream_port == null ? ''
        : `<span class="pm-led ${p.upstreamListening ? 'on' : 'off'}"></span><span class="pm-led-label ${p.upstreamListening ? 'on' : 'off'}">${p.upstreamListening ? '监听中' : '未监听'}</span>`;
    return `<div class="pj-row pm-row${p.upstreamListening ? ' listening' : ''}" id="pm-repo-${p.id}">
        <div class="pj-main">
            <span class="pj-name">${escHtml(p.name)}</span>
            <code class="pm-slug">${escHtml(p.slug)}</code>
            <span class="pm-kind">${escHtml(KIND_LABEL[p.kind] || p.kind || '项目')}</span>
            ${ports}${listenLed}
            <span class="pj-grow"></span>
            ${starBtn(p)}
            ${hasPorts ? '' : `<button class="pj-v" onclick="pmAddPort(${p.id})" title="给这个仓库添加端口映射">+ 端口</button>`}
            <button class="agg-rf" onclick="pmRemoveRepo(${p.id})" title="移出仓库管理（端口保留）">🗑</button>
        </div>
        <div class="pj-sub2">${repoText(p)}</div>
        ${p.note ? `<div class="pj-note">${escHtml(p.note)}</div>` : ''}
    </div>`;
}

function listenCell(p) {
    if (p.upstream_port == null) return '<span class="pm-dim">—</span>';
    return `<span class="pm-led ${p.upstreamListening ? 'on' : 'off'}"></span><span class="pm-led-label ${p.upstreamListening ? 'on' : 'off'}">${p.upstreamListening ? '监听中' : '未监听'}</span>`;
}

function nginxCell(p) {
    const map = {
        forwarding: ['on', '转发中', 'PM 管理的 nginx 反向代理'],
        manual: ['on manual', '手工转发', '已有手工 nginx 配置在反代（迁移后可由 PM 开关）'],
        pending: ['pending', '待应用', '已启用，等待 nginx 应用'],
        conflict: ['err', '冲突', '该对外端口被别的 upstream 占用'],
        off: ['off', '未转发', '未启用 nginx 或尚未配置'],
    };
    const [cls, label, title] = map[p.nginxState] || map.off;
    const disabled = p.nginxState === 'manual' ? ' disabled' : '';
    return `<button class="pm-nginx"${disabled} onclick="pmToggle(${p.id},'nginxEnabled',${!!p.nginx_enabled})" title="${escHtml(title)}">
        <span class="pm-led ${cls}"></span><span class="pm-led-label ${cls}">${label}</span>
    </button>`;
}

function portRowHtml(p) {
    const on = v => v ? 'on' : '';
    return `<tr class="${p.upstreamListening ? 'listening' : ''}" id="pm-port-${p.id}">
        <td>
            <div class="pm-name-cell" title="${escHtml(p.repo_path || p.name)}">
                <span class="pj-name">${escHtml(p.name)}</span>
                <span class="pm-slug">${escHtml(p.slug)}</span>
            </div>
        </td>
        <td class="pm-num"><span class="pm-port-num">${p.upstream_port != null ? `127.0.0.1:${p.upstream_port}` : '—'}</span></td>
        <td class="pm-arrow">→</td>
        <td class="pm-num"><span class="pm-port-num">${p.external_port != null ? p.external_port : '—'}</span></td>
        <td>${listenCell(p)}</td>
        <td>${nginxCell(p)}</td>
        <td>
            <div class="pm-actions">
                <button class="pj-v ${on(p.web_enabled)}" onclick="pmToggle(${p.id},'webEnabled',${!!p.web_enabled})" title="是否挂到主页">主页</button>
                <button class="pj-v ${on(p.pinned)}" onclick="pmToggle(${p.id},'pinned',${!!p.pinned})" title="置顶">★</button>
                ${p.url ? `<a class="vb pm-open ${p.nginx_enabled && p.web_enabled ? '' : 'disabled'}" href="${escHtml(safeUrl(p.url))}" target="_blank" rel="noopener" title="打开">↗</a>` : ''}
                <button class="agg-rf" onclick="pmRemovePorts(${p.id})" title="移除端口（仓库保留）">🗑</button>
            </div>
        </td>
    </tr>`;
}

function projectFormHtml() {
    return `<div class="pj-editor pm-form pm-form-wide">
        <div class="pm-form-title">新建项目（默认同时建仓 + 注册端口；可取消其中一项）</div>
        <div class="pm-form-grid">
            <label>名称<input id="pmProjectName" placeholder="例如 zfoo" oninput="pmSlugSync(this.value,'project')"></label>
            <label>slug<input id="pmProjectSlug" placeholder="自动" oninput="this.dataset.auto='0'"></label>
            <label>类型<select id="pmProjectKind">
                <option value="project">项目</option><option value="repo">仓库</option>
                <option value="service">服务</option><option value="software">成品软件</option><option value="infra">基建</option>
            </select></label>
            <label>上游端口<input id="pmProjectUp" type="number" placeholder="留空自动 127xx；可填已有端口如 8188"></label>
            <label>对外端口<input id="pmProjectExt" type="number" placeholder="留空自动 181xx"></label>
        </div>
        <div class="pm-checks">
            <label><input type="checkbox" id="pmProjectRepo" checked> 建本地仓库 + 创建双远端仓库</label>
            <label><input type="checkbox" id="pmProjectPorts" checked> 注册端口映射</label>
            <label><input type="checkbox" id="pmProjectNginx" checked> 启用 nginx</label>
            <label><input type="checkbox" id="pmProjectWeb" checked> 挂到主页</label>
        </div>
        <div class="pj-actions">
            <button class="vb" onclick="pmCreateProject()">创建并注册</button>
            <button class="vb" onclick="pmHideForms()">取消</button>
        </div>
    </div>`;
}

function repoFormHtml() {
    return `<div class="pj-editor pm-form pm-form-col">
        <div class="pm-form-grid">
            <label>仓库名<input id="pmRepoName" placeholder="例如 zfoo" oninput="pmSlugSync(this.value,'repo')"></label>
            <label>slug<input id="pmRepoSlug" placeholder="自动" oninput="this.dataset.auto='0'"></label>
        </div>
        <div class="pm-checks">
            <label><input type="checkbox" id="pmRepoDual" checked> 创建并配置双远端（GitHub + Gitee 仓库）</label>
            <label><input type="checkbox" id="pmRepoPorts" checked> 自动注册端口（127xx ↳ 181xx）</label>
            <label><input type="checkbox" id="pmRepoNginx" checked> 启用 nginx</label>
            <label><input type="checkbox" id="pmRepoWeb" checked> 挂到主页</label>
        </div>
        <div class="pj-actions">
            <button class="vb" onclick="pmCreateRepo()">创建仓库</button>
            <button class="vb" onclick="pmHideForms()">取消</button>
        </div>
    </div>`;
}

function portFormHtml() {
    const target = pmState.portTarget ? pmState.data.projects.find(p => p.id === pmState.portTarget) : null;
    if (target) {
        return `<div class="pj-editor pm-form pm-form-col">
            <div class="pm-form-title">给「${escHtml(target.name)}」添加端口映射</div>
            <div class="pm-form-grid">
                <label>上游端口<input id="pmPortUp" type="number" placeholder="留空自动 127xx；可填已有端口如 8188"></label>
                <label>对外端口<input id="pmPortExt" type="number" placeholder="留空自动 181xx"></label>
            </div>
            <div class="pm-checks">
                <label><input type="checkbox" id="pmPortNginx" checked> 启用 nginx</label>
                <label><input type="checkbox" id="pmPortWeb" checked> 挂到主页</label>
            </div>
            <div class="pj-actions">
                <button class="vb" onclick="pmCreatePort()">保存端口</button>
                <button class="vb" onclick="pmHideForms()">取消</button>
            </div>
        </div>`;
    }
    return `<div class="pj-editor pm-form pm-form-col">
        <div class="pm-form-grid">
            <label>名称<input id="pmPortName" placeholder="例如 ComfyUI" oninput="pmSlugSync(this.value,'port')"></label>
            <label>slug<input id="pmPortSlug" placeholder="自动" oninput="this.dataset.auto='0'"></label>
            <label>类型<select id="pmPortKind">
                <option value="service">服务</option><option value="software">成品软件</option>
                <option value="infra">基建</option><option value="project">项目</option>
            </select></label>
            <label>上游端口<input id="pmPortUp" type="number" placeholder="留空自动 127xx；可填已有端口如 8188"></label>
            <label>对外端口<input id="pmPortExt" type="number" placeholder="留空自动 181xx"></label>
        </div>
        <div class="pm-checks">
            <label><input type="checkbox" id="pmPortNginx" checked> 启用 nginx</label>
            <label><input type="checkbox" id="pmPortWeb" checked> 挂到主页</label>
        </div>
        <div class="pj-actions">
            <button class="vb" onclick="pmCreatePort()">创建端口映射</button>
            <button class="vb" onclick="pmHideForms()">取消</button>
        </div>
    </div>`;
}

function drawPm() {
    const screen = getActiveScreen();
    if (!screen || !isActive('pm') || !pmState.data) return;
    const d = pmState.data;
    const repos = d.projects.filter(p => p.repo_path);
    const ports = d.projects.filter(p => p.upstream_port != null || p.external_port != null);
    const listeningCount = ports.filter(p => p.upstreamListening).length;
    const forwardCount = ports.filter(p => p.nginxState === 'forwarding' || p.nginxState === 'manual').length;

    screen.innerHTML = `<div class="pm-app">
        <header class="agg-top">
            <span class="pj-title">🛠 项目管理器</span>
            <span class="agg-sub">仓库 ${repos.length} · 端口 ${ports.length} · 上游 ${d.ranges.upstream[0]}-${d.ranges.upstream[1]} · 对外 ${d.ranges.external[0]}-${d.ranges.external[1]}</span>
            <span class="agg-grow"></span>
            ${applyBadge(d.apply)}
            <button class="vb" onclick="pmSync()" title="刷新所有仓库的 git 状态">同步 git</button>
            <button class="vb" onclick="pmApply()">重新应用 nginx</button>
            <button class="vb" onclick="pmNewProject()">+ 新建项目</button>
        </header>
        ${pmState.notice ? `<div class="pm-notice">${escHtml(pmState.notice)}</div>` : ''}
        ${pmState.showProjectForm ? projectFormHtml() : ''}

        <div class="pm-cols">
            <section class="pm-col">
                <div class="pm-col-hd">
                    <h2>📦 仓库管理</h2><span class="pm-col-cnt">${repos.length}</span>
                    <span class="pm-col-actions">
                        <button class="vb" onclick="pmScan('repos')">扫描仓库</button>
                        <button class="vb" onclick="pmNewRepo()">+ 仓库</button>
                    </span>
                </div>
                ${pmState.showRepoForm ? repoFormHtml() : ''}
                <div class="pm-list">${repos.length ? repos.map(repoRowHtml).join('') : '<div class="pm-empty">还没有仓库。点「扫描仓库」或「+ 仓库」。</div>'}</div>
            </section>

            <section class="pm-col">
                <div class="pm-col-hd">
                    <h2>🔌 端口映射注册表</h2><span class="pm-col-cnt">${ports.length} 条 · ${listeningCount} 监听 · ${forwardCount} 转发</span>
                    <span class="pm-col-actions">
                        <button class="vb" onclick="pmScan('ports')">扫描运行服务</button>
                        <button class="vb" onclick="pmNewPort()">+ 注册端口</button>
                    </span>
                </div>
                ${pmState.showPortForm ? portFormHtml() : ''}
                ${ports.length ? `<div class="pm-table-wrap">
                    <table class="pm-table">
                        <colgroup>
                            <col style="width:26%"><col style="width:146px"><col style="width:20px">
                            <col style="width:72px"><col style="width:78px"><col style="width:90px"><col style="width:136px">
                        </colgroup>
                        <thead><tr>
                            <th>项目</th><th class="pm-num">上游端口</th><th></th><th class="pm-num">对外端口</th>
                            <th>监听</th><th>nginx</th><th></th>
                        </tr></thead>
                        <tbody>${ports.map(portRowHtml).join('')}</tbody>
                    </table>
                </div>` : '<div class="pm-empty">注册表为空。点「扫描运行服务」或「+ 注册端口」。</div>'}
            </section>
        </div>

        <div class="pm-foot">仓库与端口互相独立：左侧删除仓库不会删端口，右侧移除端口不会删仓库；两边都为空时条目自动移除。远端仓库需先在 GitHub/Gitee 创建。</div>
    </div>`;
}

function remoteWarning(r) {
    if (!r) return '';
    const bad = [];
    if (!r.github?.ok) bad.push(`GitHub ${r.github?.error || '失败'}`);
    if (!r.gitee?.ok) bad.push(`Gitee ${r.gitee?.error || '失败'}`);
    if (r.pushed) {
        if (!r.pushed.github?.ok) bad.push(`推送 GitHub 失败`);
        if (!r.pushed.gitee?.ok) bad.push(`推送 Gitee 失败`);
    }
    return bad.length ? `；远端：${bad.join('；')}` : '';
}

function pmSlugSync(name, which) {
    const el = document.getElementById(which === 'repo' ? 'pmRepoSlug' : which === 'port' ? 'pmPortSlug' : 'pmProjectSlug');
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

function pmHideForms() {
    pmState.showRepoForm = false;
    pmState.showPortForm = false;
    pmState.showProjectForm = false;
    pmState.portTarget = null;
    drawPm();
}

function pmNewRepo() {
    pmState.showRepoForm = true;
    pmState.showPortForm = false;
    pmState.showProjectForm = false;
    pmState.portTarget = null;
    pmState.notice = '';
    drawPm();
}

function pmNewPort() {
    pmState.showPortForm = true;
    pmState.showRepoForm = false;
    pmState.showProjectForm = false;
    pmState.portTarget = null;
    pmState.notice = '';
    drawPm();
}

function pmAddPort(id) {
    pmState.showPortForm = true;
    pmState.showRepoForm = false;
    pmState.showProjectForm = false;
    pmState.portTarget = id;
    pmState.notice = '';
    drawPm();
}

function pmNewProject() {
    pmState.showProjectForm = true;
    pmState.showRepoForm = false;
    pmState.showPortForm = false;
    pmState.portTarget = null;
    pmState.notice = '';
    drawPm();
}

async function pmCreateProject() {
    if (pmState.busy) return;
    const name = document.getElementById('pmProjectName')?.value.trim();
    const slug = document.getElementById('pmProjectSlug')?.value.trim();
    const kind = document.getElementById('pmProjectKind')?.value || 'project';
    const up = document.getElementById('pmProjectUp')?.value;
    const ext = document.getElementById('pmProjectExt')?.value;
    const createRepo = document.getElementById('pmProjectRepo')?.checked;
    const managePorts = document.getElementById('pmProjectPorts')?.checked;
    const nginxEnabled = document.getElementById('pmProjectNginx')?.checked;
    const webEnabled = document.getElementById('pmProjectWeb')?.checked;
    if (!name) { alert('请填写项目名'); return; }
    if (!createRepo && !managePorts) { alert('至少选择「建仓库」或「注册端口」之一'); return; }

    pmState.busy = true;
    try {
        const res = await pmWrite('', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name, slug: slug || undefined, kind,
                upstreamPort: up || undefined, externalPort: ext || undefined,
                createRepo, managePorts, nginxEnabled, webEnabled,
            }),
        });
        const data = await res.json();
        pmState.showProjectForm = false;
        pmState.notice = `已注册 ${data.project.slug}${data.project.external_port ? `：127.0.0.1:${data.project.upstream_port} ↳ ${data.project.external_port}` : ''}${remoteWarning(data.remotes)}`;
        await pmReload();
        pmReloadSoon();
    } catch (e) {
        alert('创建项目失败: ' + e.message);
    } finally { pmState.busy = false; }
}

async function pmCreateRepo() {
    if (pmState.busy) return;
    const name = document.getElementById('pmRepoName')?.value.trim();
    const slug = document.getElementById('pmRepoSlug')?.value.trim();
    const dualRemote = document.getElementById('pmRepoDual')?.checked;
    const managePorts = document.getElementById('pmRepoPorts')?.checked;
    const nginxEnabled = document.getElementById('pmRepoNginx')?.checked;
    const webEnabled = document.getElementById('pmRepoWeb')?.checked;
    if (!name) { alert('请填写仓库名'); return; }
    pmState.busy = true;
    try {
        const res = await pmWrite('', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name, slug: slug || undefined, createRepo: true, managePorts,
                dualRemote, nginxEnabled, webEnabled,
            }),
        });
        const data = await res.json();
        pmState.showRepoForm = false;
        pmState.notice = `已创建仓库 ${data.project.slug}：${data.project.repo_path}` +
            (data.project.upstream_port ? `；端口 127.0.0.1:${data.project.upstream_port} ↳ ${data.project.external_port}` : '（未注册端口）') +
            remoteWarning(data.remotes);
        await pmReload();
        pmReloadSoon();
    } catch (e) {
        alert('创建仓库失败: ' + e.message);
    } finally { pmState.busy = false; }
}

async function pmCreatePort() {
    if (pmState.busy) return;
    const up = document.getElementById('pmPortUp')?.value;
    const ext = document.getElementById('pmPortExt')?.value;
    const nginxEnabled = document.getElementById('pmPortNginx')?.checked;
    const webEnabled = document.getElementById('pmPortWeb')?.checked;
    const target = pmState.portTarget;
    pmState.busy = true;
    try {
        let res;
        if (target) {
            res = await pmWrite('/' + target, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ upstreamPort: up || '', externalPort: ext || '', nginxEnabled, webEnabled }),
            });
        } else {
            const name = document.getElementById('pmPortName')?.value.trim();
            const slug = document.getElementById('pmPortSlug')?.value.trim();
            const kind = document.getElementById('pmPortKind')?.value || 'service';
            if (!name) { alert('请填写名称'); return; }
            res = await pmWrite('', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name, slug: slug || undefined, kind, createRepo: false, managePorts: true,
                    upstreamPort: up || undefined, externalPort: ext || undefined, nginxEnabled, webEnabled,
                }),
            });
        }
        const data = await res.json();
        pmState.showPortForm = false;
        pmState.portTarget = null;
        pmState.notice = `端口已保存：127.0.0.1:${data.project.upstream_port} ↳ ${data.project.external_port}`;
        await pmReload();
        pmReloadSoon();
    } catch (e) {
        alert('保存端口失败: ' + e.message);
    } finally { pmState.busy = false; }
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
    } finally { pmState.busy = false; }
}

async function pmRemoveRepo(id) {
    if (!confirm('把这个仓库移出管理？端口映射会保留。')) return;
    if (pmState.busy) return;
    pmState.busy = true;
    try {
        await pmWrite(`/${id}/repo`, { method: 'DELETE' });
        pmState.notice = '仓库已移出（端口保留）';
        await pmReload();
        pmReloadSoon();
    } catch (e) { alert('移除仓库失败: ' + e.message); } finally { pmState.busy = false; }
}

async function pmRemovePorts(id) {
    if (!confirm('移除这个端口映射？仓库会保留。')) return;
    if (pmState.busy) return;
    pmState.busy = true;
    try {
        await pmWrite(`/${id}/ports`, { method: 'DELETE' });
        pmState.notice = '端口映射已移除（仓库保留）';
        await pmReload();
        pmReloadSoon();
    } catch (e) { alert('移除端口失败: ' + e.message); } finally { pmState.busy = false; }
}

async function pmScan(what) {
    if (pmState.busy) return;
    pmState.busy = true;
    pmState.notice = `扫描${what === 'repos' ? '仓库' : '端口'}中…`;
    drawPm();
    try {
        const res = await pmWrite(`/scan?what=${what}`, { method: 'POST' });
        const r = await res.json();
        pmState.notice = `扫描完成：新增 ${r.created.length}，跳过 ${r.skipped.length}${r.synced ? `，同步 git ${r.synced}` : ''}`;
        await pmReload();
        pmReloadSoon();
    } catch (e) {
        pmState.notice = '扫描失败: ' + e.message;
        drawPm();
    } finally { pmState.busy = false; }
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
    } finally { pmState.busy = false; }
}

async function pmApply() {
    if (pmState.busy) return;
    pmState.busy = true;
    try {
        await pmWrite('/apply', { method: 'POST' });
        pmReloadSoon();
    } catch (e) { alert('应用失败: ' + e.message); } finally { pmState.busy = false; }
}

registerApp('pm', { render: renderPmApp });

Object.assign(window, {
    pmNewProject, pmCreateProject, pmNewRepo, pmNewPort, pmAddPort, pmHideForms, pmCreateRepo, pmCreatePort,
    pmToggle, pmRemoveRepo, pmRemovePorts, pmScan, pmSync, pmApply, pmReload, pmSlugSync,
});
