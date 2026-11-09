#!/usr/bin/env node
// 校验 shell/master/faces.json：格式、图片存在、尺寸一致、区域落在画布内。
// 用法：node tools/check_faces.mjs [--json]
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'shell', 'master');
const MAN = join(DIR, 'faces.json');

const out = [];
const ok = (m) => out.push({ level: 'ok', msg: m });
const warn = (m) => out.push({ level: 'warn', msg: m });
const bad = (m) => out.push({ level: 'error', msg: m });

/** 读 PNG 头拿宽高（不依赖任何图像库） */
export function pngSize(path) {
  const b = readFileSync(path);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

export function checkFaces(manPath = MAN, dir = DIR) {
  const res = { ok: true, errors: [], warns: [], faces: 0, regions: 0 };
  if (!existsSync(manPath)) return { ...res, ok: false, errors: ['faces.json 不存在：' + manPath] };
  let man;
  try {
    man = JSON.parse(readFileSync(manPath, 'utf8'));
  } catch (e) {
    return { ...res, ok: false, errors: ['faces.json 不是合法 JSON：' + e.message] };
  }
  const [cw, ch] = Array.isArray(man.canvas) ? man.canvas : [0, 0];
  if (!cw || !ch) res.errors.push('canvas 必须是 [宽, 高]');
  if (!man.faces || typeof man.faces !== 'object') res.errors.push('缺少 faces 对象');

  // 每张图都要和 canvas 同尺寸，否则叠加会错位
  const seen = new Set();
  const checkPng = (name, why) => {
    if (typeof name !== 'string' || !name) { res.errors.push(`${why}：文件名无效`); return; }
    if (seen.has(name)) return;
    seen.add(name);
    const p = join(dir, name);
    if (!existsSync(p)) { res.errors.push(`${why}：缺文件 ${name}`); return; }
    const s = pngSize(p);
    if (!s) { res.warns.push(`${why}：${name} 不是 PNG，跳过尺寸校验`); return; }
    if (s.w !== cw || s.h !== ch) res.errors.push(`${why}：${name} 是 ${s.w}x${s.h}，与画布 ${cw}x${ch} 不一致`);
  };

  for (const [name, def] of Object.entries(man.faces || {})) {
    res.faces++;
    if (!def || typeof def !== 'object') { res.errors.push(`faces.${name} 不是对象`); continue; }
    if (def.base) checkPng(def.base, `faces.${name}.base`);
    else res.errors.push(`faces.${name} 缺 base`);
    for (const [i, ov] of (def.overlay || []).entries()) checkPng(ov && ov.src, `faces.${name}.overlay[${i}]`);
  }
  if (man.mouth && man.mouth.src) checkPng(man.mouth.src, 'mouth');

  for (const [i, r] of (man.regions || []).entries()) {
    res.regions++;
    if (!r || !Array.isArray(r.rect) || r.rect.length !== 4) { res.errors.push(`regions[${i}] 需要 rect:[x,y,w,h]`); continue; }
    const [x, y, w, h] = r.rect;
    if (!r.name) res.errors.push(`regions[${i}] 缺 name`);
    if (x < 0 || y < 0 || w <= 0 || h <= 0) res.errors.push(`regions[${i}] 数值不合法`);
    if (cw && ch && (x + w > cw || y + h > ch)) res.errors.push(`regions[${i}]（${r.name}）超出画布 ${cw}x${ch}`);
  }
  if (!(man.regions || []).length) res.warns.push('没有 regions：交互会退回「上部 26% = 头」的默认判定');

  // 别名指向必须存在
  for (const [k, v] of Object.entries(man.aliases || {})) {
    if (!man.faces[v]) res.errors.push(`aliases.${k} 指向不存在的表情 ${v}`);
  }

  res.ok = res.errors.length === 0;
  return res;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('check_faces.mjs')) {
  const res = checkFaces();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    for (const e of res.errors) console.log('✖ ' + e);
    for (const w of res.warns) console.log('⚠️  ' + w);
    console.log(res.ok ? `✅ faces.json 正常：${res.faces} 个表情 / ${res.regions} 个区域` : `✖ faces.json 有问题（${res.errors.length} 项）`);
  }
  process.exit(res.ok ? 0 : 1);
}
