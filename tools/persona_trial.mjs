#!/usr/bin/env node
import { inspectPersona, restorePersona, switchPersona } from '../lib/persona-trial.mjs';

try {
  const [command, first, second] = process.argv.slice(2);
  if (command === 'inspect' && first) {
    const { shell, talks, ...info } = await inspectPersona(first);
    console.log(JSON.stringify(info, null, 2));
    if (info.problems.length) process.exitCode = 1;
  } else if (command === 'switch' && first && second) {
    console.log(JSON.stringify(await switchPersona(second, first), null, 2));
  } else if (command === 'restore' && first) {
    await restorePersona(first);
    console.log('已恢复试验前的台词和外观。');
  } else throw new Error('用法：persona_trial.mjs inspect <素材目录> | switch <素材目录> <试验目录> | restore <试验目录>');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
