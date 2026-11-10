// tools/rename.mjs — 把项目里的旧名字（TIARA / Tiara / Tiara）统一换成新名字。
//
//   node tools/rename.mjs --to TIARA --dry-run     # 只看会改什么
//   node tools/rename.mjs --to TIARA --apply       # 真正落盘
//
// 只改「展示文案」，不动任何数据契约（data/*.json 的键名、today.txt 的变量名、
// ghost/master 目录名都保持原样），所以换名不会砸掉已有库与 SSP 人格。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 跳过：版本库/缓存/依赖/二进制目录。
 * `dist/` 里是 zip（二进制，改了就坏），改名后重打一遍即可：
 *   npm run pack   →  dist/TIARA-ssp.zip + dist/TIARA-portable-*.zip
 */
const SKIP_DIRS = new Set([
  '.git', 'cache', 'node_modules', 'dist', 'runtime',
  'bin', 'obj', 'season', 'backups',
]);

const EXTS = new Set([
  '.md', '.mjs', '.js', '.cs', '.html', '.css', '.json', '.txt',
  '.bat', '.ps1', '.py', '.yml', '.yaml', '.cmd',
]);

/** 旧名 → 新名。顺序有讲究：先长后短，避免「Tiara」被「tiara」规则截胡。 */
function buildPairs(to) {
  const t = String(to || 'TIARA').trim();
  const lower = t.toLowerCase();
  const title = t.charAt(0).toUpperCase() + lower.slice(1);
  return [
    ['TIARA', t],
    ['Tiara', title],
    ['tiara', lower],
    ['Tiara', title],
    ['tiara', lower],
  ];
}

/** 要改名的文件（不是改内容，是改文件名本身） */
function renamePlan(to) {
  const t = String(to || 'TIARA').trim();
  const map = [];
  for (const name of ['启动TIARA.bat', '停止TIARA.bat']) {
    if (fs.existsSync(path.join(ROOT, name))) {
      map.push([name, name.replace('TIARA', t)]);
    }
  }
  return map;
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (!EXTS.has(ext)) continue;
      if (/\.log$/i.test(e.name) || /\.bak$/i.test(e.name)) continue;
      out.push(path.join(dir, e.name));
    }
  }
}

function findReplace(text, pairs) {
  let out = text;
  let n = 0;
  for (const [from, to] of pairs) {
    const parts = out.split(from);
    if (parts.length > 1) {
      n += parts.length - 1;
      out = parts.join(to);
    }
  }
  return { out, n };
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const ti = args.indexOf('--to');
  const to = ti >= 0 ? args[ti + 1] : 'TIARA';
  const pairs = buildPairs(to);

  const files = [];
  walk(ROOT, files);

  const hits = [];
  for (const abs of files) {
    let raw;
    try {
      raw = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const { out, n } = findReplace(raw, pairs);
    if (!n) continue;
    // 找出第一处变化，好让人核对
    const firstOld = raw.split(/\r?\n/).find((l) => pairs.some(([f]) => l.includes(f))) || '';
    hits.push({
      rel: path.relative(ROOT, abs).replace(/\\/g, '/'),
      abs, n, raw, out,
      sample: firstOld.trim().slice(0, 100),
    });
  }

  console.log(`${apply ? '应用' : '预览'}：${pairs.map(([a, b]) => a + '→' + b).join('  ')}`);
  console.log(`命中 ${hits.length} 个文件、共 ${hits.reduce((s, h) => s + h.n, 0)} 处\n`);
  for (const h of hits) {
    console.log(`  ${String(h.n).padStart(3)} 处  ${h.rel}`);
    if (!apply) console.log(`        例：${h.sample}`);
  }

  const renames = renamePlan(to);
  if (renames.length) {
    console.log('\n文件改名：');
    for (const [from, toName] of renames) console.log(`  ${from}  →  ${toName}`);
  }

  if (!apply) {
    console.log('\n（预览模式，什么都没写。确认没问题后加 --apply）');
    return;
  }

  for (const h of hits) fs.writeFileSync(h.abs, h.out, 'utf8');
  for (const [from, toName] of renames) {
    fs.renameSync(path.join(ROOT, from), path.join(ROOT, toName));
  }
  console.log(`\n已写入 ${hits.length} 个文件${renames.length ? '，并改名 ' + renames.length + ' 个' : ''}。`);
  console.log('下一步：node tools/build_today.mjs && node tools/build_ghost.mjs && node tools/build_pet.mjs');
}

main();
