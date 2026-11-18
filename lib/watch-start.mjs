export const WATCH_STARTS = ['head', 'seen', 'latest'];

export function watchFloor(w) {
  return Math.max(0, (Number(w.start_episode) || 1) - 1);
}

export function remainingEpisodes(w, expected) {
  const end = Number(expected) || 0;
  const prefix = Math.max(Number(w.ep_status) || 0, watchFloor(w));
  const extras = Array.isArray(w.episode_extras) ? w.episode_extras.filter(n => n > prefix && n <= end).length : 0;
  return Math.max(0, end - prefix - extras);
}

export function applyWatchStart(w, mode, { seen = 0, latest } = {}) {
  if (mode == null) return true;
  if (!WATCH_STARTS.includes(mode)) return false;
  const limit = Number(w.eps) || Infinity;
  const value = mode === 'latest' ? latest : mode === 'seen' ? seen : 0;
  if (!Number.isSafeInteger(value) || value < (mode === 'latest' ? 1 : 0) || value > limit) return false;
  delete w.track_from;
  if (mode === 'latest') w.start_episode = value;
  w.ep_status = mode === 'seen' ? value : 0;
  return true;
}
