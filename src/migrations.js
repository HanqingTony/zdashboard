// src/migrations.js — 版本化数据库迁移（PRAGMA user_version）
//
// 约束：
// - 每个迁移必须幂等或只在版本号低于自身时执行；
// - 老库（user_version=0）会依次跑 1..N（建表用 IF NOT EXISTS、补列用 ensureColumn）；
// - 破坏性操作原则上先归档（scripts/archive-legacy.js）；v6 删除已废弃的 zproject 是显式产品决策。

// v0.2.1 及更早 zproject 的 emoji/中文值 → code（历史迁移用；台账已在 v0.4.0 移除）
const LEGACY_STATUS = {
  '🟢活跃': 'active', '🟡按需': 'on_demand', '🔵完成待维护': 'maintenance',
  '⚪暂停': 'paused', '🔴欠账': 'debt', '🧩上游': 'upstream',
  '📦归档': 'archived', '💭想法': 'idea',
};
const LEGACY_LAYER = {
  'L0 在做': 'l0', 'L1 活跃': 'l1', 'L2 按需': 'l2', 'L3 想法': 'l3', 'L4 归档': 'l4',
  L0: 'l0', L1: 'l1', L2: 'l2', L3: 'l3', L4: 'l4',
};

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
          layer               TEXT,     -- l0..l4（历史台账）
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
  {
    version: 7,
    name: 'roadmap-tables',
    up(db) {
      // 个人路线图：目标（goal）→ 树形里程碑（node，parent_id 自引用）
      db.exec(`
        CREATE TABLE IF NOT EXISTS roadmap_goal (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          title       TEXT NOT NULL,
          description TEXT,
          category    TEXT NOT NULL DEFAULT '其他',
          status      TEXT NOT NULL DEFAULT 'active',   -- active | paused | done
          target_date TEXT,                              -- YYYY-MM-DD
          completed_at TEXT,
          sort_order  INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS roadmap_node (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          goal_id     INTEGER NOT NULL,
          parent_id   INTEGER,
          title       TEXT NOT NULL,
          description TEXT,
          status      TEXT NOT NULL DEFAULT 'todo',      -- todo | doing | done | blocked
          target_date TEXT,
          completed_at TEXT,
          sort_order  INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          FOREIGN KEY (goal_id) REFERENCES roadmap_goal(id) ON DELETE CASCADE,
          FOREIGN KEY (parent_id) REFERENCES roadmap_node(id) ON DELETE CASCADE
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_roadmap_node_goal ON roadmap_node (goal_id, sort_order)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_roadmap_node_parent ON roadmap_node (parent_id, sort_order)');
    },
  },
  {
    version: 6,
    name: 'pm-v2-and-remove-ledger',
    up(db) {
      // 台账（zproject）功能取消；PM 同时管理「仓库」与「端口映射」，两者都可为空。
      db.exec(`
        CREATE TABLE IF NOT EXISTS managed_project_v2 (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          slug          TEXT NOT NULL UNIQUE,
          name          TEXT NOT NULL,
          kind          TEXT DEFAULT 'project',   -- repo | service | software | infra | project
          repo_path     TEXT,
          repo_created  INTEGER NOT NULL DEFAULT 0,
          dual_remote   INTEGER NOT NULL DEFAULT 1,
          upstream_port INTEGER UNIQUE,           -- 可空；127xx 或已有服务端口（如 8188）
          external_port INTEGER UNIQUE,           -- 可空；181xx
          nginx_enabled INTEGER NOT NULL DEFAULT 0,
          web_enabled   INTEGER NOT NULL DEFAULT 0,
          pinned        INTEGER NOT NULL DEFAULT 0,
          source        TEXT,                      -- manual | scan:repo | scan:service
          note          TEXT,
          last_commit_at      TEXT,
          last_commit_subject TEXT,
          dirty         INTEGER,
          ahead         INTEGER,
          synced_at     TEXT,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        )
      `);
      db.exec(`
        INSERT OR IGNORE INTO managed_project_v2
          (id, slug, name, repo_path, upstream_port, external_port, nginx_enabled,
           web_enabled, repo_created, dual_remote, created_at, updated_at)
        SELECT id, slug, name, repo_path, upstream_port, external_port, nginx_enabled,
               web_enabled, repo_created, dual_remote, created_at, updated_at
          FROM managed_project
      `);
      db.exec('DROP TABLE managed_project');
      db.exec('ALTER TABLE managed_project_v2 RENAME TO managed_project');
      db.exec('CREATE INDEX IF NOT EXISTS idx_mp_repo ON managed_project (repo_path)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_mp_web ON managed_project (web_enabled, nginx_enabled)');

      // 台账数据不再使用（如需归档，部署前跑 scripts/archive-legacy.js --drop）
      db.exec('DROP TABLE IF EXISTS zproject');
    },
  },
];

// 数组按版本号执行；即使后续在文件中间补迁移，也不会打乱顺序。
MIGRATIONS.sort((a, b) => a.version - b.version);

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
