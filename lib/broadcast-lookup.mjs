import { getJson } from './bgm.mjs';
import { cstParts } from './today.mjs';

// Public CC BY 4.0 dataset, documented at github.com/bangumi-data/bangumi-data.
// Download is independent of the user's search text; matching runs locally.
const URL = 'https://cdn.jsdelivr.net/npm/bangumi-data@0.3/dist/data.json';
const TTL = 6 * 3600000;
let cache;
let pending;

async function load(proxy) {
  if (cache && Date.now() - cache.at < TTL) return cache.items;
  if (!pending) {
    pending = getJson(URL, { timeoutMs: 8500, retries: 0, proxy }).then(data => {
      if (!Array.isArray(data?.items)) throw new Error('排期数据格式不正确');
      cache = { at: Date.now(), items: data.items };
      return cache.items;
    }).finally(() => { pending = null; });
  }
  return pending;
}

const normalized = s => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const pad = n => String(n).padStart(2, '0');

export function matchBroadcasts(items, { name = '', id = '', now = new Date() } = {}) {
  const query = normalized(name);
  if (!id && !query) return [];
  const matches = [];
  for (const item of items) {
    if (typeof item?.title !== 'string') continue;
    const airing = /^R\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\/P7D$/.exec(item.broadcast || '');
    if (!airing || Date.parse(item.end) < now.getTime()) continue;
    const at = new Date(airing[1]);
    if (!Number.isFinite(+at)) continue;

    const site = Array.isArray(item.sites) && item.sites.find(x => x?.site === 'bangumi');
    const subject = /^\d{1,10}$/.test(String(site?.id ?? '')) ? String(site.id) : '';
    const aliases = Object.values(item.titleTranslate || {}).flat().filter(s => typeof s === 'string');
    const names = [item.title, ...aliases].map(normalized);
    let score = 0;
    if (id) score = subject === id ? 3 : 0;
    else if (names.includes(query)) score = 2;
    else if (query.length >= 2 && names.some(s => s.includes(query))) score = 1;
    if (!score) continue;

    const time = cstParts(at);
    const translated = item.titleTranslate?.['zh-Hans'];
    const cn = Array.isArray(translated) ? translated.find(s => typeof s === 'string' && s.trim()) : '';
    matches.push({ score, name: cn || item.title, original_name: item.title, subject,
      since: time.date, weekday: time.weekday, time_cst: `${pad(time.hour)}:${pad(time.minute)}` });
  }
  return matches.sort((a, b) => b.score - a.score || b.since.localeCompare(a.since)).slice(0, 8)
    .map(({ score, ...candidate }) => candidate);
}

export async function lookupBroadcast(options) {
  return matchBroadcasts(await load(options.proxy), options);
}
