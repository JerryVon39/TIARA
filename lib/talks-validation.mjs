import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { isPng } from './cover.mjs';

const FACES = new Map(['normal', 'happy', 'sad', 'surprise', 'sleepy', 'think'].map((name, index) => [name, index]));
const BASE_VARIABLES = new Set('nickname weekday count summary quote nade_today nade_total affinity poke_total hour imagination fluster nosebleed_total mood hug_total behind_count'.split(' '));
const BOOT = ['date', 'weekday_cn'];
const POOL_VARIABLES = {
  boot: BOOT, firstBoot: BOOT, selfIntro: BOOT, todayEmpty: BOOT,
  todayHas: [...BOOT, 'names'], todayBehind: [...BOOT, 'behind', 'behind_name'],
  todayNext: [...BOOT, 'name_cn', 'time_cst'], remind: ['name_cn', 'time_cst', 'eps'],
  menuOpen: ['pending'], bump: ['name_cn', 'seen', 'total'], bumpRapid: ['bump_recent'],
  catchup: [...BOOT, 'behind', 'pending'], catchupFull: ['name_cn'],
  anniversary: ['days', 'mark'],
};
const WHEN_LIMIT = { hour_min: 23, hour_max: 23, behind_min: 2147483647, count_min: 2147483647,
  nade_min: 2147483647, affinity_min: 100, imagination_min: 100, fluster_min: 100 };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function checkWhen(when, at, issue) {
  if (when == null) return;
  if (!record(when)) { issue(at, '规则条件必须是对象'); return; }
  for (const [key, value] of Object.entries(when)) {
    const field = at + '.' + key;
    if (key === 'weekday') {
      if (!Array.isArray(value) || !value.length || value.some(day => !Number.isInteger(day) || day < 1 || day > 7))
        issue(field, '填写至少一天，周一至周日为 1–7');
    } else if (key === 'mood') {
      if (!['calm', 'dreamy', 'flustered'].includes(value)) issue(field, '未知的心情');
    } else if (Object.hasOwn(WHEN_LIMIT, key)) {
      if (!Number.isInteger(value) || value < 0 || value > WHEN_LIMIT[key]) issue(field, '超出数字范围');
    } else issue(field, '程序不会读取这个条件');
  }
  if ((['calm', 'dreamy'].includes(when.mood) && when.fluster_min >= 40) ||
      (when.mood === 'calm' && when.imagination_min >= 60)) issue(at, '心情和数值要求无法同时满足');
}

export function validateTalks(talks) {
  const issues = [];
  const faces = new Set(['normal']);
  const issue = (at, message) => issues.push({ at, message });
  if (!record(talks)) return { issues: [{ at: 'talks', message: '台词文件必须是 JSON 对象' }], faces };

  function inspect(entry, pool, at) {
    const text = typeof entry === 'string' ? entry : entry?.text;
    if (typeof text !== 'string' || !text.trim()) issue(at, '台词文字不能为空');
    else {
      const vars = new Set(Array.from(text.matchAll(/\{([^{}]*)\}/g), match => match[1]));
      for (const key of vars)
        if (!BASE_VARIABLES.has(key) && !POOL_VARIABLES[pool]?.includes(key)) issue(at, '这个台词池没有变量 {' + key + '}');
      if (/[{}]/.test(text.replace(/\{[^{}]*\}/g, ''))) issue(at, '变量的花括号未闭合');
    }
    if (entry?.face !== undefined) {
      if (!FACES.has(entry.face)) issue(at + '.face', '未知的表情');
      else faces.add(entry.face);
    }
  }

  for (const [pool, entries] of Object.entries(talks)) {
    if (pool === 'version' || pool === 'note') continue;
    if (pool === 'menu') {
      if (!record(entries)) issue(pool, '菜单定义必须是 JSON 对象');
      else for (const [key, label] of Object.entries(entries))
        if (typeof label !== 'string' || !label.trim()) issue(pool + '.' + key, '菜单文字不能为空');
      continue;
    }
    if (!Array.isArray(entries)) { issue(pool, '台词池必须是数组'); continue; }
    entries.forEach((entry, index) => {
      const at = pool + '[' + index + ']';
      inspect(entry, pool, at);
      if (pool === 'rules') {
        if (!record(entry)) issue(at, '条件台词必须是对象');
        else checkWhen(entry.when, at + '.when', issue);
      }
    });
  }
  return { issues, faces };
}

export function validateTalkResources(shell, faces) {
  const issues = [];
  const checked = new Set();
  function issue(at, message) { issues.push({ at, message }); }
  function validFile(file, at) {
    if (typeof file !== 'string' || !/^[^/\\:\x00-\x1f]+\.png$/i.test(file) || file.startsWith('.')) {
      issue(at, '图片须为该立绘目录内的 PNG 文件名');
      return;
    }
    if (checked.has(file)) return;
    checked.add(file);
    try {
      const p = path.join(shell, file);
      if (!statSync(p).isFile() || !isPng(readFileSync(p))) issue(at, file + ' 不是有效的 PNG');
    } catch {
      issue(at, '找不到图片 ' + file);
    }
  }
  function read(name) {
    try { return JSON.parse(readFileSync(path.join(shell, name), 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) {
      if (error.code !== 'ENOENT') issue(name, 'JSON 无法读取');
      return null;
    }
  }
  validFile('surface0.png', 'surface0.png');
  const layered = read('faces.json');
  if (layered) {
    if (!record(layered.faces)) issue('faces.json.faces', '表情图层必须是对象');
    else for (const [face, value] of Object.entries(layered.faces)) {
      validFile(value?.base, 'faces.json.faces.' + face + '.base');
      if (value?.overlay != null && !Array.isArray(value.overlay)) issue('faces.json.faces.' + face + '.overlay', '叠层必须是数组');
      else value?.overlay?.forEach((overlay, i) => validFile(overlay?.src, 'faces.json.faces.' + face + '.overlay[' + i + ']'));
    }
    if (layered.mouth) validFile(layered.mouth.src, 'faces.json.mouth.src');
  }
  const sprites = read('surfaces.json');
  if (sprites?.slots) {
    if (!Array.isArray(sprites.slots)) issue('surfaces.json.slots', '整图映射必须是数组');
    else sprites.slots.forEach((slot, index) => validFile(slot?.file, 'surfaces.json.slots[' + index + ']'));
  }
  for (const face of faces) {
    if (layered?.faces?.[face]?.base || face === 'normal' || face === 'sleepy' || face === 'think') continue;
    validFile('surface' + FACES.get(face) + '.png', '表情 ' + face);
  }
  return issues;
}
