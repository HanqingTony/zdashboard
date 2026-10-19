// public/projects-meta.js — 项目台账的共享枚举与展示映射
//
// 后端 src/projects/store.js / fromMarkdown.js 与前端 app.js 共用这一份，
// 避免状态/层/判决的字面量在四个地方各写一遍。

export const STATUS = {
  ACTIVE: '🟢活跃',
  ON_DEMAND: '🟡按需',
  MAINTENANCE: '🔵完成待维护',
  PAUSED: '⚪暂停',
  DEBT: '🔴欠账',
  UPSTREAM: '🧩上游',
  ARCHIVED: '📦归档',
  IDEA: '💭想法',
};

export const STATUSES = Object.values(STATUS);

export const LAYER = {
  L0: 'L0 在做',
  L1: 'L1 活跃',
  L2: 'L2 按需',
  L3: 'L3 想法',
  L4: 'L4 归档',
};

export const LAYERS = Object.values(LAYER);

export const VERDICTS = ['alive', 'parked', 'killed'];

export const KIND_LABELS = [
  ['', '全部'],
  ['repo', '工程'],
  ['infra', '基建'],
  ['upstream', '上游'],
  ['data', '数据'],
  ['idea', '想法'],
];

export const GRADE_LABELS = ['A', 'B', 'C', 'D'];

export function gradeOf(score) {
  return score >= 12 ? 'A' : score >= 9 ? 'B' : score >= 6 ? 'C' : 'D';
}

/** 侧栏项目状态圆点：a=进行中（绿）m=维护/按需（蓝）p=规划/归档（橙）r=欠账（红） */
export function statusDot(status) {
  const s = String(status || '');
  if (s.includes('欠账')) return 'r';
  if (s.includes('活跃')) return 'a';
  if (s.includes('按需') || s.includes('暂停') || s.includes('完成待维护') || s.includes('上游')) return 'm';
  if (s.includes('归档')) return 'x';
  return 'p';
}
