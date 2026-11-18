import { watchFloor } from './watch-start.mjs';

export const MAX_EPISODE = 10000;
const ordinal = value => Number.isSafeInteger(value) && value > 0 && value <= MAX_EPISODE;
const ascending = (a, b) => a - b;

// ep_status remains the continuous prefix used by old builds and Bangumi.
// Only watched episodes above it need to be stored separately.
export function episodeCoverage(w) {
  const floor = watchFloor(w);
  const prefix = Math.max(floor, Number(w.ep_status) || 0);
  const extras = [...new Set(Array.isArray(w.episode_extras) ? w.episode_extras : [])]
    .filter(n => ordinal(n) && n > prefix).sort(ascending);
  return { floor, prefix, extras, continuous: Number(w.ep_status) || 0, count: prefix - floor + extras.length };
}

export function episodeDiff(w, add, remove = []) {
  const { floor, prefix, extras } = episodeCoverage(w);
  if (prefix > MAX_EPISODE) return { error: '旧进度超出逐集记账范围，请先核对番剧资料' };
  const cap = Math.min(Number(w.eps) || MAX_EPISODE, MAX_EPISODE);
  const unique = [...new Set(add)];
  if (unique.some(n => !ordinal(n) || n > cap || n <= floor) || remove.some(n => !ordinal(n) || n <= floor))
    return { error: '集数不在本轮可观看范围内，请检查补番起点和总集数' };
  const current = new Set(extras);
  for (let n = floor + 1; n <= prefix; n++) current.add(n);
  const episodes_removed = [...new Set(remove)].filter(n => current.delete(n)).sort(ascending);
  const episodes_added = unique.filter(n => {
    if (current.has(n)) return false;
    current.add(n);
    return true;
  }).sort(ascending);
  let end = floor;
  while (current.has(end + 1)) end++;
  const episode_extras = [...current].filter(n => n > end).sort(ascending);
  return { from: Number(w.ep_status) || 0, to: end === floor ? 0 : end,
    before: prefix - floor + extras.length, after: current.size,
    episode_extras, episodes_added, episodes_removed,
    delta: episodes_added.length - episodes_removed.length };
}

export function quickEpisodeDiff(w, delta) {
  const { floor, prefix, extras } = episodeCoverage(w);
  const cap = Math.min(Number(w.eps) || MAX_EPISODE, MAX_EPISODE);
  if (prefix > MAX_EPISODE) return { error: '旧进度超出逐集记账范围，请先核对番剧资料' };
  const add = [], remove = [];
  if (delta > 0) {
    const watched = new Set(extras);
    for (let n = prefix + 1; add.length < delta && n <= cap; n++) if (!watched.has(n)) add.push(n);
  } else if (delta < 0) {
    const tail = extras.slice().reverse();
    for (const n of tail) {
      if (remove.length >= -delta) break;
      remove.push(n);
    }
    for (let n = prefix; remove.length < -delta && n > floor; n--) remove.push(n);
  }
  return episodeDiff(w, add, remove);
}

export function storeEpisodeDiff(w, result) {
  w.ep_status = result.to;
  w.episode_extras = result.episode_extras;
}

export const validEpisodeList = (value, max = 500) =>
  Array.isArray(value) && value.length > 0 && value.length <= max && value.every(ordinal) && new Set(value).size === value.length;

export function validEpisodeExtras(w) {
  const extras = w.episode_extras;
  if (extras === undefined) return true;
  return Array.isArray(extras) && (!extras.length || validEpisodeList(extras, MAX_EPISODE)) &&
    extras.every((n, i) => n > Math.max(watchFloor(w), Number(w.ep_status) || 0) + 1 &&
      (!Number(w.eps) || n <= Number(w.eps)) && (!i || n > extras[i - 1]));
}
