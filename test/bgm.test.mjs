/**
 * test/bgm.test.mjs — 同步逻辑与 HTTP 解析的单测（node --test）
 *
 * 网络在这台机器上时好时坏，所以测试全部离线：
 *   · mergeLibrary 是纯函数，直接喂样本；
 *   · parseResponse / decodeChunked 用造出来的字节流验证；
 *   · httpGet 打本机回环服务器，不碰外网。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mergeLibrary, mergeSeason, weekdayMap, parseResponse, decodeChunked, httpGet } from '../lib/bgm.mjs';

const baseLib = () => ({
  version: 1,
  updated: '2026-11-04',
  user: { nickname_for_pet: '主人' },
  watching: [
    { id: 400602, name_cn: '示例：药屋少女的呢喃 第二季', name: '藥屋少女的呢喃 第二季', eps: 24, ep_status: 18, air_weekday: 5, air_time_cst: '23:00', rate: 8, priority: '必追', last_watched: '2026-11-04', comment: '猫猫可爱' }
  ],
  weekday: { 5: [{ id: 400602, name_cn: '示例：药屋少女的呢喃 第二季', time_cst: '23:00', ep_expected: 19 }] },
  trivia: { quote_of_today: 'x' }
});

const calendar = [
  { weekday: { id: 2 }, items: [{ id: 500001, name_cn: '新番', air_weekday: 2 }] },
  { weekday: { id: 5 }, items: [{ id: 400602, name_cn: '药屋少女的呢喃 第二季', air_weekday: 5 }] }
];

const collections = [
  { subject_id: 500001, ep_status: 2, subject: { id: 500001, name: 'NEW', name_cn: '新番', eps: 12 } },
  { subject_id: 400602, ep_status: 19, subject: { id: 400602, name: '藥屋少女的呢喃 第二季', name_cn: '药屋少女的呢喃 第二季', eps: 24 } }
];

test('weekdayMap：把放送表翻成 id → 星期', () => {
  const m = weekdayMap(calendar);
  assert.equal(m.get('500001'), 2);
  assert.equal(m.get('400602'), 5);
  assert.equal(m.size, 2);
});

test('mergeLibrary：新增在看条目，默认进度 0', () => {
  const { next, changes } = mergeLibrary(baseLib(), { calendar, collections });
  const added = next.watching.find((w) => w.id === 500001);
  assert.ok(added, '应该新增 500001');
  assert.equal(added.ep_status, 0, '没有 --take-progress 时进度必须归零');
  assert.equal(added.air_weekday, 2);
  assert.equal(added.priority, '在追');
  assert.ok(changes.some((c) => c.id === 500001 && c.field === '(新增)'));
});

test('mergeLibrary：本地字段永远不被覆盖', () => {
  const { next } = mergeLibrary(baseLib(), { calendar, collections });
  const w = next.watching.find((x) => x.id === 400602);
  assert.equal(w.ep_status, 18, 'ep_status 归本地');
  assert.equal(w.priority, '必追');
  assert.equal(w.rate, 8);
  assert.equal(w.comment, '猫猫可爱');
  assert.equal(w.last_watched, '2026-11-04');
  assert.equal(w.name_cn, '药屋少女的呢喃 第二季', '番名归网络');
  assert.equal(w.eps, 24);
});

test('mergeLibrary：--take-progress 才跟着线上进度走', () => {
  const { next } = mergeLibrary(baseLib(), { calendar, collections }, { takeProgress: true });
  assert.equal(next.watching.find((x) => x.id === 400602).ep_status, 19);
  assert.equal(next.watching.find((x) => x.id === 500001).ep_status, 2);
});

test('mergeLibrary：只给日历也能把「周几播」补上', () => {
  const lib = baseLib();
  lib.watching[0].air_weekday = null;
  const { next, changes } = mergeLibrary(lib, { calendar });
  assert.equal(next.watching[0].air_weekday, 5);
  assert.ok(changes.some((c) => c.field === 'air_weekday'));
});

test('mergeLibrary：周表名字跟着 watching 校准', () => {
  const { next } = mergeLibrary(baseLib(), { calendar, collections });
  assert.equal(next.weekday['5'][0].name_cn, '药屋少女的呢喃 第二季');
});

test('mergeLibrary：没变化时不动 updated', () => {
  const lib = baseLib();
  lib.watching[0].name_cn = '药屋少女的呢喃 第二季';
  lib.weekday['5'][0].name_cn = '药屋少女的呢喃 第二季';
  const { changes, next } = mergeLibrary(lib, { calendar, collections: [collections[1]] });
  assert.equal(changes.length, 0);
  assert.equal(next.updated, lib.updated);
});

test('同步和季表入库保留暂停、归档及原排期', () => {
  const lib = baseLib();
  lib.paused = lib.watching.splice(0);
  lib.archived = [{ id: 500001, name_cn: '本地番名', eps: 12, ep_status: 12 }];
  const synced = mergeLibrary(lib, { calendar, collections }, { weekday: 'all', takeProgress: true }).next;
  const { next } = mergeSeason(synced, calendar.flatMap(day => day.items), { add: [400602, 500001] });
  assert.deepEqual(next.watching, []);
  assert.deepEqual(next.paused, lib.paused);
  assert.deepEqual(next.archived, lib.archived);
  assert.deepEqual(next.weekday[5], lib.weekday[5]);
  assert.deepEqual(Object.values(next.weekday).flat().map(w => w.id), [400602]);
});

test('parseResponse：普通响应', () => {
  const buf = Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"a":1}', 'latin1');
  const r = parseResponse(buf);
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.body.toString(), '{"a":1}');
});

test('decodeChunked / parseResponse：分块传输', () => {
  const body = Buffer.from('{"hello":"world"}');
  const raw = Buffer.concat([
    Buffer.from(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n`),
    Buffer.from(body.length.toString(16) + '\r\n'), body, Buffer.from('\r\n0\r\n\r\n')
  ]);
  assert.equal(decodeChunked(Buffer.concat([Buffer.from(body.length.toString(16) + '\r\n'), body, Buffer.from('\r\n0\r\n\r\n')])).toString(), '{"hello":"world"}');
  assert.equal(parseResponse(raw).body.toString(), '{"hello":"world"}');
});

test('httpGet：本机回环，验证状态与响应体', async () => {
  const srv = http.createServer((req, res) => {
    assert.equal(req.headers['user-agent'].startsWith('tiara/'), true);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const res = await httpGet(`http://127.0.0.1:${port}/calendar`, { timeoutMs: 3000 });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body.toString()), { ok: true });
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('mergeLibrary：--weekday watching 只补在追的，不塞整季', () => {
  const lib = baseLib();
  lib.weekday['5'] = [];                       // 先把周表清空，看它会不会补回来
  // 只喂放送表、不喂收藏：500001 谁都不认识，默认模式不该把它塞进周表
  const { next, changes } = mergeLibrary(lib, { calendar });
  assert.equal(next.weekday['5'].length, 1);
  assert.equal(next.weekday['5'][0].id, 400602);
  assert.equal(next.weekday['2'].length, 0, '500001 不在 watching，默认不该进周表');
  assert.ok(changes.some((c) => c.scope === 'weekday' && c.field === '(新增)'));
});

test('mergeLibrary：weekday=all 把放送表整季都写进周表，并保持不重复', () => {
  const lib = baseLib();
  const { next, changes } = mergeLibrary(lib, { calendar, collections }, { weekday: 'all' });
  assert.equal(next.weekday['2'].length, 1);
  assert.equal(next.weekday['2'][0].id, 500001);
  assert.equal(next.weekday['5'].length, 1, '已有的 400602 不重复插入');
  const added = changes.filter((c) => c.scope === 'weekday' && c.field === '(新增)').map((c) => c.id);
  assert.deepEqual(added, [500001], '只新增 500001，已有的 400602 不重复插');
});

test('mergeLibrary：放送表的 air_date 补进 watching.start_date', () => {
  const cal = [{ weekday: { id: 5 }, items: [{ id: 400602, name_cn: 'x', air_weekday: 5, air_date: '2026-10-24' }] }];
  const { next } = mergeLibrary(baseLib(), { calendar: cal });
  assert.equal(next.watching[0].start_date, '2026-10-24');
});
