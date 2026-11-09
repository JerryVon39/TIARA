/**
 * lib/library.mjs 的单测 —— 第四轮审计里最贵的那块（S1/S2/S3/S4）。
 *
 * 这些断言都在钉「保险」而不是「功能」：时间戳必须是这一次的、
 * 写坏了要肯拒绝、备份不能被自己的恢复动作污染、撤销栈有上限。
 * 它们以前一条都没有，因为写库逻辑长在 server.mjs 里（import 就监听端口）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  readLibrary, writeLibrary, backupLibrary, listBackups, backupPath, backupName,
  restoreLibrary, popUndo, undoDepth, UNDO_KEEP, BACKUP_KEEP, LIB_REL, BACKUP_DIR_REL,
} from '../lib/library.mjs';
import { cstParts } from '../lib/today.mjs';

/** 造一个只有 data/library.json 的假根目录 */
async function fixture(overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tiara-lib-'));
  const lib = {
    version: 1,
    updated: '2026-01-01',
    watching: [{ id: '554779', name_cn: '学生会也有洞！', eps: 12, ep_status: 3 }],
    weekday: {},
    ...overrides,
  };
  await fs.mkdir(path.join(root, 'data'), { recursive: true });
  await fs.writeFile(path.join(root, LIB_REL), JSON.stringify(lib, null, 2) + '\n', 'utf8');
  return { root, lib };
}

test('writeLibrary：updated 是「这一次」的 CST 日期（旧实现永远慢一拍）', async () => {
  const { root, lib } = await fixture();
  lib.updated = '2026-01-01'; // 故意留个过期的
  lib.watching[0].ep_status = 4;
  await writeLibrary(root, lib);
  const onDisk = await readLibrary(root);
  assert.equal(onDisk.updated, cstParts().date);
  assert.equal(onDisk.watching[0].ep_status, 4);
  // 就地更新的语义也保留着（调用方常靠它拿最新时间戳）
  assert.equal(lib.updated, cstParts().date);
});

test('writeLibrary：写前留 .bak 与滚动备份，滚动份数有上限', async () => {
  const { root, lib } = await fixture();
  for (let i = 1; i <= 7; i++) {
    lib.watching[0].ep_status = i;
    await writeLibrary(root, lib);
  }
  const bak = await fs.readFile(path.join(root, LIB_REL) + '.bak', 'utf8');
  assert.equal(JSON.parse(bak).watching[0].ep_status, 6, '.bak 是上一次落盘的内容');
  const rolling = (await fs.readdir(path.join(root, BACKUP_DIR_REL))).filter((f) => /^library-.*\.json$/.test(f));
  assert.equal(rolling.length, BACKUP_KEEP);
  const listed = await listBackups(root);
  assert.equal(listed[0].name, 'library.json.bak', '固定备份排在第一位');
  assert.equal(listed.filter((b) => !b.fixed).length, BACKUP_KEEP);
});

test('writeLibrary：撤销栈压入写前内容，且只留最近 10 步', async () => {
  const { root, lib } = await fixture();
  lib.watching[0].ep_status = 1;
  await writeLibrary(root, lib, { backup: false });
  const snap = JSON.parse(await popUndo(root));
  assert.equal(snap.watching[0].ep_status, 3, '撤销快照是写之前的内容');
  assert.equal(await popUndo(root), null, '弹完就空了');

  for (let i = 0; i < UNDO_KEEP + 5; i++) {
    lib.watching[0].ep_status = i;
    await writeLibrary(root, lib, { backup: false });
  }
  assert.equal(await undoDepth(root), UNDO_KEEP);
});

test('writeLibrary：内容坏掉时拒绝落盘，原文件一个字节都不动', async () => {
  const { root, lib } = await fixture();
  const before = await fs.readFile(path.join(root, LIB_REL), 'utf8');
  lib.watching[0].name_cn = '学生会也有洞\uFFFD'; // 编码损坏的典型痕迹
  await assert.rejects(() => writeLibrary(root, lib), /U\+FFFD/);
  assert.equal(await fs.readFile(path.join(root, LIB_REL), 'utf8'), before);
  // 非对象 / 数组也拒绝（不然会把 data/library.json 写成 []）
  await assert.rejects(() => writeLibrary(root, []), /必须是对象/);
  await assert.rejects(() => writeLibrary(root, null), /必须是对象/);
});

test('backupName：CST 命名，同一秒靠序号区分', () => {
  const t = new Date('2026-11-08T17:49:20Z'); // CST 是 11-09 01:49:20
  assert.equal(backupName(t), 'library-20261109-014920.json');
  assert.equal(backupName(t, 2), 'library-20261109-014920-2.json');
});

test('backupPath：白名单挡路径穿越，未列出的文件名一律 null', async () => {
  const { root, lib } = await fixture();
  await writeLibrary(root, lib);
  assert.equal(await backupPath(root, '../../package.json'), null);
  assert.equal(await backupPath(root, 'sub/dir.json'), null);
  assert.equal(await backupPath(root, 'library-19990101-000000.json'), null, '不在清单里就不给读');
  assert.ok(await backupPath(root, 'library.json.bak'));
});

test('restoreLibrary：恢复走 writeLibrary，且不把当前（坏）库写进 .bak', async () => {
  const { root, lib } = await fixture();
  lib.watching[0].ep_status = 7;
  await writeLibrary(root, lib); // 这一写会生成 .bak（内容是 ep_status:3）
  const bakBefore = await fs.readFile(path.join(root, LIB_REL) + '.bak', 'utf8');
  assert.equal(JSON.parse(bakBefore).watching[0].ep_status, 3);

  // 现在把库改坏
  lib.watching = [];
  lib.updated = '2026-01-01';
  await fs.writeFile(path.join(root, LIB_REL), JSON.stringify(lib), 'utf8');

  const restored = await restoreLibrary(root, 'library.json.bak');
  assert.equal(restored.watching.length, 1);
  assert.equal(restored.updated, cstParts().date, '恢复也要更新时间戳');
  const bakAfter = await fs.readFile(path.join(root, LIB_REL) + '.bak', 'utf8');
  assert.equal(bakAfter, bakBefore, '.bak 不能被恢复动作污染');
  const onDisk = await readLibrary(root);
  assert.equal(onDisk.watching[0].ep_status, 3);
});

test('restoreLibrary：找不到备份 / 备份不是合法 JSON / 没有 watching 都拒绝', async () => {
  const { root, lib } = await fixture();
  await writeLibrary(root, lib, { backup: false });
  await assert.rejects(() => restoreLibrary(root, 'nope.json'), (e) => e.code === 'ENOBACKUP');

  await fs.mkdir(path.join(root, BACKUP_DIR_REL), { recursive: true });
  await fs.writeFile(path.join(root, BACKUP_DIR_REL, 'library-20260101-000000.json'), '{oops', 'utf8');
  await assert.rejects(
    () => restoreLibrary(root, 'library-20260101-000000.json'),
    (e) => e.code === 'EBADBACKUP',
  );

  await fs.writeFile(path.join(root, BACKUP_DIR_REL, 'library-20260101-000001.json'), '{"a":1}', 'utf8');
  await assert.rejects(
    () => restoreLibrary(root, 'library-20260101-000001.json'),
    (e) => e.code === 'EBADBACKUP' && /watching/.test(e.message),
  );
});

test('backupLibrary：首次写库没有旧文件，返回 false 且不报错', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tiara-lib-empty-'));
  assert.equal(await backupLibrary(root), false);
});
