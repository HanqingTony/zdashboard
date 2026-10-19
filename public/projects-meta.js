// public/projects-meta.js — 项目台账的共享枚举、展示映射与归一化
//
// 存储用稳定 code（active / on_demand / l0 …），展示用中文/emoji 标签。
// 后端 src/projects/store.js / fromMarkdown.js 与前端 app.js 共用这一份。

export const STATUS = {
  ACTIVE: 'active',
  ON_DEMAND: 'on_demand',
  MAINTENANCE: 'maintenance',
  PAUSED: 'paused',
  DEBT: 'debt',
  UPSTREAM: 'upstream',
  ARCHIVED: 'archived',
  IDEA: 'idea',
};

export const STATUS_LABELS = {
  [STATUS.ACTIVE]: '🟢活跃',
  [STATUS.ON_DEMAND]: '🟡按需',
  [STATUS.MAINTENANCE]: '🔵完成待维护',
  [STATUS.PAUSED]: '⚪暂停',
  [STATUS.DEBT]: '🔴欠账',
  [STATUS.UPSTREAM]: '🧩上游',
  [STATUS.ARCHIVED]: '📦归档',
  [STATUS.IDEA]: '💭想法',
};

export const STATUSES = Object.values(STATUS);

export const LAYER = {
  L0: 'l0',
  L1: 'l1',
  L2: 'l2',
  L3: 'l3',
  L4: 'l4',
};

export const LAYER_LABELS = {
  [LAYER.L0]: 'L0 在做',
  [LAYER.L1]: 'L1 活跃',
  [LAYER.L2]: 'L2 按需',
  [LAYER.L3]: 'L3 想法',
  [LAYER.L4]: 'L4 归档',
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

// v0.2.1 及更早的库/接口值（emoji+中文）→ code
export const LEGACY_STATUS = {
  '🟢活跃': STATUS.ACTIVE,
  '🟡按需': STATUS.ON_DEMAND,
  '🔵完成待维护': STATUS.MAINTENANCE,
  '⚪暂停': STATUS.PAUSED,
  '🔴欠账': STATUS.DEBT,
  '🧩上游': STATUS.UPSTREAM,
  '📦归档': STATUS.ARCHIVED,
  '💭想法': STATUS.IDEA,
};

export const LEGACY_LAYER = {
  'L0 在做': LAYER.L0,
  'L1 活跃': LAYER.L1,
  'L2 按需': LAYER.L2,
  'L3 想法': LAYER.L3,
  'L4 归档': LAYER.L4,
  'L0': LAYER.L0,
  'L1': LAYER.L1,
  'L2': LAYER.L2,
  'L3': LAYER.L3,
  'L4': LAYER.L4,
};

/** 接受 code 或旧 emoji/中文值；无法识别返回 null */
export function normalizeStatus(value) {
  if (value == null || value === '') return null;
  const v = String(value);
  if (STATUS_LABELS[v]) return v;
  return LEGACY_STATUS[v] || null;
}

export function normalizeLayer(value) {
  if (value == null || value === '') return null;
  const v = String(value);
  if (LAYER_LABELS[v]) return v;
  return LEGACY_LAYER[v] || null;
}

export function statusLabel(code) {
  return STATUS_LABELS[code] || (code == null || code === '' ? '—' : String(code));
}

export function layerLabel(code) {
  return LAYER_LABELS[code] || (code == null || code === '' ? '—' : String(code));
}

export function gradeOf(score) {
  return score >= 12 ? 'A' : score >= 9 ? 'B' : score >= 6 ? 'C' : 'D';
}

/** 侧栏项目状态圆点：a=进行中（绿）m=维护/按需（蓝）p=规划/想法（橙）r=欠账（红）x=归档（灰） */
export function statusDot(status) {
  switch (normalizeStatus(status)) {
    case STATUS.DEBT: return 'r';
    case STATUS.ACTIVE: return 'a';
    case STATUS.ON_DEMAND:
    case STATUS.PAUSED:
    case STATUS.MAINTENANCE:
    case STATUS.UPSTREAM: return 'm';
    case STATUS.ARCHIVED: return 'x';
    case STATUS.IDEA: return 'p';
    default: return 'p';
  }
}
