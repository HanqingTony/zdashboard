// src/agg/store.js — 「信息聚合」的落库与「新条目」判定
//
// 两张表（建在既有 zdb.db 里）：
//   agg_item  : 见过的条目（source_id + item_id 唯一）——「新」= 表里没有过
//   agg_state : 每个源最近一次探测的状态（时间/成败/错误/条数）
//
// 约定：写完立刻 wal_checkpoint(TRUNCATE)（与 db.js 的约定一致）

import db from '../db.js';

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
    PRIMARY KEY (source_id, item_id)
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_agg_item_src ON agg_item (source_id, created_at DESC)`);
db.exec(`
  CREATE TABLE IF NOT EXISTS agg_state (
    source_id   TEXT PRIMARY KEY,
    label       TEXT,
    fetched_at  TEXT,
    status      TEXT,
    error       TEXT,
    item_count  INTEGER DEFAULT 0,
    new_count   INTEGER DEFAULT 0,
    duration_ms INTEGER
  )
`);

const stmts = {
  getItem: db.prepare('SELECT item_id FROM agg_item WHERE source_id = ? AND item_id = ?'),
  upsert: db.prepare(`
    INSERT INTO agg_item (source_id, item_id, title, url, created_at, first_seen, last_seen, meta_json)
    VALUES (@source_id, @item_id, @title, @url, @created_at, @now, @now, @meta_json)
    ON CONFLICT(source_id, item_id) DO UPDATE SET last_seen = @now, title = @title, url = @url, meta_json = @meta_json
  `),
  list: db.prepare('SELECT * FROM agg_item WHERE source_id = ? ORDER BY created_at DESC, first_seen DESC LIMIT ?'),
  setState: db.prepare(`
    INSERT INTO agg_state (source_id, label, fetched_at, status, error, item_count, new_count, duration_ms)
    VALUES (@source_id, @label, @fetched_at, @status, @error, @item_count, @new_count, @duration_ms)
    ON CONFLICT(source_id) DO UPDATE SET
      label = @label, fetched_at = @fetched_at, status = @status, error = @error,
      item_count = @item_count, new_count = @new_count, duration_ms = @duration_ms
  `),
  state: db.prepare('SELECT * FROM agg_state'),
};

/**
 * 落库一次探测结果。
 * @returns {{newCount:number, total:number}} newCount = 本次首次见到的条目数
 */
export function recordProbe(source, items, { error = null, durationMs = 0 } = {}) {
  const now = new Date().toISOString();
  let newCount = 0;
  if (!error) {
    const tx = db.transaction(rows => {
      for (const it of rows) {
        const known = stmts.getItem.get(source.id, it.id);
        if (!known) newCount++;
        stmts.upsert.run({
          source_id: source.id,
          item_id: String(it.id),
          title: it.title ?? null,
          url: it.url ?? null,
          created_at: it.createdAt ?? null,
          now,
          meta_json: JSON.stringify(it.meta || []),
        });
      }
    });
    tx(items);
  }
  const prev = stmts.state.all().find(s => s.source_id === source.id);
  stmts.setState.run({
    source_id: source.id,
    label: source.label,
    fetched_at: now,
    status: error ? 'error' : 'ok',
    error: error ? String(error).slice(0, 500) : null,
    // 出错时保留上次的条数/新数，避免界面突然清空
    item_count: error ? (prev?.item_count || 0) : items.length,
    new_count: error ? (prev?.new_count || 0) : newCount,
    duration_ms: durationMs,
  });
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* 忽略 checkpoint 失败 */ }
  return { newCount, total: items.length };
}

/** 读取某源已见过的条目（按创建时间倒序） */
export function listItems(sourceId, limit = 12) {
  return stmts.list.all(sourceId, limit).map(r => ({
    id: r.item_id,
    title: r.title,
    url: r.url,
    createdAt: r.created_at,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    isNew: r.first_seen === r.last_seen,   // 首次见到即「新」（后续探测只更新 last_seen）
    meta: (() => { try { return JSON.parse(r.meta_json || '[]'); } catch { return []; } })(),
  }));
}

export function stateOf(sourceId) {
  return stmts.state.all().find(s => s.source_id === sourceId) || null;
}

export function allStates() {
  return stmts.state.all();
}
