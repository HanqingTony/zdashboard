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

// 出境站点（红迪 / YouTube）走本机代理；国内平台直连（不绕代理）
export const PROXY_URL = process.env.AGG_PROXY || 'http://127.0.0.1:12809';
let _proxyAgent = null;
async function proxyAgent() {
  if (!_proxyAgent) {
    const { ProxyAgent } = await import('undici');
    _proxyAgent = new ProxyAgent(PROXY_URL);
  }
  return _proxyAgent;
}

const UA = 'zdashboard-info-aggregator/1.0 (+local)';

async function getJson(url, { timeoutMs = 15000, headers = {}, proxy = false, method = 'GET', body = undefined } = {}) {
  const opts = {
    method,
    headers: { 'User-Agent': UA, 'Accept': 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) opts.body = body;
  if (proxy) opts.dispatcher = await proxyAgent();          // 不走系统代理 env，显式走本机代理
  const res = await fetch(url, opts);
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

// ---------- 热榜类探针（ord = 榜单排名；无 createdAt） ----------
function hotItemsMapper(fn) {
  return rows => rows.map((r, i) => {
    const it = fn(r, i);
    return { ord: i + 1, createdAt: null, meta: [], ...it };
  });
}

// bilibili 热门（官方公开接口，免鉴权；注意：ranking/v2 需风控签名，已实测 -352，故用 popular）
const biliHotProbe = async () => {
  const d = await getJson('https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1', {
    headers: { Referer: 'https://www.bilibili.com/' },
  });
  if (d.code !== 0) throw new Error(`bilibili code=${d.code} ${d.message || ''}`);
  const rows = d?.data?.list || [];
  return {
    items: hotItemsMapper(r => ({
      id: r.bvid,
      title: r.title,
      url: `https://www.bilibili.com/video/${r.bvid}`,
      meta: [r.owner?.name, r.stat?.view != null ? `${(r.stat.view / 10000).toFixed(1)}万播放` : null].filter(Boolean),
    }))(rows),
  };
};

// 微博热搜（官方站点接口，免登录；非文档化接口，可能变动）
const weiboHotProbe = async () => {
  const d = await getJson('https://weibo.com/ajax/side/hotSearch', { headers: { Referer: 'https://weibo.com/' } });
  const rows = d?.data?.realtime || [];
  if (rows.length === 0) throw new Error('接口未返回 realtime（可能需要 cookie）');
  return {
    items: hotItemsMapper(r => ({
      id: r.word,
      title: r.word,
      url: `https://s.weibo.com/weibo?q=${encodeURIComponent('#' + r.word + '#')}`,
      meta: [r.label_name || null, r.num != null ? `${Math.round(r.num / 1000)}k` : null].filter(Boolean),
    }))(rows.slice(0, 20)),
  };
};

// 知乎热榜（官方移动端接口，免鉴权；web 端 v3 接口要身份：实测 401，故用此）
const zhihuHotProbe = async () => {
  const d = await getJson('https://api.zhihu.com/topstory/hot-list?limit=20');
  const rows = d?.data || [];
  return {
    items: hotItemsMapper(r => {
      const t = r.target || {};
      const qid = String(t.url || '').match(/questions\/(\d+)/)?.[1];
      return {
        id: qid || String(t.title || '').slice(0, 40),
        title: t.title || '',
        url: qid ? `https://www.zhihu.com/question/${qid}` : 'https://www.zhihu.com/hot',
        meta: [r.detail_text || null].filter(Boolean),
      };
    })(rows),
  };
};

// 抖音热榜（官方旧版接口免签名；web 端新接口需 a_bogus 签名，实测返回空）
const douyinHotProbe = async () => {
  const d = await getJson('https://aweme.snssdk.com/aweme/v1/hot/search/list/');
  const rows = d?.data?.word_list || d?.word_list || [];
  if (rows.length === 0) throw new Error('接口未返回 word_list');
  return {
    items: hotItemsMapper(r => ({
      id: r.word,
      title: r.word,
      url: `https://www.douyin.com/search/${encodeURIComponent(r.word)}`,
      meta: [r.hot_value != null ? `${(r.hot_value / 10000).toFixed(0)}万` : null].filter(Boolean),
    }))(rows.slice(0, 20)),
  };
};

// YouTube 最热（**官方 Data API v3**，免费配额 10k/日；需 API key）
const youtubeTrendingProbe = async () => {
  const key = process.env.YOUTUBE_API_KEY;
  const url = 'https://www.googleapis.com/youtube/v3/videos'
    + `?part=snippet,statistics&chart=mostPopular&maxResults=15&regionCode=US&key=${encodeURIComponent(key)}`;
  const d = await getJson(url, { proxy: true, timeoutMs: 20000 });
  const rows = d?.items || [];
  return {
    items: hotItemsMapper(r => ({
      id: r.id,
      title: r.snippet?.title || '',
      url: `https://www.youtube.com/watch?v=${r.id}`,
      meta: [r.snippet?.channelTitle, r.statistics?.viewCount != null ? `${(Number(r.statistics.viewCount) / 10000).toFixed(0)}万播放` : null].filter(Boolean),
    }))(rows),
  };
};

// Reddit 热门（**官方 OAuth API**，免费注册 app；需 client_id/secret，走代理）
const redditHotProbe = async () => {
  const id = process.env.REDDIT_CLIENT_ID, secret = process.env.REDDIT_CLIENT_SECRET;
  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const tok = await getJson('https://www.reddit.com/api/v1/access_token', {
    method: 'POST', proxy: true, timeoutMs: 20000,
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const access = tok?.access_token;
  if (!access) throw new Error('未拿到 access_token（检查 client_id/secret）');
  const d = await getJson('https://oauth.reddit.com/r/popular/hot?limit=15&raw_json=1', {
    proxy: true, timeoutMs: 20000, headers: { Authorization: `Bearer ${access}` },
  });
  const rows = d?.data?.children || [];
  return {
    items: hotItemsMapper(c => {
      const r = c.data || {};
      return {
        id: r.id,
        title: r.title || '',
        url: r.permalink ? `https://www.reddit.com${r.permalink}` : 'https://www.reddit.com/r/popular/',
        meta: [`r/${r.subreddit || '?'}`, r.ups != null ? `↑${r.ups}` : null, r.num_comments != null ? `💬${r.num_comments}` : null].filter(Boolean),
      };
    })(rows),
  };
};

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

  // ===== 中文热榜（均为官方站点接口；抖音/知乎用官方移动端接口） =====
  {
    id: 'hot-bilibili',
    display: 10,      // 热榜：一屏扫排名，显示前 10 条
    ranked: true,
    group: '中文热榜',
    label: 'bilibili 热门',
    note: '官方公开接口 api.bilibili.com/x/web-interface/popular（ranking/v2 需风控签名，不可用）',
    homepage: 'https://www.bilibili.com/v/popular/all',
    probe: biliHotProbe,
  },
  {
    id: 'hot-weibo',
    display: 10,      // 热榜：一屏扫排名，显示前 10 条
    ranked: true,
    group: '中文热榜',
    label: '微博热搜',
    note: '官方站点接口 weibo.com/ajax/side/hotSearch（免登录；非文档化，可能变动）',
    homepage: 'https://s.weibo.com/top/summary',
    probe: weiboHotProbe,
  },
  {
    id: 'hot-zhihu',
    display: 10,      // 热榜：一屏扫排名，显示前 10 条
    ranked: true,
    group: '中文热榜',
    label: '知乎热榜',
    note: '官方移动端接口 api.zhihu.com/topstory/hot-list（web 端 v3 需身份）',
    homepage: 'https://www.zhihu.com/hot',
    probe: zhihuHotProbe,
  },
  {
    id: 'hot-douyin',
    display: 10,      // 热榜：一屏扫排名，显示前 10 条
    ranked: true,
    group: '中文热榜',
    label: '抖音热榜',
    note: '官方旧版接口 aweme.snssdk.com/aweme/v1/hot/search/list/（免签名；web 新接口需 a_bogus）',
    homepage: 'https://www.douyin.com/hot',
    probe: douyinHotProbe,
  },
  // 小红书：无公开接口（web 需 x-s/x-t 签名）→ 未实现，见 docs/v0.1.4.md

  // ===== 外网趋势（走本机代理；需凭据） =====
  {
    id: 'tr-youtube',
    display: 10,      // 热榜：一屏扫排名，显示前 10 条
    ranked: true,
    group: '外网趋势',
    label: 'YouTube 最热趋势',
    note: '官方 Data API v3（免费配额 10k/日），需 YOUTUBE_API_KEY',
    homepage: 'https://www.youtube.com/feed/trending',
    requires: { env: ['YOUTUBE_API_KEY'], hint: 'Google Cloud 控制台建项目 → 启用 YouTube Data API v3 → 建 API key；写进 /home/tony/zdata/zdashboard/agg.env' },
    proxy: true,
    probe: youtubeTrendingProbe,
  },
  {
    id: 'tr-reddit',
    display: 10,      // 热榜：一屏扫排名，显示前 10 条
    ranked: true,
    group: '外网趋势',
    label: 'Reddit 热门',
    note: '官方 OAuth API（免费注册 app，额度 100 QPM），需 REDDIT_CLIENT_ID/SECRET',
    homepage: 'https://www.reddit.com/r/popular/',
    requires: { env: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'], hint: 'reddit.com/prefs/apps 建 script app → 取 client id/secret；写进 /home/tony/zdata/zdashboard/agg.env' },
    proxy: true,
    probe: redditHotProbe,
  },
  // X/Twitter：官方 API v2 的 trends 需付费档（Basic 起）→ 未实现，见 docs/v0.1.4.md
];

export const SOURCE_MAP = new Map(SOURCES.map(s => [s.id, s]));
