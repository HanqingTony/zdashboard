// server.js — 入口：HTTP 服务 + 优雅关闭（音频模块已于 v0.2.0 删除）
import { createServer } from 'http';
import { createApp } from './src/app.js';
import db, { flushCheckpoint } from './src/db.js';
import { PORT, HOST, DB_PATH, CHECKPOINT_MODE, AUTH_TOKEN, VERSION } from './src/config.js';

const app = createApp();
const server = createServer(app);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[zdashboard] 端口 ${HOST}:${PORT} 已被占用（换 PORT 或先停掉旧进程）`);
  } else {
    console.error('[zdashboard] HTTP 服务错误:', err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[zdashboard] v${VERSION} http://${HOST}:${PORT}`);
  console.log(`[zdashboard] 数据库: ${DB_PATH}（checkpoint=${CHECKPOINT_MODE}）`);
  console.log(`[zdashboard] 写保护: ${AUTH_TOKEN ? '已启用（X-ZToken）' : '未启用（仅建议内网使用）'}`);
  console.log('[zdashboard] 英语学习: /api/articles, /api/words, /api/vocab/stats');
  console.log('[zdashboard] 信息聚合: GET /api/agg, POST /api/agg/refresh|open');
  console.log('[zdashboard] 项目管理器: GET /api/pm, POST /api/pm/scan|sync');
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n[shutdown] ${signal} — closing HTTP + flushing WAL...`);

  server.close(() => {
    try {
      flushCheckpoint();
      db.pragma('optimize');
      db.close();
      console.log('[shutdown] ✓ Database checkpointed and closed.');
    } catch (e) {
      console.error('[shutdown] Database close error:', e.message);
    }
    process.exit(0);
  });

  // 有长连接/慢请求时不无限等待
  setTimeout(() => {
    server.closeAllConnections?.();
    try { flushCheckpoint(); db.close(); } catch { /* 已关闭 */ }
    process.exit(0);
  }, 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error('[zdashboard] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[zdashboard] uncaughtException:', err);
  try { flushCheckpoint(); db.close(); } catch { /* 已关闭 */ }
  process.exit(1);
});
