export const WATCH_STATES = ['watching', 'paused', 'archived', 'planned', 'dropped', 'removed'];

export function findWatchEntry(lib, id) {
  if (id == null) return null;
  for (const state of WATCH_STATES) {
    const entries = lib[state] || [];
    const index = entries.findIndex(w => String(w.id) === String(id));
    if (index >= 0) return { state, index, entry: entries[index] };
  }
  return null;
}

export function inactiveWatchIds(lib) {
  return new Set(WATCH_STATES.slice(1).flatMap(state => (lib[state] || []).map(w => String(w.id))));
}

export function isWatchFinished(w) {
  const total = Number(w.eps);
  const seen = Number(w.ep_status);
  return w.manual_finished === true || (Number.isFinite(total) && total > 0 && Number.isFinite(seen) && seen >= total);
}

export const isCatchup = w => w.watch_mode === 'catchup';

/** Move the whole entry. The original weekly rows stay available for resuming. */
export function moveWatchEntry(lib, found, action, mode, note) {
  const { state, index, entry } = found;
  if (action === 'remove' && state !== 'removed') {
    entry.removed_from = state;
    entry.removed_at = new Date().toISOString();
    lib[state].splice(index, 1);
    (lib.removed ||= []).unshift(entry);
    return { state: 'removed', changed: true };
  }
  if (state === 'removed') {
    if (action !== 'restore') return { code: 409, error: '请先从「已移除」找回这部番' };
    const target = WATCH_STATES.slice(0, -1).includes(entry.removed_from) ? entry.removed_from : 'planned';
    delete entry.removed_from;
    delete entry.removed_at;
    lib.removed.splice(index, 1);
    (lib[target] ||= []).unshift(entry);
    return { state: target, changed: true };
  }
  if (state === 'planned') {
    if (action !== 'start' || !['airing', 'catchup'].includes(mode))
      return { code: 400, error: '请为待看番剧选择追连载或补番' };
    if (mode === 'catchup') entry.watch_mode = mode;
    else delete entry.watch_mode;
    entry.watch_mode_manual = true;
    lib.planned.splice(index, 1);
    lib.watching.unshift(entry);
    return { state: 'watching', changed: true };
  }
  if (action === 'drop') {
    if (state !== 'watching' && state !== 'paused') return { code: 409, error: '只有在追或暂停的未看完番剧可以标为弃番' };
    if (isWatchFinished(entry)) return { code: 409, error: '已经看完的番可以归档' };
    if (typeof note !== 'string' || note.length > 500) return { code: 400, error: '弃番备注最多 500 字' };
    entry.dropped_at = new Date().toISOString();
    entry.dropped_manually = true;
    if (note.trim()) entry.drop_note = note.trim();
    else delete entry.drop_note;
    lib[state].splice(index, 1);
    (lib.dropped ||= []).unshift(entry);
    return { state: 'dropped', changed: true };
  }
  if (state === 'dropped') {
    if (action !== 'resume') return { code: 409, error: '请先恢复追番' };
    delete entry.dropped_manually;
    delete entry.dropped_at;
  }
  if (action === 'finish' || action === 'unfinish') {
    if (state === 'archived') return { code: 409, error: '请先取消归档' };
    if (action === 'finish') {
      if (entry.manual_finished === true) return { state, changed: false };
      if (Number(entry.eps) > 0) return { code: 409, error: '已知总集数的番剧按观看进度判定是否看完' };
      entry.manual_finished = true;
    } else {
      if (entry.manual_finished !== true) return { state, changed: false };
      delete entry.manual_finished;
    }
    return { state, changed: true };
  }
  const target = action === 'pause' ? 'paused' : action === 'resume' ? 'watching' : action === 'archive' ? 'archived' : null;
  if (!target) return { code: 400, error: '追番操作无效' };
  if (state === target) return { state, changed: false };
  if (action === 'pause' && state !== 'watching') return { code: 409, error: '只能暂停正在追的番剧' };
  if (action === 'archive' && !isWatchFinished(entry)) return { code: 409, error: '看完全部集数后可以归档' };
  lib[state].splice(index, 1);
  (lib[target] ||= []).unshift(entry);
  return { state: target, changed: true };
}
