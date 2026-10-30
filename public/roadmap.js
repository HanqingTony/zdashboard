// public/roadmap.js — 路线图：画布式思维导图
//
// 数据是 DAG：一个节点可以挂在多个愿景/项目下面。
// 布局只使用「第一条上级连线」作为主线，额外连线用虚线画出来，
// 这样既能保留树形导图的清晰度，也能表达“一个项目服务多个愿景”。

import { apiFetch, escHtml, isActive, getActiveScreen, registerApp } from './core.js';

const KIND = {
    vision: { label: '愿景', cls: 'vision' },
    project: { label: '项目', cls: 'project' },
    task: { label: '里程碑', cls: 'task' },
};
const KIND_RANK = { vision: 0, project: 1, task: 2 };
const STATUS = {
    todo: { label: '待开始', cls: 'todo' },
    doing: { label: '进行中', cls: 'doing' },
    done: { label: '已完成', cls: 'done' },
    blocked: { label: '受阻', cls: 'blocked' },
    paused: { label: '暂停', cls: 'paused' },
};
const PALETTE = ['#7c6cff', '#2ec4b6', '#ff8a5c', '#4aa3ff', '#f25f9c', '#f7c948', '#9b8cff', '#38d39f'];
const COL_W = 300;
const PAD_X = 48;
const PAD_Y = 34;
const SIB_GAP = 18;
const ROOT_GAP = 42;

let rmNodes = [];
let rmEdges = [];
let rmStats = {};
let rmLoaded = false;
let rmLoading = false;
let rmError = null;
let rmLayout = null;
let rmSelectedId = null;
let rmDialogState = null;
let rmZoom = 1;
let rmPan = { x: 0, y: 0 };
let rmFitDone = false;
let rmDrag = null;
let rmToastTimer = null;
let rmStageKey = '';

const TODAY = () => {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// ========== API ==========
async function rmApi(path, opts = {}) {
    const init = { ...opts };
    if (init.body && !init.headers) init.headers = { 'Content-Type': 'application/json' };
    const res = await apiFetch(path, init);
    return res.json().catch(() => ({}));
}

async function rmLoad() {
    if (rmLoading) return;
    rmLoading = true;
    rmError = null;
    rmLoaded = false;
    repaint();
    try {
        rmNodes = [];
        rmEdges = [];
        rmStats = {};
        const data = await rmApi('/api/roadmap');
        rmNodes = Array.isArray(data.nodes) ? data.nodes : [];
        rmEdges = Array.isArray(data.edges) ? data.edges : [];
        rmStats = data.stats || {};
        rmLoaded = true;
        rmFitDone = false;
        if (rmSelectedId != null && !rmNodes.some(n => n.id === rmSelectedId)) rmSelectedId = null;
    } catch (e) {
        rmError = e.message || '加载失败';
    } finally {
        rmLoading = false;
        repaint();
    }
}

// ========== 图形计算 ==========
function nodeSort(a, b) {
    return (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9)
        || (a.sortOrder || 0) - (b.sortOrder || 0)
        || a.id - b.id;
}
function nodeHeight(n) {
    return n.kind === 'vision' ? 70 : n.kind === 'project' ? 60 : 54;
}
function nodeWidth(n) {
    return n.kind === 'vision' ? 240 : n.kind === 'project' ? 214 : 196;
}

function nodeMaps() {
    const byId = new Map(rmNodes.map(n => [n.id, n]));
    const incoming = new Map(rmNodes.map(n => [n.id, []]));
    const outgoing = new Map(rmNodes.map(n => [n.id, []]));
    for (const e of rmEdges) {
        if (!byId.has(e.parentId) || !byId.has(e.childId)) continue;
        incoming.get(e.childId).push(e);
        outgoing.get(e.parentId).push(e);
    }
    for (const arr of incoming.values()) arr.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    for (const arr of outgoing.values()) arr.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    return { byId, incoming, outgoing };
}

function computeLayout() {
    const { byId, incoming, outgoing } = nodeMaps();
    const primary = new Map();
    const primaryEdgeIds = new Set();
    for (const n of rmNodes) {
        const e = incoming.get(n.id)[0];
        if (e) {
            primary.set(n.id, e.parentId);
            primaryEdgeIds.add(e.id);
        }
    }

    const children = new Map(rmNodes.map(n => [n.id, []]));
    for (const n of rmNodes) {
        const p = primary.get(n.id);
        if (p != null && children.has(p)) children.get(p).push(n);
    }
    for (const arr of children.values()) arr.sort(nodeSort);

    // 每个节点的后代进度（去重，兼容多上级 DAG）
    const progress = new Map();
    for (const n of rmNodes) {
        const seen = new Set();
        const stack = (outgoing.get(n.id) || []).map(e => e.childId);
        let done = 0;
        let total = 0;
        while (stack.length) {
            const id = stack.pop();
            if (seen.has(id)) continue;
            seen.add(id);
            const c = byId.get(id);
            if (!c) continue;
            total++;
            if (c.status === 'done') done++;
            for (const e of outgoing.get(id) || []) stack.push(e.childId);
        }
        progress.set(n.id, {
            done,
            total,
            pct: total ? Math.round(done / total * 100) : (n.status === 'done' ? 100 : 0),
            hasChildren: (outgoing.get(n.id) || []).length > 0,
        });
    }

    const roots = rmNodes.filter(n => !primary.has(n.id)).sort(nodeSort);
    const heights = new Map();
    const visiting = new Set();
    function treeHeight(id) {
        if (heights.has(id)) return heights.get(id);
        const n = byId.get(id);
        if (!n) return 0;
        if (visiting.has(id)) return nodeHeight(n);
        visiting.add(id);
        const kids = children.get(id) || [];
        let h = nodeHeight(n);
        if (kids.length) {
            let sum = 0;
            for (const kid of kids) sum += treeHeight(kid.id) + SIB_GAP;
            h = Math.max(h, sum - SIB_GAP);
        }
        visiting.delete(id);
        heights.set(id, h);
        return h;
    }

    const positions = new Map();
    const placed = new Set();
    let maxDepth = 0;
    function place(id, depth, top, color) {
        if (placed.has(id)) return;
        const n = byId.get(id);
        if (!n) return;
        placed.add(id);
        const h = nodeHeight(n);
        const w = nodeWidth(n);
        const kids = children.get(id) || [];
        let center = top + h / 2;
        if (kids.length) {
            let cursor = top;
            const centers = [];
            for (const kid of kids) {
                place(kid.id, depth + 1, cursor, color);
                const p = positions.get(kid.id);
                if (p) centers.push(p.y + p.h / 2);
                cursor += treeHeight(kid.id) + SIB_GAP;
            }
            if (centers.length) center = (centers[0] + centers[centers.length - 1]) / 2;
        }
        positions.set(id, { x: PAD_X + depth * COL_W, y: center - h / 2, w, h, color, depth });
        maxDepth = Math.max(maxDepth, depth);
    }

    let cursor = PAD_Y;
    let colorIndex = 0;
    for (const root of roots) {
        if (placed.has(root.id)) continue;
        const color = PALETTE[colorIndex++ % PALETTE.length];
        const h = treeHeight(root.id);
        place(root.id, 0, cursor, color);
        cursor += h + ROOT_GAP;
    }
    // 防御性兜底：如果数据里出现环，仍然把未放置节点当作根画出来。
    for (const n of [...rmNodes].sort(nodeSort)) {
        if (placed.has(n.id)) continue;
        const color = PALETTE[colorIndex++ % PALETTE.length];
        const h = treeHeight(n.id);
        place(n.id, 0, cursor, color);
        cursor += h + ROOT_GAP;
    }

    let right = 760;
    for (const p of positions.values()) right = Math.max(right, p.x + p.w + PAD_X);
    return {
        byId,
        incoming,
        children,
        progress,
        positions,
        primaryEdgeIds,
        width: Math.max(760, right),
        height: Math.max(480, cursor + PAD_Y),
        maxDepth,
    };
}

// ========== 小工具 ==========
function nodeOf(id) {
    return rmNodes.find(n => n.id === Number(id)) || null;
}
function kindOf(n) {
    return KIND[n?.kind] || KIND.project;
}
function statusOf(n) {
    return STATUS[n?.status] || STATUS.todo;
}
function dateText(date) {
    return date ? date.slice(5) : '';
}
function isOverdue(n) {
    return !!n?.targetDate && n.status !== 'done' && n.targetDate < TODAY();
}
function parentEdgesOf(id) {
    return rmEdges.filter(e => e.childId === Number(id))
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}
function childIdsOf(id) {
    return [...new Set(rmEdges.filter(e => e.parentId === Number(id)).map(e => e.childId))];
}
function descendantsOfClient(id) {
    const seen = new Set();
    const stack = childIdsOf(id);
    while (stack.length) {
        const cur = stack.pop();
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const e of rmEdges) if (e.parentId === cur) stack.push(e.childId);
    }
    return seen;
}
function applyTransform() {
    const canvas = document.getElementById('rmCanvas');
    if (canvas) canvas.style.transform = `translate(${rmPan.x}px, ${rmPan.y}px) scale(${rmZoom})`;
    const label = document.getElementById('rmZoomLabel');
    if (label) label.textContent = `${Math.round(rmZoom * 100)}%`;
}
function repaint() {
    if (!isActive('roadmap')) return;
    const el = getActiveScreen();
    if (el) paintInto(el);
}
function rmToast(message, bad = false) {
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
    rmToastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ========== 页面框架 ==========
function loadingHtml() {
    return `<div class="rm-app"><div class="rm-loading">正在打开路线图…</div></div>`;
}
function errorHtml() {
    return `<div class="rm-app"><div class="rm-error"><b>路线图加载失败</b><p>${escHtml(rmError || '未知错误')}</p><button class="rm-btn" onclick="rmRefresh()">重试</button></div></div>`;
}
function emptyHtml() {
    return `<div class="rm-empty">
        <div class="rm-empty-mark">✦</div>
        <h2>把愿景画成一张图</h2>
        <p>愿景是根，项目是枝，里程碑是叶。一个节点可以连到多个愿景；多条彩色分支就是你的多线发展。</p>
        <button class="rm-btn rm-btn-primary" onclick="rmOpenCreate('vision')">＋ 创建第一个愿景</button>
    </div>`;
}
function appHtml() {
    const selected = nodeOf(rmSelectedId);
    const canvas = rmLayout;
    const nodesHtml = rmNodes.map(n => {
        const p = canvas.positions.get(n.id);
        if (!p) return '';
        const kind = kindOf(n);
        const st = statusOf(n);
        const prog = canvas.progress.get(n.id) || { pct: 0, total: 0, hasChildren: false };
        const parentCount = (canvas.incoming.get(n.id) || []).length;
        const selectedCls = rmSelectedId === n.id ? ' is-selected' : '';
        const pct = prog.hasChildren ? `<span class="rm-node-pct">${prog.pct}%</span>` : '';
        const bar = prog.hasChildren ? `<span class="rm-node-bar"><i style="width:${prog.pct}%"></i></span>` : '';
        return `<button type="button" class="rm-node rm-kind-${kind.cls} rm-st-${st.cls}${selectedCls}"
            style="left:${p.x}px;top:${p.y}px;width:${p.w}px;height:${p.h}px;--rm-ac:${p.color}"
            data-node-id="${n.id}" title="${escHtml(n.description || n.title)}"
            onclick="rmSelect(event, ${n.id})" ondblclick="rmOpenEdit(${n.id})">
            <span class="rm-node-top">
                <span class="rm-node-kind">${kind.label}</span>
                ${n.category ? `<span class="rm-node-cat">${escHtml(n.category)}</span>` : ''}
                ${parentCount > 1 ? `<span class="rm-node-multi" title="关联 ${parentCount} 个上级">⇢${parentCount}</span>` : ''}
                <span class="rm-node-status"><i class="rm-dot"></i>${st.label}</span>
            </span>
            <span class="rm-node-title">${escHtml(n.title)}</span>
            <span class="rm-node-foot">
                ${n.targetDate ? `<span class="rm-node-date${isOverdue(n) ? ' overdue' : ''}">${escHtml(dateText(n.targetDate))}</span>` : '<span class="rm-node-date"></span>'}
                ${pct}
            </span>
            ${bar}
        </button>`;
    }).join('');

    const links = rmEdges.map(e => {
        const a = canvas.positions.get(e.parentId);
        const b = canvas.positions.get(e.childId);
        if (!a || !b) return '';
        const x1 = a.x + a.w;
        const y1 = a.y + a.h / 2;
        const x2 = b.x;
        const y2 = b.y + b.h / 2;
        const bend = Math.max(42, Math.abs(x2 - x1) * 0.48);
        const d = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
        const primary = canvas.primaryEdgeIds.has(e.id);
        return `<path class="rm-link ${primary ? 'is-primary' : 'is-extra'}" d="${d}" style="--rm-ac:${b.color || a.color}" vector-effect="non-scaling-stroke"></path>`;
    }).join('');

    const s = rmStats;
    return `<div class="rm-app">
        <header class="rm-head">
            <div class="rm-brand">
                <span class="rm-mark">✦</span>
                <div><h1>路线图</h1><p>MIND MAP · 多线愿景</p></div>
            </div>
            <div class="rm-kpis">
                <div class="rm-kpi"><b>${s.visions || 0}</b><span>愿景</span></div>
                <div class="rm-kpi"><b>${s.projects || 0}</b><span>项目</span></div>
                <div class="rm-kpi"><b>${s.tasks || 0}</b><span>里程碑</span></div>
                <div class="rm-kpi"><b>${s.progress || 0}%</b><span>完成度</span></div>
            </div>
            <div class="rm-actions">
                <button class="rm-btn rm-btn-primary" onclick="rmOpenCreate('vision')">＋ 愿景</button>
                <button class="rm-btn" onclick="rmOpenCreate('project')">＋ 项目</button>
                <button class="rm-btn rm-icon-btn" onclick="rmFit(true)" title="适应画布">⛶</button>
                <button class="rm-btn rm-icon-btn" onclick="rmRefresh()" title="刷新">↻</button>
            </div>
        </header>
        <div class="rm-body">
            <div class="rm-stage" id="rmStage">
                <div class="rm-canvas" id="rmCanvas" style="width:${canvas.width}px;height:${canvas.height}px">
                    <svg class="rm-links" width="${canvas.width}" height="${canvas.height}" aria-hidden="true">${links}</svg>
                    ${nodesHtml}
                </div>
                ${rmNodes.length ? '' : emptyHtml()}
                <div class="rm-legend">
                    <span><i class="rm-legend-vision"></i>愿景</span>
                    <span><i class="rm-legend-project"></i>项目</span>
                    <span><i class="rm-legend-task"></i>里程碑</span>
                    <span class="rm-legend-extra"><i></i>虚线=多愿景关联</span>
                </div>
                <div class="rm-zoombar">
                    <button type="button" onclick="rmZoomBy(-0.15)" title="缩小">−</button>
                    <span id="rmZoomLabel">100%</span>
                    <button type="button" onclick="rmZoomBy(0.15)" title="放大">＋</button>
                </div>
                <div class="rm-hint">拖动画布 · 滚轮缩放 · 双击节点编辑</div>
            </div>
            <aside class="rm-inspector${selected ? ' show' : ''}" id="rmInspector">${inspectorHtml(selected)}</aside>
        </div>
    </div>`;
}

function inspectorHtml(n) {
    if (!n) {
        return `<div class="rm-insp-empty">
            <div class="rm-insp-mark">✦</div>
            <h3>节点详情</h3>
            <p>点击画布上的节点查看详情。拖动画布平移，滚轮缩放，双击节点直接编辑。</p>
            <div class="rm-insp-guide">
                <span><b>愿景</b> 大目标 / 方向</span>
                <span><b>项目</b> 一条推进线</span>
                <span><b>里程碑</b> 可验收节点</span>
            </div>
        </div>`;
    }
    const kind = kindOf(n);
    const st = statusOf(n);
    const progress = rmLayout.progress.get(n.id) || { done: 0, total: 0, pct: 0, hasChildren: false };
    const parents = parentEdgesOf(n.id).map(e => nodeOf(e.parentId)).filter(Boolean);
    const childCount = childIdsOf(n.id).length;
    const desc = String(n.description || '').trim();
    const childKind = n.kind === 'vision' ? 'project' : 'task';
    return `<div class="rm-insp-top">
            <span class="rm-kind-tag rm-kind-${kind.cls}">${kind.label}</span>
            <button type="button" class="rm-insp-close" onclick="rmCloseInspector()" title="关闭">×</button>
        </div>
        <h2>${escHtml(n.title)}</h2>
        <div class="rm-insp-meta">
            <span class="rm-status rm-status-${st.cls}"><i class="rm-dot"></i>${st.label}</span>
            ${n.targetDate ? `<span class="rm-insp-date${isOverdue(n) ? ' overdue' : ''}">${escHtml(n.targetDate)}</span>` : ''}
            ${n.category ? `<span class="rm-insp-cat">${escHtml(n.category)}</span>` : ''}
        </div>
        ${desc ? `<p class="rm-insp-desc">${escHtml(desc)}</p>` : ''}
        <div class="rm-insp-block">
            <div class="rm-insp-label">分支进度 <b>${progress.hasChildren ? `${progress.done}/${progress.total} · ${progress.pct}%` : '暂无子节点'}</b></div>
            ${progress.hasChildren ? `<span class="rm-insp-track"><i style="width:${progress.pct}%"></i></span>` : ''}
        </div>
        <div class="rm-insp-block">
            <div class="rm-insp-label">上级节点 <b>${parents.length}${childCount ? ` · 直属下级 ${childCount}` : ''}</b></div>
            <div class="rm-insp-parents">
                ${parents.length ? parents.map(p => `<button type="button" class="rm-parent-chip" onclick="rmSelect(event, ${p.id})">${escHtml(p.title)}</button>`).join('') : '<span class="rm-muted">根节点（没有上级）</span>'}
            </div>
        </div>
        <div class="rm-insp-actions">
            <button class="rm-btn rm-btn-primary" onclick="rmOpenCreate('${childKind}', ${n.id})">＋ 子节点</button>
            <button class="rm-btn" onclick="rmOpenEdit(${n.id})">编辑</button>
            <button class="rm-btn rm-danger" onclick="rmDelete(${n.id})">删除</button>
        </div>
        <p class="rm-insp-note">删除只移除当前节点；它的子节点会断开并上移为根节点，不会跟着删除。</p>`;
}

// ========== 画布交互 ==========
function paintInto(el) {
    if (!rmLoaded) {
        el.innerHTML = rmError ? errorHtml() : loadingHtml();
        return;
    }
    // 断点/旋转会换一块屏；尺寸变了就重新 fit，避免沿用桌面端的平移量。
    const sizeKey = `${el.clientWidth}x${el.clientHeight}`;
    if (sizeKey !== rmStageKey) {
        rmStageKey = sizeKey;
        rmFitDone = false;
        if (el.clientWidth < 560) rmSelectedId = null;
    }
    rmLayout = computeLayout();
    el.innerHTML = appHtml();
    const stage = document.getElementById('rmStage');
    if (!stage) return;
    bindStage(stage);
    applyTransform();
    if (!rmFitDone) {
        const tryFit = () => {
            const s = document.getElementById('rmStage');
            if (!s) return;
            if (!s.clientWidth || !s.clientHeight) {
                requestAnimationFrame(tryFit);
                return;
            }
            rmFitDone = true;
            fitRoadmap(false);
        };
        requestAnimationFrame(tryFit);
    }
}
function bindStage(stage) {
    stage.addEventListener('pointerdown', stageDown);
    stage.addEventListener('wheel', stageWheel, { passive: false });
}
function stageDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest('.rm-node') || e.target.closest('button')) return;
    rmDrag = { x: e.clientX, y: e.clientY, px: rmPan.x, py: rmPan.y, moved: false };
    stageCapture(e.currentTarget, e.pointerId);
    e.currentTarget.classList.add('is-panning');
    e.preventDefault();
}
function stageCapture(stage, pointerId) {
    try { stage.setPointerCapture(pointerId); } catch { /* 忽略 */ }
    const move = e => {
        if (!rmDrag) return;
        const dx = e.clientX - rmDrag.x;
        const dy = e.clientY - rmDrag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) rmDrag.moved = true;
        rmPan = { x: rmDrag.px + dx, y: rmDrag.py + dy };
        applyTransform();
    };
    const up = e => {
        if (!rmDrag) return;
        const moved = rmDrag.moved;
        rmDrag = null;
        stage.classList.remove('is-panning');
        stage.removeEventListener('pointermove', move);
        stage.removeEventListener('pointerup', up);
        stage.removeEventListener('pointercancel', up);
        if (!moved && !e.target.closest('.rm-node') && !e.target.closest('button')) {
            rmSelectedId = null;
            repaint();
        }
    };
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
}
function stageWheel(e) {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    zoomAt(e.clientX, e.clientY, factor);
}
function zoomAt(clientX, clientY, factor) {
    const stage = document.getElementById('rmStage');
    if (!stage) return;
    const r = stage.getBoundingClientRect();
    const x = clientX - r.left;
    const y = clientY - r.top;
    const wx = (x - rmPan.x) / rmZoom;
    const wy = (y - rmPan.y) / rmZoom;
    rmZoom = Math.max(0.25, Math.min(2.4, rmZoom * factor));
    rmPan = { x: x - wx * rmZoom, y: y - wy * rmZoom };
    applyTransform();
}
function rmZoomBy(delta) {
    const stage = document.getElementById('rmStage');
    if (!stage) return;
    const r = stage.getBoundingClientRect();
    zoomAt(r.left + r.width / 2, r.top + r.height / 2, Math.exp(delta));
}
function fitRoadmap(markDone = true) {
    if (markDone) rmFitDone = true;
    const stage = document.getElementById('rmStage');
    if (!stage || !rmLayout) return;
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const pad = 54;
    // 手机屏放整张图会小到看不清：保留一个可读的最小缩放，从根节点附近开始平移。
    if (r.width < 560) {
        rmZoom = Math.max(0.5, Math.min(1, (r.width - pad) / rmLayout.width));
        rmPan = { x: 10, y: 10 };
        applyTransform();
        return;
    }
    const z = Math.min(1.2, (r.width - pad) / rmLayout.width, (r.height - pad) / rmLayout.height);
    rmZoom = Math.max(0.25, Math.min(1.5, z));
    rmPan = {
        x: (r.width - rmLayout.width * rmZoom) / 2,
        y: (r.height - rmLayout.height * rmZoom) / 2,
    };
    applyTransform();
}

// ========== 节点操作 ==========
function rmSelect(event, id) {
    if (event) event.stopPropagation();
    const n = nodeOf(id);
    if (!n) return;
    rmSelectedId = rmSelectedId === n.id ? null : n.id;
    repaint();
}
function rmCloseInspector() {
    rmSelectedId = null;
    repaint();
}
async function rmDelete(id) {
    const n = nodeOf(id);
    if (!n) return;
    const kids = childIdsOf(id).length;
    const hint = kids ? `\n\n它的 ${kids} 个直属下级不会删除，会断开并上移为根节点。` : '';
    if (!confirm(`删除「${n.title}」？${hint}`)) return;
    try {
        const data = await rmApi(`/api/roadmap/nodes/${id}`, { method: 'DELETE' });
        rmNodes = data.graph.nodes;
        rmEdges = data.graph.edges;
        rmStats = data.graph.stats;
        if (rmSelectedId === id) rmSelectedId = null;
        rmFitDone = false;
        repaint();
        rmToast('节点已删除');
    } catch (e) {
        rmToast(e.message || '删除失败', true);
    }
}

// ========== 创建 / 编辑弹窗 ==========
function ensureDialog() {
    let d = document.getElementById('rmDialog');
    if (!d) {
        d = document.createElement('dialog');
        d.id = 'rmDialog';
        d.className = 'rm-dialog';
        d.addEventListener('close', () => { rmDialogState = null; });
        document.body.appendChild(d);
    }
    return d;
}
function rmOpenCreate(kind = 'project', parentId = null) {
    rmDialogState = {
        mode: 'create',
        kind: KIND[kind] ? kind : 'project',
        parentId: parentId == null ? null : Number(parentId),
    };
    openDialog();
}
function rmOpenEdit(id) {
    const n = nodeOf(id);
    if (!n) return;
    rmDialogState = { mode: 'edit', id: n.id };
    openDialog();
}
function openDialog() {
    const d = ensureDialog();
    d.innerHTML = dialogHtml();
    if (!d.open) d.showModal();
    const input = d.querySelector('input[name="title"]');
    if (input) setTimeout(() => input.focus(), 30);
}
function rmCloseDialog() {
    const d = document.getElementById('rmDialog');
    if (d?.open) d.close();
    rmDialogState = null;
}
function parentOptionsHtml(excludeId, checkedIds) {
    const blocked = excludeId == null ? new Set() : descendantsOfClient(excludeId);
    const checked = new Set(checkedIds.map(Number));
    const list = rmNodes.filter(n => n.id !== excludeId).sort(nodeSort);
    if (!list.length) return '<span class="rm-muted">还没有其它节点</span>';
    return list.map(n => {
        const kind = kindOf(n);
        const dis = blocked.has(n.id);
        return `<label class="rm-parent-opt${dis ? ' disabled' : ''}">
            <input type="checkbox" class="rm-parent-check" value="${n.id}" ${checked.has(n.id) ? 'checked' : ''} ${dis ? 'disabled' : ''}>
            <span class="rm-parent-kind rm-kind-${kind.cls}">${kind.label}</span>
            <span class="rm-parent-name">${escHtml(n.title)}</span>
        </label>`;
    }).join('');
}
function dialogHtml() {
    const state = rmDialogState || { mode: 'create', kind: 'project', parentId: null };
    const n = state.mode === 'edit' ? nodeOf(state.id) : null;
    const kind = n?.kind || state.kind || 'project';
    const status = n?.status || 'todo';
    const parentIds = n
        ? parentEdgesOf(n.id).map(e => e.parentId)
        : (state.parentId != null ? [state.parentId] : []);
    const title = n?.title || '';
    const desc = n?.description || '';
    const category = n?.category || '';
    const targetDate = n?.targetDate || '';
    const heading = state.mode === 'edit' ? '编辑节点' : `新建${KIND[kind]?.label || '节点'}`;
    const sub = state.mode === 'edit'
        ? '可改类型、状态、日期，也可以重新选择上级节点。'
        : '节点可以没有上级（成为根节点），也可以同时关联多个上级。';
    const kindOpts = Object.entries(KIND).map(([k, v]) =>
        `<option value="${k}"${k === kind ? ' selected' : ''}>${v.label}</option>`).join('');
    const statusOpts = Object.entries(STATUS).map(([k, v]) =>
        `<option value="${k}"${k === status ? ' selected' : ''}>${v.label}</option>`).join('');
    return `<form class="rm-form" onsubmit="rmSubmit(event)">
        <div class="rm-form-head"><h3>${heading}</h3><p>${sub}</p></div>
        <div class="rm-form-body">
            <div class="rm-field rm-field-full">
                <label>标题</label>
                <input name="title" value="${escHtml(title)}" maxlength="200" required placeholder="例：个人自媒体自动化生产线">
            </div>
            <div class="rm-field">
                <label>类型</label>
                <select name="kind">${kindOpts}</select>
            </div>
            <div class="rm-field">
                <label>状态</label>
                <select name="status">${statusOpts}</select>
            </div>
            <div class="rm-field">
                <label>目标日期</label>
                <input type="date" name="targetDate" value="${escHtml(targetDate)}">
            </div>
            <div class="rm-field">
                <label>分类</label>
                <input name="category" value="${escHtml(category)}" maxlength="30" placeholder="事业 / 创作 / 健康">
            </div>
            <div class="rm-field rm-field-full">
                <label>描述</label>
                <textarea name="description" maxlength="4000" placeholder="这条线要做到什么程度？">${escHtml(desc)}</textarea>
            </div>
            <div class="rm-field rm-field-full">
                <label>上级节点 <small>可多选；列表靠前者作为主线布局，其余用虚线关联</small></label>
                <div class="rm-parent-list">${parentOptionsHtml(state.mode === 'edit' ? state.id : null, parentIds)}</div>
            </div>
        </div>
        <div class="rm-form-error" id="rmFormError"></div>
        <div class="rm-form-foot">
            <button type="button" class="rm-btn" onclick="rmCloseDialog()">取消</button>
            <button type="submit" class="rm-btn rm-btn-primary" id="rmSaveBtn">保存</button>
        </div>
    </form>`;
}
async function rmSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const state = rmDialogState;
    if (!state) return;
    const fd = new FormData(form);
    const parentIds = [...form.querySelectorAll('.rm-parent-check:checked')].map(el => Number(el.value));
    const body = {
        title: String(fd.get('title') || '').trim(),
        kind: String(fd.get('kind') || 'project'),
        status: String(fd.get('status') || 'todo'),
        targetDate: String(fd.get('targetDate') || '') || null,
        category: String(fd.get('category') || '').trim() || null,
        description: String(fd.get('description') || '').trim() || null,
        parentIds,
    };
    const errorEl = document.getElementById('rmFormError');
    const saveBtn = document.getElementById('rmSaveBtn');
    if (!body.title) {
        if (errorEl) errorEl.textContent = '标题不能为空';
        return;
    }
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中…'; }
    try {
        const data = state.mode === 'create'
            ? await rmApi('/api/roadmap/nodes', { method: 'POST', body: JSON.stringify(body) })
            : await rmApi(`/api/roadmap/nodes/${state.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        rmNodes = data.graph.nodes;
        rmEdges = data.graph.edges;
        rmStats = data.graph.stats;
        rmSelectedId = data.node.id;
        rmFitDone = state.mode !== 'create';
        rmCloseDialog();
        repaint();
        rmToast(state.mode === 'create' ? '节点已创建' : '已保存');
    } catch (err) {
        if (errorEl) errorEl.textContent = err.message || '保存失败';
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存'; }
    }
}

function rmRefresh() {
    if (rmLoading) return;
    rmLoaded = false;
    rmSelectedId = null;
    rmError = null;
    rmLoad();
}

// ========== 应用注册 ==========
function render(el) {
    if (rmLoading) { el.innerHTML = loadingHtml(); return; }
    if (rmError) { el.innerHTML = errorHtml(); return; }
    if (!rmLoaded) { el.innerHTML = loadingHtml(); rmLoad(); return; }
    paintInto(el);
}

registerApp('roadmap', {
    render,
    onLeave() {
        if (rmDialogState) rmCloseDialog();
    },
});

Object.assign(window, {
    rmSelect, rmCloseInspector, rmOpenCreate, rmOpenEdit, rmDelete,
    rmFit: fitRoadmap, rmZoomBy, rmRefresh,
    rmCloseDialog, rmSubmit,
});
