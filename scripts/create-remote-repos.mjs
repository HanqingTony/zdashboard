// scripts/create-remote-repos.mjs — 创建 GitHub + Gitee 仓库、配双推并推送
//
// 用法：
//   npm run remotes:create -- anarpgmaker --private --repo /home/tony/zrepo/anarpgmaker --push
//   node scripts/create-remote-repos.mjs anarpgmaker --public --description "xxx"
//
// 凭据：
//   GitHub: 本机 gh 登录态
//   Gitee:  /home/tony/zdata/zdashboard/gitee.env 里的 GITEE_TOKEN（600）
//           或环境变量 GITEE_TOKEN
import { createRemoteReposAndPush } from '../src/pm/remotes.js';

const args = process.argv.slice(2);
const name = args.find(a => !a.startsWith('--'));
if (!name) {
  console.error('用法: node scripts/create-remote-repos.mjs <name> [--public] [--description X] [--repo PATH] [--push]');
  process.exit(2);
}

const has = (k) => args.includes(k);
const valueOf = (k, fallback = '') => {
  const i = args.indexOf(k);
  if (i === -1) return fallback;
  return args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const result = await createRemoteReposAndPush({
  name,
  private: !has('--public'),
  description: valueOf('--description', `${name}`),
  repoPath: valueOf('--repo', ''),
  push: has('--push'),
});

const fmt = (r) => r.ok ? `${r.created ? 'created' : 'exists'} ${r.url}` : `FAILED ${r.error}`;
console.log(`[remotes] github: ${fmt(result.github)}`);
console.log(`[remotes] gitee : ${fmt(result.gitee)}`);
if (result.pushed) {
  console.log(`[remotes] push github: ${result.pushed.github.ok ? 'ok' : 'FAILED ' + result.pushed.github.error}`);
  console.log(`[remotes] push gitee : ${result.pushed.gitee.ok ? 'ok' : 'FAILED ' + result.pushed.gitee.error}`);
}
process.exit(result.ok && (!result.pushed || (result.pushed.github.ok && result.pushed.gitee.ok)) ? 0 : 1);
