#!/usr/bin/env node
/**
 * tools/sync_bangumi.mjs — 把 Bangumi 的「在看」和本周放送表并进 data/library.json
 *
 * 用法：
 *   node tools/sync_bangumi.mjs                 # 有 token 就同步收藏 + 放送表
 *   node tools/sync_bangumi.mjs --calendar-only # 只更新「周几播」，不需要账号
 *   node tools/sync_bangumi.mjs --dry-run       # 只打印会改什么，不写盘
 *   node tools/sync_bangumi.mjs --fixture tools/fixtures  # 离线：读本地样本，验证合并逻辑
 *   node tools/sync_bangumi.mjs --json          # 机器可读输出（server / 桌宠用）
 *
 * 账号配置（二选一，环境变量优先）：
 *   data/bgm.json  { "user": "xxx", "token": "xxxxx", "proxy": "http://127.0.0.1:7890" }
 *   环境变量       BGM_USER / BGM_TOKEN / BGM_PROXY
 *
 * 写库规则（硬约束）：网络只改 name / name_cn / eps / air_weekday / start_date；
 * priority / rate / comment / last_watched / ep_status 永远归你（除非 --take-progress）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCalendar, fetchCollections, mergeLibrary } from '../lib/bgm.mjs';
import { readLibrary, writeLibrary } from '../lib/library.mjs';
import { withLibraryLock } from '../lib/library-lock.mjs';
import { writeJsonAtomic } from '../lib/atomic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const opt = (name, dflt = '') => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

const DRY = flag('dry-run');
const AS_JSON = flag('json');
const QUIET = flag('quiet');
const CAL_ONLY = flag('calendar-only');
const TAKE_PROGRESS = flag('take-progress');
const WEEKDAY_ALL = flag('weekday-all');   // 把放送表里全部番都补进周表（默认只补在追的）
const FIXTURE = opt('fixture');
const NO_BUILD = flag('no-build');

function say(...a) { if (!QUIET && !AS_JSON) console.log(...a); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

function loadConfig() {
  let cfg = {};
  const p = path.join(ROOT, 'data', 'bgm.json');
  if (exists(p)) { try { cfg = readJson(p); } catch (e) { say('⚠ data/bgm.json 解析失败：' + e.message); } }
  return {
    user: process.env.BGM_USER || opt('user') || cfg.user || '',
    token: process.env.BGM_TOKEN || opt('token') || cfg.token || '',
    proxy: process.env.BGM_PROXY || opt('proxy') || cfg.proxy || '',
    base: process.env.BGM_BASE || opt('base') || cfg.base || 'https://api.bgm.tv'
  };
}

function saveRaw(name, data) {
  try {
    const dir = path.join(ROOT, 'cache', 'bgm');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name + '-' + new Date().toISOString().slice(0, 10) + '.json'), JSON.stringify(data, null, 2), 'utf8');
  } catch { /* 缓存失败不影响主流程 */ }
}

function fmtChange(c) {
  const from = c.from === null ? '∅' : String(c.from);
  const to = c.to === null ? '∅' : String(c.to);
  return `  ${c.scope === 'weekday' ? '周表' : '在看'} ${c.id}  ${c.field}: ${from} → ${to}${c.note ? '   (' + c.note + ')' : ''}`;
}

async function main() {
  const cfg = loadConfig();
  const data = { calendar: null, collections: null };
  const notes = [];

  // ---- 放送表 ----
  if (FIXTURE) {
    const f = path.join(ROOT, FIXTURE, 'calendar.json');
    if (!exists(f)) throw new Error('fixture 缺日历：' + f);
    data.calendar = readJson(f);
    notes.push('日历：fixture ' + path.relative(ROOT, f));
  } else {
    try {
      data.calendar = await fetchCalendar({ proxy: cfg.proxy, base: cfg.base });
      saveRaw('calendar', data.calendar);
      const days = data.calendar.map((d) => `${d.weekday?.cn || d.weekday?.id}:${(d.items || []).length}`).join(' ');
      notes.push('日历：在线成功（' + days + '）');
    } catch (e) {
      notes.push('日历：拉取失败（' + e.message + '），跳过');
    }
  }

  // ---- 在看收藏 ----
  if (!CAL_ONLY) {
    if (FIXTURE) {
      const f = path.join(ROOT, FIXTURE, 'collections.json');
      if (exists(f)) { data.collections = readJson(f).data || readJson(f); notes.push('收藏：fixture'); }
    } else if (!cfg.token) {
      notes.push('收藏：没有 token，跳过（只更新放送表；配置 data/bgm.json 可同步「在看」）');
    } else {
      try {
        data.collections = await fetchCollections(cfg.user, cfg.token, { proxy: cfg.proxy, base: cfg.base });
        saveRaw('collections', data.collections);
        notes.push('收藏：在线成功，' + data.collections.length + ' 部在看');
      } catch (e) {
        notes.push('收藏：拉取失败（' + e.message + '），跳过');
      }
    }
  }

  if (!data.calendar && !data.collections) {
    const msg = { ok: false, reason: '没有任何可用数据', notes };
    if (AS_JSON) console.log(JSON.stringify(msg));
    else notes.forEach((n) => say('· ' + n));
    process.exitCode = 2;
    return;
  }

  const { changes } = await withLibraryLock(ROOT, async () => {
    const lib = await readLibrary(ROOT);
    const result = mergeLibrary(lib, data, { takeProgress: TAKE_PROGRESS, weekday: WEEKDAY_ALL ? 'all' : 'watching' });
    if (result.changes.length && !DRY) await writeLibrary(ROOT, result.next, { source: 'sync' });
    return result;
  });
  // 只有真实、非预览的成功同步才更新开机同步的时间戳。
  if (!DRY && !FIXTURE && data.calendar) {
    await writeJsonAtomic(path.join(ROOT, 'cache/bgm/sync-success.json'), { at: new Date().toISOString() });
  }

  if (!AS_JSON) {
    notes.forEach((n) => say('· ' + n));
    if (!changes.length) say('· 没有需要改的地方，库和线上一致');
    else { say('· 变更 ' + changes.length + ' 处：'); changes.forEach((c) => say(fmtChange(c))); }
  }

  if (changes.length && !DRY) {
    say('· 已写入 data/library.json（旧版备份 data/library.json.bak）');

    if (!NO_BUILD) {
      try {
        const { spawnSync } = await import('node:child_process');
        const r = spawnSync(process.execPath, ['tools/build_today.mjs'], { cwd: ROOT, encoding: 'utf8' });
        if (r.status !== 0) notes.push('重算 today.txt 失败：' + (r.stderr || '').trim());
        else say('· 已重算 ghost/master/today.txt');
      } catch (e) { notes.push('重算失败：' + e.message); }
    }
  } else if (DRY && changes.length) {
    say('· --dry-run：没有写盘');
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ ok: true, dryRun: DRY, changes: changes.length, detail: changes, notes }, null, 2));
  }
}

main().catch((e) => {
  if (AS_JSON) console.log(JSON.stringify({ ok: false, reason: e.message }));
  else { console.error('同步失败：' + e.message); }
  process.exitCode = 1;
});
