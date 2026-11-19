import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readLibrary, writeLibrary } from '../lib/library.mjs';
import { remindStamp, reminderSnoozes } from '../lib/reminder-snooze.mjs';
import { findWatchEntry, moveWatchEntry } from '../lib/watch-lifecycle.mjs';
import { quietAt } from '../lib/watch-schedule.mjs';

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
  const delay = await reminderSnoozes(root, lib, { action: 'delay', minutes: 30, key: key('second') }, saturday + 60);
  assert.equal(delay.pending.find(row => row.id === 'second').due_at, saturday + 31 * 60);
  await reminderSnoozes(root, lib, { action: 'cancel', key: key('fourth') }, saturday + 61);
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
});
