import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { withLibraryLock } from '../lib/library-lock.mjs';

const moduleUrl = new URL('../lib/library-lock.mjs', import.meta.url).href;
function child(root, code) {
  return spawn(process.execPath, ['--input-type=module', '-e', `import {withLibraryLock} from ${JSON.stringify(moduleUrl)}; import fs from 'node:fs/promises'; const root=process.argv[1]; ${code}`, root], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

test('多个进程同时读改写不会丢增量', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tiara-lock-'));
  await fs.writeFile(path.join(root, 'counter'), '0');
  const workers = Array.from({length:3}, () => child(root, `
    for(let i=0;i<5;i++) await withLibraryLock(root,async()=>{
      const p=root+'/counter'; const n=Number(await fs.readFile(p,'utf8'));
      await new Promise(r=>setTimeout(r,10)); await fs.writeFile(p,String(n+1));
    });
  `));
  t.after(() => workers.forEach(p=>p.kill()));
  const exits = await Promise.all(workers.map(p=>once(p,'exit')));
  assert.ok(exits.every(([code])=>code===0));
  assert.equal(await fs.readFile(path.join(root,'counter'),'utf8'),'15');
});

test('写入进程被终止后，下一进程可回收遗留锁', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tiara-lock-crash-'));
  const p = child(root, `await withLibraryLock(root,async()=>{process.stdout.write('ready');await new Promise(()=>setInterval(()=>{},1000));});`);
  t.after(()=>p.kill());
  await once(p.stdout,'data');
  const gone=once(p,'exit'); p.kill(); await gone;
  const result=await withLibraryLock(root,async()=>42,{timeoutMs:3000});
  assert.equal(result,42);
  await assert.rejects(fs.access(path.join(root,'data/.library-lock')));
});
