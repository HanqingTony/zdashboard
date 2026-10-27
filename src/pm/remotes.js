// src/pm/remotes.js — 创建 GitHub/Gitee 远端仓库 + 配置双推 + 首次推送
//
// 凭据：
//   GitHub 用本机已登录的 `gh`（~/.config/gh）
//   Gitee  用 GITEE_TOKEN（环境变量优先；否则读 PM_GITEE_ENV，默认 <state>/gitee.env，600）
// 不把 token 写入仓库或日志。

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import { PM_GIT_OWNER, PM_GITEE_ENV } from '../config.js';

const execFileP = promisify(execFile);

function readEnvFile(path) {
  const out = {};
  if (!path || !existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const redact = (s) => String(s || '').replace(/[0-9a-f]{32,}/gi, '***');

function creds() {
  let file = readEnvFile(PM_GITEE_ENV);
  if (!file.GITEE_TOKEN) file = readEnvFile('/home/tony/zdata/zdashboard/gitee.env');
  return {
    githubOwner: process.env.GITHUB_OWNER || file.GITHUB_OWNER || PM_GIT_OWNER,
    giteeOwner: process.env.GITEE_OWNER || file.GITEE_OWNER || PM_GIT_OWNER,
    giteeToken: process.env.GITEE_TOKEN || file.GITEE_TOKEN || '',
  };
}

async function gh(args) {
  return execFileP('gh', args, {
    encoding: 'utf8',
    timeout: 45000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1' },
  });
}

export async function ensureGitHubRepo(name, { private: isPrivate = true, description = '' } = {}) {
  const { githubOwner } = creds();
  const full = `${githubOwner}/${name}`;
  const sshUrl = `git@github.com:${full}.git`;
  try {
    const { stdout } = await gh(['repo', 'view', full, '--json', 'name,sshUrl,visibility']);
    const data = JSON.parse(stdout);
    return { ok: true, created: false, url: data.sshUrl || sshUrl, visibility: data.visibility };
  } catch (e) {
    // 不存在才创建；其它错误（未登录等）直接上报
    const msg = redact(e.stderr || e.message);
    if (!/not found|Could not resolve|404/i.test(msg)) {
      return { ok: false, created: false, url: sshUrl, error: msg };
    }
  }
  try {
    const args = ['repo', 'create', full, isPrivate ? '--private' : '--public'];
    if (description) args.push('--description', description);
    await gh(args);
    return { ok: true, created: true, url: sshUrl };
  } catch (e) {
    return { ok: false, created: false, url: sshUrl, error: redact(e.stderr || e.message) };
  }
}

async function gitee(path, opts = {}) {
  const res = await fetch(`https://gitee.com/api/v5${path}`, {
    ...opts,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* ignore */ }
  return { status: res.status, data, text };
}

export async function ensureGiteeRepo(name, { private: isPrivate = true, description = '' } = {}) {
  const { giteeOwner, giteeToken } = creds();
  const sshUrl = `git@gitee.com:${giteeOwner}/${name}.git`;
  if (!giteeToken) {
    return { ok: false, created: false, url: sshUrl, error: 'GITEE_TOKEN 未配置（见 gitee.env）' };
  }
  try {
    const q = new URLSearchParams({ access_token: giteeToken });
    const check = await gitee(`/repos/${giteeOwner}/${name}?${q}`);
    if (check.status === 200) {
      return { ok: true, created: false, url: check.data?.ssh_url || sshUrl };
    }
    if (check.status !== 404) {
      return { ok: false, created: false, url: sshUrl, error: `检查仓库失败 HTTP ${check.status} ${redact(check.data?.message || '')}` };
    }

    const body = new URLSearchParams({
      access_token: giteeToken,
      name,
      private: String(!!isPrivate),
      auto_init: 'false',
    });
    if (description) body.set('description', description);
    const created = await gitee('/user/repos', { method: 'POST', body });
    if (created.status >= 200 && created.status < 300) {
      return { ok: true, created: true, url: created.data?.ssh_url || sshUrl };
    }
    return { ok: false, created: false, url: sshUrl, error: `创建仓库失败 HTTP ${created.status} ${redact(created.data?.message || '')}` };
  } catch (e) {
    return { ok: false, created: false, url: sshUrl, error: redact(e.message) };
  }
}

async function git(repoPath, args) {
  return execFileP('git', ['-C', repoPath, ...args], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

/** origin fetch 走 GitHub；pushurl 配 GitHub + Gitee */
export async function configureDualRemote(repoPath, { githubUrl, giteeUrl }) {
  let hasOrigin = true;
  try { await git(repoPath, ['remote', 'get-url', 'origin']); } catch { hasOrigin = false; }
  if (hasOrigin) await git(repoPath, ['remote', 'set-url', 'origin', githubUrl]);
  else await git(repoPath, ['remote', 'add', 'origin', githubUrl]);
  try { await git(repoPath, ['config', '--unset-all', 'remote.origin.pushurl']); } catch { /* none */ }
  await git(repoPath, ['remote', 'set-url', '--add', '--push', 'origin', githubUrl]);
  await git(repoPath, ['remote', 'set-url', '--add', '--push', 'origin', giteeUrl]);
  // 让本地 main 跟踪 origin/main（不依赖第一次双推是否两端都成功）
  await git(repoPath, ['config', 'branch.main.remote', 'origin']);
  await git(repoPath, ['config', 'branch.main.merge', 'refs/heads/main']);
}

async function pushOne(repoPath, url) {
  try {
    await git(repoPath, ['push', url, 'main']);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: redact(e.stderr || e.message) };
  }
}

/**
 * 建两个远端仓库 → 配双推 → 推 main。
 * 两端独立：一端失败不影响另一端；返回逐端结果。
 */
export async function createRemoteReposAndPush({
  name, repoPath, private: isPrivate = true, description = '', push = true,
} = {}) {
  const [github, gitee] = await Promise.all([
    ensureGitHubRepo(name, { private: isPrivate, description }),
    ensureGiteeRepo(name, { private: isPrivate, description }),
  ]);

  let remoteConfig = null;
  let pushed = null;
  if (repoPath) {
    try {
      await configureDualRemote(repoPath, { githubUrl: github.url, giteeUrl: gitee.url });
      remoteConfig = { ok: true };
    } catch (e) {
      remoteConfig = { ok: false, error: redact(e.message) };
    }
    if (push && remoteConfig?.ok) {
      const [pGh, pGt] = await Promise.all([
        github.ok ? pushOne(repoPath, github.url) : { ok: false, error: 'GitHub 仓库未创建' },
        gitee.ok ? pushOne(repoPath, gitee.url) : { ok: false, error: 'Gitee 仓库未创建' },
      ]);
      pushed = { github: pGh, gitee: pGt };
    }
  }
  return { github, gitee, remoteConfig, pushed, ok: !!(github.ok && gitee.ok) };
}
