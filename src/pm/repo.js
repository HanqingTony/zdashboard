// src/pm/repo.js — 新建本地仓库 + 配置双远端
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { resolve, join, sep } from 'path';
import {
  PM_REPO_ROOT, PM_GITHUB_BASE, PM_GITEE_BASE, PM_GIT_NAME, PM_GIT_EMAIL, PM_PUBLIC_HOST,
} from '../config.js';

const execFileP = promisify(execFile);

export function slugify(name) {
  return String(name || '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function validateSlug(slug) {
  return /^[a-z][a-z0-9-]{1,39}$/.test(String(slug || '')) && !slug.endsWith('-');
}

export function repoPathFor(slug) {
  const root = resolve(PM_REPO_ROOT);
  const p = resolve(root, slug);
  if (!p.startsWith(root + sep)) throw new Error('仓库路径越界');
  return p;
}

async function git(cwd, args) {
  const { stdout } = await execFileP('git', [
    '-c', `user.name=${PM_GIT_NAME}`, '-c', `user.email=${PM_GIT_EMAIL}`,
    ...args,
  ], {
    cwd, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout.trim();
}

/**
 * 创建本地仓库并配置远端。
 * @param {{slug:string, name:string, upstreamPort:number, externalPort:number, dualRemote?:boolean}} p
 */
export async function createRepo({ slug, name, upstreamPort, externalPort, dualRemote = true }) {
  const repoPath = repoPathFor(slug);
  if (existsSync(repoPath)) throw new Error(`仓库目录已存在: ${repoPath}`);
  mkdirSync(repoPath, { recursive: false });

  writeFileSync(join(repoPath, 'README.md'), `# ${name}

由 zdashboard 项目管理器创建。

- 上游：${upstreamPort ? `\`127.0.0.1:${upstreamPort}\`` : '（未配置）'}
- 对外：${externalPort ? `\`https://${PM_PUBLIC_HOST}:${externalPort}/\`` : '（未配置）'}（nginx 反代，可在项目管理器里开关）
- 双远端：${dualRemote ? 'GitHub + Gitee（`git push origin main` 双推）' : '仅 GitHub'}

## 启动

把你的服务监听在 ${upstreamPort ? `\`127.0.0.1:${upstreamPort}\`` : '一个本机端口'}，然后在项目管理器里配置/启用 nginx 映射。
`, 'utf8');

  await git(repoPath, ['init', '-b', 'main']);
  await git(repoPath, ['add', 'README.md']);
  await git(repoPath, ['commit', '-m', `chore: init ${slug}`]);

  const gh = `${PM_GITHUB_BASE}/${slug}.git`;
  await git(repoPath, ['remote', 'add', 'origin', gh]);
  if (dualRemote) {
    const gt = `${PM_GITEE_BASE}/${slug}.git`;
    // 与 zpa/setup-dual-remote.sh 一致：origin fetch 走 GitHub，pushurl 两条
    try { await git(repoPath, ['config', '--unset-all', 'remote.origin.pushurl']); } catch { /* 不存在 */ }
    await git(repoPath, ['remote', 'set-url', '--add', '--push', 'origin', gh]);
    await git(repoPath, ['remote', 'set-url', '--add', '--push', 'origin', gt]);
  }

  return { repoPath, github: gh, gitee: dualRemote ? `${PM_GITEE_BASE}/${slug}.git` : null };
}

/** 只读查询仓库状态（列表用） */
export async function repoInfo(repoPath) {
  if (!repoPath || !existsSync(join(repoPath, '.git'))) {
    return { exists: false, remotes: [], branch: null, head: null, dirty: 0 };
  }
  try {
    const [remoteV, branch, logLine, st] = await Promise.all([
      git(repoPath, ['remote', '-v']),
      git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(repoPath, ['log', '-1', '--date=short', '--format=%ad%x00%h%x00%s']),
      git(repoPath, ['status', '--porcelain=v2', '--branch']),
    ]);
    const remotes = remoteV.split('\n').filter(Boolean).map(line => {
      const [name, url, kind] = line.split(/\s+/);
      return { name, url, kind: kind.replace(/[()]/g, '') };
    });
    const [date = '', sha = '', subject = ''] = logLine.split('\x00');
    const lines = st.split('\n').filter(Boolean);
    const dirty = lines.filter(l => !l.startsWith('#')).length;
    const ab = lines.find(l => l.startsWith('# branch.ab '));
    const ahead = ab ? Number(ab.match(/\+(\d+)/)?.[1] || 0) : 0;
    return {
      exists: true,
      branch,
      head: `${sha} ${subject}`.trim(),
      last_commit_at: date,
      last_commit_subject: subject.slice(0, 80),
      ahead,
      dirty,
      remotes,
      dualPush: remotes.filter(r => r.kind === 'push').length >= 2,
    };
  } catch (e) {
    return { exists: true, error: e.message, remotes: [], branch: null, head: null, dirty: 0 };
  }
}
