import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from './atomic.mjs';
import { findWatchEntry, isCatchup, isWatchFinished, WATCH_STATES } from './watch-lifecycle.mjs';
import { scheduleRow, nextScheduledUpdate, personalReminder, reminderBlockReason } from './watch-schedule.mjs';

const occurrence = (lib, w, state) => {
  if (state !== 'watching' || isWatchFinished(w) || w.reminder_muted) return null;
  if (isCatchup(w)) {
    const slot = w.catchup_slot;
    return slot?.day && slot.time ? ['catchup', slot.day, slot.time] : null;
  }
  if (w.schedule_ended) return null;
  const slot = scheduleRow(lib, w);
  const day = slot?.day ?? w.air_weekday, time = slot ? slot.row.time_cst : w.air_time_cst;
  return day && time ? ['airing', day, time, w.start_date || null,
    (w.schedule_adjustments || []).map(item => [item.original_at, item.at])] : null;
};

export function remindStamp(lib, w, state = 'watching') {
  const slot = occurrence(lib, w, state);
  return slot ? createHash('sha256').update(JSON.stringify([w.reminder_epoch ?? 'legacy', slot])).digest('hex').slice(0, 24) : null;
}

// Epochs change even when Pause -> Resume or Undo returns to the same timetable.
// This keeps an old bubble or pending snooze from reviving after a lifecycle change.
export function updateReminderEpochs(previous, next, reset = false) {
  const old = new Map(WATCH_STATES.flatMap(state => (previous?.[state] || []).map(entry => [String(entry.id), { state, entry }])));
  for (const state of WATCH_STATES) for (const w of next[state] || []) {
    const before = old.get(String(w.id));
    const a = before && occurrence(previous, before.entry, before.state);
    const b = occurrence(next, w, state);
    if ((a || b) && (reset || !before || JSON.stringify(a) !== JSON.stringify(b))) w.reminder_epoch = randomUUID();
    else if (before?.entry.reminder_epoch) w.reminder_epoch = before.entry.reminder_epoch;
    else delete w.reminder_epoch;
  }
}

const queueFile = root => path.join(root, 'data', 'reminder-snoozes.json');
const windowSeconds = 6 * 3600;
const leaseSeconds = 90;
const validStamp = stamp => typeof stamp === 'string' && /^[a-f0-9]{24}$/.test(stamp);
const validKind = kind => kind === 'airing' || kind === 'catchup';
const validId = id => typeof id === 'string' && /^[\w-]{1,100}$/.test(id);
const validKey = key => typeof key === 'string' && /^[a-f0-9]{24}$/.test(key);
const duration = minutes => Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= 180;
const title = (w, id) => w.name_cn || w.name || id;

export function reminderSnoozeKey(id, kind, slotAt, stamp) {
  return createHash('sha256').update(JSON.stringify([id, kind, slotAt, stamp])).digest('hex').slice(0, 24);
}

async function readQueue(root) {
  try {
    const value = JSON.parse(await fs.readFile(queueFile(root), 'utf8'));
    if (!Array.isArray(value)) throw new Error('稍后提醒文件格式不正确');
    return value.filter(item => validKey(item?.key) && validId(item.id) && validStamp(item.stamp) &&
      validKind(item.kind) && Number.isSafeInteger(item.slot_at) && Number.isSafeInteger(item.due_at));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function reminderSnoozeStates(root, now, library) {
  const items = await readQueue(root);
  return new Map(items.map(item => {
    if (item.status === 'pending' && library && !current(library, item))
      return [item.key, { status: 'skipped', reason: invalidSnoozeReason(library, item) }];
    if (item.status === 'pending' && item.due_at >= now - windowSeconds)
      return [item.key, { status: item.lease_until > now ? 'processing' : 'pending', due_at: item.due_at }];
    if (item.skip_reason || item.status === 'pending') return [item.key, { status: 'skipped', reason: item.skip_reason || 'expired' }];
    return [item.key, { status: item.status === 'cancelled' ? 'cancelled' : 'done' }];
  }));
}

function invalidSnoozeReason(library, item) {
  const found = findWatchEntry(library, item.id);
  return found ? reminderBlockReason(found.entry, found.state) || 'schedule_changed' : 'removed';
}

function current(lib, item) {
  const found = findWatchEntry(lib, item.id);
  return found && (isCatchup(found.entry) ? 'catchup' : 'airing') === item.kind &&
    item.stamp === remindStamp(lib, found.entry, found.state) ? found.entry : null;
}
function matchesOccurrence(lib, w, item) {
  const at = new Date(item.slot_at * 1000);
  if (item.kind === 'catchup') return Date.parse(personalReminder(w, at)?.at) === +at;
  const slot = scheduleRow(lib, w);
  return Date.parse(nextScheduledUpdate({ ...w, air_weekday: slot?.day ?? w.air_weekday,
    air_time_cst: slot ? slot.row.time_cst : w.air_time_cst }, at, w.start_date)) === +at;
}

export async function reminderSnoozes(root, lib, input, now = Math.floor(Date.now() / 1000)) {
  const all = await readQueue(root);
  const leased = item => item.lease_until > now;
  const list = () => all.flatMap(item => {
    if (item.status !== 'pending' || leased(item) || item.due_at < now - windowSeconds) return [];
    const w = current(lib, item);
    const { claim_token, lease_until, create_token, ...pending } = item;
    return w ? [{ ...pending, name: title(w, item.id) }] : [];
  }).sort((a, b) => a.due_at - b.due_at);
  if (!input) return { pending: list() };
  const action = input.action;
  if (!['create', 'undo_create', 'delay', 'cancel', 'claim', 'ack'].includes(action)) return { code: 400, error: '未知的稍后提醒操作' };
  if (['create', 'delay'].includes(action) && !duration(input.minutes)) return { code: 400, error: '请设置 1–180 分钟' };
  const claimed = [];
  const created = [];
  if (action === 'create') {
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 40 ||
        input.items.some(item => !validId(item?.id) || !validKind(item?.kind) || !validStamp(item?.stamp) ||
          !Number.isSafeInteger(item.slot_at) || item.slot_at < now - windowSeconds || item.slot_at > now + 3600))
      return { code: 400, error: '稍后提醒档位无效或已过期' };
    if (input.items.some(item => {
      const w = current(lib, item);
      return !w || !matchesOccurrence(lib, w, item);
    })) return { code: 409, error: '原提醒已变动，请查看最新排片' };
    let available = false;
    for (const item of input.items) {
      const key = reminderSnoozeKey(item.id, item.kind, item.slot_at, item.stamp);
      const existing = all.find(row => row.key === key);
      if (existing) {
        if (existing.status === 'pending' && !leased(existing) && existing.due_at >= now - windowSeconds) available = true;
        continue;
      }
      const dueAt = now + input.minutes * 60;
      const token = randomUUID();
      all.push({ key, id: item.id, kind: item.kind, stamp: item.stamp,
        slot_at: item.slot_at, due_at: dueAt, status: 'pending', create_token: token });
      created.push({ key, due_at: dueAt, token });
      available = true;
    }
    if (!available) return { code: 409, error: '这条稍后提醒已处理、取消或正在领取，请刷新提醒记录' };
    if (!created.length) return { pending: list(), claimed, created };
  } else if (action === 'undo_create') {
    if (!validKey(input.key) || typeof input.token !== 'string' || !/^[a-f0-9-]{36}$/.test(input.token))
      return { code: 400, error: '撤销凭据无效' };
    const index = all.findIndex(item => item.key === input.key && item.create_token === input.token &&
      item.status === 'pending' && !leased(item) && item.due_at > now && current(lib, item));
    if (index < 0) return { code: 409, error: '这条稍后提醒已改动或到点，请刷新查看' };
    all.splice(index, 1);
  } else if (action === 'claim') {
    for (const item of all) {
      if (item.status !== 'pending' || leased(item) || item.due_at > now) continue;
      const w = current(lib, item);
      if (!w || item.due_at < now - windowSeconds) {
        item.status = 'done';
        item.skip_reason = !w ? invalidSnoozeReason(lib, item) : 'expired';
        delete item.claim_token;
        delete item.lease_until;
        continue;
      }
      item.lease_until = now + leaseSeconds;
      item.claim_token = randomUUID();
      delete item.create_token;
      claimed.push({ ...item, name: title(w, item.id) });
    }
  } else if (action === 'ack') {
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 256 ||
        input.items.some(item => !validKey(item?.key) || typeof item.claim_token !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(item.claim_token)))
      return { code: 400, error: '稍后提醒确认信息无效' };
    const tokens = new Map(input.items.map(item => [item.key, item.claim_token]));
    for (const item of all) {
      if (item.status !== 'pending' || !tokens.has(item.key) || tokens.get(item.key) !== item.claim_token) continue;
      item.status = 'done';
      delete item.claim_token;
      delete item.lease_until;
    }
  } else {
    const item = all.find(item => item.key === input.key && item.status === 'pending');
    if (!item || leased(item) || !current(lib, item)) return { code: 409, error: '这个提醒正在处理或已失效，请刷新' };
    if (action === 'cancel') item.status = 'cancelled';
    else item.due_at = now + input.minutes * 60;
    delete item.create_token;
    delete item.claim_token;
    delete item.lease_until;
  }
  const keep = all.filter(item => Math.max(item.due_at, item.slot_at) >= now - 86400);
  if (keep.length > 256) return { code: 409, error: '稍后提醒过多，请先清理' };
  await writeJsonAtomic(queueFile(root), keep);
  return { pending: list(), claimed, ...(action === 'create' ? { created } : {}) };
}
