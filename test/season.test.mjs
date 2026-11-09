import test from 'node:test';
import assert from 'node:assert/strict';

import { seasonOf, seasonRange, weekdayFromInfobox, subjectMeta, mergeSeason } from '../lib/bgm.mjs';
import { expectedEpisode } from '../lib/today.mjs';

test('seasonOf：季度名 / 日期 / Date 都能认', () => {
  assert.equal(seasonOf('2026Q4'), '2026Q4');
  assert.equal(seasonOf('2026q1'), '2026Q1');
  assert.equal(seasonOf('2026-10-05'), '2026Q4');
  assert.equal(seasonOf('2026-02-01'), '2026Q1');
  assert.equal(seasonOf(new Date('2026-11-04T12:00:00+08:00')), '2026Q4');
});

test('seasonRange：窗口是 [本季首日, 下季首日)', () => {
  assert.deepEqual(seasonRange('2026Q4'), { q: '2026Q4', from: '2026-10-01', to: '2027-01-01' });
  assert.deepEqual(seasonRange('2026Q2'), { q: '2026Q2', from: '2026-04-01', to: '2026-07-01' });
  assert.deepEqual(seasonRange('2025-12-31'), { q: '2025Q4', from: '2025-10-01', to: '2026-01-01' });
});

test('weekdayFromInfobox：抠得出「放送星期」，抠不出就 null', () => {
  assert.equal(weekdayFromInfobox({ infobox: [{ key: '放送星期', value: '星期五' }] }), 5);
  assert.equal(weekdayFromInfobox({ infobox: [{ key: '放送星期', value: [{ v: '周日' }, { v: '星期日' }] }] }), 7);
  assert.equal(weekdayFromInfobox({ infobox: [{ key: '话数', value: '12' }] }), null);
  assert.equal(weekdayFromInfobox({}), null);
});

test('subjectMeta：统一结构，缺字段不炸', () => {
  const m = subjectMeta({ id: 1, name: 'A', name_cn: '甲', date: '2026-10-02', eps: 12, rating: { score: 7.2 }, infobox: [{ key: '放送星期', value: '星期五' }] });
  assert.equal(m.id, 1);
  assert.equal(m.name_cn, '甲');
  assert.equal(m.weekday, 5);
  assert.equal(m.rating, 7.2);
  const bare = subjectMeta({ id: 2, name: 'B' });
  assert.equal(bare.name_cn, 'B');
  assert.equal(bare.eps, 0);
  assert.equal(bare.weekday, null);
});

const items = [
  { id: 1, name: 'A', name_cn: '甲', eps: 12, weekday: 5, date: '2026-10-02' },
  { id: 2, name: 'B', name_cn: '乙', eps: 10, weekday: null, date: '2026-10-09' },
];

test('mergeSeason：勾选 → 进在追 + 补星期表', () => {
  const lib = { watching: [], weekday: {} };
  const { next, changes } = mergeSeason(lib, items, { add: ['1'], now: new Date('2026-11-04T12:00:00+08:00') });
  assert.equal(next.watching.length, 1);
  assert.equal(next.watching[0].ep_status, 0);
  assert.equal(next.watching[0].air_weekday, 5);
  assert.equal(next.watching[0].start_date, '2026-10-02');
  assert.equal(next.watching[0].track_from, '2026-11-04');
  assert.equal(next.weekday['5'].length, 1);
  assert.ok(changes.some((c) => c.field === '(新增)'));
});

test('mergeSeason：没星期的番只进在追，不进星期表', () => {
  const lib = { watching: [], weekday: {} };
  const { next } = mergeSeason(lib, items, { add: ['2'] });
  assert.equal(next.watching.length, 1);
  assert.equal(Object.keys(next.weekday).length, 0);
});

test('mergeSeason：重复勾选不重复入库', () => {
  const lib = { watching: [{ id: 1, name_cn: '甲', eps: 12, ep_status: 3 }], weekday: {} };
  const { next, changes } = mergeSeason(lib, items, { add: ['1'] });
  assert.equal(next.watching.length, 1);
  assert.equal(next.watching[0].ep_status, 3);
  assert.ok(changes.some((c) => c.field === '(已在追)'));
});

test('mergeSeason：退追进 dropped，再追能接回原进度', () => {
  const lib = { watching: [{ id: 1, name_cn: '甲', eps: 12, ep_status: 7, air_weekday: 5 }], weekday: { 5: [{ id: 1, name_cn: '甲', time_cst: null }] } };
  const off = mergeSeason(lib, items, { remove: ['1'] });
  assert.equal(off.next.watching.length, 0);
  assert.equal(off.next.dropped.length, 1);
  assert.equal(off.next.dropped[0].ep_status, 7);

  const back = mergeSeason(off.next, items, { add: ['1'] });
  assert.equal(back.next.watching.length, 1);
  assert.equal(back.next.watching[0].ep_status, 7);
  assert.equal(back.next.dropped.length, 0);
});

test('track_from：加入前播掉的集数不算欠账', () => {
  const lib = { weekday: { 5: [{ id: 9, name_cn: '甲', time_cst: '23:00' }] }, watching: [] };
  const w = { id: 9, eps: 12, air_weekday: 5, start_date: '2026-10-02', ep_status: 0, track_from: '2026-11-04' };
  // 11-06 周五 = 第 6 话的播出日；从 11-04 才开始追，只欠这一话
  const e = expectedEpisode(w, lib, new Date('2026-11-06T12:00:00+08:00'));
  assert.equal(e, 1);
  // 没有 track_from 的话应该算出 5（说明钳位真的起作用了）
  const raw = expectedEpisode({ ...w, track_from: null }, lib, new Date('2026-11-06T12:00:00+08:00'));
  assert.equal(raw, 5);
});
