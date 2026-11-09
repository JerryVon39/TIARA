#!/usr/bin/env node
/**
 * tools/clean_cache.mjs — 清理 cache/ 里的临时垃圾（零依赖）
 *
 * 为什么需要：跑自检 / CDP 探针时会用 `--user-data-dir=cache/cdp_profile_*` 起无头浏览器，
 * 一次 50–60 MB；脚本只 kill 进程不删目录，几天就能堆到几百 MB。
 *
 * 用法：
 *   node tools/clean_cache.mjs                 # 清临时 profile，保留 audit（截图证据）
 *   node tools/clean_cache.mjs --dry-run       # 只报数
 *   node tools/clean_cache.mjs --all           # 连 audit/ 也清
 *   node tools/clean_cache.mjs --keep-audit-days 7   # audit/ 只留最近 7 天
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'cache');

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const all = args.includes('--all');
const keepDays = (() => {
  const i = args.indexOf('--keep-audit-days');
  if (i >= 0 && args[i + 1]) return Number(args[i + 1]);
  return null;
})();

const TEMP_DIR = /^(cdp_profile_|probe_prof_|edgeprof_|tmp_)/;

function sizeOf(p) {
  return fs.readdir(p, { withFileTypes: true })
    .then(async (ents) => {
      let sum = 0;
      for (const e of ents) {
        const q = path.join(p, e.name);
        if (e.isDirectory()) sum += await sizeOf(q);
        else sum += (await fs.stat(q)).size;
      }
      return sum;
    })
    .catch(() => 0);
}

const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

async function main() {
  let ents = [];
  try {
    ents = await fs.readdir(CACHE, { withFileTypes: true });
  } catch {
    console.log('没有 cache/ 目录，无需清理');
    return;
  }

  const before = await sizeOf(CACHE);
  const kills = [];
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    if (TEMP_DIR.test(e.name)) kills.push({ name: e.name, why: '临时浏览器 profile' });
    else if (e.name === 'audit' && all) kills.push({ name: e.name, why: '截图目录（--all）' });
  }
  if (keepDays != null) {
    // 只清 audit/ 里超期的单文件，不动整目录
    const dir = path.join(CACHE, 'audit');
    const cutoff = Date.now() - keepDays * 86400 * 1000;
    const files = await fs.readdir(dir).catch(() => []);
    for (const f of files) {
      const abs = path.join(dir, f);
      const st = await fs.stat(abs).catch(() => null);
      if (st && st.mtimeMs < cutoff) kills.push({ name: 'audit/' + f, why: `早于 ${keepDays} 天`, file: abs });
    }
  }

  if (!kills.length) {
    console.log(`cache/ 很干净（${mb(before)}），没有要清的`);
    return;
  }

  console.log(`cache/ 当前 ${mb(before)}，待清理 ${kills.length} 项：`);
  for (const k of kills) {
    const abs = k.file || path.join(CACHE, k.name);
    const s = await sizeOf(abs);
    console.log(`  ${dry ? '[dry] ' : ''}${k.name}  ${s ? mb(s) : ''}  — ${k.why}`);
    if (!dry) await fs.rm(abs, { recursive: true, force: true }).catch(() => {});
  }

  if (dry) {
    console.log('\n（--dry-run，没有真的删）');
    return;
  }
  const after = await sizeOf(CACHE);
  console.log(`\ncache/ ${mb(before)} → ${mb(after)}，释放 ${mb(Math.max(0, before - after))}`);
}

await main();
