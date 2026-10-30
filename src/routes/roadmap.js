// src/routes/roadmap.js — 个人路线图：画布式思维导图
//
//   GET    /api/roadmap                 节点 / 连线 / 统计
//   POST   /api/roadmap/nodes           新建节点（可挂 0..N 个上级）
//   PATCH  /api/roadmap/nodes/:id       编辑节点、状态、上级关系
//   DELETE /api/roadmap/nodes/:id       删除节点（子节点自动上移为根节点）
//
// 数据模型是 DAG：roadmap_graph_edge 允许一个节点有多个上级，
// 因此同一个项目可以同时服务多个愿景；前端用第一条上级连线做主线布局。
//
// 进度不落库，由前端按 DAG 计算；服务端只返回原始节点、连线和总量统计。

import { Router } from 'express';
import db, { checkpoint } from '../db.js';
import { nowIso } from '../lib/time.js';

const router = Router();

const KINDS = ['vision', 'project', 'task'];
const STATUSES = ['todo', 'doing', 'done', 'blocked', 'paused'];
const MAX_TITLE = 200;
const MAX_DESC = 4000;
const MAX_PARENTS = 32;

const idOf = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const getNode = id => db
  .prepare('SELECT * FROM roadmap_graph_node WHERE id = ?')
  .get(id);

function cleanText(value, max) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  return s.length > max ? null : s;
}

function parseDate(value) {
  if (value == null || value === '') return { ok: true, value: null };
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: false };
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return { ok: false };
  return { ok: true, value: s };
}

function parseCategory(value) {
  if (value == null || String(value).trim() === '') return { ok: true, value: null };
  const s = String(value).trim();
  return s.length <= 30 ? { ok: true, value: s } : { ok: false };
}

function parseParents(value) {
  if (value == null) return { ok: true, ids: [] };
  const raw = Array.isArray(value) ? value : [value];
  const ids = [];
  for (const item of raw) {
    if (item == null || item === '') continue;
    const id = idOf(item);
    if (!id) return { ok: false, error: 'parentIds 含无效 id' };
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > MAX_PARENTS) return { ok: false, error: `一个节点最多关联 ${MAX_PARENTS} 个上级` };
  return { ok: true, ids };
}

function assertParentsExist(ids) {
  if (!ids.length) return null;
  const rows = db.prepare(`
    SELECT id FROM roadmap_graph_node
     WHERE id IN (${ids.map(() => '?').join(',')})
  `).all(...ids);
  if (rows.length !== ids.length) {
    const found = new Set(rows.map(r => r.id));
    const missing = ids.filter(id => !found.has(id));
    return `上级节点不存在：${missing.join(', ')}`;
  }
  return null;
}

function descendantsOf(id) {
  const rows = db.prepare(`
    WITH RECURSIVE sub(id) AS (
      SELECT child_id FROM roadmap_graph_edge WHERE parent_id = ?
      UNION
      SELECT e.child_id
        FROM roadmap_graph_edge e
        JOIN sub s ON e.parent_id = s.id
    )
    SELECT id FROM sub
  `).all(id);
  return new Set(rows.map(r => r.id));
}

function assertNoCycle(nodeId, parentIds) {
  if (!parentIds.length) return null;
  if (parentIds.includes(nodeId)) return '节点不能以自己为上级';
  const descendants = descendantsOf(nodeId);
  const bad = parentIds.find(id => descendants.has(id));
  return bad ? '不能把节点移动到自己的子节点下面' : null;
}

function nextNodeSort() {
  return db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM roadmap_graph_node').get().n;
}

const nodeOut = row => row && ({
  id: row.id,
  title: row.title,
  description: row.description,
  category: row.category,
  kind: row.kind,
  status: row.status,
  targetDate: row.target_date,
  completedAt: row.completed_at,
  sortOrder: row.sort_order,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const edgeOut = row => ({
  id: row.id,
  parentId: row.parent_id,
  childId: row.child_id,
  sortOrder: row.sort_order,
  createdAt: row.created_at,
});

function graph() {
  const nodes = db.prepare(`
    SELECT * FROM roadmap_graph_node
     ORDER BY sort_order, id
  `).all();
  const edges = db.prepare(`
    SELECT * FROM roadmap_graph_edge
     ORDER BY sort_order, id
  `).all();
  const done = nodes.filter(n => n.status === 'done').length;
  return {
    nodes: nodes.map(nodeOut),
    edges: edges.map(edgeOut),
    stats: {
      nodes: nodes.length,
      visions: nodes.filter(n => n.kind === 'vision').length,
      projects: nodes.filter(n => n.kind === 'project').length,
      tasks: nodes.filter(n => n.kind === 'task').length,
      done,
      progress: nodes.length ? Math.round(done / nodes.length * 100) : 0,
    },
  };
}

function replaceParents(nodeId, parentIds, now) {
  db.prepare('DELETE FROM roadmap_graph_edge WHERE child_id = ?').run(nodeId);
  const insert = db.prepare(`
    INSERT INTO roadmap_graph_edge (parent_id, child_id, sort_order, created_at)
    VALUES (?, ?, ?, ?)
  `);
  parentIds.forEach((parentId, i) => insert.run(parentId, nodeId, i + 1, now));
}

router.get('/api/roadmap', (req, res) => {
  res.json(graph());
});

router.post('/api/roadmap/nodes', (req, res) => {
  const body = req.body || {};
  const title = cleanText(body.title, MAX_TITLE);
  if (!title) return res.status(400).json({ error: `title 必填且不超过 ${MAX_TITLE} 字` });

  const description = cleanText(body.description, MAX_DESC);
  if (description === null) return res.status(400).json({ error: `description 不超过 ${MAX_DESC} 字` });

  const category = parseCategory(body.category);
  if (!category.ok) return res.status(400).json({ error: 'category 不超过 30 字' });

  const kind = body.kind == null ? 'project' : String(body.kind);
  if (!KINDS.includes(kind)) return res.status(400).json({ error: `kind 须为：${KINDS.join(' / ')}` });

  const status = body.status == null ? 'todo' : String(body.status);
  if (!STATUSES.includes(status)) return res.status(400).json({ error: `status 须为：${STATUSES.join(' / ')}` });

  const date = parseDate(body.targetDate);
  if (!date.ok) return res.status(400).json({ error: 'targetDate 须为 YYYY-MM-DD 或空' });

  const parents = parseParents(body.parentIds ?? body.parentId);
  if (!parents.ok) return res.status(400).json({ error: parents.error });
  const parentError = assertParentsExist(parents.ids);
  if (parentError) return res.status(400).json({ error: parentError });

  const now = nowIso();
  const info = db.prepare(`
    INSERT INTO roadmap_graph_node
      (title, description, category, kind, status, target_date, completed_at, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    title, description || null, category.value, kind, status, date.value,
    status === 'done' ? now : null, nextNodeSort(), now, now,
  );
  const id = Number(info.lastInsertRowid);
  if (parents.ids.length) replaceParents(id, parents.ids, now);
  checkpoint();
  res.status(201).json({ node: nodeOut(getNode(id)), graph: graph() });
});

router.patch('/api/roadmap/nodes/:id', (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的节点 id' });
  const cur = getNode(id);
  if (!cur) return res.status(404).json({ error: '节点不存在' });

  const body = req.body || {};
  const patch = { updated_at: nowIso() };

  if ('title' in body) {
    const title = cleanText(body.title, MAX_TITLE);
    if (!title) return res.status(400).json({ error: `title 必填且不超过 ${MAX_TITLE} 字` });
    patch.title = title;
  }
  if ('description' in body) {
    const description = cleanText(body.description, MAX_DESC);
    if (description === null) return res.status(400).json({ error: `description 不超过 ${MAX_DESC} 字` });
    patch.description = description || null;
  }
  if ('category' in body) {
    const category = parseCategory(body.category);
    if (!category.ok) return res.status(400).json({ error: 'category 不超过 30 字' });
    patch.category = category.value;
  }
  if ('kind' in body) {
    const kind = String(body.kind);
    if (!KINDS.includes(kind)) return res.status(400).json({ error: `kind 须为：${KINDS.join(' / ')}` });
    patch.kind = kind;
  }
  if ('targetDate' in body) {
    const date = parseDate(body.targetDate);
    if (!date.ok) return res.status(400).json({ error: 'targetDate 须为 YYYY-MM-DD 或空' });
    patch.target_date = date.value;
  }
  if ('status' in body) {
    const status = String(body.status);
    if (!STATUSES.includes(status)) return res.status(400).json({ error: `status 须为：${STATUSES.join(' / ')}` });
    patch.status = status;
    patch.completed_at = status === 'done' ? (cur.completed_at || patch.updated_at) : null;
  }

  let parents = null;
  if ('parentIds' in body || 'parentId' in body) {
    parents = parseParents(body.parentIds ?? body.parentId);
    if (!parents.ok) return res.status(400).json({ error: parents.error });
    const parentError = assertParentsExist(parents.ids);
    if (parentError) return res.status(400).json({ error: parentError });
    const cycleError = assertNoCycle(id, parents.ids);
    if (cycleError) return res.status(400).json({ error: cycleError });
  }

  const apply = db.transaction(() => {
    const cols = Object.keys(patch);
    db.prepare(`UPDATE roadmap_graph_node SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`)
      .run(...cols.map(c => patch[c]), id);
    if (parents) replaceParents(id, parents.ids, patch.updated_at);
  });
  apply();
  checkpoint();
  res.json({ node: nodeOut(getNode(id)), graph: graph() });
});

router.delete('/api/roadmap/nodes/:id', (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的节点 id' });
  const cur = getNode(id);
  if (!cur) return res.status(404).json({ error: '节点不存在' });

  const remove = db.transaction(() => {
    // 子节点不删除；只断开所有连线，无上级的子节点会成为新的根节点。
    db.prepare('DELETE FROM roadmap_graph_edge WHERE parent_id = ? OR child_id = ?').run(id, id);
    db.prepare('DELETE FROM roadmap_graph_node WHERE id = ?').run(id);
  });
  remove();
  checkpoint();
  res.json({ graph: graph() });
});

export { router as roadmapRouter };
export default router;
