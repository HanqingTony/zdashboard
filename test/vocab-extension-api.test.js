// 通用词库 API：批量状态查询、网页词条 upsert、出处/原句保留
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

const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};

test('批量查状态：没有记录返回空，不把“未标记”当成 unknown', async () => {
  const r = await call('GET', '/api/vocab/words?words=hello,world');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.words, {});
});

test('点击单词：批量 upsert 状态 + 出处 + 原句，并去重', async () => {
  const occ = {
    word: 'Serendipity', status: 'familiar',
    sourceUrl: 'https://example.com/post/1', sourceTitle: 'A Post',
    context: 'Serendipity is often the best part of reading.',
  };
  const first = await call('POST', '/api/vocab/occurrences', { occurrences: [occ] });
  assert.equal(first.status, 200);
  assert.equal(first.data.count, 1);
  assert.equal(first.data.words.serendipity.status, 'familiar');
  assert.equal(first.data.words.serendipity.click_count, 1);

  const again = await call('POST', '/api/vocab/occurrences', {
    occurrences: [{ ...occ, status: 'unknown', sourceTitle: 'Updated title' }],
  });
  assert.equal(again.status, 200);
  assert.equal(again.data.words.serendipity.status, 'unknown');
  assert.equal(again.data.words.serendipity.click_count, 2);

  const list = await call('GET', '/api/vocab/occurrences?word=SERENDIPITY');
  assert.equal(list.status, 200);
  assert.equal(list.data.occurrences.length, 1);
  assert.equal(list.data.occurrences[0].clickCount, 2);
  assert.equal(list.data.occurrences[0].sourceTitle, 'Updated title');
  assert.match(list.data.occurrences[0].context, /best part of reading/);

  const status = await call('GET', '/api/vocab/words?words=serendipity');
  assert.equal(status.data.words.serendipity.status, 'unknown');
});

test('本段分析完成：未标记词批量写成 mastered，已有黄/红不动（由客户端筛选后提交）', async () => {
  await call('POST', '/api/vocab/occurrences', {
    occurrences: [{
      word: 'workflow', status: 'familiar',
      sourceUrl: 'https://example.com/post/2', sourceTitle: 'Media',
      context: 'The workflow is long.',
    }],
  });
  const r = await call('POST', '/api/vocab/occurrences', {
    occurrences: [
      {
        word: 'automation', status: 'mastered',
        sourceUrl: 'https://example.com/post/2', sourceTitle: 'Media',
        context: 'The workflow is long.',
      },
      {
        word: 'paragraph', status: 'mastered',
        sourceUrl: 'https://example.com/post/2', sourceTitle: 'Media',
        context: 'The workflow is long.',
      },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.words.automation.status, 'mastered');
  assert.equal(r.data.words.paragraph.status, 'mastered');

  const status = await call('GET', '/api/vocab/words?words=workflow,automation,paragraph');
  assert.equal(status.data.words.workflow.status, 'familiar');
  assert.equal(status.data.words.automation.status, 'mastered');
});

test('段落完成 clicked:false：写入状态但不增加点击次数', async () => {
  const r = await call('POST', '/api/vocab/occurrences', {
    occurrences: [{
      word: 'batchword', status: 'mastered', clicked: false,
      sourceUrl: 'https://example.com/post/3', sourceTitle: 'Batch',
      context: 'A paragraph completed in one batch.',
    }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.words.batchword.click_count, 0);

  const again = await call('POST', '/api/vocab/occurrences', {
    occurrences: [{
      word: 'batchword', status: 'mastered', clicked: false,
      sourceUrl: 'https://example.com/post/3', sourceTitle: 'Batch',
      context: 'A paragraph completed in one batch.',
    }],
  });
  assert.equal(again.data.words.batchword.click_count, 0);
});

test('非法批次/词/状态返回 400', async () => {
  assert.equal((await call('POST', '/api/vocab/occurrences', {})).status, 400);
  assert.equal((await call('POST', '/api/vocab/occurrences', { occurrences: [] })).status, 400);
  assert.equal((await call('POST', '/api/vocab/occurrences', {
    occurrences: [{ word: 'bad word', status: 'familiar' }],
  })).status, 400);
  assert.equal((await call('POST', '/api/vocab/occurrences', {
    occurrences: [{ word: 'valid', status: 'nope' }],
  })).status, 400);
});

test('全量词条导出：包含已有 zVocab 词，即使没有 occurrence', async () => {
  await call('PUT', '/api/words', { word: 'legacyword', status: 'familiar' });
  const r = await call('GET', '/api/vocab/words?all=1');
  assert.equal(r.status, 200);
  assert.equal(r.data.words.legacyword.status, 'familiar');
  assert.ok(r.data.words.serendipity);
});

test('统计包含 occurrence 数', async () => {
  const stats = await call('GET', '/api/vocab/stats');
  assert.equal(stats.status, 200);
  assert.ok(stats.data.occurrences >= 3);
});
