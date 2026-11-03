// src/routes/vocab.js — 单词学习状态
import { Router } from 'express';
import { createHash } from 'node:crypto';
import db, { checkpoint } from '../db.js';
import { nowIso } from '../lib/time.js';

const router = Router();

const STATUSES = ['mastered', 'familiar', 'unknown'];
const WORD_RE = /^[a-z0-9'\-]{1,64}$/;
const MAX_BATCH = 500;

function normWord(raw) {
  const w = String(raw ?? '').trim().toLowerCase();
  return WORD_RE.test(w) ? w : null;
}

function cleanText(raw, max) {
  return String(raw ?? '').trim().slice(0, max);
}

function parseOccurrence(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const word = normWord(raw.word);
  const status = raw.status;
  if (!word || !STATUSES.includes(status)) return null;
  const context = cleanText(raw.context, 2000);
  return {
    word,
    status,
    sourceUrl: cleanText(raw.sourceUrl ?? raw.source_url, 2048),
    sourceTitle: cleanText(raw.sourceTitle ?? raw.source_title, 300),
    context,
    contextHash: createHash('sha1').update(context).digest('hex'),
    clicked: raw.clicked !== false,
  };
}

function statusMap(words) {
  const map = {};
  if (!words.length) return map;
  const placeholders = words.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT word, status, first_seen, last_seen, click_count
    FROM zVocab WHERE word IN (${placeholders})
  `).all(...words);
  for (const row of rows) map[row.word] = row;
  return map;
}

// PUT /api/words - 更新单词掌握状态
router.put('/api/words', (req, res) => {
  const word = normWord(req.body?.word);
  const status = req.body?.status;
  if (!word) return res.status(400).json({ error: '无效 word（小写字母/数字/连字符/撇号，≤64）' });
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: '无效参数，status 须为 mastered/familiar/unknown' });
  }

  const now = nowIso();
  db.prepare(`
    INSERT INTO zVocab (word, status, first_seen, last_seen, click_count)
    VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(word) DO UPDATE SET
      status = excluded.status,
      last_seen = excluded.last_seen,
      click_count = click_count + 1
  `).run(word, status, now, now);
  checkpoint();

  res.json({ ok: true, word, status });
});

// GET /api/vocab/words?words=hello,world - 批量读当前状态（无记录 = 未标记）
// GET /api/vocab/words?all=1 - 导出全量词条
router.get('/api/vocab/words', (req, res) => {
  if (req.query.all === '1') {
    const rows = db.prepare(`
      SELECT word, status, first_seen, last_seen, click_count
      FROM zVocab ORDER BY word LIMIT 20000
    `).all();
    const map = {};
    for (const row of rows) map[row.word] = row;
    return res.json({ words: map });
  }
  const words = [...new Set(String(req.query.words ?? '')
    .split(',')
    .map(normWord)
    .filter(Boolean))].slice(0, MAX_BATCH);
  res.json({ words: statusMap(words) });
});

// GET /api/vocab/occurrences - 供导出/排查的通用记录接口
router.get('/api/vocab/occurrences', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 5000);
  const word = req.query.word ? normWord(req.query.word) : null;
  if (req.query.word && !word) return res.status(400).json({ error: '无效 word' });
  const rows = word
    ? db.prepare(`
        SELECT word, status, source_url AS sourceUrl, source_title AS sourceTitle,
               context, first_seen AS firstSeen, last_seen AS lastSeen, click_count AS clickCount
        FROM zWordOccurrence WHERE word = ? ORDER BY last_seen DESC LIMIT ?
      `).all(word, limit)
    : db.prepare(`
        SELECT word, status, source_url AS sourceUrl, source_title AS sourceTitle,
               context, first_seen AS firstSeen, last_seen AS lastSeen, click_count AS clickCount
        FROM zWordOccurrence ORDER BY last_seen DESC LIMIT ?
      `).all(limit);
  res.json({ occurrences: rows });
});

// POST /api/vocab/occurrences - 批量 upsert：当前状态 + 出处/原句
// 通用 JSON 接口，不绑定 SQLite，插件/其它客户端都可以直接调用。
router.post('/api/vocab/occurrences', (req, res) => {
  const raw = req.body?.occurrences;
  if (!Array.isArray(raw) || raw.length === 0) {
    return res.status(400).json({ error: 'occurrences 必须是非空数组' });
  }
  if (raw.length > MAX_BATCH) {
    return res.status(400).json({ error: `occurrences 最多 ${MAX_BATCH} 条` });
  }
  const items = raw.map(parseOccurrence);
  if (items.some(x => !x)) {
    return res.status(400).json({ error: '存在无效 occurrence（word/status 不合法）' });
  }

  const now = nowIso();
  const upsertVocab = db.prepare(`
    INSERT INTO zVocab (word, status, first_seen, last_seen, click_count)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(word) DO UPDATE SET
      status = excluded.status,
      last_seen = excluded.last_seen,
      click_count = click_count + ?
  `);
  const upsertOccurrence = db.prepare(`
    INSERT INTO zWordOccurrence
      (word, status, source_url, source_title, context, context_hash, first_seen, last_seen, click_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(word, source_url, context_hash) DO UPDATE SET
      status = excluded.status,
      source_title = excluded.source_title,
      context = excluded.context,
      last_seen = excluded.last_seen,
      click_count = click_count + ?
  `);

  db.transaction(() => {
    for (const item of items) {
      const delta = item.clicked ? 1 : 0;
      upsertVocab.run(item.word, item.status, now, now, delta, delta);
      upsertOccurrence.run(
        item.word, item.status, item.sourceUrl, item.sourceTitle,
        item.context, item.contextHash, now, now, delta, delta,
      );
    }
  })();
  checkpoint();

  const words = [...new Set(items.map(x => x.word))];
  res.json({ ok: true, count: items.length, words: statusMap(words) });
});

// GET /api/words/:word/articles - 单词详情（出现过的文章）
router.get('/api/words/:word/articles', (req, res) => {
  // 注意：Express 已经解码过路由参数，这里不能再 decodeURIComponent（含 % 的词会抛错）
  const word = normWord(req.params.word);
  if (!word) return res.status(400).json({ error: '无效 word' });

  const articles = db.prepare(`
    SELECT a.id, a.title, a.created, wa.count
    FROM zWordArticles wa
    JOIN zArticles a ON wa.article_id = a.id
    WHERE wa.word = ?
    ORDER BY a.created DESC, a.id DESC
  `).all(word);
  const vocab = db.prepare('SELECT status, click_count, first_seen, last_seen FROM zVocab WHERE word = ?').get(word) || null;
  res.json({ word, ...(vocab || {}), articles });
});

// GET /api/vocab/stats - 词汇统计
router.get('/api/vocab/stats', (req, res) => {
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status = 'mastered' THEN 1 ELSE 0 END), 0) AS mastered,
      COALESCE(SUM(CASE WHEN status = 'familiar' THEN 1 ELSE 0 END), 0) AS familiar,
      COALESCE(SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown
    FROM zVocab
  `).get();
  const articleCount = db.prepare('SELECT COUNT(*) AS c FROM zArticles').get().c;
  const occurrenceCount = db.prepare('SELECT COUNT(*) AS c FROM zWordOccurrence').get().c;
  res.json({ ...stats, articles: articleCount, occurrences: occurrenceCount });
});

export { router as vocabRouter };
