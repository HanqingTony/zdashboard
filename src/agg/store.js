// src/agg/store.js — 「信息聚合」的落库、未读判定与保留策略
//
// 表：
//   agg_item  见过的条目（source_id + item_id 唯一；first_seen 首次见到，last_seen 最近见到）
//   agg_state 每个源最近一次探测状态 + 未读水位（opened_at）+ 失败退避（fail_count）
//
// 「新」= 该条目在 opened_at 之后首次见到（你离开聚合页时打水位），
//        而不是「上次探测时首次见到」——后者会在你没看之前就把新内容吃掉。
//
// 约定：写完调用 checkpoint()（策略见 src/db.js）

import db, { checkpoint } from '../db.js';
import { nowIso, msOf } from '../lib/time.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS agg_item (
    source_id   TEXT NOT NULL,
    item_id     TEXT NOT NULL,
    title       TEXT,
    url         TEXT,
    created_at  TEXT,
    first_seen  TEXT NOT NULL,
    last_seen   TEXT NOT NULL,
    meta_json   TEXT,
    ord         INTEGER,
    PRIMARY KEY (source_id, item_id)
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_agg_item_src ON agg_item (source_id, created_at DESC)');
db.exec('CREATE INDEX IF NOT EXISTS idx_agg_item_seen ON agg_item (source_id, last_seen)');
db.exec('CREATE INDEX IF NOT EXISTS idx_agg_item_first ON agg_item (source_id, first_seen)');
db.exec(`
  CREATE TABLE IF NOT EXISTS agg_state (
    source_id   TEXT PRIMARY KEY,
    label       TEXT,
    fetched_at  TEXT,
    status      TEXT,
    error       TEXT,
    item_count  INTEGER DEFAULT 0,
    new_count   INTEGER DEFAULT 0,
    duration_ms INTEGER,
    last_ok_at  TEXT,
    fail_count  INTEGER DEFAULT 0,
    opened_at   TEXT
  )
`);

// 老库补列（幂等）；opened_at 是新增的「未读水位」，首次升级时用上次探测时间初始化，
// 避免把历史 800+ 条全部标成未读（之后由 markOpened 正常维护）。
function ensureColumn(table, col, ddl) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
  if (has) return false;
  db.exec(ddl);
  return true;
}

ensureColumn('agg_item', 'ord', 'ALTER TABLE agg_item ADD COLUMN ord INTEGER');
ensureColumn('agg_state', 'last_ok_at', 'ALTER TABLE agg_state ADD COLUMN last_ok_at TEXT');
ensureColumn('agg_state', 'fail_count', 'ALTER TABLE agg_state ADD COLUMN fail_count INTEGER DEFAULT 0');
if (ensureColumn('agg_state', 'opened_at', 'ALTER TABLE agg_state ADD COLUMN opened_at TEXT')) {
  db.exec("UPDATE agg_state SET opened_at = COALESCE(fetched_at, datetime('now'))");
}

const stmts = {
  // 新条目：插入成功 changes=1（first_seen == last_seen）；老条目：只更新 last_seen 等
  insertItem: db.prepare(`
    INSERT OR IGNORE INTO agg_item
      (source_id, item_id, title, url, created_at, first_seen, last_seen, meta_json, ord)
    VALUES
      (@source_id, @item_id, @title, @url, @created_at, @now, @now, @meta_json, @ord)
  `),
  touchItem: db.prepare(`
    UPDATE agg_item
       SET last_seen = @now, title = @title, url = @url, meta_json = @meta_json, ord = @ord
     WHERE source_id = @source_id AND item_id = @item_id
  `),
  // 有 ord（热榜排名）→ 按排名；无 ord → 按创建时间倒序
  list: db.prepare(`
    SELECT i.*, (i.first_seen >= COALESCE(s.opened_at, '')) AS is_new
    FROM agg_item i
    LEFT JOIN agg_state s ON s.source_id = i.source_id
    WHERE i.source_id = ?
    ORDER BY (i.ord IS NULL), i.ord ASC, i.created_at DESC, i.first_seen DESC
    LIMIT ?
  `),
  unread: db.prepare(`
    SELECT COUNT(*) AS n
    FROM agg_item i
    LEFT JOIN agg_state s ON s.source_id = i.source_id
    WHERE i.source_id = ? AND i.first_seen >= COALESCE(s.opened_at, '')
  `),
  setState: db.prepare(`
    INSERT INTO agg_state
      (source_id, label, fetched_at, status, error, item_count, new_count, duration_ms, last_ok_at, fail_count)
    VALUES
      (@source_id, @label, @fetched_at, @status, @error, @item_count, @new_count, @duration_ms, @last_ok_at, @fail_count)
    ON CONFLICT(source_id) DO UPDATE SET
      label = @label, fetched_at = @fetched_at, status = @status, error = @error,
      item_count = @item_count, new_count = @new_count, duration_ms = @duration_ms,
      last_ok_at = @last_ok_at, fail_count = @fail_count
  `),
  openOne: db.prepare(`
    INSERT INTO agg_state (source_id, opened_at) VALUES (@id, @now)
    ON CONFLICT(source_id) DO UPDATE SET opened_at = @now
  `),
  stateAll: db.prepare('SELECT * FROM agg_state'),
  pruneRanked: db.prepare(`
    DELETE FROM agg_item
     WHERE source_id = @id AND item_id NOT IN (
       SELECT item_id FROM agg_item WHERE source_id = @id ORDER BY first_seen DESC LIMIT @keep
     )
  `),
  pruneAged: db.prepare('DELETE FROM agg_item WHERE source_id = @id AND last_seen < @cutoff'),
};

/** 一次取全部源状态（避免每个源都全表扫） */
export function getStateMap() {
  return new Map(stmts.stateAll.all().map(s => [s.source_id, s]));
}

export function stateOf(sourceId) {
  return getStateMap().get(sourceId) || null;
}

/**
 * 落库一次探测结果。
 * @returns {{newCount:number, total:number}} newCount = 本次首次见到的条目数
 */
export function recordProbe(source, items, { error = null, durationMs = 0 } = {}) {
  const now = nowIso();
  const prev = stateOf(source.id);
  let newCount = 0;

  if (!error) {
    const tx = db.transaction(rows => {
      for (const it of rows) {
        const row = {
          source_id: source.id,
          item_id: String(it.id),
          title: it.title ?? null,
          url: it.url ?? null,
          created_at: it.createdAt ?? null,
          now,
          meta_json: JSON.stringify(it.meta || []),
          ord: Number.isFinite(it.ord) ? it.ord : null,
        };
        const r = stmts.insertItem.run(row);
        if (r.changes > 0) newCount++;
        else stmts.touchItem.run(row);
      }
    });
    tx(items);
  }

  stmts.setState.run({
    source_id: source.id,
    label: source.label,
    fetched_at: now,
    status: error ? 'error' : 'ok',
    error: error ? String(error).slice(0, 500) : null,
    // 出错时保留上次的条数，避免界面突然清空
    item_count: error ? (prev?.item_count || 0) : items.length,
    new_count: error ? (prev?.new_count || 0) : newCount,
    duration_ms: durationMs,
    last_ok_at: error ? (prev?.last_ok_at || null) : now,
    fail_count: error ? (prev?.fail_count || 0) + 1 : 0,
  });
  checkpoint();

  return { newCount, total: items.length };
}

/** 读取某源已见过的条目（按排名/时间倒序），isNew 基于 opened_at 水位 */
export function listItems(sourceId, limit = 12) {
  return stmts.list.all(sourceId, limit).map(r => ({
    id: r.item_id,
    title: r.title,
    url: r.url,
    createdAt: r.created_at,
    ord: r.ord ?? null,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    isNew: !!r.is_new,
    meta: (() => { try { return JSON.parse(r.meta_json || '[]'); } catch { return []; } })(),
  }));
}

/** 未读条数（first_seen 晚于 opened_at；从未打开过则全部算未读） */
export function unreadCount(sourceId) {
  return stmts.unread.get(sourceId)?.n || 0;
}

/** 标记已读水位。sourceIds=null 表示全部源（离开聚合页时调用） */
export function markOpened(sourceIds = null) {
  const now = nowIso();
  const ids = sourceIds ?? stmts.stateAll.all().map(r => r.source_id);
  if (!ids.length) return 0;
  const tx = db.transaction(list => {
    for (const id of list) stmts.openOne.run({ id, now });
  });
  tx(ids);
  checkpoint();
  return ids.length;
}

/**
 * 保留策略：热榜类每源只留最近 200 条（按 first_seen），其余源删除 90 天未再见的条目。
 * @param {Array<{id:string, ranked?:boolean}>} sources
 */
export function pruneItems(sources, { rankedKeep = 200, maxAgeDays = 90 } = {}) {
  const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
  let removed = 0;
  const tx = db.transaction(() => {
    for (const s of sources) {
      removed += s.ranked
        ? stmts.pruneRanked.run({ id: s.id, keep: rankedKeep }).changes
        : stmts.pruneAged.run({ id: s.id, cutoff }).changes;
    }
  });
  tx();
  if (removed > 0) checkpoint();
  return removed;
}

/** 判断某源是否到了该刷新的时间（成功 TTL + 失败指数退避） */
export function staleness(st, ttlMs, now = Date.now()) {
  const lastOk = msOf(st?.last_ok_at) ?? (st?.status === 'ok' ? msOf(st?.fetched_at) : null);

  // 失败退避：即使从未成功过，刚失败也不该被每次开页面重打
  const inBackoff = () => {
    if (st?.status !== 'error' || !st?.fetched_at) return false;
    const fails = Math.min(Math.max(st.fail_count || 1, 1), 6);
    const backoff = Math.min(ttlMs, 60_000 * 2 ** (fails - 1));
    return now - (msOf(st.fetched_at) ?? 0) < backoff;
  };

  if (lastOk == null) return { stale: !inBackoff(), lastOkAt: null };
  if (now - lastOk <= ttlMs) return { stale: false, lastOkAt: lastOk };
  return { stale: !inBackoff(), lastOkAt: lastOk };
}

export function allStates() {
  return stmts.stateAll.all();
}
