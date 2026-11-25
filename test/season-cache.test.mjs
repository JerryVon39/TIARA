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
import { refreshSeasonFromSources, SEASON_BACKUP } from '../lib/season-source.mjs';
import { effectiveBgmConfig } from '../lib/bgm-sync.mjs';
import {
  currentSeason, listCachedSeasons, pruneSeasonCache, readSeasonCache, writeSeasonCache,
  seasonCacheRel, seasonRefreshState, shiftSeason, CATALOG_DIRECTORY, KEEP_SPAN,
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

test('备用源只在启用且官方连接失败后调用，独立请求不携带账号或代理凭据', async () => {
  const calls = [];
  const failing = Object.assign(new Error('incomplete'), { code: 'season_incomplete' });
  const fetcher = async options => {
    calls.push(options);
    if (options.base !== SEASON_BACKUP.base) throw failing;
    return { q: options.q, total: 1, items: [{ id: 1 }] };
  };
  const official = { officialBase: 'https://api.bgm.tv', officialProxy: 'http://synthetic:secret@127.0.0.1',
    token: 'synthetic-token', headers: { Authorization: 'Bearer synthetic-token' } };
  await assert.rejects(refreshSeasonFromSources('2026Q4', official, fetcher), failing);
  assert.equal(calls.length, 1);
  calls.length = 0;
  const result = await refreshSeasonFromSources('2026Q4', { ...official, backup: true }, fetcher);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].proxy, official.officialProxy);
  assert.equal(calls[1].proxy, '');
  assert.equal(calls[1].headers, undefined);
  assert.equal(calls[1].token, undefined);
  assert.equal(calls[1].redirect, 'error');
  assert.equal(result.catalog_source, SEASON_BACKUP.label);
  assert.equal(result.items[0].cover_source, SEASON_BACKUP.id);
  let attempts = 0;
  await assert.rejects(refreshSeasonFromSources('2026Q4', { ...official, backup: true }, async () => {
    attempts++;
    throw Object.assign(new Error('forbidden'), { status: 403 });
  }), /forbidden/);
  assert.equal(attempts, 1, '账号或请求权限错误不换备用源');
  assert.equal(effectiveBgmConfig({ base: SEASON_BACKUP.base }).base, 'https://api.bgm.tv');
});

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

test('有缺失或重复编号的季度快照不会覆盖有效缓存', async () => {
  const q = '2019Q1';
  const root = await rootWith([]);
  await writeSeasonCache(root, { q, items: [{ id: 'local-catalog-demo' }], total: 1 });
  const filename = path.join(root, seasonCacheRel(q));
  const good = await fs.readFile(filename, 'utf8');
  for (const items of [[{}], [{ id: 1 }, { id: '1' }]]) {
    await assert.rejects(writeSeasonCache(root, { q, items, total: items.length }), /季度目录条目不完整或重复/);
    assert.equal(await fs.readFile(filename, 'utf8'), good);
  }
});

test('季末核验按北京时间计算，历史季核验后不因过期而刷新', () => {
  const q = '2025Q4';
  const boundary = '2026-01-15T00:00:00+08:00';
  assert.deepEqual(seasonRefreshState(q, null, new Date('2026-01-14T23:59:59+08:00')), { status: 'pending', due: false });
  assert.deepEqual(seasonRefreshState(q, null, new Date(boundary)), { status: 'pending', due: true });
  assert.deepEqual(seasonRefreshState(q, { verified_at: boundary }, new Date('2026-07-01')), { status: 'verified', due: false });
  assert.deepEqual(seasonRefreshState('2026Q2', null, new Date(boundary)), { status: 'preview', due: true });
  assert.deepEqual(seasonRefreshState('2026Q4', null, new Date(boundary)), { status: 'preview', due: false });
  assert.equal(shiftSeason(q, 1), '2026Q1');
});

test('内置目录能兜底旧缓存漏页，核验结果和附加字段在缓存清理后仍有效', async () => {
  const root = await rootWith([]);
  const q = '2019Q4';
  const seed = { q, items: [{ id: 1, weekday: 1, time_cst: '21:00' }, { id: 3 }], total: 2 };
  const dir = path.join(root, CATALOG_DIRECTORY);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, q + '.json'), JSON.stringify(seed));
  await fs.writeFile(path.join(root, seasonCacheRel(q)), JSON.stringify({ q, items: [{ id: 2 }], total: 2 }));
  assert.equal((await readSeasonCache(root, q)).built_in, true);
  assert.deepEqual(await listCachedSeasons(root), [q]);
  await writeSeasonCache(root, { q, total: 1, items: [{ id: 1, eps: 12, weekday: null }] });
  const saved = await readSeasonCache(root, q);
  assert.equal(saved.verified_source, 'Bangumi API');
  assert.equal(saved.catalog_sources.downloaded.verified_at, saved.verified_at);
  assert.equal(saved.catalog_sources.builtin.verified_at, null);
  assert.equal(saved.catalog_sources.builtin.count, 2);
  assert.equal(saved.catalog_sources.downloaded.count, 1);
  assert.deepEqual(saved.catalog_sources.retained_ids, ['3']);
  assert.deepEqual([saved.items[0].eps, saved.items[0].weekday, saved.items[0].time_cst], [12, 1, '21:00']);
  assert.deepEqual(await pruneSeasonCache(root, currentSeason()), []);
  assert.ok(await fs.readFile(path.join(root, seasonCacheRel(q)), 'utf8'));
});
