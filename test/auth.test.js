// 可选写保护：设置 AUTH_TOKEN 后，/api/*（health 除外）需要 X-ZToken 或 Bearer
process.env.DB_PATH = ':memory:';
process.env.CHECKPOINT = 'off';
process.env.AUTH_TOKEN = 'secret-token';

import test from 'node:test';
import assert from 'node:assert/strict';
const { createApp } = await import('../src/app.js');

const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

test('health 免鉴权；其余 /api 需要 token', async () => {
  assert.equal((await fetch(base + '/api/health')).status, 200);

  const denied = await fetch(base + '/api/agg');
  assert.equal(denied.status, 401);
  assert.match((await denied.json()).error, /unauthorized/);

  const header = await fetch(base + '/api/agg', { headers: { 'X-ZToken': 'secret-token' } });
  assert.equal(header.status, 200);

  const bearer = await fetch(base + '/api/agg', { headers: { Authorization: 'Bearer secret-token' } });
  assert.equal(bearer.status, 200);

  const wrong = await fetch(base + '/api/agg', { headers: { 'X-ZToken': 'nope' } });
  assert.equal(wrong.status, 401);
});
