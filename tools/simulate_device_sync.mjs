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

const merged = mergeDeviceTrials(a, b);
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

console.log(JSON.stringify({
  replicas: 2, entries: Object.keys(merged.entries).length, operations: merged.operations.length,
  exchange_bytes: Buffer.byteLength(JSON.stringify(merged.operations)),
  conflicts: merged.conflicts.map(item => item.field), resolved_progress: resolved.entries['700888'].progress,
}, null, 2));
