/**
 * lib/season-cache.mjs 的单测。
 *
 * 重点是 pruneSeasonCache 的两个基准取并集（S 级 P1-1）：
 * 以前只拿「刚写入的季度」当基准，于是翻一次 2018Q1 的老番表，
 * 就把 2026Q3/Q4 —— 用户当下真正要看的 —— 一起删了，回到当前季只能重新拉网。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  currentSeason, listCachedSeasons, pruneSeasonCache, readSeasonCache, writeSeasonCache,
  seasonCacheRel, KEEP_SPAN,
} from '../lib/season-cache.mjs';

async function rootWith(quarters) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tiara-season-'));
  await fs.mkdir(path.join(root, 'data', 'season'), { recursive: true });
  for (const q of quarters) {
    await fs.writeFile(
      path.join(root, seasonCacheRel(q)),
      JSON.stringify({ q, items: [], total: 0, fetched_at: new Date().toISOString() }, null, 2),
      'utf8',
    );
  }
  return root;
}

test('currentSeason：按 UTC+8 判季度（12-31 16:30Z 已经是次年 Q1）', () => {
  assert.equal(currentSeason(new Date('2026-11-09T00:00:00+08:00')), '2026Q4');
  assert.equal(currentSeason(new Date('2026-01-15T12:00:00+08:00')), '2026Q1');
  assert.equal(currentSeason(new Date('2025-12-31T16:30:00Z')), '2026Q1');
  assert.equal(currentSeason(new Date('2026-03-31T23:59:00Z')), '2026Q2');
});

test('pruneSeasonCache：写老季度不会删掉当前季（两个基准取并集）', async () => {
  const quarters = ['2018Q1', '2018Q2', '2018Q3', '2018Q4', '2025Q4', '2026Q1', '2026Q2', '2026Q3', '2026Q4'];
  const root = await rootWith(quarters);
  const now = new Date('2026-11-09T12:00:00+08:00'); // 当前季 2026Q4
  const dropped = await pruneSeasonCache(root, '2018Q1', now);

  const left = await listCachedSeasons(root);
  assert.ok(left.includes('2018Q1'), '刚写入的那一季必须留着（不然自己把它删了）');
  assert.ok(left.includes('2018Q4'), `刚写入那一季 ±${KEEP_SPAN} 季以内都要留着（同一季连翻）`);
  assert.ok(left.includes('2026Q4'), '当前季必须留着');
  assert.ok(left.includes('2026Q1'), `当前季 ±${KEEP_SPAN} 季以内要留着`);
  assert.deepEqual(dropped, ['2025Q4'], '只有落在两个基准都够不到的地方才删');
  assert.ok(!left.includes('2025Q4'));
});

test('pruneSeasonCache：基准之外的当前季老缓存也会被清（不会无限堆积）', async () => {
  const root = await rootWith(['2017Q1', '2020Q2', '2026Q3', '2026Q4']);
  const now = new Date('2026-11-09T12:00:00+08:00');
  await pruneSeasonCache(root, '2026Q4', now);
  const left = await listCachedSeasons(root);
  assert.deepEqual(left, ['2026Q4', '2026Q3']);
});

test('pruneSeasonCache：目录不存在 / 季度写法非法时安静返回空数组', async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'tiara-season-empty-'));
  assert.deepEqual(await pruneSeasonCache(empty, '2026Q4'), []);
  assert.deepEqual(await pruneSeasonCache(empty, 'not-a-quarter', new Date()), []);
});

test('writeSeasonCache：落盘带 fetched_at，返回 pruned 清单，并刷新内存层', async () => {
  const root = await rootWith(['2026Q4']);
  const out = await writeSeasonCache(root, { q: '2027Q1', items: [{ id: '1' }], total: 1 });
  assert.equal(out.path, seasonCacheRel('2027Q1'));
  assert.ok(out.fetched_at);
  const hit = await readSeasonCache(root, '2027Q1');
  assert.equal(hit.stale, false, '刚写完读出来必须是新鲜数据');
  assert.equal(hit.items.length, 1);
  assert.ok(Array.isArray(out.pruned));
});

test('readSeasonCache：过期判定与缺失文件', async () => {
  const root = await rootWith([]);
  const old = new Date(Date.now() - 13 * 3600 * 1000).toISOString();
  await fs.writeFile(
    path.join(root, seasonCacheRel('2019Q1')),
    JSON.stringify({ q: '2019Q1', items: [], fetched_at: old }, null, 2),
    'utf8',
  );
  const stale = await readSeasonCache(root, '2019Q1');
  assert.equal(stale.stale, true);
  assert.ok(stale.age_ms > 12 * 3600 * 1000);
  assert.equal(await readSeasonCache(root, '1999Q4'), null);
});
