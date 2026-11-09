const STATES = ['watching', 'paused', 'archived'];

export function findWatchEntry(lib, id) {
  if (id == null) return null;
  for (const state of STATES) {
    const entries = lib[state] || [];
    const index = entries.findIndex(w => String(w.id) === String(id));
    if (index >= 0) return { state, index, entry: entries[index] };
  }
  return null;
}

export function inactiveWatchIds(lib) {
  return new Set([...(lib.paused || []), ...(lib.archived || [])].map(w => String(w.id)));
}

export function canArchive(w) {
  return Number(w.eps) > 0 && Number(w.ep_status) >= Number(w.eps);
}

/** Move the whole entry. The original weekly rows stay available for resuming. */
export function moveWatchEntry(lib, found, action) {
  const { state, index, entry } = found;
  const target = action === 'pause' ? 'paused' : action === 'resume' ? 'watching' : action === 'archive' ? 'archived' : null;
  if (!target) return { code: 400, error: '追番操作无效' };
  if (state === target) return { state, changed: false };
  if (action === 'pause' && state !== 'watching') return { code: 409, error: '只能暂停正在追的番剧' };
  if (action === 'archive' && !canArchive(entry)) return { code: 409, error: '看完全部集数后可以归档' };
  lib[state].splice(index, 1);
  (lib[target] ||= []).unshift(entry);
  return { state: target, changed: true };
}
