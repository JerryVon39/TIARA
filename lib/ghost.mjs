import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { addressOf } from './persona.mjs';
import { buildToday, minutesOfDay, summarize, timeline } from './today.mjs';
import { remainingEpisodes } from './watch-start.mjs';

const FACE = { normal: 0, happy: 1, sad: 2, surprise: 3, sleepy: 4, think: 5, bashful: 6 };

export function ghostFaces(root) {
  return new Set(Object.values(FACE).filter(id => existsSync(path.join(root, 'shell', 'master', `surface${id}.png`))));
}

export function ghostSurface(face, available) {
  const id = FACE[face] ?? 0;
  if (available.has(id)) return id;
  if (face === 'sleepy' && available.has(2)) return 2;
  if (face === 'bashful' && available.has(1)) return 1;
  return 0;
}

export function sakuraText(text) {
  return String(text ?? '').replace(/[\\%]/g, token => '\\' + token).replace(/\r\n?|\n/g, '\\n');
}

export function ghostScript(entry, faces) {
  const { text, face, suffix = '', prefix = '', end = '\\e' } = typeof entry === 'string' ? { text: entry } : entry;
  return `${prefix}\\0\\s[${ghostSurface(face, faces)}]${sakuraText(text)}${suffix}${end}`;
}

export function loadGhost(root, now) {
  const read = name => JSON.parse(readFileSync(path.join(root, 'data', name), 'utf8').replace(/^\uFEFF/, ''));
  const lib = read('library.json');
  let settings;
  try { settings = read('settings.json'); } catch { settings = {}; }
  return { ...ghostDialogue(read('talks.json'), lib, now, settings), faces: ghostFaces(root) };
}

export function ghostDialogue(talks, lib, now, settings) {
  const today = buildToday(lib, now, settings);
  const nick = addressOf(lib);
  const pending = today.behindAll.length + today.catchup.length;
  const variables = {
    nickname: nick, count: today.today.length, pending,
    behind_count: today.behindAll.length, catchup_count: today.catchup.length,
    weekday_cn: today.weekday_cn, summary: summarize(today, lib), quote: lib.trivia?.quote_of_today ?? '',
  };
  const pool = (key, extra = {}) => (talks[key] ?? []).flatMap(entry => {
    const { text, face } = typeof entry === 'string' ? { text: entry } : entry;
    const context = { ...variables, ...extra };
    if ([...text.matchAll(/\{(\w+)\}/g)].some(([, name]) => !Object.hasOwn(context, name))) return [];
    return [{ text: text.replace(/\{(\w+)\}/g, (_, name) => String(context[name])), face }];
  });

  const todayText = today.today.length
    ? `${today.date} ${today.weekday_cn} · ${today.today.length} 部\n${today.today.map(row =>
      `${row.time_disp || '时间未定'} ${row.name_cn || row.name}${row.aired ? ' · 已播' : ''}`).join('\n')}`
    : `${today.date} ${today.weekday_cn} · 今天没有在追的排片。`;
  const next = timeline(today.today.filter(row => minutesOfDay(row.time_cst) < 1440), now).next;
  const backlog = [
    ...today.behindAll.map(row => `${row.name_cn} · 差 ${row.behind} 话`),
    ...today.catchup.map(row => `${row.name_cn || row.name} · 完结待补 ${remainingEpisodes(row, row.eps)} 话`),
  ];
  const backlogText = backlog.length
    ? `待补 ${backlog.length} 部。\n${backlog.slice(0, 6).join('\n')}${backlog.length > 6 ? `\n另有 ${backlog.length - 6} 部。` : ''}`
    : '记录簿上没有积压。……今天可以休息了。';
  const menu = [
    ['今日排片', 'OnTiaraToday'], ['今天下一部', 'OnTiaraNext'],
    ['补番清单', 'OnTiaraBacklog'], ['聊一句', 'OnTiaraChat'], ['摸摸头', 'OnNadeNade'],
    ['关于副会长', 'OnTiaraIntro'],
  ].map(([label, event]) => `\\q[${label},${event}]`).join('\\n');
  const choices = `\\n\\n${menu}`;
  const back = '\\n\\n\\q[返回案件簿,OnMouseDoubleClick]';
  const boot = pool('boot');
  const first = pool('firstBoot');
  const openMenu = pool('menuOpen');
  const random = [...pool('random'), ...pool('click'), ...pool('headpat')];
  const shy = [...pool('soft'), ...pool('doubleclick')].map(entry => ({ ...entry, face: 'bashful' }));
  const nextLines = next ? pool('todayNext', { name_cn: next.name_cn || next.name, time_cst: next.time_disp }) : [];
  const events = {
    OnFirstBoot: [{ text: first.map(entry => entry.text).join('\n') || '学生会副会长，馬剃天愛星。请多指教。', face: first[0]?.face, suffix: choices }],
    OnBoot: (boot.length ? boot : [{ text: '番组管家，TIARA。' }])
      .map(entry => ({ ...entry, text: `${entry.text}\n${todayText}` })),
    OnMouseDoubleClick: (openMenu.length ? openMenu : [{ text: '案件簿。请翻阅。' }])
      .map(entry => ({ ...entry, suffix: choices })),
    OnTiaraToday: [{ text: todayText, face: today.today.length ? 'normal' : 'sleepy' }],
    OnTiaraNext: nextLines.length ? nextLines : [next
      ? { text: `接下来是 ${next.name_cn || next.name}，${next.time_disp}。`, face: 'think' }
      : { text: '今天没有下一部已定时的番。……要不要看看补番清单？', face: 'sleepy' }],
    OnTiaraBacklog: [{ text: backlogText, face: backlog.length ? 'think' : 'happy' }],
    OnTiaraChat: [...shy, ...random],
    OnTiaraIntro: pool('selfIntro'),
    OnNadeNade: pool('nade').map(entry => entry.face === 'happy' ? { ...entry, face: 'bashful' } : entry),
    OnMouseWheel: pool('wheel'),
    OnClose: pool('close').slice(0, 1).map(entry => ({ ...entry, end: '\\-' })),
    OnAiTalk: random,
  };
  const aliases = {
    '自己紹介': events.OnTiaraIntro, '朝': pool('morning'), '昼': pool('noon'), '夜': pool('evening'),
    '今日': events.OnTiaraToday, '積み': events.OnTiaraBacklog, 'つづき': events.OnTiaraNext,
  };
  for (const name of ['OnTiaraToday', 'OnTiaraNext', 'OnTiaraBacklog', 'OnTiaraChat', 'OnTiaraIntro']) {
    events[name] = events[name].map(entry => ({ ...entry, suffix: back }));
  }
  return { today, events, aliases };
}
