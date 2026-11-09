import { getJson } from './bgm.mjs';
import { cstParts } from './today.mjs';
import { nextWeeklyUpdate } from './watch-schedule.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from './atomic.mjs';

// Public CC BY 4.0 dataset, documented at github.com/bangumi-data/bangumi-data.
// Download is independent of the user's search text; matching runs locally.
const URL = 'https://cdn.jsdelivr.net/npm/bangumi-data@0.3/dist/data.json';
const TTL = 6 * 3600000;
const caches = new Map();

async function load(root, proxy, online) {
  let state = caches.get(root);
  if (!state) {
    state = {};
    caches.set(root, state);
  }
  const file = path.join(root, 'cache', 'bgm', 'broadcast.json');
  if (!state.cache) {
    const saved = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
    if (Array.isArray(saved?.items)) state.cache ||= saved;
  }
  if (!online || state.cache && Date.now() - state.cache.at < TTL) return state.cache;
  state.pending ||= getJson(process.env.BGM_BROADCAST_URL || URL, { timeoutMs: 7000, retries: 0, proxy }).then(async data => {
    if (!Array.isArray(data?.items)) throw new Error('排期数据格式不正确');
    state.cache = { at: Date.now(), items: data.items, siteMeta: data.siteMeta || {} };
    await fs.mkdir(path.dirname(file), { recursive: true }).then(() => writeJsonAtomic(file, state.cache)).catch(() => {});
    return state.cache;
  }).catch(error => {
    if (state.cache) return state.cache;
    throw error;
  }).finally(() => { state.pending = null; });
  return state.pending;
}

const normalized = s => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const pad = n => String(n).padStart(2, '0');

function weekly(raw, end, now) {
  const airing = /^R\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\/P7D$/.exec(raw || '');
  if (!airing || Date.parse(end) < +now) return null;
  const at = new Date(airing[1]);
  if (!Number.isFinite(+at)) return null;
  const time = cstParts(at);
  const clock = `${pad(time.hour)}:${pad(time.minute)}`;
  const next = nextWeeklyUpdate(time.weekday, clock, now, time.date);
  if (Date.parse(next) > Date.parse(end)) return null;
  return { since: time.date, weekday: time.weekday, time_cst: clock, next };
}

export function matchBroadcasts(items, { name = '', id = '', now = new Date(), siteMeta = {}, includePlatforms = false } = {}) {
  const query = normalized(name);
  if (!id && !query) return [];
  const matches = [];
  for (const item of items) {
    if (typeof item?.title !== 'string') continue;
    const site = Array.isArray(item.sites) && item.sites.find(x => x?.site === 'bangumi');
    const subject = /^\d{1,10}$/.test(String(site?.id ?? '')) ? String(site.id) : '';
    const aliases = Object.values(item.titleTranslate || {}).flat().filter(s => typeof s === 'string');
    const names = [item.title, ...aliases].map(normalized);
    let score = 0;
    if (id) score = subject === id ? 3 : 0;
    else if (names.includes(query)) score = 2;
    else if (query.length >= 2 && names.some(s => s.includes(query))) score = 1;
    if (!score) continue;

    const translated = item.titleTranslate?.['zh-Hans'];
    const cn = Array.isArray(translated) ? translated.find(s => typeof s === 'string' && s.trim()) : '';
    const base = { score, name: cn || item.title, original_name: item.title, subject };
    const original = weekly(item.broadcast, item.end, now);
    if (original) matches.push({ ...base, ...original, source: 'bangumi-data 原播', platform: null, regions: [] });
    if (!includePlatforms) continue;
    for (const entry of item.sites || []) {
      const schedule = weekly(entry.broadcast, entry.end || item.end, now);
      if (!schedule || entry.site === 'bangumi') continue;
      const platform = siteMeta[entry.site]?.title || entry.site;
      matches.push({ ...base, ...schedule, source: 'bangumi-data · ' + platform, platform,
        regions: entry.regions || siteMeta[entry.site]?.regions || [] });
    }
  }
  return matches.sort((a, b) => b.score - a.score || Number(!!a.platform) - Number(!!b.platform) || b.since.localeCompare(a.since)).slice(0, 16)
    .map(({ score, ...candidate }) => candidate);
}

export async function lookupBroadcast(options) {
  const data = await load(options.root, options.proxy, true);
  return matchBroadcasts(data.items, { ...options, siteMeta: data.siteMeta, includePlatforms: true });
}

export async function broadcastSuggestions(root, ids, { proxy, online } = {}) {
  if (!ids.length) return {};
  const data = await load(root, proxy, online);
  if (!data) return {};
  const wanted = new Set(ids.map(String));
  const entries = new Map();
  for (const item of data.items) {
    for (const site of item.sites || []) {
      if (site.site !== 'bangumi' || !wanted.has(String(site.id))) continue;
      const id = String(site.id);
      if (!entries.has(id)) entries.set(id, []);
      entries.get(id).push(item);
    }
  }
  const out = {};
  for (const [id, items] of entries) {
    const candidates = matchBroadcasts(items, { id, siteMeta: data.siteMeta, includePlatforms: true });
    const regional = candidates.filter(candidate => candidate.platform && candidate.regions.includes('CN'));
    const match = regional.length === 1 ? regional[0] : candidates.find(candidate => !candidate.platform);
    if (match) out[id] = match;
  }
  return out;
}
