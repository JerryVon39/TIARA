/**
 * lib/season-cache.mjs — 本季番剧表的本地缓存（零依赖）
 *
 * 为什么缓存：整季 167 部要拉 4 页，慢且没必要每次都拉；断网时还得能看上次的表。
 * 随包目录在 assets/season-catalog，在线更新在 data/season。
 * 当季和未来两季每 12 小时可检查更新，已核验的历史季适用独立的保留规则。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './atomic.mjs';

export const TTL_MS = 12 * 3600 * 1000;
export const FIRST_CATALOG_SEASON = '2019Q1';
export const CATALOG_DIRECTORY = 'assets/season-catalog';
const CHECK_DELAY_MS = 14 * 86400_000;

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

function validSeasonItems(items) {
  if (!Array.isArray(items)) return false;
  const ids = new Set();
  for (const item of items) {
    const id = item?.id;
    const valid = typeof id === 'string' ? id.trim() !== '' : Number.isSafeInteger(id) && id > 0;
    if (!valid) return false;
    const key = String(id).trim();
    if (ids.has(key)) return false;
    ids.add(key);
  }
  return true;
}

/** @returns {Promise<{q:string,items:Array,fetched_at:string,stale:boolean,age_ms:number|null}|null>} */
async function readSnapshot(file, q) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    return data?.q === q && validSeasonItems(data.items) ? data : null;
  } catch {
    return null;
  }
}

export function mergeSeasonCatalog(builtin, fresh) {
  const rows = new Map(builtin.items.map(item => [String(item.id), item]));
  for (const item of fresh.items) {
    const id = String(item.id);
    const seed = rows.get(id);
    rows.set(id, seed ? {
      ...seed, ...item,
      date: item.date || seed.date || '',
      image: item.image || seed.image || null,
      weekday: item.time_cst ? item.weekday : seed.weekday || item.weekday || null,
      time_cst: item.time_cst || seed.time_cst || null,
      broadcast_end: item.broadcast_end || seed.broadcast_end || null,
    } : item);
  }
  const items = [...rows.values()].sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')));
  return { ...fresh, items, total: items.length };
}

function withAge(data) {
  const ts = Date.parse(data.fetched_at || '');
  const age = Number.isFinite(ts) ? Date.now() - ts : null;
  return { ...data, age_ms: age, stale: hasPartialRows(data) || age == null || age > TTL_MS };
}

const hasPartialRows = data => Array.isArray(data.items) && Number.isSafeInteger(data.total) && data.total !== data.items.length;

function catalogSnapshot(data, source) {
  return { source, count: data.items.length, fetched_at: data.fetched_at || null,
    verified_at: hasPartialRows(data) ? null : data.verified_at || null };
}

export async function readSeasonCache(root, q) {
  if (seasonIndex(q) == null) return null;
  const hit = MEM.get(memKey(root, q));
  if (hit && Date.now() - hit.at < MEM_TTL) return withAge(hit.data);
  const [saved, seed] = await Promise.all([
    readSnapshot(path.join(root, seasonCacheRel(q)), q),
    readSnapshot(path.join(root, CATALOG_DIRECTORY, `${q}.json`), q),
  ]);
  const builtin = seed && seed.total === seed.items.length ? seed : null;
  const unusableDownload = builtin && saved && (hasPartialRows(saved) || !saved.items.length);
  const online = unusableDownload ? null : saved;
  if (!builtin && !online) return null;
  let data = builtin && online ? mergeSeasonCatalog(builtin, online) :
    builtin ? { ...builtin, built_in: true } : online;
  if (!data.verified_at && builtin?.verified_at) data = { ...data, verified_at: builtin.verified_at, verified_source: builtin.source };

  const downloadedIds = new Set((online?.items || []).map(item => String(item.id)));
  const retained = builtin && online ? builtin.items.map(item => String(item.id)).filter(id => !downloadedIds.has(id)) : [];
  data = { ...data, catalog_sources: {
    builtin: builtin ? catalogSnapshot(builtin, builtin.source || '内置目录') : null,
    downloaded: online ? catalogSnapshot(online, online.catalog_source || online.verified_source || 'Bangumi API') : null,
    retained_ids: retained,
  } };
  MEM.set(memKey(root, q), { data, at: Date.now() });
  return withAge(data);
}

/** 写缓存及季末核验时间，再清理生效区间之外的临时缓存。 */
export async function writeSeasonCache(root, payload) {
  if (seasonIndex(payload?.q) == null) throw new Error('季度编号不正确');
  if (!validSeasonItems(payload.items)) throw new Error('季度目录条目不完整或重复，无法更新缓存');
  if (Number.isSafeInteger(payload.total) && payload.total !== payload.items.length)
    throw new Error('季度目录未完整读取，无法更新缓存');
  const rel = seasonCacheRel(payload.q);
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const now = new Date();
  const fetched_at = now.toISOString();
  const checked = payload.q >= FIRST_CATALOG_SEASON && payload.items.length > 0 && now.getTime() >= seasonVerificationTime(payload.q);
  const data = { ...payload, fetched_at, ...(checked ? { verified_at: fetched_at, verified_source: payload.catalog_source || 'Bangumi API' } : {}) };
  await writeFileAtomic(abs, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8' });
  MEM.delete(memKey(root, payload.q));
  const pruned = await pruneSeasonCache(root, payload.q).catch(() => []);
  return { path: rel, fetched_at, pruned };
}

/** 季度 → 从 2000Q1 起算的绝对序号，方便算「差几季」 */
function seasonIndex(q) {
  const m = /^(\d{4})Q([1-4])$/.exec(String(q || ''));
  if (!m) return null;
  return Number(m[1]) * 4 + (Number(m[2]) - 1);
}

export function shiftSeason(q, amount) {
  const index = seasonIndex(q) + amount;
  return `${Math.floor(index / 4)}Q${index % 4 + 1}`;
}

function seasonVerificationTime(q) {
  const next = seasonIndex(q) + 1;
  return Date.UTC(Math.floor(next / 4), (next % 4) * 3, 1) - 8 * 3600_000 + CHECK_DELAY_MS;
}

export function seasonRefreshState(q, cached, now = new Date()) {
  const distance = seasonIndex(q) - seasonIndex(currentSeason(now));
  const cutoff = seasonVerificationTime(q);
  const verified = Date.parse(cached?.verified_at || '');
  const fetched = Date.parse(cached?.fetched_at || '');
  if (distance < 0) {
    if (cached && !hasPartialRows(cached) && verified >= cutoff && verified <= now.getTime()) return { status: 'verified', due: false };
    return { status: 'pending', due: q >= FIRST_CATALOG_SEASON && now.getTime() >= cutoff };
  }
  return { status: distance === 0 ? 'current' : 'preview',
    due: distance <= 2 && (!cached || hasPartialRows(cached) || !Number.isFinite(fetched) || now.getTime() - fetched >= TTL_MS) };
}

export const KEEP_SPAN = 3;

/**
 * 保留已核验的季度，并保留「当前季」和「刚写入的那一季」前后各 KEEP_SPAN 个季度。
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
      const saved = await readSnapshot(path.join(dir, f), q);
      if (saved?.total === saved?.items.length && seasonRefreshState(q, saved, now).status === 'verified') continue;
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
export async function findSeasonRelocations(root, q, retained) {
  if (!retained?.length) return {};
  const wanted = new Set(retained);
  const folder = path.join(root, 'data', 'season');
  const files = await fs.readdir(folder).catch(() => []);
  const candidates = await Promise.all(files.filter(name => /^\d{4}Q[1-4]\.json$/.test(name) && name !== q + '.json')
    .map(name => readSnapshot(path.join(folder, name), name.slice(0, -5))));
  const moved = new Map();
  for (const data of candidates.filter(snapshot => snapshot && snapshot.total === snapshot.items.length)
    .sort((a, b) => String(b.fetched_at || '').localeCompare(String(a.fetched_at || '')))) {
    for (const item of data.items) {
      const id = String(item.id);
      if (!wanted.has(id) || moved.has(id) || !/^\d{4}-\d{2}-\d{2}$/.test(item.date || '')) continue;
      const [year, month] = item.date.split('-');
      if (year + 'Q' + Math.ceil(Number(month) / 3) === data.q) moved.set(id, data.q);
    }
  }
  return Object.fromEntries(moved);
}

export async function listCachedSeasons(root) {
  const dirs = ['data/season', CATALOG_DIRECTORY];
  const all = await Promise.all(dirs.map(dir => fs.readdir(path.join(root, dir)).catch(() => [])));
  const seasons = all.flat().filter(f => /^\d{4}Q[1-4]\.json$/.test(f)).map(f => f.slice(0, -5));
  return [...new Set(seasons)].sort().reverse();
}
