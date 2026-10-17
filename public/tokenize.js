// public/tokenize.js — 唯一的英文分词实现
//
// 前端（着色/点击）与后端（入词统计）共用这一份，避免"前端能点的词后端没有"。
// 浏览器：`import { tokenize } from './tokenize.js'`（app.js 是 type="module"）
// Node：  `import { wordCounts } from '../../public/tokenize.js'`

export const WORD_RE = /[a-zA-Z0-9]+(?:['\-][a-zA-Z0-9]+)*/g;

/** 统一弯引号 / 各种破折号 / 不换行空格（常见于从 Word/PDF 复制的文本） */
export function normalizeText(content) {
  return String(content ?? '')
    .replace(/[\u2018\u2019\u201A\uFF07\u02BC]/g, "'")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\uFF0D]/g, '-')
    .replace(/\u00A0/g, ' ');
}

/**
 * 切分为 sep/word 序列，保留原文所有分隔符。
 * - word.key 为小写，用于查 zVocab；
 * - 纯数字 token 不算单词（作为分隔符保留），避免把年份点进词库。
 * @returns {Array<{type:'sep'|'word', text:string, key?:string}>}
 */
export function tokenize(content) {
  const text = normalizeText(content);
  const tokens = [];
  let pos = 0;
  for (const m of text.matchAll(WORD_RE)) {
    const word = m[0];
    const idx = m.index;
    if (idx > pos) tokens.push({ type: 'sep', text: text.slice(pos, idx) });
    if (/[a-zA-Z]/.test(word)) {
      tokens.push({ type: 'word', text: word, key: word.toLowerCase() });
    } else {
      tokens.push({ type: 'sep', text: word });
    }
    pos = idx + word.length;
  }
  if (pos < text.length) tokens.push({ type: 'sep', text: text.slice(pos) });
  return tokens;
}

/** 单词 → 出现次数（已小写） */
export function wordCounts(content) {
  const counts = new Map();
  for (const t of tokenize(content)) {
    if (t.type === 'word') counts.set(t.key, (counts.get(t.key) || 0) + 1);
  }
  return counts;
}
