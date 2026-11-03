const $ = (id) => document.getElementById(id);
const HANDLE_DB = 'zd_vocab_handles';
const HANDLE_STORE = 'handles';

const els = {
  mode: [...document.querySelectorAll('input[name="mode"]')],
  format: $('format'),
  folderName: $('folderName'),
  chooseFolder: $('chooseFolder'),
  exportBtn: $('exportBtn'),
  importBtn: $('importBtn'),
  importFile: $('importFile'),
  localNote: $('localNote'),
  apiUrl: $('apiUrl'),
  apiToken: $('apiToken'),
  testApi: $('testApi'),
  saveApi: $('saveApi'),
  apiNote: $('apiNote'),
  statWords: $('statWords'),
  statOcc: $('statOcc'),
  statMode: $('statMode'),
  refreshStats: $('refreshStats'),
  status: $('status'),
};

let dirHandle = null;

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response || {});
    });
  });
}

function showStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle('err', isError);
}

function mode() {
  return document.querySelector('input[name="mode"]:checked')?.value || 'local';
}

function currentFormat() {
  return els.format.value === 'csv' ? 'csv' : 'json';
}

function setModeUI() {
  document.body.dataset.mode = mode();
  const isApi = mode() === 'api';
  els.localNote.textContent = isApi
    ? 'API 模式的数据在 zdashboard；这里仍可导出 JSON/CSV 备份。'
    : '数据同时保存在扩展本地，导出的文件可带到别处。';
  els.apiNote.textContent = isApi
    ? '点击单词会立即写入 zdashboard 的数据库。'
    : '切到 API 模式后，这里才会启用。';
  els.exportBtn.textContent = isApi ? '从 API 导出 JSON / CSV' : '导出当前数据';
}

function settingsFromForm() {
  return {
    mode: mode(),
    format: currentFormat(),
    apiUrl: els.apiUrl.value.trim(),
    apiToken: els.apiToken.value,
    folderName: dirHandle?.name || els.folderName.value || '',
  };
}

async function hostPatternFor(url) {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('API 地址必须是 http/https');
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

async function ensureHostPermission(url) {
  const pattern = await hostPatternFor(url);
  const has = await chrome.permissions.contains({ origins: [pattern] });
  if (has) return true;
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) throw new Error('没有授权访问这个 API 地址');
  return true;
}

async function persist(settings, requestHost = false) {
  if (requestHost && settings.mode === 'api') {
    await ensureHostPermission(settings.apiUrl);
  }
  const response = await send({ type: 'zd-save-settings', settings });
  if (response.error) throw new Error(response.error);
  return response;
}

async function loadSettings() {
  const response = await send({ type: 'zd-get-settings' });
  if (response.error) throw new Error(response.error);
  const settings = response;
  for (const radio of els.mode) radio.checked = radio.value === settings.mode;
  els.format.value = settings.format === 'csv' ? 'csv' : 'json';
  els.apiUrl.value = settings.apiUrl || 'http://127.0.0.1:28100';
  els.apiToken.value = settings.apiToken || '';
  els.folderName.value = settings.folderName || '';
  dirHandle = await getDirHandle();
  if (dirHandle) els.folderName.value = dirHandle.name;
  setModeUI();
}

function openHandleDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(HANDLE_STORE)) {
        req.result.createObjectStore(HANDLE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getDirHandle() {
  try {
    const db = await openHandleDb();
    const tx = db.transaction(HANDLE_STORE, 'readonly');
    return await new Promise((resolve, reject) => {
      const req = tx.objectStore(HANDLE_STORE).get('dir');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function saveDirHandle(handle) {
  const db = await openHandleDb();
  const tx = db.transaction(HANDLE_STORE, 'readwrite');
  tx.objectStore(HANDLE_STORE).put(handle, 'dir');
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function chooseFolder() {
  if (typeof window.showDirectoryPicker !== 'function') {
    showStatus('当前浏览器不支持目录选择，请使用 Chrome/Edge 最新版', true);
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    const permission = await handle.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') throw new Error('没有获得目录写权限');
    dirHandle = handle;
    await saveDirHandle(handle);
    els.folderName.value = handle.name;
    await persist(settingsFromForm());
    showStatus(`数据目录：${handle.name}`);
  } catch (err) {
    if (err.name !== 'AbortError') showStatus(err.message, true);
  }
}

async function writeToDir(filename, content) {
  if (!dirHandle) return false;
  let permission = await dirHandle.queryPermission({ mode: 'readwrite' });
  if (permission !== 'granted') permission = await dirHandle.requestPermission({ mode: 'readwrite' });
  if (permission !== 'granted') throw new Error('目录写权限已失效，请重新选择目录');
  const file = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  await writable.write(content);
  await writable.close();
  return true;
}

function download(filename, content) {
  const type = filename.endsWith('.csv') ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8';
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportData() {
  try {
    const settings = settingsFromForm();
    await persist(settings, settings.mode === 'api');
    const response = await send({ type: 'zd-export', format: currentFormat() });
    if (response.error) throw new Error(response.error);
    const savedToFolder = await writeToDir(response.filename, response.content);
    if (!savedToFolder) download(response.filename, response.content);
    showStatus(`${savedToFolder ? '已写入' : '已下载'} ${response.filename}（${response.count} 条出处）`);
  } catch (err) {
    showStatus(err.message, true);
  }
}

function parseJson(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data.occurrences;
  if (!Array.isArray(list)) throw new Error('JSON 里没有 occurrences 数组');
  return list;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(cell); cell = ''; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
      continue;
    }
    cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim())) rows.push(row);
  if (!rows.length) return [];

  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((values) => {
    const obj = {};
    header.forEach((key, index) => { obj[key] = values[index] ?? ''; });
    return obj;
  });
}

function normalizeOccurrence(row) {
  const word = String(row.word || '').trim().toLowerCase();
  const status = String(row.status || '').trim();
  if (!word || !['familiar', 'unknown', 'mastered'].includes(status)) return null;
  return {
    word,
    status,
    sourceUrl: String(row.sourceUrl ?? row.source_url ?? ''),
    sourceTitle: String(row.sourceTitle ?? row.source_title ?? ''),
    context: String(row.context ?? ''),
    clicked: false,
  };
}

async function importData(file) {
  try {
    const text = await file.text();
    const parsed = file.name.toLowerCase().endsWith('.csv') ? parseCsv(text) : parseJson(text);
    const occurrences = parsed.map(normalizeOccurrence).filter(Boolean);
    if (!occurrences.length) throw new Error('没有可导入的有效词条');
    const response = await send({ type: 'zd-import', occurrences });
    if (response.error) throw new Error(response.error);
    await refreshStats();
    showStatus(`已导入 ${response.count ?? occurrences.length} 条出处记录`);
  } catch (err) {
    showStatus(`导入失败：${err.message}`, true);
  }
}

async function saveApi() {
  try {
    const settings = settingsFromForm();
    await persist(settings, true);
    showStatus('API 设置已保存');
  } catch (err) {
    showStatus(err.message, true);
  }
}

async function testApi() {
  try {
    const settings = settingsFromForm();
    await persist(settings, true);
    const response = await send({ type: 'zd-test-api', settings });
    if (response.error) throw new Error(response.error);
    const health = response.health || {};
    showStatus(`连接成功：${health.service || 'zdashboard'} ${health.version || ''}`.trim());
  } catch (err) {
    showStatus(`连接失败：${err.message}`, true);
  }
}

async function refreshStats() {
  try {
    const response = await send({ type: 'zd-stats' });
    if (response.error) throw new Error(response.error);
    els.statWords.textContent = response.total ?? '–';
    els.statOcc.textContent = response.occurrences ?? '–';
    els.statMode.textContent = mode() === 'api' ? 'API' : '本地';
  } catch (err) {
    els.statWords.textContent = '–';
    els.statOcc.textContent = '–';
    els.statMode.textContent = '–';
    showStatus(err.message, true);
  }
}

els.mode.forEach((radio) => radio.addEventListener('change', async () => {
  setModeUI();
  try { await persist(settingsFromForm()); } catch (err) { showStatus(err.message, true); }
  refreshStats();
}));

els.format.addEventListener('change', async () => {
  try { await persist(settingsFromForm()); } catch (err) { showStatus(err.message, true); }
});

els.chooseFolder.addEventListener('click', chooseFolder);
els.exportBtn.addEventListener('click', exportData);
els.importBtn.addEventListener('click', () => els.importFile.click());
els.importFile.addEventListener('change', async () => {
  const file = els.importFile.files?.[0];
  els.importFile.value = '';
  if (file) await importData(file);
});
els.saveApi.addEventListener('click', saveApi);
els.testApi.addEventListener('click', testApi);
els.refreshStats.addEventListener('click', refreshStats);

(async () => {
  try {
    await loadSettings();
    await refreshStats();
  } catch (err) {
    showStatus(err.message, true);
  }
})();
