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
process.env.PM_TOKEN = 'secret';

mkdirSync(process.env.PM_STATE_DIR, { recursive: true });
mkdirSync(process.env.PM_REPO_ROOT, { recursive: true });

const { createApp } = await import('../src/app.js');
const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); rmSync(TMP, { recursive: true, force: true }); });

const json = (path, opts) => fetch(base + path, opts);
const H = { 'Content-Type': 'application/json', 'X-PM-Token': 'secret' };

test('端口条目（无仓库）+ nav + 开关 + 删除', async () => {
  const noToken = await json('/api/pm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'demo', createRepo: false }),
  });
  assert.equal(noToken.status, 401);

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
