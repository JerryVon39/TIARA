import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeFileAtomic, writeJsonAtomic } from './atomic.mjs';
import { withLibraryLock } from './library-lock.mjs';
import { validateTalkResources, validateTalks } from './talks-validation.mjs';

const THEMES = ['warm', 'pink', 'blue'];
const SIZES = ['small', 'standard', 'large'];
const APPEARANCE = ['desktop_shell', 'bubble_theme', 'bubble_size'];
const at = (root, ...name) => path.join(root, 'data', ...name);

async function readOptional(file) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function inspectPersona(folder) {
  const manifest = await readOptional(path.join(folder, 'persona.json'));
  if (manifest?.format !== 'tiara-persona' || manifest.schema !== 1 ||
      typeof manifest.id !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(manifest.id) ||
      typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 80 ||
      !THEMES.includes(manifest.theme?.bubble) || !SIZES.includes(manifest.theme?.size))
    throw new Error('人格素材清单格式、编号或主题无效');
  const shell = path.join(folder, 'shell');
  if (!(await fs.lstat(shell).catch(() => null))?.isDirectory()) throw new Error('找不到独立 shell 文件夹');
  const resources = (await fs.readdir(shell, { withFileTypes: true })).filter(entry =>
    /^(?:[^./\\][^/\\]*\.png|faces\.json|surfaces\.json)$/i.test(entry.name));
  if (resources.length > 40) throw new Error('人格素材试验支持最多 40 个图片与配置文件');
  const linked = resources.find(entry => !entry.isFile());
  if (linked) throw new Error('清单引用需要使用素材目录中的常规文件：' + linked.name);
  const files = resources.map(entry => entry.name);
  const file = path.join(folder, 'talks.json');
  if (!(await fs.lstat(file).catch(() => null))?.isFile()) throw new Error('找不到独立 talks.json');
  const talks = await fs.readFile(file, 'utf8');
  const inspected = validateTalks(JSON.parse(talks.replace(/^\uFEFF/, '')));
  const problems = [...inspected.issues, ...validateTalkResources(shell, inspected.faces)];
  return {
    id: manifest.id, name: manifest.name, preview: 'shell/surface0.png', theme: manifest.theme,
    assets: files, problems, shell, talks,
  };
}

async function current(root) {
  const state = await readOptional(at(root, 'state.json')) || {};
  if (typeof state !== 'object' || Array.isArray(state)) throw new Error('当前桌宠状态格式无效');
  const appearance = Object.fromEntries(APPEARANCE.filter(name => Object.hasOwn(state, name)).map(name => [name, state[name]]));
  return { state, appearance, talks: await fs.readFile(at(root, 'talks.json'), 'utf8') };
}

async function checkPreviewRoot(root) {
  if (!(await fs.stat(path.join(root, 'pet', 'Pet.exe')).catch(() => null))?.isFile())
    throw new Error('请指定已解压的便携版试验目录');
  const presence = await readOptional(path.join(root, 'cache', 'pet-presence.json'));
  const pid = presence?.pid;
  if (Number.isInteger(pid) && pid > 0 && Math.abs(Date.now() / 1000 - Number(presence.at)) < 120) {
    let running = true;
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') running = false; else throw error; }
    if (running) throw new Error('桌宠仍在运行，请退出试验目录中的桌宠后切换素材');
  }
}

async function applyFiles(root, snapshot) {
  const { state } = await current(root);
  for (const name of APPEARANCE) delete state[name];
  Object.assign(state, snapshot.appearance);
  await writeFileAtomic(at(root, 'talks.json'), snapshot.talks);
  await writeJsonAtomic(at(root, 'state.json'), state);
}

async function recover(root) {
  const file = at(root, 'persona-trial', 'pending.json');
  const pending = await readOptional(file);
  if (!pending) return;
  await applyFiles(root, pending);
  await fs.unlink(file);
}

async function select(root, next) {
  const previous = await current(root);
  const journal = at(root, 'persona-trial', 'pending.json');
  await writeJsonAtomic(journal, { appearance: previous.appearance, talks: previous.talks });
  try {
    await applyFiles(root, next);
    await fs.unlink(journal);
  } catch (error) {
    await recover(root);
    throw error;
  }
}

export async function switchPersona(root, folder) {
  return withPersonaRoot(root, async () => {
    const plan = await inspectPersona(folder);
    if (plan.problems.length) throw new Error(plan.problems.map(item => item.at + ' · ' + item.message).join('\n'));
    const original = at(root, 'persona-trial', 'original.json');
    if (!await readOptional(original)) {
      const previous = await current(root);
      await writeJsonAtomic(original, { appearance: previous.appearance, talks: previous.talks });
    }
    const slot = 'persona-' + plan.id + '-' + randomBytes(4).toString('hex');
    const destination = path.join(root, 'shell', slot);
    await fs.mkdir(destination);
    for (const asset of plan.assets) await fs.copyFile(path.join(plan.shell, asset), path.join(destination, asset));
    await select(root, { talks: plan.talks, appearance: {
      desktop_shell: slot, bubble_theme: THEMES.indexOf(plan.theme.bubble), bubble_size: SIZES.indexOf(plan.theme.size),
    } });
    return { id: plan.id, name: plan.name, slot };
  });
}

export async function restorePersona(root) {
  return withPersonaRoot(root, async () => {
    const original = await readOptional(at(root, 'persona-trial', 'original.json'));
    if (!original) throw new Error('此目录还没有试验前的人格记录');
    await select(root, original);
  });
}

async function withPersonaRoot(root, run) {
  return withLibraryLock(root, async () => {
    await checkPreviewRoot(root);
    await recover(root);
    return run();
  });
}
