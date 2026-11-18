#!/usr/bin/env node
// 按日快照：把 data/ 里「丢了会心疼」的几份文件各存一份到 data/backups/YYYY-MM-DD/。
// 一天只做一次（已存在就跳过），默认保留 14 天。
// 用法：node tools/snapshot_daily.mjs [--force] [--keep 14] [--dry-run] [--json]
import { readFileSync, mkdirSync, existsSync, readdirSync, rmSync, lstatSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic, writeJsonAtomic } from '../lib/atomic.mjs';
import { redactCredentials } from '../lib/migration.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DAILY_BACKUP_KEEP = 14;
export const DAILY_HISTORY_TAIL = 800;
export const DAILY_BACKUP_NAME = /^\d{4}-\d{2}-\d{2}$/;

/** 要留底的文件：源路径 → 快照里的文件名（history 只留尾部，别越滚越大） */
const FILES = [
  ['library.json', 'library.json'],
  ['settings.json', 'settings.json'],
  ['state.json', 'state.json'],
];
const HISTORY = 'history.jsonl';

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
export async function snapshot(opts = {}) {
  const DATA = join(opts.root || ROOT, 'data');
  const BK = join(DATA, 'backups');
  const day = opts.dir && opts.dir !== 'auto' ? opts.dir : todayCst();
  if (!DAILY_BACKUP_NAME.test(day)) throw new Error('快照日期格式无效');
  const target = join(BK, day);
  const keep = Number.isInteger(opts.keep) && opts.keep > 0 ? opts.keep : DAILY_BACKUP_KEEP;
  const res = { ok: true, dir: target, wrote: [], skipped: [], pruned: [] };
  const existed = existsSync(target);
  if (existed && !lstatSync(target).isDirectory()) throw new Error('同名快照路径不是目录');
  if (existed && !opts.force) {
    res.skipped.push('今天已经快照过了（' + day + '）');
    return res;
  }
  if (!opts.dryRun) mkdirSync(target, { recursive: true });

  for (const [src, name] of FILES) {
    const p = join(DATA, src);
    if (!existsSync(p)) { res.skipped.push(src + '（没有）'); continue; }
    try {
      const value = redactCredentials(JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')));
      if (!opts.dryRun) await writeJsonAtomic(join(target, name), value);
      res.wrote.push(name);
    } catch (error) {
      res.skipped.push(name + '（无法备份：' + error.message + '）');
    }
  }

  const hp = join(DATA, HISTORY);
  if (existsSync(hp)) {
    const lines = readFileSync(hp, 'utf8').split('\n').filter(Boolean);
    const tail = lines.slice(-DAILY_HISTORY_TAIL).flatMap(line => {
      try { return [JSON.stringify(redactCredentials(JSON.parse(line.replace(/^\uFEFF/, ''))))]; }
      catch { return []; }
    });
    if (!opts.dryRun) await writeFileAtomic(join(target, HISTORY), tail.join('\n') + (tail.length ? '\n' : ''));
    res.wrote.push(`${HISTORY}（尾 ${tail.length} 行 / 共 ${lines.length}）`);
  }

  // 只保留最近 keep 天（按目录名字典序即时间序）
  const days = snapshotInfo(opts.root).days;
  const drop = days.slice(0, Math.max(0, days.length - keep));
  for (const d of drop) {
    const directory = join(BK, d);
    if (!opts.dryRun && dirname(realpathSync(directory)) === realpathSync(BK))
      rmSync(directory, { recursive: true, force: true });
    res.pruned.push(d);
  }
  return res;
}

/** 最近一次快照的日期（没有就 null）+ 有几天 */
export function snapshotInfo(root = ROOT) {
  const BK = join(root, 'data', 'backups');
  if (!existsSync(BK)) return { days: [], latest: null };
  const days = readdirSync(BK, { withFileTypes: true }).filter(entry =>
    entry.isDirectory() && DAILY_BACKUP_NAME.test(entry.name)).map(entry => entry.name).sort();
  return { days, latest: days.length ? days[days.length - 1] : null };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/snapshot_daily.mjs')) {
  const keepArg = process.argv.indexOf('--keep');
  const res = await snapshot({
    force: process.argv.includes('--force'),
    dryRun: process.argv.includes('--dry-run'),
    keep: keepArg > 0 ? Number(process.argv[keepArg + 1]) : DAILY_BACKUP_KEEP,
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
