// src/app.js — Express 应用装配（可被测试直接 import，不监听端口）
import express from 'express';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PUBLIC_DIR, VERSION, AUTH_TOKEN, ALLOWED_HOSTS } from './config.js';
import { rateLimit } from './lib/rate-limit.js';
import { articlesRouter } from './routes/articles.js';
import { vocabRouter } from './routes/vocab.js';
import { aggRouter } from './routes/agg.js';
import { pmRouter } from './routes/pm.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // 只信任来自回环的代理头（nginx 与 app 同机），让 req.ip 还原成真实 LAN 客户端
  app.set('trust proxy', 'loopback');

  // 基础安全头；CSP 允许本站脚本/内联处理（页面用了 inline onclick），但禁止外域脚本与嵌套
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '));
    next();
  });

  // 可选 Host 白名单（ALLOWED_HOSTS），默认关闭
  if (ALLOWED_HOSTS.length) {
    app.use((req, res, next) => {
      const host = String(req.hostname || '').toLowerCase();
      if (ALLOWED_HOSTS.includes(host)) return next();
      res.status(400).json({ error: 'host not allowed' });
    });
  }

  // 静态资源：HTML/JS/CSS 必须重校验（ES module 的 import 不带版本号），
  // 图片等其它资源可缓存 1h；nav.json 由前端 no-store 拉取。
  app.get('/index.html', (req, res) => res.redirect(301, '/'));
  app.use(express.static(PUBLIC_DIR, {
    index: false,
    maxAge: '1h',
    etag: true,
    setHeaders(res, filePath) {
      if (/\.(?:js|css)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  // 首页：注入版本号，部署后 app.js/style.css 的 URL 自动变化，避免旧缓存
  const INDEX_HTML = readFileSync(resolve(PUBLIC_DIR, 'index.html'), 'utf8');
  app.get('/', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(INDEX_HTML.replaceAll('__ASSET_VER__', VERSION));
  });

  // Health（探活；不碰数据库、不读 body、免鉴权）
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'zdashboard', version: VERSION, uptime: process.uptime() });
  });

  // 可选写保护：AUTH_TOKEN 为空时完全不启用（默认自用场景）
  app.use((req, res, next) => {
    if (!AUTH_TOKEN) return next();
    if (!req.path.startsWith('/api/')) return next();
    const got = req.get('x-ztoken') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (got === AUTH_TOKEN) return next();
    res.status(401).json({ error: 'unauthorized' });
  });

  // /api 响应不缓存（个人数据），并先限流、再解析 body：
  // 未认证/超频请求不会先吃掉 2MB 内存
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', rateLimit({ windowMs: 60_000, max: 180 }));
  app.use(express.json({ limit: '2mb' }));

  app.use(articlesRouter);
  app.use(vocabRouter);
  app.use(aggRouter);
  app.use(pmRouter);

  // API 404 也返回 JSON（否则会掉进 SPA/HTML 默认页）
  app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  // 统一错误响应：坏 JSON、URIError、async 抛错都变成 JSON；
  // 生产环境不把 500 的内部错误文本（可能含 SQL）返回给客户端
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[http]', req.method, req.originalUrl, err);
    const reveal = status < 500 || process.env.NODE_ENV !== 'production';
    res.status(status).json({ error: reveal ? (err.message || 'request error') : 'internal error' });
  });

  return app;
}
