// YAYA 字典生成器 + 整周排片表的单元测试（node --test）
import test from 'node:test';
import assert from 'node:assert/strict';

import { yayaText, candidate, minutesOfHHMM, checkDic } from '../tools/build_ghost.mjs';
import { allShows } from '../lib/today.mjs';
import { validateTalks, validateTalkResources } from '../lib/talks-validation.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { inspectSspShell, renderSspPreview } from '../lib/ssp-shell-preview.mjs';
import { inspectPersona, restorePersona, switchPersona } from '../lib/persona-trial.mjs';
import { ghostDialogue, ghostScript } from '../lib/ghost.mjs';

test('yayaText 转义引号、反斜杠与换行', () => {
  assert.equal(yayaText("It's 100%"), "It''s 100\\%");
  assert.equal(yayaText('a\\e'), 'a\\\\e');
  assert.equal(yayaText('一\n二'), '一\\n二');
  assert.equal(yayaText('tab\there'), 'tab\there');
});

test('candidate 使用实际存在的立绘，并按表情回退', () => {
  const set = new Set([0, 1, 2, 6]);
  assert.equal(candidate({ text: '早', face: 'normal' }, set), "    '\\0\\s[0]早\\e'");
  assert.equal(candidate({ text: '嗯', face: 'bashful' }, set), "    '\\0\\s[6]嗯\\e'");
  assert.equal(candidate({ text: '唔', face: 'sleepy' }, set), "    '\\0\\s[2]唔\\e'");
  assert.equal(candidate({ text: '嗯', face: 'think' }, set), "    '\\0\\s[0]嗯\\e'");
});

test('minutesOfHHMM 容忍跨日写法，非法输入给 -1', () => {
  assert.equal(minutesOfHHMM('23:00'), 1380);
  assert.equal(minutesOfHHMM('01:05'), 65);
  assert.equal(minutesOfHHMM('25:30'), 1530);
  assert.equal(minutesOfHHMM(''), -1);
  assert.equal(minutesOfHHMM('乱写'), -1);
});

test('checkDic 通过正常字典', () => {
  const ok = [
    'OnBoot {',
    '    "\\0\\s[0]早\\e"',
    '    "\\0\\s[1]他说""好""\\e"',
    '}',
    '',
    'OnSecondChange {',
    '    if GETTYPE(x) == 0 { return }',
    '    "\\0\\s[1]%(_s[""name_cn""]) 开播了。\\e"',
    '}',
  ].join('\r\n');
  assert.deepEqual(checkDic(ok).problems, []);
  assert.deepEqual(checkDic(ok).funcs, ['OnBoot', 'OnSecondChange']);
});

test('checkDic 抓出未闭合引号', () => {
  const bad = 'OnBoot {\r\n    "\\0\\s[0]没闭合\\e\r\n}\r\n';
  assert.equal(checkDic(bad).problems.length > 0, true);
});

test('checkDic 抓出 %() 里的裸引号', () => {
  const bad = 'OnBoot {\r\n    "\\0\\s[0]%(_s["name_cn"]) 开播了\\e"\r\n}\r\n';
  const p = checkDic(bad).problems.join('\n');
  assert.match(p, /裸引号/);
});

test('checkDic 保留台词中的网址和花括号', () => {
  const text = "OnTiaraToday {\n    '\\0标题 {前传 https://example.com/a %(\"试听\")\\e'\n}";
  assert.deepEqual(checkDic(text).problems, []);
});

test('Ghost 案件簿引用可用事件，并使用最新称呼、排期和补番起点', () => {
  const lib = {
    user: { nickname_for_pet: '测试会长' },
    watching: [
      { id: 1, name_cn: '夜间番', air_weekday: 1, air_time_cst: '25:30' },
      { id: 2, name_cn: '完结番', eps: 12, ep_status: 8, start_episode: 10, watch_mode: 'catchup' },
      { id: 3, name_cn: '尚无周档', eps: 12, ep_status: 0 },
    ],
    weekday: { 1: [{ id: 1, time_cst: '25:30' }] },
  };
  const talks = {
    boot: [{ text: '欢迎，{nickname}' }],
    todayNext: [{ text: '{name_cn}，{time_cst}', face: 'think' }],
    selfIntro: [{ text: '副会长' }],
    soft: [{ text: '……' }],
    nade: [{ text: '第 {nade_today} 次' }, { text: '……随你', face: 'happy' }],
  };
  const { events } = ghostDialogue(talks, lib, new Date('2026-11-09T16:00:00Z'), { clock: '24h' });
  const faces = new Set([0, 4, 5, 6]);
  const menu = ghostScript(events.OnMouseDoubleClick[0], faces);
  for (const [, event] of menu.matchAll(/\\q\[[^,]+,(On\w+)\]/g)) {
    assert.ok(events[event]?.length, event);
    for (const option of events[event]) {
      assert.match(ghostScript(option, faces), /\\q\[返回案件簿,OnMouseDoubleClick\]/, event);
    }
  }
  assert.match(menu, /\\q\[摸摸头,OnTiaraNade\]/);
  assert.match(ghostScript(events.OnBoot[0], faces), /欢迎，测试会长\\n.*01:30 夜间番/);
  assert.match(ghostScript(events.OnTiaraNext[0], faces), /\\s\[5\]夜间番，01:30/);
  const backlog = ghostScript(events.OnTiaraBacklog[0], faces);
  assert.match(backlog, /完结番 · 待补 3 话/);
  assert.equal(backlog.match(/完结番/g).length, 1);
  assert.doesNotMatch(backlog, /尚无周档/);
  assert.deepEqual(events.OnNadeNade, [{ text: '……随你', face: 'bashful' }]);
});

test('allShows 合并在追列表与整周排片表，按周几+时间排序去重', () => {
  const lib = {
    watching: [{ id: 1, name_cn: '在追的', air_weekday: 3, air_time_cst: '22:00' }],
    weekday: {
      1: [{ id: 2, name_cn: '周一的', time_cst: '23:00', ep_expected: 5 }],
      3: [{ id: 1, name_cn: '在追的', time_cst: '22:00' }],
    },
  };
  const list = allShows(lib);
  assert.deepEqual(list.map((s) => s.id), [2, 1]);
  assert.equal(list[0].min, 1380);
  assert.equal(list[0].ep_expected, 5);
  assert.equal(list[1].ep_expected, null);
  assert.equal(list.length, 2, '同一部番在两张表里只保留一条');
});

test('allShows 容忍空数据', () => {
  assert.deepEqual(allShows({}), []);
  assert.deepEqual(allShows({ watching: [{ id: 9, air_weekday: null }] }), []);
});

test('台词验错覆盖上下文变量、条件分支与本地图片资源', () => {
  const { issues, faces } = validateTalks({
    random: [{ text: '计数 {seen}', face: 'happy' }, { text: '{nickname' }, { text: '未知表情', face: 'unknown' }],
    bump: ['{name_cn} 到 {seen}/{total}'],
    rules: [
      { text: '夜间', when: { hour_min: 22, hour_max: 2, weekday: [1, 2] } },
      { text: '非法', when: { weekday: [], hour_mix: 7, mood: 'calm', fluster_min: 40 } },
    ],
  });
  assert.equal(issues.length, 6);
  assert.deepEqual(Array.from(faces), ['normal', 'happy']);
  assert.ok(issues.some(issue => issue.at === 'random[0]' && issue.message.includes('{seen}')));
  assert.ok(issues.some(issue => issue.at === 'rules[1].when' && issue.message.includes('无法同时')));
  assert.ok(!issues.some(issue => issue.at.startsWith('bump') || issue.at.startsWith('rules[0]')));
  const folder = mkdtempSync(path.join(os.tmpdir(), 'tiara-talk-test-'));
  writeFileSync(path.join(folder, 'surface0.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=', 'base64'));
  writeFileSync(path.join(folder, 'faces.json'), JSON.stringify({
    faces: { happy: { base: 'surface0.png', overlay: [{ src: 'missing.png' }] } },
  }));
  assert.deepEqual(validateTalkResources(folder, faces), [
    { at: 'faces.json.faces.happy.overlay[0]', message: '找不到图片 missing.png' },
  ]);
});

const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=', 'base64');

test('SSP 转换试验读取 Shift_JIS、图层位置和碰撞区', async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'tiara-ssp-preview-'));
  await fs.writeFile(path.join(folder, 'surface0.png'), tinyPng);
  await fs.writeFile(path.join(folder, 'overlay.png'), tinyPng);
  await fs.writeFile(path.join(folder, 'surfaces.txt'), Buffer.concat([
    Buffer.from('surface0\r\n{\r\nelement1,overlay,overlay.png,1,-2\r\ncollision0,0,0,1,1,'),
    Buffer.from([0x82, 0xa0]), Buffer.from('\r\nanimation0.interval,sometimes\r\n}\r\n'),
  ]));
  const shape = await inspectSspShell(folder);
  assert.equal(shape.encoding, 'Shift_JIS');
  assert.deepEqual(shape.canvas, { left: 0, top: -2, width: 2, height: 3 });
  assert.equal(shape.collisions[0].name, 'あ');
  assert.equal(shape.layers[0].file, 'surface0.png');
  assert.ok(shape.warnings.length);
  assert.match(renderSspPreview(shape), /aspect-ratio:2\/3.*class="hit"/);
  await fs.unlink(path.join(folder, 'overlay.png'));
  await assert.rejects(inspectSspShell(folder), /找不到本地图片 overlay/);
});

test('人格素材静态预览有缺件反馈，切换与恢复只更新外观和台词', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tiara-persona-trial-'));
  const folder = path.join(root, 'pack');
  for (const dir of ['pet', 'data', 'shell', 'pack/shell']) await fs.mkdir(path.join(root, dir), { recursive: true });
  await fs.writeFile(path.join(root, 'pet/Pet.exe'), '');
  const details = { desktop_shell: 'master', bubble_theme: 1, vars: { affinity: 42 } };
  const prior = '{"random":["原有台词"]}';
  await fs.writeFile(path.join(root, 'data/state.json'), JSON.stringify(details));
  await fs.writeFile(path.join(root, 'data/talks.json'), prior);
  await fs.writeFile(path.join(folder, 'persona.json'), JSON.stringify({
    format: 'tiara-persona', schema: 1, id: 'fixture', name: '试验素材', theme: { bubble: 'blue', size: 'large' },
  }));
  await fs.writeFile(path.join(folder, 'talks.json'), '{"random":["样例：{nickname}"]}');
  assert.ok((await inspectPersona(folder)).problems.length);
  await assert.rejects(switchPersona(root, folder), /surface0/);
  await fs.writeFile(path.join(folder, 'shell/surface0.png'), tinyPng);
  const applied = await switchPersona(root, folder);
  const state = JSON.parse(await fs.readFile(path.join(root, 'data/state.json')));
  assert.equal(state.desktop_shell, applied.slot);
  assert.equal(state.bubble_theme, 2);
  assert.equal(state.bubble_size, 2);
  state.vars.affinity = 56;
  await fs.writeFile(path.join(root, 'data/state.json'), JSON.stringify(state));
  await restorePersona(root);
  assert.equal(await fs.readFile(path.join(root, 'data/talks.json'), 'utf8'), prior);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'data/state.json'))), { ...details, vars: { affinity: 56 } });
});
