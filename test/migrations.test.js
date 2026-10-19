// 迁移框架：版本号、老数据映射、幂等
process.env.DB_PATH = ':memory:';
process.env.CHECKPOINT = 'off';

import test from 'node:test';
import assert from 'node:assert/strict';

const { default: db } = await import('../src/db.js');
const { migrate, MIGRATIONS } = await import('../src/migrations.js');

test('新库跑到最新 schema 版本，所有表存在', () => {
  assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.at(-1).version);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  for (const t of ['zVocab', 'zArticles', 'zWordArticles', 'agg_item', 'agg_state', 'zproject']) {
    assert.ok(tables.includes(t), `缺表: ${t}`);
  }
});

test('v3 → v4：旧 status/layer（emoji/中文）映射为 code', () => {
  db.pragma('user_version = 3');
  db.prepare("INSERT INTO zproject (name, status, layer) VALUES ('legacy-a', '🟢活跃', 'L0 在做')").run();
  db.prepare("INSERT INTO zproject (name, status, layer) VALUES ('legacy-b', '💭想法', 'L3 想法')").run();
  db.prepare("INSERT INTO zproject (name, status, layer) VALUES ('legacy-c', '自定义状态', 'L9')").run();

  migrate(db);

  const row = db.prepare("SELECT status, layer FROM zproject WHERE name = 'legacy-a'").get();
  assert.equal(row.status, 'active');
  assert.equal(row.layer, 'l0');
  const idea = db.prepare("SELECT status, layer FROM zproject WHERE name = 'legacy-b'").get();
  assert.equal(idea.status, 'idea');
  assert.equal(idea.layer, 'l3');
  // 未知值原样保留，不丢数据
  const unknown = db.prepare("SELECT status, layer FROM zproject WHERE name = 'legacy-c'").get();
  assert.equal(unknown.status, '自定义状态');
  assert.equal(unknown.layer, 'L9');
  assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.at(-1).version);
});

test('重复 migrate 不报错、不重复改数据', () => {
  const before = db.prepare("SELECT status, layer FROM zproject WHERE name = 'legacy-a'").get();
  migrate(db);
  const after = db.prepare("SELECT status, layer FROM zproject WHERE name = 'legacy-a'").get();
  assert.deepEqual(after, before);
});
