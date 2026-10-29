process.env.DB_PATH = ':memory:';
process.env.CHECKPOINT = 'off';

import test from 'node:test';
import assert from 'node:assert/strict';
const { createApp } = await import('../src/app.js');

const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};

test.after(() => server.close());

test('路线图：目标/树形里程碑/完成状态/防环/级联删除', async () => {
  let snap = await call('GET', '/api/roadmap');
  assert.equal(snap.status, 200);
  assert.deepEqual(snap.data.goals, []);
  assert.deepEqual(snap.data.nodes, []);

  const goal = await call('POST', '/api/roadmap/goals', {
    title: '跑完半马',
    category: '健康',
    description: '12 周训练',
    targetDate: '2026-12-31',
  });
  assert.equal(goal.status, 200);
  const goalId = goal.data.goal.id;
  assert.equal(goal.data.goal.status, 'active');

  const badDate = await call('POST', '/api/roadmap/goals', {
    title: '坏日期', category: '学习', targetDate: '2026-02-30',
  });
  assert.equal(badDate.status, 400);

  const root = await call('POST', '/api/roadmap/nodes', {
    goalId, title: '基础期', status: 'doing',
  });
  const child = await call('POST', '/api/roadmap/nodes', {
    goalId, parentId: root.data.node.id, title: '完成 5 公里',
  });
  assert.equal(child.status, 200);
  assert.equal(child.data.node.parent_id, root.data.node.id);

  snap = await call('GET', '/api/roadmap');
  assert.equal(snap.data.stats.goals, 1);
  assert.equal(snap.data.stats.nodes, 2);
  assert.equal(snap.data.stats.progress, 0);

  const done = await call('PATCH', `/api/roadmap/nodes/${child.data.node.id}`, { status: 'done' });
  assert.equal(done.status, 200);
  assert.equal(done.data.node.status, 'done');
  assert.ok(done.data.node.completed_at);

  const cycle = await call('PATCH', `/api/roadmap/nodes/${root.data.node.id}`, {
    parentId: child.data.node.id,
  });
  assert.equal(cycle.status, 400);
  assert.match(cycle.data.error, /子节点/);

  const moved = await call('PATCH', `/api/roadmap/nodes/${child.data.node.id}`, { parentId: null });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.node.parent_id, null);

  const goalDone = await call('PATCH', `/api/roadmap/goals/${goalId}`, { status: 'done' });
  assert.equal(goalDone.status, 200);
  assert.ok(goalDone.data.goal.completed_at);

  const del = await call('DELETE', `/api/roadmap/goals/${goalId}`);
  assert.equal(del.status, 200);

  snap = await call('GET', '/api/roadmap');
  assert.equal(snap.data.goals.length, 0);
  assert.equal(snap.data.nodes.length, 0);
});
