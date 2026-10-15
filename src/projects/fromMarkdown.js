// src/projects/fromMarkdown.js — 从 zpa 的清单生成 seed.json（清单是事实源，DB 是操作层）
//
// 用法: node src/projects/fromMarkdown.js [--out src/projects/seed.json]
// 读:  /home/tony/zrepo/zpa/PROJECTS.md, IDEAS-RANKING.md
// 出:  src/projects/seed.json（导入用；zproject 表按 name 幂等 upsert）

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ZPA = process.env.ZPA_DIR || '/home/tony/zrepo/zpa';
const outArg = process.argv.indexOf('--out');
const OUT = outArg > -1 ? process.argv[outArg + 1] : resolve(__dirname, 'seed.json');

const strip = s => String(s || '')
  .replace(/\*\*/g, '').replace(/`/g, '')
  .replace(/^[\s🟢🟡🔵⚪🔴📦🧩💭📄✏️·]+/u, '')
  .replace(/\s+/g, ' ').trim();

// 状态单元格里的 emoji → 规范状态
function normStatus(cell) {
  const c = String(cell || '');
  if (c.includes('📦')) return '📦归档';
  if (c.includes('🔴')) return '🔴欠账';
  if (c.includes('🟢')) return '🟢活跃';
  if (c.includes('🟡')) return '🟡按需';
  if (c.includes('🔵')) return '🔵完成待维护';
  if (c.includes('⚪')) return '⚪暂停';
  if (c.includes('🧩')) return '🧩上游';
  return strip(c);
}

function layerOf(status, kind) {
  if (kind === 'idea') return 'L3 想法';
  if (status.includes('归档')) return 'L4 归档';
  if (status.includes('欠账')) return 'L1 活跃';
  if (status.includes('活跃')) return 'L1 活跃';
  if (status.includes('上游')) return 'L2 按需';
  if (status.includes('按需') || status.includes('暂停') || status.includes('完成待维护')) return 'L2 按需';
  return 'L2 按需';
}

// 明确在做（L0）的项目名（人工口径，与 PORTFOLIO.md 一致）
const L0 = new Set(['zdashboard', 'zup / comfy-web', 'anotemanager (anm)', 'zpa', 'zscript']);

function rows(md) {
  // 返回 [[section, cells...], ...]，只取表格体行
  const out = [];
  let section = '';
  for (const line of md.split('\n')) {
    const h = line.match(/^#{2,4}\s+(.*)$/);
    if (h) { section = strip(h[1]); continue; }
    if (!line.trim().startsWith('|')) continue;
    if (/^\|[\s\-:|]+\|$/.test(line.trim())) continue;         // 分隔行
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    if (cells[0].includes('项目') || cells[0] === '#' || cells[0].includes('想法') || cells[0].includes('仓库')) continue; // 表头
    out.push([section, ...cells]);
  }
  return out;
}

const projects = [];
const P = readFileSync(resolve(ZPA, 'PROJECTS.md'), 'utf8');
for (const [section, ...c] of rows(P)) {
  if (section.startsWith('一、自研应用')) {
    projects.push({
      name: strip(c[0]), kind: 'repo', board: '工程', status: normStatus(c[3]),
      stack: strip(c[2]), deploy: strip(c[4]), next_step: strip(c[5]),
      source: 'zpa/PROJECTS.md §一',
    });
  } else if (section.startsWith('二、基础设施')) {
    projects.push({
      name: strip(c[0]), kind: 'infra', board: '基建', status: normStatus(c[2]),
      note: strip(c[3]), source: 'zpa/PROJECTS.md §二',
    });
  } else if (section.startsWith('三、上游依赖')) {
    projects.push({
      name: strip(c[0]), kind: 'upstream', board: '上游', status: normStatus(c[3]),
      note: strip(c[1]), deploy: strip(c[2]), source: 'zpa/PROJECTS.md §三',
    });
  } else if (section.startsWith('四、数据与素材')) {
    projects.push({
      name: strip(c[0]), kind: 'data', board: '数据', status: normStatus(c[2]),
      note: strip(c[1]), source: 'zpa/PROJECTS.md §四',
    });
  } else if (section.startsWith('六、归档')) {
    projects.push({
      name: strip(c[0]), kind: 'repo', board: '归档', status: '📦归档',
      note: `${strip(c[2])}（归档位置：${strip(c[1])}）`, source: 'zpa/PROJECTS.md §六',
    });
  }
}

// 想法（IDEAS-RANKING.md 的 A/B/C/D 四张表）
const R = readFileSync(resolve(ZPA, 'IDEAS-RANKING.md'), 'utf8');
const ideaRows = [];
for (const [section, ...c] of rows(R)) {
  if (/^A 档/.test(section)) {
    // | # | 想法 | F | C | I | 合计 | 备注 |
    const [, idea, f, cc, i, total, note] = c;
    ideaRows.push({ idea: strip(idea), f, c: cc, i, total, note: strip(note), grade: 'A' });
  } else if (/^B 档/.test(section)) {
    // | 想法 | F | C | I | 合计 | 前置条件 |
    const [idea, f, cc, i, total, note] = c;
    ideaRows.push({ idea: strip(idea), f, c: cc, i, total, note: strip(note), grade: 'B' });
  } else if (/^C 档/.test(section)) {
    const [idea, f, cc, i, total] = c;
    ideaRows.push({ idea: strip(idea), f, c: cc, i, total, note: '', grade: 'C' });
  } else if (/^D 档/.test(section)) {
    const [idea, f, cc, i, total, why] = c;
    ideaRows.push({ idea: strip(idea), f, c: cc, i, total, note: `冻结理由：${strip(why)}`, grade: 'D' });
  }
}
// 想法名规范化：去 idea/ 前缀、.md、/readme、括号补充说明、尾斜杠
function cleanIdeaName(x) {
  let t = strip(x);
  t = t.replace(/^idea\//, '');
  t = t.replace(/[（(][^）)]*[）)]\s*$/, '');
  t = t.replace(/\.(md|MD)$/, '');
  t = t.replace(/\/(readme|README)$/, '');
  return t.replace(/[/\s]+$/, '').trim();
}

const num = v => { const n = parseInt(String(v).replace(/\D/g, ''), 10); return Number.isFinite(n) ? n : null; };
for (const r of ideaRows) {
  if (!r.idea) continue;
  const src = r.idea.startsWith('idea/') ? `znote/${r.idea}` : `znote/idea/${r.idea}`;
  projects.push({
    name: cleanIdeaName(r.idea),
    kind: 'idea', board: '想法', status: '💭想法',
    feasibility: num(r.f), completeness: num(r.c), importance: num(r.i), score: num(r.total), grade: r.grade,
    note: r.note, source: src.replace(/[（(].*$/, ''),
  });
}

// 风险：把 PORTFOLIO.md 第四节的风险表挂到对应项目
// 匹配方式：取项目名的若干关键词（按空格/斜杠/括号/连字符切），任一关键词出现在风险行里即挂上
const PORT = readFileSync(resolve(ZPA, 'PORTFOLIO.md'), 'utf8');
const tokensOf = (name) => name.replace(/[（(].*$/, '')
  .split(/[\s/\-—·]+/).map(t => t.replace(/[^\w\u4e00-\u9fa5]/g, '')).filter(t => t.length >= 4);
for (const [section, ...c] of rows(PORT)) {
  if (!section.startsWith('四、风险')) continue;
  const rawCell = c[1] || '', impact = strip(c[2] || ''), advice = strip(c[3] || '');
  for (const p of projects) {
    if (p.kind === 'idea' || p.board === '归档') continue;   // 归档条目不挂风险
    const toks = tokensOf(p.name);
    // 词边界匹配：避免 'tether' 命中 'aBigfileTether' 这类子串误配
    if (toks.some(t => new RegExp('(^|[^\\w])' + t + '([^\\w]|$)', 'i').test(rawCell))) {
      const txt = `${impact}${advice ? '（建议：' + advice + '）' : ''}`;
      p.risk = p.risk ? `${p.risk} / ${txt}` : txt;
    }
  }
}

// repo_path：按名字猜 /home/tony/zrepo/<name>（去掉括号补充、取空格/斜杠前的首个词）
const ZREPO = '/home/tony/zrepo';
for (const p of projects) {
  if (p.kind === 'idea') continue;
  const cand = p.name.replace(/[（(].*$/, '').split(/[\s/]+/)[0].replace(/\*\*/g, '');
  if (cand && existsSync(`${ZREPO}/${cand}/.git`)) p.repo_path = `${ZREPO}/${cand}`;
}

// 层：想法 L3；在办项目 L0；其余按状态
for (const p of projects) {
  if (p.layer === 'L0 在做') p.pinned = 1;    // 在办置顶
  p.layer = p.kind === 'idea' ? 'L3 想法'
    : (p.board === '归档' ? 'L4 归档' : (L0.has(p.name) ? 'L0 在做' : layerOf(p.status || '', p.kind)));
}

writeFileSync(OUT, JSON.stringify(projects, null, 1) + '\n', 'utf8');
const by = (k) => projects.reduce((m, p) => (m[p[k]] = (m[p[k]] || 0) + 1, m), {});
console.log(`[seed] 生成 ${projects.length} 条 → ${OUT}`);
console.log('[seed] 按 kind:', JSON.stringify(by('kind')));
console.log('[seed] 按 layer:', JSON.stringify(by('layer')));
console.log('[seed] 按 grade:', JSON.stringify(by('grade')));
