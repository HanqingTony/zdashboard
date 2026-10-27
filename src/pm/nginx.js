// src/pm/nginx.js — 生成托管项目的 nginx 配置（期望状态）
//
// app 只写 /home/tony/zdata/zdashboard/pm-nginx.conf；
// root 的 zdashboard-nginx-apply.service（path unit 触发）负责安装到 conf.d、
// nginx -t、reload，并回写 pm-nginx-status.json。

import { writeFileSync, renameSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { resolve } from 'path';
import {
  PM_NGINX_CONF_STAGING, PM_NGINX_STATUS, PM_STATE_DIR,
  PM_TLS_CERT, PM_TLS_KEY, PM_PUBLIC_HOST,
} from '../config.js';
import { nowIso } from '../lib/time.js';

const HEADER = '# Managed by zdashboard (project manager). DO NOT EDIT.';

function serverBlock(p) {
  const name = String(p.name || p.slug).replace(/[\r\n]+/g, ' ').slice(0, 80);
  return `# ${p.slug}: ${name}
server {
    listen ${p.external_port} ssl;
    listen [::]:${p.external_port} ssl;
    server_name _;
    ssl_certificate     ${PM_TLS_CERT};
    ssl_certificate_key ${PM_TLS_KEY};
    client_max_body_size 100m;
    location / {
        proxy_pass http://127.0.0.1:${p.upstream_port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
    }
}
`;
}

export function renderManagedConf(projects, { at = nowIso() } = {}) {
  const enabled = projects.filter(p => p.nginx_enabled);
  return `${HEADER}
# generated: ${at}
# projects: ${enabled.length}
# 端口：127xx 回环上游 → 181xx 对外入口；修改请走 zdashboard 项目管理器。

${enabled.map(serverBlock).join('\n')}`;
}

/** 原子写期望状态；path unit 会在几秒内应用 */
export function writeManagedState(projects) {
  mkdirSync(PM_STATE_DIR, { recursive: true });
  const at = nowIso();
  const conf = renderManagedConf(projects, { at });
  const tmp = `${PM_NGINX_CONF_STAGING}.tmp.${process.pid}`;
  writeFileSync(tmp, conf, 'utf8');
  chmodSync(tmp, 0o644);
  renameSync(tmp, PM_NGINX_CONF_STAGING);

  // 便于排查的 JSON 快照（不含任何密钥）
  const meta = {
    at,
    publicHost: PM_PUBLIC_HOST,
    projects: projects.filter(p => p.nginx_enabled).map(p => ({
      slug: p.slug, name: p.name, upstreamPort: p.upstream_port, externalPort: p.external_port,
    })),
  };
  const metaTmp = `${PM_STATE_DIR}/pm-nginx.json.tmp.${process.pid}`;
  writeFileSync(metaTmp, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  renameSync(metaTmp, resolve(PM_STATE_DIR, 'pm-nginx.json'));
  return { at, count: meta.projects.length };
}

export function readApplyStatus() {
  if (!existsSync(PM_NGINX_STATUS)) return { ok: null, at: null, message: '尚未应用' };
  try {
    return JSON.parse(readFileSync(PM_NGINX_STATUS, 'utf8'));
  } catch {
    return { ok: null, at: null, message: '状态文件无法解析' };
  }
}

export function navUrl(p) {
  return `https://${PM_PUBLIC_HOST}:${p.external_port}/`;
}
