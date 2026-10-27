// HTTP 冒烟测试：路由、分词入库、删除清理、错误 JSON、版本注入
process.env.DB_PATH = ':memory:';
process.env.CHECKPOINT = 'off';

import test from 'node:test';
import assert from 'node:assert/strict';
const { createApp } = await import('../src/app.js');

const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const json = (path, opts) => fetch(base + path, opts);

test('health + 首页版本注入 + 静态资源可访问', async () => {
  const h = await (await json('/api/health')).json();
  assert.equal(h.ok, true);
  assert.equal(h.service, 'zdashboard');
  assert.match(h.version, /^\d+\.\d+\.\d+$/);

  const html = await (await json('/')).text();
  assert.match(html, new RegExp(`app\\.js\\?v=${h.version.replace(/\./g, '\\.')}`));
  assert.equal((await json('/app.js')).status, 200);
  assert.equal((await json('/tokenize.js')).status, 200);
  const moduleRes = await json('/core.js');
  assert.equal(moduleRes.status, 200);
  assert.match(moduleRes.headers.get('cache-control'), /no-cache/);
});

test('文章：入库分词、列表词数、删除后清理孤立词', async () => {
  const post = await json('/api/articles', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: "Hello world hello 2024 don't" }),
  });
  assert.equal(post.status, 200);
  const created = await post.json();
  assert.equal(created.wordCount, 3);   // hello / world / don't（2024 不算词）

  const list = await (await json('/api/articles')).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].word_count, 3);
  assert.equal(list[0].content_length, 28);

  const detail = await (await json(`/api/articles/${created.id}`)).json();
  const hello = detail.words.find(w => w.word === 'hello');
  assert.equal(hello.count, 2);
  assert.equal(hello.status, 'unknown');

  const put = await json('/api/words', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ word: 'HELLO', status: 'mastered' }),
  });
  assert.equal(put.status, 200);

  let stats = await (await json('/api/vocab/stats')).json();
  assert.equal(stats.total, 3);
  assert.equal(stats.mastered, 1);

  const del = await (await json(`/api/articles/${created.id}`, { method: 'DELETE' })).json();
  assert.equal(del.ok, true);
  assert.equal(del.removedWords, 3);   // 删除文章后孤立词被清掉

  stats = await (await json('/api/vocab/stats')).json();
  assert.equal(stats.total, 0);
});

test('坏 JSON / 未知 API / 非法参数都返回 JSON', async () => {
  const bad = await json('/api/articles', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad',
  });
  assert.equal(bad.status, 400);
  assert.match(bad.headers.get('content-type'), /application\/json/);
  assert.ok((await bad.json()).error);

  const missing = await json('/api/nope');
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /application\/json/);

  const badWord = await json('/api/words', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ word: 'not a word!', status: 'mastered' }),
  });
  assert.equal(badWord.status, 400);

  const badArticleId = await json('/api/articles/abc');
  assert.equal(badArticleId.status, 400);
});

test('聚合：快照结构 / 已读水位 / 未知源', async () => {
  const snap = await (await json('/api/agg')).json();
  assert.ok(Array.isArray(snap.sources));
  assert.ok(snap.sources.length > 0);
  assert.equal(typeof snap.totalNew, 'number');

  const opened = await json('/api/agg/open', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }),
  });
  assert.equal(opened.status, 200);

  const unknown = await json('/api/agg/refresh?source=no-such-source', { method: 'POST' });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error, /未知 source/);
});
