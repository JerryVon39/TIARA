/**
 * tools/pack_portable.mjs —— 解压后可直接运行桌宠和网页服务的 Windows 便携包。
 *
 *   node tools/pack_portable.mjs              # → dist/TIARA-portable-<version>.zip
 *   node tools/pack_portable.mjs --out x.zip
 *   node tools/pack_portable.mjs --no-pet     # 不塞 pet/Pet.exe（只想要网页版）
 *
 * 里面有什么：
 *   pet/Pet.exe             桌宠本体（已编译）
 *   runtime/node.exe        用 tools/fetch_runtime.mjs 准备的必带运行时
 *   server.mjs + lib/ + panel/ + tools/ + ghost/ + shell/ + data/ + test/
 *   启动TIARA.bat / 打开番组表.bat / 停止TIARA.bat
 *   README.md / 安装说明.txt
 *
 * 不塞：cache/（都是临时文件）、.git/、dist/、runtime 之外的 exe、node_modules。
 * data/ 只带新生成的空库、默认设置和台词，所有人格生成物也用空库重新生成。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip, readZip } from '../lib/zip.mjs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const outIdx = argv.indexOf('--out');
const NO_PET = has('--no-pet');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const OUT = path.resolve(ROOT, outIdx >= 0 ? argv[outIdx + 1] : `dist/TIARA-portable-${pkg.version}.zip`);
const nodeExe = path.join(ROOT, 'runtime', 'node.exe');
const petExe = path.join(ROOT, 'pet', 'Pet.exe');
if (!fs.existsSync(nodeExe)) {
  console.error('[pack_portable] 缺少 runtime/node.exe，请先运行 node tools/fetch_runtime.mjs。');
  process.exit(1);
}
if (!NO_PET && !fs.existsSync(petExe)) {
  console.error('[pack_portable] 缺少 pet/Pet.exe，请先运行 node tools/build_pet.mjs。');
  process.exit(1);
}
const runtimeVersion = execFileSync(nodeExe, ['--version'], { windowsHide: true, encoding: 'utf8' }).trim();
if (!/^v\d+\.\d+\.\d+/.test(runtimeVersion) || Number(runtimeVersion.slice(1).split('.')[0]) < 18) {
  throw new Error(`便携运行时不符合项目要求：${runtimeVersion}`);
}

/** 目录白名单：只有这些目录会被整目录带走 */
const DIRS = [
  'lib', 'panel', 'tools', 'ghost', 'shell', 'test', 'assets', 'docs',
];
/** 根目录下的散文件 */
const FILES = [
  'server.mjs', 'package.json', 'README.md', '启动TIARA.bat', '打开番组表.bat', '停止TIARA.bat',
];
/** 永不打包 */
const SKIP_EXT = new Set(['.log', '.bak', '.tmp', '.zip']);
const SKIP_NAME = new Set(['node_modules', '.git', '.vscode', 'dist', 'cache', 'obj', 'bin']);
const GENERATED = new Set(['ghost/master/today.txt', 'ghost/master/today.json',
  'ghost/master/basis.dic', 'ghost/master/yaya.txt']);

function walk(abs, rel, out) {
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return;
  }
  if (st.isDirectory()) {
    if (SKIP_NAME.has(path.basename(abs))) return;
    for (const name of fs.readdirSync(abs)) walk(path.join(abs, name), path.join(rel, name), out);
    return;
  }
  const ext = path.extname(abs).toLowerCase();
  const name = rel.replace(/\\/g, '/');
  // 覆盖安装留下的旧里々字典可能包含个人台词和番组数据。
  if (GENERATED.has(name) || name === 'ghost/master/words.txt') return;
  if (SKIP_EXT.has(ext)) return;
  if (/_portable|library\.json\.bak/.test(path.basename(abs))) return;
  out.push({ name, data: fs.readFileSync(abs) });
}

const files = [];
// 发行数据只由此白名单生成；不读取本机的库、账号、历史、备份、撤销栈。
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'tiara-release-'));
try {
  fs.mkdirSync(path.join(stage, 'data'), { recursive: true });
  const defaults = {
    'library.json': { version: 1, updated: '', user: {}, watching: [], weekday: {}, dropped: [], trivia: {} },
    'settings.json': { clock: '30h', pet_scale: 1 },
  };
  for (const [name, value] of Object.entries(defaults)) fs.writeFileSync(path.join(stage, 'data', name), JSON.stringify(value, null, 2) + '\n');
  fs.copyFileSync(path.join(ROOT, 'data/talks.json'), path.join(stage, 'data/talks.json'));
  if (fs.existsSync(path.join(ROOT, 'shell/master'))) fs.cpSync(path.join(ROOT, 'shell/master'), path.join(stage, 'shell/master'), { recursive: true });
  for (const tool of ['build_today.mjs', 'build_ghost.mjs']) {
    execFileSync(process.execPath, [path.join(ROOT, 'tools', tool), '--root', stage], { windowsHide: true, stdio: 'pipe' });
  }
  for (const name of ['data/library.json', 'data/settings.json', 'data/talks.json', 'data/today.json', ...GENERATED]) {
    files.push({ name, data: fs.readFileSync(path.join(stage, name)) });
  }
} finally {
  // mkdtemp 返回的、由本进程持有的暂存目录；不涉及工作区或用户数据。
  if (path.dirname(stage) === path.resolve(os.tmpdir()) && path.basename(stage).startsWith('tiara-release-')) fs.rmSync(stage, { recursive: true, force: true });
}
for (const d of DIRS) walk(path.join(ROOT, d), d, files);
for (const f of FILES) {
  const abs = path.join(ROOT, f);
  if (fs.existsSync(abs)) files.push({ name: f.replace(/\\/g, '/'), data: fs.readFileSync(abs) });
}

// 桌宠：exe 是产物，dist 里必须带上（不然「便携版」还得自己编译）
if (!NO_PET) {
  files.push({ name: 'pet/Pet.exe', data: fs.readFileSync(petExe) });
}

files.push({ name: 'runtime/node.exe', data: fs.readFileSync(nodeExe) });

const guide = `TIARA 便携版 v${pkg.version}
=====================================

一、怎么用
  1) 解压整个压缩包到可写目录，支持中文和空格。
  2) 双击 pet/Pet.exe 或「启动TIARA.bat」。桌宠会在后台启动网页服务。
     从右键菜单或托盘点「打开网页番组表」即可使用。
  3) 「打开番组表.bat」也能单独开面板。桌宠会复用这个安装目录已经在跑的服务。
  4) 退出桌宠会结束由桌宠启动的服务。「停止TIARA.bat」可退出本目录的桌宠和服务。

二、需要装什么
  不需要安装 Node.js。包内带 runtime/node.exe（${runtimeVersion}），请和桌宠一起保留。

三、数据在哪
  data/library.json       你的番组库（初始为空，在网页「本季番剧」添加）
  data/backups/           每次写库前的自动备份
  data/history.jsonl      进度历史
  cache/server.log        服务日志（出问题时先看这个，网页里「诊断」按钮也能看）

四、桌宠
  右键桌宠可查看排片、打开网页面板、记一话或撤销。尺寸、省电和开机自启都在「桌宠设置」。
  摸头 = 点头顶，拖动 = 按住身体任意处。
  详细上手步骤见 README.md；开发与构建说明见 docs/DEVELOPMENT.md。

五、升级或换电脑
  把新版解压到另一个目录，退出旧版。在新版网页底栏打开「升级与换机」。
  选择旧版的 data 文件夹或已导出的迁移文件，检查预览后确认。导入前会自动备份新版的现有数据。
  迁移文件带有番库、观看历史、偏好和陪伴记忆，Bangumi 令牌请在新安装中重新填写。
`;

files.push({ name: '安装说明-便携版.txt', data: Buffer.from(guide, 'utf8') });
files.sort((a, b) => a.name.localeCompare(b.name));

const zip = buildZip(files);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, zip);

const back = readZip(zip);
const mb = (n) => (n / 1024 / 1024).toFixed(1);
console.log(`[pack_portable] ${path.relative(ROOT, OUT)}  ${back.length} 个文件  ${mb(zip.length)} MB`);
if (NO_PET) console.log('[pack_portable] 按 --no-pet 跳过 pet/Pet.exe');
