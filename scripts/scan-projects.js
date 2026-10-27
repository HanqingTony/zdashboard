// scripts/scan-projects.js — 扫描本机仓库/运行服务并写入 managed_project
//
// 用法：npm run pm:scan
// 会创建缺失条目；已存在的同名/同仓库条目跳过；最后写一次 nginx 期望状态。
import { scanAndImport } from '../src/pm/scan.js';
import { writeManagedState } from '../src/pm/nginx.js';
import * as store from '../src/pm/store.js';

const r = await scanAndImport({ sync: true });
const state = writeManagedState(store.list());
console.log(`[pm:scan] 新增 ${r.created.length}: ${r.created.join(', ') || '—'}`);
console.log(`[pm:scan] 跳过 ${r.skipped.length}: ${r.skipped.join(', ') || '—'}`);
console.log(`[pm:scan] 仓库 ${r.repos} 个，监听端口 ${r.listening.join(',')}`);
console.log(`[pm:scan] nginx 期望状态: ${state.count} 个映射`);
