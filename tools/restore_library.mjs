#!/usr/bin/env node
/**
 * 从备份恢复 data/library.json —— 一条命令，不用记路径。
 *
 *   node tools/restore_library.mjs --list          # 看有哪些备份
 *   node tools/restore_library.mjs --latest        # 用最近一份覆盖（先备份当前文件）
 *   node tools/restore_library.mjs --name library-20261105-010000.json
 *   node tools/restore_library.mjs --latest --check-only   # 只校验备份是否健康
 *
 * 触发场景：库被写坏（乱码 / 空 watching / 分不清哪次改坏的）。
 * 恢复后会自动重算 today.txt 与两份 today.json，桌宠 4 秒内跟上。
 */
import fs from 'node:fs/promises';
import { withLibraryLock } from '../lib/library-lock.mjs';
import { restoreLibrary } from '../lib/library.mjs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LIB = path.join(ROOT, 'data', 'library.json');
const BACKUP_DIR = path.join(ROOT, 'data', 'backups');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : '';
};

/** 库「健康」的最低标准：能解析、有 watching 数组、中文没坏成双重编码 */
function inspect(text) {
  let lib;
  try {
    lib = JSON.parse(text);
  } catch (e) {
    return { ok: false, why: 'JSON 解析失败：' + e.message };
  }
  if (!Array.isArray(lib.watching)) return { ok: false, why: '没有 watching 数组' };
  const bad = ['锛', '銆', '绾', '鐢', '瓒', '鍦', '鏄', '锟', '\uFFFD'].filter((ch) => text.includes(ch));
  if (bad.length) return { ok: false, why: '疑似编码损坏（命中 ' + bad.join(' ') + '）' };
  return { ok: true, watching: lib.watching.length, weekday: Object.keys(lib.weekday || {}).length };
}

async function listBackups() {
  const out = [];
  for (const [dir, tag] of [[BACKUP_DIR, 'backups'], [path.join(ROOT, 'data'), 'data/*.bak']]) {
    let names = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^library-.*\.json$/.test(name) && !name.endsWith('.json.bak')) continue;
      const full = path.join(dir, name);
      const st = await fs.stat(full);
      const text = await fs.readFile(full, 'utf8').catch(() => '');
      out.push({ tag, name, full, mtime: st.mtime, size: st.size, health: inspect(text) });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function rebuild() {
  const tools = ['build_today.mjs', 'build_ghost.mjs', 'build_yaya.mjs'];
  return tools.reduce((p, t) => p.then(() => new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, 'tools', t)], { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) console.log(`  ✗ ${t}：${String(stderr || err.message).trim().split('\n').pop()}`);
      else console.log(`  ✓ ${t}`);
      resolve();
    });
  })), Promise.resolve());
}

async function main() {
  const backups = await listBackups();

  if (has('--list') || backups.length === 0) {
    if (!backups.length) {
      console.log('没有找到备份（data/backups/library-*.json 或 data/library.json.bak）');
      process.exit(backups.length ? 0 : 1);
    }
    console.log(`共 ${backups.length} 份备份（新的在前）：`);
    for (const b of backups.slice(0, 15)) {
      const t = new Date(b.mtime.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      const h = b.health.ok ? `watching=${b.health.watching}` : `不可用：${b.health.why}`;
      console.log(`  ${t}  ${(b.size / 1024).toFixed(1).padStart(6)} KB  ${b.tag}/${b.name}  ${h}`);
    }
    process.exit(0);
  }

  const want = val('--name');
  const pick = want ? backups.find((b) => b.name === want) : backups[0];
  if (!pick) {
    console.error(`没找到备份：${want}`);
    process.exit(1);
  }
  if (!pick.health.ok) {
    console.error(`这份备份不可用（${pick.health.why}）：${pick.full}`);
    process.exit(1);
  }

  const text = await fs.readFile(pick.full, 'utf8');
  console.log(`选用：${pick.full}`);
  console.log(`  内容：watching=${pick.health.watching}，weekday ${pick.health.weekday} 天，${(pick.size / 1024).toFixed(1)} KB`);

  if (has('--check-only') || has('--dry-run')) {
    console.log('（--check-only，没有动 data/library.json）');
    process.exit(0);
  }

  await withLibraryLock(ROOT, () => restoreLibrary(ROOT, pick.name));
  console.log('已恢复 data/library.json，重算产物：');
  await rebuild();
  console.log('完成。桌宠 4 秒内自动跟随；面板刷新一下即可。');
}

main().catch((e) => {
  console.error('恢复失败：' + e.message);
  process.exit(1);
});
