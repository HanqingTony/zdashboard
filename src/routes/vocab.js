// src/routes/vocab.js — 单词学习状态
import { Router } from 'express';
import db, { checkpoint } from '../db.js';
import { nowIso } from '../lib/time.js';

const router = Router();

const STATUSES = ['mastered', 'familiar', 'unknown'];
const WORD_RE = /^[a-z0-9'\-]{1,64}$/;

function normWord(raw) {
  const w = String(raw ?? '').trim().toLowerCase();
  return WORD_RE.test(w) ? w : null;
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
  res.json({ ...stats, articles: articleCount });
});

export { router as vocabRouter };
