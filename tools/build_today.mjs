#!/usr/bin/env node
/**
 * tools/build_today.mjs — 把 library.json 算成「今天该说的话」，落成纯文本变量表
 *
 *   node tools/build_today.mjs                 # 算今天
 *   node tools/build_today.mjs --date 2026-11-07
 *
 * 产出：
 *   ghost/master/today.txt   key=value 变量表（Pet.exe / YAYA / 自写 DLL 读这个）
 *   data/today.json          结构化快照（面板 / 调试 / 外部脚本用）
 *
 * 为什么要中间落一层文本：Pet.exe 是 .NET Framework 4 的 WPF 程序，
 * 让它自己解析 JSON + 日期，比读一张 key=value 表更容易出 bug。
 * 这里算好，那边无脑读。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildToday, timeline, summarize, cstParts, reminders, timeOfDay, actualSchedule } from '../lib/today.mjs';
import { writeFileAtomic, writeJsonAtomic } from '../lib/atomic.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
let dateArg = null;
let rootArg = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--date' && argv[i + 1]) dateArg = argv[++i];
  else if (argv[i] === '--root' && argv[i + 1]) rootArg = argv[++i];
}
const ROOT = rootArg ? path.resolve(rootArg) : DEFAULT_ROOT;

function dateFromArg(s) {
  // 2026-11-07 → 当天 12:00 CST（避免跨日边界把星期算错）
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 4, 0, 0)); // UTC 04:00 = CST 12:00
}

const pad = (n) => String(n).padStart(2, '0');

/** 用户偏好（data/settings.json，缺省就用代码里的默认值） */
async function readSettings() {
  const { DEFAULT_SETTINGS } = await import('../lib/today.mjs');
  try {
    const s = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'settings.json'), 'utf8'));
    return {
      clock: s.clock === '24h' || s.clock === '30h' ? s.clock : DEFAULT_SETTINGS.clock,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function main() {
  const lib = actualSchedule(JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'library.json'), 'utf8')));
  const settings = await readSettings();

  const now = dateArg ? dateFromArg(dateArg) : new Date();
  const t = buildToday(lib, now, { clock: settings.clock });
  const tl = timeline(t.today, now);
  const nick = lib.user?.nickname_for_pet || '会長';
  const { date: dateStr, hour, minute } = cstParts(now);

  /** "23:00"(+ "25:30") → 相对今日 00:00 CST 的 unix 秒；解析不了给空串 */
  const tsOf = (hhmm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    if (!m) return '';
    let h = Number(m[1]);
    let extraDays = 0;
    while (h >= 24) { h -= 24; extraDays += 1; }
    const ms = Date.parse(`${t.date}T${pad(h)}:${m[2]}:00+08:00`);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) + extraDays * 86400 : '';
  };

  // ---------- 1. 变量表 ----------
  const L = [];
  const put = (k, v) => L.push(`${k}=${v ?? ''}`);

  L.push('# 番组管家 · 今日数据（由 tools/build_today.mjs 生成，勿手改）');
  put('generated_at', now.toISOString());
  put('date', t.date);
  put('weekday', t.weekday);
  put('weekday_cn', t.weekday_cn);
  put('now_hhmm', `${pad(hour)}:${pad(minute)}`);
  put('time_of_day', timeOfDay(now));
  put('user', lib.user?.name ?? '');
  put('nickname', nick);
  put('clock', settings.clock);
  put('count', t.today.length);
  put('side_count', (t.side || []).length);
  put('has_today', t.today.length > 0 ? 1 : 0);
  put('behind_count', t.behindAll.length);
  put('catchup_count', t.catchup.length);
  put('summary', summarize(t, lib));
  put('quote', lib.trivia?.quote_of_today ?? '');
  put('next_name', tl.next?.name_cn ?? '');
  put('next_time', tl.next?.time_disp ?? tl.next?.time_cst ?? '');
  put('last_name', tl.last?.name_cn ?? '');
  put('last_time', tl.last?.time_disp ?? tl.last?.time_cst ?? '');

  t.today.forEach((s, i) => {
    const n = i + 1;
    put(`show${n}_id`, s.id);
    put(`show${n}_name`, s.name_cn || s.name);
    put(`show${n}_time`, s.time_cst ?? '');
    put(`show${n}_time_disp`, s.time_disp ?? s.time_cst ?? '');
    put(`show${n}_wd_disp`, s.weekday_disp ?? t.weekday);
    put(`show${n}_unix`, tsOf(s.time_cst));
    put(`show${n}_aired`, s.aired ? 1 : 0);
    put(`show${n}_eps`, s.watched_eps != null ? `${s.watched_eps}/${s.total_eps}` : '');
    put(`show${n}_behind`, s.behind);
    put(`show${n}_priority`, s.priority);
  });
  // 给 Pet.exe 的「该提醒了」预计算结果（它自己也会按 30s 扫一遍兜底）
  const rem = reminders(t.today, now, 60);
  put('remind_count', rem.length);
  rem.slice(0, 5).forEach((s, i) => {
    put(`remind${i + 1}_id`, s.id);
    put(`remind${i + 1}_name`, s.name_cn || s.name);
    put(`remind${i + 1}_time`, s.time_cst ?? '');
    put(`remind${i + 1}_left`, s.minutes_left);
  });

  t.behindAll.forEach((s, i) => {
    put(`behind${i + 1}_id`, s.id);
    put(`behind${i + 1}_name`, s.name_cn);
    put(`behind${i + 1}_eps`, s.behind);
    put(`behind${i + 1}_expected`, s.expected_eps);
    put(`behind${i + 1}_watched`, s.watched_eps);
  });
  t.catchup.forEach((s, i) => {
    put(`catchup${i + 1}_id`, s.id);
    put(`catchup${i + 1}_name`, s.name_cn || s.name);
    put(`catchup${i + 1}_eps`, s.eps - s.ep_status);
  });

  // 整周排片（今天的之外，桌宠「接下来」用；面板另有实时视图）
  const week = lib.weekday ?? {};
  const { displayClock } = await import('../lib/today.mjs');
  const mineIds = new Set((lib.watching || []).map((w) => String(w.id)));
  for (let d = 1; d <= 7; d++) {
    const list = (week[String(d)] ?? [])
      .slice()
      .sort((a, b) => String(a.time_cst ?? '').localeCompare(String(b.time_cst ?? '')));
    put(`w${d}_count`, list.length);
    list.forEach((s, i) => {
      const dc = displayClock(s.time_cst, d, settings.clock);
      put(`w${d}_${i + 1}_id`, s.id);
      put(`w${d}_${i + 1}_name`, s.name_cn);
      put(`w${d}_${i + 1}_time`, s.time_cst ?? '');
      put(`w${d}_${i + 1}_time_disp`, dc.time_disp);
      put(`w${d}_${i + 1}_wd_disp`, dc.weekday_disp ?? d);
      put(`w${d}_${i + 1}_mine`, mineIds.has(String(s.id)) ? 1 : 0);
    });
  }

  // 原子写：Pet.exe 每分钟轮询 today.txt 的 mtime，直接覆写会让它读到半截文件
  //（表现为「今天突然没番」或者某一行为空），先写 .tmp 再 rename 才是原子的。
  await writeFileAtomic(path.join(ROOT, 'ghost', 'master', 'today.txt'), L.join('\r\n') + '\r\n', 'utf8');

  // ---------- 2. 结构化快照 ----------
  const snapshot = {
    generated: now.toISOString(),
    date: t.date,
    weekday: t.weekday,
    weekday_cn: t.weekday_cn,
    now_hhmm: `${pad(hour)}:${pad(minute)}`,
    clock: settings.clock,
    settings,
    time_of_day: timeOfDay(now),
    nickname: nick,
    summary: summarize(t, lib),
    quote: lib.trivia?.quote_of_today ?? '',
    count: t.today.length,
    today: t.today,
    behind: t.behindAll,
    catchup: t.catchup,
    reminders: rem,
    timeline: { aired: tl.aired, upcoming: tl.upcoming, next: tl.next, last: tl.last },
    // 扁平整周表：YAYA 版 SSP 直接读它，按 weekday + min 和当前时间比
    all_shows: t.allShows ?? [],
    week,
  };
  await writeJsonAtomic(path.join(ROOT, 'data', 'today.json'), snapshot);

  const kb = (Buffer.byteLength(L.join('\r\n'), 'utf8') / 1024).toFixed(1);
  console.log(`[build_today] ${t.date} ${t.weekday_cn} ${pad(hour)}:${pad(minute)} · 今天 ${t.today.length} 部 · 落后 ${t.behindAll.length} 部 · 待补 ${t.catchup.length} 部`);
  console.log('  ' + summarize(t, lib));
  if (tl.next) console.log(`  下一部: ${tl.next.name_cn} ${tl.next.time_cst}`);
  if (rem.length) console.log(`  一小时内开播: ${rem.map((r) => `${r.name_cn} ${r.time_cst}`).join('、')}`);
  console.log(`  → ghost/master/today.txt (${kb}KB)`);
  console.log('  → data/today.json');
}

main().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
