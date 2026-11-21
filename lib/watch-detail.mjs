import { createHash, randomUUID } from 'node:crypto';
import { findWatchEntry, isWatchFinished, isCatchup } from './watch-lifecycle.mjs';
import { nextWeeklyUpdate, parseWatchSlot, reminderOverride, scheduleRow, setWatchSlot } from './watch-schedule.mjs';
import { applyWatchStart } from './watch-start.mjs';
import { cstParts } from './today.mjs';
import { duplicateReview, libraryMatches } from './watch-matches.mjs';
import { episodeCoverage } from './watch-episodes.mjs';

export function watchUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\//i.test(value) || /[\s\\\x00-\x1f\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.hostname && !url.username && !url.password && url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}

// Keep the stored weekday and extended clock together (e.g. Monday 25:30).
export function watchDetail(lib, w, state = 'watching') {
  const slot = scheduleRow(lib, w);
  const episodes = episodeCoverage(w);
  const fields = {
    id: String(w.id),
    state,
    watch_mode: isCatchup(w) ? 'catchup' : 'airing',
    watch_mode_manual: w.watch_mode_manual === true,
    catchup_slot: w.catchup_slot || null,
    name: w.name_cn || w.name || String(w.id),
    eps: Number(w.eps) > 0 ? Number(w.eps) : null,
    ep_status: Number(w.ep_status) || 0,
    watched_count: episodes.count,
    episode_extras: episodes.extras,
    start_episode: w.start_episode || null,
    air_weekday: slot?.day ?? (Number(w.air_weekday) || null),
    air_time_cst: slot ? (slot.row.time_cst || null) : (w.air_time_cst || null),
    schedule_source: w.schedule_source || null,
    schedule_fetched_at: w.schedule_fetched_at || null,
    schedule_manual: w.schedule_manual === true,
    schedule_ended: !!w.schedule_ended,
    schedule_adjustments: w.schedule_adjustments || [],
    reminder_muted: !!w.reminder_muted,
    reminder_lead: reminderOverride(w.reminder_lead),
    finished: isWatchFinished(w),
    manual_finished: w.manual_finished === true,
    watch_url: watchUrl(w.watch_url),
    ...(Array.isArray(w.watch_order) ? { watch_order: w.watch_order } : {}),
    ...(Array.isArray(w.rewatches) ? { rewatches: w.rewatches } : {}),
    ...(w.dropped_at ? { dropped_at: w.dropped_at } : {}),
    ...(w.drop_note ? { drop_note: w.drop_note } : {}),
    ...(w.removed_from ? { removed_from: w.removed_from, removed_at: w.removed_at || null } : {}),
    ...(w.finished_at ? { finished_at: w.finished_at } : {}),
    ...(w.user_details ? { user_details: w.user_details } : {}),
  };
  return { ...fields, revision: createHash('sha256').update(JSON.stringify(fields)).digest('hex') };
}

const invalid = error => ({ code: 400, error });
const whole = (value, min) => Number.isSafeInteger(value) && value >= min;

export function editWatchPreferences(lib, found, input) {
  const { entry, state } = found;
  const old = watchDetail(lib, entry, state);
  if (input.expected_revision !== old.revision) return { code: 409, error: '条目已经更新，请重新打开详情' };
  const fields = input.preferences;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return invalid('番剧整理资料无效');
  const { tags, year, note, spoiler, pinned, links } = fields;
  if (!Array.isArray(tags) || tags.length > 8 || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 30))
    return invalid('最多可填写 8 个标签，每个标签不超过 30 字');
  if (year !== null && (!Number.isInteger(year) || year < 1900 || year > 2200)) return invalid('年份必须在 1900 到 2200 之间');
  if (typeof note !== 'string' || note.length > 3000) return invalid('笔记最多 3000 字');
  if (typeof spoiler !== 'boolean' || typeof pinned !== 'boolean' || !Array.isArray(links) || links.length > 4)
    return invalid('最多可保存 4 个观看入口');
  const seen = new Set();
  const parsed = [];
  for (const link of links) {
    const url = watchUrl(link?.url);
    if (!url || typeof link.name !== 'string' || link.name.trim().length > 40 || seen.has(url))
      return invalid('请填写有效且互不重复的 HTTP 或 HTTPS 链接，平台名最多 40 字');
    seen.add(url);
    parsed.push({ name: link.name.trim(), url });
  }
  const next = {
    tags: [...new Set(tags.map(tag => tag.trim()))], year, note: note.trim(), spoiler,
    pinned_at: pinned ? entry.user_details?.pinned_at || new Date().toISOString() : null,
    primary_name: parsed[0]?.name || '', links: parsed.slice(1),
  };
  const primary = parsed[0]?.url || null;
  if (JSON.stringify(next) === JSON.stringify(entry.user_details) && primary === old.watch_url)
    return { detail: old, changed: false };
  entry.user_details = next;
  if (primary) entry.watch_url = primary;
  else delete entry.watch_url;
  return { detail: watchDetail(lib, entry, state), changed: true };
}

/** Apply the form to the latest library while the caller holds the write lock. */
export function editWatchDetail(lib, body, { defaultCatchup = false, catalog } = {}) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 160 || /[\x00-\x1f\x7f\ufffd]/.test(name)) return invalid('请填写 1–160 字的单行番名');
  const eps = body.eps ?? null;
  const ep = body.ep_status;
  if (eps !== null && !whole(eps, 1)) return invalid('总集数须为正整数，未知可留空');
  if (!whole(ep, 0) || (eps !== null && ep > eps)) return invalid('已看集数须为非负整数，且不能超过总集数');

  const slot = parseWatchSlot(body.air_weekday, body.air_time_cst);
  if (slot.error) return invalid(slot.error);
  const { day, time } = slot;
  const source = body.schedule_source;
  const fetchedAt = body.schedule_fetched_at;
  if (source != null && (typeof source !== 'string' || source.length > 80 || /[\x00-\x1f\x7f]/.test(source))) return invalid('排期来源格式不正确');
  if (fetchedAt != null && (typeof fetchedAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(fetchedAt) ||
    !Number.isFinite(Date.parse(fetchedAt)) || fetchedAt.length > 30)) return invalid('排期资料时间无效');

  const adding = body.id == null;
  const planned = adding && body.planned === true;
  const mode = body.watch_mode;
  if (body.planned !== undefined && (!adding || body.planned !== true)) return invalid('待看状态仅用于新增番剧');
  if (planned && (ep !== 0 || body.start_mode != null || body.catchup_slot != null || day || time))
    return invalid('开始观看后再设置进度和提醒');
  if (mode !== undefined && mode !== 'airing' && mode !== 'catchup') return invalid('请选择追连载或补番');
  const subject = body.subject_id;
  if (subject != null && (!adding || !whole(subject, 1))) return invalid('Bangumi 条目编号无效');
  const identity = catalog?.id ?? subject;
  const date = catalog?.date ?? body.release_date;
  const release = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
  const original = catalog?.name ?? (typeof body.original_name === 'string' ? body.original_name.trim().slice(0, 160) : '');
  if (adding && (identity != null || body.check_duplicates === true)) {
    const existing = identity != null && findWatchEntry(lib, identity);
    if (existing) return { code: 409, error: '这部番已在番库', duplicates: [{
      id: identity, match: 'id', name: existing.entry.name_cn || existing.entry.name, state: existing.state,
    }] };
    const candidate = { id: identity, name_cn: name, name: original, date: release };
    const matches = libraryMatches(lib, candidate);
    if (matches.some(row => row.match === 'id')) return { code: 409, error: '该 Bangumi 条目已在番库', duplicates: matches };
    const revision = duplicateReview(candidate, matches);
    if (body.check_duplicates === true && matches.length && body.duplicate_revision !== revision)
      return { code: 409, error: '发现可能重复的条目，请先核对', duplicates: matches, duplicate_revision: revision };
  }
  let personal;
  if (body.catchup_slot !== undefined) {
    const entry = body.catchup_slot;
    if (entry === null) personal = null;
    else if (entry && Number.isInteger(entry.day) && entry.day >= 1 && entry.day <= 7 &&
      typeof entry.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(entry.time)) personal = { day: entry.day, time: entry.time };
    else return invalid('补番提醒需要选择星期和 24 小制时间');
  }
  if (!adding && (typeof body.id !== 'string' || !body.id)) return invalid('番剧编号无效');
  const found = adding ? null : findWatchEntry(lib, body.id);
  if (!adding && !found) return { code: 404, error: '找不到这部番，刷新后再试' };
  if (found?.state === 'archived') return { code: 409, error: '请先恢复到在追，再修改归档记录' };
  if (found?.state === 'removed') return { code: 409, error: '请先找回这部番，再修改条目' };
  if (found?.state === 'planned' && (ep !== 0 || body.catchup_slot != null)) return invalid('开始观看后再设置进度和提醒');
  const w = found?.entry || { id: identity ?? ('local-' + randomUUID()), priority: '在追' };
  if (adding && identity != null) {
    if (original) w.name = original;
    if (release) w.release_date = release;
    if (catalog && release) w.start_date = release;
  }
  const old = found ? watchDetail(lib, w, found.state) : null;
  if (found?.state === 'dropped' && ep !== old.ep_status) return { code: 409, error: '请先继续观看，再修改首轮进度' };
  if (old && body.expected_revision !== undefined && body.expected_revision !== old.revision) {
    return { code: 409, error: '进度或排期已被其他操作修改，请关闭详情后重新打开' };
  }
  let link = old?.watch_url ?? null;
  if (body.watch_url !== undefined) {
    const supplied = typeof body.watch_url === 'string' ? body.watch_url.trim() : body.watch_url;
    link = supplied == null || supplied === '' ? null : watchUrl(supplied);
    if (supplied != null && supplied !== '' && !link) return invalid('观看链接须为有效的 HTTP 或 HTTPS 地址，且不含账号密码');
  }

  const nameChanged = adding || name !== old.name;
  const totalChanged = adding || eps !== old.eps;
  if (!adding && totalChanged && ep === old.ep_status && eps != null && old.episode_extras.some(n => n > eps))
    return { code: 409, error: '还有已看集数超过新的总集数，请先在观看历史里更正' };
  const linkChanged = body.watch_url !== undefined && link !== (w.watch_url ?? null);
  const scheduleChanged = adding || day !== old.air_weekday || time !== old.air_time_cst ||
    (source != null && source !== old.schedule_source) || (fetchedAt != null && fetchedAt !== old.schedule_fetched_at);
  const modeChanged = mode !== undefined && mode !== old?.watch_mode;
  const modePicked = mode !== undefined && !old?.watch_mode_manual;
  const personalChanged = personal !== undefined && JSON.stringify(personal) !== JSON.stringify(old?.catchup_slot ?? null);
  if (!nameChanged && !totalChanged && !scheduleChanged && !linkChanged && !modeChanged && !modePicked && !personalChanged && ep === old.ep_status)
    return { detail: old, changed: false };
  if (modeChanged) {
    if (mode === 'catchup') w.watch_mode = mode;
    else delete w.watch_mode;
  }
  if (modePicked) w.watch_mode_manual = true;
  if (adding && !planned && mode === undefined && defaultCatchup) w.watch_mode = 'catchup';
  if (personalChanged) {
    if (personal) w.catchup_slot = personal;
    else delete w.catchup_slot;
  }

  if (nameChanged) { w.name_cn = name; w.name_manual = true; }
  if (totalChanged) { w.eps = eps; w.eps_manual = true; }
  if (linkChanged) {
    if (link) w.watch_url = link;
    else delete w.watch_url;
  }
  if (old && ep !== old.ep_status) {
    delete w.episode_extras;
    w.progress_edited_at = new Date().toISOString();
  }
  w.ep_status = ep;
  if (adding && !applyWatchStart(w, body.start_mode, { seen: ep, latest: body.latest_episode })) return invalid('请填写有效的补番起点');
  if (adding && body.start_mode === 'latest' && day && time) {
    const next = Date.parse(nextWeeklyUpdate(day, time));
    const broadcastDay = new Date(next - (Number(time.split(':')[0]) >= 24 ? 8 : 7) * 86400000);
    w.start_date = cstParts(broadcastDay).date;
    w.ep_start = w.start_episode;
  }
  if (!adding && w.start_episode && (ep > 0 && ep < w.start_episode || eps != null && eps < w.start_episode)) {
    w.progress_edited_at = new Date().toISOString();
    delete w.start_episode;
  }
  if (scheduleChanged && !planned) {
    setWatchSlot(lib, w, { day, time, source, fetchedAt });
  } else if (nameChanged) {
    for (const rows of Object.values(lib.weekday || {})) {
      for (const row of rows) if (String(row.id) === String(w.id)) row.name_cn = name;
    }
  }
  const state = planned ? 'planned' : found?.state || 'watching';
  if (adding) (lib[state] ||= []).push(w);
  if (!isWatchFinished(w)) delete w.finished_at;
  return { detail: watchDetail(lib, w, state), changed: true, added: adding };
}
