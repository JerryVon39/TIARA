import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const versions = new Map();

async function fileVersion(exe) {
  const stat = await fs.stat(exe).catch(() => null);
  if (!stat?.isFile()) return { exists: false, version: null };
  if (process.platform !== 'win32') return { exists: true, version: null };
  const stamp = [stat.size, stat.mtimeMs, stat.ctimeMs].join('/');
  const cached = versions.get(exe);
  if (cached?.stamp === stamp) return cached.result;
  const result = (async () => {
    const system = process.env.SystemRoot || 'C:\\Windows';
    const ps = path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try {
      const { stdout } = await run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        '[System.Diagnostics.FileVersionInfo]::GetVersionInfo($env:TIARA_DIAG_EXE).FileVersion'],
      { windowsHide: true, timeout: 2500, env: { ...process.env, TIARA_DIAG_EXE: exe } });
      return { exists: true, version: /^\d+\.\d+\.\d+(?=\.|$)/.exec(stdout.trim())?.[0] ?? null };
    } catch {
      return { exists: true, version: null };
    }
  })();
  versions.set(exe, { stamp, result });
  return result;
}

export async function launchDiagnostics(root) {
  const launcher = path.join(root, '启动TIARA.bat');
  const exe = path.join(root, 'pet', 'Pet.exe');
  const script = await fs.readFile(launcher, 'utf8').catch(() => null);
  const operand = script?.match(/^\s*start\s+""\s+"([^"\r\n]+\.exe)"\s*$/im)?.[1];
  let target = null;
  if (operand?.toLowerCase().startsWith('%~dp0')) {
    const relative = operand.slice(5).replace(/\\/g, '/');
    if (!relative.includes('%')) target = path.resolve(root, relative);
  } else if (operand && path.isAbsolute(operand) && !operand.includes('%')) {
    target = path.normalize(operand);
  }
  const [binary, launched] = await Promise.all([fileVersion(exe), target ? fileVersion(target) : null]);
  return { script: { path: launcher, exists: script !== null, target, binary: launched }, binary: { path: exe, ...binary } };
}
