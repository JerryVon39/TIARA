// lib/zip.mjs 的单测：zip 结构写坏的症状是「能解压但文件损坏」，必须往返校验。
import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, dosTime, buildZip, readZip } from '../lib/zip.mjs';

test('crc32：已知值对得上（"123456789" 的标准 CRC32 是 0xCBF43926）', () => {
  assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('dosTime：1980 年前的年份被夹到 1980，秒数折半', () => {
  const { time, date } = dosTime(new Date(1970, 0, 1, 0, 0, 0));
  assert.equal((date >> 9) + 1980, 1980);
  const t2 = dosTime(new Date(2026, 10, 5, 13, 4, 30));
  assert.equal(t2.time >> 11, 13, '小时');
  assert.equal((t2.time >> 5) & 0x3f, 4, '分钟');
  assert.equal(t2.time & 0x1f, 15, '30 秒 → 15');
  assert.equal(((t2.date >> 5) & 0x0f), 11, '11 月');
  assert.equal(t2.date & 0x1f, 5, '5 日');
});

test('buildZip → readZip：内容、顺序、长度都还原', () => {
  const files = [
    { name: 'a.txt', data: Buffer.from('hello', 'utf8') },
    { name: 'dir/b.bin', data: Buffer.from([0, 1, 2, 255]) },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ];
  const zip = buildZip(files, new Date(2026, 10, 5, 12, 0, 0));
  const back = readZip(zip);
  assert.equal(back.length, 3);
  for (let i = 0; i < files.length; i++) {
    assert.equal(back[i].name, files[i].name);
    assert.deepEqual(back[i].data, files[i].data);
  }
  assert.equal(zip.readUInt32LE(0), 0x04034b50, '开头是 local file header');
  assert.ok(zip.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06])), '结尾有 EOCD');
});

test('中文文件名按 UTF-8 存、读回来不乱码', () => {
  const zip = buildZip([{ name: '安装说明.txt', data: Buffer.from('你好', 'utf8') }]);
  const back = readZip(zip);
  assert.equal(back[0].name, '安装说明.txt');
  assert.equal(back[0].data.toString('utf8'), '你好');
  // bit 11 (0x0800) 表示名字是 UTF-8，Windows 解压才不会乱码
  assert.equal(zip.readUInt16LE(6) & 0x0800, 0x0800);
});

test('反斜杠路径被规范成正斜杠', () => {
  const back = readZip(buildZip([{ name: 'shell\\master\\a.png', data: Buffer.from('x') }]));
  assert.equal(back[0].name, 'shell/master/a.png');
});
