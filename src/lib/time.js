// src/lib/time.js — 统一时间格式：一律 ISO 8601 UTC（带 Z），便于排序/跨时区
export const nowIso = () => new Date().toISOString();

export function toIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 解析成毫秒；无法解析返回 null */
export function msOf(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

export function daysAgo(value) {
  const t = msOf(value);
  if (t == null) return null;
  return Math.floor((Date.now() - t) / 86400000);
}
