// public/nav.js — 服务导航（黄页）
import { apiFetch, escHtml, safeUrl, isActive, registerApp } from './core.js';

// ========== 服务导航（黄页）==========
// 主页数据 = /api/nav（静态 nav.json + 项目管理器挂载的项目）
// 每次进入都重新取一次；PM 增删后回到主页即可看到新卡片。
async function loadNavData() {
    try {
        return await (await apiFetch('/api/nav')).json();
    } catch (e) {
        // 未配置全局 token / API 暂时不可用时退回静态黄页
        const res = await fetch('nav.json', { cache: 'no-store' });
        if (!res.ok) throw e;
        return res.json();
    }
}

function navItemHtml(it) {
    const tags = (it.tags || []).map(t => `<span class="ni-tag">${escHtml(t)}</span>`).join('');
    const shown = String(it.url || '').replace(/^https?:\/\//, '');
    const ports = (it.port || it.upstream)
        ? `<span class="ni-ports">${it.port ? `<b>${escHtml(it.port)}</b>` : ''}${it.upstream ? `<i>\u21b3${escHtml(it.upstream)}</i>` : ''}</span>`
        : '';
    return `<a class="ni" href="${escHtml(safeUrl(it.url))}" target="_blank" rel="noopener">
        <span class="ni-top"><span class="ni-name">${escHtml(it.name || '')}${tags}</span>${ports}</span>
        <span class="ni-desc">${escHtml(it.desc || '')}</span>
        <span class="ni-url">${escHtml(shown)}</span>
    </a>`;
}

async function renderNavApp(container) {
    container.innerHTML = '<div class="nav-app"><div class="nav-loading">载入服务导航…</div></div>';
    let data;
    try {
        data = await loadNavData();
    } catch (e) {
        container.innerHTML = `<div class="nav-app"><div class="nav-loading">加载 nav.json 失败：${escHtml(e.message)}</div></div>`;
        return;
    }
    if (!isActive('nav')) return;   // 期间已切走，丢弃过期渲染

    const groups = (data.groups || []).map(g => `
        <section class="nav-group">
            <h2 class="ng-title">${escHtml(g.name || '')}${g.note ? `<span class="ng-note">${escHtml(g.note)}</span>` : ''}</h2>
            <div class="ng-grid">${(g.items || []).map(navItemHtml).join('')}</div>
        </section>`).join('');

    container.innerHTML = `
        <div class="nav-app">
            <header class="nav-head">
                <h1>${escHtml(data.title || '服务导航')}</h1>
                ${data.subtitle ? `<p class="nav-sub">${escHtml(data.subtitle)}</p>` : ''}
            </header>
            ${groups}
            ${data.footer ? `<footer class="nav-foot">${escHtml(data.footer)}</footer>` : ''}
        </div>`;
}


registerApp('nav', { render: renderNavApp });
