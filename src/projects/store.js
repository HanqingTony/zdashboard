// src/projects/store.js — 项目台账的落库层
//
// 设计：**zpa 仓库里的清单是事实源**（PROJECTS.md / IDEAS-RANKING.md / PORTFOLIO.md），
//       本表是**操作层**：状态/层/下一步/备注/风险/想法判决 在这里改，导入时不覆盖。
// 表：zproject（一表到底，够用就好）

import db, { checkpoint } from '../db.js';
import { nowIso } from '../lib/time.js';
import { STATUSES, LAYERS, VERDICTS, gradeOf } from '../../public/projects-meta.js';

export { STATUSES, LAYERS, VERDICTS };

db.exec(`
  CREATE TABLE IF NOT EXISTS zproject (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL UNIQUE,      -- 唯一键（导入幂等靠它）
    kind               TEXT,                       -- repo | infra | upstream | data | idea | service
    board              TEXT,                       -- 板块：工程 / 基建 / 想法（Portfolio 的口径）
    layer              TEXT,                       -- L0 在做 / L1 活跃 / L2 按需 / L3 想法 / L4 归档
    status             TEXT,                       -- 🟢活跃 🟡按需 ⚪暂停 🔴欠账 📦归档 💭想法
    -- 想法评分（只有 kind='idea' 有）
    feasibility        INTEGER,                    -- F 1-5
    completeness       INTEGER,                    -- C 1-5
    importance         INTEGER,                    -- I 1-5
    score              INTEGER,                    -- F+C+I
    grade              TEXT,                       -- A/B/C/D
    verdict            TEXT,                       -- 想法判决：alive / parked / killed
    -- 工程信息
    stack              TEXT,
    repo_path          TEXT,
    remote             TEXT,
    deploy             TEXT,
    ports              TEXT,
    next_step          TEXT,
    risk               TEXT,
    note               TEXT,
    source             TEXT,                       -- 来源文件 / 路径
    -- git 派生（/api/projects/sync 刷新）
    last_commit_at     TEXT,
    last_commit_subject TEXT,
    dirty              INTEGER,
    ahead              INTEGER,
    synced_at          TEXT,
    pinned             INTEGER DEFAULT 0,
    created_at         TEXT,
    updated_at         TEXT
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_project_kind ON zproject (kind, grade)');
db.exec('CREATE INDEX IF NOT EXISTS idx_project_layer ON zproject (layer)');

const COLS = [
  'name', 'kind', 'board', 'layer', 'status', 'feasibility', 'completeness', 'importance',
  'score', 'grade', 'verdict', 'stack', 'repo_path', 'remote', 'deploy', 'ports',
  'next_step', 'risk', 'note', 'source', 'pinned',
];

// 导入时"库里已有值就不覆盖"的操作字段（其余字段以清单为准）
const OPERATIONAL = new Set(['status', 'layer', 'next_step', 'note', 'risk', 'verdict']);

const EDITABLE = Object.freeze([
  'board', 'layer', 'status', 'verdict', 'next_step', 'risk', 'note', 'stack',
  'deploy', 'ports', 'repo_path', 'remote', 'pinned', 'feasibility', 'completeness', 'importance',
]);

/** 导入用：按 name 幂等 upsert；操作字段不被空值/清单覆盖 */
export function upsertMany(rows) {
  const setSql = COLS.filter(c => c !== 'name').map(c => OPERATIONAL.has(c)
    ? `${c} = COALESCE(NULLIF(zproject.${c}, ''), excluded.${c})`
    : `${c} = COALESCE(excluded.${c}, zproject.${c})`
  ).join(',\n      ');

  const ins = db.prepare(`
    INSERT INTO zproject (${COLS.join(',')}, created_at, updated_at)
    VALUES (${COLS.map(c => '@' + c).join(',')}, @now, @now)
    ON CONFLICT(name) DO UPDATE SET
      ${setSql},
      updated_at = @now
  `);

  const now = nowIso();
  let n = 0;
  const tx = db.transaction(list => {
    for (const r of list) {
      const row = { now };
      for (const c of COLS) row[c] = r[c] ?? null;
      ins.run(row);
      n++;
    }
  });
  tx(rows);
  checkpoint();
  return n;
}

export function list({ kind, board, layer, status, grade, verdict, q } = {}) {
  const where = [];
  const args = {};
  if (kind) { where.push('kind = @kind'); args.kind = kind; }
  if (board) { where.push('board = @board'); args.board = board; }
  if (layer) { where.push('layer = @layer'); args.layer = layer; }
  if (status) { where.push('status = @status'); args.status = status; }
  if (grade) { where.push('grade = @grade'); args.grade = grade; }
  if (verdict) { where.push('verdict = @verdict'); args.verdict = verdict; }
  if (q) {
    where.push('(name LIKE @q OR note LIKE @q OR next_step LIKE @q OR stack LIKE @q)');
    args.q = `%${q}%`;
  }
  const sql = `SELECT * FROM zproject ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY pinned DESC,
             CASE kind WHEN 'repo' THEN 0 WHEN 'service' THEN 1 WHEN 'infra' THEN 2 WHEN 'data' THEN 3 WHEN 'upstream' THEN 4 ELSE 5 END,
             CASE grade WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 WHEN 'D' THEN 3 ELSE 9 END,
             score DESC, name`;
  return db.prepare(sql).all(args);
}

export function get(id) {
  return db.prepare('SELECT * FROM zproject WHERE id = ?').get(id) || null;
}

const scoreNum = (v, field) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error(`${field} 须为 1-5 的整数`);
  return n;
};

export function create(data = {}) {
  const name = String(data.name ?? '').trim();
  if (!name) throw new Error('缺少 name');
  if (data.status != null && data.status !== '' && !STATUSES.includes(data.status)) throw new Error(`无效 status: ${data.status}`);
  if (data.layer != null && data.layer !== '' && !LAYERS.includes(data.layer)) throw new Error(`无效 layer: ${data.layer}`);
  if (data.verdict != null && data.verdict !== '' && !VERDICTS.includes(data.verdict)) throw new Error(`无效 verdict: ${data.verdict}`);
  for (const k of ['feasibility', 'completeness', 'importance']) {
    if (data[k] != null && data[k] !== '') data[k] = scoreNum(data[k], k);
  }
  if ([data.feasibility, data.completeness, data.importance].every(v => v != null)) {
    data.score = data.feasibility + data.completeness + data.importance;
    data.grade = gradeOf(data.score);
  }
  const keys = COLS.filter(k => data[k] !== undefined && data[k] !== '');
  if (!keys.includes('name')) keys.unshift('name');
  const row = { now: nowIso() };
  for (const k of keys) row[k] = k === 'name' ? name : data[k];

  db.prepare(`
    INSERT INTO zproject (${keys.join(',')}, created_at, updated_at)
    VALUES (${keys.map(k => '@' + k).join(',')}, @now, @now)
  `).run(row);
  checkpoint();
  return db.prepare('SELECT * FROM zproject WHERE name = ?').get(name);
}

export function update(id, patch = {}) {
  const cur = get(id);
  if (!cur) return null;

  const data = {};
  for (const k of EDITABLE) if (k in patch) data[k] = patch[k];

  if ('status' in data && !STATUSES.includes(data.status)) throw new Error(`无效 status: ${data.status}`);
  if ('layer' in data && !LAYERS.includes(data.layer)) throw new Error(`无效 layer: ${data.layer}`);
  if ('verdict' in data && data.verdict != null && data.verdict !== '' && !VERDICTS.includes(data.verdict)) {
    throw new Error(`无效 verdict: ${data.verdict}`);
  }
  for (const k of ['feasibility', 'completeness', 'importance']) {
    if (k in data) data[k] = scoreNum(data[k], k);
  }

  // F/C/I 任一变动且三项齐全 → 重算 score/grade（原先会改写模块级 EDITABLE 数组）
  if (['feasibility', 'completeness', 'importance'].some(k => k in data)) {
    const f = 'feasibility' in data ? data.feasibility : cur.feasibility;
    const c = 'completeness' in data ? data.completeness : cur.completeness;
    const i = 'importance' in data ? data.importance : cur.importance;
    if ([f, c, i].every(v => v != null)) {
      const score = f + c + i;
      data.score = score;
      data.grade = gradeOf(score);
    }
  }

  const keys = Object.keys(data);
  if (!keys.length) return cur;

  db.prepare(`
    UPDATE zproject SET ${keys.map(k => `${k} = @${k}`).join(', ')}, updated_at = @now
    WHERE id = @id
  `).run({ ...data, id, now: nowIso() });
  checkpoint();
  return get(id);
}

export function remove(id) {
  const n = db.prepare('DELETE FROM zproject WHERE id = ?').run(id).changes;
  if (n > 0) checkpoint();
  return n > 0;
}

/** 批量写 git 派生字段（一次事务 + 一次 checkpoint） */
export function saveGitMany(rows) {
  if (!rows.length) return 0;
  const stmt = db.prepare(`
    UPDATE zproject
       SET last_commit_at = @last_commit_at,
           last_commit_subject = @last_commit_subject,
           dirty = @dirty,
           ahead = @ahead,
           remote = COALESCE(@remote, remote),
           synced_at = @synced_at,
           updated_at = @synced_at
     WHERE id = @id
  `);
  const now = nowIso();
  const tx = db.transaction(list => {
    for (const r of list) stmt.run({ ...r, synced_at: r.synced_at || now });
  });
  tx(rows);
  checkpoint();
  return rows.length;
}

export function saveGit(id, g) {
  return saveGitMany([{ id, ...g }]);
}

export function stats() {
  const by = (col) => db.prepare(`SELECT COALESCE(${col},'—') k, COUNT(*) n FROM zproject GROUP BY 1 ORDER BY n DESC`).all();
  return {
    total: db.prepare('SELECT COUNT(*) n FROM zproject').get().n,
    byKind: by('kind'),
    byLayer: by('layer'),
    byStatus: by('status'),
    byGrade: db.prepare("SELECT COALESCE(grade,'—') k, COUNT(*) n FROM zproject GROUP BY 1 ORDER BY 1").all(),
    ideas: db.prepare("SELECT COUNT(*) n FROM zproject WHERE kind='idea'").get().n,
    ideasNoVerdict: db.prepare("SELECT COUNT(*) n FROM zproject WHERE kind='idea' AND (verdict IS NULL OR verdict='')").get().n,
    reposWithRisk: db.prepare("SELECT COUNT(*) n FROM zproject WHERE risk IS NOT NULL AND risk <> ''").get().n,
  };
}
