#!/usr/bin/env node
// 产物清单：给 dist/ 里的东西列一份 path / size / sha256，方便校验「发出去的东西有没有被动过」。
// 用法：node tools/manifest.mjs [--dir dist] [--out dist/manifest.json] [--check] [--json]
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 递归列文件（跳过 manifest 自身） */
function walk(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, base, acc);
    else if (!/manifest\.json$/.test(name)) acc.push({ path: relative(base, p).replace(/\\/g, '/'), size: st.size });
  }
  return acc;
}

/** 算一份清单（不写盘） */
export function buildManifest(dir) {
  const files = walk(dir).sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const f of files) f.sha256 = createHash('sha256').update(readFileSync(join(dir, f.path))).digest('hex');
  return { built_at: new Date().toISOString(), dir: dir.replace(/\\/g, '/'), count: files.length, bytes: files.reduce((n, f) => n + f.size, 0), files };
}

/** 拿现有 manifest 和实际文件比：返回 {ok, missing, changed, extra} */
export function checkManifest(dir, man) {
  const now = buildManifest(dir);
  const have = new Map(man.files.map((f) => [f.path, f.sha256]));
  const real = new Map(now.files.map((f) => [f.path, f.sha256]));
  const missing = [...have.keys()].filter((k) => !real.has(k));
  const extra = [...real.keys()].filter((k) => !have.has(k));
  const changed = [...have.keys()].filter((k) => real.has(k) && have.get(k) !== real.get(k));
  return { ok: !missing.length && !changed.length, missing, changed, extra };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/manifest.mjs')) {
  const dirArg = process.argv.indexOf('--dir');
  const dir = join(ROOT, dirArg > 0 ? process.argv[dirArg + 1] : 'dist');
  const outArg = process.argv.indexOf('--out');
  const out = outArg > 0 ? join(ROOT, process.argv[outArg + 1]) : join(dir, 'manifest.json');
  if (!existsSync(dir)) {
    console.log('✖ 没有这个目录：' + dir);
    process.exit(1);
  }
  if (process.argv.includes('--check')) {
    if (!existsSync(out)) { console.log('✖ 还没有 manifest.json，先跑一次不带 --check 的'); process.exit(1); }
    const man = JSON.parse(readFileSync(out, 'utf8'));
    const r = checkManifest(dir, man);
    if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
    else if (r.ok) console.log(`✅ 清单一致：${man.count} 个文件`);
    else {
      for (const m of r.missing) console.log('✖ 少了 ' + m);
      for (const c of r.changed) console.log('✖ 变了 ' + c);
      for (const x of r.extra) console.log('· 多出来 ' + x);
    }
    process.exit(r.ok ? 0 : 1);
  }
  const man = buildManifest(dir);
  writeFileSync(out, JSON.stringify(man, null, 2) + '\n', 'utf8');
  if (process.argv.includes('--json')) console.log(JSON.stringify({ out, count: man.count, bytes: man.bytes }, null, 2));
  else console.log(`→ ${out}（${man.count} 个文件，${(man.bytes / 1048576).toFixed(1)} MB）`);
}
