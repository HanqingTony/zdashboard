// src/routes/agg.js — 「信息聚合」路由
//
//  GET  /api/agg            读取缓存（含「新」标记），标记是否过期
//  POST /api/agg/refresh    跑探针（可指定 ?source=<id> 或 body.source），写库并返回最新结果
//
// 每条信息源独立探测、独立失败：某个源挂了只影响它自己（status=error + error 文本），
// 其余照常返回；同源并发刷新会被合并（in-flight 去重）。

import { Router } from 'express';
import { SOURCES, SOURCE_MAP } from '../agg/sources.js';
import { recordProbe, listItems, stateOf } from '../agg/store.js';

const router = Router();

export const TTL_MS = 30 * 60 * 1000;   // 缓存 30 分钟；超时前端会提示/自动刷新
let lastRefreshAt = null;
const inflight = new Map();             // sourceId -> Promise

// 源声明了 requires.env 但环境里没有 → 「待配置」：不探测、不报错、不标过期
function missingEnv(source) {
  return (source.requires?.env || []).filter(k => !process.env[k]);
}

function sourceView(source, { stale }) {
  const st = stateOf(source.id);
  const missing = missingEnv(source);
  if (missing.length) {
    return {
      id: source.id, board: source.board || 'probe', group: source.group, label: source.label, note: source.note || null,
      homepage: source.homepage || null,
      status: 'unconfigured', fetchedAt: st?.fetched_at || null, error: null,
      itemCount: 0, newCount: 0, durationMs: null, stale: false,
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
    error: st?.error || null,
    itemCount: st?.item_count ?? 0,
    newCount: st?.new_count ?? 0,
    durationMs: st?.duration_ms ?? null,
    stale,
    ranked: !!source.ranked,
    items: source.status === 'idle' && !st ? [] : listItems(source.id, source.display || 6),
  };
}

function snapshot() {
  const now = Date.now();
  const sources = SOURCES.map(s => {
    const st = stateOf(s.id);
    const age = st?.fetched_at ? now - new Date(st.fetched_at).getTime() : Infinity;
    return sourceView(s, { stale: age > TTL_MS });   // 未配置的源在 sourceView 里恒为 stale:false
  });
  const totalNew = sources.reduce((n, s) => n + (s.status === 'ok' ? s.newCount : 0), 0);
  const newest = sources.map(s => s.fetchedAt).filter(Boolean).sort().pop() || null;
  return { lastRefreshAt: lastRefreshAt || newest, totalNew, ttlMs: TTL_MS, sources };
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

router.get('/api/agg', (req, res) => {
  res.json(snapshot());
});

router.post('/api/agg/refresh', async (req, res) => {
  const wanted = req.query.source || req.body?.source || null;
  const targets = wanted
    ? [SOURCE_MAP.get(String(wanted))].filter(Boolean)
    : SOURCES;
  if (targets.length === 0) return res.status(400).json({ error: `未知 source: ${wanted}` });

  const results = await Promise.all(targets.map(runSource));
  lastRefreshAt = new Date().toISOString();
  res.json({ results, ...snapshot() });
});

export { router as aggRouter };
