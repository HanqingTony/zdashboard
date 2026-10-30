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

test('路线图：多愿景 DAG、多上级、防环、状态与删除后上移', async () => {
  let snap = await call('GET', '/api/roadmap');
  assert.equal(snap.status, 200);
  assert.deepEqual(snap.data.nodes, []);
  assert.deepEqual(snap.data.edges, []);
  assert.equal(snap.data.stats.nodes, 0);

  const vision = await call('POST', '/api/roadmap/nodes', {
    title: '一人公司', kind: 'vision', status: 'doing', category: '事业',
    description: '用自动化把一个人的产能放大',
  });
  assert.equal(vision.status, 201);
  assert.equal(vision.data.node.kind, 'vision');
  assert.equal(vision.data.node.category, '事业');
  const vid = vision.data.node.id;

  const media = await call('POST', '/api/roadmap/nodes', {
    title: '个人自媒体自动化', kind: 'project', parentIds: [vid],
  });
  const print3d = await call('POST', '/api/roadmap/nodes', {
    title: '3D 打印线', kind: 'project', parentIds: [vid],
  });
  const tts = await call('POST', '/api/roadmap/nodes', {
    title: 'TTS 语音', kind: 'task', parentIds: [media.data.node.id],
  });
  const shared = await call('POST', '/api/roadmap/nodes', {
    title: '内容流水线共用素材库', kind: 'task',
    parentIds: [media.data.node.id, print3d.data.node.id],
  });
  assert.equal(shared.status, 201);
  const sid = shared.data.node.id;

  snap = await call('GET', '/api/roadmap');
  assert.equal(snap.data.stats.visions, 1);
  assert.equal(snap.data.stats.projects, 2);
  assert.equal(snap.data.stats.tasks, 2);
  assert.equal(snap.data.stats.nodes, 5);
  assert.equal(snap.data.edges.filter(e => e.childId === sid).length, 2);

  // 重复上级去重：只保留一条边
  const dup = await call('POST', '/api/roadmap/nodes', {
    title: '重复上级', kind: 'task',
    parentIds: [media.data.node.id, media.data.node.id],
  });
  assert.equal(dup.status, 201);
  assert.equal(dup.data.graph.edges.filter(e => e.childId === dup.data.node.id).length, 1);

  // 防环：media 是 shared 的祖先，不能把 media 挂到 shared 下面
  const cycle = await call('PATCH', `/api/roadmap/nodes/${media.data.node.id}`, {
    parentIds: [sid],
  });
  assert.equal(cycle.status, 400);
  assert.match(cycle.data.error, /子节点/);

  // 替换上级：tts 从 media 改挂到 3D + 愿景
  const moved = await call('PATCH', `/api/roadmap/nodes/${tts.data.node.id}`, {
    parentIds: [print3d.data.node.id, vid],
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.graph.edges.filter(e => e.childId === tts.data.node.id).length, 2);
  assert.equal(moved.data.graph.edges.filter(e => e.childId === tts.data.node.id && e.parentId === media.data.node.id).length, 0);

  // 完成状态写入 completedAt；改回 doing 清空
  const done = await call('PATCH', `/api/roadmap/nodes/${sid}`, { status: 'done' });
  assert.equal(done.status, 200);
  assert.equal(done.data.node.status, 'done');
  assert.ok(done.data.node.completedAt);
  const reopen = await call('PATCH', `/api/roadmap/nodes/${sid}`, { status: 'doing' });
  assert.equal(reopen.status, 200);
  assert.equal(reopen.data.node.completedAt, null);

  // 参数校验
  assert.equal((await call('POST', '/api/roadmap/nodes', { title: '坏日期', targetDate: '2026-02-30' })).status, 400);
  assert.equal((await call('POST', '/api/roadmap/nodes', { title: '坏类型', kind: 'epic' })).status, 400);
  assert.equal((await call('POST', '/api/roadmap/nodes', { title: '坏状态', status: 'urgent' })).status, 400);
  assert.equal((await call('POST', '/api/roadmap/nodes', { title: '缺上级', parentIds: [999999] })).status, 400);
  assert.equal((await call('POST', '/api/roadmap/nodes', { title: '长分类', category: 'x'.repeat(31) })).status, 400);
  assert.equal((await call('PATCH', '/api/roadmap/nodes/999999', { title: '不存在' })).status, 404);

  // 删除项目：节点消失，子节点保留；只挂在该项目下的子节点变成根节点
  const orphan = await call('POST', '/api/roadmap/nodes', {
    title: '孤儿里程碑', kind: 'task', parentIds: [media.data.node.id],
  });
  const del = await call('DELETE', `/api/roadmap/nodes/${media.data.node.id}`);
  assert.equal(del.status, 200);
  snap = del.data.graph;
  assert.equal(snap.nodes.some(n => n.id === media.data.node.id), false);
  assert.equal(snap.nodes.some(n => n.id === orphan.data.node.id), true);
  assert.equal(snap.edges.filter(e => e.parentId === media.data.node.id).length, 0);
  assert.equal(snap.edges.filter(e => e.childId === orphan.data.node.id).length, 0);
  assert.equal(snap.edges.filter(e => e.childId === sid).length, 1, 'shared 仍挂在 3D 线');

  // 删除愿景：其它节点不删除，3D 项目成为根节点
  const delVision = await call('DELETE', `/api/roadmap/nodes/${vid}`);
  assert.equal(delVision.status, 200);
  snap = delVision.data.graph;
  assert.equal(snap.nodes.some(n => n.id === print3d.data.node.id), true);
  assert.equal(snap.edges.filter(e => e.childId === print3d.data.node.id).length, 0);
  assert.equal(snap.stats.visions, 0);
});
