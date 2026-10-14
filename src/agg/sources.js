// src/agg/sources.js — 「信息聚合」各信息源的探针定义
//
// 设计：**每个条目一套独立逻辑**，互不依赖；失败只影响自己（返回 {items} 或抛错）。
// 每个源：{ id, group, label, note, homepage, probe() }
//   probe() → { items: [{ id, title, url, createdAt, meta: [...] }] }
//   id 必须稳定（用于「新条目」判定），createdAt 为 ISO 字符串（可为空）
//
// 网络：只走直连（实测 civarchive.com / hf-mirror.com 直连可用，不走代理）；
//       zdashboard 的 systemd 单元不需要代理环境变量。

const HF_BASE = 'https://hf-mirror.com';        // 直连可用（huggingface.co 需代理：直连 000）
const CA_BASE = 'https://civarchive.com';       // Civitai 存档站，直连可用

const UA = 'zdashboard-info-aggregator/1.0 (+local)';

async function getJson(url, { timeoutMs = 15000, headers = {} } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

function daysAgo(iso) {
  if (!iso) return null;
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return Number.isFinite(d) ? d : null;
}

// ---------- 探针 1 类：HuggingFace 组织最新模型 ----------
function hfAuthorProbe(author, { limit = 30, take = 8 } = {}) {
  return async () => {
    const url = `${HF_BASE}/api/models?author=${encodeURIComponent(author)}`
      + `&sort=createdAt&direction=-1&limit=${limit}&full=false`;
    const list = await getJson(url);
    if (!Array.isArray(list)) throw new Error('返回不是数组（接口变了？）');
    const items = list
      .filter(m => m && m.modelId && m.createdAt)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, take)
      .map(m => ({
        id: m.modelId,
        title: m.modelId,
        url: `${HF_BASE}/${m.modelId}`,
        createdAt: m.createdAt,
        meta: [
          m.pipeline_tag || null,
          m.downloads != null ? `↓${m.downloads}` : null,
          m.likes != null ? `♥${m.likes}` : null,
          (() => { const d = daysAgo(m.createdAt); return d === 0 ? '今天' : d === 1 ? '昨天' : d != null ? `${d} 天前` : null; })(),
        ].filter(Boolean),
      }));
    return { items, extra: { total: list.length, author } };
  };
}

// ---------- 探针 2 类：civarchive 按「底模」筛 LoRA ----------
// term: 提交给 /api/search?q= 的检索词（决定召回）
// baseRe: 底模名归一化匹配（civarchive 的 base_model 写法不统一，如 MiniMax H3 / MiniMax-H3 / MINIMAX_H3_COMFY）
function civarchiveLoraProbe({ term, baseRe, pages = 2, take = 10 }) {
  return async () => {
    const batch = [];
    for (let page = 1; page <= pages; page++) {
      const url = `${CA_BASE}/api/search?q=${encodeURIComponent(term)}&type=LORA&page=${page}`;
      const data = await getJson(url, { timeoutMs: 20000 });
      const rows = Array.isArray(data?.results) ? data.results : [];
      if (rows.length === 0) break;
      batch.push(...rows);
      if (batch.length >= 120) break;
    }
    const seen = new Set();
    const items = batch
      .filter(r => r && r.id && baseRe.test(String(r.base_model || '')))
      .filter(r => (seen.has(r.id) ? false : seen.add(r.id)))
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
      .slice(0, take)
      .map(r => {
        const iso = r.created_at ? new Date(r.created_at * 1000).toISOString() : null;
        const d = daysAgo(iso);
        return {
          id: r.id,
          title: r.name || r.id,
          url: r.url ? `${CA_BASE}${r.url}` : CA_BASE,
          createdAt: iso,
          meta: [
            r.base_model || null,
            r.username || null,
            r.download_count != null ? `↓${r.download_count}` : null,
            r.is_deleted ? '已删除' : null,
            d === 0 ? '今天' : d === 1 ? '昨天' : d != null ? `${d} 天前` : null,
          ].filter(Boolean),
          extra: { platform: r.platform || null },
        };
      });
    return { items, extra: { scanned: batch.length, term } };
  };
}

// ---------- 源清单（用户当前关注的信息） ----------
export const SOURCES = [
  {
    id: 'hf-qwen',
    group: 'HuggingFace',
    label: 'Qwen 团队新模型',
    note: 'author=Qwen，按创建时间倒序',
    homepage: `${HF_BASE}/models?author=Qwen&sort=createdate`,
    probe: hfAuthorProbe('Qwen'),
  },
  {
    id: 'hf-ornith',
    group: 'HuggingFace',
    label: 'ornith-ai 新模型',
    note: 'author=ornith-ai（Ornith 系列）',
    homepage: `${HF_BASE}/models?author=ornith-ai&sort=createdate`,
    probe: hfAuthorProbe('ornith-ai'),
  },
  {
    id: 'hf-accio',
    group: 'HuggingFace',
    label: 'Accio-Lab 新模型',
    note: 'author=Accio-Lab（occamy 系列）',
    homepage: `${HF_BASE}/models?author=Accio-Lab&sort=createdate`,
    probe: hfAuthorProbe('Accio-Lab'),
  },
  {
    id: 'ca-minimax-h3',
    group: 'civarchive',
    label: 'MiniMax H3 新 LoRA',
    note: '检索 "minimax h3" → 只留 LoRA，底模含 MiniMax H3 各种写法',
    homepage: `${CA_BASE}/deleted-models/lora`,
    probe: civarchiveLoraProbe({ term: 'minimax h3', baseRe: /minimax[\s_\-]*h3/i }),
  },
  {
    id: 'ca-qwen-image-2.1',
    group: 'civarchive',
    label: 'Qwen Image 2.1 新 LoRA',
    note: '检索 "qwen image 2.1" → 只留 LoRA，底模含 Qwen 2.1 / Qwen-Image-2.1',
    homepage: `${CA_BASE}/deleted-models/lora`,
    probe: civarchiveLoraProbe({ term: 'qwen image 2.1', baseRe: /qwen[\s_\-]*(image[\s_\-]*)?2\.1/i }),
  },
];

export const SOURCE_MAP = new Map(SOURCES.map(s => [s.id, s]));
