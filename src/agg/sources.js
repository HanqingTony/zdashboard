// src/agg/sources.js — 「信息聚合」各信息源的探针定义
//
// 设计：**每个条目一套独立逻辑**，互不依赖；失败只影响自己（返回 {items} 或抛错）。
// 每个源：{ id, group, label, note, homepage, probe() }
//   probe() → { items: [{ id, title, url, createdAt, meta: [...] }] }
//   id 必须稳定（用于「新条目」判定），createdAt 为 ISO 字符串（可为空）
//
// 网络：国内平台与 hf-mirror/civarchive 走直连；出境源按 proxyMode 走本机代理
//       （'on' 必走 / 'auto' 先直连失败再走），不依赖系统代理 env。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { daysAgo } from '../lib/time.js';

const HF_BASE = 'https://hf-mirror.com';        // 直连可用（huggingface.co 需代理：直连 000）
const CA_BASE = 'https://civarchive.com';       // Civitai 存档站，直连可用

// 出境站点（红迪 / YouTube）走本机代理；国内平台直连（不绕代理）
const PROXY_URL = process.env.AGG_PROXY || 'http://127.0.0.1:12809';

// 榜单类 ID：同一话题隔天再上榜应重新提醒（每日榜/热搜按天去重）
const dayKey = () => new Date().toISOString().slice(0, 10);
let _undici = null;
async function undiciMod() {
  if (!_undici) _undici = await import('undici');
  return _undici;
}

let _proxyAgent = null;
async function proxyAgent() {
  if (!_proxyAgent) {
    const { ProxyAgent } = await undiciMod();
    _proxyAgent = new ProxyAgent(PROXY_URL);
  }
  return _proxyAgent;
}

const UA = 'zdashboard-info-aggregator/1.0 (+local)';

async function getJson(url, opts = {}) {
  const txt = await fetchText(url, opts);
  try { return JSON.parse(txt); }
  catch { throw new Error('返回不是 JSON（接口变了？）'); }
}

// proxyMode: 'off'（默认，直连）| 'on'（总是走本机代理）| 'auto'（先直连，失败再走代理）
async function fetchText(url, { timeoutMs = 15000, headers = {}, proxyMode = 'off', method = 'GET', body = undefined } = {}) {
  const opts = {
    method,
    headers: { 'User-Agent': UA, 'Accept': '*/*', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) opts.body = body;
  const tries = proxyMode === 'on' ? [true] : proxyMode === 'auto' ? [false, true] : [false];
  let lastErr;
  for (const useProxy of tries) {
    try {
      let res;
      if (useProxy) {
        // 坑：Node 内置 fetch 与 npm 装的 undici 版本不同，把外装 ProxyAgent 交给内置 fetch 会报
        // "invalid onRequestStart method"（fetch failed）→ 代理请求一律用 undici 自带的 fetch，保持同版本
        const u = await undiciMod();
        res = await u.fetch(url, { ...opts, dispatcher: await proxyAgent() });
      } else {
        res = await fetch(url, opts);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// RSS/Atom 解析（fast-xml-parser）
let _xmlParser = null;
async function parseXml(txt) {
  const { XMLParser } = await import('fast-xml-parser');
  if (!_xmlParser) _xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });
  return _xmlParser.parse(txt);
}
function asArray(x) { return x == null ? [] : Array.isArray(x) ? x : [x]; }

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
      id: `${dayKey()}:${r.word}`,
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
      id: `${dayKey()}:${r.word}`,
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
  const d = await getJson(url, { proxyMode: 'on', timeoutMs: 20000 });
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

// ---------- 外网备选（免 key / 官方 feed；经实测筛选，见 docs/v0.1.5.md） ----------

// Google Trends 每日热搜（**官方 RSS**，免 key；X trends 的首选替代指标）
function gTrendsProbe(geo = 'US', hl = 'en-US') {
  return async () => {
    const txt = await fetchText(`https://trends.google.com/trending/rss?geo=${geo}&hl=${hl}`, { proxyMode: 'auto', timeoutMs: 20000 });
    const doc = await parseXml(txt);
    const rows = asArray(doc?.rss?.channel?.item);
    if (!rows.length) throw new Error('RSS 里没有 item');
    return {
      items: hotItemsMapper(r => {
        const title = String(r.title || '').trim();
        const traffic = r['ht:approx_traffic'] ? `${r['ht:approx_traffic']} 搜索` : null;
        const src = r['ht:picture_source'] || null;
        return {
          id: `${dayKey()}:${title}`,
          title,
          url: `https://trends.google.com/trends/explore?geo=${geo}&q=${encodeURIComponent(title)}`,
          meta: [traffic, src].filter(Boolean),
        };
      })(rows),
    };
  };
}

// Reddit 热门：**有凭据走官方 OAuth（可靠）**，无凭据退回官方 RSS（***可能 429 限流***）
// 实测：免认证 `…/hot.json` 直连 000 / 走代理 403；官方 RSS 可读但被限流（429）→ OAuth 才是可靠路径
const redditOauthProbe = async () => {
  const id = process.env.REDDIT_CLIENT_ID, secret = process.env.REDDIT_CLIENT_SECRET;
  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const tok = await getJson('https://www.reddit.com/api/v1/access_token', {
    method: 'POST', proxyMode: 'on', timeoutMs: 20000,
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const access = tok?.access_token;
  if (!access) throw new Error('未拿到 access_token（检查 client_id/secret）');
  const d = await getJson('https://oauth.reddit.com/r/popular/hot?limit=25&raw_json=1', {
    proxyMode: 'on', timeoutMs: 20000, headers: { Authorization: `Bearer ${access}` },
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

function redditRssProbe(sub = 'popular', sort = 'hot') {
  return async () => {
    const url = `https://www.reddit.com/r/${sub}/${sort}/.rss?limit=25`;
    let txt;
    try {
      txt = await fetchText(url, { proxyMode: 'on', timeoutMs: 20000 });
    } catch (e) {
      if (!String(e.message).includes('429')) throw e;
      await new Promise(r => setTimeout(r, 3000));            // 被限流 → 等 3s 重试一次
      txt = await fetchText(url, { proxyMode: 'on', timeoutMs: 20000 });
    }
    const doc = await parseXml(txt);
    const rows = asArray(doc?.feed?.entry);
    if (!rows.length) throw new Error('feed 里没有 entry');
    return {
      items: hotItemsMapper(e => {
        const link = typeof e.link === 'object' ? (asArray(e.link)[0]?.['@href'] || '') : (e.link || '');
        const cat = asArray(e.category)[0];
        const label = cat?.['@label'] || (cat?.['@term'] ? `r/${cat['@term']}` : null);
        return {
          id: e.id || link,
          title: String(e.title || '').trim(),
          url: link || `https://www.reddit.com/r/${sub}/`,
          meta: [label, e.updated ? `${Math.max(0, Math.round((Date.now() - new Date(e.updated).getTime()) / 3600000))} 小时前` : null].filter(Boolean),
        };
      })(rows),
    };
  };
}

const redditProbe = async () => {
  const hasCreds = !!(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);
  return hasCreds ? redditOauthProbe() : redditRssProbe('popular')();
};

// Bluesky 趋势话题（**官方公共 API**，免 key；推特的同构替代）
const blueskyTrendsProbe = async () => {
  const d = await getJson('https://public.api.bsky.app/xrpc/app.bsky.unspecced.getTrendingTopics', { proxyMode: 'on', timeoutMs: 20000 });
  const rows = d?.topics || [];
  if (!rows.length) throw new Error('没有 topics');
  return {
    items: hotItemsMapper(t => ({
      id: `${dayKey()}:${t.topic || t.displayName || t.link}`,
      title: t.displayName || t.topic || '',
      url: t.link ? `https://bsky.app${t.link}` : 'https://bsky.app/explore',
      meta: [(t.description || '').slice(0, 46)].filter(Boolean),
    }))(rows),
  };
};

// Mastodon 趋势标签（**官方公共 API**，免 key）
const mastodonTrendsProbe = async () => {
  const d = await getJson('https://mastodon.social/api/v1/trends/tags?limit=10', { proxyMode: 'on', timeoutMs: 20000 });
  const rows = Array.isArray(d) ? d : [];
  if (!rows.length) throw new Error('没有趋势标签');
  return {
    items: hotItemsMapper(t => ({
      id: `${dayKey()}:${t.name}`,
      title: `#${t.name}`,
      url: t.url || `https://mastodon.social/tags/${t.name}`,
      meta: [t.history?.[0]?.uses != null ? `${t.history[0].uses} 帖/今日` : null,
        t.history?.[0]?.accounts != null ? `${t.history[0].accounts} 人` : null].filter(Boolean),
    }))(rows),
  };
};

// Hacker News 首页头条（**官方 Algolia API**，免 key）
const hnFrontPageProbe = async () => {
  const d = await getJson('https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=15', { proxyMode: 'auto' });
  const rows = d?.hits || [];
  return {
    items: hotItemsMapper(h => ({
      id: String(h.objectID),
      title: h.title || h.story_title || '',
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      meta: [h.points != null ? `${h.points} 分` : null, h.num_comments != null ? `${h.num_comments} 评论` : null].filter(Boolean),
    }))(rows),
  };
};

// 维基百科当日最热条目（**官方 pageviews API**，免 key；“世界在看什么”的稳定指标）
// 注意：pageviews 数据有 1–3 天延迟，当天查不到会 404 → 向前回退最多 4 天取最近可用的一天
const wikiTopProbe = async () => {
  let d = null, usedDay = null, lastErr = null;
  for (let back = 1; back <= 4; back++) {
    const y = new Date(Date.now() - back * 86400000);
    const day = `${y.getFullYear()}/${String(y.getMonth() + 1).padStart(2, '0')}/${String(y.getDate()).padStart(2, '0')}`;
    try {
      d = await getJson(`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${day}`,
        { proxyMode: 'auto', timeoutMs: 20000 });
      usedDay = day; break;
    } catch (e) { lastErr = e; }
  }
  if (!d) throw lastErr || new Error('取不到 pageviews 数据');
  const rows = (d?.items?.[0]?.articles || [])
    .filter(a => a.article && !a.article.startsWith('Special:') && a.article !== 'Main_Page')
    .slice(0, 12);
  return {
    items: hotItemsMapper(a => ({
      id: `${usedDay}:${a.article}`,
      title: a.article.replace(/_/g, ' '),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(a.article)}`,
      meta: [`${Number(a.views).toLocaleString()} 次浏览`, usedDay].filter(Boolean),
    }))(rows),
  };
};

// GitHub 新星仓库（**官方 search API**，免 key：未认证 10 次/分钟）
const githubTrendingProbe = async () => {
  const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const d = await getJson(`https://api.github.com/search/repositories?q=created:>${since}&sort=stars&order=desc&per_page=10`,
    { proxyMode: 'auto', timeoutMs: 20000, headers: { Accept: 'application/vnd.github+json' } });
  const rows = d?.items || [];
  return {
    items: hotItemsMapper(r => ({
      id: r.full_name,
      title: r.full_name,
      url: r.html_url,
      meta: [`★${Number(r.stargazers_count || 0).toLocaleString()}`, r.language, (r.description || '').slice(0, 40)].filter(Boolean),
    }))(rows),
  };
};

// ---------- 探针 N 类：版本更新（GitHub atom feed + 本地 git describe 对比） ----------
// 用 atom feed 而非 REST API：共享代理出口 IP 的 API 限额（60/时）易被吃光；feed 走 web 域，不限额。
// 本地版本 = 源码仓库的 `git describe --tags --always`（z-llamacpp/build.sh、z-ftllm/env.conf 的默认仓库位置）
const execFileP = promisify(execFile);
async function localDescribe(dir) {
  try {
    const { stdout } = await execFileP('git', ['-C', dir, 'describe', '--tags', '--always'], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },   // 只读 home 的 systemd hardening 下也能跑
    });
    return stdout.trim() || null;
  } catch { return null; }
}
// describe → { tag, dist }：v0.1.8.2-438-gf026aa53 → {tag:'v0.1.8.2',dist:438}；b11195-5-g81bc6b83f → {tag:'b11195',dist:5}；裸 sha → {tag:sha,dist:0}
function parseDescribe(s) {
  if (!s) return null;
  const m = String(s).match(/^(.+?)-(\d+)-g[0-9a-f]+$/i);
  return m ? { tag: m[1], dist: parseInt(m[2], 10) } : { tag: String(s), dist: 0 };
}
// b#### 构建号 / vX.Y.Z 语义号 → 可比数字数组
function versionKey(v) {
  const b = String(v).match(/^b(\d+)$/i);
  if (b) return [parseInt(b[1], 10)];
  const sem = String(v).match(/^v?(\d+(?:\.\d+)*)(?:\.\d+)?/);
  if (sem) return sem[1].split('.').map(n => parseInt(n, 10));
  return null;
}
function cmpVersion(a, b) {   // -1/0/1；不可比 → 0
  const ka = versionKey(a), kb = versionKey(b);
  if (!ka || !kb || ka.length !== kb.length) return 0;
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
  return 0;
}
// repo: github 仓库；feed: releases.atom（上游项目）| tags.atom（自有仓库）；localDir: 本地源码仓库
function githubVersionProbe({ repo, feed, name, localDir, take = 10 }) {
  return async () => {
    const txt = await fetchText(`https://github.com/${repo}/${feed}`, { proxyMode: 'auto', timeoutMs: 20000 });
    const doc = await parseXml(txt);
    const rows = asArray(doc?.feed?.entry);
    if (!rows.length) throw new Error('feed 里没有 entry');
    const local = parseDescribe(await localDescribe(localDir));
    const localShort = local ? (local.dist ? `${local.tag}+${local.dist}` : local.tag) : null;
    return {
      items: rows.slice(0, take).map(e => {
        const tag = String(e.title || '').trim();
        const link = typeof e.link === 'object' ? (asArray(e.link)[0]?.['@href'] || '') : (e.link || '');
        const updated = typeof e.updated === 'string' ? e.updated : null;
        let rel;
        if (!local) rel = '本地版本未知';
        else {
          const c = cmpVersion(tag, local.tag);
          if (c > 0) rel = `⬆ 本地 ${localShort} 落后`;
          else if (c === 0) rel = local.dist ? `✓ 本地领先 ${local.dist} 提交` : '✓ 与本地一致';
          else rel = `本地 ${localShort}`;
        }
        const d = daysAgo(updated);
        return {
          id: tag || link,
          title: `${name} ${tag}`,
          url: link || `https://github.com/${repo}`,
          createdAt: updated,
          meta: [rel, d === 0 ? '今天' : d === 1 ? '昨天' : d != null ? `${d} 天前` : null].filter(Boolean),
        };
      }),
    };
  };
}

// ---------- 源清单（用户当前关注的信息） ----------
export const SOURCES = [
  {
    id: 'hf-qwen',
    board: 'probe',
    group: 'HuggingFace',
    label: 'Qwen 团队新模型',
    note: 'author=Qwen，按创建时间倒序',
    homepage: `${HF_BASE}/models?author=Qwen&sort=createdate`,
    probe: hfAuthorProbe('Qwen'),
  },
  {
    id: 'hf-ornith',
    board: 'probe',
    group: 'HuggingFace',
    label: 'ornith-ai 新模型',
    note: 'author=ornith-ai（Ornith 系列）',
    homepage: `${HF_BASE}/models?author=ornith-ai&sort=createdate`,
    probe: hfAuthorProbe('ornith-ai'),
  },
  {
    id: 'hf-accio',
    board: 'probe',
    group: 'HuggingFace',
    label: 'Accio-Lab 新模型',
    note: 'author=Accio-Lab（occamy 系列）',
    homepage: `${HF_BASE}/models?author=Accio-Lab&sort=createdate`,
    probe: hfAuthorProbe('Accio-Lab'),
  },
  {
    id: 'ca-minimax-h3',
    board: 'probe',
    group: 'civarchive',
    label: 'MiniMax H3 新 LoRA',
    note: '检索 "minimax h3" → 只留 LoRA，底模含 MiniMax H3 各种写法',
    homepage: `${CA_BASE}/deleted-models/lora`,
    probe: civarchiveLoraProbe({ term: 'minimax h3', baseRe: /minimax[\s_\-]*h3/i }),
  },
  {
    id: 'ca-qwen-image-2.1',
    board: 'probe',
    group: 'civarchive',
    label: 'Qwen Image 2.1 新 LoRA',
    note: '检索 "qwen image 2.1" → 只留 LoRA，底模含 Qwen 2.1 / Qwen-Image-2.1',
    homepage: `${CA_BASE}/deleted-models/lora`,
    probe: civarchiveLoraProbe({ term: 'qwen image 2.1', baseRe: /qwen[\s_\-]*(image[\s_\-]*)?2\.1/i }),
  },

  // ===== 版本更新（本地栈 vs 上游；atom feed 免 key/限额，本地 git describe 对比） =====
  {
    id: 'ver-llamacpp',
    board: 'probe',
    group: '版本更新',
    label: 'llama.cpp 上游版本',
    note: 'ggml-org/llama.cpp releases.atom + 本地 ~/zrepo/llama.cpp git describe；落后时用 z-llamacpp.sh --build 重编',
    homepage: 'https://github.com/ggml-org/llama.cpp/releases',
    probe: githubVersionProbe({ repo: 'ggml-org/llama.cpp', feed: 'releases.atom', name: 'llama.cpp', localDir: path.join(os.homedir(), 'zrepo', 'llama.cpp') }),
  },
  {
    id: 'ver-fastllm',
    board: 'probe',
    group: '版本更新',
    label: 'fastllm (ftllm) 版本',
    note: 'ztxz16/fastllm tags.atom + 本地 ~/zrepo/fastllm git describe；本地为事实源，GitHub 为镜像',
    homepage: 'https://github.com/ztxz16/fastllm/tags',
    probe: githubVersionProbe({ repo: 'ztxz16/fastllm', feed: 'tags.atom', name: 'fastllm', localDir: path.join(os.homedir(), 'zrepo', 'fastllm') }),
  },

  // ===== 中文热榜（均为官方站点接口；抖音/知乎用官方移动端接口） =====
  {
    id: 'hot-bilibili',
    board: 'topic',
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
    board: 'topic',
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
    board: 'topic',
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
    board: 'topic',
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
    id: 'tr-gtrends',
    board: 'topic',
    display: 10,
    ranked: true,
    group: '外网趋势',
    label: 'Google Trends 热搜 (US)',
    note: '官方 RSS，免 key —— X trends 的首选替代指标',
    homepage: 'https://trends.google.com/trending?geo=US',
    probe: gTrendsProbe('US'),
  },
  {
    id: 'tr-reddit',
    board: 'topic',
    display: 10,
    ranked: true,
    group: '外网趋势',
    label: 'Reddit 热门 (r/popular)',
    note: '有凭据→官方 OAuth（可靠）；无凭据→官方 RSS（免 OAuth，但实测会被限流 429）',
    homepage: 'https://www.reddit.com/r/popular/',
    probe: redditProbe,
  },
  {
    id: 'tr-bluesky',
    board: 'topic',
    display: 10,
    ranked: true,
    group: '外网趋势',
    label: 'Bluesky 趋势话题',
    note: '官方公共 API，免 key —— 推特的同构替代',
    homepage: 'https://bsky.app/explore',
    probe: blueskyTrendsProbe,
  },
  {
    id: 'tr-mastodon',
    board: 'topic',
    display: 10,
    ranked: true,
    group: '外网趋势',
    label: 'Mastodon 趋势标签',
    note: '官方公共 API，免 key',
    homepage: 'https://mastodon.social/explore',
    probe: mastodonTrendsProbe,
  },
  {
    id: 'tr-hn',
    board: 'topic',
    display: 10,
    ranked: true,
    group: '外网趋势',
    label: 'Hacker News 头条',
    note: '官方 Algolia API，免 key —— 科技圈头条指标',
    homepage: 'https://news.ycombinator.com/',
    probe: hnFrontPageProbe,
  },
  {
    id: 'tr-wiki',
    board: 'topic',
    display: 10,
    ranked: true,
    group: '外网趋势',
    label: 'Wikipedia 当日最热条目',
    note: '官方 pageviews API，免 key —— “世界在看什么”',
    homepage: 'https://en.wikipedia.org/wiki/Wikipedia:Top_25_Report',
    probe: wikiTopProbe,
  },
  {
    id: 'tr-github',
    board: 'topic',
    display: 10,
    ranked: true,
    group: '外网趋势',
    label: 'GitHub 新星仓库',
    note: '官方 search API，免 key（未认证 10 次/分）—— 近 7 天新建 + star 最多',
    homepage: 'https://github.com/trending',
    probe: githubTrendingProbe,
  },
  {
    id: 'tr-youtube',
    board: 'topic',
    display: 10,
    ranked: true,
    group: '外网趋势',
    label: 'YouTube 最热趋势',
    note: '官方 Data API v3（免费配额 10k/日），需 YOUTUBE_API_KEY；免 key 的 Invidious 公共实例实测不可靠（403/401/非 JSON）',
    homepage: 'https://www.youtube.com/feed/trending',
    requires: { env: ['YOUTUBE_API_KEY'], hint: 'Google Cloud 控制台建项目 → 启用 YouTube Data API v3 → 建 API key；写进 /home/tony/zdata/zdashboard/agg.env' },
    probe: youtubeTrendingProbe,
  },
  // X/Twitter：官方 trends 需付费档；抓取型备选实测全不可靠（nitter RSS 410、getdaytrends rss 301、trends24 无 RSS）
  //   → 用 Google Trends + Bluesky + Mastodon 组合替代，不做抓取。详 docs/v0.1.5.md
];

export const SOURCE_MAP = new Map(SOURCES.map(s => [s.id, s]));
