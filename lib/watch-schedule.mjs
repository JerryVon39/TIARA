import { parseClock } from './time.mjs';
import { isWatchFinished, isCatchup } from './watch-lifecycle.mjs';

export function scheduleRow(lib, w) {
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

export function parseWatchSlot(day, rawTime) {
  if (day != null && (!Number.isInteger(day) || day < 1 || day > 7)) return { error: '请选择周一至周日，或设为未排期' };
  if (rawTime == null || rawTime === '') return { day: day ?? null, time: null };
  if (typeof rawTime !== 'string') return { error: '请按 23:30 或 25:30 格式填写开播时间' };
  const parsed = parseClock(rawTime);
  if (!parsed.ok) return { error: parsed.error };
  if (day == null) return { error: '填写开播时间前，请先选择开播星期' };
  return { day, time: parsed.text };
}

export function setWatchSlot(lib, w, { day, time, source, fetchedAt }) {
  const current = scheduleRow(lib, w);
  const previous = current?.row;
  if (current?.day !== day || previous?.time_cst !== time) {
    if (Array.isArray(w.schedule_adjustments)) w.schedule_adjustments = w.schedule_adjustments.filter(change =>
      Math.max(Date.parse(change.original_at), Date.parse(change.at) || 0) < Date.now());
  }
  w.air_weekday = day;
  w.air_time_cst = time;
  w.schedule_manual = true;
  if (time && source) w.schedule_source = source;
  else delete w.schedule_source;
  if (time && source && fetchedAt) w.schedule_fetched_at = fetchedAt;
  else delete w.schedule_fetched_at;
  lib.weekday ||= {};
  for (const key of Object.keys(lib.weekday)) lib.weekday[key] = lib.weekday[key].filter(row => String(row.id) !== String(w.id));
  if (day !== null) (lib.weekday[day] ||= []).push({ ...previous, id: w.id, name_cn: w.name_cn || w.name || String(w.id), time_cst: time });
}

/** Project the first scheduled weekly time at or after now. Stored 25:30 stays paired with its broadcast day. */
export function nextWeeklyUpdate(day, time, now = new Date(), since) {
  const parsed = parseClock(time);
  if (!parsed.ok || !Number.isInteger(day) || day < 1 || day > 7) return null;
  const hour = 3600000, week = 7 * 24 * hour;
  const cst = new Date(+now + 8 * hour);
  const midnight = Date.UTC(cst.getUTCFullYear(), cst.getUTCMonth(), cst.getUTCDate()) - 8 * hour;
  const delta = day - (cst.getUTCDay() || 7);
  let next = midnight + delta * 24 * hour + parsed.minutes * 60000;
  const earliest = Math.max(+now, Date.parse(since + 'T00:00:00+08:00') || 0);
  if (next < earliest) next += Math.ceil((earliest - next) / week) * week;
  return new Date(next).toISOString();
}

export function nextScheduledUpdate(w, now = new Date(), since) {
  if (w.schedule_ended) return null;
  let next = nextWeeklyUpdate(w.air_weekday, w.air_time_cst, now, since);
  if (!next) return null;
  const changes = w.schedule_adjustments || [];
  const replaced = new Set(changes.map(change => change.original_at));
  while (replaced.has(next)) next = new Date(Date.parse(next) + 7 * 86400000).toISOString();
  for (const change of changes) if (change.at && Date.parse(change.at) >= +now && change.at < next) next = change.at;
  return next;
}

export function personalReminder(w, now = new Date()) {
  const slot = w.catchup_slot;
  if (!slot || !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time || '')) return null;
  const at = nextWeeklyUpdate(slot.day, slot.time, now);
  return at ? { at, day: slot.day, time: slot.time } : null;
}

export function catchupReminders(lib, since = new Date()) {
  return (lib.watching || []).filter(w => isCatchup(w) && !isWatchFinished(w))
    .flatMap(w => {
      const slot = personalReminder(w, since);
      return slot ? [{ id: w.id, name: w.name_cn || w.name || String(w.id), ...slot }] : [];
    })
    .sort((a, b) => a.at.localeCompare(b.at));
}

export const REMINDER_LEADS = [0, 5, 10, 15, 30, 60];
export const reminderLead = settings => REMINDER_LEADS.includes(settings.reminder_lead) ? settings.reminder_lead : 0;

export function quietAt(settings, at) {
  const time = new Date(+at + 8 * 3600000);
  const minute = time.getUTCHours() * 60 + time.getUTCMinutes();
  const today = time.getUTCDay();
  function interval(day) {
    const key = day === 0 || day === 6 ? 'quiet_weekend' : 'quiet_work';
    const start = parseClock(settings[key + '_start'] ?? settings.quiet_start);
    const end = parseClock(settings[key + '_end'] ?? settings.quiet_end);
    return start.ok && end.ok && start.minutes < 1440 && end.minutes < 1440 && start.minutes !== end.minutes ?
      [start.minutes, end.minutes] : null;
  }
  const previous = interval((today + 6) % 7);
  if (previous && previous[0] > previous[1] && minute < previous[1]) return true;
  const here = interval(today);
  return !!here && minute >= here[0] && (here[0] > here[1] || minute < here[1]);
}
