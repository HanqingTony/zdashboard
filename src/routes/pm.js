// src/routes/pm.js — 项目管理器
//
// 一个条目可独立拥有：仓库（repo_path）、端口映射（upstream→external）、或两者。
//   POST /api/pm            新建/附着仓库、分配端口
//   POST /api/pm/scan       扫描本机仓库 + 已知运行服务，补建条目
//   POST /api/pm/sync       刷新 git 派生字段
//   PATCH/DELETE /api/pm/:id
//   POST /api/pm/apply      重写 nginx 期望状态
//   GET  /api/pm            列表 + nginx 应用状态
//   GET  /api/nav           黄页 + 托管项目
//
// 写操作依赖可选的全局 AUTH_TOKEN（app.js 中间件）；未启用时任何内网设备都可写。

import { Router } from 'express';
import { readFileSync, statSync, existsSync } from 'fs';
import { resolve, sep } from 'path';
import * as store from '../pm/store.js';
import { allocatePorts, listeningPorts, externalInOtherConf, activeMappings } from '../pm/ports.js';
import { slugify, validateSlug, repoPathFor, createRepo, repoInfo } from '../pm/repo.js';
import { writeManagedState, readApplyStatus, navUrl } from '../pm/nginx.js';
import { scanAndImport, syncRepos } from '../pm/scan.js';
import {
  PUBLIC_DIR, PM_REPO_ROOT,
  PM_UPSTREAM_MIN, PM_UPSTREAM_MAX, PM_EXTERNAL_MIN, PM_EXTERNAL_MAX,
} from '../config.js';

const router = Router();
const idOf = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const bool = v => v ? 1 : 0;

function enrich(p, listening, active) {
  const mappedUp = p.external_port != null ? active.get(p.external_port) : null;
  let nginxState = 'off';
  if (mappedUp != null) {
    nginxState = mappedUp === p.upstream_port ? (p.nginx_enabled ? 'forwarding' : 'manual') : 'conflict';
  } else if (p.nginx_enabled) {
    nginxState = 'pending';
  }
  return {
    ...p,
    nginx_enabled: !!p.nginx_enabled,
    web_enabled: !!p.web_enabled,
    dual_remote: !!p.dual_remote,
    repo_created: !!p.repo_created,
    upstreamListening: p.upstream_port != null && listening.has(p.upstream_port),
    nginxState,
    nginxMappedUpstream: mappedUp ?? null,
    repo: p.repo_path ? {
      exists: existsSync(p.repo_path),
      dualPush: !!p.dual_remote,
      last_commit_at: p.last_commit_at,
      last_commit_subject: p.last_commit_subject,
      dirty: p.dirty,
      ahead: p.ahead,
      synced_at: p.synced_at,
    } : null,
    url: navUrl(p),
  };
}

async function snapshot() {
  const listening = await listeningPorts();
  const active = activeMappings();
  return {
    projects: store.list().map(p => enrich(p, listening, active)),
    ranges: {
      upstream: [PM_UPSTREAM_MIN, PM_UPSTREAM_MAX],
      external: [PM_EXTERNAL_MIN, PM_EXTERNAL_MAX],
    },
    apply: readApplyStatus(),
    repoRoot: PM_REPO_ROOT,
  };
}

router.get('/api/pm', async (req, res, next) => {
  try { res.json(await snapshot()); } catch (e) { next(e); }
});

router.post('/api/pm', async (req, res) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: '缺少 name' });

    const slug = slugify(body.slug || name);
    if (!validateSlug(slug)) {
      return res.status(400).json({ error: 'slug 需为 2-40 位小写字母/数字/连字符，且以字母开头' });
    }
    if (store.findBySlug(slug)) return res.status(409).json({ error: `slug 已存在: ${slug}` });

    const createRepoFlag = body.createRepo !== false;
    const managePorts = body.managePorts !== false;
    if (createRepoFlag && body.repoPath) {
      return res.status(400).json({ error: 'createRepo=true 时不能同时指定 repoPath；附着已有仓库请设 createRepo=false' });
    }
    const kind = ['repo', 'service', 'software', 'infra', 'project'].includes(body.kind) ? body.kind : 'project';

    let repoPath = null;
    let repoCreated = 0;
    let dualRemote = body.dualRemote !== false;

    if (createRepoFlag) {
      const target = repoPathFor(slug);
      if (existsSync(target)) return res.status(409).json({ error: `仓库目录已存在: ${target}` });
      const ports = managePorts
        ? await allocatePorts({ upstreamPort: body.upstreamPort, externalPort: body.externalPort })
        : { upstreamPort: null, externalPort: null };
      const repo = await createRepo({
        slug, name, upstreamPort: ports.upstreamPort ?? 0,
        externalPort: ports.externalPort ?? 0, dualRemote,
      });
      repoPath = repo.repoPath;
      repoCreated = 1;

      const row = store.create({
        slug, name, kind,
        repo_path: repoPath, repo_created: 1, dual_remote: bool(dualRemote),
        upstream_port: ports.upstreamPort, external_port: ports.externalPort,
        nginx_enabled: bool(managePorts && body.nginxEnabled !== false),
        web_enabled: bool(managePorts && body.webEnabled !== false),
        pinned: bool(body.pinned), source: 'manual', note: String(body.note || '').slice(0, 500) || null,
      });
      const info = await repoInfo(repoPath);
      store.saveGitMany([{
        id: row.id, last_commit_at: info.last_commit_at || null,
        last_commit_subject: info.last_commit_subject || null,
        dirty: info.dirty ?? 0, ahead: info.ahead ?? 0,
        dual_remote: info.dualPush ? 1 : 0,
      }]);
      writeManagedState(store.list());
      const listening = await listeningPorts();
      console.log(`[pm] 新建 ${slug}: repo=${repoPath} 127.0.0.1:${row.upstream_port ?? '-'} → :${row.external_port ?? '-'}`);
      return res.json({ ok: true, project: enrich(store.get(row.id), listening, activeMappings()), apply: readApplyStatus() });
    }

    // 附着已有仓库（扫描/导入）
    if (body.repoPath) {
      const root = resolve(PM_REPO_ROOT);
      const p = resolve(String(body.repoPath));
      if (p !== root && !p.startsWith(root + sep)) return res.status(400).json({ error: 'repoPath 越界' });
      if (!existsSync(p)) return res.status(400).json({ error: `repoPath 不存在: ${p}` });
      if (!existsSync(resolve(p, '.git'))) return res.status(400).json({ error: '不是 git 仓库' });
      repoPath = p;
      repoCreated = 0;
    }

    const ports = managePorts
      ? await allocatePorts({ upstreamPort: body.upstreamPort, externalPort: body.externalPort })
      : { upstreamPort: null, externalPort: null };

    const row = store.create({
      slug, name, kind,
      repo_path: repoPath, repo_created: 0, dual_remote: bool(dualRemote),
      upstream_port: ports.upstreamPort, external_port: ports.externalPort,
      nginx_enabled: bool(managePorts && body.nginxEnabled !== false),
      web_enabled: bool(managePorts && body.webEnabled !== false),
      pinned: bool(body.pinned), source: body.source || 'manual',
      note: String(body.note || '').slice(0, 500) || null,
    });
    writeManagedState(store.list());
    const listening = await listeningPorts();
    res.json({ ok: true, project: enrich(row, listening, activeMappings()), apply: readApplyStatus() });
  } catch (e) {
    const code = /UNIQUE|已存在/.test(e.message) ? 409 : /已占用|须在|无空闲|越界/.test(e.message) ? 400 : 500;
    res.status(code).json({ error: e.message });
  }
});

router.patch('/api/pm/:id', async (req, res) => {
  try {
    const id = idOf(req.params.id);
    if (!id) return res.status(400).json({ error: '无效 id' });
    const cur = store.get(id);
    if (!cur) return res.status(404).json({ error: 'not found' });

    const body = req.body || {};
    const patch = {};
    if ('name' in body) {
      const name = String(body.name || '').trim().slice(0, 80);
      if (!name) return res.status(400).json({ error: 'name 不能为空' });
      patch.name = name;
    }
    if ('kind' in body && ['repo', 'service', 'software', 'infra', 'project'].includes(body.kind)) patch.kind = body.kind;
    if ('note' in body) patch.note = String(body.note || '').slice(0, 500) || null;
    if ('nginxEnabled' in body) patch.nginxEnabled = bool(body.nginxEnabled);
    if ('webEnabled' in body) patch.webEnabled = bool(body.webEnabled);
    if ('pinned' in body) patch.pinned = bool(body.pinned);

    if ('upstreamPort' in body || 'externalPort' in body) {
      const ports = await allocatePorts({
        upstreamPort: 'upstreamPort' in body ? body.upstreamPort : cur.upstream_port,
        externalPort: 'externalPort' in body ? body.externalPort : cur.external_port,
        excludeId: id,
      });
      patch.upstreamPort = ports.upstreamPort;
      patch.externalPort = ports.externalPort;
    }

    const next = {
      ...cur,
      ...('nginxEnabled' in patch ? { nginx_enabled: patch.nginxEnabled } : {}),
      ...('webEnabled' in patch ? { web_enabled: patch.webEnabled } : {}),
      ...('upstreamPort' in patch ? { upstream_port: patch.upstreamPort } : {}),
      ...('externalPort' in patch ? { external_port: patch.externalPort } : {}),
    };
    if (next.nginx_enabled || next.web_enabled) {
      if (next.upstream_port == null || next.external_port == null) {
        return res.status(400).json({ error: '启用 nginx/主页前需要先配置上游与对外端口' });
      }
    }
    if (next.nginx_enabled && externalInOtherConf(next.external_port)
        && !(cur.nginx_enabled && cur.external_port === next.external_port)) {
      return res.status(409).json({ error: `对外端口 ${next.external_port} 已被其它 nginx 配置占用；请改用其它端口` });
    }

    const row = store.update(id, patch);
    writeManagedState(store.list());
    const listening = await listeningPorts();
    res.json({ ok: true, project: enrich(row, listening, activeMappings()), apply: readApplyStatus() });
  } catch (e) {
    const code = /已占用|须在|无空闲|UNIQUE/.test(e.message) ? 400 : 500;
    res.status(code).json({ error: e.message });
  }
});

// 解绑仓库（保留端口）；如果两边都没了则删除整条
router.delete('/api/pm/:id/repo', (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: '无效 id' });
  const row = store.get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  store.clearRepo(id);
  const after = store.get(id);
  if (after && after.upstream_port == null && after.external_port == null) store.remove(id);
  writeManagedState(store.list());
  res.json({ ok: true, slug: row.slug, removedRow: !store.get(id) });
});

// 解绑端口映射（保留仓库）；如果两边都没了则删除整条
router.delete('/api/pm/:id/ports', (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: '无效 id' });
  const row = store.get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  store.clearPorts(id);
  const after = store.get(id);
  if (after && !after.repo_path) store.remove(id);
  writeManagedState(store.list());
  res.json({ ok: true, slug: row.slug, removedRow: !store.get(id), apply: readApplyStatus() });
});

router.delete('/api/pm/:id', (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: '无效 id' });
  const row = store.get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  store.remove(id);
  writeManagedState(store.list());
  res.json({ ok: true, removed: row.slug, keptRepo: !!row.repo_path, apply: readApplyStatus() });
});

router.post('/api/pm/apply', (req, res) => {
  const state = writeManagedState(store.list());
  res.json({ ok: true, state, apply: readApplyStatus() });
});

router.post('/api/pm/sync', async (req, res, next) => {
  try {
    const r = await syncRepos();
    res.json({ ok: true, ...r, ...(await snapshot()) });
  } catch (e) { next(e); }
});

router.post('/api/pm/scan', async (req, res, next) => {
  try {
    const what = String(req.query.what || req.body?.what || 'all');
    if (!['all', 'repos', 'ports'].includes(what)) return res.status(400).json({ error: 'what 须为 all/repos/ports' });
    const r = await scanAndImport({ sync: true, what });
    writeManagedState(store.list());
    res.json({ ok: true, ...r, ...(await snapshot()) });
  } catch (e) { next(e); }
});

// ---------- 黄页：静态 nav.json + 托管项目 ----------
let navCache = { mtime: 0, data: null };

function readStaticNav() {
  const file = resolve(PUBLIC_DIR, 'nav.json');
  const mtime = statSync(file).mtimeMs;
  if (!navCache.data || navCache.mtime !== mtime) {
    navCache = { mtime, data: JSON.parse(readFileSync(file, 'utf8')) };
  }
  return { ...navCache.data, groups: [...(navCache.data.groups || [])] };
}

router.get('/api/nav', (req, res, next) => {
  try {
    const nav = readStaticNav();
    const managed = store.list()
      .filter(p => p.nginx_enabled && p.web_enabled && p.external_port)
      .map(p => ({
        name: p.name,
        url: navUrl(p),
        desc: `项目管理器 · 127.0.0.1:${p.upstream_port}${p.repo_path ? ' · ' + p.repo_path : ''}`,
        port: String(p.external_port),
        upstream: p.upstream_port != null ? String(p.upstream_port) : '',
        tags: ['managed'],
      }));
    if (managed.length) {
      nav.groups = [{ name: '我的项目', note: '由 zdashboard 项目管理器托管', items: managed }, ...nav.groups];
    }
    res.json(nav);
  } catch (e) { next(e); }
});

export { router as pmRouter };
