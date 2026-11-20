import fs from 'node:fs/promises';
import path from 'node:path';
import { getJson } from './bgm.mjs';
import { writeJsonAtomic } from './atomic.mjs';
import { MAX_EPISODE } from './watch-episodes.mjs';
import { broadcastDate } from './broadcast-status.mjs';

const cacheFile = (root, id) => path.join(root, 'cache', 'bgm', 'episodes', id + '.json');
const pending = new Map();
export async function readEpisodeCatalog(root, id) {
  const saved = await fs.readFile(cacheFile(root, id), 'utf8').then(JSON.parse).catch(() => null);
  if (!Array.isArray(saved?.items) || !saved.items.every(chapter =>
    Number.isInteger(chapter?.number) && chapter.number >= 1 && chapter.number <= MAX_EPISODE &&
    (chapter.title == null || typeof chapter.title === 'string'))) return null;
  return new Set(saved.items.map(chapter => chapter.number)).size === saved.items.length ? saved : null;
}

export async function refreshEpisodeCatalog(root, id, { base, proxy }) {
  const key = cacheFile(root, id);
  if (pending.has(key)) return pending.get(key);
  const job = (async () => {
    const items = new Map();
    const limit = 100;
    for (let offset = 0; offset < MAX_EPISODE;) {
      const url = new URL('/v0/episodes', base || 'https://api.bgm.tv');
      url.search = new URLSearchParams({ subject_id: id, type: '0', limit: String(limit), offset: String(offset) });
      const page = await getJson(url.href, { proxy, timeoutMs: 7000, retries: 0 });
      if (!Array.isArray(page?.data) || page.data.length > limit)
        throw new Error('章节格式有误');
      if (!page.data.length && Number(page.total) > offset) throw new Error('章节未读完整');
      for (const item of page.data) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('章节条目格式有误');
        const n = item.ep ?? item.sort;
        if (item.type != null && item.type !== 0 || !Number.isInteger(n) || n < 1 || n > MAX_EPISODE) continue;
        const airdate = broadcastDate(item.airdate);
        items.set(n, { number: n, title: String(item.name_cn || item.name || '').slice(0, 160),
          ...(airdate ? { airdate } : {}) });
      }
      offset += page.data.length;
      if (!page.data.length || (Number.isInteger(page.total) ? offset >= page.total : page.data.length < limit)) {
        const saved = { fetched_at: new Date().toISOString(), items: [...items.values()].sort((a, b) => a.number - b.number) };
        await writeJsonAtomic(key, saved).catch(() => {});
        return saved;
      }
    }
    throw new Error('章节超出可读取范围');
  })();
  pending.set(key, job);
  try { return await job; } finally { pending.delete(key); }
}
