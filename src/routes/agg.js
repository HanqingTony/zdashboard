// src/routes/agg.js — 「信息聚合」路由
//
//  GET  /api/agg                 读取缓存（含未读标记与过期判定）
//  POST /api/agg/refresh         跑探针：?source=<id> 只刷一个；不带 source 刷全部过期源；
//                                ?force=1（或 body.force）连未过期的也刷
//  POST /api/agg/open            标记已读水位：body {all:true} 或 {source:"<id>"}
//
// 每个源独立探测、独立失败；同源并发刷新合并；全量刷新带并发上限（默认 4）。
// 「新」的语义见 src/agg/store.js（opened_at 水位，而不是上次探测）。

import { Router } from 'express';
import { SOURCES, SOURCE_MAP } from '../agg/sources.js';
import {
  recordProbe, listItems, getStateMap, unreadCount,
  markOpened, pruneItems, staleness,
} from '../agg/store.js';
import { nowIso } from '../lib/time.js';

const router = Router();

export const TTL_MS = 30 * 60 * 1000;   // 缓存 30 分钟
const CONCURRENCY = 4;                  // 全量刷新时同时探测的源数量

let lastRefreshAt = null;
const inflight = new Map();             // sourceId -> Promise

// 源声明了 requires.env 但环境里没有 → 「待配置」：不探测、不报错、不标过期
function missingEnv(source) {
  return (source.requires?.env || []).filter(k => !process.env[k]);
}

function sourceView(source, { states, now }) {
  const st = states.get(source.id) || null;
  const missing = missingEnv(source);
  const info = staleness(st, TTL_MS, now);

  if (missing.length) {
    return {
      id: source.id, board: source.board || 'probe', group: source.group, label: source.label,
      note: source.note || null, homepage: source.homepage || null,
      status: 'unconfigured', fetchedAt: st?.fetched_at || null, lastOkAt: st?.last_ok_at || null,
      error: null, itemCount: 0, newCount: 0, durationMs: null, stale: false, ranked: !!source.ranked,
      requires: { env: source.requires.env, hint: source.requires.hint || null, missing },
      items: [],
    };
  }

  return {
    id: source.id,
    board: source.board || 'probe',
    group: source.group,
    label: source.label,
    note: source.note || null,
    homepage: source.homepage || null,
    status: st?.status || 'idle',        // idle | ok | error
    fetchedAt: st?.fetched_at || null,
    lastOkAt: st?.last_ok_at || null,
    error: st?.error || null,
    itemCount: st?.item_count ?? 0,
    newCount: unreadCount(source.id),    // 未读条数（不是"本次新见到"）
    durationMs: st?.duration_ms ?? null,
    stale: info.stale,
    failCount: st?.fail_count || 0,
    ranked: !!source.ranked,
    items: st ? listItems(source.id, source.display || 6) : [],
  };
}

function snapshot() {
  const now = Date.now();
  const states = getStateMap();
  const sources = SOURCES.map(s => sourceView(s, { states, now }));
  const totalNew = sources.reduce((n, s) => n + (s.status === 'unconfigured' ? 0 : s.newCount), 0);
  const newest = sources
    .map(s => s.lastOkAt || s.fetchedAt)
    .filter(Boolean)
    .sort()
    .pop() || null;
  return { lastRefreshAt: newest || lastRefreshAt, totalNew, ttlMs: TTL_MS, sources };
}

// 跑一个源的探针（独立失败隔离 + 并发去重）
async function runSource(source) {
  const missing = missingEnv(source);
  if (missing.length) {
    return { source: source.id, ok: false, skipped: true, missing, error: `未配置：${missing.join(', ')}` };
  }
  if (inflight.has(source.id)) return inflight.get(source.id);
  const p = (async () => {
    const t0 = Date.now();
    try {
      const { items } = await source.probe();
      const { newCount, total } = recordProbe(source, items, { durationMs: Date.now() - t0 });
      return { source: source.id, ok: true, newCount, total, durationMs: Date.now() - t0 };
    } catch (e) {
      const msg = e?.name === 'TimeoutError' ? '超时（网络不通或对方太慢）' : (e?.message || String(e));
      recordProbe(source, [], { error: msg, durationMs: Date.now() - t0 });
      return { source: source.id, ok: false, error: msg, durationMs: Date.now() - t0 };
    } finally {
      inflight.delete(source.id);
    }
  })();
  inflight.set(source.id, p);
  return p;
}

// 简单并发池：避免 18 个源同时打代理/外部 API（GitHub 未认证 10 次/分）
async function runPool(list, limit) {
  const out = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      out[i] = await runSource(list[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

router.get('/api/agg', (req, res) => {
  res.json(snapshot());
});

router.post('/api/agg/refresh', async (req, res, next) => {
  try {
    const wanted = req.query.source || req.body?.source || null;
    const force = req.query.force === '1' || req.body?.force === true;
    const now = Date.now();

    let targets;
    if (wanted) {
      const src = SOURCE_MAP.get(String(wanted));
      if (!src) return res.status(400).json({ error: `未知 source: ${wanted}` });
      if (missingEnv(src).length) {
        return res.json({ results: [{ source: src.id, ok: false, skipped: true, missing: missingEnv(src) }], ...snapshot() });
      }
      targets = [src];
    } else {
      const states = getStateMap();
      targets = SOURCES.filter(s => {
        if (missingEnv(s).length) return false;
        return force || staleness(states.get(s.id), TTL_MS, now).stale;
      });
    }

    const results = await runPool(targets, CONCURRENCY);

    if (!wanted) {
      lastRefreshAt = nowIso();
      try { pruneItems(SOURCES); } catch (e) { console.warn('[agg] 保留策略清理失败:', e.message); }
    }

    res.json({ results, ...snapshot() });
  } catch (e) {
    next(e);
  }
});

router.post('/api/agg/open', (req, res) => {
  const { all, source } = req.body || {};
  if (all) return res.json({ ok: true, marked: markOpened(null) });
  if (!source) return res.status(400).json({ error: '需要 {source} 或 {all:true}' });
  if (!SOURCE_MAP.has(String(source))) return res.status(400).json({ error: `未知 source: ${source}` });
  return res.json({ ok: true, marked: markOpened([String(source)]) });
});

export { router as aggRouter };
