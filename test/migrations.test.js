// 迁移框架：最新版本、v7 表结构、v5→v6 数据迁移
process.env.DB_PATH = ':memory:';
process.env.CHECKPOINT = 'off';

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

const { default: db } = await import('../src/db.js');
const { migrate, MIGRATIONS } = await import('../src/migrations.js');

const LATEST = MIGRATIONS.at(-1).version;

test('新库跑到最新 schema，台账表已移除', () => {
  assert.equal(db.pragma('user_version', { simple: true }), LATEST);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of ['zVocab', 'zArticles', 'zWordArticles', 'agg_item', 'agg_state', 'managed_project', 'roadmap_goal', 'roadmap_node']) {
    assert.ok(tables.includes(t), `缺表: ${t}`);
  }
  assert.equal(tables.includes('zproject'), false, 'zproject 应已移除');
  const cols = db.prepare('PRAGMA table_info(managed_project)').all().map(c => c.name);
  for (const c of ['kind', 'repo_path', 'upstream_port', 'external_port', 'nginx_enabled', 'web_enabled', 'source', 'last_commit_at']) {
    assert.ok(cols.includes(c), `managed_project 缺列: ${c}`);
  }
});

test('v5 → v6：原 managed_project 行保留，zproject 被删', () => {
  const t = new Database(':memory:');
  t.exec(`
    CREATE TABLE managed_project (
      id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE, name TEXT,
      repo_path TEXT, upstream_port INTEGER NOT NULL UNIQUE, external_port INTEGER NOT NULL UNIQUE,
      nginx_enabled INTEGER, web_enabled INTEGER, repo_created INTEGER, dual_remote INTEGER,
      created_at TEXT, updated_at TEXT
    );
    INSERT INTO managed_project (slug,name,repo_path,upstream_port,external_port,nginx_enabled,web_enabled,repo_created,dual_remote,created_at,updated_at)
      VALUES ('old','Old','/tmp/old',12710,18130,1,1,1,1,'2026-01-01','2026-01-01');
    CREATE TABLE zproject (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO zproject (name) VALUES ('ledger');
  `);
  const v6 = MIGRATIONS.find(m => m.version === 6);
  v6.up(t);
  const row = t.prepare("SELECT * FROM managed_project WHERE slug='old'").get();
  assert.equal(row.name, 'Old');
  assert.equal(row.upstream_port, 12710);
  assert.equal(row.external_port, 18130);
  assert.equal(row.kind, 'project');
  const tables = t.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  assert.equal(tables.includes('zproject'), false);
  t.close();
});

test('重复 migrate 不报错', () => {
  migrate(db);
  assert.equal(db.pragma('user_version', { simple: true }), LATEST);
});
