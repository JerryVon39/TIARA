import { randomUUID } from 'node:crypto';
import { isWatchFinished } from './watch-lifecycle.mjs';
import { episodeCoverage, episodeDiff, quickEpisodeDiff, storeEpisodeDiff, validEpisodeList } from './watch-episodes.mjs';

export function firstWatchCompleted(entry, rows, owners) {
  if (entry.finished_at) return entry.finished_at;
  if (!isWatchFinished(entry) || !Number.isInteger(Number(entry.eps)) || Number(entry.eps) < 1) return null;
  return rows.filter(row => owners.get(String(row.id)) === entry && row.watch_mode !== 'rewatch' &&
    row.source !== 'absolute' && row.delta > 0 && row.to >= Number(entry.eps) && /^\d{4}-\d{2}-\d{2}$/.test(row.date || ''))
    .map(row => row.date).sort()[0] || null;
}

export function changeRewatch(found, input, day, now) {
  const entry = found.entry;
  const rounds = Array.isArray(entry.rewatches) ? entry.rewatches : [];
  const current = rounds.find(round => !round.finished_at);
  if (input.action === 'start') {
    if (current) return { error: '已有一轮重看在进行', code: 409 };
    if (found.state !== 'dropped' && !isWatchFinished(entry)) return { error: '看完或弃番后可另开一轮重看', code: 409 };
    const total = Number(entry.eps) || null;
    const round = { id: randomUUID(), started_at: now, eps: total, ep_status: 0, finished_at: null };
    entry.rewatches = [round, ...rounds];
    return { round };
  }
  if (!current || input.round_id !== current.id) return { error: '重看进度有变化，请重新打开详情', code: 409 };
  if (input.action === 'finish') {
    if (current.eps || !episodeCoverage(current).count) return { error: '这里只能完成已记录集数且总集数未知的重看', code: 409 };
    current.finished_at = day;
    return { round: current };
  }
  if (!['next', 'episodes'].includes(input.action)) return { error: '重看操作无效', code: 400 };
  if (input.action === 'episodes' && !validEpisodeList(input.episodes))
    return { error: '请选择 1–500 个互不重复的正片集数', code: 400 };
  const diff = input.action === 'episodes' ? episodeDiff(current, input.episodes) : quickEpisodeDiff(current, 1);
  if (diff.error) return { error: diff.error, code: 409 };
  if (!diff.delta) return { round: current, unchanged: true };
  storeEpisodeDiff(current, diff);
  if (current.eps && current.ep_status >= current.eps) current.finished_at = day;
  return { round: current, history: { from: diff.from, to: diff.to, delta: diff.delta, watch_mode: 'rewatch', rewatch_id: current.id,
    episodes_added: diff.episodes_added, episodes_removed: diff.episodes_removed } };
}
