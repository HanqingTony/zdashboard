// src/pm/ports.js — 端口扫描与分配
//
// 上游：127xx（默认 12710-12799，回环）
// 对外：181xx（默认 18130-18189，nginx）
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
export function nginxPorts() {
  const ports = new Set();
  for (const file of confFiles()) {
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
    ports.add(r.upstream_port);
    ports.add(r.external_port);
  }
  return ports;
}

/** ss 的监听端口（127xx/181xx 只关心本机 bind） */
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

function inRange(p, min, max) { return p >= min && p <= max; }

/** 所有已占用端口（含监听、nginx、nav、DB） */
export async function usedPorts() {
  const sets = [nginxPorts(), navPorts(), dbPorts(), await listeningPorts()];
  const out = new Set();
  for (const s of sets) for (const p of s) out.add(p);
  return out;
}

export function validatePorts({ upstreamPort, externalPort }) {
  if (!inRange(upstreamPort, PM_UPSTREAM_MIN, PM_UPSTREAM_MAX)) {
    throw new Error(`上游端口须在 ${PM_UPSTREAM_MIN}-${PM_UPSTREAM_MAX}`);
  }
  if (!inRange(externalPort, PM_EXTERNAL_MIN, PM_EXTERNAL_MAX)) {
    throw new Error(`对外端口须在 ${PM_EXTERNAL_MIN}-${PM_EXTERNAL_MAX}`);
  }
}

/**
 * 分配端口。用户显式给端口时校验是否空闲；否则挑区间内最小空闲。
 * @param {{upstreamPort?:number, externalPort?:number, excludeId?:number}} opts
 */
export async function allocatePorts({ upstreamPort, externalPort, excludeId } = {}) {
  const used = await usedPorts();
  if (excludeId) {
    const row = db.prepare('SELECT upstream_port, external_port FROM managed_project WHERE id = ?').get(excludeId);
    if (row) { used.delete(row.upstream_port); used.delete(row.external_port); }
  }

  const pick = (want, min, max, label) => {
    if (want != null && want !== '') {
      const p = Number(want);
      if (!Number.isInteger(p) || !inRange(p, min, max)) throw new Error(`${label}须在 ${min}-${max}`);
      if (used.has(p)) throw new Error(`${label} ${p} 已被占用`);
      used.add(p);
      return p;
    }
    for (let p = min; p <= max; p++) {
      if (!used.has(p)) { used.add(p); return p; }
    }
    throw new Error(`${label}段 ${min}-${max} 已无空闲端口`);
  };

  return {
    upstreamPort: pick(upstreamPort, PM_UPSTREAM_MIN, PM_UPSTREAM_MAX, '上游端口'),
    externalPort: pick(externalPort, PM_EXTERNAL_MIN, PM_EXTERNAL_MAX, '对外端口'),
  };
}

export { PM_UPSTREAM_MIN, PM_UPSTREAM_MAX, PM_EXTERNAL_MIN, PM_EXTERNAL_MAX };
