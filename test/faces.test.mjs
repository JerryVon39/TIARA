import { existsSync } from 'node:fs';
// faces.json 的校验：正常包要过，缺图/尺寸不符/区域越界/别名悬空都要被抓到。
// 用临时目录造 PNG 头（只写 IHDR 需要的字节），不依赖任何图像库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFaces, pngSize } from '../tools/check_faces.mjs';

/** 造一张只有头的假 PNG：签名 + 宽高在 16/20 */
function fakePng(path, w, h) {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);            // IHDR 长度
  b.write('IHDR', 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  writeFileSync(path, b);
}

function mkdirCase(manifest, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tiara-faces-'));
  for (const [name, [w, h]] of Object.entries(files)) fakePng(join(dir, name), w, h);
  const man = join(dir, 'faces.json');
  writeFileSync(man, JSON.stringify(manifest), 'utf8');
  return { dir, man };
}

const BASE = {
  canvas: [384, 576],
  regions: [
    { name: 'head', rect: [44, 8, 296, 196] },
    { name: 'face', rect: [96, 92, 192, 96] },
    { name: 'body', rect: [36, 204, 312, 372] },
  ],
  mouth: { src: 'talk.png' },
  faces: {
    normal: { base: 'surface0.png' },
    happy: { base: 'surface1.png', overlay: [{ src: 'blush.png' }] },
    missing: { base: 'surface2.png' },
  },
  aliases: { normal: 'normal', happy: 'happy' },
};

test('pngSize 读出宽高', () => {
  const { dir } = mkdirCase(BASE, { 'surface0.png': [384, 576] });
  const s = pngSize(join(dir, 'surface0.png'));
  assert.deepEqual(s, { w: 384, h: 576 });
});

test('正常包通过', () => {
  const { man, dir } = mkdirCase(BASE, {
    'surface0.png': [384, 576],
    'surface1.png': [384, 576],
    'surface2.png': [384, 576],
    'talk.png': [384, 576],
    'blush.png': [384, 576],
  });
  const res = checkFaces(man, dir);
  assert.equal(res.ok, true, res.errors.join('; '));
  assert.equal(res.faces, 3);
  assert.equal(res.regions, 3);
});

test('缺图被抓到', () => {
  const { man, dir } = mkdirCase(BASE, { 'surface0.png': [384, 576], 'surface1.png': [384, 576] });
  const res = checkFaces(man, dir);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('surface2.png')), res.errors.join('; '));
});

test('尺寸与画布不一致被抓到', () => {
  const { man, dir } = mkdirCase(BASE, {
    'surface0.png': [400, 576],
    'surface1.png': [384, 576],
    'surface2.png': [384, 576],
    'talk.png': [384, 576],
    'blush.png': [384, 576],
  });
  const res = checkFaces(man, dir);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('400x576')), res.errors.join('; '));
});

test('区域越界被抓到', () => {
  const man = {
    ...BASE,
    regions: [{ name: 'head', rect: [300, 8, 296, 196] }],
  };
  const { man: p, dir } = mkdirCase(man, {
    'surface0.png': [384, 576],
    'surface1.png': [384, 576],
    'surface2.png': [384, 576],
    'talk.png': [384, 576],
    'blush.png': [384, 576],
  });
  const res = checkFaces(p, dir);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('超出画布')), res.errors.join('; '));
});

test('别名指向不存在的表情被抓到', () => {
  const man = { ...BASE, aliases: { nade: 'sleepy' } };
  const { man: p, dir } = mkdirCase(man, {
    'surface0.png': [384, 576],
    'surface1.png': [384, 576],
    'surface2.png': [384, 576],
    'talk.png': [384, 576],
    'blush.png': [384, 576],
  });
  const res = checkFaces(p, dir);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('sleepy')), res.errors.join('; '));
});

test('没有 regions 只 warn 不 error', () => {
  const man = { ...BASE, regions: [] };
  const { man: p, dir } = mkdirCase(man, {
    'surface0.png': [384, 576],
    'surface1.png': [384, 576],
    'surface2.png': [384, 576],
    'talk.png': [384, 576],
    'blush.png': [384, 576],
  });
  const res = checkFaces(p, dir);
  assert.equal(res.ok, true, res.errors.join('; '));
  assert.ok(res.warns.some((w) => w.includes('26%')), res.warns.join('; '));
});

test('仓库里真实的 faces.json 通过', { skip: !existsSync('shell/master/surface0.png') && '源码版需自行添加立绘' }, () => {
  const res = checkFaces();
  assert.equal(res.ok, true, res.errors.join('; '));
  assert.ok(res.faces >= 6);
  assert.equal(res.regions, 3);
});
