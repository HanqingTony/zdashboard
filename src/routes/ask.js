// src/routes/ask.js — Ask 咨询入口 + 本地 Pi session 桥
//
//   GET  /api/ask                 最近问题
//   POST /api/ask                 记录问题
//   GET  /api/ask/pi/sessions     列出本机 Pi session
//   POST /api/ask/pi              用选中的 Pi session 回答（只读副本，不写回原 session）
//
// Pi 调用固定 --no-tools --no-mcp --no-extensions --no-context-files：
// 它只使用该 session 的上下文回答问题，不会执行工具或修改仓库。

import { Router } from 'express';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import db, { checkpoint } from '../db.js';
import { nowIso } from '../lib/time.js';

const router = Router();

const ENGINES = new Set(['deepseek', 'zhihu', 'grok', 'claude', 'pi', 'searxng']);
const MAX_QUESTION = 4000;
const MAX_ANSWER = 20000;
const PI_TIMEOUT_MS = 120_000;
const PI_MAX_OUTPUT = 8 * 1024 * 1024;
const PI_COMPACT_BYTES = 2 * 1024 * 1024;
const PI_COMPACT_CHARS = 500_000;
const PI_AGENT_DIR = process.env.PI_AGENT_DIR || path.join(homedir(), '.pi', 'agent');
const PI_SESSION_ROOT = process.env.PI_SESSION_DIR
  || path.join(PI_AGENT_DIR, 'sessions');
const DEFAULT_PI_BIN = path.join(homedir(), '.local', 'share', 'pnpm', 'bin', 'pi');
const PI_BIN = process.env.PI_BIN || (existsSync(DEFAULT_PI_BIN) ? DEFAULT_PI_BIN : 'pi');

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function parseQuestion(value) {
  const s = String(value ?? '').trim();
  if (!s) return { error: '问题不能为空' };
  if (s.length > MAX_QUESTION) return { error: `问题最多 ${MAX_QUESTION} 字` };
  return { value: s };
}

function parseEngine(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return ENGINES.has(s) ? s : null;
}

function parseId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseSessionId(value) {
  const s = String(value ?? '').trim();
  return /^[A-Za-z0-9_-]{6,100}$/.test(s) ? s : null;
}

async function readHead(file) {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const line = buf.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0];
    return JSON.parse(line);
  } finally {
    await fh.close();
  }
}

async function collectSessionFiles(dir, depth = 0, out = []) {
  if (depth > 2 || out.length >= 500) return out;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= 500) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectSessionFiles(full, depth + 1, out);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.endsWith('.acp.json')) {
      out.push(full);
    }
  }
  return out;
}

async function listPiSessions(limit = 40) {
  const files = await collectSessionFiles(PI_SESSION_ROOT);
  const sessions = [];
  for (const file of files) {
    try {
      const [meta, info] = await Promise.all([readHead(file), stat(file)]);
      if (meta?.type !== 'session' || !meta.id) continue;
      const cwd = typeof meta.cwd === 'string' ? meta.cwd : '';
      const stamp = String(meta.timestamp || info.mtime.toISOString()).slice(0, 10);
      sessions.push({
        id: meta.id,
        label: `${path.basename(cwd) || 'Pi'} · ${stamp}`,
        cwd,
        updatedAt: info.mtime.toISOString(),
        size: info.size,
      });
    } catch { /* 坏 session 文件跳过 */ }
  }
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return sessions.slice(0, limit);
}

async function findPiSession(id) {
  const wanted = parseSessionId(id);
  if (!wanted) return null;
  const files = await collectSessionFiles(PI_SESSION_ROOT);
  for (const file of files) {
    try {
      const meta = await readHead(file);
      if (meta?.type === 'session' && meta.id === wanted) {
        return { file, cwd: typeof meta.cwd === 'string' ? meta.cwd : '' };
      }
    } catch { /* ignore */ }
  }
  return null;
}

function piMessageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block && block.type === 'text')
    .map(block => String(block.text || ''))
    .join('\n')
    .trim();
}

// 大 session 会超过模型上下文窗口。复制时只保留最近的 system/user/assistant
// 文本，丢掉工具结果和 thinking；回答仍然基于所选 session 的最近对话。
async function copyPiSession(source, dest, cwd) {
  const info = await stat(source);
  if (info.size <= PI_COMPACT_BYTES) {
    await copyFile(source, dest);
    return false;
  }

  const raw = await readFile(source, 'utf8');
  let modelChange = null;
  let thinkingChange = null;
  const messages = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (item.type === 'model_change' && !modelChange) modelChange = item;
    else if (item.type === 'thinking_level_change' && !thinkingChange) thinkingChange = item;
    else if (item.type === 'message') {
      const message = item.message || {};
      if (!['system', 'user', 'assistant'].includes(message.role)) continue;
      const text = piMessageText(message);
      if (text) messages.push({ role: message.role, text });
    }
  }

  const selected = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (selected.length && chars + message.text.length > PI_COMPACT_CHARS) break;
    selected.push(message);
    chars += message.text.length;
  }
  selected.reverse();
  if (!selected.length) throw new Error('session 没有可用的文本上下文');

  const out = [{
    type: 'session', version: 3, id: randomUUID(), timestamp: nowIso(), cwd: cwd || process.cwd(),
  }];
  if (modelChange) out.push({ ...modelChange, id: randomUUID().slice(0, 8), parentId: null });
  if (thinkingChange) out.push({ ...thinkingChange, id: randomUUID().slice(0, 8), parentId: null });

  let parentId = null;
  for (const message of selected) {
    const id = randomUUID().slice(0, 8);
    out.push({
      type: 'message', id, parentId, timestamp: nowIso(),
      message: { role: message.role, content: [{ type: 'text', text: message.text }] },
    });
    parentId = id;
  }
  await writeFile(dest, out.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf8');
  return true;
}

function parsePiAnswer(stdout) {
  let answer = '';
  let error = '';
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue;
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (item.type === 'message_end' && item.message?.role === 'assistant') {
      const text = piMessageText(item.message);
      if (text) answer = text;
      if (item.message.errorMessage) error = String(item.message.errorMessage);
    } else if (item.type === 'compaction_end' && item.errorMessage) {
      error = String(item.errorMessage);
    }
  }
  return { answer: answer.trim(), error };
}

function runPi(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(PI_BIN, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(Object.assign(new Error('Pi 回答超时'), { killed: true, signal: 'SIGTERM' }));
    }, PI_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > PI_MAX_OUTPUT) {
        child.kill('SIGKILL');
        fail(new Error('Pi 输出过大'));
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', fail);
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`Pi 退出码 ${code}`), { code, signal, stderr }));
    });
  });
}

// GET /api/ask?limit=30
router.get('/api/ask', (req, res) => {
  const n = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
  const questions = db.prepare(`
    SELECT id, question, engine, session_id AS sessionId, answer, created_at AS createdAt
    FROM ask_question ORDER BY id DESC LIMIT ?
  `).all(n);
  res.json({ questions });
});

// POST /api/ask {question, engine, sessionId?}
router.post('/api/ask', (req, res) => {
  const parsed = parseQuestion(req.body?.question);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const engine = parseEngine(req.body?.engine);
  if (!engine) return res.status(400).json({ error: '未知引擎' });
  const sessionId = engine === 'pi' ? parseSessionId(req.body?.sessionId) : null;

  const createdAt = nowIso();
  const info = db.prepare(`
    INSERT INTO ask_question (question, engine, session_id, created_at)
    VALUES (?, ?, ?, ?)
  `).run(parsed.value, engine, sessionId, createdAt);
  checkpoint();
  const row = db.prepare(`
    SELECT id, question, engine, session_id AS sessionId, answer, created_at AS createdAt
    FROM ask_question WHERE id = ?
  `).get(info.lastInsertRowid);
  res.status(201).json({ question: row });
});

// GET /api/ask/pi/sessions
router.get('/api/ask/pi/sessions', asyncRoute(async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 40));
  res.json({ sessions: await listPiSessions(limit), root: PI_SESSION_ROOT });
}));

// POST /api/ask/pi {questionId, sessionId, question}
router.post('/api/ask/pi', asyncRoute(async (req, res) => {
  const parsed = parseQuestion(req.body?.question);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const sessionId = parseSessionId(req.body?.sessionId);
  if (!sessionId) return res.status(400).json({ error: '请选择 Pi session' });
  const questionId = parseId(req.body?.questionId);
  if (!questionId) return res.status(400).json({ error: 'questionId 无效' });

  const question = db.prepare('SELECT * FROM ask_question WHERE id = ?').get(questionId);
  if (!question || question.engine !== 'pi') return res.status(404).json({ error: '问题记录不存在' });

  const session = await findPiSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Pi session 不存在' });

  let dir = null;
  try {
    dir = await mkdtemp(path.join(tmpdir(), 'zd-ask-pi-'));
    const copied = path.join(dir, 'session.jsonl');
    // systemd 的 ProtectHome=read-only 会让 Pi 写 ~/.pi 失败；配置复制到临时目录，
    // 只复制凭据/模型配置，不复制 settings.json/mcp.json。
    // settings 里的 npm 扩展（如 billion-context-pi）会被 Pi 尝试重新安装；
    // 生产 ProtectHome=read-only 时 npm cache 不可写，会导致整个 Ask 失败。
    const agentDir = path.join(dir, 'agent');
    await mkdir(agentDir, { recursive: true });
    for (const name of ['auth.json', 'models.json', 'models-store.json']) {
      await copyFile(path.join(PI_AGENT_DIR, name), path.join(agentDir, name)).catch(() => {});
    }
    const info = await stat(session.file);
    if (info.size > 50 * 1024 * 1024) return res.status(413).json({ error: 'session 文件过大' });
    const compacted = await copyPiSession(session.file, copied, session.cwd);

    const args = [
      '--session', copied,
      '--no-tools', '--no-mcp', '--no-extensions', '--no-context-files',
      '--mode', 'json', '--print', '--', parsed.value,
    ];
    const { stdout, stderr } = await runPi(args, {
      cwd: session.cwd && session.cwd.startsWith('/') ? session.cwd : process.cwd(),
      env: { ...process.env, PI_ASK: '1', PI_CODING_AGENT_DIR: agentDir },
    });
    const parsedAnswer = parsePiAnswer(stdout);
    const answer = parsedAnswer.answer.slice(0, MAX_ANSWER);
    if (!answer) {
      console.error('[ask/pi] empty answer', parsedAnswer.error || String(stderr || '').slice(0, 1000));
      const contextLimit = /context|maximum|token/i.test(parsedAnswer.error);
      return res.status(502).json({
        error: parsedAnswer.error
          ? (contextLimit ? 'Pi 回答失败：session 超出模型上下文' : 'Pi 回答失败')
          : 'Pi 没有返回内容',
      });
    }
    db.prepare('UPDATE ask_question SET answer = ?, session_id = ? WHERE id = ?')
      .run(answer, sessionId, questionId);
    checkpoint();
    res.json({ answer, questionId, compacted });
  } catch (err) {
    const timeout = err?.killed || err?.signal === 'SIGTERM';
    console.error('[ask/pi]', err?.message || err, String(err?.stderr || '').slice(0, 2000));
    res.status(502).json({ error: timeout ? 'Pi 回答超时' : 'Pi 回答失败' });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}));

export { router as askRouter };
