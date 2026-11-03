(() => {
  if (window.__zdVocabExtLoaded) return;
  window.__zdVocabExtLoaded = true;

  const WORD_RE = /[A-Za-z0-9]+(?:['\-][A-Za-z0-9]+)*/g;
  const SKIP_TEXT_RE = /```[\s\S]*?```|`[^`\n]*`|(?:https?:\/\/|www\.)[^\s]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi;
  const BLOCK_TAGS = new Set(['P', 'LI', 'BLOCKQUOTE', 'DD', 'DT', 'TD', 'TH', 'FIGCAPTION']);
  const SKIP_SELECTOR = [
    'script', 'style', 'noscript', 'code', 'pre', 'kbd', 'samp', 'textarea',
    'input', 'select', 'option', 'button', 'svg', 'math', 'canvas', 'video',
    'audio', 'iframe', 'object', 'embed',
    '[contenteditable=""]', '[contenteditable="true"]',
  ].join(',');
  const CHROME_BLOCKS = 'nav,header,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"],[aria-hidden="true"]';
  const MIN_BLOCK_CHARS = 40;
  const MIN_BLOCK_WORDS = 6;
  const CONTEXT_MAX = 2000;
  const SOURCE_MAX = 2048;

  const state = {
    active: false,
    blocks: new Set(),
    blockText: new Map(),
    blockWords: new Map(),
    blockTokens: new Map(),
    nodeTokens: new Map(),
    wordRanges: new Map(),
    wordBlocks: new Map(),
    words: new Set(),
    statuses: Object.create(null),
    loadedWords: new Set(),
    observer: null,
    scanTimer: 0,
    toastTimer: 0,
    lastBlock: null,
    highlightFamiliar: null,
    highlightUnknown: null,
  };

  const L = {
    unmarked: '初始未标记',
    familiar: '黄 · 不熟',
    unknown: '红 · 不认识',
    mastered: '无色 · 已掌握',
  };

  function toast(message, ms = 2600) {
    let el = document.getElementById('zd-vocab-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'zd-vocab-toast';
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = message;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      el?.remove();
      state.toastTimer = 0;
    }, ms);
  }

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || {});
        });
      } catch (err) {
        resolve({ error: err.message });
      }
    });
  }

  function blockText(el) {
    return String(el.innerText || '').replace(/\s+/g, ' ').trim();
  }

  function nearestBlock(node) {
    let el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    while (el && el !== document.documentElement) {
      if (BLOCK_TAGS.has(el.tagName)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function isEligibleBlock(el) {
    if (!el || !BLOCK_TAGS.has(el.tagName)) return false;
    if (el.closest(SKIP_SELECTOR) || el.closest(CHROME_BLOCKS)) return false;
    if (!el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return true;
  }

  function tokensFor(text) {
    const blocked = [...text.matchAll(SKIP_TEXT_RE)].map((m) => [m.index, m.index + m[0].length]);
    const out = [];
    for (const match of text.matchAll(WORD_RE)) {
      const raw = match[0];
      if (/^\d+$/.test(raw)) continue;
      const start = match.index;
      const end = start + raw.length;
      if (blocked.some(([a, b]) => start < b && end > a)) continue;
      out.push({ word: raw.toLowerCase(), text: raw, start, end });
    }
    return out;
  }

  function scanBlock(el) {
    if (state.blocks.has(el) || !isEligibleBlock(el)) return;
    const text = blockText(el);
    if (text.length < MIN_BLOCK_CHARS) return;

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        if (nearestBlock(node) !== el) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const local = [];
    const unique = new Set();
    let node;
    while ((node = walker.nextNode())) {
      const tokens = tokensFor(node.nodeValue);
      if (!tokens.length) continue;
      for (const token of tokens) {
        const range = document.createRange();
        range.setStart(node, token.start);
        range.setEnd(node, token.end);
        local.push({ ...token, block: el, range });
        unique.add(token.word);
      }
      state.nodeTokens.set(node, tokens.map((t) => ({ ...t, block: el })));
    }

    if (unique.size < MIN_BLOCK_WORDS) return;

    state.blocks.add(el);
    state.blockText.set(el, text);
    state.blockWords.set(el, unique);
    state.blockTokens.set(el, []);
    for (const token of local) {
      const list = state.wordRanges.get(token.word) || [];
      list.push(token.range);
      state.wordRanges.set(token.word, list);
      const blocks = state.wordBlocks.get(token.word) || new Set();
      blocks.add(el);
      state.wordBlocks.set(token.word, blocks);
      state.words.add(token.word);
      state.blockTokens.get(el).push(token);
    }
  }

  function scanPage() {
    for (const el of document.querySelectorAll('p,li,blockquote,dd,dt,td,th,figcaption')) {
      scanBlock(el);
    }
  }

  function clearHighlights() {
    if (typeof CSS === 'undefined' || !CSS.highlights) return;
    for (const name of ['zd-familiar', 'zd-unknown']) CSS.highlights.delete(name);
  }

  function applyHighlights() {
    if (typeof Highlight === 'undefined' || !CSS?.highlights) return;
    const familiar = new Highlight();
    const unknown = new Highlight();
    for (const [word, ranges] of state.wordRanges) {
      const status = state.statuses[word];
      if (status === 'familiar') {
        for (const range of ranges) familiar.add(range);
      } else if (status === 'unknown') {
        for (const range of ranges) unknown.add(range);
      }
    }
    CSS.highlights.set('zd-familiar', familiar);
    CSS.highlights.set('zd-unknown', unknown);
  }

  async function loadStatuses(words) {
    const pending = [...words].filter((w) => !state.loadedWords.has(w));
    if (!pending.length) return true;
    const response = await send({ type: 'zd-statuses', words: pending });
    if (response.error) {
      toast(`读取词库失败：${response.error}`, 4200);
      return false;
    }
    for (const word of pending) {
      state.loadedWords.add(word);
      const row = response.words?.[word];
      if (row?.status) state.statuses[word] = row.status;
    }
    return true;
  }

  function nextStatus(current) {
    if (!current) return 'familiar';
    if (current === 'familiar') return 'unknown';
    if (current === 'unknown') return 'mastered';
    return 'familiar';
  }

  function sourceUrl() {
    return location.href.split('#')[0].slice(0, SOURCE_MAX);
  }

  function occurrenceFor(token, status, clicked) {
    return {
      word: token.word,
      status,
      sourceUrl: sourceUrl(),
      sourceTitle: String(document.title || '').slice(0, 300),
      context: String(state.blockText.get(token.block) || '').slice(0, CONTEXT_MAX),
      clicked,
    };
  }

  async function recordTokens(tokens, clicked) {
    if (!tokens.length) return { ok: true };
    const seen = new Set();
    const occurrences = [];
    for (const token of tokens) {
      if (seen.has(token.word)) continue;
      seen.add(token.word);
      occurrences.push(occurrenceFor(token, state.statuses[token.word], clicked));
    }
    const response = await send({ type: 'zd-record', occurrences });
    if (response.error) {
      toast(`写入失败：${response.error}`, 4200);
      return { error: response.error };
    }
    return response;
  }

  async function cycleWord(token) {
    const word = token.word;
    const prev = state.statuses[word] || null;
    const next = nextStatus(prev);
    state.statuses[word] = next;
    applyHighlights();
    toast(`${token.text} → ${L[next]}`);
    const response = await recordTokens([token], true);
    if (response.error) {
      if (prev) state.statuses[word] = prev;
      else delete state.statuses[word];
      applyHighlights();
    }
  }

  function tokenAtPoint(x, y) {
    let node = null;
    let offset = 0;
    if (typeof document.caretPositionFromPoint === 'function') {
      const pos = document.caretPositionFromPoint(x, y);
      node = pos?.offsetNode;
      offset = pos?.offset ?? 0;
    } else if (typeof document.caretRangeFromPoint === 'function') {
      const range = document.caretRangeFromPoint(x, y);
      node = range?.startContainer;
      offset = range?.startOffset ?? 0;
    }
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    const tokens = state.nodeTokens.get(node);
    if (!tokens?.length) return null;
    let found = null;
    for (const token of tokens) {
      if (offset >= token.start && offset <= token.end) {
        found = token;
        if (offset < token.end) break;
      }
    }
    return found;
  }

  function onClick(event) {
    if (!state.active || event.button !== 0) return;
    const token = tokenAtPoint(event.clientX, event.clientY);
    if (!token) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    cycleWord(token);
  }

  function onContextMenu(event) {
    if (!state.active) return;
    const block = nearestBlock(event.target);
    if (block && state.blocks.has(block)) state.lastBlock = block;
  }

  async function completeParagraph() {
    if (!state.active) {
      toast('当前页面还没有开启词析');
      return { ok: false };
    }
    const block = state.lastBlock;
    if (!block || !state.blockWords.has(block)) {
      toast('请在正文段落上点右键，再选择“本段分析完成”');
      return { ok: false };
    }
    const words = [...state.blockWords.get(block)].filter((w) => !state.statuses[w]);
    if (!words.length) {
      toast('本段没有未标记的单词');
      return { ok: true, count: 0 };
    }

    const tokens = [];
    const seen = new Set();
    for (const token of state.blockTokens.get(block) || []) {
      if (!words.includes(token.word) || seen.has(token.word)) continue;
      seen.add(token.word);
      tokens.push(token);
    }

    const previous = new Map();
    for (const word of words) {
      previous.set(word, state.statuses[word]);
      state.statuses[word] = 'mastered';
    }
    applyHighlights();

    const response = await recordTokens(tokens, false);
    if (response.error) {
      for (const [word, value] of previous) {
        if (value) state.statuses[word] = value;
        else delete state.statuses[word];
      }
      applyHighlights();
      return { ok: false, error: response.error };
    }

    toast(`本段分析完成：${words.length} 个未标记词 → 已掌握`);
    return { ok: true, count: words.length };
  }

  function scheduleRescan() {
    if (!state.active || state.scanTimer) return;
    state.scanTimer = setTimeout(async () => {
      state.scanTimer = 0;
      if (!state.active) return;
      const before = state.words.size;
      scanPage();
      if (state.words.size > before) {
        if (await loadStatuses(state.words)) applyHighlights();
      }
    }, 350);
  }

  function cleanup() {
    state.active = false;
    if (state.scanTimer) clearTimeout(state.scanTimer);
    state.scanTimer = 0;
    state.observer?.disconnect();
    state.observer = null;
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('contextmenu', onContextMenu, true);
    clearHighlights();
    document.getElementById('zd-vocab-toast')?.remove();
    state.blocks.clear();
    state.blockText.clear();
    state.blockWords.clear();
    state.blockTokens.clear();
    state.nodeTokens.clear();
    state.wordRanges.clear();
    state.wordBlocks.clear();
    state.words.clear();
    state.statuses = Object.create(null);
    state.loadedWords.clear();
    state.lastBlock = null;
  }

  async function activate() {
    if (state.active) return { active: true };
    if (typeof Highlight === 'undefined' || !CSS?.highlights) {
      toast('当前浏览器不支持自定义高亮，请升级 Chrome/Edge');
      return { active: false, error: 'CSS Custom Highlight API 不可用' };
    }

    scanPage();
    if (!state.words.size) {
      toast('没有找到可分析的正文段落（已跳过导航、按钮、代码和短标签）', 4200);
      return { active: false, error: '没有找到正文' };
    }
    if (!(await loadStatuses(state.words))) return { active: false, error: '读取词库失败' };

    state.active = true;
    applyHighlights();
    window.addEventListener('click', onClick, true);
    window.addEventListener('contextmenu', onContextMenu, true);
    state.observer = new MutationObserver(scheduleRescan);
    state.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    toast(`词析已开启：${state.words.size} 个词，点击单词循环状态`, 3200);
    return { active: true };
  }

  function deactivate() {
    if (!state.active) return { active: false };
    cleanup();
    toast('词析已关闭');
    return { active: false };
  }

  async function toggle() {
    return state.active ? deactivate() : activate();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'zd-toggle') {
      toggle().then(sendResponse).catch((err) => sendResponse({ active: false, error: err.message }));
      return true;
    }
    if (message?.type === 'zd-complete-paragraph') {
      completeParagraph().then(sendResponse).catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    if (message?.type === 'zd-settings-changed') {
      if (state.active) {
        cleanup();
        toast('存储模式已切换，请重新点击 Z 图标开启词析', 4200);
      }
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();
