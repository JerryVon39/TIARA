#!/usr/bin/env node
/**
 * tools/build_yaya.mjs —— 生成「YAYA 版」SSP 人格（带真正的到点提醒）
 *
 *   node tools/build_yaya.mjs            # 生成 ghost-yaya/master/{yaya.txt,basis.dic,today.json}
 *   node tools/build_yaya.mjs --date 2026-11-06
 *   node tools/build_yaya.mjs --check    # 只做静态检查（括号/引号/段落）
 *
 * 为什么还要 YAYA：里々 不读文件，做不出「23:00 到了自己开口」。
 * YAYA 有 FREADJSON + GETTIME，可以真的比对时间——代价是语法完全不同，
 * 所以这里从同一份 data/talks.json 另外生成一套 .dic，两边台词不会各说各话。
 *
 * 结构：
 *   ghost-yaya/master/yaya.txt     YAYA 的配置文件（dic 列表 + 编码）
 *   ghost-yaya/master/basis.dic    事件函数（OnBoot / OnSecondChange / …）
 *   ghost-yaya/master/today.json   今日快照副本（含 all_shows）
 *   shell/master/                  两边共用（打包时一起塞进 zip）
 *
 * 事件函数里 OnSecondChange 每 30 秒才真正干活（YAYA 全局变量会自己存档）：
 *   读 today.json → 取当前星期几和分钟数 → 找出「刚过去 5 分钟内」的番 → 说一句
 *   已提醒过的 (id|日期) 记进 yayaDone，重开 SSP 也不会重复念。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildToday } from '../lib/today.mjs';

const rootIndex = process.argv.indexOf('--root');
const ROOT = rootIndex >= 0 ? path.resolve(process.argv[rootIndex + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'ghost-yaya', 'master');

/** 表情名 → \s[n]（与 shell/master/surfaceN.png 对应；缺的退回 0） */
const FACE = { normal: 0, happy: 1, sad: 2, surprise: 3, sleepy: 4, think: 5 };

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
let dateArg = null;
for (let i = 0; i < argv.length; i++) if (argv[i] === '--date' && argv[i + 1]) dateArg = argv[++i];

function dateFromArg(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 4, 0, 0));
}

/** 哪些 surface 真的存在（缺的表情退回 normal，避免画成空白） */
function haveFaces() {
  const set = new Set([0]);
  for (let i = 1; i <= 5; i++) {
    if (fs.existsSync(path.join(ROOT, 'shell', 'master', `surface${i}.png`))) set.add(i);
  }
  return set;
}

/**
 * 文本 → YAYA 字符串字面量内容。
 * YAYA 里 " 用两个 " 转义；反斜杠原样保留（さくらスクリプト要靠它）。
 */
export function yayaText(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')     // 台词里的反斜杠不是标签，先转义成字面量
    .replace(/\r?\n/g, '\\n')   // 真换行 → さくらスクリプト 的 \n
    .replace(/"/g, '""');
}

/** 一条候选："\0\s[0]……\e" */
export function candidate(entry, faces = new Set([0])) {
  const e = typeof entry === 'string' ? { text: entry, face: 'normal' } : entry;
  let face = FACE[e.face] ?? 0;
  if (!faces.has(face)) face = 0;
  return `    "\\0\\s[${face}]${yayaText(e.text)}\\e"`;
}

/** "23:00" / "25:30" → 当日分钟数；非法给 -1（生成器用，和 lib 的宽松版区分开） */
export function minutesOfHHMM(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ''));
  if (!m) return -1;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (mi > 59) return -1;
  return h * 60 + mi;
}

/** 静态检查：括号配对、每行引号成对、段落不重复 */
export function checkDic(text) {
  const problems = [];
  const lines = text.split('\n');
  let depth = 0;
  const funcs = new Map();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    const n = i + 1;

    // 引号：去掉 "" 转义后应当成对
    const unescaped = line.replace(/""/g, '');
    if ((unescaped.match(/"/g) || []).length % 2 !== 0) {
      problems.push(`第 ${n} 行引号没闭合：${raw.trim()}`);
    }

    // %(...) 里如果出现裸引号，会提前截断字符串——这是最容易埋的坑
    const expand = [...line.matchAll(/%\((.*?)\)/g)].map((m) => m[1]);
    for (const e of expand) {
      if (e.replace(/""/g, '').includes('"')) {
        problems.push(`第 ${n} 行 %(...) 里有裸引号，要写成 "">""：${raw.trim()}`);
      }
    }

    // 顶层函数名（缩进 0 且以 { 结尾）
    if (/^[A-Za-z_＊][\w＊]*\s*(:\s*[\w_]+)?\s*\{\s*$/.test(line) && depth === 0) {
      const name = line.trim().split(/[\s{]/)[0];
      if (funcs.has(name)) problems.push(`函数 ${name} 重复定义（第 ${n} 行，前一次第 ${funcs.get(name)} 行）`);
      else funcs.set(name, n);
    }

    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      if (depth < 0) {
        problems.push(`第 ${n} 行多了一个 }`);
        depth = 0;
      }
    }
  }
  if (depth !== 0) problems.push(`花括号不配平，剩余 ${depth} 层没关`);
  return { problems, funcs: [...funcs.keys()] };
}

function todaySentence(t, nick) {
  if (!t.today.length) return `${t.weekday_cn}没有要追的番。${nick}，要不要补一补积压的？`;
  const parts = t.today.map((s) => `${s.time_cst ?? '--:--'} ${s.name_cn}`);
  return `${t.weekday_cn}共 ${t.today.length} 部：${parts.join('、')}。`;
}

function main() {
  const talks = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'talks.json'), 'utf8'));
  const lib = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'library.json'), 'utf8'));
  const now = dateArg ? dateFromArg(dateArg) : new Date();
  const t = buildToday(lib, now);
  const faces = haveFaces();
  const nick = lib.user?.nickname_for_pet || '主人';

  const L = [];
  const fn = [];
  /** 开始一个函数：fn('OnBoot') → 往 dic 里写 "OnBoot {" */
  const open = (name, opt = '') => {
    fn.push('');
    fn.push(`${name}${opt ? ' : ' + opt : ''} {`);
  };
  const close = () => fn.push('}');

  L.push('// 番组管家 · TIARA —— YAYA 版字典（basis.dic）');
  L.push('// 由 tools/build_yaya.mjs 从 data/talks.json 生成，别手改。');
  L.push('// 和里々版共用同一套台词；差别只在于 YAYA 能读文件、能比时间。');
  L.push('');

  // ---------- OnFirstBoot / OnBoot ----------
  open('OnFirstBoot');
  for (const e of talks.firstBoot ?? []) fn.push(candidate(e, faces));
  close();

  open('OnBoot');
  const bootPool = talks.boot?.length ? talks.boot : [{ text: '番组管家，TIARA。', face: 'normal' }];
  for (const b of bootPool) {
    fn.push(candidate({ text: `${b.text}\\n${todaySentence(t, nick)}`, face: b.face ?? 'normal' }, faces));
  }
  close();

  // ---------- 自我介绍 / 摸头 / 滚轮 / 双击 / 关闭 ----------
  // 里々 里那个「＊自己紹介」是中文函数名，YAYA 的函数名保持 ASCII，不放进来
  const simple = [
    ['OnNadeNade', talks.nade],
    ['OnMouseWheel', talks.wheel],
    ['OnMouseDoubleClick', talks.doubleclick],
    ['OnClose', (talks.close ?? []).slice(0, 1)],
  ];
  for (const [name, pool] of simple) {
    if (!pool?.length) continue;
    open(name);
    for (const e of pool) fn.push(candidate(e, faces));
    close();
  }

  // ---------- 今日播报（手动也能测） ----------
  open('今日');
  fn.push(candidate({ text: todaySentence(t, nick), face: t.today.length ? 'normal' : 'sleepy' }, faces));
  close();

  // ---------- 真正的到点提醒 ----------
  fn.push('');
  fn.push('// 每 30 秒查一次：today.json 里有没有「刚刚开播」的番。');
  fn.push('// yayaTick / yayaData / yayaAge / yayaDone 是全局变量，YAYA 退出时自己存档。');
  open('OnSecondChange');
  fn.push('    yayaTick = yayaTick + 1');
  fn.push('    if yayaTick < 30 { return }');
  fn.push('    yayaTick = 0');
  fn.push('    yayaAge = yayaAge + 30');
  fn.push('    if GETTYPE(yayaData) == 0 || yayaAge > 600 {');
  fn.push('        yayaData = FREADJSON("today.json")');
  fn.push('        yayaAge = 0');
  fn.push('    }');
  fn.push('    if GETTYPE(yayaData) != 5 { return }');
  fn.push('    _list = yayaData["all_shows"]');
  fn.push('    if GETTYPE(_list) != 4 { return }');
  fn.push('    _t = GETTIME()');
  fn.push('    _wd = _t[3]');
  fn.push('    if _wd == 0 { _wd = 7 }          // GETTIME 是 0=周日，我们的表是 1=周一');
  fn.push('    _now = _t[4] * 60 + _t[5]');
  fn.push('    if GETTYPE(yayaDone) == 0 { yayaDone = "" }   // 首次运行时它还不存在');
  fn.push('    foreach _list ; _s {');
  fn.push('        if !_s["mine"] || _s["reminder_muted"] { continue }');
  fn.push('        if _s["weekday"] != _wd { continue }');
  fn.push('        _d = _now - _s["min"]');
  fn.push('        if _d < 0 || _d > 4 { continue }   // 只认刚过去的 5 分钟');
  fn.push('        _key = "" + _s["id"] + "@" + yayaData["date"]');
  fn.push('        if _key _in_ yayaDone { continue }');
  fn.push('        yayaDone ,= _key');
  // 注意：%() 里取哈希成员，引号必须写成 ""，否则字符串会被提前截断
  fn.push('        "\\0\\s[1]%(_s[""name_cn""]) 开播了。别装没看见。\\e"');
  fn.push('    }');
  close();

  const text = L.concat(fn).join('\r\n') + '\r\n';
  const { problems, funcs } = checkDic(text);

  if (has('--check')) {
    console.log(`[build_yaya] 段落 ${funcs.length}：${funcs.join(' / ')}`);
    if (problems.length) {
      console.error('[build_yaya] 静态检查没通过：');
      for (const p of problems) console.error('  - ' + p);
      process.exit(1);
    }
    console.log('[build_yaya] 静态检查通过');
    return;
  }

  if (problems.length) {
    console.error('[build_yaya] 生成结果没通过静态检查，先别往 SSP 里丢：');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'basis.dic'), text, 'utf8');
  fs.writeFileSync(
    path.join(OUT, 'yaya.txt'),
    [
      '// YAYA 配置：只加载本目录的 basis.dic，编码 UTF-8',
      'dic, basis.dic',
      'charset, UTF-8',
      '',
    ].join('\r\n'),
    'utf8'
  );

  // today.json 副本：YAYA 的 FREADJSON 按 yaya.dll 所在目录解析相对路径
  const snapPath = path.join(ROOT, 'data', 'today.json');
  if (fs.existsSync(snapPath)) fs.copyFileSync(snapPath, path.join(OUT, 'today.json'));
  else console.warn('[build_yaya] data/today.json 不存在，先跑 node tools/build_today.mjs');

  console.log(`[build_yaya] ${t.date} ${t.weekday_cn} · ${t.today.length} 部 · 函数 ${funcs.length} 段`);
  console.log(`  ghost-yaya/master/basis.dic   ${(Buffer.byteLength(text) / 1024).toFixed(1)}KB`);
  console.log('  提醒：OnSecondChange 每 30 秒比对一次 today.json 的 all_shows');
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (e) {
    console.error('FATAL', e.message);
    process.exit(1);
  }
}
