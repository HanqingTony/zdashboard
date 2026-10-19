// scripts/archive-legacy.js — 把历史遗留表归档到独立数据库，再从主库删除
//
// 用法：
//   node scripts/archive-legacy.js            # 只归档，不动主库
//   node scripts/archive-legacy.js --drop     # 归档后 DROP TABLE
//
// 默认处理 zInfra / zObjects（v0.1 时代的任务表与 MinIO 对象元数据）。
// 归档文件默认写到 BACKUP_DIR 或 <DB 目录>/backup/legacy。

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { DB_PATH } from '../src/config.js';

const TABLES = ['zInfra', 'zObjects'];
const DROP = process.argv.includes('--drop');
const OUT_DIR = process.env.LEGACY_DIR || resolve(dirname(DB_PATH), 'backup', 'legacy');
const stamp = (() => {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
})();

mkdirSync(OUT_DIR, { recursive: true });
const archivePath = join(OUT_DIR, `legacy-${stamp}.db`);

const src = new Database(DB_PATH);
src.pragma('busy_timeout = 5000');
const dst = new Database(archivePath);

const existing = src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN (?, ?)")
  .all(...TABLES).map(r => r.name);

if (existing.length === 0) {
  console.log('[archive] 没有需要归档的历史表');
  dst.close();
  src.close();
  process.exit(0);
}

const copyOne = (table) => {
  const ddl = src.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(table)?.sql;
  if (!ddl) return 0;
  dst.exec(ddl);

  const indexes = src.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL")
    .all(table);
  for (const idx of indexes) dst.exec(idx.sql);

  const rows = src.prepare(`SELECT * FROM ${table}`).all();
  if (rows.length) {
    const cols = Object.keys(rows[0]);
    const insert = dst.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})`);
    dst.transaction(list => { for (const row of list) insert.run(row); })(rows);
  }
  return rows.length;
};

let total = 0;
for (const table of existing) {
  const n = copyOne(table);
  total += n;
  console.log(`[archive] ${table}: ${n} 行 → ${archivePath}`);
}
dst.close();

if (DROP) {
  const drop = src.transaction(() => {
    for (const table of existing) src.exec(`DROP TABLE ${table}`);
  });
  drop();
  src.pragma('wal_checkpoint(TRUNCATE)');
  console.log(`[archive] 已从主库删除: ${existing.join(', ')}`);
} else {
  console.log('[archive] 未加 --drop，主库保持不变');
}

src.close();
console.log(`[archive] 共归档 ${total} 行；归档库: ${archivePath}`);
