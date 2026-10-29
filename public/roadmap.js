// public/roadmap.js — 路线图：个人目标 → 树形里程碑
import { apiFetch, escHtml, isActive, getActiveScreen, registerApp } from './core.js';

const GOAL_STATUS = {
    active: { label: '进行中', cls: 'active' },
    paused: { label: '暂停', cls: 'paused' },
    done: { label: '已完成', cls: 'done' },
};
const NODE_STATUS = {
    todo: { label: '待开始', cls: 'todo' },
    doing: { label: '进行中', cls: 'doing' },
    done: { label: '已完成', cls: 'done' },
    blocked: { label: '受阻', cls: 'blocked' },
};
const CATEGORIES = ['学习', '事业', '健康', '生活', '创作', '财务', '其他'];
const CAT_CLASS = {
    '学习': 'study', '事业': 'career', '健康': 'health',
    '生活': 'life', '创作': 'create', '财务': 'money', '其他': 'other',
};
const TODAY = () => {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

let rmState = { goals: [], nodes: [], stats: {} };
let rmSelectedGoal = null;
let rmCollapsed = new Set();
let rmSeq = 0;
let rmToastTimer = null;

// ========== API ==========
async function rmApi(path, opts = {}) {
    const init = { ...opts };
    if (init.body && !init.headers) init.headers = { 'Content-Type': 'application/json' };
    const res = await apiFetch(path, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
    return data;
}

async function loadRoadmap() {
    return rmApi('/api/roadmap');
}

// ========== 小工具 ==========
function goalOf(id) {
    return rmState.goals.find(g => g.id === Number(id)) || null;
}
function nodeOf(id) {
    return rmState.nodes.find(n => n.id === Number(id)) || null;
}
function goalStatus(s) {
    return GOAL_STATUS[s] || GOAL_STATUS.active;
}
function nodeStatus(s) {
    return NODE_STATUS[s] || NODE_STATUS.todo;
}
function isOverdue(date, status) {
    return !!date && status !== 'done' && date < TODAY();
}
function targetText(date) {
    return date || '未设日期';
}
function dateHtml(date, status) {
    return `<span class="rm-date ${isOverdue(date, status) ? 'overdue' : ''}">${escHtml(targetText(date))}</span>`;
}
function progressHtml(pct, cls = '') {
    return `<span class="rm-progress ${cls}"><span class="rm-progress-track"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></span><b>${pct}%</b></span>`;
}

function childrenMap(nodes) {
    const byId = new Map(nodes.map(n => [n.id, n]));
    const map = new Map();
    for (const n of nodes) {
        const parent = n.parent_id != null && byId.has(n.parent_id) ? n.parent_id : null;
        if (!map.has(parent)) map.set(parent, []);
        map.get(parent).push(n);
    }
    for (const arr of map.values()) {
        arr.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.id - b.id);
    }
    return map;
}

function goalProgress(goalId) {
    const nodes = rmState.nodes.filter(n => n.goal_id === Number(goalId));
    const done = nodes.filter(n => n.status === 'done').length;
    const goal = goalOf(goalId);
    const pct = nodes.length
        ? Math.round(done / nodes.length * 100)
        : (goal && goal.status === 'done' ? 100 : 0);
    return { done, total: nodes.length, pct };
}

function subtreeStats(nodes) {
    const byId = new Map(nodes.map(n => [n.id, n]));
    const children = childrenMap(nodes);
    const memo = new Map();

    function calc(id, seen = new Set()) {
        if (memo.has(id)) return memo.get(id);
        if (seen.has(id)) return { done: 0, total: 0 };
        const n = byId.get(id);
        if (!n) return { done: 0, total: 0 };
        seen.add(id);
        let done = n.status === 'done' ? 1 : 0;
        let total = 1;
        for (const child of children.get(id) || []) {
            const s = calc(child.id, seen);
            done += s.done;
            total += s.total;
        }
        seen.delete(id);
        const out = { done, total };
        memo.set(id, out);
        return out;
    }

    for (const n of nodes) calc(n.id);
    return { stats: memo, children };
}

function descendantsOf(nodes, id) {
    const children = childrenMap(nodes);
    const out = new Set([Number(id)]);
    const stack = [Number(id)];
    while (stack.length) {
        const cur = stack.pop();
        for (const child of children.get(cur) || []) {
            if (out.has(child.id)) continue;
            out.add(child.id);
            stack.push(child.id);
        }
    }
    return out;
}

// ========== 页面渲染 ==========
function goalCardHtml(g) {
    const p = goalProgress(g.id);
    const s = goalStatus(g.status);
    return `<button class="rm-goal ${g.id === rmSelectedGoal ? 'active' : ''} rm-goal-${s.cls}" type="button"
        onclick="roadmapSelectGoal(${g.id})" aria-pressed="${g.id === rmSelectedGoal}">
        <span class="rm-goal-top">
            <span class="rm-tag ${CAT_CLASS[g.category] || 'other'}">${escHtml(g.category)}</span>
            <span class="rm-goal-pct">${p.pct}%</span>
        </span>
        <span class="rm-goal-title">${escHtml(g.title)}</span>
        <span class="rm-goal-meta">${p.done}/${p.total} 里程碑 · ${escHtml(targetText(g.target_date))}</span>
        <span class="rm-goal-bar"><i style="width:${p.pct}%"></i></span>
    </button>`;
}

function goalListHtml() {
    if (!rmState.goals.length) {
        return `<div class="rm-side-empty">还没有目标。<br>从一个方向开始。</div>`;
    }
    return rmState.goals.map(goalCardHtml).join('');
}

function rootHtml(g) {
    const p = goalProgress(g.id);
    const s = goalStatus(g.status);
    return `<div class="rm-root rm-goal-${s.cls}">
        <div class="rm-root-top">
            <div class="rm-root-tags">
                <span class="rm-tag ${CAT_CLASS[g.category] || 'other'}">${escHtml(g.category)}</span>
                <span class="rm-status rm-status-${s.cls}">${escHtml(s.label)}</span>
                ${isOverdue(g.target_date, g.status) ? '<span class="rm-overdue">已过期</span>' : ''}
            </div>
            <div class="rm-root-actions">
                <button class="rm-btn rm-btn-ghost" type="button" onclick="roadmapOpenNode(null, ${g.id})">＋ 里程碑</button>
                <button class="rm-btn rm-btn-ghost" type="button" onclick="roadmapEditGoal(${g.id})">编辑</button>
                <button class="rm-btn rm-btn-ghost rm-danger" type="button" onclick="roadmapDeleteGoal(${g.id})">删除</button>
            </div>
        </div>
        <h2 class="rm-root-title">${escHtml(g.title)}</h2>
        ${g.description ? `<p class="rm-desc">${escHtml(g.description)}</p>` : ''}
        <div class="rm-root-foot">
            <span class="rm-root-meta">🎯 ${escHtml(targetText(g.target_date))}</span>
            <span class="rm-root-meta">${p.done}/${p.total} 里程碑</span>
            ${progressHtml(p.pct)}
        </div>
    </div>`;
}

function nodeHtml(n, goalId, tree) {
    const kids = tree.children.get(n.id) || [];
    const hasKids = kids.length > 0;
    const collapsed = rmCollapsed.has(n.id);
    const st = tree.stats.get(n.id) || { done: 0, total: 0 };
    const s = nodeStatus(n.status);
    const pct = st.total ? Math.round(st.done / st.total * 100) : 0;
    const carets = hasKids
        ? `<button class="rm-caret" type="button" title="${collapsed ? '展开' : '折叠'}" aria-label="${collapsed ? '展开' : '折叠'}里程碑" aria-expanded="${!collapsed}"
             onclick="roadmapToggleNode(${n.id})">${collapsed ? '▸' : '▾'}</button>`
        : '<span class="rm-caret rm-caret-leaf" aria-hidden="true"></span>';

    return `<div class="rm-branch">
        <div class="rm-node-row">
            ${carets}
            <div class="rm-node rm-node-${s.cls}">
                <div class="rm-node-main">
                    <span class="rm-dot rm-dot-${s.cls}"></span>
                    <span class="rm-node-title">${escHtml(n.title)}</span>
                    ${hasKids ? `<span class="rm-node-ratio">${st.done}/${st.total}</span>` : ''}
                    ${dateHtml(n.target_date, n.status)}
                </div>
                ${n.description ? `<p class="rm-node-desc">${escHtml(n.description)}</p>` : ''}
                ${hasKids ? `<div class="rm-node-progress">${progressHtml(pct)}</div>` : ''}
                <div class="rm-node-actions">
                    <select class="rm-select rm-select-sm rm-st-${s.cls}" onchange="roadmapSetNodeStatus(${n.id}, this.value)" aria-label="里程碑状态">
                        ${Object.entries(NODE_STATUS).map(([k, v]) => `<option value="${k}" ${k === n.status ? 'selected' : ''}>${v.label}</option>`).join('')}
                    </select>
                    <button class="rm-mini" type="button" onclick="roadmapOpenNode(${n.id}, ${goalId})">＋ 子项</button>
                    <button class="rm-mini" type="button" onclick="roadmapEditNode(${n.id})">编辑</button>
                    <button class="rm-mini rm-danger" type="button" onclick="roadmapDeleteNode(${n.id})">删除</button>
                </div>
            </div>
        </div>
        ${hasKids && !collapsed ? `<div class="rm-children">${kids.map(k => nodeHtml(k, goalId, tree)).join('')}</div>` : ''}
    </div>`;
}

function treeHtml(g) {
    const nodes = rmState.nodes.filter(n => n.goal_id === g.id);
    if (!nodes.length) {
        return `${rootHtml(g)}
        <div class="rm-empty-tree">
            <span class="rm-empty-mark">◇</span>
            <p>目标还没有被拆开。</p>
            <button class="rm-btn rm-btn-primary" type="button" onclick="roadmapOpenNode(null, ${g.id})">＋ 添加第一个里程碑</button>
        </div>`;
    }
    const tree = subtreeStats(nodes);
    const roots = tree.children.get(null) || [];
    return `${rootHtml(g)}
        <div class="rm-children rm-children-root">${roots.map(n => nodeHtml(n, g.id, tree)).join('')}</div>`;
}

function mainHtml() {
    if (!rmState.goals.length) {
        return `<div class="rm-empty">
            <span class="rm-empty-mark">◇</span>
            <h2>把想去的地方，画成一条路</h2>
            <p>先设定一个目标，再把它拆成可以完成的里程碑。</p>
            <button class="rm-btn rm-btn-primary" type="button" onclick="roadmapOpenGoal()">＋ 创建第一个目标</button>
        </div>`;
    }
    const g = goalOf(rmSelectedGoal) || rmState.goals[0];
    return `<div class="rm-canvas-head">
        <div><span class="rm-eyebrow">GOAL TREE</span><h2>目标视图</h2></div>
        <button class="rm-btn rm-btn-ghost" type="button" onclick="roadmapOpenGoal()">＋ 新目标</button>
    </div>
    <div class="rm-tree" data-goal="${g.id}">${treeHtml(g)}</div>`;
}

function paintRoadmap({ resetScroll = false } = {}) {
    if (!isActive('roadmap')) return;
    const screen = getActiveScreen();
    const old = resetScroll ? 0 : (screen.querySelector('.rm-scroll')?.scrollTop || 0);
    const stats = rmState.stats || {};
    screen.innerHTML = `<div class="rm-app">
        <header class="rm-head">
            <div class="rm-brand">
                <span class="rm-mark">◇</span>
                <div><h1>路线图</h1><p>目标 / 里程碑 / 下一步</p></div>
            </div>
            <div class="rm-kpis">
                <div class="rm-kpi"><b>${stats.goals || 0}</b><span>目标</span></div>
                <div class="rm-kpi"><b>${stats.doneNodes || 0}/${stats.nodes || 0}</b><span>里程碑</span></div>
                <div class="rm-kpi"><b>${stats.progress || 0}%</b><span>总完成度</span></div>
            </div>
            <button class="rm-btn rm-btn-primary" type="button" onclick="roadmapOpenGoal()">＋ 新目标</button>
        </header>
        <div class="rm-body">
            <aside class="rm-side">
                <div class="rm-side-head"><span>我的目标</span><b>${rmState.goals.length}</b></div>
                <div class="rm-goal-list">${goalListHtml()}</div>
                <button class="rm-side-add" type="button" onclick="roadmapOpenGoal()">＋ 新建目标</button>
            </aside>
            <main class="rm-main">
                <div class="rm-scroll">${mainHtml()}</div>
            </main>
        </div>
    </div>`;
    const sc = screen.querySelector('.rm-scroll');
    if (sc && old) sc.scrollTop = old;
}

async function refreshRoadmap() {
    const seq = ++rmSeq;
    try {
        const data = await loadRoadmap();
        if (seq !== rmSeq || !isActive('roadmap')) return;
        rmState = data;
        if (rmSelectedGoal == null || !rmState.goals.some(g => g.id === rmSelectedGoal)) {
            rmSelectedGoal = rmState.goals[0]?.id ?? null;
        }
        paintRoadmap();
    } catch (e) {
        if (seq !== rmSeq) return;
        if (!isActive('roadmap')) return;
        getActiveScreen().innerHTML = `<div class="rm-app"><div class="rm-error">
            <b>路线图加载失败</b><p>${escHtml(e.message)}</p>
            <button class="rm-btn rm-btn-primary" type="button" onclick="roadmapRetry()">重试</button>
        </div></div>`;
    }
}

async function renderRoadmap(container) {
    container.innerHTML = `<div class="rm-app"><div class="rm-loading">正在展开路线图…</div></div>`;
    await refreshRoadmap();
}

// ========== 选择 / 折叠 ==========
function roadmapSelectGoal(id) {
    rmSelectedGoal = Number(id);
    paintRoadmap({ resetScroll: true });
}

function roadmapToggleNode(id) {
    id = Number(id);
    if (rmCollapsed.has(id)) rmCollapsed.delete(id);
    else rmCollapsed.add(id);
    paintRoadmap();
}

// ========== 状态 / 删除 ==========
async function roadmapSetNodeStatus(id, status) {
    if (!NODE_STATUS[status]) return;
    try {
        await rmApi(`/api/roadmap/nodes/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
        await refreshRoadmap();
    } catch (e) {
        roadmapToast(e.message, true);
        await refreshRoadmap();
    }
}

async function roadmapDeleteGoal(id) {
    const g = goalOf(id);
    if (!g) return;
    if (!confirm(`删除目标「${g.title}」？\n它下面的所有里程碑也会一起删除。`)) return;
    try {
        await rmApi(`/api/roadmap/goals/${id}`, { method: 'DELETE' });
        rmSelectedGoal = null;
        roadmapToast('目标已删除');
        await refreshRoadmap();
    } catch (e) {
        roadmapToast(e.message, true);
    }
}

async function roadmapDeleteNode(id) {
    const n = nodeOf(id);
    if (!n) return;
    if (!confirm(`删除里程碑「${n.title}」？\n它的子里程碑也会一起删除。`)) return;
    try {
        await rmApi(`/api/roadmap/nodes/${id}`, { method: 'DELETE' });
        roadmapToast('里程碑已删除');
        await refreshRoadmap();
    } catch (e) {
        roadmapToast(e.message, true);
    }
}

// ========== 弹窗 ==========
function ensureDialog() {
    let dlg = document.getElementById('rmDialog');
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    dlg.id = 'rmDialog';
    dlg.className = 'rm-dialog';
    document.body.appendChild(dlg);
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    return dlg;
}

function openRoadmapDialog({ title, subtitle, body, submitText, onSubmit }) {
    const dlg = ensureDialog();
    if (dlg.open) dlg.close();
    dlg.innerHTML = `<form class="rm-form">
        <header class="rm-form-head">
            <h3>${escHtml(title)}</h3>
            ${subtitle ? `<p>${escHtml(subtitle)}</p>` : ''}
        </header>
        <div class="rm-form-body">${body}</div>
        <div class="rm-form-error" id="rmFormError" role="alert"></div>
        <footer class="rm-form-foot">
            <button class="rm-btn rm-btn-ghost" type="button" data-close>取消</button>
            <button class="rm-btn rm-btn-primary" type="submit">${escHtml(submitText)}</button>
        </footer>
    </form>`;
    const form = dlg.querySelector('form');
    const err = dlg.querySelector('#rmFormError');
    dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
    form.addEventListener('submit', async e => {
        e.preventDefault();
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = '保存中…';
        err.textContent = '';
        try {
            await onSubmit(new FormData(form));
            dlg.close();
            await refreshRoadmap();
        } catch (ex) {
            err.textContent = ex.message;
            btn.disabled = false;
            btn.textContent = submitText;
        }
    });
    dlg.showModal();
    setTimeout(() => form.querySelector('[name="title"]')?.focus(), 40);
}

function optionHtml(value, label, selected) {
    return `<option value="${escHtml(value)}" ${value === selected ? 'selected' : ''}>${escHtml(label)}</option>`;
}

function parentOptionsHtml(nodes, currentId, selectedParentId = null) {
    const exclude = currentId ? descendantsOf(nodes, currentId) : new Set();
    const children = childrenMap(nodes);
    const out = [];
    function walk(parent, depth) {
        for (const n of children.get(parent) || []) {
            if (exclude.has(n.id)) continue;
            out.push(`<option value="${n.id}" ${Number(selectedParentId) === n.id ? 'selected' : ''}>${escHtml('· '.repeat(depth) + n.title)}</option>`);
            walk(n.id, depth + 1);
        }
    }
    walk(null, 0);
    return `<option value="">（顶层里程碑）</option>${out.join('')}`;
}

function goalFormBody(g) {
    const category = g?.category || '其他';
    const status = g?.status || 'active';
    return `<div class="rm-field rm-field-full">
        <label for="rmTitle">目标名称</label>
        <input id="rmTitle" name="title" maxlength="200" required placeholder="例如：完成一次半程马拉松" value="${escHtml(g?.title || '')}">
    </div>
    <div class="rm-field">
        <label for="rmCategory">分类</label>
        <select id="rmCategory" name="category">${CATEGORIES.map(c => optionHtml(c, c, category)).join('')}</select>
    </div>
    <div class="rm-field">
        <label for="rmStatus">状态</label>
        <select id="rmStatus" name="status">${Object.entries(GOAL_STATUS).map(([k, v]) => optionHtml(k, v.label, status)).join('')}</select>
    </div>
    <div class="rm-field">
        <label for="rmDate">目标日期</label>
        <input id="rmDate" name="targetDate" type="date" value="${escHtml(g?.target_date || '')}">
    </div>
    <div class="rm-field rm-field-full">
        <label for="rmDesc">描述</label>
        <textarea id="rmDesc" name="description" rows="4" maxlength="4000" placeholder="为什么想完成它？完成后是什么样子？">${escHtml(g?.description || '')}</textarea>
    </div>`;
}

function goalPayload(fd) {
    return {
        title: String(fd.get('title') || '').trim(),
        category: String(fd.get('category') || '其他'),
        status: String(fd.get('status') || 'active'),
        targetDate: String(fd.get('targetDate') || ''),
        description: String(fd.get('description') || '').trim(),
    };
}

function roadmapOpenGoal() {
    openRoadmapDialog({
        title: '新建目标',
        subtitle: '先定方向，再拆步骤。',
        body: goalFormBody(null),
        submitText: '创建目标',
        onSubmit: async fd => {
            const payload = goalPayload(fd);
            if (!payload.title) throw new Error('目标名称不能为空');
            await rmApi('/api/roadmap/goals', { method: 'POST', body: JSON.stringify(payload) });
            roadmapToast('目标已创建');
        },
    });
}

function roadmapEditGoal(id) {
    const g = goalOf(id);
    if (!g) return;
    openRoadmapDialog({
        title: '编辑目标',
        subtitle: '调整方向，也调整节奏。',
        body: goalFormBody(g),
        submitText: '保存',
        onSubmit: async fd => {
            const payload = goalPayload(fd);
            if (!payload.title) throw new Error('目标名称不能为空');
            await rmApi(`/api/roadmap/goals/${g.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
            roadmapToast('目标已更新');
        },
    });
}

function nodeFormBody({ node = null, parent = null, goal = null, nodes = [] } = {}) {
    const status = node?.status || 'todo';
    const parentField = node
        ? `<div class="rm-field rm-field-full">
            <label for="rmParent">上级里程碑</label>
            <select id="rmParent" name="parentId">${parentOptionsHtml(nodes, node.id, node.parent_id)}</select>
            <small>可以移动分支；不能移动到自身或子节点下。</small>
        </div>`
        : `<div class="rm-field rm-field-full">
            <label>上级里程碑</label>
            <div class="rm-readonly">${parent ? escHtml(parent.title) : '（目标的顶层里程碑）'}</div>
            <input type="hidden" name="parentId" value="${parent ? parent.id : ''}">
        </div>`;
    return `<div class="rm-field rm-field-full">
        <label for="rmNodeTitle">里程碑名称</label>
        <input id="rmNodeTitle" name="title" maxlength="200" required placeholder="例如：完成 10 公里耐力跑" value="${escHtml(node?.title || '')}">
    </div>
    <div class="rm-field">
        <label for="rmNodeStatus">状态</label>
        <select id="rmNodeStatus" name="status">${Object.entries(NODE_STATUS).map(([k, v]) => optionHtml(k, v.label, status)).join('')}</select>
    </div>
    <div class="rm-field">
        <label for="rmNodeDate">目标日期</label>
        <input id="rmNodeDate" name="targetDate" type="date" value="${escHtml(node?.target_date || '')}">
    </div>
    ${parentField}
    <div class="rm-field rm-field-full">
        <label for="rmNodeDesc">备注</label>
        <textarea id="rmNodeDesc" name="description" rows="4" maxlength="4000" placeholder="完成标准、资源、下一步……">${escHtml(node?.description || '')}</textarea>
    </div>`;
}

function nodePayload(fd) {
    return {
        title: String(fd.get('title') || '').trim(),
        status: String(fd.get('status') || 'todo'),
        targetDate: String(fd.get('targetDate') || ''),
        parentId: String(fd.get('parentId') || '') || null,
        description: String(fd.get('description') || '').trim(),
    };
}

function roadmapOpenNode(parentId = null, goalId = null) {
    const goal = goalOf(goalId || rmSelectedGoal);
    if (!goal) return;
    const parent = parentId ? nodeOf(parentId) : null;
    openRoadmapDialog({
        title: parent ? '添加子里程碑' : '添加里程碑',
        subtitle: parent ? `挂在「${parent.title}」下` : `目标：${goal.title}`,
        body: nodeFormBody({ parent, goal }),
        submitText: '添加',
        onSubmit: async fd => {
            const payload = nodePayload(fd);
            if (!payload.title) throw new Error('里程碑名称不能为空');
            await rmApi('/api/roadmap/nodes', {
                method: 'POST',
                body: JSON.stringify({
                    ...payload,
                    goalId: goal.id,
                    parentId: parent ? parent.id : null,
                }),
            });
            roadmapToast('里程碑已添加');
        },
    });
}

function roadmapEditNode(id) {
    const node = nodeOf(id);
    if (!node) return;
    const goal = goalOf(node.goal_id);
    if (!goal) return;
    const nodes = rmState.nodes.filter(n => n.goal_id === goal.id);
    openRoadmapDialog({
        title: '编辑里程碑',
        subtitle: `目标：${goal.title}`,
        body: nodeFormBody({ node, goal, nodes }),
        submitText: '保存',
        onSubmit: async fd => {
            const payload = nodePayload(fd);
            if (!payload.title) throw new Error('里程碑名称不能为空');
            await rmApi(`/api/roadmap/nodes/${node.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
            roadmapToast('里程碑已更新');
        },
    });
}

// ========== Toast / 启动 ==========
function roadmapToast(message, bad = false) {
    let el = document.getElementById('rmToast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'rmToast';
        el.className = 'rm-toast';
        document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.toggle('bad', bad);
    el.classList.add('show');
    clearTimeout(rmToastTimer);
    rmToastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function roadmapRetry() {
    getActiveScreen().innerHTML = `<div class="rm-app"><div class="rm-loading">正在重试…</div></div>`;
    refreshRoadmap();
}

Object.assign(window, {
    roadmapSelectGoal, roadmapToggleNode, roadmapSetNodeStatus,
    roadmapOpenGoal, roadmapEditGoal, roadmapDeleteGoal,
    roadmapOpenNode, roadmapEditNode, roadmapDeleteNode, roadmapRetry,
});

registerApp('roadmap', {
    render: renderRoadmap,
    onLeave: () => document.getElementById('rmDialog')?.close(),
});
