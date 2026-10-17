// src/config.js — 环境变量集中读取（不再有 config.json：README 曾写错，已改）
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = resolve(__dirname, '..');
export const PUBLIC_DIR = resolve(APP_ROOT, 'public');

const int = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

// PORT 是本服务的监听端口；ZDASHBOARD_PORT 是 .run/compose 时代的历史别名
export const PORT = int(process.env.PORT ?? process.env.ZDASHBOARD_PORT, 3100);
export const HOST = process.env.HOST || '127.0.0.1';
export const DB_PATH = process.env.DB_PATH || resolve(APP_ROOT, 'zdb.db');

// 可选写保护：设置后，除 /api/health 外的 /api/* 需要 X-ZToken 或 Bearer
export const AUTH_TOKEN = process.env.AUTH_TOKEN || '';

// WAL checkpoint 策略：always（每次写）/ throttle（写后 500ms 合并）/ off
export const CHECKPOINT_MODE = (process.env.CHECKPOINT || 'throttle').toLowerCase();

// 项目台账的事实源（zpa 清单）与仓库根目录
export const ZPA_DIR = process.env.ZPA_DIR || '/home/tony/zrepo/zpa';
export const ZREPO_DIR = process.env.ZREPO_DIR || '/home/tony/zrepo';

export const VERSION = JSON.parse(readFileSync(resolve(APP_ROOT, 'package.json'), 'utf8')).version;
