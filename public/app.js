// public/app.js — 启动入口：注册各应用 + 初始化角标
import './vocab.js';
import './nav.js';
import './agg.js';
import './projects.js';
import './pm.js';

import { startApp, setStat, updateAggBadge } from './core.js';
import { aggFetch, startAggPoll } from './agg.js';
import { pjApi, applyProjectsData } from './projects.js';

startApp();
startAggPoll();

// 顶栏版本 + Tools 角标（失败静默）
fetch('/api/health')
    .then(r => r.json())
    .then(h => setStat('Ver', 'v' + h.version))
    .catch(() => {});
aggFetch(false).then(d => updateAggBadge(d.totalNew || 0)).catch(() => {});
pjApi('').then(applyProjectsData).catch(() => {});
