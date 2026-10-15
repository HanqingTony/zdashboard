// src/projects/store.js — 项目台账的落库层
//
// 设计：**zpa 仓库里的清单是事实源**（PROJECTS.md / IDEAS-RANKING.md / PORTFOLIO.md），
//       本表是**操作层**：状态、下一步、备注、想法判决（活/死）在这里改，导入时不被覆盖那些字段。
// 表：zproject（一表到底，够用就好）

import db from '../db.js';

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
    created_at         TEXT DEFAULT (datetime('now','localtime')),
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

/** 导入用：只在"来自清单"的字段上 upsert；status/next_step/note/verdict/risk 若库里已有值则不覆盖 */
export function upsertMany(rows) {
  const ins = db.prepare(`
    INSERT INTO zproject (${COLS.join(',')}, created_at, updated_at)
    VALUES (${COLS.map(c => '@' + c).join(',')}, datetime('now','localtime'), datetime('now','localtime'))
    ON CONFLICT(name) DO UPDATE SET
      ${COLS.filter(c => c !== 'name').map(c => `${c} = COALESCE(NULLIF(zproject.${c}, ''), excluded.${c})`).join(',\n      ')},
      updated_at = datetime('now','localtime')
  `);
  let n = 0;
  const tx = db.transaction(list => {
    for (const r of list) {
      const row = {};
      for (const c of COLS) row[c] = r[c] ?? null;
      ins.run(row);
      n++;
    }
  });
  tx(rows);
  db.pragma('wal_checkpoint(TRUNCATE)');
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
  if (q) { where.push('(name LIKE @q OR note LIKE @q OR next_step LIKE @q OR stack LIKE @q)'); args.q = `%${q}%`; }
  const sql = `SELECT * FROM zproject ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY pinned DESC,
             CASE kind WHEN 'repo' THEN 0 WHEN 'service' THEN 1 WHEN 'infra' THEN 2 WHEN 'data' THEN 3 WHEN 'upstream' THEN 4 ELSE 5 END,
             CASE grade WHEN 'A' THEN 0 WHEN 'B' THEN 1 WHEN 'C' THEN 2 WHEN 'D' THEN 3 ELSE 9 END,
             score DESC, name`;
  return db.prepare(sql).all(args);
}

export function get(id) {
  return db.prepare('SELECT * FROM zproject WHERE id = ?').get(id);
}

export function create(data) {
  const keys = Object.keys(data).filter(k => COLS.includes(k) || ['feasibility', 'completeness', 'importance'].includes(k));
  db.prepare(`INSERT INTO zproject (${keys.join(',')}, created_at, updated_at)
              VALUES (${keys.map(k => '@' + k).join(',')}, datetime('now','localtime'), datetime('now','localtime'))`)
    .run(Object.fromEntries(keys.map(k => [k, data[k] ?? null])));
  db.pragma('wal_checkpoint(TRUNCATE)');
  return db.prepare('SELECT * FROM zproject WHERE name = ?').get(data.name);
}

const EDITABLE = ['board', 'layer', 'status', 'verdict', 'next_step', 'risk', 'note', 'stack',
  'deploy', 'ports', 'repo_path', 'remote', 'pinned', 'feasibility', 'completeness', 'importance'];

export function update(id, patch) {
  const keys = Object.keys(patch).filter(k => EDITABLE.includes(k));
  if (keys.length === 0) return get(id);
  if (keys.includes('feasibility') || keys.includes('completeness') || keys.includes('importance')) {
    const cur = get(id);
    const f = patch.feasibility ?? cur.feasibility, c = patch.completeness ?? cur.completeness, i = patch.importance ?? cur.importance;
    if ([f, c, i].every(v => v != null)) {
      patch = { ...patch, score: f + c + i, grade: (f + c + i) >= 12 ? 'A' : (f + c + i) >= 9 ? 'B' : (f + c + i) >= 6 ? 'C' : 'D' };
      for (const k of ['score', 'grade']) if (!EDITABLE.includes(k)) EDITABLE.push(k), keys.push(k);
    }
  }
  db.prepare(`UPDATE zproject SET ${keys.map(k => `${k} = @${k}`).join(', ')}, updated_at = datetime('now','localtime') WHERE id = @id`)
    .run({ ...patch, id });
  db.pragma('wal_checkpoint(TRUNCATE)');
  return get(id);
}

export function remove(id) {
  const n = db.prepare('DELETE FROM zproject WHERE id = ?').run(id).changes;
  db.pragma('wal_checkpoint(TRUNCATE)');
  return n > 0;
}

export function saveGit(id, g) {
  db.prepare(`UPDATE zproject SET last_commit_at=@last_commit_at, last_commit_subject=@last_commit_subject,
              dirty=@dirty, ahead=@ahead, remote=COALESCE(@remote, remote), synced_at=datetime('now','localtime'),
              updated_at=datetime('now','localtime') WHERE id=@id`).run({ ...g, id });
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
