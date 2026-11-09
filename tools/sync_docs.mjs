#!/usr/bin/env node
/**
 * 文档版本同步：让「版本号 + 发版日期」不再靠手改。
 *
 *   node tools/sync_docs.mjs           # 改 README 的版本行
 *   node tools/sync_docs.mjs --check   # 只检查，不一致就 exit 1（给 CI/doctor 用）
 *
 * 版本号只有一个来源：package.json。
 * 发版日期也只有一个来源：docs/CHANGELOG.md 里「## [x.y.z] — YYYY-MM-DD」那一条。
 *
 * 以前日期直接取「运行当天」，于是只要隔几天跑一次同步，README 就会显示
 * 「当前版本 v0.25.0 · 今天」——看着像今天发的版，其实一行代码都没改。
 * 现在如果 CHANGELOG 里没有对应版本，就保留 README 原有日期并告警，绝不自己编。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const checkOnly = process.argv.includes('--check');

const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`package.json 的 version 不是 1.2.3 形式：${JSON.stringify(pkg.version)}`);
  process.exit(2);
}

const readmePath = path.join(ROOT, 'README.md');
const readme = await fs.readFile(readmePath, 'utf8');
const re = /^当前版本 v([\d.]+) · (\d{4}-\d{2}-\d{2})$/m;
const found = readme.match(re);
if (!found) {
  console.error('README.md 里找不到「当前版本 vX · YYYY-MM-DD」这一行');
  process.exit(2);
}
const curDate = found[2];

/** CHANGELOG 里这个版本的发版日期（没有就返回 null） */
async function releasedOn(v) {
  let text = '';
  try {
    text = await fs.readFile(path.join(ROOT, 'docs', 'CHANGELOG.md'), 'utf8');
  } catch {
    return null; // 还没有 CHANGELOG 的项目阶段，允许缺
  }
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^##\\s*\\[${esc}\\][^\\n]*?(\\d{4}-\\d{2}-\\d{2})`, 'm').exec(text);
  return m ? m[1] : null;
}

const stamped = await releasedOn(version);
const date = stamped || curDate;
if (!stamped) {
  console.warn(`docs/CHANGELOG.md 里没有 v${version} 的日期，沿用 README 原日期 ${curDate}`);
}

const line = `当前版本 v${version} · ${date}`;
const cur = found[0];

if (cur === line) {
  console.log(`README 版本行已是最新：${line}`);
  process.exit(0);
}

if (checkOnly) {
  console.error(`README 版本行过期：现在「${cur}」，应为「${line}」（跑 node tools/sync_docs.mjs）`);
  process.exit(1);
}

await fs.writeFile(readmePath, readme.replace(re, line), 'utf8');
console.log(`README 版本行 → ${line}`);
