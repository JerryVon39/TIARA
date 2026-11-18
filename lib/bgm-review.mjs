import { calendarEntries } from './bgm.mjs';
import { findWatchEntry, isCatchup, isWatchFinished } from './watch-lifecycle.mjs';
import { scheduleRow } from './watch-schedule.mjs';
import { cstParts } from './today.mjs';

export const BGM_STATES = {
  1: ['想看', 'planned', '待看'],
  2: ['看过', 'watching', '已看完'],
  3: ['在看', 'watching', '在追'],
  4: ['搁置', 'paused', '暂停'],
  5: ['抛弃', 'dropped', '已弃番'],
};
const localLabel = found => found.state === 'watching'
  ? isWatchFinished(found.entry) ? '已看完' : isCatchup(found.entry) ? '补番' : '在追'
  : { paused: '暂停', planned: '待看', archived: '归档', dropped: '已弃番', removed: '已移除' }[found.state];
const meaningfulNumber = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const title = (w, id) => w?.name_cn || w?.name || String(id);

// Each visible row owns an operation. Derived fields (such as a weekly row's
// name, or the timestamp for a progress override) belong to the same operation.
export function reviewBgmLibrary(library, data, { takeProgress = false, allWeek = false, now = new Date(), stamp = {}, ended = new Set() } = {}) {
  const next = structuredClone(library);
  const calendar = new Map(calendarEntries(data.calendar).map(item => [String(item.id), item]));
  const changes = [], operations = new Map(), mappings = [], protectedFields = [];
  const created = new Set();
  function offer(id, name, field, from, to, source, apply, selected = true, note) {
    const key = String(id) + ':' + field;
    changes.push({ key, id, field, name, from: from ?? null, to: to ?? null, source, fetched_at: stamp[source] || null, selected, note });
    operations.set(key, apply);
  }
  function protect(id, name, field, from, to, reason, source) {
    if (from !== to) protectedFields.push({ id, name, field, from: from ?? null, to: to ?? null, reason, source, fetched_at: stamp[source] || null });
  }
  function putWeek(item, w) {
    next.weekday ||= {};
    const existing = w && scheduleRow(next, w);
    for (const day of Object.keys(next.weekday))
      next.weekday[day] = next.weekday[day].filter(row => String(row.id) !== String(item.id));
    (next.weekday[item.weekday] ||= []).push({ time_cst: null, ep_expected: null, ...existing?.row,
      id: w?.id ?? item.id, name_cn: title(w || item, item.id) });
  }

  const seenCollections = new Set();
  for (const item of data.collections || []) {
    const id = meaningfulNumber(item?.subject_id ?? item?.subject?.id);
    const type = Number(item?.type ?? 3);
    if (!id || !Object.hasOwn(BGM_STATES, type) || seenCollections.has(id)) continue;
    seenCollections.add(id);
    const idKey = String(id), subject = item.subject || {};
    const [remote, state, defaultLabel] = BGM_STATES[type];
    const found = findWatchEntry(next, id);
    const name = title(found?.entry || subject, id);
    const eps = meaningfulNumber(subject.eps || subject.total_episodes);
    const rawProgress = item.ep_status;
    const progress = Number.isSafeInteger(rawProgress) && rawProgress >= 0 ? rawProgress : null;
    const catchup = !found && type === 3 && ended.has(idKey) && !(takeProgress && eps && progress >= eps);
    const mapped = catchup ? '补番' : defaultLabel;
    const cal = calendar.get(idKey);
    const current = found ? localLabel(found) : null;
    const stateProtected = !!found && (found.state !== 'watching' || isWatchFinished(found.entry) || isCatchup(found.entry));
    mappings.push({ id, name, remote, mapped, current, protected: stateProtected && current !== mapped });
    if (!found) {
      created.add(idKey);
      const week = type === 3 && cal?.weekday >= 1 && cal.weekday <= 7 ? cal : null;
      const seen = state !== 'planned' && takeProgress && progress !== null ? Math.min(progress, eps || progress) : 0;
      const entry = { id, name_cn: name, name: subject.name || '', eps: eps || 0,
        ep_status: seen, air_weekday: week?.weekday ?? null, air_time_cst: null, last_watched: null,
        ...(catchup ? { watch_mode: 'catchup' } : {}),
        ...(subject.date ? { release_date: subject.date } : {}),
        ...(week?.air_date ? { start_date: week.air_date } : {}),
        ...(type === 2 && !(eps && seen >= eps) ? { manual_finished: true } : {}),
        ...(type === 5 ? { dropped_manually: true } : {}),
      };
      offer(id, name, '(新增)', null, mapped, 'collections', () => {
        (next[state] ||= []).push(entry);
        if (week?.weekday) putWeek(week, entry);
      }, type === 3, seen ? '同时导入 ' + seen + ' 集' : undefined);
      continue;
    }
    const w = found.entry;
    if (current !== mapped && !stateProtected && type !== 3) {
      offer(id, name, 'collection_state', current, mapped, 'collections', () => {
        if (type === 2) w.manual_finished = true;
        else {
          next[found.state] = next[found.state].filter(row => row !== w);
          (next[state] ||= []).push(w);
          if (type === 5) w.dropped_manually = true;
        }
      }, false, '观看记录和本地排期保留');
    }
    const pausedFinished = found.state === 'paused' && isWatchFinished(w) && !w.manual_finished;
    if (found.state !== 'watching' && !pausedFinished) continue;
    if (found.state === 'watching') {
      for (const key of ['name_cn', 'name']) {
        if (!subject[key] || subject[key] === w[key]) continue;
        if (w.name_manual) protect(id, name, key, w[key], subject[key], '手填番名', 'collections');
        else offer(id, name, key, w[key], subject[key], 'collections', () => {
          w[key] = subject[key];
          if (key === 'name_cn') {
            const slot = scheduleRow(next, w);
            if (slot) slot.row.name_cn = w.name_cn;
          }
        });
      }
    }
    if (eps && eps !== Number(w.eps) && (!pausedFinished || eps > Number(w.eps))) {
      const before = Number(w.eps) || null;
      if (w.eps_manual) protect(id, name, 'eps', before, eps, '手填集数', 'collections');
      else if (eps < Math.max(Number(w.ep_status) || 0, w.episode_extras?.at(-1) || 0) ||
          (takeProgress && before && progress > eps && progress <= before))
        protect(id, name, 'eps', before, eps, '少于本机或可导入的观看进度', 'collections');
      else offer(id, name, 'eps', before, eps, 'collections', () => {
        w.eps = eps;
        if (eps > (before || 0)) { w.eps_updated_at = cstParts(now).date; w.eps_prev = before; }
        if (!isWatchFinished(w)) delete w.finished_at;
      });
    }
    if (found.state === 'watching' && takeProgress && progress !== null && progress !== Number(w.ep_status) && type !== 1) {
      const cap = meaningfulNumber(w.eps);
      if (w.episode_extras?.length)
        protect(id, name, 'ep_status', w.ep_status, progress, '线上连续进度无法表示本机跳集，保留逐集记录', 'collections');
      else if ((cap || eps) && progress > (cap || eps))
        protect(id, name, 'ep_status', w.ep_status, progress, '超过已知总集数，请先核对集数', 'collections');
      else offer(id, name, 'ep_status', w.ep_status, progress, 'collections', () => {
        w.ep_status = progress;
        w.progress_edited_at = now.toISOString();
        if (!isWatchFinished(w)) delete w.finished_at;
      }, progress > Number(w.ep_status));
    }
  }
  for (const [key, item] of calendar) {
    if (created.has(key) || !(item.weekday >= 1 && item.weekday <= 7)) continue;
    const found = findWatchEntry(next, key), w = found?.entry;
    const name = title(w || item, item.id);
    if (!w) {
      if (allWeek && !scheduleRow(next, item)) offer(item.id, name, 'calendar_entry', null, item.weekday, 'calendar', () => putWeek(item));
      continue;
    }
    if (found.state !== 'watching') continue;
    const slot = scheduleRow(next, w), from = slot?.day ?? w.air_weekday;
    if (w.schedule_manual || w.schedule_ended || isCatchup(w) || slot?.row.time_cst || w.air_time_cst)
      protect(item.id, name, 'air_weekday', from, item.weekday, '保留本机排期', 'calendar');
    else if (!slot || slot.day !== item.weekday || w.air_weekday !== item.weekday)
      offer(item.id, name, 'air_weekday', from, item.weekday, 'calendar', () => {
        w.air_weekday = item.weekday;
        putWeek(item, w);
      });
    if (item.air_date && !w.start_date)
      offer(item.id, name, 'start_date', null, item.air_date, 'calendar', () => { w.start_date = item.air_date; });
  }
  return { changes, mappings, protectedFields, apply(keys) {
    const selected = new Set(keys ?? changes.filter(change => change.selected).map(change => change.key));
    for (const change of changes) if (selected.has(change.key)) operations.get(change.key)();
    return { next, changes: changes.filter(change => selected.has(change.key)) };
  } };
}
