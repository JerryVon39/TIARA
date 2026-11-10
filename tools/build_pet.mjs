#!/usr/bin/env node
/**
 * tools/build_pet.mjs — 用系统自带的 csc.exe 编译桌面版TIARA（WPF，无需 .NET SDK）
 *
 *   node tools/build_pet.mjs
 *
 * 产物：pet/Pet.exe
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CANDIDATE_CSC = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
];

const csc = CANDIDATE_CSC.find((p) => fs.existsSync(p));
if (!csc) {
  console.error('找不到 csc.exe（需要 .NET Framework 4.x，Windows 自带）');
  process.exit(1);
}

const fwDir = path.dirname(csc);
const wpfDir = path.join(fwDir, 'WPF');
const refs = [
  path.join(wpfDir, 'PresentationFramework.dll'),
  path.join(wpfDir, 'PresentationCore.dll'),
  path.join(wpfDir, 'WindowsBase.dll'), // 注意：WindowsBase 在 WPF 子目录，不在 Framework 根目录
  path.join(fwDir, 'System.Xaml.dll'),
  path.join(fwDir, 'System.Web.Extensions.dll'), // JavaScriptSerializer：读 talks.json / state.json
  path.join(fwDir, 'System.Core.dll'),
  path.join(fwDir, 'System.dll'),
  path.join(fwDir, 'System.Drawing.dll'),        // 托盘图标
  path.join(fwDir, 'System.Windows.Forms.dll'),  // NotifyIcon：托盘菜单
];
const missing = refs.filter((p) => !fs.existsSync(p));
if (missing.length) {
  console.error('缺少 WPF 程序集：\n  ' + missing.join('\n  '));
  process.exit(1);
}

const src = path.join(ROOT, 'pet', 'Pet.cs');
const out = path.join(ROOT, 'pet', 'Pet.exe');
const manifest = path.join(ROOT, 'pet', 'app.manifest');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('桌宠版本须为三段数字');
const versionSource = path.join(ROOT, 'pet', `.assembly-version-${process.pid}.tmp`);

const args = [
  '/nologo',
  '/target:winexe',
  '/platform:anycpu',
  '/optimize+',
  '/codepage:65001', // Pet.cs 是无 BOM 的 UTF-8，不指定的话 csc 会按系统 ANSI 读，中文全变乱码
  `/out:${out}`,
  `/win32manifest:${manifest}`, // DPI 感知：不加的话 125% 缩放下界面会被裁掉右边
  ...refs.map((r) => `/r:${r}`),
  src,
  path.join(ROOT, 'pet', 'Companion.cs'),
  path.join(ROOT, 'pet', 'DesktopExtras.cs'),
  path.join(ROOT, 'pet', 'PanelHost.cs'),
  versionSource,
];

console.log(`[build_pet] csc: ${csc}`);
try {
  fs.writeFileSync(versionSource, `[assembly: System.Reflection.AssemblyVersion("${version}.0")]\n`);
  const stdout = execFileSync(csc, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (stdout.trim()) console.log(stdout.trim());
  const kb = (fs.statSync(out).size / 1024).toFixed(0);
  console.log(`[build_pet] ok → pet/Pet.exe (${kb}KB)`);
} catch (e) {
  const msg = (e.stdout || '') + (e.stderr || '') || e.message;
  console.error('[build_pet] 编译失败：\n' + msg);
  process.exitCode = 1;
} finally {
  fs.rmSync(versionSource, { force: true });
}
