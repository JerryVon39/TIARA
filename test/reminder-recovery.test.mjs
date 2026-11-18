import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('补发快照包含跨午夜的上一天档位，并沿用临时调档和追番状态', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tiara-reminder-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data'));
  const airing = (id, fields = {}) => ({ id, name_cn: id, eps: 12, ep_status: 2, air_weekday: 6, ...fields });
  const personal = (id, day, time, fields = {}) => ({
    id, name_cn: id, watch_mode: 'catchup', catchup_slot: { day, time }, ...fields,
  });
  const previous = '2026-11-14';
  const current = '2026-11-15';
  const move = { date: previous, original_at: '2026-11-14T13:00:00.000Z', at: '2026-11-14T16:05:00.000Z' };
  const lib = {
    watching: [
      airing('airing'), airing('late'), airing('moved', { schedule_adjustments: [move] }),
      airing('finished', { ep_status: 12 }), airing('new', { track_from: current }),
      personal('catchup', 6, '22:00'), personal('today-catchup', 7, '00:30'),
      personal('new-catchup', 6, '22:15', { track_from: current }),
      airing('after-midnight', { air_weekday: 7, air_time_cst: '24:15' }),
    ],
    paused: [airing('paused')],
    weekday: { 7: [{ id: 'after-midnight', time_cst: '24:15' }], 6: [
      { id: 'airing', time_cst: '23:25' }, { id: 'late', time_cst: '25:30' },
      { id: 'moved', time_cst: '21:00' }, { id: 'finished', time_cst: '22:00' },
      { id: 'new', time_cst: '22:00' }, { id: 'paused', time_cst: '23:00' },
      { id: 'untracked', time_cst: '23:00' },
    ] },
  };
  await fs.writeFile(path.join(root, 'data/library.json'), JSON.stringify(lib));
  await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../tools/build_today.mjs', import.meta.url)),
    '--root', root, '--date', current], { windowsHide: true });
  const raw = await fs.readFile(path.join(root, 'ghost/master/today.txt'), 'utf8');
  const vars = Object.fromEntries(raw.split(/\r?\n/).filter(line => /^[\w]+=/.test(line)).map(line => line.split('=')));
  const rows = prefix => Object.keys(vars).filter(key => new RegExp('^' + prefix + '\\d+_id$').test(key)).map(key => {
    const row = key.slice(0, -3);
    return [vars[key], new Date(Number(vars[row + '_unix']) * 1000).toISOString(), vars[row + '_personal']];
  }).sort((a, b) => a[0].localeCompare(b[0]));
  assert.equal(vars.previous_date, previous);
  assert.equal(vars.previous_count, '2');
  assert.deepEqual(rows('previous'), [
    ['airing', '2026-11-14T15:25:00.000Z', '0'], ['catchup', '2026-11-14T14:00:00.000Z', '1'],
  ]);
  assert.deepEqual(rows('show'), [
    ['late', '2026-11-14T17:30:00.000Z', undefined], ['moved', move.at, undefined],
  ]);
  assert.deepEqual(rows('personal'), [['today-catchup', '2026-11-14T16:30:00.000Z', undefined]]);
  assert.deepEqual(rows('next'), [['after-midnight', '2026-11-15T16:15:00.000Z', '0']]);
  assert.match(vars.next1_stamp, /^[a-f0-9]{24}$/);
});
