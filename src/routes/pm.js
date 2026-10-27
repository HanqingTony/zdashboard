// src/routes/pm.js — 项目管理器
//
//  POST /api/pm                 新建：分配 127xx/181xx、建本地仓库、配置双远端、写 nginx 期望状态
//  PATCH /api/pm/:id            改 nginx/主页开关、名称、端口
//  DELETE /api/pm/:id           删除管理记录（仓库保留），同步移除 nginx 映射
//  POST /api/pm/apply           重新写一次 nginx 期望状态（path unit 会应用）
//  GET  /api/nav                黄页 + 托管项目（主页展示）
//
// 写操作需要 PM_TOKEN（X-PM-Token），或已启用全局 AUTH_TOKEN。

import { Router } from 'express';
import { timingSafeEqual } from 'crypto';
import { readFileSync, statSync, existsSync } from 'fs';
import { resolve } from 'path';
import * as store from '../pm/store.js';
import { allocatePorts, listeningPorts } from '../pm/ports.js';
import { slugify, validateSlug, repoPathFor, createRepo, repoInfo } from '../pm/repo.js';
import { writeManagedState, readApplyStatus, navUrl } from '../pm/nginx.js';
import {
  PUBLIC_DIR, AUTH_TOKEN, PM_TOKEN,
  PM_UPSTREAM_MIN, PM_UPSTREAM_MAX, PM_EXTERNAL_MIN, PM_EXTERNAL_MAX,
} from '../config.js';

const router = Router();

const idOf = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

function requirePmWrite(req, res, next) {
  if (AUTH_TOKEN) return next();               // 全局鉴权已在 app.js 完成
  if (!PM_TOKEN) {
    return res.status(403).json({ error: '写操作未启用：请配置 PM_TOKEN（或 AUTH_TOKEN）' });
  }
  const got = req.get('x-pm-token') || '';
  const a = Buffer.from(got);
  const b = Buffer.from(PM_TOKEN);
  if (a.length === b.length && timingSafeEqual(a, b)) return next();
  return res.status(401).json({ error: 'PM 管理口令无效' });
}

async function enrich(p, listening) {
  const repo = await repoInfo(p.repo_path);
  return {
    ...p,
    nginx_enabled: !!p.nginx_enabled,
    web_enabled: !!p.web_enabled,
    dual_remote: !!p.dual_remote,
    repo_created: !!p.repo_created,
    upstreamListening: listening.has(p.upstream_port),
    repo,
    url: navUrl(p),
  };
}

async function snapshot() {
  const listening = await listeningPorts();
  const projects = await Promise.all(store.list().map(p => enrich(p, listening)));
  return {
    projects,
    ranges: {
      upstream: [PM_UPSTREAM_MIN, PM_UPSTREAM_MAX],
      external: [PM_EXTERNAL_MIN, PM_EXTERNAL_MAX],
    },
    apply: readApplyStatus(),
    writeAuth: AUTH_TOKEN ? 'auth' : PM_TOKEN ? 'pm_token' : null,
  };
}

router.get('/api/pm', async (req, res, next) => {
  try { res.json(await snapshot()); } catch (e) { next(e); }
});

router.post('/api/pm', requirePmWrite, async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim().slice(0, 80);
    if (!name) return res.status(400).json({ error: '缺少 name' });

    const slug = slugify(body.slug || name);
    if (!validateSlug(slug)) {
      return res.status(400).json({ error: 'slug 需为 2-40 位小写字母/数字/连字符，且以字母开头' });
    }
    if (store.findBySlug(slug)) return res.status(409).json({ error: `slug 已存在: ${slug}` });

    const repoPath = repoPathFor(slug);
    const createRepoFlag = body.createRepo !== false;
    if (createRepoFlag && existsSync(repoPath)) {
      return res.status(409).json({ error: `仓库目录已存在: ${repoPath}` });
    }

    const ports = await allocatePorts({
      upstreamPort: body.upstreamPort,
      externalPort: body.externalPort,
    });

    let repo = null;
    if (createRepoFlag) {
      repo = await createRepo({
        slug, name,
        upstreamPort: ports.upstreamPort,
        externalPort: ports.externalPort,
        dualRemote: body.dualRemote !== false,
      });
    }

    const row = store.create({
      slug,
      name,
      repo_path: repo?.repoPath || repoPath,
      upstream_port: ports.upstreamPort,
      external_port: ports.externalPort,
      nginx_enabled: body.nginxEnabled === false ? 0 : 1,
      web_enabled: body.webEnabled === false ? 0 : 1,
      repo_created: createRepoFlag ? 1 : 0,
      dual_remote: body.dualRemote === false ? 0 : 1,
    });

    writeManagedState(store.list());
    const listening = await listeningPorts();
    console.log(`[pm] 新建 ${slug}: 127.0.0.1:${row.upstream_port} → :${row.external_port}${repo ? '（repo 已建）' : ''}`);
    res.json({ ok: true, project: await enrich(row, listening), apply: readApplyStatus() });
  } catch (e) {
    const code = /已存在|已占用|须在|无空闲|slug|UNIQUE/.test(e.message) ? 409 : 500;
    res.status(code).json({ error: e.message });
  }
});

router.patch('/api/pm/:id', requirePmWrite, async (req, res, next) => {
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
    if ('nginxEnabled' in body) patch.nginxEnabled = body.nginxEnabled ? 1 : 0;
    if ('webEnabled' in body) patch.webEnabled = body.webEnabled ? 1 : 0;

    if ('upstreamPort' in body || 'externalPort' in body) {
      const ports = await allocatePorts({
        upstreamPort: 'upstreamPort' in body ? body.upstreamPort : cur.upstream_port,
        externalPort: 'externalPort' in body ? body.externalPort : cur.external_port,
        excludeId: id,
      });
      patch.upstreamPort = ports.upstreamPort;
      patch.externalPort = ports.externalPort;
    }

    const row = store.update(id, patch);
    writeManagedState(store.list());
    const listening = await listeningPorts();
    res.json({ ok: true, project: await enrich(row, listening), apply: readApplyStatus() });
  } catch (e) {
    const code = /已占用|须在|无空闲/.test(e.message) ? 400 : 500;
    res.status(code).json({ error: e.message });
  }
});

router.delete('/api/pm/:id', requirePmWrite, (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: '无效 id' });
  const row = store.get(id);
  if (!row) return res.status(404).json({ error: 'not found' });
  store.remove(id);
  writeManagedState(store.list());
  res.json({ ok: true, removed: row.slug, apply: readApplyStatus() });
});

router.post('/api/pm/apply', requirePmWrite, (req, res) => {
  const state = writeManagedState(store.list());
  res.json({ ok: true, state, apply: readApplyStatus() });
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
      .filter(p => p.nginx_enabled && p.web_enabled)
      .map(p => ({
        name: p.name,
        url: navUrl(p),
        desc: `项目管理器 · 127.0.0.1:${p.upstream_port}`,
        port: String(p.external_port),
        upstream: String(p.upstream_port),
        tags: ['managed'],
      }));
    if (managed.length) {
      nav.groups = [{ name: '我的项目', note: '由 zdashboard 项目管理器托管', items: managed }, ...nav.groups];
    }
    res.json(nav);
  } catch (e) { next(e); }
});

export { router as pmRouter };
