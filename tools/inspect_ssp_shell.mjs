#!/usr/bin/env node
import { inspectSspShell, renderSspPreview } from '../lib/ssp-shell-preview.mjs';
import { writeFileAtomic } from '../lib/atomic.mjs';

const [source, ...args] = process.argv.slice(2);
function arg(name) { return args.includes(name) ? args[args.indexOf(name) + 1] : null; }
try {
  if (!source || source.startsWith('--')) throw new Error('用法：node tools/inspect_ssp_shell.mjs <shell目录> [--surface 0] [--html 预览.html]');
  const report = await inspectSspShell(source, Number(arg('--surface') ?? 0));
  const html = arg('--html');
  if (html) await writeFileAtomic(html, renderSspPreview(report));
  const { layers, ...info } = report;
  console.log(JSON.stringify({ ...info, layers: layers.map(({ data, ...layer }) => layer) }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
