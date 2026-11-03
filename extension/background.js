// 扩展后台：统一管理两种存储模式。
// - local：IndexedDB 工作库，导出 JSON/CSV 文件
// - api：直接调用 zdashboard 的通用词库 API，写同一个 SQLite

const SETTINGS_KEY = 'zd_settings_v1';
const DB_NAME = 'zd_vocab_local';
const DB_VERSION = 1;
const LOCAL_WORDS = 'words';
const LOCAL_OCC = 'occurrences';

const DEFAULTS = {
  mode: 'local',
  format: 'json',
  apiUrl: 'http://127.0.0.1:28100',
  apiToken: '',
  folderName: '',
};

let dbPromise = null;
let settingsCache = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LOCAL_WORDS)) {
        db.createObjectStore(LOCAL_WORDS, { keyPath: 'word' });
      }
      if (!db.objectStoreNames.contains(LOCAL_OCC)) {
        db.createObjectStore(LOCAL_OCC, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('无法打开本地数据库'));
  });
  return dbPromise;
}

function requestAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getSettings() {
  if (settingsCache) return { ...settingsCache };
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  settingsCache = { ...DEFAULTS, ...(stored[SETTINGS_KEY] || {}) };
  return { ...settingsCache };
}

async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  const changed = ['mode', 'apiUrl', 'apiToken'].some((key) => current[key] !== next[key]);
  settingsCache = next;
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  if (changed) await notifySettingsChanged();
  return { ...next };
}

async function notifySettingsChanged() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map(async (tab) => {
      if (!tab.id) return;
      try { await chrome.tabs.sendMessage(tab.id, { type: 'zd-settings-changed' }); } catch { /* 没有 content script */ }
    }));
  } catch { /* 忽略无标签页权限的瞬时状态 */ }
}

function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

async function apiFetch(settings, path, options = {}) {
  const base = normalizeBase(settings.apiUrl);
  if (!base) throw new Error('还没有配置 zdashboard API 地址');
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  if (settings.apiToken) headers['X-ZToken'] = settings.apiToken;
  let res;
  try {
    res = await fetch(base + path, {
      ...options,
      headers,
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    throw new Error(`连不上 zdashboard：${err.message}`);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON 错误页 */ }
  if (!res.ok) throw new Error(data?.error || `API HTTP ${res.status}`);
  return data;
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function apiStatuses(settings, words) {
  const out = {};
  for (const part of chunks(words, 200)) {
    const data = await apiFetch(settings, `/api/vocab/words?words=${encodeURIComponent(part.join(','))}`);
    Object.assign(out, data.words || {});
  }
  return out;
}

async function apiRecord(settings, occurrences) {
  const out = { words: {}, count: 0 };
  for (const part of chunks(occurrences, 200)) {
    const data = await apiFetch(settings, '/api/vocab/occurrences', {
      method: 'POST',
      body: JSON.stringify({ occurrences: part }),
    });
    Object.assign(out.words, data.words || {});
    out.count += data.count || 0;
  }
  return out;
}

async function apiStats(settings) {
  const data = await apiFetch(settings, '/api/vocab/stats');
  return data;
}

async function apiExport(settings) {
  const [all, data] = await Promise.all([
    apiFetch(settings, '/api/vocab/words?all=1'),
    apiFetch(settings, '/api/vocab/occurrences?limit=5000'),
  ]);
  const occurrences = data.occurrences || [];
  const words = all.words || {};
  return { words, occurrences };
}

function localWordRow(item, prev, now) {
  const clicked = item.clicked !== false;
  return {
    word: item.word,
    status: item.status,
    firstSeen: prev?.firstSeen || now,
    lastSeen: now,
    clickCount: (prev?.clickCount || 0) + (clicked ? 1 : 0),
  };
}

function localOccKey(item) {
  // 只用于本地去重；同步到 API 时服务端会重新按原句哈希。
  let h = 2166136261;
  const text = `${item.sourceUrl}|${item.context || ''}`;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${item.word}|${(h >>> 0).toString(16)}`;
}

async function localGetStatuses(words) {
  const db = await openDb();
  const store = db.transaction(LOCAL_WORDS, 'readonly').objectStore(LOCAL_WORDS);
  const out = {};
  await Promise.all(words.map(async (word) => {
    const row = await requestAsPromise(store.get(word));
    if (row) {
      out[word] = {
        word: row.word,
        status: row.status,
        clickCount: row.clickCount,
        lastSeen: row.lastSeen,
      };
    }
  }));
  return out;
}

async function localRecord(occurrences) {
  const now = new Date().toISOString();
  const db = await openDb();
  const tx = db.transaction([LOCAL_WORDS, LOCAL_OCC], 'readwrite');
  const wordStore = tx.objectStore(LOCAL_WORDS);
  const occStore = tx.objectStore(LOCAL_OCC);

  for (const item of occurrences) {
    const wordReq = wordStore.get(item.word);
    wordReq.onsuccess = () => {
      wordStore.put(localWordRow(item, wordReq.result, now));
    };

    const key = localOccKey(item);
    const occReq = occStore.get(key);
    occReq.onsuccess = () => {
      const prev = occReq.result;
      occStore.put({
        key,
        word: item.word,
        status: item.status,
        sourceUrl: item.sourceUrl || '',
        sourceTitle: item.sourceTitle || '',
        context: item.context || '',
        firstSeen: prev?.firstSeen || now,
        lastSeen: now,
        clickCount: (prev?.clickCount || 0) + (item.clicked === false ? 0 : 1),
      });
    };
  }

  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('本地写入失败'));
    tx.onabort = () => reject(tx.error || new Error('本地写入被回滚'));
  });
  return localGetStatuses([...new Set(occurrences.map((o) => o.word))]);
}

async function localAll() {
  const db = await openDb();
  const transaction = db.transaction([LOCAL_WORDS, LOCAL_OCC], 'readonly');
  const wordsArr = await requestAsPromise(transaction.objectStore(LOCAL_WORDS).getAll());
  const occArr = await requestAsPromise(transaction.objectStore(LOCAL_OCC).getAll());
  const words = {};
  for (const row of wordsArr) words[row.word] = row;
  occArr.sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
  return { words, occurrences: occArr };
}

async function localImport(occurrences) {
  if (!Array.isArray(occurrences) || !occurrences.length) return { count: 0 };
  await localRecord(occurrences.map((o) => ({
    ...o,
    clicked: o.clicked === true ? true : false,
  })));
  return { count: occurrences.length };
}

async function getStatuses(words) {
  const uniq = [...new Set((words || []).filter(Boolean))];
  if (!uniq.length) return {};
  const settings = await getSettings();
  return settings.mode === 'api'
    ? apiStatuses(settings, uniq)
    : localGetStatuses(uniq);
}

async function record(occurrences) {
  const list = (occurrences || []).filter((o) => o && o.word);
  if (!list.length) return { words: {}, count: 0 };
  const settings = await getSettings();
  return settings.mode === 'api'
    ? apiRecord(settings, list)
    : { words: await localRecord(list), count: list.length };
}

async function stats() {
  const settings = await getSettings();
  if (settings.mode === 'api') return apiStats(settings);
  const data = await localAll();
  return {
    total: Object.keys(data.words).length,
    occurrences: data.occurrences.length,
    counts: {},
    mode: 'local',
  };
}

async function dataForExport() {
  const settings = await getSettings();
  return settings.mode === 'api' ? apiExport(settings) : localAll();
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportData(format) {
  const data = await dataForExport();
  const settings = await getSettings();
  const fmt = format === 'csv' ? 'csv' : 'json';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  const filename = `zvocab-${stamp}.${fmt}`;

  if (fmt === 'csv') {
    const header = ['word', 'status', 'source_url', 'source_title', 'context', 'first_seen', 'last_seen', 'click_count'];
    const lines = [header.join(',')];
    for (const o of data.occurrences) {
      lines.push([
        o.word, o.status, o.sourceUrl, o.sourceTitle, o.context,
        o.firstSeen, o.lastSeen, o.clickCount,
      ].map(csvCell).join(','));
    }
    return { filename, content: lines.join('\r\n'), count: data.occurrences.length, mode: settings.mode };
  }

  return {
    filename,
    content: JSON.stringify({
      schema: 'zdashboard.vocab.v1',
      exportedAt: new Date().toISOString(),
      mode: settings.mode,
      words: data.words,
      occurrences: data.occurrences,
    }, null, 2),
    count: data.occurrences.length,
    mode: settings.mode,
  };
}

async function importData(occurrences) {
  const settings = await getSettings();
  if (settings.mode === 'api') return apiRecord(settings, occurrences);
  return localImport(occurrences);
}

async function testApi(settingsPatch) {
  const settings = await saveSettings(settingsPatch || {});
  const health = await apiFetch(settings, '/api/health');
  return { ok: true, health };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'zd-get-settings': return getSettings();
      case 'zd-save-settings': return saveSettings(message.settings || {});
      case 'zd-statuses': return getStatuses(message.words);
      case 'zd-record': return record(message.occurrences);
      case 'zd-stats': return stats();
      case 'zd-export': return exportData(message.format);
      case 'zd-import': return importData(message.occurrences);
      case 'zd-test-api': return testApi(message.settings);
      default: return { error: '未知消息' };
    }
  })().then(sendResponse).catch((err) => sendResponse({ error: err.message }));
  return true;
});

async function setBadge(tabId, active) {
  try {
    await chrome.action.setBadgeText({ tabId, text: active ? 'ON' : '' });
    if (active) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#2f9e7e' });
  } catch { /* 标签页可能已关闭 */ }
}

async function toggleTab(tab) {
  if (!tab?.id || !/^https?:/.test(tab.url || '')) {
    await setBadge(tab?.id, false);
    return;
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'zd-toggle' });
    await setBadge(tab.id, !!response?.active);
  } catch {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'zd-toggle' });
      await setBadge(tab.id, !!response?.active);
    } catch (err) {
      console.warn('[zvocab] 无法注入当前页面', err);
      await setBadge(tab.id, false);
      await chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    }
  }
}

chrome.action.onClicked.addListener((tab) => { toggleTab(tab); });

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') setBadge(tabId, false);
});

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'zd-settings', title: '词析设置…', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'zd-export', title: '导出词库…', contexts: ['action'] });
    chrome.contextMenus.create({
      id: 'zd-complete',
      title: '本段分析完成（未标记词设为已掌握）',
      contexts: ['page'],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'zd-settings' || info.menuItemId === 'zd-export') {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (info.menuItemId === 'zd-complete' && tab?.id) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'zd-complete-paragraph' });
    } catch { /* 当前页没有开启词析 */ }
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  setupMenus();
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  if (!stored[SETTINGS_KEY]) await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULTS });
});

chrome.runtime.onStartup.addListener(setupMenus);
setupMenus();
