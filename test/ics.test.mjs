import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIcs, icsText, icsStamp, foldLine, timeToMinutes } from '../lib/ics.mjs';

const EV = {
  uid: 'kx-2026-11-05-400602@tiara.local',
  date: '2026-11-05',
  time: '23:30',
  summary: '药屋少女的呢喃 第二季 第19话',
  description: '由 TIARA 生成 · 本地番组表',
};

test('转义：反斜杠 / 分号 / 逗号 / 换行', () => {
  assert.equal(icsText('a\\b;c,d\ne'), 'a\\\\b\\;c\\,d\\ne');
  assert.equal(icsText(null), '');
});

test('DTSTAMP 是真实 UTC 瞬时（不再 +8 小时）', () => {
  // 2026-11-05T01:30:00+08:00 === 2026-11-04T17:30:00Z
  // 旧实现先 +8h 再打 Z，等于把 DTSTAMP 标成 8 小时后，日历端会说「上次更新在未来」。
  assert.equal(icsStamp(new Date('2026-11-05T01:30:00+08:00')), '20261104T173000Z');
  assert.equal(icsStamp(new Date('2026-11-04T17:30:00Z')), '20261104T173000Z');
});

test('折行：超过 75 字节按 UTF-8 边界续行，汉字不被切碎', () => {
  assert.equal(foldLine('SUMMARY:短'), 'SUMMARY:短');
  const long = 'DESCRIPTION:' + '药'.repeat(40);          // 12 + 120 字节
  const folded = foldLine(long);
  assert.ok(folded.includes('\r\n '), '长行必须折');
  const back = folded.replace(/\r\n /g, '');              // 还原后应与原文一致
  assert.equal(back, long);
  for (const line of folded.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `折完每行 ≤75 字节：${line}`);
    assert.ok(!line.includes('\uFFFD'), '不能切出半个汉字');
  }
});

test('时刻解析：合法 / 跨日 / 非法', () => {
  assert.equal(timeToMinutes('23:30'), 1410);
  assert.equal(timeToMinutes('25:30'), 1530);
  assert.equal(timeToMinutes('24:00'), 1440);
  assert.equal(timeToMinutes(''), null);
  assert.equal(timeToMinutes('7:60'), null);
  assert.equal(timeToMinutes('abc'), null);
});

test('生成的事件带 VALARM，且用 CRLF 分隔', () => {
  const ics = buildIcs([EV], { now: new Date('2026-11-05T01:00:00+08:00') });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.trimEnd().endsWith('END:VCALENDAR'));
  assert.ok(!/[^\r]\n/.test(ics), '每一行都必须以 \\r\\n 结尾');
  assert.match(ics, /BEGIN:VEVENT\r\n/);
  assert.match(ics, /DTSTART;TZID=Asia\/Shanghai:20261105T233000/);
  assert.match(ics, /DTEND;TZID=Asia\/Shanghai:20261106T000000/); // +30 分钟跨到次日
  assert.match(ics, /SUMMARY:药屋少女的呢喃 第二季 第19话/);
  assert.match(ics, /BEGIN:VALARM\r\nTRIGGER:-PT10M\r\nACTION:DISPLAY/);
  assert.match(ics, /END:VALARM\r\nEND:VEVENT/);
});

test('关掉提醒时不输出 VALARM', () => {
  const ics = buildIcs([EV], { includeAlarm: false });
  assert.ok(!ics.includes('VALARM'));
  assert.ok(ics.includes('BEGIN:VEVENT'));
});

test('没有时刻的事件直接跳过（不生成 00:00 的假日程）', () => {
  const ics = buildIcs([{ ...EV, time: '' }, { ...EV, uid: 'b', time: null }], {});
  assert.ok(!ics.includes('BEGIN:VEVENT'));
  assert.equal((ics.match(/END:VCALENDAR/g) || []).length, 1);
});

test('乱序 / 缺字段不炸', () => {
  assert.doesNotThrow(() => buildIcs(null));
  assert.doesNotThrow(() => buildIcs([{}], {}));
  const ics = buildIcs([{ uid: 'x', date: '2026-12-31', time: '23:50', summary: 'a' }], {});
  // 跨年：23:50 + 30 分 → 2027-01-01
  assert.match(ics, /DTEND;TZID=Asia\/Shanghai:20270101T002000/);
});
