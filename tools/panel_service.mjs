import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { findPanel, panelControlFile } from '../lib/panel-instance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];

async function start() {
  const existing = await findPanel(root);
  if (existing) return existing;

  const child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: root, detached: true, windowsHide: true, stdio: 'ignore',
  });
  let launchError;
  child.once('error', error => { launchError = error; });
  child.unref();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    const service = await findPanel(root);
    if (service) return service;
    await delay(150);
  }
  throw new Error('网页服务未就绪，请查看 cache/server.log。');
}

async function stop() {
  const service = await findPanel(root);
  if (!service) return;
  const control = JSON.parse(await fs.readFile(panelControlFile(root), 'utf8'));
  if (control.instance !== service.instance || control.pid !== service.pid || control.port !== service.port || !/^[a-f0-9]{64}$/.test(control.token)) {
    throw new Error('服务身份已变化，请重试。');
  }
  const r = await fetch(`http://127.0.0.1:${service.port}/api/_shutdown`, {
    method: 'POST', headers: { 'x-tiara-control': control.token }, signal: AbortSignal.timeout(1500),
  }).catch(async e => {
    // 桌宠可能在身份检查之后退出并同时关闭自己的服务。
    if (!(await findPanel(root))) return null;
    throw e;
  });
  if (r && !r.ok) throw new Error('服务没有接受关闭请求，请重试。');
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if ((await findPanel(root))?.pid !== service.pid) return;
    await delay(100);
  }
  throw new Error('等待网页服务退出超时。');
}

try {
  if (mode === '--stop') await stop();
  else if (mode === '--port') console.log((await start()).port);
  else throw new Error('用法：panel_service.mjs --port | --stop');
} catch (e) {
  console.error(`[tiara] ${e.message}`);
  process.exitCode = 1;
}
