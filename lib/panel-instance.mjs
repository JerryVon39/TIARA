import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { APP_ID } from './version.mjs';

export function panelId(root) {
  let name = path.resolve(root).replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32') name = name.toLowerCase();
  return createHash('sha256').update(name).digest('hex');
}

export const panelPortFile = root => path.join(root, 'cache', 'panel_port.txt');
export const panelControlFile = root => path.join(root, 'cache', 'panel_control.json');

export async function probePanel(port, id) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(400) });
    if (!r.ok) return null;
    const j = await r.json();
    return j.ok && j.app === APP_ID && j.instance === id && j.port === port ? j : null;
  } catch { return null; }
}

export async function findPanel(root, startPort = 7788) {
  const id = panelId(root);
  const recorded = Number(await fs.readFile(panelPortFile(root), 'utf8').catch(() => ''));
  const preferred = await probePanel(recorded, id);
  if (preferred) return preferred;
  const ports = Array.from({ length: 12 }, (_, i) => startPort + i).filter(p => p !== recorded);
  return (await Promise.all(ports.map(p => probePanel(p, id)))).find(Boolean) || null;
}
