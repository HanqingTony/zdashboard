import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, wordCounts, normalizeText } from '../public/tokenize.js';

test('tokenize 无损重建原文（含标点与空白）', () => {
  const input = `Hello, world!\nIt's a test—"quoted" text.`;
  const tokens = tokenize(input);
  assert.equal(tokens.map(t => t.text).join(''), normalizeText(input));
  assert.ok(tokens.some(t => t.type === 'word' && t.key === "it's"));
});

test('弯引号与各种破折号归一化', () => {
  const tokens = tokenize('don\u2019t \u2014 well\u2010known\u00A0word');
  const words = tokens.filter(t => t.type === 'word').map(t => t.key);
  assert.deepEqual(words, ["don't", 'well-known', 'word']);
});

test('纯数字不是词，字母数字混合是词', () => {
  const words = tokenize('2024 GPT4 3.5 a').filter(t => t.type === 'word').map(t => t.key);
  assert.deepEqual(words, ['gpt4', 'a']);
});

test('wordCounts 与 tokenize 一致', () => {
  const counts = wordCounts('Hello hello HELLO world');
  assert.equal(counts.get('hello'), 3);
  assert.equal(counts.get('world'), 1);
  const fromTokens = new Map();
  for (const t of tokenize('Hello hello HELLO world')) {
    if (t.type === 'word') fromTokens.set(t.key, (fromTokens.get(t.key) || 0) + 1);
  }
  assert.deepEqual([...counts], [...fromTokens]);
});

test('URL / 邮箱 / 代码不进入词库，但仍原样显示', () => {
  const input = 'Visit https://example.com/a?b=1 or mail me@example.com. Use `npm test` please.\n```js\nconst x = 1;\n```';
  const tokens = tokenize(input);
  assert.equal(tokens.map(t => t.text).join(''), normalizeText(input));
  const words = tokens.filter(t => t.type === 'word').map(t => t.key);
  assert.deepEqual(words, ['visit', 'or', 'mail', 'use', 'please']);

  const counts = wordCounts(input);
  assert.equal(counts.has('example'), false);
  assert.equal(counts.has('npm'), false);
  assert.equal(counts.has('const'), false);
  assert.equal(counts.get('visit'), 1);
});
