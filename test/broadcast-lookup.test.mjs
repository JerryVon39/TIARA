import test from 'node:test';
import assert from 'node:assert/strict';
import { matchBroadcasts } from '../lib/broadcast-lookup.mjs';
import { editWatchDetail } from '../lib/watch-detail.mjs';
import { mergeLibrary } from '../lib/bgm.mjs';

const now = new Date('2026-11-10T04:00:00Z');
const airing = 'R/2026-11-15T18:30:00Z/P7D'; // Sunday UTC → Monday 02:30 CST
const items = [
  { title: 'Original Title', titleTranslate: { 'zh-Hans': ['测试番'] }, broadcast: airing, sites: [{ site: 'bangumi', id: '111' }] },
  { title: 'Original Title 2', titleTranslate: { 'zh-Hans': ['测试番 第二季'] }, broadcast: airing, sites: [{ site: 'bangumi', id: '222' }] },
  { title: '测试番 特别篇', broadcast: airing.replace('P7D', 'P0D') },
  { title: '测试番 每日', broadcast: airing.replace('P7D', 'P1D') },
  { title: '测试番 已完结', broadcast: airing, end: '2026-10-01T00:00:00Z' },
  { title: '测试番 时区未知', broadcast: 'R/2026-11-15T18:30:00/P7D' },
];

test('排期按确切 Bangumi ID 或标题匹配，只给明确周播并换算到北京时间', () => {
  const ranked = matchBroadcasts(items, { name: ' 测试番 ', now });
  assert.deepEqual(ranked.map(x => [x.subject, x.weekday, x.time_cst]), [['111', 1, '02:30'], ['222', 1, '02:30']]);
  assert.equal(ranked[0].since, '2026-11-16');
  assert.equal(matchBroadcasts(items, { id: '222', name: '测试番', now })[0].subject, '222');
  assert.deepEqual(matchBroadcasts(items, { id: '999', name: '测试番', now }), []);
});

test('同步保留详情手填的名称、总数和清空的排期', () => {
  const lib = { watching: [{ id: 111, name_cn: '旧名', eps: 12, ep_status: 2, air_weekday: 1 }],
    weekday: { 1: [{ id: 111, time_cst: '22:00' }] } };
  editWatchDetail(lib, { id: '111', name: '改名', eps: 24, ep_status: 3, air_weekday: null, air_time_cst: null });
  const { next } = mergeLibrary(lib, {
    calendar: [{ weekday: { id: 2 }, items: [{ id: 111, name_cn: '同步名' }] }],
    collections: [{ subject_id: 111, subject: { name_cn: '同步名', eps: 12 } }],
  }, { weekday: 'all' });
  assert.equal(next.watching[0].name_cn, '改名');
  assert.equal(next.watching[0].eps, 24);
  assert.equal(next.watching[0].ep_status, 3);
  assert.equal(next.watching[0].air_weekday, null);
  assert.ok(Object.values(next.weekday).every(rows => rows.length === 0));
});
