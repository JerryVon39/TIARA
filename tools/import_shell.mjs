#!/usr/bin/env node
/**
 * tools/import_shell.mjs — 把网上公开的立绘素材（带 alpha 的 PNG）导入成本工程的 shell
 *
 *   node tools/import_shell.mjs --from cache/net/codel --to shell/codel \
 *     --map "normal=Codel1,happy=Codel10,sad=Codel8,surprise=Codel2,sleepy=Codel6,think=Codel3" \
 *     --crop 0.5 --credit "Codel sprite by LisadiKaprio, CC-BY 3.0, opengameart.org/content/codel-visual-novel-sprite"
 *
 *   --from    素材目录（找 <名字>.png / <名字>.PNG）
 *   --to      输出目录，默认 shell/imported（会被 switch_shell.mjs 识别）
 *   --map     表情映射，缺的表情用 normal 顶替
 *   --crop    裁掉下半身的比例：0.5 = 只留上面 50%（头到腰），1 = 保留全身
 *   --tol     原图是不透明底时才用得到的抠图容差（默认 40）
 *   --credit  署名信息，会写进 CREDITS.txt（CC-BY 必须保留）
 *
 * 流程： (有 alpha 就跳过抠图) → trim 去空白边 → croprel 切半身 → resize fit 384x576 底对齐
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = process.cwd();
const TOOL = path.join(ROOT, 'tools', 'ImageTool.exe');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const MATTED = path.join(ROOT, 'cache', 'matted');

const W = 384;
const H = 576;
const SLOTS = ['normal', 'happy', 'sad', 'surprise', 'sleepy', 'think'];
const FACES = { normal: 0, happy: 1, sad: 2, surprise: 3, sleepy: 4, think: 5 };

const argv = process.argv.slice(2);
const arg = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);

const FROM = path.resolve(arg('--from', ''));
const TO = path.resolve(arg('--to', 'shell/imported'));
const CROP = arg('--crop', '0.62');
const TOL = arg('--tol', '40');
const CREDIT = arg('--credit', '');
const MAP_RAW = arg('--map', '');
/** 统一比例：各张原图尺寸不一致时（比如同一套里有的 887×1774、有的 953×1651），
 *  先按「去白边后的高度 = N」缩放，再进 384×576，切表情时人物大小才不会跳 */
const NORM = parseInt(arg('--norm', '0'), 10);
/** 只输出 --map 里点名的表情；没点名的就不生成（Pet / 面板会自动退回 normal） */
const ONLY_MAPPED = argv.includes('--only-mapped');
/** 口型帧：额外产出 talk.png（打字机吐字期间显示） */
const TALK = arg('--talk', '');

if (!FROM || !argv.includes('--from')) {
  console.error('用法：node tools/import_shell.mjs --from <素材目录> [--to shell/xxx] [--map "normal=文件名,…"] [--crop 0.62] [--credit "…"]');
  process.exit(1);
}

async function ensureTool() {
  try {
    await fs.access(TOOL);
    return;
  } catch {}
  console.log('ImageTool.exe 不存在，用 csc 重新编译…');
  await run(CSC, ['/nologo', '/optimize+', '/target:exe', `/out:${TOOL}`, '/r:System.Drawing.dll', path.join(ROOT, 'tools', 'ImageTool.cs')]);
}

async function resolveFile(name) {
  const want = name.replace(/\.png$/i, '').toLowerCase();
  const files = await fs.readdir(FROM);
  const hit = files.find((f) => f.toLowerCase() === want + '.png') || files.find((f) => f.toLowerCase() === want);
  if (!hit) throw new Error(`素材目录里找不到 ${name}.png`);
  return path.join(FROM, hit);
}

/** 有 alpha（透明像素 > 3%）就直接用，否则先做四角 flood fill 抠底 */
async function hasAlpha(file) {
  const { stdout } = await run(TOOL, ['info', file]);
  const m = stdout.match(/transparent=([\d.]+)%/);
  return m ? parseFloat(m[1]) > 3 : false;
}

function parseMap(raw) {
  const map = {};
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = part.split('=');
    if (!k || !v) continue;
    const face = k.trim();
    if (!SLOTS.includes(face)) throw new Error(`未知表情：${face}（只能是 ${SLOTS.join('/')}）`);
    map[face] = v.trim();
  }
  return map;
}

/** 一张原图 → 一张 384×576 sprite（抠图 → trim → 归一 → 裁剪 → 缩放） */
async function processFrame(src, out) {
  const tag = `import_${path.basename(out).replace(/\.png$/, '')}_${path.basename(src).replace(/[^\w.-]/g, '_')}`;
  let cur = src;

  if (!(await hasAlpha(src))) {
    const m = path.join(MATTED, `${tag}_matte.png`);
    console.log(`  原图不透明，抠图… ${path.basename(src)}`);
    await run(TOOL, ['matte', src, m, TOL, '1', '1.5']);
    cur = m;
  }

  const trimmed = path.join(MATTED, `${tag}_trim.png`);
  const cropped = path.join(MATTED, `${tag}_crop.png`);
  await run(TOOL, ['trim', cur, trimmed]);

  let base = trimmed;
  if (NORM > 0) {
    // 按「去白边后的高度 = NORM」等比缩放：宽高都得算准，不能给个超大画布（会被 width 绑死）
    const { stdout } = await run(TOOL, ['info', trimmed]);
    const m = stdout.match(/^(\d+)x(\d+)/);
    const tw = Number(m[1]), th = Number(m[2]);
    const nw = Math.max(1, Math.round((tw * NORM) / th));
    const normed = path.join(MATTED, `${tag}_norm.png`);
    await run(TOOL, ['resize', trimmed, normed, String(nw), String(NORM), 'stretch']);
    base = normed;
  }
  await run(TOOL, ['croprel', base, cropped, '0', '0', '1', String(CROP)]);
  await run(TOOL, ['resize', cropped, out, String(W), String(H), 'fit']);
  return out;
}

async function main() {
  await ensureTool();
  await fs.mkdir(MATTED, { recursive: true });
  await fs.mkdir(TO, { recursive: true });

  const map = MAP_RAW ? parseMap(MAP_RAW) : {};
  if (!map.normal) throw new Error('--map 至少要给 normal=…');
  const explicit = new Set(Object.keys(map));
  // 缺的表情用 normal 顶（--only-mapped 时不顶，直接不出图）
  if (!ONLY_MAPPED) for (const f of SLOTS) if (!map[f]) map[f] = map.normal;

  const manifest = [];
  for (const face of SLOTS) {
    if (ONLY_MAPPED && !explicit.has(face)) { console.log(`  ${face.padEnd(9)} — 未映射，跳过（用 normal 顶）`); continue; }
    const src = await resolveFile(map[face]);
    const out = path.join(TO, `surface${FACES[face]}.png`);
    await processFrame(src, out);
    const st = await fs.stat(out);
    manifest.push({ face, idx: FACES[face], file: path.basename(out), bytes: st.size, source: path.basename(src) });
    console.log(`  ${face.padEnd(9)} ← ${path.basename(src).padEnd(16)} → ${path.relative(ROOT, out)} (${(st.size / 1024).toFixed(0)}KB)`);
  }

  // 口型帧：打字时临时显示的那一张（Pet / 面板会在打字期间换上它）
  if (TALK) {
    const src = await resolveFile(TALK);
    const out = path.join(TO, 'talk.png');
    await processFrame(src, out);
    const st = await fs.stat(out);
    manifest.push({ face: 'talk', idx: -1, file: 'talk.png', bytes: st.size, source: path.basename(src) });
    console.log(`  ${'talk'.padEnd(9)} ← ${path.basename(src).padEnd(16)} → ${path.relative(ROOT, out)} (${(st.size / 1024).toFixed(0)}KB)`);
  }

  await fs.writeFile(
    path.join(TO, 'surfaces.json'),
    JSON.stringify({ size: { w: W, h: H }, slots: manifest }, null, 2) + '\n',
    'utf8'
  );
  if (CREDIT) {
    await fs.writeFile(
      path.join(TO, 'CREDITS.txt'),
      `本目录的立绘由 --credit 指定的来源提供，按该来源的授权使用：\n\n${CREDIT}\n\n素材来源目录：${path.relative(ROOT, FROM)}\n处理方式：裁剪、等比缩放（未改变画风与内容）。\n` +
        (NORM > 0 ? `统一比例：先按去白边高度 ${NORM}px 归一，再缩到 ${W}x${H}。\n` : ''),
      'utf8'
    );
  }
  console.log(`\n完成 ${manifest.length} 张 → ${path.relative(ROOT, TO)}（384x576）`);
  console.log(`切换：node tools/switch_shell.mjs ${path.basename(TO)}`);
}

main().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
