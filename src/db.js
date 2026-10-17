// src/db.js — SQLite 连接、建表与 WAL checkpoint 策略
//
// 约定：所有写事务结束后调用 checkpoint()。
//   CHECKPOINT=always   —— 每次写立刻 TRUNCATE（单文件 bind-mount / 容器默认）
//   CHECKPOINT=throttle —— 写后 500ms 合并一次（本机默认，避免每次点词都 fsync）
//   CHECKPOINT=off      —— 不主动 checkpoint（交给 wal_autocheckpoint / 关机时 flush）

import Database from 'better-sqlite3';
import { DB_PATH, CHECKPOINT_MODE } from './config.js';

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('wal_autocheckpoint = 100');

let timer = null;
let planned = false;

function runCheckpoint() {
  planned = false;
  try {
    const r = db.pragma('wal_checkpoint(TRUNCATE)');
    const row = Array.isArray(r) ? r[0] : r;
    if (row && row.busy) console.warn('[db] wal_checkpoint busy（有活跃读事务），下次写后再试');
  } catch (e) {
    console.warn('[db] wal_checkpoint 失败:', e.message);
  }
}

/** 写事务结束后调用；force=true 时立刻执行（关机/备份前） */
export function checkpoint(force = false) {
  if (CHECKPOINT_MODE === 'off' && !force) return;
  if (force || CHECKPOINT_MODE === 'always') {
    if (timer) { clearTimeout(timer); timer = null; }
    runCheckpoint();
    return;
  }
  planned = true;
  if (timer) return;
  timer = setTimeout(() => { timer = null; runCheckpoint(); }, 500);
  timer.unref?.();
}

/** 关机前把挂起的 checkpoint 落盘 */
export function flushCheckpoint() {
  if (timer) { clearTimeout(timer); timer = null; }
  runCheckpoint();
}

export function hasPendingCheckpoint() {
  return planned || timer != null;
}

// zVocab
db.exec(`
  CREATE TABLE IF NOT EXISTS zVocab (
    word        TEXT PRIMARY KEY,
    status      TEXT NOT NULL DEFAULT 'unknown',
    first_seen  TEXT,
    last_seen   TEXT,
    click_count INTEGER DEFAULT 0
  )
`);

// zArticles
db.exec(`
  CREATE TABLE IF NOT EXISTS zArticles (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    title     TEXT,
    content   TEXT NOT NULL,
    created   TEXT NOT NULL
  )
`);

// zWordArticles
db.exec(`
  CREATE TABLE IF NOT EXISTS zWordArticles (
    word        TEXT NOT NULL,
    article_id  INTEGER NOT NULL,
    count       INTEGER DEFAULT 1,
    PRIMARY KEY (word, article_id),
    FOREIGN KEY (article_id) REFERENCES zArticles(id) ON DELETE CASCADE
  )
`);

console.log(`[db] 已连接: ${DB_PATH}（checkpoint=${CHECKPOINT_MODE}）`);
console.log('[db] 表: zVocab, zArticles, zWordArticles');

export default db;
