import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from './atomic.mjs';
import { fetchAnimeRelations } from './bgm.mjs';

const DAY = 86_400_000;
const PREQUELS = /前传|前作|前篇/;
const SEQUELS = /续集|续作|后传/;
const cachePath = (root, id) => path.join(root, 'cache', 'anime-relations', id + '.json');
export const relationId = id => typeof id === 'string' && /^[1-9]\d{0,9}$/.test(id);

export async function readRelationCache(root, id) {
  const cache = await readJsonFile(cachePath(root, id)).catch(() => null);
  return Array.isArray(cache?.rows) ? cache : null;
}

export async function animeRelations(root, id, config, refresh) {
  const cached = await readRelationCache(root, id);
  if (!refresh && cached && Date.now() - Date.parse(cached.fetched_at) < DAY)
    return { ...cached, source: 'cache' };
  let rows;
  try {
    rows = await fetchAnimeRelations(id, { base: config.base, proxy: config.proxy, timeoutMs: 5000, retries: 0 });
  } catch {
    return { ...(cached || { rows: [] }), source: 'offline' };
  }
  const result = { rows, fetched_at: new Date().toISOString() };
  try {
    await writeJsonAtomic(cachePath(root, id), result);
    return { ...result, source: 'bangumi' };
  } catch {
    return { ...result, source: 'temporary' };
  }
}

export function orderedRelations(entry, related) {
  const id = String(entry.id);
  const current = { id, name: entry.name_cn || entry.name || id, original: entry.name || '', relation: '当前番剧', current: true };
  const rows = related.filter(item => item.id !== id);
  const priority = item => PREQUELS.test(item.relation) ? 0 : item.current ? 1 : SEQUELS.test(item.relation) ? 2 : 3;
  const suggested = [current, ...rows].sort((a, b) => priority(a) - priority(b));
  const saved = new Set(Array.isArray(entry.watch_order) ? entry.watch_order : []);
  if (!saved.size) return suggested;
  const byId = new Map(suggested.map(row => [row.id, row]));
  return [...[...saved].map(id => byId.get(id)).filter(Boolean), ...suggested.filter(row => !saved.has(row.id))];
}

export function setWatchOrder(entry, cache, order) {
  if (!Array.isArray(order) || order.length > 101 || new Set(order).size !== order.length || !order.every(relationId))
    return { code: 400, error: '观看顺序中的条目编号无效' };
  if (order.length) {
    const available = new Set([String(entry.id), ...(cache?.rows || []).map(row => row.id)]);
    if (available.size < 2 || available.size !== order.length || !order.every(id => available.has(id)))
      return { code: 409, error: '关联条目已更新，请重新打开观看顺序后再保存' };
  }
  const changed = JSON.stringify(order) !== JSON.stringify(entry.watch_order || []);
  if (changed) {
    if (order.length) entry.watch_order = order;
    else delete entry.watch_order;
  }
  return { changed };
}
