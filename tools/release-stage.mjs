import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { redactCredentials } from '../lib/migration.mjs';

export function withReleaseStage(root, callback, { privateSnapshot = false } = {}) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'tiara-release-'));
  try {
    fs.mkdirSync(path.join(stage, 'data'), { recursive: true });
    const defaults = {
      'library.json': { version: 1, updated: '', user: {}, watching: [], weekday: {}, dropped: [], trivia: {} },
      'settings.json': { clock: '30h', pet_scale: 1 },
    };
    for (const [name, value] of Object.entries(defaults)) {
      const target = path.join(stage, 'data', name);
      const source = path.join(root, 'data', name);
      const content = privateSnapshot && (name === 'library.json' || fs.existsSync(source)) ?
        redactCredentials(JSON.parse(fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, ''))) : value;
      fs.writeFileSync(target, JSON.stringify(content, null, 2) + '\n', 'utf8');
    }
    fs.copyFileSync(path.join(root, 'tools/release/talks.json'), path.join(stage, 'data/talks.json'));
    if (fs.existsSync(path.join(root, 'shell/master')))
      fs.cpSync(path.join(root, 'shell/master'), path.join(stage, 'shell/master'), { recursive: true });
    for (const tool of ['build_today.mjs', 'build_ghost.mjs'])
      execFileSync(process.execPath, [path.join(root, 'tools', tool), '--root', stage], { windowsHide: true, stdio: 'pipe' });
    return callback(stage);
  } finally {
    const resolved = fs.realpathSync(stage);
    if (path.dirname(resolved) === fs.realpathSync(os.tmpdir()) && path.basename(resolved).startsWith('tiara-release-'))
      fs.rmSync(resolved, { recursive: true, force: true });
  }
}
