import { watchFloor } from './watch-start.mjs';
import { episodeCoverage, episodeDiff, validEpisodeList } from './watch-episodes.mjs';

export const historyIdValid = id => typeof id === 'string' && /^[a-f\d]{32}$/.test(id);
const integer = n => Number.isSafeInteger(n) && n >= 0;
export const historyRetractions = lib => Array.isArray(lib.history_retractions) ? lib.history_retractions.filter(row =>
  row && historyIdValid(row.id) && historyIdValid(row.anchor) && typeof row.watch_id === 'string' &&
  integer(row.from) && integer(row.to) && (row.to < row.from || row.episode === true && row.to === row.from)) : [];

function exactRetraction(rows, entry, target, retractions) {
  const roundId = target.watch_mode === 'rewatch' ? target.rewatch_id : null;
  const round = roundId ? (entry.rewatches || []).find(item => item.id === roundId) : entry;
  if (!round || (target.watch_mode === 'rewatch' && !roundId)) return { error: '找不到这轮重看' };
  if (!roundId && entry.progress_edited_at && entry.progress_edited_at >= target.ts)
    return { error: '这条记录之后曾手动更正或同步进度，请在番剧详情核对' };
  const floor = watchFloor(round);
  function affected(row) {
    if (Array.isArray(row.episodes_added)) return { add: row.episodes_added, remove: row.episodes_removed || [] };
    if (!integer(row.from) || !integer(row.to) || row.source === 'absolute') return null;
    const start = Math.max(floor, Math.min(row.from, row.to));
    const count = Math.max(floor, row.from, row.to) - start;
    if (count > 10000 || Math.abs(row.delta) !== count) return null;
    const span = Array.from({ length: count }, (_, i) => start + i + 1);
    return row.delta > 0 ? { add: span, remove: [] } : { add: [], remove: span };
  }
  const additions = affected(target)?.add;
  if (!validEpisodeList(additions, 10000) || additions.length !== target.delta || !Number.isFinite(Date.parse(target.ts)))
    return { error: '不能核对这条记录对应的集数' };
  const ids = new Set(retractions.map(item => item.id));
  const wanted = new Set(additions);
  const index = rows.indexOf(target);
  const later = rows.slice(index + 1).filter(row => !ids.has(row.history_id));
  for (const row of later) {
    const activity = affected(row);
    if (!activity || [...activity.add, ...activity.remove].some(n => wanted.has(n)))
      return { error: '后续记录改动过相同集数，请先处理后续记录' };
  }
  if (!Array.isArray(target.episodes_added) && retractions.some(item => item.episode !== true &&
      rows.slice(index).some(row => row.history_id === item.anchor))) return { error: '中间曾按连续进度撤销，请在详情核对后再改' };
  const diff = episodeDiff(round, [], additions);
  if (diff.error || diff.episodes_removed.length !== additions.length) return { error: '有些集数已经不在当前进度里' };
  const finish = roundId && (round.eps ? diff.to >= round.eps : diff.after > 0 && round.finished_at);
  if (roundId && !finish && round.finished_at && (entry.rewatches || []).some(item => item !== round && !item.finished_at))
    return { error: '已有一轮重看在进行，请完成该轮后再更正已结束的重看' };
  const surviving = rows.filter(row => row !== target && row.delta > 0 && !ids.has(row.history_id) && row.source !== 'absolute')
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.ts || '').localeCompare(String(a.ts || '')));
  const last = surviving[0];
  const baseline = rows[0]?.prior_last_watched || null;
  return { ...diff, episode: true, roundId, episodes: additions, keepsFinished: !!finish, later: later.length,
    lastDate: last && (!baseline || last.date >= baseline) ? last.date : baseline,
    lastAt: last && (!baseline || last.date >= baseline) ? last.ts : null, anchor: target.history_id };
}

export function retraceHistory(rows, found, target, retractions) {
  // Keep the JSONL rows immutable. A persisted adjustment is replayed after the row
  // that was latest when the adjustment was applied, before subsequent writes.
  const entry = found.entry;
  const id = String(entry.id);
  const round = target.watch_mode === 'rewatch' ? target.rewatch_id : null;
  const same = rows.filter(row => String(row.id) === id && Number.isFinite(row.delta) &&
    (round ? row.rewatch_id === round : row.watch_mode !== 'rewatch') &&
    row.event !== 'season' && row.action !== 'season').sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  const adjustments = retractions.filter(row => row.watch_id === id);
  if (target.source === 'absolute' || !integer(target.delta) || target.delta === 0 ||
    !Number.isFinite(Date.parse(target.ts)) || !integer(target.from) || !integer(target.to)) {
    return { error: '这条记录属于进度调整或缺少连续观看数据，无法单独撤销' };
  }
  if (target.watch_mode === 'rewatch' || Array.isArray(entry.episode_extras) || Array.isArray(target.episodes_added))
    return exactRetraction(same, entry, target, adjustments);
  if (entry.progress_edited_at && entry.progress_edited_at >= target.ts)
    return { error: '这条记录之后曾手动更正或同步进度，请在番剧详情核对' };
  const index = same.indexOf(target);
  if (index < 0) return { error: '找不到对应的观看记录' };
  const later = same.slice(index);
  const cutoff = '之后的观看进度无法连续核对，请在番剧详情确认';
  const floor = watchFloor(entry);
  const byAnchor = new Map();
  for (const item of adjustments) {
    if (!byAnchor.has(item.anchor)) byAnchor.set(item.anchor, []);
    byAnchor.get(item.anchor).push(item);
  }
  let progress = target.from;
  for (const row of later) {
    if (!historyIdValid(row.history_id) || row.source === 'absolute' || row.watch_mode === 'rewatch' ||
      progress !== row.from || !integer(row.to) || !Number.isFinite(Date.parse(row.ts))) return { error: cutoff };
    progress = row.to;
    for (const correction of byAnchor.get(row.history_id) || []) {
      if (correction.from !== progress) return { error: cutoff };
      progress = correction.to;
    }
    if (Math.max(progress, floor) - target.delta < floor) return { error: '后续记录已退回这段进度，无法重复扣减' };
  }
  if (progress !== (Number(entry.ep_status) || 0)) return { error: cutoff };
  const remaining = Math.max(progress, floor) - target.delta;
  const next = remaining === floor ? 0 : remaining;
  if (Number(entry.eps) > 0 && next > Number(entry.eps)) return { error: cutoff };
  const removed = new Set(adjustments.map(row => row.id));
  const surviving = same.filter(row => row !== target && row.delta > 0 && !removed.has(row.history_id));
  const latest = surviving.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) ||
    String(b.ts || '').localeCompare(String(a.ts || '')))[0];
  const baseline = same[0]?.prior_last_watched || null;
  const lastDate = entry.last_watched > target.date ? entry.last_watched :
    latest && (!baseline || latest.date >= baseline) ? latest.date : baseline;
  const lastAt = entry.last_watched > target.date ? entry.last_watched_at || null : lastDate === latest?.date ? latest.ts : null;
  return { to: next, from: progress, later: later.slice(1).filter(row => !removed.has(row.history_id)).length,
    lastDate, lastAt, anchor: later.at(-1).history_id };
}
