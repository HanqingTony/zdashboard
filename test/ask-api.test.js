// Ask 咨询记录 + 本地 Pi session 列表
process.env.DB_PATH = ':memory:';
process.env.CHECKPOINT = 'off';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const piRoot = await mkdtemp(path.join(tmpdir(), 'zd-ask-test-'));
process.env.PI_SESSION_DIR = piRoot;
const sessionId = 'abcdef1234567890';
const sessionDir = path.join(piRoot, '--home-tony-project--');
await mkdir(sessionDir, { recursive: true });
await writeFile(path.join(sessionDir, `${sessionId}.jsonl`), [
  JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/home/tony/project' }),
  JSON.stringify({ type: 'message', id: 'm1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
].join('\n') + '\n');

const { createApp } = await import('../src/app.js');
const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const call = async (method, p, body) => {
  const res = await fetch(base + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};

test.after(async () => {
  server.close();
  await rm(piRoot, { recursive: true, force: true });
});

test('Ask：记录问题、按时间倒序读取、校验引擎', async () => {
  const one = await call('POST', '/api/ask', { question: '先搭什么？', engine: 'deepseek' });
  assert.equal(one.status, 201);
  assert.equal(one.data.question.engine, 'deepseek');
  assert.equal(one.data.question.question, '先搭什么？');

  const two = await call('POST', '/api/ask', { question: 'Pi 怎么接？', engine: 'pi', sessionId });
  assert.equal(two.status, 201);
  assert.equal(two.data.question.sessionId, sessionId);

  const list = await call('GET', '/api/ask?limit=10');
  assert.equal(list.status, 200);
  assert.equal(list.data.questions.length, 2);
  assert.equal(list.data.questions[0].id, two.data.question.id);

  const empty = await call('POST', '/api/ask', { question: '   ', engine: 'grok' });
  assert.equal(empty.status, 400);
  const bad = await call('POST', '/api/ask', { question: 'x', engine: 'bing' });
  assert.equal(bad.status, 400);
});

test('Pi session 列表读取本机 session 元数据', async () => {
  const r = await call('GET', '/api/ask/pi/sessions');
  assert.equal(r.status, 200);
  assert.equal(r.data.sessions.length, 1);
  assert.equal(r.data.sessions[0].id, sessionId);
  assert.equal(r.data.sessions[0].cwd, '/home/tony/project');
  assert.match(r.data.sessions[0].label, /project/);
});

test('Pi 提问：未知 session 在启动子进程前返回 404', async () => {
  const rec = await call('POST', '/api/ask', { question: 'test', engine: 'pi', sessionId });
  const r = await call('POST', '/api/ask/pi', {
    questionId: rec.data.question.id,
    sessionId: 'does-not-exist',
    question: 'test',
  });
  assert.equal(r.status, 404);
});
