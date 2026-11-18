#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../lib/version.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = `dist/v${VERSION}`;
const expected = [`TIARA-portable-${VERSION}.zip`, `TIARA-ssp-${VERSION}.zip`];
const run = (tool, ...args) => execFileSync(process.execPath, [path.join(root, tool), ...args],
  { cwd: root, windowsHide: true, stdio: 'inherit' });
if (!process.argv.includes('--check')) {
  run('tools/validate_talks.mjs', '--release');
  run('tools/build_pet.mjs');
  run('tools/pack_portable.mjs', '--out', `${directory}/${expected[0]}`);
  run('tools/pack_ssp.mjs', '--out', `${directory}/${expected[1]}`);
}
const files = fs.readdirSync(path.join(root, directory)).filter(name => name !== 'manifest.json').sort();
if (JSON.stringify(files) !== JSON.stringify(expected)) throw new Error(`发行目录应只包含 ${expected.join(' 和 ')}`);
if (!process.argv.includes('--check')) run('tools/manifest.mjs', '--dir', directory);
run('tools/manifest.mjs', '--dir', directory, '--check');
