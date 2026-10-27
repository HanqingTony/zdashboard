// PM API：端口条目（无仓库）/ 主页 nav / 开关 / 删除
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TMP = mkdtempSync(join(tmpdir(), 'zdb-pm-api-'));
process.env.DB_PATH = ':memory:';
process.env.CHECKPOINT = 'off';
process.env.PM_STATE_DIR = join(TMP, 'state');
process.env.PM_REPO_ROOT = join(TMP, 'repos');
process.env.PM_NGINX_DIR = join(TMP, 'nginx');

mkdirSync(process.env.PM_STATE_DIR, { recursive: true });
mkdirSync(process.env.PM_REPO_ROOT, { recursive: true });

const { createApp } = await import('../src/app.js');
const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); rmSync(TMP, { recursive: true, force: true }); });

const json = (path, opts) => fetch(base + path, opts);
const H = { 'Content-Type': 'application/json' };

test('端口条目（无仓库）+ nav + 开关 + 删除（无 PM 口令）', async () => {
  const created = await (await json('/api/pm', {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'demo', createRepo: false, managePorts: true, nginxEnabled: true, webEnabled: true }),
  })).json();
  assert.equal(created.ok, true);
  assert.equal(created.project.repo_path, null);
  assert.ok(created.project.upstream_port >= 12710);
  assert.ok(created.project.external_port >= 18130);

  const nav = await (await json('/api/nav')).json();
  assert.equal(nav.groups[0].name, '我的项目');
  assert.equal(nav.groups[0].items[0].port, String(created.project.external_port));

  const id = created.project.id;
  const off = await (await json(`/api/pm/${id}`, {
    method: 'PATCH', headers: H, body: JSON.stringify({ nginxEnabled: false }),
  })).json();
  assert.equal(off.project.nginx_enabled, false);
  const nav2 = await (await json('/api/nav')).json();
  assert.equal(nav2.groups.some(g => g.name === '我的项目'), false);

  assert.equal((await json(`/api/pm/${id}`, { method: 'DELETE', headers: H })).status, 200);
  const list = await (await json('/api/pm')).json();
  assert.equal(list.projects.length, 0);
});

test('仓库/端口解耦：解绑一侧不删另一侧', async () => {
  // 只有仓库
  const repo = await (await json('/api/pm', {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'repotest', slug: 'repotest', createRepo: true, managePorts: false }),
  })).json();
  assert.equal(repo.ok, true);
  assert.ok(repo.project.repo_path);
  assert.equal(repo.project.upstream_port, null);

  const rid = repo.project.id;
  // 给仓库加端口
  const withPort = await (await json(`/api/pm/${rid}`, {
    method: 'PATCH', headers: H,
    body: JSON.stringify({ upstreamPort: '', externalPort: '', nginxEnabled: true, webEnabled: true }),
  })).json();
  assert.ok(withPort.project.upstream_port >= 12710);
  assert.ok(withPort.project.external_port >= 18130);

  // 解绑仓库 → 端口保留，行还在
  assert.equal((await json(`/api/pm/${rid}/repo`, { method: 'DELETE', headers: H })).status, 200);
  let rows = (await (await json('/api/pm')).json()).projects;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].repo_path, null);
  assert.ok(rows[0].upstream_port);

  // 再解绑端口 → 行删除
  assert.equal((await json(`/api/pm/${rid}/ports`, { method: 'DELETE', headers: H })).status, 200);
  rows = (await (await json('/api/pm')).json()).projects;
  assert.equal(rows.length, 0);
});

test('扫描模式：只扫端口 / 只扫仓库', async () => {
  const ports = await (await json('/api/pm/scan?what=ports', { method: 'POST', headers: H })).json();
  assert.ok(Array.isArray(ports.created));
  const repos = await (await json('/api/pm/scan?what=repos', { method: 'POST', headers: H })).json();
  assert.ok(Array.isArray(repos.created));
  const bad = await json('/api/pm/scan?what=xxx', { method: 'POST', headers: H });
  assert.equal(bad.status, 400);
});

test('新建仓库默认自动分配并注册一组端口', async () => {
  const created = await (await json('/api/pm', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      name: 'autoport', slug: 'autoport', createRepo: true, managePorts: true,
      dualRemote: true, nginxEnabled: false, webEnabled: false,
    }),
  })).json();
  assert.equal(created.ok, true);
  assert.ok(created.project.repo_path);
  assert.ok(created.project.upstream_port >= 12710);
  assert.ok(created.project.external_port >= 18130);
  assert.equal(created.project.nginx_enabled, false);
  assert.equal(created.project.web_enabled, false);
  assert.equal((await json(`/api/pm/${created.project.id}`, { method: 'DELETE', headers: H })).status, 200);
});
