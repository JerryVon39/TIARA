#!/usr/bin/env node
/**
 * tools/ci.mjs — 一条命令跑完「提交前该跑的全部检查」。
 *
 *   node tools/ci.mjs
 *   node tools/ci.mjs --fast     # 跳过单测（只查语法与文档一致性）
 *
 * 检查项：
 *   1. 语法：root/lib/tools/test 下所有 .mjs 过一遍 node --check
 *   2. 单测：node --test test/*.test.mjs
 *   3. 文档：README 版本行 == package.json + CHANGELOG 发版日
 *   4. 面板：index.html 引用的 ./style.css 与 ./app.js 存在，且没用 type="module"
 *      （桌宠在没有服务时会用 file:// 打开面板，module 会被 CORS 拦成白屏）
 *   5. 生成物：ghost/master/today.txt 的 date= 是今天（过期只 warn，不算失败）
 *
 * 为什么要有这个：以前「跑测试」要记 `node --test "test/*.test.mjs"` 这个带引号的字符串，
 * 在 PowerShell / cmd / bash 里行为还不一样；而 README 版本行、面板拆分这类事
 * 没人会主动想起来查。现在一条命令，红/绿一眼看到。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAST = process.argv.includes('--fast');
const NODE = process.execPath;

const rows = [];
let failed = 0;

function record(name, ok, detail = '', level = ok ? 'ok' : 'error') {
  rows.push({ name, level, detail });
  if (level === 'error') failed++;
}

function run(args, { allowFail = false } = {}) {
  const r = spawnSync(NODE, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (r.error) return { code: 127, out: String(r.error.message) };
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status !== 0 && !allowFail) return { code: r.status ?? 1, out };
  return { code: r.status ?? 0, out };
}

// ---------- 1. 语法 ----------
function walk(dir, acc = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'cache' || e.name === 'dist' || e.name === 'runtime') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(mjs|js)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const files = ['server.mjs', ...walk(path.join(ROOT, 'lib')), ...walk(path.join(ROOT, 'tools')), ...walk(path.join(ROOT, 'test')), ...walk(path.join(ROOT, 'panel'))];
const badSyntax = [];
for (const f of files) {
  const r = run(['--check', f], { allowFail: true });
  if (r.code !== 0) badSyntax.push({ f: path.relative(ROOT, f), out: r.out.trim() });
}
record(
  `语法 ${files.length} 个脚本`,
  badSyntax.length === 0,
  badSyntax.length ? badSyntax.map((b) => `${b.f}: ${b.out.split('\n')[0]}`).join(' | ') : ''
);

// ---------- 2. 单测 ----------
if (FAST) {
  record('单测（--fast 跳过）', true, '', 'info');
} else {
  const testDir = path.join(ROOT, 'test');
  const tests = fs
    .readdirSync(testDir)
    .filter((f) => f.endsWith('.test.mjs'))
    .map((f) => path.join('test', f));
  const r = run(['--test', ...tests]);
  const m = /# pass (\d+)[\s\S]*?# fail (\d+)/.exec(r.out) || /ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/.exec(r.out);
  record(
    `单测 ${tests.length} 个文件`,
    r.code === 0,
    m ? `pass ${m[1]} / fail ${m[2]}` : r.out.split('\n').slice(-6).join(' ')
  );
}

// ---------- 3. 文档版本 ----------
{
  const r = run(['tools/sync_docs.mjs', '--check'], { allowFail: true });
  record('README 版本行', r.code === 0, r.out.trim().split('\n')[0] || '');
}

// ---------- 4. 面板拆分 ----------
{
  const html = fs.readFileSync(path.join(ROOT, 'panel', 'index.html'), 'utf8');
  const problems = [];
  const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1]);
  for (const rel of refs) {
    if (!fs.existsSync(path.join(ROOT, 'panel', rel))) problems.push(`缺文件 panel/${rel}`);
  }
  if (/<script[^>]+type="module"/i.test(html)) problems.push('用了 type="module"（file:// 下会被 CORS 拦死）');
  if (!/app\.js/.test(html)) problems.push('没引用 app.js');
  if (!/style\.css/.test(html)) problems.push('没引用 style.css');
  record('面板拆分（经典脚本 + 外部 css）', problems.length === 0, problems.join('；'));
}

// ---------- 5. today.txt 新鲜度 ----------
{
  const p = path.join(ROOT, 'ghost', 'master', 'today.txt');
  if (!fs.existsSync(p)) {
    record('today.txt 存在', false, 'ghost/master/today.txt 不存在，跑 node tools/build_today.mjs');
  } else {
    const head = fs.readFileSync(p, 'utf8').split('\n', 12).join('\n');
    const m = /^date=(\d{4}-\d{2}-\d{2})$/m.exec(head);
    const t = new Date(Date.now() + 8 * 3600e3);
    const todayStr = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
    const fresh = m && m[1] === todayStr;
    record('today.txt 是今天的', true, fresh ? 'date=' + todayStr : `date=${m ? m[1] : '?'}（今天 ${todayStr}），跑 tools/build_today.mjs`, fresh ? 'ok' : 'warn');
  }
}

// ---------- 汇总 ----------
const icon = { ok: '✅', warn: '⚠️ ', error: '❌', info: '·' };
for (const r of rows) {
  console.log(`${icon[r.level]} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
}
const warns = rows.filter((r) => r.level === 'warn').length;
console.log('');
if (failed) {
  console.error(`❌ CI 失败：${failed} 项不通过${warns ? `，另有 ${warns} 条警告` : ''}`);
  process.exit(1);
}
console.log(`✅ 全部通过${warns ? `（${warns} 条警告不影响）` : ''}`);
