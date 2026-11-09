/**
 * lib/library.mjs — data/library.json 的读写与保险（零依赖）
 *
 * 这个文件原来整块长在 server.mjs 里，导致两个后果：
 *   1. 没有任何单测能覆盖「写库」这件事（server.mjs 是启动即监听，import 不进来）
 *   2. /api/restore 顺手用了 fs.writeFile 直写，绕过这里的所有护栏
 *
 * 现在写库只有一条路：writeLibrary()。它保证——
 *   · updated 字段是「这次写入」的 CST 日期（旧实现先序列化再改字段，落盘的永远是上一次的值）
 *   · 落盘前检查编码损坏（U+FFFD）与 JSON 可解析
 *   · 写前留 .bak + 滚动 5 份 data/backups/library-<CST>.json
 *   · 撤销栈：把「写之前的内容」压进 data/undo（最多 10 步）
 *   · 原子写（lib/atomic.mjs）
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomic, writeJsonAtomic, readJsonFile } from './atomic.mjs';
import { cstParts } from './today.mjs';

export const LIB_REL = path.join('data', 'library.json');
export const UNDO_DIR_REL = path.join('data', 'undo');
export const BACKUP_DIR_REL = path.join('data', 'backups');
export const BACKUP_FIXED = 'library.json.bak';
export const UNDO_KEEP = 10;
export const BACKUP_KEEP = 5;

const libraryAbs = (root) => path.join(root, LIB_REL);
const undoAbs = (root) => path.join(root, UNDO_DIR_REL);
const backupAbs = (root) => path.join(root, BACKUP_DIR_REL);

const noop = () => {};

/** 读库：失败时抛带文件名与处理建议的错误（别让面板只看到 "Unexpected token"） */
export async function readLibrary(root) {
  try {
    return await readJsonFile(libraryAbs(root));
  } catch (e) {
    const err = new Error(e.message);
    err.code = e.code || 'ELIBRARY';
    throw err;
  }
}

/** data/backups/library-20261109-021500.json —— 文件名用 CST，和面板/日志口径一致 */
export function backupName(now = new Date(), seq = 0) {
  const p = cstParts(now);
  const pad = (n) => String(n).padStart(2, '0');
  const tail = seq ? `-${seq}` : '';
  return `library-${p.date.replace(/-/g, '')}-${pad(p.hour)}${pad(p.minute)}${pad(p.second ?? 0)}${tail}.json`;
}

/** 写库前留一份：固定 .bak + 滚动 5 份带时间戳的 */
export async function backupLibrary(root, { log = noop } = {}) {
  const src = libraryAbs(root);
  try {
    await fs.access(src);
  } catch {
    return false; // 首次写库，没有旧文件
  }
  try {
    const raw = await fs.readFile(src, 'utf8');
    await writeFileAtomic(src + '.bak', raw, { encoding: 'utf8' });
    const dir = backupAbs(root);
    await fs.mkdir(dir, { recursive: true });
    // 同一分钟内连写两次时加个序号，别互相覆盖（覆盖了等于少一份可回滚的点）
    let name = backupName();
    let seq = 0;
    while (await exists(path.join(dir, name))) {
      seq += 1;
      if (seq > 99) break;
      name = backupName(new Date(), seq);
    }
    await writeFileAtomic(path.join(dir, name), raw, { encoding: 'utf8' });
    const old = (await fs.readdir(dir)).filter((f) => /^library-.*\.json$/.test(f)).sort();
    while (old.length > BACKUP_KEEP) await fs.rm(path.join(dir, old.shift()), { force: true });
    return true;
  } catch (e) {
    log('error', 'backupLibrary: ' + e.message);
    return false;
  }
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 撤销栈：压入「写之前的内容」 */
export async function pushUndo(root, text, { log = noop } = {}) {
  try {
    const dir = undoAbs(root);
    await fs.mkdir(dir, { recursive: true });
    const name = `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
    await writeFileAtomic(path.join(dir, name), text, { encoding: 'utf8' });
    const files = (await fs.readdir(dir)).filter((f) => /^step-.*\.json$/.test(f)).sort();
    while (files.length > UNDO_KEEP) await fs.rm(path.join(dir, files.shift()), { force: true });
  } catch (e) {
    log('error', 'pushUndo: ' + e.message);
  }
}

/** 弹出最近一步（返回快照文本，没有则 null） */
export async function popUndo(root) {
  let files;
  try {
    files = (await fs.readdir(undoAbs(root))).filter((f) => /^step-.*\.json$/.test(f)).sort();
  } catch {
    return null;
  }
  if (!files.length) return null;
  const abs = path.join(undoAbs(root), files[files.length - 1]);
  const text = await fs.readFile(abs, 'utf8');
  await fs.rm(abs, { force: true });
  return text;
}

export async function undoDepth(root) {
  try {
    return (await fs.readdir(undoAbs(root))).filter((f) => /^step-.*\.json$/.test(f)).length;
  } catch {
    return 0;
  }
}

/**
 * 写库（唯一入口）。
 * @param {string} root
 * @param {object} lib        会被就地更新 updated 字段
 * @param {{pushUndo?:boolean, backup?:boolean, log?:Function, source?:string}} [opts]
 * @returns {Promise<string>} 落盘的文本（指纹、断言都用得上）
 */
export async function writeLibrary(root, lib, opts = {}) {
  const { pushUndo: wantUndo = true, backup = true, log = noop, source = '' } = opts;
  if (!lib || typeof lib !== 'object' || Array.isArray(lib)) throw new Error('writeLibrary: 库必须是对象');

  // 关键顺序：先盖时间戳，再序列化。旧代码反着来，所以落盘的 updated 永远慢一拍。
  const updated = cstParts().date;
  lib.updated = updated;
  const text = JSON.stringify(lib, null, 2) + '\n';

  // 护栏一：编码坏掉的库一旦落盘就是「追番全没、名字变乱码」，宁可不写。
  if (text.includes('\uFFFD')) throw new Error('refuse to write: library contains U+FFFD (encoding damage)');
  // 护栏二：序列化结果必须能再解析（NaN / 循环引用之类的问题在这里拦下）
  try {
    JSON.parse(text);
  } catch (e) {
    throw new Error('refuse to write: serialized library is not valid JSON (' + e.message + ')');
  }

  const target = libraryAbs(root);
  if (wantUndo) {
    try {
      const prev = await fs.readFile(target, 'utf8');
      if (prev.trim()) await pushUndo(root, prev, { log });
    } catch {
      /* 首次写库时没有旧文件，正常 */
    }
  }
  if (backup) await backupLibrary(root, { log });
  await writeFileAtomic(target, text, { encoding: 'utf8' });

  const watching = Array.isArray(lib.watching) ? lib.watching.length : 0;
  const hash = createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 10);
  log('info', `写库${source ? '（' + source + '）' : ''}：updated=${updated} watching=${watching} bytes=${Buffer.byteLength(text, 'utf8')} sha1=${hash}`);
  return text;
}

/** 列出可用备份（固定 .bak 在前，其余按名字倒序 = 新的在前） */
export async function listBackups(root) {
  const out = [];
  const fixed = libraryAbs(root) + '.bak';
  try {
    const st = await fs.stat(fixed);
    out.push({ name: BACKUP_FIXED, size: st.size, mtime: st.mtimeMs, fixed: true });
  } catch { /* 还没备份过 */ }
  const dir = backupAbs(root);
  try {
    for (const f of (await fs.readdir(dir)).sort().reverse()) {
      if (!/^library-.*\.json$/.test(f)) continue;
      const st = await fs.stat(path.join(dir, f));
      out.push({ name: f, size: st.size, mtime: st.mtimeMs, fixed: false });
    }
  } catch { /* 没有 backups 目录 */ }
  return out;
}

/** 备份文件的绝对路径；名字不合法或不在清单里返回 null（白名单，挡 ../） */
export async function backupPath(root, name) {
  const safe = /^[A-Za-z0-9._-]+$/.test(name);
  if (!safe) return null;
  const known = await listBackups(root);
  if (!known.some((b) => b.name === name)) return null;
  return name === BACKUP_FIXED
    ? libraryAbs(root) + '.bak'
    : path.join(backupAbs(root), name);
}

/**
 * 从备份恢复：读 → 校验 → 走 writeLibrary（会先备份当前态、压撤销栈、原子落盘）。
 * 旧实现直接 fs.writeFile，既不留撤销点也不更新 updated，还把「恢复前」的坏数据
 * 写进了 .bak —— 等于把唯一的退路也污染了。
 */
export async function restoreLibrary(root, name, opts = {}) {
  const src = await backupPath(root, name);
  if (!src) {
    const err = new Error('没有这份备份：' + name);
    err.code = 'ENOBACKUP';
    throw err;
  }
  const raw = await fs.readFile(src, 'utf8');
  let lib;
  try {
    lib = JSON.parse(raw);
  } catch (e) {
    const err = new Error('备份文件不是合法 JSON：' + e.message);
    err.code = 'EBADBACKUP';
    throw err;
  }
  if (!Array.isArray(lib.watching)) {
    const err = new Error('备份里没有 watching 数组，拒绝覆盖');
    err.code = 'EBADBACKUP';
    throw err;
  }
  // 恢复时不拍备份：此刻的库正是用户要逃开的那个（坏掉 / 误删），
  // 再把它写进 .bak 和滚动备份，等于用坏数据挤掉唯一几份好的退路。
  // 撤销栈照压 —— 「恢复错了」还能一步退回去。
  await writeLibrary(root, lib, { ...opts, backup: false, source: 'restore:' + name });
  return lib;
}

/** 供工具脚本用：把任意对象写成规范的库文件（不做备份/撤销） */
export async function writeLibraryRaw(root, lib) {
  await writeJsonAtomic(libraryAbs(root), lib);
}
