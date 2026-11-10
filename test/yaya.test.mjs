// YAYA 字典生成器 + 整周排片表的单元测试（node --test）
import test from 'node:test';
import assert from 'node:assert/strict';

import { yayaText, candidate, minutesOfHHMM, checkDic } from '../tools/build_ghost.mjs';
import { allShows } from '../lib/today.mjs';
import { ghostDialogue, ghostScript } from '../lib/ghost.mjs';

test('yayaText 转义引号、反斜杠与换行', () => {
  assert.equal(yayaText("It's 100%"), "It''s 100\\%");
  assert.equal(yayaText('a\\e'), 'a\\\\e');
  assert.equal(yayaText('一\n二'), '一\\n二');
  assert.equal(yayaText('tab\there'), 'tab\there');
});

test('candidate 使用实际存在的立绘，并按表情回退', () => {
  const set = new Set([0, 1, 2, 6]);
  assert.equal(candidate({ text: '早', face: 'normal' }, set), "    '\\0\\s[0]早\\e'");
  assert.equal(candidate({ text: '嗯', face: 'bashful' }, set), "    '\\0\\s[6]嗯\\e'");
  assert.equal(candidate({ text: '唔', face: 'sleepy' }, set), "    '\\0\\s[2]唔\\e'");
  assert.equal(candidate({ text: '嗯', face: 'think' }, set), "    '\\0\\s[0]嗯\\e'");
});

test('minutesOfHHMM 容忍跨日写法，非法输入给 -1', () => {
  assert.equal(minutesOfHHMM('23:00'), 1380);
  assert.equal(minutesOfHHMM('01:05'), 65);
  assert.equal(minutesOfHHMM('25:30'), 1530);
  assert.equal(minutesOfHHMM(''), -1);
  assert.equal(minutesOfHHMM('乱写'), -1);
});

test('checkDic 通过正常字典', () => {
  const ok = [
    'OnBoot {',
    '    "\\0\\s[0]早\\e"',
    '    "\\0\\s[1]他说""好""\\e"',
    '}',
    '',
    'OnSecondChange {',
    '    if GETTYPE(x) == 0 { return }',
    '    "\\0\\s[1]%(_s[""name_cn""]) 开播了。\\e"',
    '}',
  ].join('\r\n');
  assert.deepEqual(checkDic(ok).problems, []);
  assert.deepEqual(checkDic(ok).funcs, ['OnBoot', 'OnSecondChange']);
});

test('checkDic 抓出未闭合引号', () => {
  const bad = 'OnBoot {\r\n    "\\0\\s[0]没闭合\\e\r\n}\r\n';
  assert.equal(checkDic(bad).problems.length > 0, true);
});

test('checkDic 抓出 %() 里的裸引号', () => {
  const bad = 'OnBoot {\r\n    "\\0\\s[0]%(_s["name_cn"]) 开播了\\e"\r\n}\r\n';
  const p = checkDic(bad).problems.join('\n');
  assert.match(p, /裸引号/);
});

test('checkDic 保留台词中的网址和花括号', () => {
  const text = "OnTiaraToday {\n    '\\0标题 {前传 https://example.com/a %(\"试听\")\\e'\n}";
  assert.deepEqual(checkDic(text).problems, []);
});

test('Ghost 案件簿引用可用事件，并使用最新称呼、排期和补番起点', () => {
  const lib = {
    user: { nickname_for_pet: '测试会长' },
    watching: [
      { id: 1, name_cn: '夜间番', air_weekday: 1, air_time_cst: '25:30' },
      { id: 2, name_cn: '完结番', eps: 12, ep_status: 8, start_episode: 10 },
    ],
    weekday: { 1: [{ id: 1, time_cst: '25:30' }] },
  };
  const talks = {
    boot: [{ text: '欢迎，{nickname}' }],
    todayNext: [{ text: '{name_cn}，{time_cst}', face: 'think' }],
    selfIntro: [{ text: '副会长' }],
    soft: [{ text: '……' }],
    nade: [{ text: '第 {nade_today} 次' }, { text: '……随你', face: 'happy' }],
  };
  const { events } = ghostDialogue(talks, lib, new Date('2026-11-09T16:00:00Z'), { clock: '24h' });
  const faces = new Set([0, 4, 5, 6]);
  const menu = ghostScript(events.OnMouseDoubleClick[0], faces);
  for (const [, event] of menu.matchAll(/\\q\[[^,]+,(On\w+)\]/g)) assert.ok(events[event]?.length, event);
  assert.match(ghostScript(events.OnBoot[0], faces), /欢迎，测试会长\\n.*01:30 夜间番/);
  assert.match(ghostScript(events.OnTiaraNext[0], faces), /\\s\[5\]夜间番，01:30/);
  assert.match(ghostScript(events.OnTiaraBacklog[0], faces), /完结番 · 完结待补 3 话/);
  assert.deepEqual(events.OnNadeNade, [{ text: '……随你', face: 'bashful' }]);
});

test('allShows 合并在追列表与整周排片表，按周几+时间排序去重', () => {
  const lib = {
    watching: [{ id: 1, name_cn: '在追的', air_weekday: 3, air_time_cst: '22:00' }],
    weekday: {
      1: [{ id: 2, name_cn: '周一的', time_cst: '23:00', ep_expected: 5 }],
      3: [{ id: 1, name_cn: '在追的', time_cst: '22:00' }],
    },
  };
  const list = allShows(lib);
  assert.deepEqual(list.map((s) => s.id), [2, 1]);
  assert.equal(list[0].min, 1380);
  assert.equal(list[0].ep_expected, 5);
  assert.equal(list[1].ep_expected, null);
  assert.equal(list.length, 2, '同一部番在两张表里只保留一条');
});

test('allShows 容忍空数据', () => {
  assert.deepEqual(allShows({}), []);
  assert.deepEqual(allShows({ watching: [{ id: 9, air_weekday: null }] }), []);
});
