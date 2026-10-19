// scripts/backup.js — 在线备份 SQLite（WAL 安全，无需停服）
//
// 用法：node scripts/backup.js
// 环境变量：DB_PATH（默认与 app 相同）、BACKUP_DIR（默认 <DB 目录>/backup/zdashboard）、BACKUP_KEEP（默认 7）
//
// 建议由 systemd timer 每天跑一次（deploy/zdashboard-backup.timer）。

import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { DB_PATH } from '../src/config.js';

const BACKUP_DIR = process.env.BACKUP_DIR || resolve(dirname(DB_PATH), 'backup', 'zdashboard');
const KEEP = Math.max(1, parseInt(process.env.BACKUP_KEEP || '7', 10) || 7);

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\.(\d{3})Z$/, '-$1');
}

mkdirSync(BACKUP_DIR, { recursive: true });
const dest = join(BACKUP_DIR, `zdb-${stamp()}.db`);

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
try {
  await db.backup(dest);
} finally {
  db.close();
}

// 只保留最近 KEEP 份（文件名按时间戳排序）
const files = readdirSync(BACKUP_DIR)
  .filter(f => /^zdb-.*\.db$/.test(f))
  .map(f => ({ f, mtime: statSync(join(BACKUP_DIR, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

let removed = 0;
for (const { f } of files.slice(KEEP)) {
  unlinkSync(join(BACKUP_DIR, f));
  removed++;
}

console.log(`[backup] ${DB_PATH} → ${dest}（保留 ${Math.min(files.length, KEEP)} 份，清理 ${removed} 份）`);
