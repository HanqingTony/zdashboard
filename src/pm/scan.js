// src/pm/scan.js — 扫描本机仓库与正在运行的服务，导入 managed_project
//
// 规则：
// - 仓库：PM_REPO_ROOT 下所有含 .git 的目录 → kind=repo（无端口）
// - 服务：已知的成品软件/服务（ComfyUI、dsh、comfy-web、MinIO、searxng、zres）
//         → 端口映射；已有手工 nginx 映射的条目标记 nginx_enabled=0（避免重复 listen）
// - 不覆盖同名/同仓库已有条目；不删除任何东西

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import * as store from './store.js';
import { repoInfo } from './repo.js';
import { allocatePorts, listeningPorts } from './ports.js';
import { PM_REPO_ROOT } from '../config.js';

const REPO_ROOT = PM_REPO_ROOT;

// 已知服务：running 判断用监听端口；repo 存在才作为仓库关联
const KNOWN_SERVICES = [
  {
    slug: 'comfyui', name: 'ComfyUI', kind: 'software', port: 8188,
    repo: '/home/tony/zrepo/ComfyUI', preferExternal: 18130,
    nginx: true, web: true, pinned: 1,
    note: 'ComfyUI 主服务（--listen 0.0.0.0:8188）；由 PM 新增 TLS 181xx 入口',
  },
  {
    slug: 'dsh-web', name: 'dsh web', kind: 'service', port: 28110,
    repo: '/home/tony/zrepo/deepseek-harness', external: 18110,
    nginx: false, web: false,
    note: '已有手工 nginx 映射 18110（zports-external.conf）；PM 仅登记',
  },
  {
    slug: 'comfy-web', name: 'comfy-web', kind: 'service', port: 28104,
    repo: '/home/tony/zrepo/zup', external: 18104,
    nginx: false, web: false,
    note: '已有手工 nginx 映射 18104；PM 仅登记',
  },
  {
    slug: 'minio', name: 'MinIO', kind: 'infra', port: 28101,
    repo: null, external: 18101,
    nginx: false, web: false,
    note: '已有手工映射 18101；S3 API 9000',
  },
  {
    slug: 'searxng', name: 'searxng', kind: 'infra', port: 28102,
    repo: null, external: 18102,
    nginx: false, web: false,
    note: '已有手工映射 18102',
  },
  {
    slug: 'zres', name: 'zres 素材库', kind: 'service', port: 28120,
    repo: '/home/tony/zrepo/zres', external: 18120,
    nginx: false, web: false,
    note: '已有手工映射 18120',
  },
];

function slugOf(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function listRepos() {
  if (!existsSync(REPO_ROOT)) return [];
  return readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter(e => e.isDirectory() && existsSync(join(REPO_ROOT, e.name, '.git')))
    .map(e => ({ name: e.name, path: join(REPO_ROOT, e.name), slug: slugOf(e.name) }))
    .filter(r => r.slug);
}

/**
 * 扫描并导入。
 * @param {{sync?:boolean}} opts
 */
export async function scanAndImport({ sync = true, what = 'all' } = {}) {
  const listening = await listeningPorts();
  const created = [];
  const skipped = [];
  const services = [];

  const tryCreate = (data) => {
    if (store.findBySlug(data.slug)) { skipped.push(data.slug); return null; }
    if (data.repo_path && store.findByRepoPath(data.repo_path)) { skipped.push(data.slug); return null; }
    const row = store.create({
      kind: 'project', repo_path: null, repo_created: 0, dual_remote: 1,
      upstream_port: null, external_port: null, nginx_enabled: 0, web_enabled: 0,
      pinned: 0, source: 'scan', note: null,
      ...data,
    });
    created.push(row.slug);
    return row;
  };

  // 1) 已知服务（含 ComfyUI 这种成品软件）
  if (what !== 'repos') for (const s of KNOWN_SERVICES) {
    if (!listening.has(s.port)) { skipped.push(`${s.slug}(not-running)`); continue; }
    const repoPath = s.repo && existsSync(join(s.repo, '.git')) ? s.repo : null;
    // 已存在则跳过（必须在端口分配之前；否则会撞上自己的 upstream/external）
    if (store.findBySlug(s.slug) || (repoPath && store.findByRepoPath(repoPath))) {
      skipped.push(`${s.slug}(exists)`);
      continue;
    }
    let external = s.external ?? null;
    let nginxEnabled = s.nginx ? 1 : 0;
    let dual = 1;
    if (repoPath) {
      try { dual = (await repoInfo(repoPath)).dualPush ? 1 : 0; } catch { /* ignore */ }
    }

    // ComfyUI：没有旧映射，自动挑一个空闲 181xx 并启用
    if (nginxEnabled && !external) {
      try {
        const ports = await allocatePorts({ upstreamPort: s.port, externalPort: s.preferExternal });
        external = ports.externalPort;
      } catch {
        const ports = await allocatePorts({ upstreamPort: s.port });
        external = ports.externalPort;
      }
    }

    const row = tryCreate({
      slug: s.slug,
      name: s.name,
      kind: s.kind,
      repo_path: repoPath,
      dual_remote: dual,
      upstream_port: s.port,
      external_port: external,
      nginx_enabled: nginxEnabled,
      web_enabled: s.web ? 1 : 0,
      pinned: s.pinned ? 1 : 0,
      source: 'scan:service',
      note: s.note,
    });
    if (row) services.push({ slug: row.slug, port: s.port, external: row.external_port, nginx: !!row.nginx_enabled });
  }

  // 2) 本机仓库（已被服务条目关联的跳过）
  if (what !== 'ports') for (const r of listRepos()) {
    if (store.findByRepoPath(r.path)) { skipped.push(`${r.slug}(repo-linked)`); continue; }
    let dual = 1;
    try {
      const info = await repoInfo(r.path);
      dual = info.dualPush ? 1 : 0;
    } catch { /* ignore */ }
    tryCreate({
      slug: r.slug,
      name: r.name,
      kind: 'repo',
      repo_path: r.path,
      repo_created: 0,
      dual_remote: dual,
      source: 'scan:repo',
      note: '扫描导入（仓库）',
    });
  }

  // 3) 可选：同步 git 派生字段（17+ 仓库，慢一点但一次性）
  let synced = 0;
  if (sync) {
    try { synced = (await syncRepos()).synced; } catch { /* ignore */ }
  }

  return { created, skipped, services, repos: listRepos().length, synced, listening: [...listening].sort((a, b) => a - b) };
}

/** 刷新所有仓库条目的 git 派生字段 */
export async function syncRepos({ concurrency = 3 } = {}) {
  const rows = store.list().filter(r => r.repo_path && existsSync(join(r.repo_path, '.git')));
  const out = new Array(rows.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= rows.length) return;
      const info = await repoInfo(rows[i].repo_path);
      out[i] = {
        id: rows[i].id,
        last_commit_at: info.last_commit_at || null,
        last_commit_subject: info.last_commit_subject || null,
        dirty: info.dirty ?? 0,
        ahead: info.ahead ?? 0,
        dual_remote: info.dualPush ? 1 : 0,
      };
    }
  }));
  store.saveGitMany(out.filter(Boolean));
  return { synced: out.filter(Boolean).length, total: rows.length };
}

export { KNOWN_SERVICES };
