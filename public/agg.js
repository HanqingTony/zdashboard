// public/agg.js — 信息聚合
import {
    apiFetch, escHtml, safeUrl, isActive, getActiveScreen, layout,
    registerApp, updateAggBadge,
} from './core.js';

// ========== 信息聚合 ==========
const aggState = { data: null, autoRefreshed: false, busy: false, sourceBusy: new Set() };

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
    const okMs = data.lastOkAt ? Date.parse(data.lastOkAt) : NaN;
    const tryMs = data.lastAttemptAt ? Date.parse(data.lastAttemptAt) : NaN;
    const okText = Number.isFinite(okMs) ? `上次成功 ${aggTimeAgo(data.lastOkAt)}` : '从未成功';
    const tryText = Number.isFinite(tryMs) && (!Number.isFinite(okMs) || tryMs - okMs > 60000)
        ? ` · 上次尝试 ${aggTimeAgo(data.lastAttemptAt)}` : '';
    return `${totalNew > 0 ? totalNew + ' 条未读' : '暂无未读'} · ${okText}${tryText}`;
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
    if (!isActive('agg')) return;   // 已离开聚合页：不要把未读数写回角标
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
    if (!isActive('agg')) return;
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
        if (isActive('agg')) drawAgg(screen, data);
    } catch (e) {
        if (aggState.data && isActive('agg')) drawAgg(screen, aggState.data);
        alert('刷新失败: ' + e.message);
    } finally {
        aggState.busy = false;
        layout();
    }
}

function ackAggRead({ keepalive = false } = {}) {
    if (!aggState.data) return;
    apiFetch('/api/agg/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
        keepalive,
    }).catch(() => {});
    aggState.data.sources.forEach(s => { s.newCount = 0; });
    updateAggBadge(0);
}


registerApp('agg', { render: renderAggApp, onLeave: () => ackAggRead() });

// 页面常驻时：每 5 分钟更新未读；在聚合页顺便刷新过期源
export function startAggPoll() {
    setInterval(async () => {
        if (document.visibilityState === 'hidden') return;
        try {
            const d = await aggFetch(false);
            updateAggBadge(d.totalNew || 0);
            if (!isActive('agg')) return;
            const queue = d.sources
                .filter(s => s.status !== 'unconfigured' && s.stale)
                .map(s => s.id);
            await Promise.all(Array.from({ length: Math.min(2, queue.length) }, async () => {
                for (;;) {
                    const id = queue.shift();
                    if (!id) return;
                    await refreshAgg(id);
                }
            }));
        } catch { /* 离线时保持旧数据 */ }
    }, 5 * 60 * 1000);

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && isActive('agg')) ackAggRead({ keepalive: true });
    });
    window.addEventListener('pagehide', () => {
        if (isActive('agg')) ackAggRead({ keepalive: true });
    });
}

Object.assign(window, { refreshAgg });
export { aggFetch, refreshAgg };
