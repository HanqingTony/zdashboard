// Ask：问题记录 + 本地 Pi session 桥（用假 Pi 可执行文件，不调用真实模型）
process.env.DB_PATH = ':memory:';
process.env.CHECKPOINT = 'off';

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(tmpdir(), 'zd-ask-test-'));
const sessions = path.join(root, 'sessions');
const agent = path.join(root, 'agent');
const fakePi = path.join(root, 'fake-pi.mjs');
const fakeHerdr = path.join(root, 'fake-herdr.cjs');
const herdrLog = path.join(root, 'herdr-prompt.log');
const liveFile = path.join(sessions, '--home-tony--', 'live.jsonl');
const liveId = 'livesession1234';
mkdirSync(sessions);
mkdirSync(agent);
process.env.PI_SESSION_DIR = sessions;
process.env.PI_AGENT_DIR = agent;
process.env.PI_BIN = fakePi;
process.env.HERDR_BIN = fakeHerdr;
process.env.HERDR_LIVE_FILE = liveFile;
process.env.HERDR_PROMPT_LOG = herdrLog;
process.env.HERDR_TIMEOUT_MS = '3000';

writeFileSync(fakePi, `#!/usr/bin/env node
const args = process.argv.slice(2);
const session = args[args.indexOf('--session') + 1] || '';
const mode = args[args.indexOf('--mode') + 1] || '';
if (!session || mode !== 'json') process.exit(2);
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: { role: 'assistant', content: [{ type: 'text', text: 'PONG' }] }
}) + '\\n');
`);
chmodSync(fakePi, 0o755);

writeFileSync(fakeHerdr, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'agent' && args[1] === 'list') {
  const file = process.env.HERDR_LIVE_FILE;
  const agents = file && fs.existsSync(file) ? [{
    agent: 'pi', agent_status: 'idle', pane_id: 'wT:p1', focused: true,
    agent_session: { agent: 'pi', kind: 'path', value: file },
  }] : [];
  process.stdout.write(JSON.stringify({ result: { agents } }));
} else if (args[0] === 'agent' && args[1] === 'prompt') {
  fs.appendFileSync(process.env.HERDR_PROMPT_LOG, JSON.stringify(args) + '\\n');
  process.stdout.write('{}');
} else {
  process.stderr.write('unexpected herdr args: ' + args.join(' '));
  process.exit(2);
}
`);
chmodSync(fakeHerdr, 0o755);

const sessionId = 'testsession1234';
const sessionFile = path.join(sessions, '--home-tony--', 'one.jsonl');
mkdirSync(path.dirname(sessionFile), { recursive: true });
writeFileSync(sessionFile, [
  JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp' }),
  JSON.stringify({ type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
].join('\n') + '\n');

writeFileSync(liveFile, [
  JSON.stringify({ type: 'session', version: 3, id: liveId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp' }),
  JSON.stringify({ type: 'message', id: 'l1', parentId: null, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'live' }] } }),
].join('\n') + '\n');

// 超过 2MB 的 session 会触发“截取最近文本”路径
const bigFile = path.join(sessions, '--home-tony--', 'two.jsonl');
const bigId = 'bigsession1234';
const bigText = 'x'.repeat(2.2 * 1024 * 1024);
writeFileSync(bigFile, [
  JSON.stringify({ type: 'session', version: 3, id: bigId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp' }),
  JSON.stringify({ type: 'message', id: 'b1', parentId: null, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: bigText }] } }),
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

test.after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});

test('Ask：记录问题、列出 Pi sessions、调用假 Pi 返回答案', async () => {
  const list = await call('GET', '/api/ask/pi/sessions');
  assert.equal(list.status, 200);
  assert.ok(list.data.sessions.some(s => s.id === sessionId));
  assert.equal(list.data.sessions.find(s => s.id === liveId)?.live, true);
  assert.equal(list.data.sessions.find(s => s.id === liveId)?.paneId, 'wT:p1');

  const created = await call('POST', '/api/ask', {
    question: '测试 Pi', engine: 'pi', sessionId,
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.question.engine, 'pi');

  const answer = await call('POST', '/api/ask/pi', {
    questionId: created.data.question.id, sessionId, question: '测试 Pi',
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.data.answer, 'PONG');
  assert.equal(answer.data.compacted, false);

  const history = await call('GET', '/api/ask');
  assert.equal(history.status, 200);
  assert.equal(history.data.questions[0].answer, 'PONG');
});

test('Ask：超大 session 自动截取，不把整段工具上下文塞给模型', async () => {
  const created = await call('POST', '/api/ask', {
    question: '大 session', engine: 'pi', sessionId: bigId,
  });
  const answer = await call('POST', '/api/ask/pi', {
    questionId: created.data.question.id, sessionId: bigId, question: '大 session',
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.data.answer, 'PONG');
  assert.equal(answer.data.compacted, true);
});

test('Ask：实时 TUI session 直接把问题送进 Herdr pane', async () => {
  const created = await call('POST', '/api/ask', {
    question: '发到 TUI', engine: 'pi', sessionId: liveId,
  });
  const answer = await call('POST', '/api/ask/pi', {
    questionId: created.data.question.id, sessionId: liveId, question: '发到 TUI',
  });
  assert.equal(answer.status, 200);
  assert.equal(answer.data.forwarded, true);
  assert.equal(answer.data.paneId, 'wT:p1');
  const log = await import('node:fs/promises').then(fs => fs.readFile(herdrLog, 'utf8'));
  assert.match(log, /wT:p1/);
  assert.match(log, /发到 TUI/);
});

test('Ask：未知引擎和无效 session 被拒绝', async () => {
  assert.equal((await call('POST', '/api/ask', { question: 'x', engine: 'unknown' })).status, 400);
  const q = await call('POST', '/api/ask', { question: 'x', engine: 'pi', sessionId: 'nosuch1234' });
  assert.equal(q.status, 201);
  const r = await call('POST', '/api/ask/pi', {
    questionId: q.data.question.id, sessionId: 'nosuch1234', question: 'x',
  });
  assert.equal(r.status, 404);
});
