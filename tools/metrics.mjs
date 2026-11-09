#!/usr/bin/env node
/**
 * 一眼看清「现在的规模」：库、日志、缓存、体积、单测。
 *
 *   node tools/metrics.mjs            # 人看
 *   node tools/metrics.mjs --json     # 机器读（CI / 记录用）
 *
 * 只读，不改任何文件。目的是回答「这个项目现在多大、哪块在长」这几个问题，
 * 免得每次都要现敲一堆 Get-ChildItem。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedEpisode } from '../lib/today.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AS_JSON = process.argv.includes('--json');

const readJson = async (rel, dflt = null) => {
  try { return JSON.parse(await fs.readFile(path.join(ROOT, rel), 'utf8')); }
  catch { return dflt; }
};

async function dirSize(abs) {
  let bytes = 0;
  let files = 0;
  const walk = async (d) => {
    let ents;
    try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        try { bytes += (await fs.stat(p)).size; files += 1; } catch { /* 被占用就算了 */ }
      }
    }
  };
  await walk(abs);
  return { bytes, files };
}

async function fileLines(rel) {
  try {
    const t = await fs.readFile(path.join(ROOT, rel), 'utf8');
    return t.trim() ? t.trim().split(/\r?\n/).length : 0;
  } catch { return 0; }
}

const mb = (n) => +(n / 1024 / 1024).toFixed(1);

const lib = (await readJson('data/library.json')) || {};
const watching = Array.isArray(lib.watching) ? lib.watching : [];
const now = new Date();
const behind = watching
  .map((w) => {
    const exp = expectedEpisode(w, lib, now);
    return exp == null ? 0 : exp - Number(w.ep_status || 0);
  })
  .filter((n) => n > 0);

const code = {};
for (const rel of [
  'server.mjs', 'panel/index.html', 'pet/Pet.cs',
  'lib/today.mjs', 'lib/bgm.mjs', 'lib/season-cache.mjs', 'lib/ics.mjs', 'lib/http-util.mjs', 'lib/zip.mjs'
]) code[rel] = await fileLines(rel);

let tests = 0;
try {
  tests = (await fs.readdir(path.join(ROOT, 'test'))).filter((f) => f.endsWith('.test.mjs')).length;
} catch { /* 没有 test/ */ }

const cache = await dirSize(path.join(ROOT, 'cache'));
const data = await dirSize(path.join(ROOT, 'data'));
const seasonDir = path.join(ROOT, 'data', 'season');
let seasons = [];
try { seasons = (await fs.readdir(seasonDir)).filter((f) => f.endsWith('.json')).sort(); } catch { /* 还没拉过 */ }

const backups = [];
try {
  for (const f of await fs.readdir(path.join(ROOT, 'data', 'backups'))) {
    if (f.endsWith('.json')) backups.push(f);
  }
} catch { /* 没有 backups/ */ }

const history = await fileLines('data/history.jsonl');
let logErrors = 0;
let logBytes = 0;
try {
  const log = await fs.readFile(path.join(ROOT, 'cache', 'server.log'), 'utf8');
  logBytes = Buffer.byteLength(log);
  logErrors = log.split(/\r?\n/).filter((l) => l.includes('[error]')).length;
} catch { /* 没日志 */ }

const pkg = (await readJson('package.json')) || {};
const out = {
  version: pkg.version || null,
  watching: watching.length,
  behind: { shows: behind.length, eps: behind.reduce((s, n) => s + n, 0) },
  weekdayEntries: Object.values(lib.weekday || {}).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0),
  seasonCache: seasons,
  backups: backups.length,
  historyLines: history,
  serverLog: { bytes: logBytes, errors: logErrors },
  sizes: { cacheMB: mb(cache.bytes), dataMB: mb(data.bytes), cacheFiles: cache.files },
  lines: code,
  testFiles: tests,
};

if (AS_JSON) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`TIARA ${out.version || '(no version)'}`);
  console.log('');
  console.log(`在追 ${out.watching} 部 · 星期表 ${out.weekdayEntries} 条 · 待看 ${out.behind.shows} 部 ${out.behind.eps} 话`);
  console.log(`季节缓存 ${out.seasonCache.length} 个${out.seasonCache.length ? `（${out.seasonCache.map((f) => f.replace('.json', '')).join(' ')}）` : ''}`);
  console.log(`备份 ${out.backups} 份 · 历史 ${out.historyLines} 行 · 服务日志 ${mb(out.serverLog.bytes)} MB / ${out.serverLog.errors} 条错误`);
  console.log(`cache/ ${out.sizes.cacheMB} MB（${out.sizes.cacheFiles} 文件） · data/ ${out.sizes.dataMB} MB`);
  console.log('');
  console.log('代码行数：');
  for (const [k, v] of Object.entries(out.lines)) console.log(`  ${k.padEnd(22)} ${String(v).padStart(5)}`);
  console.log('');
  console.log(`单测文件 ${out.testFiles} 个（node --test "test/*.test.mjs"）`);
}
