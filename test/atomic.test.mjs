/**
 * lib/atomic.mjs 的单测。
 *
 * 为什么值得钉住：这个模块换掉了项目里所有「直接 fs.writeFile」的写库路径。
 * 它要是会在目标目录留下 .tmp、或者 rename 失败时把原文件弄丢，
 * 那每次写番组记录都可能顺手删掉用户的库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic, writeJsonAtomic, readJsonFile } from '../lib/atomic.mjs';

async function tmpDir() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'tiara-atomic-'));
  return d;
}

test('writeFileAtomic：写入、覆盖、不留临时文件', async () => {
  const dir = await tmpDir();
  const f = path.join(dir, 'a.txt');
  await writeFileAtomic(f, '第一版', 'utf8');
  assert.equal(await fs.readFile(f, 'utf8'), '第一版');
  await writeFileAtomic(f, '第二版——比第一版长一些', 'utf8');
  assert.equal(await fs.readFile(f, 'utf8'), '第二版——比第一版长一些');
  const left = (await fs.readdir(dir)).filter((n) => n.includes('.tmp'));
  assert.deepEqual(left, [], '临时文件必须被 rename 走，不能留在目录里');
});

test('writeFileAtomic：自动建父目录，并保留 mode', async () => {
  const dir = await tmpDir();
  const f = path.join(dir, 'deep', 'nested', 'b.json');
  await writeFileAtomic(f, '{}', { encoding: 'utf8', mode: 0o600 });
  assert.equal(await fs.readFile(f, 'utf8'), '{}');
  const st = await fs.stat(f);
  if (process.platform !== 'win32') assert.equal(st.mode & 0o777, 0o600);
});

test('writeJsonAtomic：2 空格缩进 + 结尾换行（git diff 才好看）', async () => {
  const dir = await tmpDir();
  const f = path.join(dir, 'x.json');
  await writeJsonAtomic(f, { a: 1, b: [1, 2] });
  const raw = await fs.readFile(f, 'utf8');
  assert.ok(raw.endsWith('\n'));
  assert.equal(raw, JSON.stringify({ a: 1, b: [1, 2] }, null, 2) + '\n');
  assert.deepEqual(await readJsonFile(f), { a: 1, b: [1, 2] });
});

test('readJsonFile：文件不存在 / 不是 JSON 时给带文件名的错误', async () => {
  const dir = await tmpDir();
  await assert.rejects(() => readJsonFile(path.join(dir, 'nope.json')), /nope\.json/);
  const bad = path.join(dir, 'bad.json');
  await fs.writeFile(bad, '{oops', 'utf8');
  await assert.rejects(() => readJsonFile(bad), /bad\.json/);
});

test('并发写同一个文件：最后一次落盘的内容完整（不会读出半个 JSON）', async () => {
  const dir = await tmpDir();
  const f = path.join(dir, 'race.json');
  const payloads = Array.from({ length: 20 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(200) }));
  await Promise.all(payloads.map((p) => writeFileAtomic(f, p, 'utf8')));
  const text = await fs.readFile(f, 'utf8');
  // 必须是某一个完整 payload，不能是两段拼起来的碎片
  assert.ok(payloads.includes(text), '落盘内容必须是某一次写入的完整结果');
  assert.doesNotThrow(() => JSON.parse(text));
});
