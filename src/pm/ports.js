// src/pm/ports.js — 端口扫描与分配
//
// 两种端口概念：
//   upstream：回环服务端口。新项目默认自动分配 12710-12799；
//             成品软件（ComfyUI 8188 等）可直接用显式端口附着。
//   external：nginx 对外入口，默认自动分配 18130-18189。
//
// 来源：managed_project + ss 监听 + 活动 nginx conf（conf.d/*.conf + sites-enabled）+ nav.json

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { resolve, join } from 'path';
import db from '../db.js';
import {
  PUBLIC_DIR, PM_NGINX_DIR,
  PM_UPSTREAM_MIN, PM_UPSTREAM_MAX, PM_EXTERNAL_MIN, PM_EXTERNAL_MAX,
} from '../config.js';

const execFileP = promisify(execFile);
export const EXTERNAL_HARD_MIN = 18100;
export const EXTERNAL_HARD_MAX = 18199;

function confFiles() {
  const out = [];
  const add = (dir) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try {
        const st = statSync(p); // 跟随 symlink
        if (st.isFile() && !f.includes('.bak') && (f.endsWith('.conf') || dir.endsWith('sites-enabled'))) out.push(p);
      } catch { /* ignore */ }
    }
  };
  add(join(PM_NGINX_DIR, 'conf.d'));
  add(join(PM_NGINX_DIR, 'sites-enabled'));
  return out;
}

/** 解析 nginx 的 listen / proxy_pass 端口（只用于防冲突） */
export function nginxPorts({ excludeManaged = false } = {}) {
  const ports = new Set();
  for (const file of confFiles()) {
    if (excludeManaged && file.endsWith('/zdashboard-projects.conf')) continue;
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/\blisten\s+(?:\[[^\]]*\]:)?(?:[\d.]+:)?(\d{2,5})\b/g)) {
      ports.add(Number(m[1]));
    }
    for (const m of text.matchAll(/\bproxy_pass\s+https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{2,5})/g)) {
      ports.add(Number(m[1]));
    }
  }
  return ports;
}

/** 某个 external 端口是否已被「非 PM 管理」的 nginx 配置占用（用于阻止重复 listen） */
export function externalInOtherConf(port) {
  return nginxPorts({ excludeManaged: true }).has(Number(port));
}

// 当前 nginx 里实际生效的 对外端口 → 上游端口 映射（含手工 conf 和 PM 生成 conf）
let _mapCache = { key: '', map: new Map() };

export function activeMappings() {
  const files = confFiles();
  const key = files.map(f => {
    try { return `${f}:${statSync(f).mtimeMs}`; } catch { return f; }
  }).join('|');
  if (key === _mapCache.key) return _mapCache.map;

  const map = new Map();
  for (const file of files) {
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    let inServer = false;
    let depth = 0;
    let listen = null;
    let upstream = null;
    for (const raw of text.split('\n')) {
      const line = raw.replace(/#.*$/, '');
      if (!inServer) {
        if (/^\s*server\s*\{/.test(line)) {
          inServer = true;
          depth = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
          listen = null;
          upstream = null;
        }
        continue;
      }
      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (listen == null) {
        const m = line.match(/^\s*listen\s+(?:\[[^\]]*\]:)?(?:[\d.]+:)?(\d{2,5})/);
        if (m) listen = Number(m[1]);
      }
      if (upstream == null) {
        const m = line.match(/proxy_pass\s+https?:\/\/(?:127\.0\.0\.1|localhost):(\d{2,5})/);
        if (m) upstream = Number(m[1]);
      }
      if (depth <= 0) {
        if (listen != null && upstream != null) map.set(listen, upstream);
        inServer = false;
        listen = null;
        upstream = null;
        depth = 0;
      }
    }
  }
  _mapCache = { key, map };
  return map;
}

export function navPorts() {
  const ports = new Set();
  try {
    const data = JSON.parse(readFileSync(resolve(PUBLIC_DIR, 'nav.json'), 'utf8'));
    for (const g of data.groups || []) {
      for (const it of g.items || []) {
        for (const v of [it.port, it.upstream]) {
          for (const m of String(v ?? '').matchAll(/(\d{2,5})/g)) ports.add(Number(m[1]));
        }
      }
    }
  } catch { /* ignore */ }
  return ports;
}

export function dbPorts() {
  const ports = new Set();
  for (const r of db.prepare('SELECT upstream_port, external_port FROM managed_project').all()) {
    if (r.upstream_port != null) ports.add(r.upstream_port);
    if (r.external_port != null) ports.add(r.external_port);
  }
  return ports;
}

/** ss 的监听端口 */
export async function listeningPorts() {
  const ports = new Set();
  try {
    const { stdout } = await execFileP('ss', ['-ltnH'], { timeout: 3000, maxBuffer: 1 << 20 });
    for (const line of stdout.split('\n')) {
      const m = line.match(/\s(?:[\d.]+|\[[^\]]*\]):(\d{2,5})\s/);
      if (m) ports.add(Number(m[1]));
    }
  } catch { /* 没装 ss 时只靠 nginx/nav/db */ }
  return ports;
}

export async function usedPorts() {
  const sets = [nginxPorts(), navPorts(), dbPorts(), await listeningPorts()];
  const out = new Set();
  for (const s of sets) for (const p of s) out.add(p);
  return out;
}

export function validatePorts({ upstreamPort, externalPort }) {
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) {
    throw new Error('上游端口须为 1-65535');
  }
  if (!Number.isInteger(externalPort) || externalPort < EXTERNAL_HARD_MIN || externalPort > EXTERNAL_HARD_MAX) {
    throw new Error(`对外端口须在 ${EXTERNAL_HARD_MIN}-${EXTERNAL_HARD_MAX}`);
  }
}

/**
 * 分配/校验端口。
 * - 显式 upstream：允许是已有服务的监听端口（附着成品软件）
 * - 自动 upstream：仅从 12710-12799 取空闲
 * - 显式 external：仅校验 DB 内唯一 + 硬范围；是否与其它 nginx conf 冲突由启用开关时再查
 * - 自动 external：从 18130-18189 取空闲（ss/nginx/nav/db 全避让）
 */
export async function allocatePorts({ upstreamPort, externalPort, excludeId, allowExternalUsed = false } = {}) {
  const used = await usedPorts();
  if (excludeId) {
    const row = db.prepare('SELECT upstream_port, external_port FROM managed_project WHERE id = ?').get(excludeId);
    if (row) {
      if (row.upstream_port != null) used.delete(row.upstream_port);
      if (row.external_port != null) used.delete(row.external_port);
    }
  }

  let up;
  if (upstreamPort != null && upstreamPort !== '') {
    up = Number(upstreamPort);
    if (!Number.isInteger(up) || up < 1 || up > 65535) throw new Error('上游端口须为 1-65535');
    const clash = db.prepare('SELECT id FROM managed_project WHERE upstream_port = ? AND id IS NOT ?').get(up, excludeId ?? -1);
    if (clash) throw new Error(`上游端口 ${up} 已被其它托管条目使用`);
  } else {
    up = null;
    for (let p = PM_UPSTREAM_MIN; p <= PM_UPSTREAM_MAX; p++) {
      if (!used.has(p)) { up = p; used.add(p); break; }
    }
    if (up == null) throw new Error(`上游端口段 ${PM_UPSTREAM_MIN}-${PM_UPSTREAM_MAX} 已无空闲`);
  }

  let ext;
  if (externalPort != null && externalPort !== '') {
    ext = Number(externalPort);
    if (!Number.isInteger(ext) || ext < EXTERNAL_HARD_MIN || ext > EXTERNAL_HARD_MAX) {
      throw new Error(`对外端口须在 ${EXTERNAL_HARD_MIN}-${EXTERNAL_HARD_MAX}`);
    }
    const clash = db.prepare('SELECT id FROM managed_project WHERE external_port = ? AND id IS NOT ?').get(ext, excludeId ?? -1);
    if (clash) throw new Error(`对外端口 ${ext} 已被其它托管条目使用`);
    if (!allowExternalUsed && used.has(ext)) throw new Error(`对外端口 ${ext} 已被占用`);
  } else {
    ext = null;
    for (let p = PM_EXTERNAL_MIN; p <= PM_EXTERNAL_MAX; p++) {
      if (!used.has(p)) { ext = p; used.add(p); break; }
    }
    if (ext == null) throw new Error(`对外端口段 ${PM_EXTERNAL_MIN}-${PM_EXTERNAL_MAX} 已无空闲`);
  }

  return { upstreamPort: up, externalPort: ext };
}

export { PM_UPSTREAM_MIN, PM_UPSTREAM_MAX, PM_EXTERNAL_MIN, PM_EXTERNAL_MAX };
