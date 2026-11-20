#!/usr/bin/env node
import assert from 'node:assert/strict';
import { deviceTrialChange, mergeDeviceTrials } from '../lib/device-sync-trial.mjs';

let seed = deviceTrialChange('desktop-a', [], '700888',
  { title: '合成测试番', state: 'watching', progress: { seen: 2 } });
seed = deviceTrialChange('desktop-a', seed, '700889',
  { title: '第二个合成条目', state: 'planned', progress: { seen: 0 } });
let a = deviceTrialChange('desktop-a', seed, '700888', { progress: { seen: 4 } });
a = deviceTrialChange('desktop-a', a, '700889', { deleted: true });
let b = deviceTrialChange('laptop-b', seed, '700888', { progress: { seen: 3, extra: [5] } });
b = deviceTrialChange('laptop-b', b, '700888', { schedule: { day: 2, clock: '25:10' } });
b = deviceTrialChange('laptop-b', b, '700889', { state: 'watching' });

const beforePreview = JSON.stringify([a, b]);
const merged = mergeDeviceTrials(a, b);
assert.equal(JSON.stringify([a, b]), beforePreview, 'Preview must leave both device logs unchanged');
assert.deepEqual(mergeDeviceTrials(b, a), merged);
assert.deepEqual(mergeDeviceTrials(merged.operations, a), merged);
assert.equal(merged.entries['700889'].deleted, true);
assert.deepEqual(merged.entries['700888'].schedule, { day: 2, clock: '25:10' });
assert.deepEqual(merged.conflicts.map(item => item.field), ['progress', 'deleted-edit']);
const chosen = deviceTrialChange('desktop-a', merged.operations, '700888', { progress: { seen: 4, extra: [5] } });
const resolved = mergeDeviceTrials(chosen, b);
assert.deepEqual(resolved.entries['700888'].progress, { seen: 5, extra: [] });
assert.throws(() => deviceTrialChange('desktop-a', resolved.operations, '700888', { token: 'fixture' }), /未允许迁移/);
assert.equal(resolved.conflicts.filter(item => item.field === 'progress').length, 0);
const previous = mergeDeviceTrials(a).entries['700888'].progress;
const undo = deviceTrialChange('desktop-a', resolved.operations, '700888', { progress: previous });
const rolledBack = mergeDeviceTrials(undo, b, undo);
assert.deepEqual(rolledBack.entries['700888'].progress, previous);
assert.deepEqual(rolledBack.entries['700888'].schedule, { day: 2, clock: '25:10' });
assert.equal(rolledBack.entries['700889'].deleted, true);
const peerUpdate = deviceTrialChange('laptop-b', resolved.operations, '700888', { progress: { seen: 6 } });
assert.ok(mergeDeviceTrials(undo, peerUpdate).conflicts.some(item => item.field === 'progress'),
  'A concurrent device edit cannot be silently overwritten by undo');

console.log(JSON.stringify({
  replicas: 2, entries: Object.keys(merged.entries).length, operations: merged.operations.length,
  exchange_bytes: Buffer.byteLength(JSON.stringify(merged.operations)),
  conflicts: merged.conflicts.map(item => item.field), resolved_progress: resolved.entries['700888'].progress,
  preview_read_only: true, undone_progress: rolledBack.entries['700888'].progress, concurrent_undo_conflict: true,
}, null, 2));
