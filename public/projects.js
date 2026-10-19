// public/projects.js — 项目台账
import {
    apiFetch, escHtml, isActive, registerApp,
    updatePjBadge, renderProjectSidebar,
} from './core.js';
import {
    STATUSES as PJ_STATUS, LAYERS as PJ_LAYERS, KIND_LABELS as PJ_KINDS,
    GRADE_LABELS, LAYER, statusLabel, layerLabel,
} from './projects-meta.js';

// ========== 项目台账 ==========
const pjState = { data: null, filter: { kind: '', layer: '', grade: '', q: '' }, busy: false };
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
            ${pjChip(statusLabel(it.status))}
            ${it.layer ? pjChip(layerLabel(it.layer), 'dim') : ''}
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
        `${st.total} 条 · 在办 ${(st.byLayer.find(x => x.k === LAYER.L0) || {}).n || 0} · 想法 ${st.ideas}（待判 ${st.ideasNoVerdict}）· 风险 ${st.reposWithRisk}`;
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
    if (!isActive('projects')) return;
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
            <select class="vb" onchange="pjSet('layer', this.value)"><option value="">全部层</option>${PJ_LAYERS.map(l => `<option value="${escHtml(l)}" ${pjState.filter.layer === l ? 'selected' : ''}>${escHtml(layerLabel(l))}</option>`).join('')}</select>
            <select class="vb" onchange="pjSet('grade', this.value)"><option value="">全部档</option>${GRADE_LABELS.map(g => `<option ${pjState.filter.grade === g ? 'selected' : ''}>${g}</option>`).join('')}</select>
            <input class="pj-q" placeholder="搜索名称/备注/下一步…" value="${escHtml(pjState.filter.q)}" oninput="pjSet('q', this.value)">
        </div>
        <div id="pjBody"></div>
    </div>`;
    drawProjects();
    updatePjBadge(data.stats.ideasNoVerdict, data.stats.total);
    renderProjectSidebar(data.items);
}

function pjSet(k, v) {
    pjState.filter[k] = v;
    drawProjects();
}

async function pjReload() {
    pjState.data = await pjApi('');
    drawProjects();
    updatePjBadge(pjState.data.stats.ideasNoVerdict, pjState.data.stats.total);
    renderProjectSidebar(pjState.data.items);
}

async function pjVerdict(id, v) {
    try {
        await pjApi('/' + id, 'PATCH', { verdict: v });
        const it = pjState.data.items.find(x => x.id === id);
        if (it) it.verdict = v;
        const row = document.getElementById('pj-row-' + id);
        if (row && it) row.outerHTML = pjRowHtml(it);
        updatePjBadge(
            pjState.data.items.filter(x => x.kind === 'idea' && !x.verdict).length,
            pjState.data.stats.total,
        );
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

    // entries: [[value, label], ...]；value 存 code，label 只用于显示
    const sel = (name, cur, entries) => {
        const opts = entries.map(e => [...e]);
        if (cur && !opts.some(([v]) => v === cur)) opts.unshift([cur, cur]);   // 兼容历史/未知值
        return `<select data-f="${name}">${opts.map(([v, label]) => `<option value="${escHtml(v)}" ${v === cur ? 'selected' : ''}>${escHtml(label)}</option>`).join('')}</select>`;
    };
    box.innerHTML = `<div class="pj-editor">
        <label>下一步 / 交付物<input data-f="next_step" value="${escHtml(it.next_step || '')}"></label>
        <label>状态 ${sel('status', it.status || '', PJ_STATUS.map(v => [v, statusLabel(v)]))}</label>
        <label>层 ${sel('layer', it.layer || '', PJ_LAYERS.map(v => [v, layerLabel(v)]))}</label>
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


export function applyProjectsData(data) {
    pjState.data = data;
    updatePjBadge(data.stats.ideasNoVerdict, data.stats.total);
    renderProjectSidebar(data.items);
}

registerApp('projects', { render: renderProjectsApp });

Object.assign(window, {
    pjSet, pjVerdict, pjEdit, pjSave, pjDelete, pjSync, pjImport,
});
export { pjApi };
