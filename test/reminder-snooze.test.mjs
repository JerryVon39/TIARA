import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readLibrary, writeLibrary } from '../lib/library.mjs';
import { remindStamp, reminderSnoozeStates, reminderSnoozes } from '../lib/reminder-snooze.mjs';
import { findWatchEntry, moveWatchEntry } from '../lib/watch-lifecycle.mjs';
import { quietAt, reminderPreview } from '../lib/watch-schedule.mjs';

const saturday = Date.parse('2026-11-21T00:30:00+08:00') / 1000;

test('工作日跨午夜到周末，反向亦按开始那天计算，兼容旧的每日规则', () => {
  const quiet = (rules, timestamp) => quietAt(rules, new Date(timestamp + ':00+08:00'));
  const weekdays = { quiet_work_start: '22:00', quiet_work_end: '06:00', quiet_weekend_start: '23:30', quiet_weekend_end: '01:00' };
  assert.equal(quiet(weekdays, '2026-11-21T05:59'), true, '周六清晨仍按周五结束时刻');
  assert.equal(quiet(weekdays, '2026-11-21T06:00'), false);
  assert.equal(quiet(weekdays, '2026-11-23T00:59'), true, '周一凌晨沿用周日晚');
  assert.equal(quiet(weekdays, '2026-11-23T01:30'), false, '不能倒用周一晚的时段');
  assert.equal(quiet(weekdays, '2026-11-21T23:29'), false);
  assert.equal(quiet(weekdays, '2026-11-21T23:30'), true);
  assert.equal(quiet({ quiet_start: '23:00', quiet_end: '06:00' }, '2026-11-21T02:00'), true);
});

test('预览分别显示免打扰的档位、已延后的时刻和下一次可提示档', () => {
  const now = new Date('2026-11-20T23:50:00+08:00');
  const entry = { id: 'sample', watch_mode: 'catchup', catchup_slot: { day: 6, time: '00:30' }, reminder_lead: 30 };
  const settings = { reminder_lead: 0, quiet_work_start: '23:00', quiet_work_end: '06:00' };
  const dueAt = Date.parse('2026-11-21T07:00:00+08:00');
  const preview = reminderPreview(entry, settings, { now, snoozes: [{ id: entry.id, due_at: dueAt / 1000 }] });
  assert.equal(preview.inherited, false);
  assert.equal(preview.first.at, '2026-11-20T16:00:00.000Z');
  assert.equal(preview.reason, 'quiet_work');
  assert.deepEqual(preview.next, { kind: 'snooze', at: new Date(dueAt).toISOString(), reason: null });
  assert.equal(reminderPreview(entry, settings, { now }).next, null);
  const temporary = reminderPreview({ ...entry, reminder_lead: 0 }, { reminder_lead: 30 }, {
    now, quietUntil: Date.parse('2026-11-21T01:00:00+08:00') / 1000,
  });
  assert.equal(temporary.lead, 0);
  assert.equal(temporary.reason, 'temporary_quiet');
  assert.equal(temporary.next.at, '2026-11-27T16:30:00.000Z');
  assert.equal(reminderPreview({ ...entry, reminder_muted: true }, settings, { now }).reason, 'muted');
  assert.equal(reminderPreview(entry, settings, { now: new Date('2026-11-21T00:05:00+08:00') }).reason, 'time_passed');
  const handled = reminderPreview({ ...entry, reminder_lead: 0 }, {}, {
    now: new Date('2026-11-21T00:05:00+08:00'), scanned: new Set(['2026-11-21|catchup|sample|' + saturday]),
  });
  assert.equal(handled.reason, 'already_processed');
  assert.equal(handled.next.at, '2026-11-27T16:30:00.000Z');
});

test('稍后提醒可延后、取消、超时重领和确认，暂停恢复及改期使旧档失效', async t => {
  const tmp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tmp, 'tiara-snooze-test-'));
  t.after(async () => {
    const real = await fs.realpath(root);
    if (path.dirname(real) === tmp && path.basename(real).startsWith('tiara-snooze-test-')) await fs.rm(real, { recursive: true });
  });
  let lib = { watching: [
    { id: 'first', name_cn: '跨日开播', ep_status: 2, eps: 10, air_weekday: 5, air_time_cst: '24:30' },
    { id: 'second', name_cn: '补番', ep_status: 3, eps: 10, watch_mode: 'catchup', catchup_slot: { day: 6, time: '00:30' } },
    { id: 'third', name_cn: '会改期', ep_status: 1, eps: 10, air_weekday: 5, air_time_cst: '24:30' },
    { id: 'fourth', name_cn: '被取消', ep_status: 0, eps: 3, air_weekday: 5, air_time_cst: '24:30' },
  ], weekday: { 5: ['first', 'third', 'fourth'].map(id => ({ id, time_cst: '24:30' })) } };
  await writeLibrary(root, lib);
  const items = lib.watching.map(w => ({
    id: w.id, stamp: remindStamp(lib, w), slot_at: saturday, kind: w.watch_mode === 'catchup' ? 'catchup' : 'airing',
  }));
  assert.equal((await reminderSnoozes(root, lib, { action: 'create', minutes: 15,
    items: [{ ...items[0], slot_at: saturday + 60 }] }, saturday)).code, 409);
  const created = await reminderSnoozes(root, lib, { action: 'create', items, minutes: 15 }, saturday);
  assert.equal(created.pending.length, 4);
  const key = id => created.pending.find(row => row.id === id).key;
  const repeated = await reminderSnoozes(root, lib, { action: 'create', items: [items[1]], minutes: 30 }, saturday + 45);
  assert.equal(repeated.pending.find(row => row.key === key('second')).due_at, saturday + 15 * 60);
  const delay = await reminderSnoozes(root, lib, { action: 'delay', minutes: 30, key: key('second') }, saturday + 60);
  assert.equal(delay.pending.find(row => row.id === 'second').due_at, saturday + 31 * 60);
  await reminderSnoozes(root, lib, { action: 'cancel', key: key('fourth') }, saturday + 61);
  assert.equal((await reminderSnoozes(root, lib, { action: 'create', items: [items[3]], minutes: 15 }, saturday + 70)).code, 409);
  assert.deepEqual((await reminderSnoozeStates(root, saturday + 70)).get(key('fourth')), { status: 'cancelled' });
  moveWatchEntry(lib, findWatchEntry(lib, 'first'), 'pause');
  await writeLibrary(root, lib);
  moveWatchEntry(lib, findWatchEntry(lib, 'first'), 'resume');
  lib.weekday[5].find(row => row.id === 'third').time_cst = '24:45';
  await writeLibrary(root, lib);
  lib = await readLibrary(root);
  assert.deepEqual((await reminderSnoozes(root, lib, null, saturday + 80)).pending.map(row => row.id), ['second']);
  assert.equal((await reminderSnoozes(root, lib, { action: 'create', items: [items[0]], minutes: 15 }, saturday + 80)).code, 409);
  const due = await reminderSnoozes(root, lib, { action: 'claim' }, saturday + 32 * 60);
  assert.deepEqual(due.claimed.map(row => row.id), ['second']);
  assert.equal((await reminderSnoozes(root, lib, { action: 'claim' }, saturday + 33 * 60)).claimed.length, 0);
  const retried = await reminderSnoozes(root, lib, { action: 'claim' }, saturday + 34 * 60);
  assert.deepEqual(retried.claimed.map(row => row.id), ['second']);
  assert.notEqual(retried.claimed[0].claim_token, due.claimed[0].claim_token);
  await reminderSnoozes(root, lib, { action: 'ack', items: due.claimed }, saturday + 34 * 60);
  const current = await reminderSnoozes(root, lib, { action: 'claim' }, saturday + 36 * 60);
  assert.equal(current.claimed.length, 1, '旧领取凭据不能确认新的领取');
  await reminderSnoozes(root, lib, { action: 'ack', items: current.claimed }, saturday + 36 * 60);
  assert.equal((await reminderSnoozes(root, lib, { action: 'claim' }, saturday + 38 * 60)).claimed.length, 0);
  assert.equal((await reminderSnoozes(root, lib, { action: 'create', items: [items[1]], minutes: 15 }, saturday + 38 * 60)).code, 409);
  assert.deepEqual((await reminderSnoozeStates(root, saturday + 38 * 60)).get(key('second')), { status: 'done' });
});

test('逐部撤销延后只移除该次新建的稍后提醒', async t => {
  const tmp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(tmp, 'tiara-snooze-undo-'));
  t.after(() => fs.rm(root, { recursive: true }));
  const watching = ['a', 'b'].map(id => ({
    id, watch_mode: 'catchup', catchup_slot: { day: 6, time: '00:30' },
  }));
  const library = { watching };
  const items = watching.map(w => ({ id: w.id, kind: 'catchup', slot_at: saturday, stamp: remindStamp(library, w) }));
  await fs.mkdir(path.join(root, 'data'));
  const queueFile = path.join(root, 'data', 'reminder-snoozes.json');
  const existing = await reminderSnoozes(root, library, { action: 'create', minutes: 30, items: [items[1]] }, saturday);
  // 模拟升级前保存的延后记录。
  await fs.writeFile(queueFile, JSON.stringify(existing.pending));
  const send = (input, now = saturday) => reminderSnoozes(root, library, input, now);
  const create = (minutes, selected = items) => send({ action: 'create', minutes, items: selected });
  const undo = (receipt, now) => send({ action: 'undo_create', ...receipt }, now);
  const first = await create(15);
  assert.deepEqual(first.pending.map(row => [row.id, row.due_at]), [['a', saturday + 900], ['b', saturday + 1800]]);
  assert.equal(first.pending.some(row => Object.hasOwn(row, 'create_token')), false);
  assert.equal(first.created.length, 1);
  assert.deepEqual((await create(60)).created, []);
  assert.equal((await undo(existing.created[0])).code, 409);
  assert.equal((await undo({ ...first.created[0], token: '00000000-0000-0000-0000-000000000000' })).code, 409);
  assert.deepEqual((await undo(first.created[0])).pending.map(row => [row.id, row.due_at]), [['b', saturday + 1800]]);
  const second = (await create(15, [items[0]])).created[0];
  assert.equal(second.key, first.created[0].key);
  assert.notEqual(second.token, first.created[0].token);
  assert.equal((await undo(first.created[0])).code, 409);
  assert.equal((await undo(second, saturday + 900)).code, 409);
  await send({ action: 'delay', key: second.key, minutes: 5 });
  assert.equal((await undo(second)).code, 409);
  assert.deepEqual((await send({ action: 'claim' }, saturday + 300)).claimed.map(row => row.id), ['a']);
  assert.equal((await undo(second, saturday + 300)).code, 409);
});
