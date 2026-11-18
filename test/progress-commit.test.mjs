import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { commitProgress, recoverProgress } from '../lib/progress-commit.mjs';

test('观看事务中间失败或重启，只保留与已提交番库相符的历史', async () => {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'tiara-commit-test-'));
  try {
    const data = path.join(root, 'data');
    await fs.mkdir(data);
    const history = path.join(data, 'history.jsonl');
    const library = path.join(data, 'library.json');
    const journal = path.join(data, '.progress-pending.json');
    const old = '{"name":"旧记录"}';
    await fs.writeFile(history, old);
    await fs.writeFile(library, '{"watching":[]}');
    const id = 'a'.repeat(32);
    const row = { history_id: id, delta: 1 };
    await assert.rejects(commitProgress(root, {}, row, () => { throw new Error('模拟番库提交失败'); }, () => {}),
      /进度没有改变/);
    assert.equal(await fs.readFile(history, 'utf8'), old);
    await assert.rejects(fs.stat(journal), { code: 'ENOENT' });
    const pending = JSON.stringify({ id, offset: Buffer.byteLength(old) });
    const line = '\n' + JSON.stringify(row) + '\n';
    // Simulate an interruption on either side of the atomic replacement.
    await fs.appendFile(history, line);
    await fs.writeFile(journal, pending);
    await recoverProgress(root);
    assert.equal(await fs.readFile(history, 'utf8'), old);
    await fs.appendFile(history, line);
    await fs.writeFile(journal, pending);
    await fs.writeFile(library, JSON.stringify({ watching: [], history_commit: id }));
    await recoverProgress(root);
    await recoverProgress(root);
    assert.equal(await fs.readFile(history, 'utf8'), old + line);
  } finally {
    const target = await fs.realpath(root);
    if (path.dirname(target) === temp && path.basename(target).startsWith('tiara-commit-test-'))
      await fs.rm(target, { recursive: true });
  }
});
