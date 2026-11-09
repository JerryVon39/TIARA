/**
 * lib/time.mjs 的单测。
 *
 * 这一层的存在理由就是「同一个时刻串，全项目只允许一种判法」——
 * 所以重点不是 23:30 能不能过，而是 25:30 / 29:00 / 'abc' 这些边界：
 * 以前 /api/season/time 拒 25:00、/api/season/time-batch 却收，而 'abc' 两边都收。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClock, clockText, splitClock, normalizeClockOrNull, MAX_CLOCK_MINUTES } from '../lib/time.mjs';

test('parseClock：正常时刻 + 规范化补零', () => {
  const a = parseClock('23:30');
  assert.equal(a.ok, true);
  assert.equal(a.minutes, 1410);
  assert.equal(a.text, '23:30');
  // 9:05 要补成 09:05，否则字符串排序会把 9 点排到 10 点后面
  const b = parseClock('9:05');
  assert.equal(b.ok, true);
  assert.equal(b.text, '09:05');
  assert.equal(b.minutes, 545);
});

test('parseClock：30 小时制跨日写法合法（25:30 = 次日 01:30）', () => {
  const r = parseClock('25:30');
  assert.equal(r.ok, true);
  assert.equal(r.minutes, 1530);
  assert.equal(r.text, '25:30');
  assert.deepEqual(splitClock(r.minutes), { dayOffset: 1, hhmm: '01:30' });
  // 上界刚好 28:59
  assert.equal(parseClock('28:59').ok, true);
  assert.equal(parseClock('28:59').minutes, MAX_CLOCK_MINUTES);
});

test('parseClock：非法串一律拒绝（含旧实现会静默收下的 abc）', () => {
  for (const bad of ['abc', '24:60', '29:00', '2:3', '23:3', '23:30:00', '－1:00', '', '   ', null, undefined, 2330]) {
    const r = parseClock(bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 必须被拒`);
    assert.ok(r.error, '拒绝时要带一句人话，面板直接显示它');
  }
});

test('clockText / splitClock：越界与非法输入不炸', () => {
  assert.equal(clockText(0), '00:00');
  assert.equal(clockText(1410), '23:30');
  assert.equal(clockText(-30), '00:00');
  assert.equal(clockText('abc'), '00:00');
  assert.deepEqual(splitClock(1440), { dayOffset: 1, hhmm: '00:00' });
  assert.deepEqual(splitClock(0), { dayOffset: 0, hhmm: '00:00' });
});

test('normalizeClockOrNull：合法返回规范串，非法给 null（清空时刻用）', () => {
  assert.equal(normalizeClockOrNull('7:05'), '07:05');
  assert.equal(normalizeClockOrNull('25:30'), '25:30');
  assert.equal(normalizeClockOrNull('abc'), null);
  assert.equal(normalizeClockOrNull(null), null);
  assert.equal(normalizeClockOrNull(undefined), null);
});
