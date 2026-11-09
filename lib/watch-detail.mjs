import { createHash, randomUUID } from 'node:crypto';
import { parseClock } from './time.mjs';
import { findWatchEntry } from './watch-lifecycle.mjs';

function scheduleRow(lib, w) {
  let first = null;
  for (const [key, rows] of Object.entries(lib.weekday || {})) {
    const row = rows.find(r => String(r.id) === String(w.id));
    if (!row) continue;
    const found = { day: Number(key), row };
    if (found.day === Number(w.air_weekday)) return found;
    first ??= found;
  }
  return first;
}

// Keep the stored weekday and extended clock together (e.g. Monday 25:30).
export function watchDetail(lib, w, state = 'watching') {
  const slot = scheduleRow(lib, w);
  const fields = {
    id: String(w.id),
    state,
    name: w.name_cn || w.name || String(w.id),
    eps: Number(w.eps) > 0 ? Number(w.eps) : null,
    ep_status: Number(w.ep_status) || 0,
    air_weekday: slot?.day ?? (Number(w.air_weekday) || null),
    air_time_cst: slot ? (slot.row.time_cst || null) : (w.air_time_cst || null),
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

  const day = body.air_weekday ?? null;
  if (day !== null && (!whole(day, 1) || day > 7)) return invalid('请选择周一至周日，或设为未排期');
  let time = null;
  if (body.air_time_cst != null && body.air_time_cst !== '') {
    if (typeof body.air_time_cst !== 'string') return invalid('请按 23:30 或 25:30 格式填写开播时间');
    const parsed = parseClock(body.air_time_cst);
    if (!parsed.ok) return invalid(parsed.error);
    if (day === null) return invalid('填写开播时间后，请选择开播星期');
    time = parsed.text;
  }

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
  const scheduleChanged = adding || day !== old.air_weekday || time !== old.air_time_cst;
  if (!nameChanged && !totalChanged && !scheduleChanged && ep === old.ep_status) return { detail: old, changed: false };

  if (nameChanged) { w.name_cn = name; w.name_manual = true; }
  if (totalChanged) { w.eps = eps; w.eps_manual = true; }
  w.ep_status = ep;
  if (scheduleChanged) {
    const oldRow = adding ? null : scheduleRow(lib, w)?.row;
    w.air_weekday = day;
    w.air_time_cst = time;
    w.schedule_manual = true;
    lib.weekday ||= {};
    for (const key of Object.keys(lib.weekday)) lib.weekday[key] = lib.weekday[key].filter(r => String(r.id) !== String(w.id));
    if (day !== null) (lib.weekday[day] ||= []).push({ ...oldRow, id: w.id, name_cn: name, time_cst: time });
  } else if (nameChanged) {
    for (const rows of Object.values(lib.weekday || {})) {
      for (const row of rows) if (String(row.id) === String(w.id)) row.name_cn = name;
    }
  }
  if (adding) lib.watching.push(w);
  return { detail: watchDetail(lib, w, found?.state), changed: true, added: adding };
}
