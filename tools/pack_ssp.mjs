#!/usr/bin/env node
/**
 * tools/pack_ssp.mjs —— 把 ghost/ + shell/ 打成一个能直接丢进 SSP 的 zip（dist/TIARA-ssp.zip）。
 *
 *   node tools/pack_ssp.mjs                # 生成 dist/TIARA-ssp.zip
 *   node tools/pack_ssp.mjs --out x.zip    # 换个名字
 *   node tools/pack_ssp.mjs --list         # 只列会打进去的文件
 *
 * 为什么是 zip 而不是 .nar：.nar 是 NSIS 安装包，得装 makensis + narc 才能做；
 * SSP 对「zip 里带 ghost/ 与 shell/ 目录」同样认，解压到 SSP 根目录即可。
 * 零依赖：zip 写入在 lib/zip.mjs（store 模式，CRC32 手算），这里只负责挑文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip } from '../lib/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const YAYA = has('--yaya');
const outArg = (() => {
  const i = argv.indexOf('--out');
  return i >= 0 ? argv[i + 1] : null;
})();
const OUT = path.resolve(ROOT, outArg || (YAYA ? 'dist/TIARA-yaya.zip' : 'dist/TIARA-ssp.zip'));

/** 打进去的东西：{ from: 相对 ROOT 的源路径, to: 包内路径 } */
const SHELL = [
  'shell/master/descript.txt',
  'shell/master/surface0.png',
  'shell/master/surface1.png',
  'shell/master/surface2.png',
  'shell/master/surface3.png',
  'shell/master/surface4.png',
  'shell/master/surface5.png',
  'shell/master/talk.png',
];

const ENTRIES = YAYA
  ? [
      { from: 'ghost/master/descript.txt', to: 'ghost/master/descript.txt' },
      { from: 'ghost-yaya/master/yaya.txt', to: 'ghost/master/yaya.txt' },
      { from: 'ghost-yaya/master/basis.dic', to: 'ghost/master/basis.dic' },
      { from: 'ghost-yaya/master/today.json', to: 'ghost/master/today.json' },
      ...SHELL.map((p) => ({ from: p, to: p })),
    ]
  : [
      { from: 'ghost/master/descript.txt', to: 'ghost/master/descript.txt' },
      { from: 'ghost/master/words.txt', to: 'ghost/master/words.txt' },
      { from: 'ghost/master/today.txt', to: 'ghost/master/today.txt' },
      ...SHELL.map((p) => ({ from: p, to: p })),
    ];

// ---------- 读文件 ----------
const files = [];
const missing = [];
for (const ent of ENTRIES) {
  const abs = path.join(ROOT, ent.from);
  if (!fs.existsSync(abs)) {
    missing.push(ent.from);
    continue;
  }
  files.push({ name: ent.to, data: fs.readFileSync(abs) });
}

const install = YAYA
  ? `TIARA · 伪春菜人格（SSP + YAYA 版）
=====================================

一、这是什么
  ghost/ 里是人格（descript.txt + yaya.txt + basis.dic + today.json），shell/ 里是立绘。
  basis.dic 是「YAYA」格式的事件脚本，由 tools/build_yaya.mjs 从 data/talks.json 生成。
  和里々版的台词完全一样，区别是 YAYA 能读文件、能比时间，所以到点会真的开口提醒。

二、装到 SSP 里
  1) 把本压缩包解到 SSP 根目录（和 SSP.exe 同级），得到 ghost/master 与 shell/master。
     如果 SSP 里已经有别的人格，请先把 ghost/master 改名备份，否则会被覆盖。
  2) 装 YAYA（SHIORI）：把 YAYA 的 yaya.dll 放到 ghost/master/shiori/ 下
     （ghost/master/shiori/yaya.dll）。SSP 本体不带 SHIORI，没有它人格加载不了。
  3) 启动 SSP，人格列表里选「TIARA」。

三、到点提醒怎么工作
  · ghost/master/yaya.txt 里写了 dic / charset，YAYA 据此加载 basis.dic。
  · OnSecondChange 每 30 秒跑一次，读 ghost/master/today.json 的 all_shows，
    把「今天、这个周几、时间刚过去 0~4 分钟」且没提醒过的番念出来。
  · today.json 是生成时的快照，改了番组库要重跑：
       node tools/build_today.mjs
       node tools/build_yaya.mjs
    然后让 SSP 重新加载人格（或重开）。

四、能力边界
  · OnBoot / OnFirstBoot / OnClose / OnMouseDoubleClick / OnNadeNade / OnMouseWheel 都有台词。
  · 「首次启动」只念一次：YAYA 会把全局变量存档到自己的 save 目录。
  · 提醒去重靠 yayaDone，跨天会随 today.json 的 date 变化自然失效。
`
  : `TIARA · 伪春菜人格（SSP 用）
======================================

一、这是什么
  ghost/ 里是人格（descript.txt + words.txt + today.txt），shell/ 里是立绘。
  words.txt 是「里々」格式的事件脚本，由 tools/build_ghost.mjs 从 data/talks.json 生成。

二、装到 SSP 里
  1) 把本压缩包解到 SSP 根目录（和 SSP.exe 同级），得到 ghost/master 与 shell/master。
     如果 SSP 里已经有别的人格，请先把 ghost/master 改名备份，否则会被覆盖。
  2) 装里々（SHIORI）：SSP 本体不带 SHIORI，需要单独放一份里々到
     ghost/master/shiori/（或 ghost/master/ 下的 shiori.dll + 辞書.txt）。
     没有 SHIORI 的人格 SSP 会拒绝加载——这不是本包的问题。
  3) 启动 SSP，人格列表里选「TIARA」。

三、让数据和桌面版同步
  ghost/master/today.txt 是「生成时的快照」，不会自己更新。改了番组库以后跑：
     node tools/build_today.mjs
     node tools/build_ghost.mjs
  然后重开 SSP（或让它重新加载人格）。
  想让它在到点时真的开口，请改用 YAYA 版：node tools/pack_ssp.mjs --yaya

四、能力边界
  · OnBoot / OnFirstBoot / OnClose / OnMouseDoubleClick / OnNadeNade / OnMouseWheel
    / OnSecondClick 都有台词，内容来自 data/talks.json。
  · 真正的「到点提醒」写在 OnSecondChange 里，但里々做不到「每分钟读文件再比对」，
    要 YAYA 才稳。这里用的是「打开时念一次今日番组」的保守做法。
`;

if (has('--list')) {
  console.log('会打进去的文件：');
  console.log(`  安装说明.txt  ${Buffer.byteLength(install)} B（生成）`);
  for (const f of files) console.log(`  ${f.name}  ${f.data.length} B`);
  for (const m of missing) console.log(`  缺失（跳过）：${m}`);
  process.exit(0);
}

if (!files.length) {
  console.error('没有可打包的文件：先跑 node tools/build_today.mjs 与 node tools/build_ghost.mjs');
  process.exit(1);
}

// 说明文件放第一个，解压后一眼能看见
files.unshift({ name: '安装说明.txt', data: Buffer.from(install, 'utf8') });

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, buildZip(files));

console.log(`[pack_ssp] ${files.length} 个文件 → ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
if (missing.length) console.log(`[pack_ssp] 跳过缺失：${missing.join(', ')}`);
console.log(
  YAYA
    ? '[pack_ssp] 解压到 SSP 根目录，再把 YAYA 的 yaya.dll 放进 ghost/master/shiori/ 才能加载人格（到点提醒靠它）'
    : '[pack_ssp] 解压到 SSP 根目录，再把里々放进 ghost/master/shiori/ 才能加载人格（要真到点提醒请用 --yaya）'
);
