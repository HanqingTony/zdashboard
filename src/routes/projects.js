// src/routes/projects.js — 项目台账 API
//
//  GET    /api/projects                 列表（可带 kind/board/layer/status/grade/verdict/q 过滤）+ 统计
//  POST   /api/projects/import          从 zpa 清单重新生成 seed 并导入（幂等；?regen=0 跳过重新生成）
//  POST   /api/projects/sync            刷新 git 派生字段（最近提交/脏文件/未推送）
//  POST   /api/projects                 新建
//  PATCH  /api/projects/:id             改（状态/下一步/备注/想法判决/评分…）
//  DELETE /api/projects/:id             删

import { Router } from 'express';
import { execFileSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as store from '../projects/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..', '..');
const SEED = resolve(APP_ROOT, 'src/projects/seed.json');

const router = Router();

router.get('/api/projects', (req, res) => {
  const { kind, board, layer, status, grade, verdict, q } = req.query;
  const items = store.list({ kind, board, layer, status, grade, verdict, q });
  res.json({ stats: store.stats(), count: items.length, items });
});

// 从 zpa 清单导入（清单是事实源）
router.post('/api/projects/import', (req, res) => {
  try {
    if (req.query.regen !== '0') {
      execFileSync('node', [resolve(APP_ROOT, 'src/projects/fromMarkdown.js')], { cwd: APP_ROOT, timeout: 30000, stdio: 'pipe' });
    }
    const rows = JSON.parse(readFileSync(SEED, 'utf8'));
    const n = store.upsertMany(rows);
    res.json({ ok: true, imported: n, source: SEED, stats: store.stats() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 刷新 git 派生字段
router.post('/api/projects/sync', (req, res) => {
  const rows = store.list({}).filter(r => r.repo_path && existsSync(r.repo_path));
  const git = (dir, args) => {
    try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return ''; }
  };
  let n = 0;
  for (const r of rows) {
    const d = r.repo_path;
    const br = git(d, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
    let remote = git(d, ['remote', 'get-url', 'origin']).replace(/^git@/, '').replace(/:.*$/, '');
    if (!remote) remote = '⚠️ 无远端';
    else if (git(d, ['config', '--get-all', 'remote.origin.pushurl']).split('\n').filter(Boolean).length >= 2) remote += '(双推)';
    store.saveGit(r.id, {
      last_commit_at: git(d, ['log', '-1', '--date=short', '--format=%ad']),
      last_commit_subject: git(d, ['log', '-1', '--format=%s']).slice(0, 80),
      dirty: git(d, ['status', '--porcelain']).split('\n').filter(Boolean).length,
      ahead: git(d, ['log', '--oneline', `origin/${br}..HEAD`]).split('\n').filter(Boolean).length,
      remote,
    });
    n++;
  }
  res.json({ ok: true, synced: n });
});

router.post('/api/projects', (req, res) => {
  try { res.json(store.create(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/api/projects/:id', (req, res) => {
  const row = store.update(Number(req.params.id), req.body || {});
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

router.delete('/api/projects/:id', (req, res) => {
  const ok = store.remove(Number(req.params.id));
  res.status(ok ? 200 : 404).json({ ok });
});

export { router as projectsRouter };
