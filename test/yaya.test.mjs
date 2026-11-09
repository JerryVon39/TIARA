// YAYA 字典生成器 + 整周排片表的单元测试（node --test）
import test from 'node:test';
import assert from 'node:assert/strict';

import { yayaText, candidate, minutesOfHHMM, checkDic } from '../tools/build_yaya.mjs';
import { allShows } from '../lib/today.mjs';

test('yayaText 转义引号、反斜杠与换行', () => {
  assert.equal(yayaText('他说"好"'), '他说""好""');
  assert.equal(yayaText('a\\e'), 'a\\\\e');
  assert.equal(yayaText('一\n二'), '一\\n二');
  assert.equal(yayaText('tab\there'), 'tab\there');
});

test('candidate 输出 4 空格缩进的 \\0\\s[face] 候选行', () => {
  const set = new Set([0, 2]);
  assert.equal(candidate({ text: '早', face: 'normal' }, set), '    "\\0\\s[0]早\\e"');
  assert.equal(candidate({ text: '嗯', face: 'sad' }, set), '    "\\0\\s[2]嗯\\e"');
  // 表情文件不存在时退回 normal
  assert.equal(candidate({ text: '嗯', face: 'think' }, set), '    "\\0\\s[0]嗯\\e"');
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
