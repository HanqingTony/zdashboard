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

// 可选 Host 白名单（逗号分隔，不含端口）；留空 = 不校验。用于防 DNS rebinding。
export const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

// WAL checkpoint 策略：always（每次写）/ throttle（写后 500ms 合并）/ off
export const CHECKPOINT_MODE = (process.env.CHECKPOINT || 'throttle').toLowerCase();

// 仓库根目录（项目管理器扫描/建仓）
export const ZREPO_DIR = process.env.ZREPO_DIR || '/home/tony/zrepo';

// ---------- 项目管理器（PM） ----------
// 端口段：127xx 回环上游（新项目专用 12710+），181xx 对外入口（托管项目 18130+）
export const PM_UPSTREAM_MIN = int(process.env.PM_UPSTREAM_MIN, 12710);
export const PM_UPSTREAM_MAX = int(process.env.PM_UPSTREAM_MAX, 12799);
export const PM_EXTERNAL_MIN = int(process.env.PM_EXTERNAL_MIN, 18130);
export const PM_EXTERNAL_MAX = int(process.env.PM_EXTERNAL_MAX, 18189);

export const PM_PUBLIC_HOST = process.env.PM_PUBLIC_HOST || '192.168.0.102';
export const PM_REPO_ROOT = process.env.PM_REPO_ROOT || ZREPO_DIR;
export const PM_GIT_OWNER = process.env.PM_GIT_OWNER || 'HanqingTony';
export const PM_GITHUB_BASE = process.env.PM_GITHUB_BASE || `git@github.com:${PM_GIT_OWNER}`;
export const PM_GITEE_BASE = process.env.PM_GITEE_BASE || `git@gitee.com:${PM_GIT_OWNER}`;
export const PM_GIT_NAME = process.env.PM_GIT_NAME || 'tony';
export const PM_GIT_EMAIL = process.env.PM_GIT_EMAIL || 'tony@zmain.local';

// 期望状态/应用状态目录（app 可写；root helper 读取）
export const PM_STATE_DIR = process.env.PM_STATE_DIR || resolve(dirname(DB_PATH), 'zdashboard');
export const PM_NGINX_CONF_STAGING = resolve(PM_STATE_DIR, 'pm-nginx.conf');
export const PM_NGINX_STATUS = resolve(PM_STATE_DIR, 'pm-nginx-status.json');
export const PM_NGINX_DIR = process.env.PM_NGINX_DIR || '/etc/nginx';
export const PM_TLS_CERT = process.env.PM_TLS_CERT || '/etc/nginx/ssl/zmain.crt';
export const PM_TLS_KEY = process.env.PM_TLS_KEY || '/etc/nginx/ssl/zmain.key';


export const VERSION = JSON.parse(readFileSync(resolve(APP_ROOT, 'package.json'), 'utf8')).version;
