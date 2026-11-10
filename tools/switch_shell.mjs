#!/usr/bin/env node
/**
 * tools/switch_shell.mjs — 在几套立绘之间切换（把 shell/<名字>/surface*.png 拷进 shell/master/）
 *
 *   node tools/switch_shell.mjs            # 列出所有可切换的立绘组
 *   node tools/switch_shell.mjs chibi      # 切换到 shell/chibi（Q 版）
 *   node tools/switch_shell.mjs cute       # 切换到 shell/cute（萌系大眼）
 *
 * 切完重启 pet/Pet.exe 才生效（Pet 启动时只读一次图）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const SHELL = path.join(ROOT, 'shell');
const TARGET = path.join(SHELL, 'master');
const want = process.argv[2];

async function listSets() {
  const entries = await fs.readdir(SHELL, { withFileTypes: true });
  const sets = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'master') continue;
    try {
      await fs.access(path.join(SHELL, e.name, 'surface0.png'));
      sets.push(e.name);
    } catch {}
  }
  return sets;
}

async function main() {
  const sets = await listSets();
  if (!want) {
    console.log('可切换的立绘组：');
    for (const s of sets) {
      const st = await fs.stat(path.join(SHELL, s, 'surface0.png'));
      console.log(`  ${s.padEnd(10)} ${(st.size / 1024).toFixed(0)}KB  → node tools/switch_shell.mjs ${s}`);
    }
    console.log('\n当前 shell/master 用的是哪一套，看 shell/master/surfaces.json 的 slots[].source。');
    return;
  }
  if (!sets.includes(want)) {
    console.error(`没有这套立绘：${want}（可选：${sets.join(', ')}）`);
    process.exit(1);
  }
  for (let i = 0; i <= 6; i++) {
    const src = path.join(SHELL, want, `surface${i}.png`);
    const dst = path.join(TARGET, `surface${i}.png`);
    try {
      await fs.copyFile(src, dst);
    } catch {
      // 新这套没有这个表情：把旧的删掉，否则会残留上一套的图
      try { await fs.rm(dst, { force: true }); } catch {}
    }
  }
  // 口型帧同样处理：有就拷，没有就删
  const talkSrc = path.join(SHELL, want, 'talk.png');
  const talkDst = path.join(TARGET, 'talk.png');
  try {
    await fs.copyFile(talkSrc, talkDst);
  } catch {
    try { await fs.rm(talkDst, { force: true }); } catch {}
  }
  try {
    await fs.copyFile(path.join(SHELL, want, 'surfaces.json'), path.join(TARGET, 'surfaces.json'));
  } catch {}
  console.log(`已切换到 ${want}。重启 pet/Pet.exe（或重开面板）即可看到。`);
}

main().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
