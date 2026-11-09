// tools/fetch_runtime.mjs — 把本机的 node.exe 复制进 runtime/，让用户不用自己装 Node.js。
//
//   node tools/fetch_runtime.mjs            # 从 PATH 上的 node 复制
//   node tools/fetch_runtime.mjs --from "C:\Program Files\nodejs\node.exe"
//
// 只有 Windows 需要这一步；产物 runtime/node.exe 已在 .gitignore 里，不进仓库。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST_DIR = path.join(ROOT, 'runtime');
const DEST = path.join(DEST_DIR, 'node.exe');

function resolveSource() {
  const i = process.argv.indexOf('--from');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  try {
    const out = execFileSync('where', ['node'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    if (out.length) return out[0].trim();
  } catch {
    /* ignore */
  }
  return null;
}

function main() {
  if (process.platform !== 'win32') {
    console.log('只有 Windows 需要打包运行时（macOS / Linux 直接用系统 node 即可）。');
    return;
  }
  const src = resolveSource();
  if (!src || !fs.existsSync(src)) {
    console.error('没找到 node.exe。先装 Node.js，或用 --from 指定路径。');
    process.exit(1);
  }

  const size = fs.statSync(src).size;
  fs.mkdirSync(DEST_DIR, { recursive: true });
  fs.copyFileSync(src, DEST);

  let ver = '';
  try {
    ver = execFileSync(DEST, ['-v'], { encoding: 'utf8' }).trim();
  } catch {
    /* ignore */
  }

  const note = [
    'TIARA 自带的 Node.js 运行时',
    '',
    `来源：${src}`,
    `版本：${ver || '未知'}`,
    `体积：${(size / 1024 / 1024).toFixed(1)} MB`,
    `生成时间：${new Date().toISOString()}`,
    '',
    '为什么带一份：网页面板要起一个本地 HTTP 服务，用户机器上不一定装了 Node.js。',
    '这个 exe 是自包含的（本机实测无同目录 DLL 依赖），拷过来就能用。',
    '不想带就删掉它——启动脚本会自动回退到系统 PATH 里的 node。',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(DEST_DIR, 'README.txt'), note, 'utf8');

  console.log(`已复制 node.exe → runtime/node.exe（${(size / 1024 / 1024).toFixed(1)} MB, ${ver}）`);
  console.log('启动脚本会自动优先使用它。');
}

main();
