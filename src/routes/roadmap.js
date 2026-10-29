// src/routes/roadmap.js — 个人路线图：目标 + 树形里程碑
//
//   GET    /api/roadmap                 目标/里程碑全量 + 统计
//   POST   /api/roadmap/goals           新建目标
//   PATCH  /api/roadmap/goals/:id       编辑目标（标题/描述/分类/状态/日期）
//   DELETE /api/roadmap/goals/:id       删除目标（级联里程碑）
//   POST   /api/roadmap/nodes           新建里程碑（parentId 可空 = 根节点）
//   PATCH  /api/roadmap/nodes/:id       编辑/移动/完成里程碑
//   DELETE /api/roadmap/nodes/:id       删除里程碑（级联子节点）
//
// 状态：goal = active | paused | done；node = todo | doing | done | blocked。
// 进度不落库，由前端按树计算；服务端只返回原始行与总量统计。

import { Router } from 'express';
import db, { checkpoint } from '../db.js';
import { nowIso } from '../lib/time.js';

const router = Router();

const GOAL_STATUSES = ['active', 'paused', 'done'];
const NODE_STATUSES = ['todo', 'doing', 'done', 'blocked'];
const CATEGORIES = ['学习', '事业', '健康', '生活', '创作', '财务', '其他'];
const MAX_TITLE = 200;
const MAX_DESC = 4000;

const idOf = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const getGoal = id => db.prepare('SELECT * FROM roadmap_goal WHERE id = ?').get(id);
const getNode = id => db.prepare('SELECT * FROM roadmap_node WHERE id = ?').get(id);

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

function categoryOf(value) {
  return CATEGORIES.includes(value) ? value : null;
}

function nextGoalSort() {
  return db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM roadmap_goal').get().n;
}

function nextNodeSort(goalId, parentId) {
  return db.prepare(`
    SELECT COALESCE(MAX(sort_order), 0) + 1 AS n
      FROM roadmap_node
     WHERE goal_id = ? AND parent_id IS ?
  `).get(goalId, parentId).n;
}

// 把 parentId 挂到 nodeId 下面会不会形成环？检查 parent 的祖先链。
function wouldCycle(nodeId, parentId) {
  if (nodeId === parentId) return true;
  const seen = new Set();
  let cur = getNode(parentId);
  while (cur) {
    if (cur.id === nodeId) return true;
    if (seen.has(cur.id)) return true;
    seen.add(cur.id);
    if (cur.parent_id == null) return false;
    cur = getNode(cur.parent_id);
  }
  return false;
}

router.get('/api/roadmap', (req, res) => {
  const goals = db.prepare(`
    SELECT * FROM roadmap_goal
     ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
              sort_order, id
  `).all();
  const nodes = db.prepare(`
    SELECT * FROM roadmap_node
     ORDER BY goal_id, sort_order, id
  `).all();
  const doneNodes = nodes.filter(n => n.status === 'done').length;
  res.json({
    goals,
    nodes,
    stats: {
      goals: goals.length,
      activeGoals: goals.filter(g => g.status === 'active').length,
      doneGoals: goals.filter(g => g.status === 'done').length,
      nodes: nodes.length,
      doneNodes,
      progress: nodes.length ? Math.round(doneNodes / nodes.length * 100) : 0,
    },
  });
});

router.post('/api/roadmap/goals', (req, res) => {
  const body = req.body || {};
  const title = cleanText(body.title, MAX_TITLE);
  if (!title) return res.status(400).json({ error: `title 必填且不超过 ${MAX_TITLE} 字` });

  const description = cleanText(body.description, MAX_DESC);
  if (description === null) return res.status(400).json({ error: `description 不超过 ${MAX_DESC} 字` });

  const category = categoryOf(body.category);
  if (!category) return res.status(400).json({ error: `category 须为：${CATEGORIES.join(' / ')}` });

  const date = parseDate(body.targetDate);
  if (!date.ok) return res.status(400).json({ error: 'targetDate 须为 YYYY-MM-DD 或空' });

  const status = body.status == null ? 'active' : String(body.status);
  if (!GOAL_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'status 须为 active/paused/done' });
  }

  const now = nowIso();
  const info = db.prepare(`
    INSERT INTO roadmap_goal
      (title, description, category, status, target_date, completed_at, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    title, description || null, category, status, date.value,
    status === 'done' ? now : null, nextGoalSort(), now, now,
  );
  checkpoint();
  res.json({ ok: true, goal: getGoal(Number(info.lastInsertRowid)) });
});

router.patch('/api/roadmap/goals/:id', (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的目标 id' });
  const cur = getGoal(id);
  if (!cur) return res.status(404).json({ error: '目标不存在' });

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
    const category = categoryOf(body.category);
    if (!category) return res.status(400).json({ error: `category 须为：${CATEGORIES.join(' / ')}` });
    patch.category = category;
  }
  if ('targetDate' in body) {
    const date = parseDate(body.targetDate);
    if (!date.ok) return res.status(400).json({ error: 'targetDate 须为 YYYY-MM-DD 或空' });
    patch.target_date = date.value;
  }
  if ('status' in body) {
    const status = String(body.status);
    if (!GOAL_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'status 须为 active/paused/done' });
    }
    patch.status = status;
    patch.completed_at = status === 'done' ? (cur.completed_at || patch.updated_at) : null;
  }

  const cols = Object.keys(patch);
  db.prepare(`UPDATE roadmap_goal SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`)
    .run(...cols.map(c => patch[c]), id);
  checkpoint();
  res.json({ ok: true, goal: getGoal(id) });
});

router.delete('/api/roadmap/goals/:id', (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的目标 id' });
  const info = db.prepare('DELETE FROM roadmap_goal WHERE id = ?').run(id);
  if (!info.changes) return res.status(404).json({ error: '目标不存在' });
  checkpoint();
  res.json({ ok: true });
});

router.post('/api/roadmap/nodes', (req, res) => {
  const body = req.body || {};
  const goalId = idOf(body.goalId);
  if (!goalId) return res.status(400).json({ error: '无效的 goalId' });
  if (!getGoal(goalId)) return res.status(404).json({ error: '目标不存在' });

  let parentId = null;
  if (body.parentId != null && body.parentId !== '') {
    parentId = idOf(body.parentId);
    if (!parentId) return res.status(400).json({ error: '无效的 parentId' });
    const parent = getNode(parentId);
    if (!parent) return res.status(404).json({ error: '父里程碑不存在' });
    if (parent.goal_id !== goalId) return res.status(400).json({ error: '父里程碑不属于该目标' });
  }

  const title = cleanText(body.title, MAX_TITLE);
  if (!title) return res.status(400).json({ error: `title 必填且不超过 ${MAX_TITLE} 字` });

  const description = cleanText(body.description, MAX_DESC);
  if (description === null) return res.status(400).json({ error: `description 不超过 ${MAX_DESC} 字` });

  const status = body.status == null ? 'todo' : String(body.status);
  if (!NODE_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'status 须为 todo/doing/done/blocked' });
  }

  const date = parseDate(body.targetDate);
  if (!date.ok) return res.status(400).json({ error: 'targetDate 须为 YYYY-MM-DD 或空' });

  const now = nowIso();
  const info = db.prepare(`
    INSERT INTO roadmap_node
      (goal_id, parent_id, title, description, status, target_date, completed_at, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    goalId, parentId, title, description || null, status, date.value,
    status === 'done' ? now : null, nextNodeSort(goalId, parentId), now, now,
  );
  checkpoint();
  res.json({ ok: true, node: getNode(Number(info.lastInsertRowid)) });
});

router.patch('/api/roadmap/nodes/:id', (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的里程碑 id' });
  const cur = getNode(id);
  if (!cur) return res.status(404).json({ error: '里程碑不存在' });

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
  if ('targetDate' in body) {
    const date = parseDate(body.targetDate);
    if (!date.ok) return res.status(400).json({ error: 'targetDate 须为 YYYY-MM-DD 或空' });
    patch.target_date = date.value;
  }
  if ('status' in body) {
    const status = String(body.status);
    if (!NODE_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'status 须为 todo/doing/done/blocked' });
    }
    patch.status = status;
    patch.completed_at = status === 'done' ? (cur.completed_at || patch.updated_at) : null;
  }

  if ('parentId' in body) {
    let parentId = null;
    if (body.parentId != null && body.parentId !== '') {
      parentId = idOf(body.parentId);
      if (!parentId) return res.status(400).json({ error: '无效的 parentId' });
      const parent = getNode(parentId);
      if (!parent) return res.status(404).json({ error: '父里程碑不存在' });
      if (parent.goal_id !== cur.goal_id) return res.status(400).json({ error: '父里程碑不属于该目标' });
      if (wouldCycle(id, parentId)) return res.status(400).json({ error: '不能把里程碑移动到自身或子节点下' });
    }
    if (parentId !== cur.parent_id) {
      patch.parent_id = parentId;
      patch.sort_order = nextNodeSort(cur.goal_id, parentId);
    }
  }

  const cols = Object.keys(patch);
  db.prepare(`UPDATE roadmap_node SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`)
    .run(...cols.map(c => patch[c]), id);
  checkpoint();
  res.json({ ok: true, node: getNode(id) });
});

router.delete('/api/roadmap/nodes/:id', (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的里程碑 id' });
  const info = db.prepare('DELETE FROM roadmap_node WHERE id = ?').run(id);
  if (!info.changes) return res.status(404).json({ error: '里程碑不存在' });
  checkpoint();
  res.json({ ok: true });
});

export { router as roadmapRouter };
