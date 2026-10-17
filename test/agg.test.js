// 聚合存储层测试：未读水位、失败退避、保留策略
process.env.DB_PATH = ':memory:';
process.env.CHECKPOINT = 'off';

import test from 'node:test';
import assert from 'node:assert/strict';

const store = await import('../src/agg/store.js');
const { default: db } = await import('../src/db.js');

const src = { id: 's1', label: 'S1' };
const item = (id, extra = {}) => ({ id, title: id, url: `https://example.com/${id}`, createdAt: '2026-01-01T00:00:00.000Z', meta: [], ...extra });

test('首次探测全部未读；再次探测只把真正的新条目算「本次新增」', () => {
  assert.equal(store.recordProbe(src, [item('a'), item('b')]).newCount, 2);
  assert.equal(store.unreadCount('s1'), 2);
  assert.equal(store.listItems('s1', 10).every(i => i.isNew), true);

  const second = store.recordProbe(src, [item('a'), item('b'), item('c')]);
  assert.equal(second.newCount, 1);
  assert.equal(store.unreadCount('s1'), 3);   // 没打开过就一直是未读
  assert.equal(store.listItems('s1', 10).length, 3);
});

test('标记已读后未读数清零，之后的新条目重新计未读', () => {
  store.markOpened(['s1']);
  assert.equal(store.unreadCount('s1'), 0);
  assert.equal(store.listItems('s1', 10).some(i => i.isNew), false);

  store.recordProbe(src, [item('d')]);
  assert.equal(store.unreadCount('s1'), 1);
  assert.equal(store.listItems('s1', 10).find(i => i.id === 'd').isNew, true);
});

test('探测失败：保留上次成功时间，fail_count 累加，未读不变', () => {
  const before = store.stateOf('s1');
  assert.ok(before.last_ok_at);
  store.recordProbe(src, [], { error: 'boom' });
  const st = store.stateOf('s1');
  assert.equal(st.status, 'error');
  assert.equal(st.fail_count, 1);
  assert.equal(st.last_ok_at, before.last_ok_at);
  assert.equal(store.unreadCount('s1'), 1);
});

test('失败退避：刚失败不算过期；失败很久才允许重试', () => {
  const st = store.stateOf('s1');
  assert.equal(store.staleness(st, 30 * 60 * 1000).stale, false);          // 60s 退避窗口内
  db.prepare("UPDATE agg_state SET fetched_at = '2026-01-01T00:00:00.000Z', last_ok_at = '2026-01-01T00:00:00.000Z' WHERE source_id = 's1'").run();
  assert.equal(store.staleness(store.stateOf('s1'), 30 * 60 * 1000).stale, true);
});

test('从未成功过、刚失败的源也在退避窗口内（不会被每次开页面重打）', () => {
  const fresh = { id: 'never-ok', label: 'N' };
  store.recordProbe(fresh, [], { error: 'boom' });
  assert.equal(store.staleness(store.stateOf('never-ok'), 30 * 60 * 1000).stale, false);
});

test('热榜类保留最近 N 条；普通源清掉过期条目', () => {
  const ranked = { id: 'r1', label: 'R1', ranked: true };
  const rows = Array.from({ length: 205 }, (_, i) => item(`r${i}`));
  store.recordProbe(ranked, rows);

  const oldSrc = { id: 'n1', label: 'N1' };
  store.recordProbe(oldSrc, [item('old'), item('fresh')]);
  db.prepare("UPDATE agg_item SET last_seen = '2020-01-01T00:00:00.000Z' WHERE source_id = 'n1' AND item_id = 'old'").run();

  store.pruneItems([{ id: 'r1', ranked: true }, { id: 'n1' }], { rankedKeep: 200, maxAgeDays: 90 });
  const count = (id) => db.prepare('SELECT COUNT(*) n FROM agg_item WHERE source_id = ?').get(id).n;
  assert.equal(count('r1'), 200);
  assert.equal(count('n1'), 1);
});
