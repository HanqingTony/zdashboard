// src/app.js — Express 应用装配（可被测试直接 import，不监听端口）
import express from 'express';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PUBLIC_DIR, VERSION, AUTH_TOKEN } from './config.js';
import { articlesRouter } from './routes/articles.js';
import { vocabRouter } from './routes/vocab.js';
import { aggRouter } from './routes/agg.js';
import { projectsRouter } from './routes/projects.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  // 只给文章正文留余量；其它接口没有这么大的载荷
  app.use(express.json({ limit: '2mb' }));

  // 静态资源：URL 带 ?v=<版本> 时浏览器可长期缓存；nav.json 由前端 no-store 拉取
  app.get('/index.html', (req, res) => res.redirect(301, '/'));
  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: '1h', etag: true }));

  // 首页：注入版本号，部署后 app.js/style.css 的 URL 自动变化，避免旧缓存
  const INDEX_HTML = readFileSync(resolve(PUBLIC_DIR, 'index.html'), 'utf8');
  app.get('/', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(INDEX_HTML.replaceAll('__ASSET_VER__', VERSION));
  });

  // 可选写保护：AUTH_TOKEN 为空时完全不启用（默认自用场景）
  app.use((req, res, next) => {
    if (!AUTH_TOKEN) return next();
    if (!req.path.startsWith('/api/') || req.path === '/api/health') return next();
    const got = req.get('x-ztoken') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (got === AUTH_TOKEN) return next();
    res.status(401).json({ error: 'unauthorized' });
  });

  // Health（探活；不碰数据库，nginx/巡检可高频打）
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'zdashboard', version: VERSION, uptime: process.uptime() });
  });

  app.use(articlesRouter);
  app.use(vocabRouter);
  app.use(aggRouter);
  app.use(projectsRouter);

  // API 404 也返回 JSON（否则会掉进 SPA/HTML 默认页）
  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  // 统一错误响应：坏 JSON、URIError、async 抛错都变成 JSON
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[http]', req.method, req.originalUrl, err);
    res.status(status).json({ error: err.message || 'internal error' });
  });

  return app;
}
