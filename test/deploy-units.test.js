import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('nginx path unit 不使用 PathExists，避免 oneshot 自我触发', () => {
  const unit = readFileSync(resolve(root, 'deploy/zdashboard-nginx-apply.path'), 'utf8');
  assert.match(unit, /^PathChanged=\/home\/tony\/zdata\/zdashboard\/pm-nginx\.conf$/m);
  assert.doesNotMatch(unit, /^PathExists=/m);
  assert.match(unit, /^TriggerLimitIntervalSec=[1-9]\d*$/m);
  assert.match(unit, /^TriggerLimitBurst=[1-9]\d*$/m);
});

test('nginx apply service 有启动限流，避免失败风暴', () => {
  const unit = readFileSync(resolve(root, 'deploy/zdashboard-nginx-apply.service'), 'utf8');
  assert.match(unit, /^StartLimitIntervalSec=[1-9]\d*$/m);
  assert.match(unit, /^StartLimitBurst=[1-9]\d*$/m);
});
