// src/projects/fromMarkdown.js — 从 zpa 清单生成项目台账 seed
//
// 清单是事实源：PROJECTS.md / IDEAS-RANKING.md / PORTFOLIO.md
// - API 导入：import { buildSeed }，在进程内解析（不落盘，不弄脏仓库）
// - 手动生成：node src/projects/fromMarkdown.js [--out src/projects/seed.json]
//
// 解析失败会带文件名+行号抛错（上游表格改列数时不会静默写入 undefined）。

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { ZPA_DIR, ZREPO_DIR } from '../config.js';
import { STATUS, LAYER } from '../../public/projects-meta.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(__dirname, 'seed.json');

const strip = s => String(s || '')
  .replace(/\*\*/g, '').replace(/`/g, '')
  .replace(/^[\s🟢🟡🔵⚪🔴📦🧩💭📄✏️·]+/u, '')
  .replace(/\s+/g, ' ').trim();

// 状态单元格里的 emoji → 规范状态
function normStatus(cell) {
  const c = String(cell || '');
  if (c.includes('📦')) return STATUS.ARCHIVED;
  if (c.includes('🔴')) return STATUS.DEBT;
  if (c.includes('🟢')) return STATUS.ACTIVE;
  if (c.includes('🟡')) return STATUS.ON_DEMAND;
  if (c.includes('🔵')) return STATUS.MAINTENANCE;
  if (c.includes('⚪')) return STATUS.PAUSED;
  if (c.includes('🧩')) return STATUS.UPSTREAM;   // 返回 code，不再存 emoji
  return strip(c);
}

function layerOf(status, kind) {
  if (kind === 'idea') return LAYER.L3;
  if (status === STATUS.ARCHIVED) return LAYER.L4;
  if (status === STATUS.DEBT || status === STATUS.ACTIVE) return LAYER.L1;
  if (status === STATUS.UPSTREAM) return LAYER.L2;
  return LAYER.L2;
}

// 明确在做（L0）的项目名（人工口径，与 PORTFOLIO.md 一致）
const L0 = new Set(['zdashboard', 'zup / comfy-web', 'anotemanager (anm)', 'zpa', 'zscript']);

/**
 * 读 markdown 表格体行。
 * @returns {Array<{section:string, cells:string[], line:number, raw:string}>}
 */
export function readTableRows(md, file = 'markdown') {
  const out = [];
  let section = '';
  md.split('\n').forEach((line, idx) => {
    const h = line.match(/^#{2,4}\s+(.*)$/);
    if (h) { section = strip(h[1]); return; }
    if (!line.trim().startsWith('|')) return;
    if (/^\|[\s\-:|]+\|$/.test(line.trim())) return;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    // 表头
    if (cells[0].includes('项目') || cells[0] === '#' || cells[0].includes('想法') || cells[0].includes('仓库')) return;
    out.push({ section, cells, line: idx + 1, raw: line.trim() });
  });
  return out;
}

function need(row, min, file) {
  if (row.cells.length < min) {
    throw new Error(`${file}:${row.line} 表格列数不足（需要 ≥${min}，实际 ${row.cells.length}）：${row.raw}`);
  }
}

function parseProjects(md, file) {
  const projects = [];
  for (const row of readTableRows(md, file)) {
    const c = row.cells;
    const { section } = row;
    if (section.startsWith('一、自研应用')) {
      need(row, 6, file);
      projects.push({
        name: strip(c[0]), kind: 'repo', board: '工程', status: normStatus(c[3]),
        stack: strip(c[2]), deploy: strip(c[4]), next_step: strip(c[5]),
        source: 'zpa/PROJECTS.md §一',
      });
    } else if (section.startsWith('二、基础设施')) {
      need(row, 4, file);
      projects.push({
        name: strip(c[0]), kind: 'infra', board: '基建', status: normStatus(c[2]),
        note: strip(c[3]), source: 'zpa/PROJECTS.md §二',
      });
    } else if (section.startsWith('三、上游依赖')) {
      need(row, 4, file);
      projects.push({
        name: strip(c[0]), kind: 'upstream', board: '上游', status: normStatus(c[3]),
        note: strip(c[1]), deploy: strip(c[2]), source: 'zpa/PROJECTS.md §三',
      });
    } else if (section.startsWith('四、数据与素材')) {
      need(row, 3, file);
      projects.push({
        name: strip(c[0]), kind: 'data', board: '数据', status: normStatus(c[2]),
        note: strip(c[1]), source: 'zpa/PROJECTS.md §四',
      });
    } else if (section.startsWith('六、归档')) {
      need(row, 3, file);
      projects.push({
        name: strip(c[0]), kind: 'repo', board: '归档', status: STATUS.ARCHIVED,
        note: `${strip(c[2])}（归档位置：${strip(c[1])}）`, source: 'zpa/PROJECTS.md §六',
      });
    }
  }
  return projects;
}

const num = v => {
  const n = parseInt(String(v).replace(/\D/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

// 想法名规范化：去 idea/ 前缀、.md、/readme、括号补充说明、尾斜杠
export function cleanIdeaName(x) {
  let t = strip(x);
  t = t.replace(/^idea\//, '');
  t = t.replace(/[（(][^）)]*[）)]\s*$/, '');
  t = t.replace(/\.(md|MD)$/, '');
  t = t.replace(/\/(readme|README)$/, '');
  return t.replace(/[/\s]+$/, '').trim();
}

function parseIdeas(md, file) {
  const ideas = [];
  for (const row of readTableRows(md, file)) {
    const c = row.cells;
    const { section } = row;
    let idea, f, cc, i, total, note, grade;
    if (/^A 档/.test(section)) {
      // | # | 想法 | F | C | I | 合计 | 备注 |
      need(row, 7, file);
      [, idea, f, cc, i, total, note] = c;
      grade = 'A';
    } else if (/^B 档/.test(section)) {
      // | 想法 | F | C | I | 合计 | 前置条件 |
      need(row, 6, file);
      [idea, f, cc, i, total, note] = c;
      grade = 'B';
    } else if (/^C 档/.test(section)) {
      // | 想法 | F | C | I | 合计 |
      need(row, 5, file);
      [idea, f, cc, i, total] = c;
      note = '';
      grade = 'C';
    } else if (/^D 档/.test(section)) {
      // | 想法 | F | C | I | 合计 | 冻结理由 |
      need(row, 6, file);
      [idea, f, cc, i, total, note] = c;
      note = `冻结理由：${strip(note)}`;
      grade = 'D';
    } else {
      continue;
    }
    if (!strip(idea)) continue;
    const src = strip(idea).startsWith('idea/') ? `znote/${strip(idea)}` : `znote/idea/${strip(idea)}`;
    ideas.push({
      name: cleanIdeaName(idea),
      kind: 'idea', board: '想法', status: STATUS.IDEA,
      feasibility: num(f), completeness: num(cc), importance: num(i), score: num(total), grade,
      note: strip(note), source: src.replace(/[（(].*$/, ''),
    });
  }
  return ideas;
}

const tokensOf = (name) => name.replace(/[（(].*$/, '')
  .split(/[\s/\-—·]+/).map(t => t.replace(/[^\w\u4e00-\u9fa5]/g, '')).filter(t => t.length >= 4);

/**
 * 把 PORTFOLIO.md 第四节的风险表挂到对应项目。
 * 匹配：项目名的关键词只要整词出现在风险行里，就把影响/建议挂上。
 */
function attachRisks(projects, md, file) {
  for (const row of readTableRows(md, file)) {
    if (!row.section.startsWith('四、风险')) continue;
    need(row, 3, file);
    const rawCell = row.cells[1] || '';
    const impact = strip(row.cells[2] || '');
    const advice = strip(row.cells[3] || '');
    for (const p of projects) {
      if (p.kind === 'idea' || p.board === '归档') continue;   // 归档/想法不挂风险
      const toks = tokensOf(p.name);
      // 词边界匹配：避免 'tether' 命中 'aBigfileTether' 这类子串误配
      if (toks.some(t => new RegExp('(^|[^\\w])' + t + '([^\\w]|$)', 'i').test(rawCell))) {
        const txt = `${impact}${advice ? '（建议：' + advice + '）' : ''}`;
        p.risk = p.risk ? `${p.risk} / ${txt}` : txt;
      }
    }
  }
}

/** repo_path：按名字猜 <zrepoDir>/<name>（去掉括号补充、取空格/斜杠前的首个词） */
function guessRepoPaths(projects, zrepoDir) {
  for (const p of projects) {
    if (p.kind === 'idea') continue;
    const cand = p.name.replace(/[（(].*$/, '').split(/[\s/]+/)[0].replace(/\*\*/g, '');
    if (cand && existsSync(`${zrepoDir}/${cand}/.git`)) p.repo_path = `${zrepoDir}/${cand}`;
  }
}

function assignLayers(projects) {
  for (const p of projects) {
    p.layer = p.kind === 'idea' ? LAYER.L3
      : (p.board === '归档' ? LAYER.L4 : (L0.has(p.name) ? LAYER.L0 : layerOf(p.status || '', p.kind)));
    if (p.layer === LAYER.L0) p.pinned = 1;   // 在办置顶（原实现因顺序错误从未生效）
  }
}

/**
 * 构建 seed 数组（纯函数，不写文件）。
 * @param {{zpaDir?:string, zrepoDir?:string}} opts
 */
export function buildSeed({ zpaDir = ZPA_DIR, zrepoDir = ZREPO_DIR } = {}) {
  const projectsFile = resolve(zpaDir, 'PROJECTS.md');
  const ideasFile = resolve(zpaDir, 'IDEAS-RANKING.md');
  const portfolioFile = resolve(zpaDir, 'PORTFOLIO.md');
  for (const f of [projectsFile, ideasFile, portfolioFile]) {
    if (!existsSync(f)) throw new Error(`找不到 zpa 清单: ${f}`);
  }

  const projects = parseProjects(readFileSync(projectsFile, 'utf8'), 'PROJECTS.md');
  const ideas = parseIdeas(readFileSync(ideasFile, 'utf8'), 'IDEAS-RANKING.md');
  projects.push(...ideas);

  attachRisks(projects, readFileSync(portfolioFile, 'utf8'), 'PORTFOLIO.md');
  guessRepoPaths(projects, zrepoDir);
  assignLayers(projects);

  const names = new Set();
  for (const p of projects) {
    if (!p.name) throw new Error('存在空项目名（清单表格可能改版）');
    if (names.has(p.name)) throw new Error(`项目名重复: ${p.name}`);
    names.add(p.name);
  }
  return projects;
}

// ---- CLI：node src/projects/fromMarkdown.js [--out path] ----
const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const outArg = process.argv.indexOf('--out');
  const out = outArg > -1 ? process.argv[outArg + 1] : DEFAULT_OUT;
  const projects = buildSeed();
  writeFileSync(out, JSON.stringify(projects, null, 1) + '\n', 'utf8');
  const by = (k) => projects.reduce((m, p) => (m[p[k]] = (m[p[k]] || 0) + 1, m), {});
  console.log(`[seed] 生成 ${projects.length} 条 → ${out}`);
  console.log('[seed] 按 kind:', JSON.stringify(by('kind')));
  console.log('[seed] 按 layer:', JSON.stringify(by('layer')));
  console.log('[seed] 按 grade:', JSON.stringify(by('grade')));
}
