// src/routes/articles.js — 文章 CRUD 与分词入库
import { Router } from 'express';
import db, { checkpoint } from '../db.js';
import { wordCounts } from '../../public/tokenize.js';
import { nowIso } from '../lib/time.js';

const router = Router();

const MAX_CONTENT = 500_000; // 约 500KB 字符，远小于 2MB JSON 限制
const idOf = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// GET /api/articles - 文章列表（含去重词数）
router.get('/api/articles', (req, res) => {
  const articles = db.prepare(`
    SELECT a.id, a.title, a.created, LENGTH(a.content) AS content_length,
           (SELECT COUNT(*) FROM zWordArticles wa WHERE wa.article_id = a.id) AS word_count
    FROM zArticles a
    ORDER BY a.created DESC, a.id DESC
  `).all();
  res.json(articles);
});

// POST /api/articles - 保存文章并分词入库
router.post('/api/articles', (req, res) => {
  const { title, content } = req.body || {};
  if (typeof content !== 'string' || content.trim() === '') {
    return res.status(400).json({ error: '缺少 content' });
  }
  if (content.length > MAX_CONTENT) {
    return res.status(413).json({ error: `文章过长（上限 ${MAX_CONTENT} 字符）` });
  }

  const now = nowIso();
  const articleTitle = (typeof title === 'string' && title.trim())
    ? title.trim().slice(0, 200)
    : content.trim().substring(0, 50).replace(/\s+/g, ' ');

  const counts = wordCounts(content);

  const insertArticle = db.prepare('INSERT INTO zArticles (title, content, created) VALUES (?, ?, ?)');
  const insertWordArticle = db.prepare('INSERT OR IGNORE INTO zWordArticles (word, article_id, count) VALUES (?, ?, ?)');
  const insertVocab = db.prepare("INSERT OR IGNORE INTO zVocab (word, status, first_seen, last_seen) VALUES (?, 'unknown', ?, ?)");

  let articleId;
  const tx = db.transaction(() => {
    articleId = insertArticle.run(articleTitle, content, now).lastInsertRowid;
    for (const [word, count] of counts) {
      insertWordArticle.run(word, articleId, count);
      insertVocab.run(word, now, now);
    }
  });
  tx();
  checkpoint();

  console.log(`[article] 保存 #${articleId} "${articleTitle}" (${counts.size} 单词)`);
  res.json({ id: Number(articleId), title: articleTitle, wordCount: counts.size });
});

// GET /api/articles/:id - 文章详情（含单词状态）
router.get('/api/articles/:id', (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的文章 id' });
  const article = db.prepare('SELECT * FROM zArticles WHERE id = ?').get(id);
  if (!article) return res.status(404).json({ error: '文章不存在' });
  const words = db.prepare(`
    SELECT wa.word, wa.count, COALESCE(v.status, 'unknown') AS status
    FROM zWordArticles wa
    LEFT JOIN zVocab v ON wa.word = v.word
    WHERE wa.article_id = ?
    ORDER BY wa.count DESC, wa.word ASC
  `).all(id);
  res.json({ ...article, words });
});

// DELETE /api/articles/:id - 删除文章，并清理不再属于任何文章的词汇
router.delete('/api/articles/:id', (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: '无效的文章 id' });
  const article = db.prepare('SELECT id, title FROM zArticles WHERE id = ?').get(id);
  if (!article) return res.status(404).json({ error: '文章不存在' });

  let removedWords = 0;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM zArticles WHERE id = ?').run(id); // zWordArticles 级联删除
    removedWords = db.prepare(
      'DELETE FROM zVocab WHERE word NOT IN (SELECT DISTINCT word FROM zWordArticles)'
    ).run().changes;
  });
  tx();
  checkpoint();

  console.log(`[article] 已删除 #${article.id} "${article.title}"（清理孤立词 ${removedWords}）`);
  res.json({ ok: true, removedWords });
});

export { router as articlesRouter };
