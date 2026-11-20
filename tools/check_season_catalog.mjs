#!/usr/bin/env node
import fs from 'node:fs';
import { CATALOG_DIRECTORY, FIRST_CATALOG_SEASON, currentSeason, shiftSeason } from '../lib/season-cache.mjs';
import { coverIdOf, coverMediaType } from '../lib/cover.mjs';

const directory = new URL(`../${CATALOG_DIRECTORY}/`, import.meta.url);
const read = name => JSON.parse(fs.readFileSync(new URL(name, directory), 'utf8'));
const index = read('index.json');
const checkedAt = new Date(index.checked_at);
if (!Number.isFinite(+checkedAt) || !/^[a-f0-9]{64}$/.test(index.source_sha256 || ''))
  throw new Error('季度目录缺少有效的核对时间或来源散列');

const lastRequired = currentSeason(process.argv.includes('--current') ? new Date() : checkedAt);
for (let q = FIRST_CATALOG_SEASON; q <= lastRequired; q = shiftSeason(q, 1)) {
  if (!Number.isInteger(index.seasons?.[q]) || index.seasons[q] < 1)
    throw new Error(`缺少随包季度 ${q}，请先生成包含该季的本地目录`);
}

let entryCount = 0;
const all = new Set();
for (const [q, expected] of Object.entries(index.seasons)) {
  if (!/^\d{4}Q[1-4]$/.test(q) || q < FIRST_CATALOG_SEASON) throw new Error(`无效的季度编号 ${q}`);
  const { q: actual, total, items } = read(`${q}.json`);
  if (actual !== q || total !== expected || !Array.isArray(items) || items.length !== total || total < 1)
    throw new Error(`季度 ${q} 的清单和实际条目数不一致`);
  const ids = new Set(items.map(item => String(item.id || '')));
  if (ids.has('') || ids.size !== total) throw new Error(`季度 ${q} 有重复或缺失的条目编号`);
  ids.forEach(id => all.add(id));
  entryCount += total;
}

const missing = index.missing_covers || {};
const covered = new Set();
for (const id of all) {
  const number = coverIdOf(id);
  const photo = number && new URL(`covers/${number}.jpg`, directory);
  if (photo && fs.existsSync(photo)) {
    if (coverMediaType(fs.readFileSync(photo)) !== 'image/jpeg' || Object.hasOwn(missing, id))
      throw new Error(`缩略图 ${id} 无效或状态与文件冲突`);
    covered.add(id);
    continue;
  }
  if (!missing[id] || missing[id] === 'not_checked')
    throw new Error(`条目 ${id} 缺缩略图与核对结论，请使用 --covers 重建`);
}
if (covered.size !== index.thumbnails || Object.keys(missing).some(id => !all.has(id)))
  throw new Error('缩略图统计和目录条目不一致');

console.log(`离线目录 ${FIRST_CATALOG_SEASON} 至 ${lastRequired} · ${Object.keys(index.seasons).length} 季 · ${entryCount} 条 · ${covered.size} 张缩略图 · ${Object.keys(missing).length} 个占位`);
