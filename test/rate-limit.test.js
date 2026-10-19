// 限流中间件：固定窗口、按 IP 计数
import test from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit } from '../src/lib/rate-limit.js';

function fakeReq(ip = '10.0.0.1') {
  return { ip, socket: { remoteAddress: ip } };
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    json(obj) { this.body = obj; return this; },
  };
  return res;
}

test('超过窗口内上限返回 429，其它 IP 互不影响', () => {
  const limiter = rateLimit({ windowMs: 60_000, max: 2 });
  const a = fakeReq('1.1.1.1');
  const b = fakeReq('2.2.2.2');

  for (let i = 0; i < 2; i++) {
    const res = fakeRes();
    let next = false;
    limiter(a, res, () => { next = true; });
    assert.equal(next, true);
  }

  const blocked = fakeRes();
  limiter(a, blocked, () => { throw new Error('不该放行'); });
  assert.equal(blocked.statusCode, 429);
  assert.match(blocked.body.error, /频繁/);
  assert.ok(blocked.headers['Retry-After']);

  const other = fakeRes();
  let passed = false;
  limiter(b, other, () => { passed = true; });
  assert.equal(passed, true);
});
