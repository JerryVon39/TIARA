#!/usr/bin/env node
/**
 * TIARA · 本季番剧表（命令行版）
 *
 * 面板里能做的事，命令行也能做：列当季、勾着加到在追。
 * 走的是同一套 lib/bgm.mjs + lib/season-cache.mjs，缓存文件也共用。
 *
 *   node tools/season.mjs                       # 列当季（先用 12 小时缓存）
 *   node tools/season.mjs --q 2026Q3 --net      # 强制走网络拉上一季
 *   node tools/season.mjs --tv-only --sort rate --top 20
 *   node tools/season.mjs --add 622288,665390   # 加进在追（带 track_from）
 *   node tools/season.mjs --add 622288 --dry-run
 */

import fs from 'node:fs/promises';
import { withLibraryLock } from '../lib/library-lock.mjs';
import { writeLibrary } from '../lib/library.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchSeason, mergeSeason, seasonOf } from '../lib/bgm.mjs';
import { readSeasonCache, writeSeasonCache } from '../lib/season-cache.mjs';
import { cstParts } from '../lib/today.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = '') => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const Q = val('--q', seasonOf(new Date()));
const NET = has('--net');
const TV_ONLY = has('--tv-only');
const SORT = val('--sort', 'date'); // date | rate | name
const TOP = Number(val('--top', '0')) || 0;
const ADD = val('--add', '');
const DRY = has('--dry-run');
const JSON_OUT = has('--json');

const readJson = async (rel, dflt = null) => {
  try {
    return JSON.parse(await fs.readFile(path.join(ROOT, rel), 'utf8'));
  } catch {
    return dflt;
  }
};

async function loadSeason() {
  if (!NET) {
    const cached = await readSeasonCache(ROOT, Q);
    if (cached && Array.isArray(cached.items) && cached.items.length) {
      return { items: cached.items, fetched_at: cached.fetched_at, source: 'cache' };
    }
  }
  const cfg = (await readJson('data/bgm.json', {})) || {};
  const res = await fetchSeason({
    q: Q,
    proxy: cfg.proxy || '',
    onProgress: (m) => process.stderr.write(`\r${m}`.padEnd(60)),
  });
  process.stderr.write('\r'.padEnd(60) + '\r');
  await writeSeasonCache(ROOT, res);
  return { items: res.items, fetched_at: res.fetched_at, source: 'net' };
}

function pick(list) {
  let out = list.slice();
  if (TV_ONLY) out = out.filter((x) => (x.meta || []).includes('TV'));
  if (SORT === 'rate') out.sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0));
  else if (SORT === 'name') out.sort((a, b) => String(a.name_cn || a.name).localeCompare(String(b.name_cn || b.name), 'zh'));
  else out.sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')));
  if (TOP > 0) out = out.slice(0, TOP);
  return out;
}

const fmtOne = (x) => {
  const wd = x.weekday ? `周${'一二三四五六日'[x.weekday - 1]}` : '星期未定';
  const rate = x.rating != null ? Number(x.rating).toFixed(1) : ' - ';
  const tags = (x.tags || []).filter((t) => !/^\d{4}年|TV|WEB/.test(t)).slice(0, 2).join('/');
  return `${String(x.id).padEnd(7)} ${rate}  ${wd}  ${x.date || '首播未定'}  ${x.name_cn || x.name}${tags ? `  [${tags}]` : ''}`;
};

async function main() {
  const season = await loadSeason();
  const list = pick(season.items || []);

  if (ADD) {
    return withLibraryLock(ROOT, async () => {
    const ids = ADD.split(',').map((s) => s.trim()).filter(Boolean);
    const lib = await readJson('data/library.json');
    if (!lib) {
      console.error('找不到 data/library.json');
      process.exit(1);
    }
    const { next, changes } = mergeSeason(lib, season.items || [], {
      add: ids,
      track_from: cstParts().date,
      now: new Date(),
    });
    if (!changes.length) {
      console.log('没有需要改的地方（这些 id 可能已经在追，或者不在本季表里）');
      return;
    }
    for (const c of changes) console.log(`+ ${c.id} ${c.to || ''}`);
    if (DRY) {
      console.log(`\n[dry-run] 会新增/修改 ${changes.length} 条，没有写盘`);
      return;
    }
    await writeLibrary(ROOT, next, { source: 'season-cli' });
    console.log(`\n已写入 data/library.json（${changes.length} 条），记得重算：node tools/build_today.mjs`);
    return;
    });
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ q: Q, source: season.source, total: list.length, items: list }, null, 2));
    return;
  }

  const tv = list.filter((x) => (x.meta || []).includes('TV')).length;
  console.log(`${Q} 共 ${season.items.length} 部 · 列出 ${list.length} 部${TV_ONLY ? '（仅 TV）' : `（其中 TV ${tv}）`} · 来源 ${season.source} · 抓于 ${season.fetched_at || '?'}`);
  console.log('');
  for (const x of list) console.log(fmtOne(x));
  console.log('');
  console.log('加进在追：node tools/season.mjs --add <id,id>   （加 --dry-run 先看会改什么）');
}

main().catch((e) => {
  console.error('season 失败：' + (e && e.message ? e.message : e));
  process.exit(1);
});
