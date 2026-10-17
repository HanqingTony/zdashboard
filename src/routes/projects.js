// src/routes/projects.js — 项目台账 API
//
//  GET    /api/projects                 列表（可带 kind/board/layer/status/grade/verdict/q 过滤）+ 统计
//  POST   /api/projects/import          zpa 清单 → 幂等 upsert（?regen=0 用 seed.json；zpa 不可用时自动回退）
//  POST   /api/projects/sync            异步刷新 git 派生字段（并发 4，不再阻塞事件循环）
//  POST   /api/projects                 新建
//  PATCH  /api/projects/:id             改（状态/下一步/备注/想法判决/评分…）
//  DELETE /api/projects/:id             删

import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as store from '../projects/store.js';
import { buildSeed } from '../projects/fromMarkdown.js';
import { ZPA_DIR, ZREPO_DIR } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..', '..');
const SEED = resolve(APP_ROOT, 'src/projects/seed.json');

const execFileP = promisify(execFile);
const router = Router();

const idOf = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

async function git(dir, args) {
  try {
    const { stdout } = await execFileP('git', ['-C', dir, ...args], {
      encoding: 'utf8', timeout: 8000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

function remoteLabel(remotes) {
  const rows = remotes.split('\n').filter(Boolean).map(l => l.split(/\s+/));
  const fetchUrl = rows.find(r => r[2] === '(fetch)')?.[1] || '';
  if (!fetchUrl) return '⚠️ 无远端';
  const pushCount = rows.filter(r => r[2] === '(push)').length;
  const host = fetchUrl
    .replace(/^[a-z]+@/i, '')
    .replace(/^[a-z]+:\/\//i, '')
    .split(/[:\/]/)[0];
  return host + (pushCount >= 2 ? '(双推)' : '');
}

// 3 次 git 调用拿齐所有派生字段（原来 7 次）
async function repoInfo(dir) {
  const [status, log, remotes] = await Promise.all([
    git(dir, ['status', '--porcelain=v2', '--branch']),
    git(dir, ['log', '-1', '--date=short', '--format=%ad%x00%s']),
    git(dir, ['remote', '-v']),
  ]);

  const lines = status ? status.split('\n') : [];
  const dirty = lines.filter(l => l && !l.startsWith('#')).length;
  const ab = lines.find(l => l.startsWith('# branch.ab '));
  const ahead = ab ? Number(ab.match(/\+(\d+)/)?.[1] || 0) : 0;
  const [date = '', subject = ''] = log.split('\x00');

  return {
    ok: !!(status || log),
    last_commit_at: date,
    last_commit_subject: subject.slice(0, 80),
    dirty,
    ahead,
    remote: remoteLabel(remotes),
  };
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

router.get('/api/projects', (req, res) => {
  const { kind, board, layer, status, grade, verdict, q } = req.query;
  const items = store.list({ kind, board, layer, status, grade, verdict, q });
  res.json({ stats: store.stats(), count: items.length, items });
});

// 从 zpa 清单导入（清单是事实源；进程内解析，不重写仓库里的 seed.json）
router.post('/api/projects/import', (req, res) => {
  try {
    let rows;
    let source;
    if (req.query.regen === '0') {
      rows = JSON.parse(readFileSync(SEED, 'utf8'));
      source = SEED;
    } else {
      try {
        rows = buildSeed({ zpaDir: ZPA_DIR, zrepoDir: ZREPO_DIR });
        source = ZPA_DIR;
      } catch (e) {
        if (!existsSync(SEED)) throw e;
        rows = JSON.parse(readFileSync(SEED, 'utf8'));
        source = `${SEED}（zpa 不可用：${e.message}）`;
      }
    }
    const n = store.upsertMany(rows);
    res.json({ ok: true, imported: n, source, stats: store.stats() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 刷新 git 派生字段（异步 + 并发池，避免阻塞事件循环）
router.post('/api/projects/sync', async (req, res, next) => {
  try {
    const rows = store.list({}).filter(r => r.repo_path && existsSync(r.repo_path));
    const results = await mapPool(rows, 4, r => repoInfo(r.repo_path));
    const failed = rows.filter((_, i) => !results[i].ok).map(r => r.name);
    // 只写成功的结果：git 临时失败时不要把已有的最近提交/脏文件覆盖成空
    const saved = results.flatMap((info, i) => info.ok ? [{
      id: rows[i].id,
      last_commit_at: info.last_commit_at,
      last_commit_subject: info.last_commit_subject,
      dirty: info.dirty,
      ahead: info.ahead,
      remote: info.remote,
    }] : []);
    store.saveGitMany(saved);
    res.json({ ok: true, synced: saved.length, total: rows.length, failed });
  } catch (e) {
    next(e);
  }
});

router.post('/api/projects', (req, res) => {
  try {
    res.json(store.create(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/api/projects/:id', (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: '无效 id' });
  try {
    const row = store.update(id, req.body || {});
    if (!row) return res.status(404).json({ error: 'not found' });
    res.json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/api/projects/:id', (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: '无效 id' });
  const ok = store.remove(id);
  res.status(ok ? 200 : 404).json({ ok });
});

export { router as projectsRouter };
