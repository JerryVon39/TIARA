import { findWatchEntry, isCatchup, isWatchFinished, moveWatchEntry, WATCH_STATES } from './watch-lifecycle.mjs';
import { releaseYear, titleKey } from './watch-matches.mjs';
import { watchDetail, watchUrl } from './watch-detail.mjs';
import { scheduleRow } from './watch-schedule.mjs';
import { episodeDiff, storeEpisodeDiff } from './watch-episodes.mjs';

const listNames = WATCH_STATES;
const manualId = id => typeof id === 'string' && /^local-[\w-]{1,80}$/.test(id);
const problem = (error, code = 409) => ({ error, code });

export function watchHistoryOwners(lib) {
  const ids = new Map();
  const entries = listNames.flatMap(state => lib[state] || []);
  for (const entry of entries) if (!ids.has(String(entry.id))) ids.set(String(entry.id), entry);
  for (const entry of entries) {
    for (const id of Array.isArray(entry.history_ids) ? entry.history_ids : []) {
      if (manualId(id) && !ids.has(id)) ids.set(id, entry);
    }
  }
  return ids;
}

function linksOf(entry) {
  const info = entry.user_details || {};
  const supplied = [{ url: entry.watch_url, name: info.primary_name || '' }, ...(info.links || [])];
  return supplied.filter(link => watchUrl(link.url));
}

function summary(lib, { entry, state }, rows, owners) {
  const detail = watchDetail(lib, entry, state);
  const history = rows.filter(row => owners.get(String(row.id)) === entry && Number.isFinite(row.delta));
  return { ...detail, year: releaseYear(entry), release_date: entry.release_date || null, original: entry.name || '', links: linksOf(entry),
    history_count: history.length, history_recent: history.map(row => row.date).filter(Boolean).sort().at(-1) || null };
}

function dateConflict(left, right) {
  const year = releaseYear(left), other = releaseYear(right);
  if (year && other && year !== other) return true;
  const a = left.release_date || left.date, b = right.release_date || right.date;
  return /^\d{4}-\d{2}-\d{2}$/.test(a || '') && /^\d{4}-\d{2}-\d{2}$/.test(b || '') && a !== b;
}

function identityIssue(local, subject, existing) {
  const year = releaseYear(local);
  const onlineYear = releaseYear(subject);
  if (year && onlineYear && year !== onlineYear) return '首播年份不同，可能是不同季或重制版。';
  if (/^\d{4}-\d{2}-\d{2}$/.test(local.release_date || '') && /^\d{4}-\d{2}-\d{2}$/.test(subject.date || '') &&
    local.release_date !== subject.date) return '首播日期不同，请核对是否为同一年播出的不同季。';
  const localNames = [local.name_cn, local.name, local.alias].flat().map(titleKey).filter(Boolean);
  const remoteNames = [subject.name_cn, subject.name].map(titleKey).filter(Boolean);
  if (!localNames.some(name => remoteNames.includes(name))) return '番名不匹配，请核对季数和版本。';
  if (local.name && local.name_cn && titleKey(local.name) !== titleKey(local.name_cn) &&
    !remoteNames.includes(titleKey(local.name))) return '原名不同，请核对版本。';
  if (existing && (dateConflict(existing, subject) || dateConflict(existing, local)))
    return '番库中已绑定的条目首播日期或年份冲突，请核对是否为同一季。';
  if (existing && (!year || !onlineYear)) return '合并前请在本地条目的整理资料里填写并核对首播年份。';
  return null;
}

export function planBinding(lib, id, subject, rows, now, scheduleChoice) {
  if (!manualId(id)) return problem('只能绑定手动添加的条目', 400);
  const from = findWatchEntry(lib, id);
  if (!from) return problem('找不到手动条目', 404);
  const onlineId = String(subject.id);
  const to = findWatchEntry(lib, onlineId);
  const owners = watchHistoryOwners(lib);
  const source = summary(lib, from, rows, owners);
  const existing = to;
  const target = existing ? summary(lib, existing, rows, owners) : null;
  const online = { id: onlineId, name: subject.name_cn, original: subject.name, date: subject.date,
    platform: subject.platform, eps: subject.eps || null };
  const mode = existing ? 'merge' : 'bind';
  const review = { source, target, online, mode };
  const issue = identityIssue(from.entry, subject, existing?.entry);
  if (issue) return { review: { ...review, blocked: issue } };
  if (from.state === 'removed' || to?.state === 'removed')
    return { review: { ...review, blocked: '请先从「已移除」找回对应条目' } };

  const local = from.entry;
  const linked = to?.entry;
  const schedule = (entry, detail) => ({
    entry, slot: scheduleRow(lib, entry), day: detail.air_weekday, time: detail.air_time_cst,
    manual: !!(entry.schedule_manual || entry.schedule_ended), ended: detail.schedule_ended,
  });
  const localSlot = schedule(local, source), linkedSlot = linked ? schedule(linked, target) : null;
  const conflict = linkedSlot && localSlot.manual && linkedSlot.manual &&
    (localSlot.day !== linkedSlot.day || localSlot.time !== linkedSlot.time || localSlot.ended !== linkedSlot.ended ||
      JSON.stringify(local.schedule_adjustments || []) !== JSON.stringify(linked.schedule_adjustments || []));
  if (conflict && !['local', 'linked'].includes(scheduleChoice))
    return { review: { ...review, schedule_conflict: true, blocked: '两边手动排期不同，请先选择要保留的排期。' } };
  if (conflict) Object.assign(review, { schedule_conflict: true, schedule_choice: scheduleChoice });
  const chosen = !linkedSlot || (conflict ? scheduleChoice === 'local' :
    localSlot.manual && !linkedSlot.manual || !linkedSlot.manual && !linkedSlot.time && !!localSlot.time)
    ? localSlot : linkedSlot;
  const current = target && target.ep_status >= source.ep_status ? linked : local;
  const progress = Math.max(source.ep_status, target?.ep_status || 0);
  const totals = [current.eps, linked?.eps, local.eps, subject.eps].map(Number);
  const extras = [...(local.episode_extras || []), ...(linked?.episode_extras || [])];
  const eps = totals.find(total => total > 0 && total >= Math.max(progress, ...extras)) || null;
  const merged = { ...local, ...linked, id: subject.id, name: subject.name || local.name || linked?.name,
    name_cn: linked?.name_cn || local.name_cn || subject.name_cn, release_date: subject.date || linked?.release_date || local.release_date,
    ep_status: progress, eps };
  for (const key of ['schedule_manual', 'schedule_source', 'schedule_fetched_at', 'schedule_adjustments', 'schedule_ended']) {
    if (Object.hasOwn(chosen.entry, key)) merged[key] = chosen.entry[key];
    else delete merged[key];
  }
  merged.air_weekday = chosen.day;
  merged.air_time_cst = chosen.time;
  if (local.reminder_muted || linked?.reminder_muted) merged.reminder_muted = true;
  if (linked) {
    const rounds = [...(local.rewatches || []), ...(linked.rewatches || [])];
    if (rounds.filter(round => !round.finished_at).length > 1)
      return { review: { ...review, blocked: '两条番剧都在重看，请先完成其中一轮再合并。' } };
    if (rounds.length) merged.rewatches = rounds.sort((a, b) => b.started_at.localeCompare(a.started_at));
    merged.finished_at = [local.finished_at, linked.finished_at].filter(Boolean).sort()[0];
    const recent = [local, linked].sort((a, b) => String(b.last_watched || '').localeCompare(String(a.last_watched || '')) ||
      String(b.last_watched_at || '').localeCompare(String(a.last_watched_at || '')))[0];
    merged.last_watched = recent.last_watched || null;
    merged.last_watched_at = recent.last_watched_at;
    merged.start_episode = current.start_episode;
    merged.ep_start = current.ep_start;
    merged.progress_edited_at = now;
    if (extras.length || Array.isArray(local.episode_extras) || Array.isArray(linked.episode_extras)) {
      delete merged.episode_extras;
      const floor = Math.max(merged.ep_status, (Number(merged.start_episode) || 1) - 1);
      const diff = episodeDiff(merged, extras.filter(n => n > floor));
      if (diff.error) return { review: { ...review, blocked: diff.error } };
      storeEpisodeDiff(merged, diff);
    }
  }
  const historyIds = [...new Set([id, ...(local.history_ids || []), ...(linked?.history_ids || [])])];
  merged.history_ids = historyIds;
  const allLinks = [...linksOf(linked || {}), ...linksOf(local)];
  const links = allLinks.filter((link, index) => allLinks.findIndex(item => item.url === link.url) === index);
  const tags = [...new Set([...(linked?.user_details?.tags || []), ...(local.user_details?.tags || [])])];
  const note = [...new Set([linked?.user_details?.note, local.user_details?.note].filter(Boolean))].join('\n\n');
  if (links.length > 4 || tags.length > 8 || note.length > 3000)
    return { review: { ...review, blocked: '合并后会超过观看链接、标签或笔记的容量。请先在两条记录的整理资料中精简。' } };
  if (links.length) merged.watch_url = links[0].url;
  if (local.user_details || linked?.user_details || links.length) {
    merged.user_details = { ...local.user_details, ...linked?.user_details, tags, note,
      spoiler: !!(local.user_details?.spoiler || linked?.user_details?.spoiler),
      pinned_at: linked?.user_details?.pinned_at || local.user_details?.pinned_at || null,
      primary_name: links[0]?.name || '', links: links.slice(1) };
  }
  const state = from.state === 'planned' || (to && to.state !== 'planned') ? to?.state || from.state : from.state;
  if (linked && isCatchup(linked) !== isCatchup(local)) {
    const preference = local.watch_mode_manual === true && linked.watch_mode_manual !== true ? local :
      linked.watch_mode_manual === true && local.watch_mode_manual !== true ? linked :
        state === 'planned' || to?.state !== 'planned' ? linked : local;
    if (isCatchup(preference)) merged.watch_mode = 'catchup';
    else delete merged.watch_mode;
  }
  if (local.watch_mode_manual === true || linked?.watch_mode_manual === true) merged.watch_mode_manual = true;
  const postState = state === 'archived' && !isWatchFinished(merged) ? 'paused' : state;
  function apply() {
    const positions = [from, ...(to ? [to] : [])].sort((a, b) => b.index - a.index);
    for (const item of positions) lib[item.state].splice(item.index, 1);
    (lib[postState] ||= []).push(merged);
    lib.weekday ||= {};
    for (const [day, entries] of Object.entries(lib.weekday))
      lib.weekday[day] = entries.filter(row => ![id, onlineId].includes(String(row.id)));
    if (chosen.day != null) (lib.weekday[chosen.day] ||= []).push({
      ...chosen.slot?.row, id: subject.id, name_cn: merged.name_cn || merged.name, time_cst: chosen.time,
    });
  }
  // The caller supplies a fresh snapshot. Build the review from the exact state
  // it may later commit, including the linked weekly row.
  apply();
  review.result = { ...watchDetail(lib, merged, postState), release_date: merged.release_date || null, links,
    history_count: source.history_count + (target?.history_count || 0) };
  return { review };
}

export function organizeLibrary(lib, input, apply = false, statuses = new Map()) {
  const { ids, action } = input;
  const tag = typeof input.tag === 'string' ? input.tag.trim() : '';
  if (!Array.isArray(ids) || !ids.length || ids.length > 200 || new Set(ids).size !== ids.length ||
    !ids.every(id => typeof id === 'string' && id && id.length <= 100)) return problem('请选择 1 至 200 个番剧条目', 400);
  const toCatchup = action === 'catchup' || action === 'ended-catchup';
  if (!['tag', 'catchup', 'ended-catchup', 'archive'].includes(action) || (action === 'tag' && (!tag || tag.length > 30 || /[\x00-\x1f]/.test(tag))))
    return problem('请检查批量操作和标签，标签最多 30 字', 400);
  const rows = ids.map(id => {
    const found = findWatchEntry(lib, id);
    const entry = found?.entry;
    const row = { id, name: entry?.name_cn || entry?.name || id };
    if (!entry) return { ...row, reason: '条目已移出番库' };
    if (found.state === 'removed') return { ...row, reason: '请先找回已移除的条目' };
    const tags = entry.user_details?.tags || [];
    if (action === 'tag' && tags.includes(tag)) return { ...row, reason: '已有这一标签' };
    if (action === 'tag' && tags.length >= 8) return { ...row, reason: '标签已满' };
    if (toCatchup && (found.state !== 'watching' || isWatchFinished(entry) || isCatchup(entry)))
      return { ...row, reason: '仅可切换尚未看完的在追番剧' };
    if (action === 'ended-catchup') {
      const detail = watchDetail(lib, entry, found.state);
      row.watched_count = detail.watched_count;
      row.eps = detail.eps;
      if (entry.watch_mode_manual === true) return { ...row, reason: '保留手动选择的观看方式' };
      if (detail.schedule_adjustments.some(change => Date.parse(change.at) > Date.now()) ||
          (!detail.schedule_ended && detail.schedule_manual && detail.air_weekday && detail.air_time_cst))
        return { ...row, reason: '保留已有的手动排片或未来改期' };
      const evidence = statuses.get(id);
      if (evidence?.state !== 'ended') return { ...row, reason: evidence?.state === 'airing' ? '仍有未播正片或未来播出日' : '暂未确认原播结束' };
      row.broadcast = evidence;
    }
    if (action === 'archive' && (found.state === 'archived' || found.state === 'planned' || !isWatchFinished(entry)))
      return { ...row, reason: '仅可归档尚未归档的已看完番剧' };
    if (apply) {
      if (action === 'tag') entry.user_details = { ...entry.user_details, tags: [...tags, tag] };
      if (toCatchup) {
        entry.watch_mode = 'catchup';
        entry.watch_mode_manual = true;
      }
      if (action === 'archive') moveWatchEntry(lib, found, 'archive');
    }
    return row;
  });
  return { changed: rows.filter(row => !row.reason), skipped: rows.filter(row => row.reason), tag, action };
}
