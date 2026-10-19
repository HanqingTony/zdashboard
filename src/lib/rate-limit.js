// src/lib/rate-limit.js — 极简固定窗口限流（单进程，个人内网够用）
//
// 默认按 IP 计数；通过 nginx 反代时由 app.set('trust proxy', 'loopback') 还原客户端 IP。

export function rateLimit({ windowMs = 60_000, max = 180 } = {}) {
  const hits = new Map();   // key -> { start, count }
  let lastSweep = Date.now();

  return function limiter(req, res, next) {
    const now = Date.now();

    // 偶尔清理过期桶，避免长期运行内存增长
    if (now - lastSweep > windowMs * 5 && hits.size > 1000) {
      for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
      lastSweep = now;
    }

    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const bucket = hits.get(key);
    if (!bucket || now - bucket.start >= windowMs) {
      hits.set(key, { start: now, count: 1 });
      return next();
    }
    bucket.count++;
    if (bucket.count <= max) return next();

    res.set('Retry-After', String(Math.ceil((bucket.start + windowMs - now) / 1000)));
    res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  };
}
