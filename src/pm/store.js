// src/pm/store.js — 项目管理器落库层（managed_project）
import db, { checkpoint } from '../db.js';
import { nowIso } from '../lib/time.js';

const COLS = ['slug', 'name', 'repo_path', 'upstream_port', 'external_port',
  'nginx_enabled', 'web_enabled', 'repo_created', 'dual_remote'];

export function list() {
  return db.prepare('SELECT * FROM managed_project ORDER BY id').all();
}

export function get(id) {
  return db.prepare('SELECT * FROM managed_project WHERE id = ?').get(id) || null;
}

export function findBySlug(slug) {
  return db.prepare('SELECT * FROM managed_project WHERE slug = ?').get(slug) || null;
}

export function create(data) {
  const now = nowIso();
  const row = { ...data, created_at: now, updated_at: now };
  const info = db.prepare(`
    INSERT INTO managed_project (${COLS.join(',')}, created_at, updated_at)
    VALUES (${COLS.map(c => '@' + c).join(',')}, @created_at, @updated_at)
  `).run(row);
  checkpoint();
  return get(info.lastInsertRowid);
}

export function update(id, patch) {
  const map = {
    name: 'name',
    nginxEnabled: 'nginx_enabled',
    webEnabled: 'web_enabled',
    upstreamPort: 'upstream_port',
    externalPort: 'external_port',
  };
  const data = {};
  for (const [k, col] of Object.entries(map)) {
    if (k in patch) data[col] = patch[k];
  }
  const keys = Object.keys(data);
  if (!keys.length) return get(id);
  db.prepare(`
    UPDATE managed_project SET ${keys.map(k => `${k} = @${k}`).join(', ')}, updated_at = @now
    WHERE id = @id
  `).run({ ...data, id, now: nowIso() });
  checkpoint();
  return get(id);
}

export function remove(id) {
  const n = db.prepare('DELETE FROM managed_project WHERE id = ?').run(id).changes;
  if (n > 0) checkpoint();
  return n > 0;
}
