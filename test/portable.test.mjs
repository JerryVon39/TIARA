import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readZip } from '../lib/zip.mjs';

test('发行包使用全新库，配置/备份/撤销/生成台词都不泄露个人数据', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tiara-pack-test-'));
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const rel of ['tools', 'lib', 'package.json']) await fs.cp(path.join(source, rel), path.join(root, rel), { recursive: true });
  const pack = () => promisify(execFile)(process.execPath, [path.join(root, 'tools/pack_portable.mjs'), '--no-pet'], { windowsHide: true });
  await assert.rejects(pack(), error => /runtime\/node.exe/.test(error.stderr));
  await fs.mkdir(path.join(root, 'runtime'));
  await fs.copyFile(process.execPath, path.join(root, 'runtime', 'node.exe'));
  const secret = 'PRIVATE_FIXTURE_92726';
  for (const rel of ['data/library.json', 'data/bgm.json', 'data/history.jsonl', 'data/state.json', 'data/backups/2026-11-09/bgm.json', 'data/undo/step-1.json', 'ghost/master/words.txt', 'ghost-yaya/master/basis.dic']) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), JSON.stringify({ secret }));
  }
  await fs.copyFile(path.join(source, 'data/talks.json'), path.join(root, 'data/talks.json'));
  await pack();
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json')));
  const zip = readZip(await fs.readFile(path.join(root, `dist/TIARA-portable-${pkg.version}.zip`)));
  const allowed = ['data/library.json', 'data/settings.json', 'data/talks.json', 'data/today.json'];
  assert.deepEqual(zip.filter(x => x.name.startsWith('data/')).map(x => x.name).sort(), allowed.sort());
  assert.equal(zip.some(x => x.data.includes(Buffer.from(secret))), false);
  assert.deepEqual(JSON.parse(zip.find(x => x.name === 'data/library.json').data).watching, []);
  assert.ok(zip.some(x => x.name === 'ghost/master/today.txt'));
  assert.ok(zip.some(x => x.name === 'runtime/node.exe' && x.data.length > 0));
});
