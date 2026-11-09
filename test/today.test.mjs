/**
 * test/today.test.mjs — 日程计算单测（node --test）
 * 把审计时手验过的几个坑固化成用例：跨日写法、空 weekday、ep_expected 缺省、播没播的判断。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { cstParts, toMin, minutesOfDay, expectedEpisode, buildToday, timeline, WEEK_CN, displayClock, reminders, allShows } from '../lib/today.mjs';

const lib = () => ({
  user: { nickname_for_pet: '主人' },
  watching: [
    { id: 1, name_cn: '在追的', eps: 12, ep_status: 3, air_weekday: 2, air_time_cst: '22:30', priority: '在追' },
    { id: 2, name_cn: '周五的重头戏', eps: 24, ep_status: 18, air_weekday: 5, air_time_cst: '23:00', priority: '必追' },
    { id: 3, name_cn: '已完结', eps: 13, ep_status: 13, air_weekday: null, air_time_cst: null, priority: '补完' }
  ],
  weekday: {
    2: [{ id: 1, name_cn: '在追的', time_cst: '22:30', ep_expected: 4 }],
    5: [{ id: 2, name_cn: '周五的重头戏', time_cst: '23:00', ep_expected: 19 }],
    6: []
  },
  trivia: { quote_of_today: '追番不是任务，是给明天留个期待。' }
});

test('cstParts：UTC 2016-11-04T20:00Z 是 CST 11-05 04:00（周五）', () => {
  const p = cstParts(new Date('2026-11-04T20:00:00Z'));
  assert.equal(p.date, '2026-11-05');
  assert.equal(p.weekday, 4);
  assert.equal(p.hour, 4);
});

test('toMin / minutesOfDay：容忍 25:30 这种跨日写法', () => {
  assert.equal(toMin('23:00'), 23 * 60);
  assert.equal(minutesOfDay('25:30'), 25 * 60 + 30);
  assert.equal(toMin(''), 24 * 60 + 1, '非法值排到最后');
});

test('expectedEpisode：手工 ep_expected 优先，并按「本周播没播」修正', () => {
  const now = new Date('2026-11-06T23:30:00+08:00');   // 周五已过点
  assert.equal(expectedEpisode(lib().watching[1], lib(), now), 19);
  const before = new Date('2026-11-06T22:00:00+08:00'); // 周五还没到点
  assert.equal(expectedEpisode(lib().watching[1], lib(), before), 18);
});

test('expectedEpisode：没有 ep_expected 也没有 start_date 时返回 null（不瞎猜）', () => {
  const l = lib();
  l.watching[0].air_weekday = 3;   // 周三，但周表里没有它
  const w = l.watching[0];
  assert.equal(expectedEpisode(w, l, new Date('2026-11-04T12:00:00+08:00')), null);
});

test('buildToday：周三没有番，落后者照样能算出来（behindAll）', () => {
  const t = buildToday(lib(), new Date('2026-11-04T12:00:00+08:00'));
  assert.equal(t.weekday_cn, '周三');
  assert.equal(t.today.length, 0);
  assert.equal(t.behind.length, 0, '今天没番就没有「今日落后」');
  const ids = t.behindAll.map((x) => String(x.id));
  assert.ok(ids.includes('1'), '周二的番应该算落后');
  assert.ok(!ids.includes('2'), '周五的番本话还没播，这周不算落后');
  assert.ok(!ids.includes('3'), '已完结的不该算落后');

  // 到了周六，周五那话就算播过了 → 该显示落后 1 话
  const sat = buildToday(lib(), new Date('2026-11-07T12:00:00+08:00'));
  const satIds = sat.behindAll.map((x) => String(x.id));
  assert.ok(satIds.includes('2'), '周五的番在周六应该算落后');
});

test('buildToday：周五当天能排出重头戏，并带上已播标记', () => {
  const t = buildToday(lib(), new Date('2026-11-06T23:30:00+08:00'));
  assert.equal(t.today.length, 1);
  assert.equal(t.today[0].id, 2);
  assert.equal(t.today[0].aired, true);
});

test('timeline：给出「下一部」和「已播完的最后一部」', () => {
  const t = buildToday(lib(), new Date('2026-11-06T12:00:00+08:00'));
  const tl = timeline(t.today, new Date('2026-11-06T12:00:00+08:00'));
  assert.equal(tl.next && tl.next.id, 2);
  assert.equal(tl.last, null);
});

test('WEEK_CN：七个名字都在', () => {
  assert.equal(WEEK_CN[1], '周一');
  assert.equal(WEEK_CN[7], '周日');
});

test('displayClock：30 小时制把 01:00 写成前一天 25:00', () => {
  const d = displayClock('01:00', 5, '30h');
  assert.equal(d.time_disp, '25:00');
  assert.equal(d.weekday_disp, 4);
  assert.equal(d.time, '01:00');       // 原字段不动
  assert.equal(d.shifted, true);
});

test('displayClock：05:00 之后不挪，24 小时制一律不挪', () => {
  assert.equal(displayClock('05:00', 5, '30h').time_disp, '05:00');
  assert.equal(displayClock('01:00', 5, '24h').time_disp, '01:00');
  assert.equal(displayClock('01:00', 5, '24h').weekday_disp, 5);
});

test('displayClock：周一的深夜档回退到周日 25:00', () => {
  const d = displayClock('00:30', 1, '30h');
  assert.equal(d.time_disp, '24:30');
  assert.equal(d.weekday_disp, 7);
});

test('buildToday：opts.clock 影响派生出的 disp 字段', () => {
  const l = lib();
  l.weekday['5'] = [{ id: 9, name_cn: '深夜档', time_cst: '01:00', ep_expected: 3 }];
  // 9 号不在 watching 里，会落到 side（本季放送表），能推位移的字段照样要算出来
  const t30 = buildToday(l, new Date('2026-11-06T12:00:00+08:00'), { clock: '30h' });
  const item = t30.side.find((x) => x.id === 9);
  assert.equal(item.time_disp, '25:00');
  assert.equal(item.weekday_disp, 4);
  const t24 = buildToday(l, new Date('2026-11-06T12:00:00+08:00'), { clock: '24h' });
  assert.equal(t24.side.find((x) => x.id === 9).time_disp, '01:00');
});

test('buildToday：不在在追名单里的放送表条目落到 side，不进今日清单', () => {
  const l = lib();
  l.weekday['5'] = [
    { id: 9, name_cn: '别人家的番', time_cst: '01:00' },
    { id: 2, name_cn: '周五的重头戏', time_cst: '23:00', ep_expected: 19 }
  ];
  const t = buildToday(l, new Date('2026-11-06T12:00:00+08:00'));
  assert.deepEqual(t.today.map((x) => x.id), [2]);
  assert.deepEqual(t.side.map((x) => x.id), [9]);
});

test('首播推算在跨周后不倒退，下次开播前后只增加一次', () => {
  const l = lib();
  const w = { ...l.watching[1], start_date: '2026-11-06', eps: 12, ep_status: 0 };
  l.watching = [w];
  delete l.weekday[5][0].ep_expected;
  for (const [date, count] of [
    ['2026-11-06T22:59:00', 0], ['2026-11-06T23:00:00', 1],
    ['2026-11-09T12:00:00', 1], ['2026-11-13T22:59:00', 1], ['2026-11-13T23:00:00', 2],
  ]) assert.equal(expectedEpisode(w, l, new Date(date + '+08:00')), count, date);
});

test('广播日 25:30 在次日提醒，跨周/跨月/跨年都保留；原数据不变', () => {
  for (const day of ['2026-11-08', '2026-11-30', '2026-12-31']) {
    const first = new Date(day + 'T12:00:00+08:00');
    const wd = cstParts(first).weekday;
    const l = { watching: [{ id: 9, eps: 12, ep_status: 0, air_weekday: wd, air_time_cst: '25:30', start_date: day }],
      weekday: { [wd]: [{ id: 9, time_cst: '25:30' }] } };
    const before = JSON.stringify(l);
    const air = new Date(+first + 13.5 * 3600000);
    const t = buildToday(l, air);
    assert.equal(t.today[0].id, 9);
    assert.equal(t.today[0].time_cst, '01:30');
    assert.equal(t.today[0].time_disp, '25:30');
    assert.equal(t.today[0].expected_eps, 1);
    assert.equal(reminders(t.today, air)[0].minutes_left, 0);
    assert.equal(allShows(l)[0].min, 90);
    assert.equal(allShows(l)[0].weekday, wd === 7 ? 1 : wd + 1);
    assert.equal(buildToday(l, first).today.length, 0);
    assert.equal(JSON.stringify(l), before);
  }
});
