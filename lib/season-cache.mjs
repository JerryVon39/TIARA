/**
 * lib/season-cache.mjs — 本季番剧表的本地缓存（零依赖）
 *
 * 为什么缓存：整季 167 部要拉 4 页，慢且没必要每次都拉；断网时还得能看上次的表。
 * 存放：data/season/<季度>.json，形如 {q, from, to, total, items:[…], fetched_at}
 * 过期：12 小时。过期后 GET /api/season 仍会先用旧数据兜底，再在后台刷新。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './atomic.mjs';

export const TTL_MS = 12 * 3600 * 1000;

/**
 * 进程内的第二层缓存：一个季度的 JSON 有 200+ 条、约 200 KB，
 * 每次请求都 readFile + JSON.parse 大概 8–15 ms；面板切来切去时这部分白花的。
 * 写缓存时同步刷新，所以不会读到旧数据。
 */
const MEM = new Map();      // `${root}|${q}` -> { data, at }
const MEM_TTL = 10 * 60 * 1000;

/** 内存层的 key：必须带 root，否则两个数据目录（比如单测的临时目录）会互相串味 */
const memKey = (root, q) => `${root}|${q}`;

export function seasonCacheRel(q) {
  return `data/season/${q}.json`;
}

/** 只给预取用：库里有没有这个季度的缓存（不读文件内容） */
export async function hasSeasonCache(root, q) {
  if (MEM.has(memKey(root, q))) return true;
  try {
    await fs.access(path.join(root, seasonCacheRel(q)));
    return true;
  } catch {
    return false;
  }
}

/** @returns {Promise<{q:string,items:Array,fetched_at:string,stale:boolean,age_ms:number|null}|null>} */
export async function readSeasonCache(root, q) {
  const hit = MEM.get(memKey(root, q));
  if (hit && Date.now() - hit.at < MEM_TTL) return hit.data;
  try {
    const raw = await fs.readFile(path.join(root, seasonCacheRel(q)), 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.items)) return null;
    const ts = Date.parse(data.fetched_at || '');
    const age = Number.isFinite(ts) ? Date.now() - ts : null;
    const out = { ...data, age_ms: age, stale: age == null ? true : age > TTL_MS };
    MEM.set(memKey(root, q), { data: out, at: Date.now() });
    return out;
  } catch {
    return null;
  }
}

/** 写缓存（带 fetched_at）；写完顺手把「当前季 ±KEEP_SPAN 季」之外的旧季度删掉 */
export async function writeSeasonCache(root, payload) {
  const rel = seasonCacheRel(payload.q);
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const data = { ...payload, fetched_at: new Date().toISOString() };
  await writeFileAtomic(abs, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8' });
  MEM.set(memKey(root, payload.q), {
    data: { ...data, age_ms: 0, stale: false },
    at: Date.now(),
  });
  const pruned = await pruneSeasonCache(root, payload.q).catch(() => []);
  return { path: rel, fetched_at: data.fetched_at, pruned };
}

/** 季度 → 从 2000Q1 起算的绝对序号，方便算「差几季」 */
function seasonIndex(q) {
  const m = /^(\d{4})Q([1-4])$/.exec(String(q || ''));
  if (!m) return null;
  return Number(m[1]) * 4 + (Number(m[2]) - 1);
}

export const KEEP_SPAN = 3;

/**
 * 只保留「当前季」和「刚写入的那一季」前后各 KEEP_SPAN 个季度。
 *
 * 以前只用刚写入的季度当基准：写 2018Q1（翻老番表）会把 2026Q3/Q4 一起删掉——
 * 用户翻一次十年前的表，回到当前季就得重新拉网。现在两个基准取并集，
 * 既保证刚写的文件不会被自己删掉，也不会让「点过的季度」无限堆下去。
 * @returns {Promise<string[]>} 被删掉的季度
 */
export async function pruneSeasonCache(root, baseQ, now = new Date()) {
  const bases = [seasonIndex(baseQ), seasonIndex(currentSeason(now))].filter((x) => x != null);
  if (!bases.length) return [];
  const dir = path.join(root, 'data', 'season');
  let files = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => /^\d{4}Q[1-4]\.json$/.test(f));
  } catch {
    return [];
  }
  const dropped = [];
  for (const f of files) {
    const q = f.replace('.json', '');
    const idx = seasonIndex(q);
    if (idx == null) continue;
    const keep = bases.some((b) => Math.abs(idx - b) <= KEEP_SPAN);
    if (keep) continue;
    try {
      await fs.rm(path.join(dir, f), { force: true });
      MEM.delete(memKey(root, q));
      dropped.push(q);
    } catch { /* 删不掉就算了，下次再删 */ }
  }
  return dropped.sort();
}

/** 当前季（'2026Q4'）；用 UTC+8 判断，和项目其它地方的 CST 口径一致 */
export function currentSeason(now = new Date()) {
  const t = new Date(now.getTime() + 8 * 3600e3);
  const q = Math.floor(t.getUTCMonth() / 3) + 1;
  return `${t.getUTCFullYear()}Q${q}`;
}

/** 所有已缓存的季度（新的在前） */
export async function listCachedSeasons(root) {
  try {
    const dir = path.join(root, 'data', 'season');
    const files = (await fs.readdir(dir)).filter((f) => /^\d{4}Q[1-4]\.json$/.test(f));
    return files.map((f) => f.replace('.json', '')).sort().reverse();
  } catch {
    return [];
  }
}
