#!/usr/bin/env node
// 按日快照：把 data/ 里「丢了会心疼」的几份文件各存一份到 data/backups/YYYY-MM-DD/。
// 一天只做一次（已存在就跳过），默认保留 14 天。
// 用法：node tools/snapshot_daily.mjs [--force] [--keep 14] [--dry-run] [--json]
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const BK = join(DATA, 'backups');

/** 要留底的文件：源路径 → 快照里的文件名（history 只留尾部，别越滚越大） */
const FILES = [
  ['library.json', 'library.json'],
  ['settings.json', 'settings.json'],
  ['state.json', 'state.json'],
  ['bgm.json', 'bgm.json'],
];
const HISTORY = 'history.jsonl';
const HISTORY_TAIL = 800;

function pad(n) { return String(n).padStart(2, '0'); }
function todayCst() {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * 做一次快照。
 * @param {object} opts {dir: 'YYYY-MM-DD'|'auto', force:boolean, keep:number, dryRun:boolean}
 * @returns {{ok:boolean, dir:string, wrote:string[], skipped:string[], pruned:string[]}}
 */
export function snapshot(opts = {}) {
  const DATA = join(opts.root || ROOT, 'data');
  const BK = join(DATA, 'backups');
  const day = opts.dir && opts.dir !== 'auto' ? opts.dir : todayCst();
  const target = join(BK, day);
  const keep = Number.isFinite(opts.keep) ? opts.keep : 14;
  const res = { ok: true, dir: target, wrote: [], skipped: [], pruned: [] };
  const existed = existsSync(target);
  if (existed && !opts.force) {
    res.skipped.push('今天已经快照过了（' + day + '）');
    return res;
  }
  if (!opts.dryRun) mkdirSync(target, { recursive: true });

  for (const [src, name] of FILES) {
    const p = join(DATA, src);
    if (!existsSync(p)) { res.skipped.push(src + '（没有）'); continue; }
    if (!opts.dryRun) writeFileSync(join(target, name), readFileSync(p));
    res.wrote.push(name);
  }

  const hp = join(DATA, HISTORY);
  if (existsSync(hp)) {
    const lines = readFileSync(hp, 'utf8').split('\n').filter(Boolean);
    const tail = lines.slice(-HISTORY_TAIL);
    if (!opts.dryRun) writeFileSync(join(target, HISTORY), tail.join('\n') + (tail.length ? '\n' : ''), 'utf8');
    res.wrote.push(`${HISTORY}（尾 ${tail.length} 行 / 共 ${lines.length}）`);
  }

  // 只保留最近 keep 天（按目录名字典序即时间序）
  const days = (existsSync(BK) ? readdirSync(BK) : []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const drop = days.slice(0, Math.max(0, days.length - keep));
  for (const d of drop) {
    if (!opts.dryRun) rmSync(join(BK, d), { recursive: true, force: true });
    res.pruned.push(d);
  }
  return res;
}

/** 最近一次快照的日期（没有就 null）+ 有几天 */
export function snapshotInfo() {
  if (!existsSync(BK)) return { days: [], latest: null };
  const days = readdirSync(BK).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return { days, latest: days.length ? days[days.length - 1] : null };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/snapshot_daily.mjs')) {
  const keepArg = process.argv.indexOf('--keep');
  const res = snapshot({
    force: process.argv.includes('--force'),
    dryRun: process.argv.includes('--dry-run'),
    keep: keepArg > 0 ? Number(process.argv[keepArg + 1]) : 14,
  });
  if (process.argv.includes('--json')) console.log(JSON.stringify(res, null, 2));
  else if (res.skipped.length === 1 && !res.wrote.length) console.log('· ' + res.skipped[0]);
  else {
    console.log(`→ ${res.dir}`);
    for (const w of res.wrote) console.log('  写 ' + w);
    for (const s of res.skipped) console.log('  略 ' + s);
    if (res.pruned.length) console.log('  清旧快照：' + res.pruned.join('、'));
  }
  const info = snapshotInfo();
  if (!process.argv.includes('--json')) console.log(`（现有 ${info.days.length} 天快照，最新 ${info.latest || '无'}）`);
}
