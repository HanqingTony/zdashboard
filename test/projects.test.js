// 项目台账：seed 解析 + 存储层校验
process.env.DB_PATH = ':memory:';
process.env.CHECKPOINT = 'off';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const { buildSeed } = await import('../src/projects/fromMarkdown.js');
const { STATUSES, LAYERS, VERDICTS } = await import('../public/projects-meta.js');
const store = await import('../src/projects/store.js');

const PROJECTS = `# PROJECTS

## 一、自研应用（有明确产品形态）

| 项目 | 定位 | 技术栈 | 状态 | 部署 / 端口 | 下一步 |
|---|---|---|---|---|---|
| **zdashboard** | 面板 | Node | 🟢 活跃 | 127.0.0.1:28100 | 收口 |
| **zup / comfy-web** | 工作台 | Deno | 🟡 按需 | 28104 | 修 e2e |

## 三、上游依赖 / 第三方（本地克隆，非自研）

| 项目 | 用途 | 部署 | 状态 |
|---|---|---|---|
| ComfyUI | 图像引擎 | 101:8188 | 🧩 跟随上游 |

## 六、归档与退役

| 项目 | 归档位置 | 原因 |
|---|---|---|
| oldthing | znote/archive/x | 已归档 |
`;

const IDEAS = `# IDEAS

### A 档（候选池）

| # | 想法 | F | C | I | 合计 | 备注 |
|---|---|---|---|---|---|---|
| 1 | \`idea/foo.md\` | 5 | 4 | 4 | **13** | 好想法 |

### D 档（冻结）

| 想法 | F | C | I | 合计 | 冻结理由 |
|---|---|---|---|---|---|
| bar-idea | 1 | 1 | 1 | 3 | 没有价值 |
`;

const PORTFOLIO = `## 四、风险与欠账（需要你决策的都在这里）

| # | 事项 | 影响 | 建议 |
|---|---|---|---|
| 1 | **zdashboard 未推送** | 只在本机 | git push |
`;

function fixture(projects = PROJECTS) {
  const dir = mkdtempSync(join(tmpdir(), 'zdb-seed-'));
  writeFileSync(join(dir, 'PROJECTS.md'), projects);
  writeFileSync(join(dir, 'IDEAS-RANKING.md'), IDEAS);
  writeFileSync(join(dir, 'PORTFOLIO.md'), PORTFOLIO);
  return dir;
}

test('buildSeed 解析项目/想法/风险，并修正 L0 置顶', () => {
  const dir = fixture();
  try {
    const rows = buildSeed({ zpaDir: dir, zrepoDir: dir });
    assert.equal(rows.length, 6);   // 4 个项目 + 2 个想法
    for (const r of rows) {
      assert.ok(STATUSES.includes(r.status), `未知状态: ${r.status}`);
      assert.ok(LAYERS.includes(r.layer), `未知层: ${r.layer}`);
    }

    const dash = rows.find(r => r.name === 'zdashboard');
    assert.equal(dash.status, 'active');
    assert.equal(dash.layer, 'l0');
    assert.equal(dash.pinned, 1);
    assert.match(dash.risk, /只在本机/);

    const comfy = rows.find(r => r.name === 'zup / comfy-web');
    assert.equal(comfy.layer, 'l0');

    const foo = rows.find(r => r.name === 'foo');
    assert.equal(foo.kind, 'idea');
    assert.equal(foo.grade, 'A');
    assert.equal(foo.score, 13);
    assert.equal(foo.source, 'znote/idea/idea/foo.md'.replace('/idea/idea/', '/idea/'));

    const bar = rows.find(r => r.name === 'bar-idea');
    assert.equal(bar.grade, 'D');
    assert.match(bar.note, /^冻结理由：/);

    const archived = rows.find(r => r.name === 'oldthing');
    assert.equal(archived.layer, 'l4');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('表格列数不足时报错并带行号（不再静默写入 undefined）', () => {
  const broken = `## 一、自研应用\n\n| 项目 | 定位 | 技术栈 | 状态 | 部署 / 端口 | 下一步 |\n|---|---|---|---|---|---|\n| broken | 只有两列 |\n`;
  const dir = fixture(broken);
  try {
    assert.throws(() => buildSeed({ zpaDir: dir, zrepoDir: dir }), /PROJECTS\.md:\d+ 表格列数不足/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('zpa 目录不存在时给出明确错误', () => {
  assert.throws(() => buildSeed({ zpaDir: '/nonexistent/zpa', zrepoDir: '/tmp' }), /找不到 zpa 清单/);
});

test('台账 CRUD：评分重算、枚举校验、git 批量写回', () => {
  const created = store.create({ name: 'idea-x', kind: 'idea', status: '💭想法' });   // 旧值会被归一化
  assert.equal(created.status, 'idea');
  assert.equal(created.name, 'idea-x');

  const scored = store.update(created.id, { feasibility: 5, completeness: 4, importance: 4 });
  assert.equal(scored.score, 13);
  assert.equal(scored.grade, 'A');

  assert.throws(() => store.update(created.id, { status: '乱写' }), /无效 status/);
  assert.throws(() => store.update(created.id, { verdict: 'maybe' }), /无效 verdict/);
  assert.throws(() => store.update(created.id, { feasibility: 9 }), /1-5/);

  store.update(created.id, { verdict: 'alive', note: '手动备注' });
  store.saveGitMany([{ id: created.id, last_commit_at: '2026-10-17', last_commit_subject: 'x', dirty: 2, ahead: 1, remote: 'github.com' }]);
  const after = store.get(created.id);
  assert.equal(after.verdict, 'alive');
  assert.equal(after.dirty, 2);
  assert.equal(after.remote, 'github.com');

  assert.equal(store.remove(created.id), true);
  assert.equal(store.get(created.id), null);
});

test('导入幂等：不覆盖操作字段，但清单字段会更新', () => {
  store.upsertMany([{ name: 'p1', kind: 'repo', status: '🟢活跃', next_step: '旧', layer: 'L1 活跃' }]);
  const row = store.list({ kind: 'repo' }).find(x => x.name === 'p1');
  store.update(row.id, { status: '⚪暂停', next_step: '手动下一步' });

  store.upsertMany([{ name: 'p1', kind: 'repo', status: '🟡按需', next_step: '新', stack: 'Node' }]);
  const after = store.list({ kind: 'repo' }).find(x => x.name === 'p1');
  assert.equal(after.status, 'paused');           // 操作字段保留
  assert.equal(after.next_step, '手动下一步');
  assert.equal(after.stack, 'Node');              // 清单字段更新
});
