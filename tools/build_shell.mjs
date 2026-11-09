#!/usr/bin/env node
/**
 * tools/build_shell.mjs — 把 ComfyUI 出的原图变成 SSP 能用的 shell 立绘
 *
 *   node tools/build_shell.mjs            # 处理 cache/gen/ 下所有已知表情
 *   node tools/build_shell.mjs --only happy
 *
 * 流程：matte(四角 flood fill 去底 + 去白边) → resize(384x576) → shell/master/surfaceN.png
 * 原图留在 cache/gen/，中间产物在 cache/matted/，随时可重跑。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = process.cwd();
const GEN = path.join(ROOT, 'cache', 'gen');
const MATTED = path.join(ROOT, 'cache', 'matted');
const SHELL = path.join(ROOT, 'shell', 'master');
const TOOL = path.join(ROOT, 'tools', 'ImageTool.exe');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

const W = 384;
const H = 576;
/** 半身取景：从头到膝上（0.74 ≈ 到小腿上部），想留全身就传 --bust 1 */
const argv0 = process.argv.slice(2);
const BUST = argv0.includes('--bust') ? argv0[argv0.indexOf('--bust') + 1] : '0.74';

/** 表情 → surface 序号。SSP 用 \s[0] 切表情。 */
const SLOTS = [
  ['normal', 0],
  ['happy', 1],
  ['sad', 2],
  ['surprise', 3],
  ['sleepy', 4],
  ['think', 5],
];

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
/** --dir 指定原图目录（默认 cache/gen），--to 指定输出目录（默认 shell/master） */
const GEN_DIR = path.resolve(argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : GEN);
const SHELL_DIR = path.resolve(argv.includes('--to') ? argv[argv.indexOf('--to') + 1] : SHELL);
/** --tol 抠图容差：肤色很白（Q 版）时要调小，否则 flood fill 会啃进脸里 */
const TOL = argv.includes('--tol') ? argv[argv.indexOf('--tol') + 1] : '40';

async function ensureTool() {
  try {
    await fs.access(TOOL);
    return;
  } catch {}
  console.log('ImageTool.exe 不存在，用 csc 重新编译…');
  await run(CSC, ['/nologo', '/optimize+', '/target:exe', `/out:${TOOL}`, '/r:System.Drawing.dll', path.join(ROOT, 'tools', 'ImageTool.cs')]);
}

async function newestFor(face) {
  const files = (await fs.readdir(GEN_DIR)).filter((f) => f.startsWith(face + '_') && f.endsWith('.png'));
  if (!files.length) return null;
  const stat = await Promise.all(files.map(async (f) => ({ f, t: (await fs.stat(path.join(GEN_DIR, f))).mtimeMs })));
  stat.sort((a, b) => b.t - a.t);
  return path.join(GEN_DIR, stat[0].f);
}

async function main() {
  await ensureTool();
  await fs.mkdir(MATTED, { recursive: true });
  await fs.mkdir(SHELL_DIR, { recursive: true });

  const manifest = [];
  for (const [face, idx] of SLOTS) {
    if (only && only !== face) continue;
    const src = await newestFor(face);
    if (!src) {
      console.log(`  skip ${face}（cache/gen 里没有原图）`);
      continue;
    }
    const mid = path.join(MATTED, `${face}.png`);
    const cut = path.join(MATTED, `${face}_trim.png`);
    const bust = path.join(MATTED, `${face}_bust.png`);
    const out = path.join(SHELL_DIR, `surface${idx}.png`);

    await run(TOOL, ['matte', src, mid, String(TOL), '1', '1.5']);
    // 先按 alpha 裁掉多余白边，再切成半身（头到膝上），最后等比缩放
    await run(TOOL, ['trim', mid, cut]);
    await run(TOOL, ['croprel', cut, bust, '0', '0', '1', String(BUST)]);
    // 'fit' = 等比缩放 + 底对齐（'contain' 会居中留空）
    await run(TOOL, ['resize', bust, out, String(W), String(H), 'fit']);
    const st = await fs.stat(out);
    manifest.push({ face, idx, file: path.basename(out), bytes: st.size, source: path.basename(src) });
    console.log(`  ${face.padEnd(9)} → ${path.relative(ROOT, out)}  (${(st.size / 1024).toFixed(0)}KB)`);
  }

  await fs.writeFile(
    path.join(SHELL_DIR, 'surfaces.json'),
    JSON.stringify({ size: { w: W, h: H }, slots: manifest }, null, 2) + '\n',
    'utf8'
  );
  console.log(`\n完成 ${manifest.length} 张，尺寸 ${W}x${H}。`);
}

main().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
