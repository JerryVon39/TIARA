#!/usr/bin/env node
// 打包 SSP 人格。ZIP 根目录采用 SSP 的 install.txt + ghost/ + shell/ 布局。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip } from '../lib/zip.mjs';
import { VERSION } from '../lib/version.mjs';
import { cstParts } from '../lib/today.mjs';
import { sspSnapshotWindow } from '../lib/release-info.mjs';
import { withReleaseStage } from './release-stage.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const argv = process.argv.slice(2);
const outIndex = argv.indexOf('--out');
const isPrivate = argv.includes('--private-snapshot');
const out = path.resolve(root, outIndex >= 0 ? argv[outIndex + 1] : isPrivate
  ? `private-snapshots/TIARA-ssp-private-${cstParts().date}.zip` : `dist/TIARA-ssp-${VERSION}.zip`);
const inDist = path.relative(path.join(root, 'dist'), out);
if (isPrivate && (!/private/i.test(path.basename(out)) ||
    (!path.isAbsolute(inDist) && !inDist.startsWith('..' + path.sep))))
  throw new Error('私人快照请使用文件名包含 private 的 ZIP，放在 dist 以外。');
// 沿用已发布的 YAYA 人格目录和名称，旧安装可以原位升级。
const directory = 'tiara-yaya';
const name = '番组管家（YAYA）';

const files = [];
const missing = [];
const add = (name, data) => files.push({ name, data: Buffer.from(data, 'utf8') });
function include(name, optional = false, source = root) {
  try {
    files.push({ name, data: fs.readFileSync(path.join(source, name)) });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!optional) missing.push(name);
  }
}

add('install.txt', ['charset,UTF-8', `name,${name}`, 'type,ghost', `directory,${directory}`, ''].join('\r\n'));
include('ghost/master/descript.txt');
const window = withReleaseStage(root, stage => {
  for (const file of ['yaya.txt', 'basis.dic', 'today.json']) include(`ghost/master/${file}`, false, stage);
  return sspSnapshotWindow(JSON.parse(fs.readFileSync(path.join(stage, 'ghost/master/today.json'), 'utf8')).date);
}, { privateSnapshot: isPrivate });
add('readme.txt', `charset,UTF-8
TIARA · SSP 人格

安装
  · 把 ZIP 拖到 SSP，或把其中的 ghost、shell 两个目录解压到 SSP/ghost/${directory}/。
  · 将 yaya.dll 放到 SSP/ghost/${directory}/ghost/master/，与 descript.txt 同目录。
  · 使用 YAYA Tc608-3 或兼容版本，并把 SHIORIES 的 dic/system/yaya_base 目录复制到 ghost/master/yaya_base。
    https://github.com/YAYA-shiori/yaya-shiori/releases
    https://github.com/YAYA-shiori/shiories/releases
  · 已安装 YAYA 版时，更新后重载原人格即可。双击 TIARA 打开案件簿。

排片
${isPrivate ? '  · 这是私人快照，含本机排片、称呼和观看资料，只供自己使用。\n  · 提醒覆盖北京时间 ' + window.from + ' 至 ' + window.to + '（含首尾）。' :
  '  · 公开安装包使用空番库，安装后可以使用人格和案件簿。\n  · 如需把自己的排片带到 SSP，在源码或便携版目录运行 node tools/pack_ssp.mjs --private-snapshot。'}
`.replace(/\r?\n/g, '\r\n'));

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
