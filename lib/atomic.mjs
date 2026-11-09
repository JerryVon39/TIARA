/**
 * lib/atomic.mjs — 原子写盘（零依赖）
 *
 * 为什么单独抽出来：项目里有四五个地方在写「别人正在读」的文件——
 *   · server 写 data/library.json，面板 / 桌宠可能同时在读
 *   · build_today 写 ghost/master/today.txt，桌宠每 4 秒轮询一次 mtime
 *   · build_today 写 data/today.json，面板刷新时在读
 * 以前的写法是 fs.writeFile 直接覆盖：文件被截断的那一瞬间读到，就是「追番全没了」
 * 或者「今天没番」。这里统一改成「同目录临时文件 → rename」，rename 在同一分区是
 * 原子的：读的人要么看到旧内容，要么看到新内容，不会看到半截。
 *
 * 注意：临时文件必须和目标同目录，跨分区 rename 会退化成 copy（不原子）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

let seq = 0;

/** rename 在 Windows 上偶发 EPERM/EBUSY（杀软、索引器、另一进程正开着目标文件），重试即可 */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_TRIES = 6;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 原子写文本文件。
 * @param {string} absPath 目标绝对路径
 * @param {string|Buffer} data
 * @param {{encoding?:BufferEncoding, mode?:number}} [opts]
 */
export async function writeFileAtomic(absPath, data, opts = {}) {
  const dir = path.dirname(absPath);
  await fs.mkdir(dir, { recursive: true });
  // 名字里带 pid + 递增序号：两个进程同时写也不会抢同一个临时文件
  const tmp = path.join(dir, `.${path.basename(absPath)}.${process.pid}.${++seq}.tmp`);
  try {
    await fs.writeFile(tmp, data, opts.encoding ? { encoding: opts.encoding, mode: opts.mode } : { mode: opts.mode });
    for (let attempt = 1; ; attempt++) {
      try {
        await fs.rename(tmp, absPath);
        return;
      } catch (e) {
        if (attempt >= RENAME_TRIES || !RENAME_RETRY_CODES.has(e.code)) throw e;
        // 5ms → 80ms：给占着句柄的那一方一点时间松手
        await sleep(5 * 2 ** (attempt - 1));
      }
    }
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** 原子写 JSON（2 空格缩进 + 结尾换行，和项目里其它 JSON 保持一致） */
export async function writeJsonAtomic(absPath, obj) {
  await writeFileAtomic(absPath, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8' });
}

/** 读 JSON：文件不存在 / 解析失败都抛出带文件名的错误，别只丢一句 "Unexpected token" */
export async function readJsonFile(absPath) {
  let raw;
  try {
    raw = await fs.readFile(absPath, 'utf8');
  } catch (e) {
    const err = new Error(`读不到 ${absPath}：${e.message}`);
    err.code = e.code;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${absPath} 不是合法 JSON：${e.message}`);
  }
}
