#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTalks, validateTalkResources } from '../lib/talks-validation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
function arg(name, defaultValue) {
  const i = args.indexOf(name);
  if (i < 0) return defaultValue;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('请给 ' + name + ' 指定路径');
  return args[i + 1];
}

try {
  const release = args.includes('--release');
  const file = arg('--file', path.join(root, release ? 'tools/release/talks.json' : 'data/talks.json'));
  const shells = release ? ['master', 'tiara2'].map(name => path.join(root, 'shell', name))
    .filter((folder, i) => i === 0 || fs.existsSync(folder)) : [arg('--shell', path.join(root, 'shell', 'master'))];
  const talks = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const { issues, faces } = validateTalks(talks);
  for (const shell of shells)
    issues.push(...validateTalkResources(shell, faces).map(issue => ({ ...issue, at: path.relative(root, shell) + '/' + issue.at })));
  if (issues.length) {
    for (const issue of issues) console.error(issue.at + ' · ' + issue.message);
    process.exitCode = 1;
  } else console.log('台词检查通过 · ' + Object.keys(talks).length + ' 项定义 · ' + shells.length + ' 套立绘');
} catch (error) {
  console.error('台词检查失败 · ' + error.message);
  process.exitCode = 1;
}
