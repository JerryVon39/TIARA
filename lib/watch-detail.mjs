import { createHash, randomUUID } from 'node:crypto';
import { findWatchEntry } from './watch-lifecycle.mjs';
import { nextWeeklyUpdate, parseWatchSlot, scheduleRow, setWatchSlot } from './watch-schedule.mjs';
import { applyWatchStart } from './watch-start.mjs';
import { cstParts } from './today.mjs';

// Keep the stored weekday and extended clock together (e.g. Monday 25:30).
export function watchDetail(lib, w, state = 'watching') {
  const slot = scheduleRow(lib, w);
  const fields = {
    id: String(w.id),
    state,
    name: w.name_cn || w.name || String(w.id),
    eps: Number(w.eps) > 0 ? Number(w.eps) : null,
    ep_status: Number(w.ep_status) || 0,
    start_episode: w.start_episode || null,
    air_weekday: slot?.day ?? (Number(w.air_weekday) || null),
    air_time_cst: slot ? (slot.row.time_cst || null) : (w.air_time_cst || null),
    schedule_source: w.schedule_source || null,
    schedule_ended: !!w.schedule_ended,
    schedule_adjustments: w.schedule_adjustments || [],
    reminder_muted: !!w.reminder_muted,
  };
  return { ...fields, revision: createHash('sha256').update(JSON.stringify(fields)).digest('hex') };
}

const invalid = error => ({ code: 400, error });
const whole = (value, min) => Number.isSafeInteger(value) && value >= min;

/** Apply the form to the latest library while the caller holds the write lock. */
export function editWatchDetail(lib, body) {
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
  if (source != null && (typeof source !== 'string' || source.length > 80 || /[\x00-\x1f\x7f]/.test(source))) return invalid('排期来源格式不正确');

  const adding = body.id == null;
  if (!adding && (typeof body.id !== 'string' || !body.id)) return invalid('番剧编号无效');
  const found = adding ? null : findWatchEntry(lib, body.id);
  if (!adding && !found) return { code: 404, error: '找不到这部番，刷新后再试' };
  if (found?.state === 'archived') return { code: 409, error: '请先恢复到在追，再修改归档记录' };
  const w = found?.entry || { id: 'local-' + randomUUID(), priority: '在追' };
  const old = found ? watchDetail(lib, w, found.state) : null;
  if (old && body.expected_revision !== undefined && body.expected_revision !== old.revision) {
    return { code: 409, error: '进度或排期已被其他操作修改，请关闭详情后重新打开' };
  }

  const nameChanged = adding || name !== old.name;
  const totalChanged = adding || eps !== old.eps;
  const scheduleChanged = adding || day !== old.air_weekday || time !== old.air_time_cst || (source != null && source !== old.schedule_source);
  if (!nameChanged && !totalChanged && !scheduleChanged && ep === old.ep_status) return { detail: old, changed: false };

  if (nameChanged) { w.name_cn = name; w.name_manual = true; }
  if (totalChanged) { w.eps = eps; w.eps_manual = true; }
  w.ep_status = ep;
  if (adding && !applyWatchStart(w, body.start_mode, { seen: ep, latest: body.latest_episode })) return invalid('请填写有效的补番起点');
  if (adding && body.start_mode === 'latest' && day && time) {
    const next = Date.parse(nextWeeklyUpdate(day, time));
    const broadcastDay = new Date(next - (Number(time.split(':')[0]) >= 24 ? 8 : 7) * 86400000);
    w.start_date = cstParts(broadcastDay).date;
    w.ep_start = w.start_episode;
  }
  if (!adding && w.start_episode && (ep > 0 && ep < w.start_episode || eps != null && eps < w.start_episode)) delete w.start_episode;
  if (scheduleChanged) {
    setWatchSlot(lib, w, { day, time, source });
  } else if (nameChanged) {
    for (const rows of Object.values(lib.weekday || {})) {
      for (const row of rows) if (String(row.id) === String(w.id)) row.name_cn = name;
    }
  }
  if (adding) lib.watching.push(w);
  return { detail: watchDetail(lib, w, found?.state), changed: true, added: adding };
}
