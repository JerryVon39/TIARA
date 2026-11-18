import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from './atomic.mjs';

const journalPath = root => path.join(root, 'data', '.progress-pending.json');
const historyPath = root => path.join(root, 'data', 'history.jsonl');
const isId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);

export async function progressJournal(root) {
  try {
    const journal = JSON.parse(await fs.readFile(journalPath(root), 'utf8'));
    if (!isId(journal?.id) || !Number.isSafeInteger(journal.offset) || journal.offset < 0)
      throw new Error('无效的观看记录恢复文件');
    return journal;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return null;
  }
}

// 这两个操作只在番库写锁内运行。番库的原子替换是事务提交点。
export async function recoverProgress(root) {
  const journal = await progressJournal(root);
  if (!journal) return;
  const raw = await fs.readFile(path.join(root, 'data', 'library.json'), 'utf8');
  const library = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (library.history_commit !== journal.id) {
    const history = await fs.stat(historyPath(root));
    if (!history.isFile() || history.size < journal.offset)
      throw new Error('无法核对未完成的观看历史，请保留文件并检查备份');
    await fs.truncate(historyPath(root), journal.offset);
  }
  await fs.unlink(journalPath(root));
}

export async function commitProgress(root, library, record, save, log) {
  if (!isId(record.history_id)) throw new Error('无效的观看记录编号');
  const file = historyPath(root);
  const line = JSON.stringify(record) + '\n';
  try {
    const handle = await fs.open(file, 'a+');
    try {
      const previous = await handle.stat();
      if (!previous.isFile()) throw new Error('观看历史路径不是普通文件');
      let separator = '';
      if (previous.size) {
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, previous.size - 1);
        if (last[0] !== 10) separator = '\n';
      }
      await writeJsonAtomic(journalPath(root), { id: record.history_id, offset: previous.size });
      await handle.appendFile(separator + line, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    library.history_commit = record.history_id;
    const saved = await save();
    await fs.unlink(journalPath(root)).catch(error => log('warn', '观看记录已保存，暂未清理恢复文件：' + error.code));
    return saved;
  } catch (error) {
    log('error', '观看进度写入失败：' + (error.code || error.message));
    try {
      await recoverProgress(root);
    } catch (recoveryError) {
      log('error', '观看进度恢复失败：' + (recoveryError.code || recoveryError.message));
      throw new Error('观看记录未能保存或安全恢复。请检查数据目录，修复后再重试。');
    }
    throw new Error('观看记录未保存，进度没有改变。请检查数据目录是否可写，再重试。');
  }
}
