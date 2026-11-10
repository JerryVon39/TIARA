#!/usr/bin/env node
// 从共享台词和番组库生成 SSP YAYA 字典与提醒快照。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ghostScript, ghostSurface, loadGhost, sakuraText } from '../lib/ghost.mjs';
import { writeFileAtomic } from '../lib/atomic.mjs';

const argv = process.argv.slice(2);
const arg = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const root = path.resolve(arg('--root') ?? fileURLToPath(new URL('../', import.meta.url)));
const out = path.join(root, 'ghost', 'master');

// 单引号字符串保留字面百分号，避免番名里的 %hour 被当成 YAYA 变量。
const quoteYaya = text => text.replace(/'/g, "''");
export const yayaText = text => quoteYaya(sakuraText(text));

export function candidate(entry, faces = new Set([0])) {
  return `    '${quoteYaya(ghostScript(entry, faces))}'`;
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
    const tokens = /"(?:[^"]|"")*"|'(?:[^']|'')*'|\/\*.*?\*\/|\/\/.*$/g;
    const line = raw.replace(tokens, token => token.startsWith('/') ? '' : token);
    const code = line.replace(tokens, '');
    const n = i + 1;

    if (/["']/.test(code)) {
      problems.push(`第 ${n} 行引号没闭合：${raw.trim()}`);
    }

    // %(...) 里如果出现裸引号，会提前截断字符串——这是最容易埋的坑
    const interpolated = line.replace(tokens, token => token.startsWith("'") ? '' : token);
    const expand = [...interpolated.matchAll(/%\((.*?)\)/g)].map((m) => m[1]);
    for (const e of expand) {
      if (e.replace(/""/g, '').includes('"')) {
        problems.push(`第 ${n} 行 %(...) 里有裸引号，要写成 "">""：${raw.trim()}`);
      }
    }

    // 顶层函数名（缩进 0 且以 { 结尾）
    if (/^[\p{L}_][\p{L}\w]*\s*(:\s*\w+)?\s*\{\s*$/u.test(code) && depth === 0) {
      const name = line.trim().split(/[\s{]/)[0];
      if (funcs.has(name)) problems.push(`函数 ${name} 重复定义（第 ${n} 行，前一次第 ${funcs.get(name)} 行）`);
      else funcs.set(name, n);
    }

    for (const ch of code) {
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

function reminderEvent(faces) {
  return [
    'OnSecondChange {',
    '    if reference[3] != 1 { return }',
    '    _stamp = GETSECCOUNT',
    '    if _stamp >= tiaraLastPoll && _stamp - tiaraLastPoll < 30 { return }',
    '    tiaraLastPoll = _stamp',
    '    _data = FREADJSON("today.json")',
    '    if GETTYPE(_data) != 5 { return }',
    '    _list = _data["all_shows"]',
    '    if GETTYPEEX("_list") != 4 { return }',
    '    _t = GETTIME(_stamp, "+08:00")',
    '    _now = _t[4] * 60 + _t[5]',
    '    _day = _stamp - _now * 60 - _t[6]',
    '    _snapshot = GETSECCOUNT(_data["date"] + "T00:00:00+08:00")',
    '    if _snapshot < 0 || _day < _snapshot || _day >= _snapshot + 604800 { return }',
    '    _wd = _t[3]',
    '    if _wd == 0 { _wd = 7 }',
    '    if tiaraReminderDay != _day {',
    '        tiaraReminderDay = _day',
    '        tiaraReminderIds = ","',
    '    }',
    '    foreach _list ; _show {',
    '        if !_show["mine"] || _show["reminder_muted"] || _show["weekday"] != _wd { continue }',
    '        if _show["on_date"] && GETSECCOUNT(_show["on_date"] + "T00:00:00+08:00") != _day { continue }',
    '        _delay = _now - _show["min"]',
    '        if _delay < 0 || _delay > 4 { continue }',
    '        _key = "," + _show["id"] + ","',
    '        if _key _in_ tiaraReminderIds { continue }',
    '        tiaraReminderIds += _show["id"] + ","',
    `        '\\0\\s[${ghostSurface('happy', faces)}]' + SHIORI3FW.EscapeAllTags(_show["name_cn"]) + ' 开播了。……一起看？\\e'`,
    '        break',
    '    }',
    '}',
  ].join('\n');
}

async function main() {
  const date = arg('--date');
  const now = date ? new Date(`${date}T12:00:00+08:00`) : new Date();
  const { today, faces, events, aliases } = loadGhost(root, now);
  const sections = Object.entries({ ...events, ...aliases })
    .filter(([, entries]) => entries.length)
    .map(([name, entries]) => [
      `${name} {`,
      ...entries.map(entry => candidate(name === 'OnBoot' || name === 'OnFirstBoot'
        ? { ...entry, prefix: '\\1\\s[-1]' }
        : entry, faces)),
      '}',
    ].join('\n'));
  const text = ['// 番组管家 · tools/build_ghost.mjs 生成', ...sections, reminderEvent(faces)].join('\n\n') + '\n';
  const { problems, funcs } = checkDic(text);
  if (problems.length) throw new Error(problems.join('\n'));
  if (argv.includes('--check')) {
    console.log(`[build_ghost] 静态检查通过 · ${funcs.length} 个事件`);
    return;
  }

  const config = [
    'charset.setting, UTF-8',
    'charset.dic, UTF-8',
    'charset.output, UTF-8',
    'charset.file, UTF-8',
    'charset.save, UTF-8',
    'dicdir, yaya_base',
    'dic, basis.dic',
    '',
  ].join('\n');
  fs.mkdirSync(out, { recursive: true });
  await writeFileAtomic(path.join(out, 'basis.dic'), text, 'utf8');
  await writeFileAtomic(path.join(out, 'yaya.txt'), config, 'utf8');

  const snapshot = path.join(root, 'data', 'today.json');
  if (fs.existsSync(snapshot)) {
    await writeFileAtomic(path.join(out, 'today.json'), fs.readFileSync(snapshot));
  } else {
    console.warn('[build_ghost] data/today.json 不存在，先运行 node tools/build_today.mjs');
  }
  console.log(`[build_ghost] ${today.date} ${today.weekday_cn} · ${today.today.length} 部 · ${funcs.length} 个事件`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('[build_ghost]', error.message);
    process.exitCode = 1;
  });
}
