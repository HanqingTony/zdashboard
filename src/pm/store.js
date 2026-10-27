// src/pm/store.js — 项目管理器落库层（managed_project）
//
// 一个条目可以只有仓库、只有端口映射，或两者都有（如 ComfyUI：仓库 + 8188→181xx）。
import db, { checkpoint } from '../db.js';
import { nowIso } from '../lib/time.js';

const COLS = [
  'slug', 'name', 'kind', 'repo_path', 'repo_created', 'dual_remote',
  'upstream_port', 'external_port', 'nginx_enabled', 'web_enabled',
  'pinned', 'source', 'note',
];

export function list() {
  return db.prepare(`
    SELECT * FROM managed_project
    ORDER BY pinned DESC,
             CASE kind WHEN 'repo' THEN 0 WHEN 'software' THEN 1 WHEN 'service' THEN 2 WHEN 'infra' THEN 3 ELSE 4 END,
             COALESCE(last_commit_at, '') DESC, updated_at DESC, id
  `).all();
}

export function get(id) {
  return db.prepare('SELECT * FROM managed_project WHERE id = ?').get(id) || null;
}

export function findBySlug(slug) {
  return db.prepare('SELECT * FROM managed_project WHERE slug = ?').get(slug) || null;
}

export function findByRepoPath(repoPath) {
  return db.prepare('SELECT * FROM managed_project WHERE repo_path = ?').get(repoPath) || null;
}

export function create(data) {
  const now = nowIso();
  const row = { kind: 'project', ...data };
  for (const c of COLS) if (!(c in row)) row[c] = null;
  row.created_at = now;
  row.updated_at = now;
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
    kind: 'kind',
    note: 'note',
    nginxEnabled: 'nginx_enabled',
    webEnabled: 'web_enabled',
    pinned: 'pinned',
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

export function saveGitMany(rows) {
  if (!rows.length) return 0;
  const stmt = db.prepare(`
    UPDATE managed_project
       SET last_commit_at = @last_commit_at,
           last_commit_subject = @last_commit_subject,
           dirty = @dirty,
           ahead = @ahead,
           dual_remote = @dual_remote,
           synced_at = @synced_at,
           updated_at = @synced_at
     WHERE id = @id
  `);
  const now = nowIso();
  db.transaction(list => {
    for (const r of list) stmt.run({ ...r, synced_at: r.synced_at || now });
  })(rows);
  checkpoint();
  return rows.length;
}

export function clearRepo(id) {
  const n = db.prepare(`
    UPDATE managed_project
       SET repo_path = NULL, repo_created = 0, dual_remote = 0,
           last_commit_at = NULL, last_commit_subject = NULL,
           dirty = NULL, ahead = NULL, synced_at = NULL, updated_at = @now
     WHERE id = @id
  `).run({ id, now: nowIso() }).changes;
  if (n > 0) checkpoint();
  return n > 0;
}

export function clearPorts(id) {
  const n = db.prepare(`
    UPDATE managed_project
       SET upstream_port = NULL, external_port = NULL,
           nginx_enabled = 0, web_enabled = 0, updated_at = @now
     WHERE id = @id
  `).run({ id, now: nowIso() }).changes;
  if (n > 0) checkpoint();
  return n > 0;
}

export function remove(id) {
  const n = db.prepare('DELETE FROM managed_project WHERE id = ?').run(id).changes;
  if (n > 0) checkpoint();
  return n > 0;
}
