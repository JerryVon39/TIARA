#!/usr/bin/env node
// 打包 SSP 人格。ZIP 根目录采用 SSP 的 install.txt + ghost/ + shell/ 布局。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip } from '../lib/zip.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const argv = process.argv.slice(2);
const outIndex = argv.indexOf('--out');
const out = path.resolve(root, outIndex >= 0 ? argv[outIndex + 1] : 'dist/TIARA-ssp.zip');
// 沿用已发布的 YAYA 人格目录和名称，旧安装可以原位升级。
const directory = 'tiara-yaya';
const name = '番组管家（YAYA）';

const files = [];
const missing = [];
const add = (name, data) => files.push({ name, data: Buffer.from(data, 'utf8') });
const read = name => fs.readFileSync(path.join(root, name));
function include(name, optional = false) {
  try {
    files.push({ name, data: read(name) });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!optional) missing.push(name);
  }
}

add('install.txt', ['charset,UTF-8', `name,${name}`, 'type,ghost', `directory,${directory}`, ''].join('\r\n'));
add('readme.txt', `charset,UTF-8
TIARA · SSP 人格

安装
  · 把 ZIP 拖到 SSP，或把其中的 ghost、shell 两个目录解压到 SSP/ghost/${directory}/。
  · 将 yaya.dll 放到 SSP/ghost/${directory}/ghost/master/，与 descript.txt 同目录。
  · 使用 YAYA Tc608-3 或兼容版本，并把 SHIORIES 的 dic/system/yaya_base 目录复制到 ghost/master/yaya_base。
    https://github.com/YAYA-shiori/yaya-shiori/releases
    https://github.com/YAYA-shiori/shiories/releases
  · 已安装 YAYA 版时，更新后重载原人格即可。双击 TIARA 打开案件簿。

同步
  · 在项目目录依次运行 node tools/build_today.mjs、node tools/build_ghost.mjs、node tools/pack_ssp.mjs，再更新已安装的人格。
  · 包里的排片、称呼和补番清单取自打包前生成的快照。
  · 仅提醒快照所覆盖的七天内、自己在追且未静音的排片。
`.replace(/\r?\n/g, '\r\n'));
for (const file of ['descript.txt', 'yaya.txt', 'basis.dic', 'today.json']) {
  include(`ghost/master/${file}`);
}

include('shell/master/descript.txt');
for (let id = 0; id <= 6; id++) {
  include(`shell/master/surface${id}.png`, id > 0);
}
include('shell/master/talk.png', true);

// 字典和 Shell 可能是在不同时间生成的，切换过 Shell 后提示重新构建，避免安装包出现空白表情。
const dictionary = files.find(({ name }) => name === 'ghost/master/basis.dic');
if (dictionary) {
  const ids = new Set([...dictionary.data.toString('utf8').matchAll(/(?<!\\)\\s\[(\d+)\]/g)].map(match => match[1]));
  for (const id of ids) {
    const name = `shell/master/surface${id}.png`;
    if (!files.some(file => file.name === name) && !missing.includes(name)) missing.push(name);
  }
}

if (argv.includes('--list')) {
  for (const { name, data } of files) console.log(`  ${name}  ${data.length} B`);
}
if (missing.length) {
  console.error(`[pack_ssp] 缺少 ${missing.join('、')}。请检查 Shell，再运行 build_today 和 build_ghost。`);
  process.exitCode = 1;
} else if (!argv.includes('--list')) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buildZip(files));
  console.log(`[pack_ssp] ${files.length} 个文件 → ${path.relative(root, out)}（YAYA）`);
}
