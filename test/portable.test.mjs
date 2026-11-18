import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readZip } from '../lib/zip.mjs';
import { publicRelease, RELEASE_PAGE, sspSnapshotWindow } from '../lib/release-info.mjs';

test('发行包使用全新库，配置/备份/撤销/生成台词都不泄露个人数据', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tiara-pack-test-'));
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const rel of ['tools', 'lib', 'package.json']) await fs.cp(path.join(source, rel), path.join(root, rel), { recursive: true });
  const pack = () => promisify(execFile)(process.execPath, [path.join(root, 'tools/pack_portable.mjs'), '--no-pet'], { windowsHide: true });
  await assert.rejects(pack(), error => /runtime\/node.exe/.test(error.stderr));
  await fs.mkdir(path.join(root, 'runtime'));
  await fs.copyFile(process.execPath, path.join(root, 'runtime', 'node.exe'));
  const secret = 'PRIVATE_FIXTURE_92726';
  for (const rel of ['data/library.json', 'data/bgm.json', 'data/history.jsonl', 'data/history-2025.jsonl', 'data/talks.json', 'data/state.json', 'data/backups/2026-11-09/bgm.json', 'data/undo/step-1.json', 'ghost/master/basis.dic', 'ghost/master/today.json', 'ghost/master/words.txt', 'ghost-yaya/master/basis.dic', 'shell/custom/surfaces.json']) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), JSON.stringify({ secret }));
  }
  await fs.copyFile(path.join(source, 'ghost/master/descript.txt'), path.join(root, 'ghost/master/descript.txt'));
  await pack();
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json')));
  const zip = readZip(await fs.readFile(path.join(root, `dist/TIARA-portable-${pkg.version}.zip`)));
  const allowed = ['data/library.json', 'data/settings.json', 'data/talks.json', 'data/today.json'];
  assert.deepEqual(zip.filter(x => x.name.startsWith('data/')).map(x => x.name).sort(), allowed.sort());
  assert.equal(zip.some(x => x.data.includes(Buffer.from(secret))), false);
  assert.deepEqual(JSON.parse(zip.find(x => x.name === 'data/library.json').data).watching, []);
  assert.deepEqual(zip.filter(x => x.name.startsWith('ghost')).map(x => x.name).sort(),
    ['basis.dic', 'descript.txt', 'today.json', 'today.txt', 'yaya.txt'].map(name => `ghost/master/${name}`));
  assert.ok(zip.some(x => x.name === 'runtime/node.exe' && x.data.length > 0));
});

test('SSP 公开包是空库，只有私人快照含本机排片，且不能写进发行目录', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tiara-ssp-test-'));
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const rel of ['tools', 'lib', 'package.json', 'ghost/master/descript.txt', 'shell/master'])
    await fs.cp(path.join(source, rel), path.join(root, rel), { recursive: true });
  const title = 'PRIVATE_SSP_SHOW_6038';
  const credentials = 'PRIVATE_BGM_TOKEN_6038';
  await fs.mkdir(path.join(root, 'data'));
  await fs.writeFile(path.join(root, 'data/bgm.json'), JSON.stringify({ token: credentials }));
  await fs.writeFile(path.join(root, 'data/library.json'), JSON.stringify({
    user: { nickname_for_pet: '私人称呼' },
    watching: [{ id: 'local-fixture', name_cn: title, ep_status: 2, eps: 9, air_weekday: 1, air_time_cst: '25:30', accessToken: credentials }],
    weekday: { 1: [{ id: 'local-fixture', name_cn: title, time_cst: '25:30' }] },
  }));
  await fs.writeFile(path.join(root, 'ghost/master/today.json'), title);
  const pack = (...args) => promisify(execFile)(process.execPath, [path.join(root, 'tools/pack_ssp.mjs'), ...args], { windowsHide: true });
  await assert.rejects(pack('--private-snapshot', '--out', 'dist/private.zip'));
  await pack('--out', 'dist/public.zip');
  await pack('--private-snapshot', '--out', 'private-snapshots/private.zip');
  for (const [file, isPrivate] of [['dist/public.zip', false], ['private-snapshots/private.zip', true]]) {
    const entries = readZip(await fs.readFile(path.join(root, file)));
    assert.ok(entries.some(x => x.name === 'install.txt'));
    assert.ok(entries.some(x => x.name === 'ghost/master/basis.dic'));
    assert.equal(entries.some(x => x.data.includes(Buffer.from(credentials))), false);
    assert.equal(entries.some(x => x.data.includes(Buffer.from(title))), isPrivate);
    assert.equal(entries.some(x => x.data.includes(Buffer.from('私人称呼'))), isPrivate);
    const snapshot = JSON.parse(entries.find(x => x.name === 'ghost/master/today.json').data);
    assert.equal(snapshot.all_shows.some(row => row.name_cn === title), isPrivate);
    if (isPrivate) {
      const coverage = sspSnapshotWindow(snapshot.date);
      const readme = entries.find(x => x.name === 'readme.txt').data.toString('utf8');
      assert.ok(readme.includes(coverage.from + ' 至 ' + coverage.to));
    }
  }
});

test('发行检查按版本排序，仅提供正式包和可验证的发布摘要', async () => {
  const make = version => ({
    tag_name: 'v' + version,
    assets: [
      { name: 'TIARA-portable-' + version + '.zip', browser_download_url: RELEASE_PAGE + '/download/v' + version + '/TIARA-portable-' + version + '.zip',
        state: 'uploaded', digest: 'sha256:' + 'a'.repeat(64), size: 42 },
      { name: 'TIARA-ssp-' + version + '.zip', browser_download_url: 'https://example.invalid/ssp.zip', state: 'uploaded' },
    ],
  });
  const release = (version, extra = {}) => async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/JerryVon39/TIARA/releases/latest');
    assert.equal(options.headers.Authorization, undefined);
    return new Response(JSON.stringify({ ...make(version), ...extra }));
  };
  const info = await publicRelease('0.9.0', release('0.10.0'));
  assert.equal(info.update, true);
  assert.equal(info.assets.length, 1);
  assert.equal(info.assets[0].sha256, 'a'.repeat(64));
  assert.equal((await publicRelease('0.11.0', release('0.10.0'))).update, false);
  await assert.rejects(publicRelease('0.9.0', release('0.10.0', { prerelease: true })), /正式发行/);
  await assert.rejects(publicRelease('0.9.0', async () => new Response('', { status: 429 })), /限制查询/);
});
