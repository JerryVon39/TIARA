import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Lock the whole read/modify/write transaction, across server and CLI processes.
// Owners have unique filenames: reclaiming a dead owner cannot unlink a new owner.
export async function withLibraryLock(root, fn, { timeoutMs = 30000 } = {}) {
  const dir = path.join(root, 'data', '.library-lock');
  const owner = `${process.pid}-${randomUUID()}`;
  const file = path.join(dir, owner);
  const deadline = Date.now() + timeoutMs;
  await fs.mkdir(path.dirname(dir), { recursive: true });
  for (;;) {
    try {
      await fs.mkdir(dir);
      try { await fs.writeFile(file, '', { flag: 'wx' }); }
      catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owners = await fs.readdir(dir).catch(() => null);
      if (owners) {
        for (const name of owners) {
          const pid = Number(/^(\d+)-/.exec(name)?.[1]);
          if (!pid) continue;
          try { process.kill(pid, 0); }
          catch (err) {
            if (err.code === 'ESRCH') await fs.unlink(path.join(dir, name)).catch(() => {});
          }
        }
        const st = await fs.stat(dir).catch(() => null);
        if (owners.length || (st && Date.now() - st.mtimeMs > 30000)) {
          await fs.rmdir(dir).catch(() => {}); // succeeds only when empty
        }
      }
      if (Date.now() >= deadline) throw new Error('写入正在被其他进程占用，请稍后重试');
      await new Promise(r => setTimeout(r, 25));
    }
  }
  try { return await fn(); }
  finally {
    await fs.unlink(file).catch(() => {});
    await fs.rmdir(dir).catch(() => {});
  }
}
