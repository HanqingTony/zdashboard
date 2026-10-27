// src/migrations.js — 版本化数据库迁移（PRAGMA user_version）
//
// 约束：
// - 每个迁移必须幂等或只在版本号低于自身时执行；
// - 老库（user_version=0）会依次跑 1..N（建表用 IF NOT EXISTS、补列用 ensureColumn）；
// - 破坏性操作（删表）不放在这里，见 scripts/archive-legacy.js。

import { LEGACY_STATUS, LEGACY_LAYER } from '../public/projects-meta.js';

function ensureColumn(db, table, col, ddl) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
  if (has) return false;
  db.exec(ddl);
  return true;
}

const q = v => `'${String(v).replace(/'/g, "''")}'`;

function remapColumn(db, table, col, map) {
  const entries = Object.entries(map);
  const cases = entries.map(([from, to]) => `WHEN ${q(from)} THEN ${q(to)}`).join(' ');
  const keys = entries.map(([from]) => q(from)).join(', ');
  db.exec(`
    UPDATE ${table}
       SET ${col} = CASE ${col} ${cases} ELSE ${col} END
     WHERE ${col} IN (${keys})
  `);
}

export const MIGRATIONS = [
  {
    version: 1,
    name: 'vocab-tables',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS zVocab (
          word        TEXT PRIMARY KEY,
          status      TEXT NOT NULL DEFAULT 'unknown',
          first_seen  TEXT,
          last_seen   TEXT,
          click_count INTEGER DEFAULT 0
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS zArticles (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          title     TEXT,
          content   TEXT NOT NULL,
          created   TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS zWordArticles (
          word        TEXT NOT NULL,
          article_id  INTEGER NOT NULL,
          count       INTEGER DEFAULT 1,
          PRIMARY KEY (word, article_id),
          FOREIGN KEY (article_id) REFERENCES zArticles(id) ON DELETE CASCADE
        )
      `);
    },
  },
  {
    version: 2,
    name: 'agg-tables',
    up(db) {
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

      // 老库补列；opened_at 首次出现时用上次探测时间初始化，避免历史条目全变未读
      ensureColumn(db, 'agg_item', 'ord', 'ALTER TABLE agg_item ADD COLUMN ord INTEGER');
      ensureColumn(db, 'agg_state', 'last_ok_at', 'ALTER TABLE agg_state ADD COLUMN last_ok_at TEXT');
      ensureColumn(db, 'agg_state', 'fail_count', 'ALTER TABLE agg_state ADD COLUMN fail_count INTEGER DEFAULT 0');
      if (ensureColumn(db, 'agg_state', 'opened_at', 'ALTER TABLE agg_state ADD COLUMN opened_at TEXT')) {
        db.exec("UPDATE agg_state SET opened_at = COALESCE(fetched_at, datetime('now'))");
      }
    },
  },
  {
    version: 3,
    name: 'project-table',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS zproject (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          name                TEXT NOT NULL UNIQUE,
          kind                TEXT,
          board               TEXT,
          layer               TEXT,     -- l0..l4（展示映射见 public/projects-meta.js）
          status              TEXT,     -- active / on_demand / ...（code）
          feasibility         INTEGER,
          completeness        INTEGER,
          importance          INTEGER,
          score               INTEGER,
          grade               TEXT,
          verdict             TEXT,
          stack               TEXT,
          repo_path           TEXT,
          remote              TEXT,
          deploy              TEXT,
          ports               TEXT,
          next_step           TEXT,
          risk                TEXT,
          note                TEXT,
          source              TEXT,
          last_commit_at      TEXT,
          last_commit_subject TEXT,
          dirty               INTEGER,
          ahead               INTEGER,
          synced_at           TEXT,
          pinned              INTEGER DEFAULT 0,
          created_at          TEXT,
          updated_at          TEXT
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_project_kind ON zproject (kind, grade)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_project_layer ON zproject (layer)');
    },
  },
  {
    version: 4,
    name: 'project-enums-to-codes',
    up(db) {
      // v0.2.1 及更早：status/layer 存 emoji/中文；改为稳定 code（展示映射在前端）
      remapColumn(db, 'zproject', 'status', LEGACY_STATUS);
      remapColumn(db, 'zproject', 'layer', LEGACY_LAYER);
    },
  },
  {
    version: 5,
    name: 'managed-project',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS managed_project (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          slug          TEXT NOT NULL UNIQUE,
          name          TEXT NOT NULL,
          repo_path     TEXT,
          upstream_port INTEGER NOT NULL UNIQUE,   -- 127xx 回环上游
          external_port INTEGER NOT NULL UNIQUE,   -- 181xx nginx 对外入口
          nginx_enabled INTEGER NOT NULL DEFAULT 1,
          web_enabled   INTEGER NOT NULL DEFAULT 1,  -- 是否挂到 zdashboard 主页
          repo_created  INTEGER NOT NULL DEFAULT 0,
          dual_remote   INTEGER NOT NULL DEFAULT 1,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_mp_web ON managed_project (web_enabled, nginx_enabled)');
    },
  },
];

export function migrate(db) {
  const current = db.pragma('user_version', { simple: true }) || 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    })();
    console.log(`[db] 迁移 ${m.version}/${MIGRATIONS.length}: ${m.name}`);
  }
  return db.pragma('user_version', { simple: true });
}
