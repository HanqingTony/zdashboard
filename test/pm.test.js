// 项目管理器：端口分配 / 建仓双远端 / nginx 期望状态
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TMP = mkdtempSync(join(tmpdir(), 'zdb-pm-'));
process.env.DB_PATH = ':memory:';
process.env.CHECKPOINT = 'off';
process.env.PM_STATE_DIR = join(TMP, 'state');
process.env.PM_REPO_ROOT = join(TMP, 'repos');
process.env.PM_NGINX_DIR = join(TMP, 'nginx');
process.env.PM_GITHUB_BASE = 'git@github.com:Test';
process.env.PM_GITEE_BASE = 'git@gitee.com:Test';

const { slugify, validateSlug, createRepo, repoInfo } = await import('../src/pm/repo.js');
const { allocatePorts } = await import('../src/pm/ports.js');
const { writeManagedState, renderManagedConf, readApplyStatus } = await import('../src/pm/nginx.js');
const store = await import('../src/pm/store.js');

test.after(() => rmSync(TMP, { recursive: true, force: true }));

test('slug 规则', () => {
  assert.equal(slugify('Test Project 01'), 'test-project-01');
  assert.equal(validateSlug('a'), false);
  assert.equal(validateSlug('ab'), true);
  assert.equal(validateSlug('-bad'), false);
});

test('端口分配：跳过已占用的 12710/18130', async () => {
  mkdirSync(join(TMP, 'nginx', 'conf.d'), { recursive: true });
  writeFileSync(join(TMP, 'nginx', 'conf.d', 'x.conf'), 'server { listen 18130 ssl; }\n');
  const ports = await allocatePorts({});
  assert.equal(ports.upstreamPort, 12710);
  assert.equal(ports.externalPort, 18131);
  await assert.rejects(() => allocatePorts({ externalPort: 18130 }), /已被占用/);
  await assert.rejects(() => allocatePorts({ upstreamPort: 9999 }), /须在/);
});

test('建仓 + 双远端 + 初始提交', async () => {
  mkdirSync(process.env.PM_REPO_ROOT, { recursive: true });
  const repo = await createRepo({
    slug: 'test-project-01', name: 'Test Project 01',
    upstreamPort: 12710, externalPort: 18131, dualRemote: true,
  });
  const info = await repoInfo(repo.repoPath);
  assert.equal(info.exists, true);
  assert.equal(info.branch, 'main');
  assert.match(info.head, /chore: init test-project-01/);
  assert.equal(info.dualPush, true);
  assert.equal(info.remotes.filter(r => r.kind === 'push').length, 2);
  assert.match(readFileSync(join(repo.repoPath, 'README.md'), 'utf8'), /127\.0\.0\.1:12710/);
});

test('nginx 期望状态：header、server 数量、关闭后为空', async () => {
  const row = store.create({
    slug: 'test-project-01', name: 'Test Project 01',
    repo_path: join(process.env.PM_REPO_ROOT, 'test-project-01'),
    upstream_port: 12710, external_port: 18131,
    nginx_enabled: 1, web_enabled: 1, repo_created: 1, dual_remote: 1,
  });
  assert.equal(store.list().length, 1);

  const conf = renderManagedConf(store.list());
  assert.match(conf.split('\n')[0], /^# Managed by zdashboard/);
  assert.equal((conf.match(/^server \{/gm) || []).length, 1);
  assert.match(conf, /proxy_pass http:\/\/127\.0\.0\.1:12710/);

  writeManagedState(store.list());
  assert.equal(readApplyStatus().ok, null);   // root helper 未运行

  store.update(row.id, { nginxEnabled: 0 });
  const second = renderManagedConf(store.list());
  assert.equal((second.match(/^server \{/gm) || []).length, 0);

  store.remove(row.id);
  assert.equal(store.list().length, 0);
});
