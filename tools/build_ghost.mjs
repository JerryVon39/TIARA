#!/usr/bin/env node
/**
 * tools/build_ghost.mjs — 生成 SSP 人格台词文件 words.txt（里々 / 花和雅 兼容）
 *
 *   node tools/build_ghost.mjs
 *   node tools/build_ghost.mjs --date 2026-11-07
 *
 * 生成规则（保守写法，保证里々 不歧义）：
 *   一段只有一行台词，以 \e 收尾；句内换行用 \n；
 *   ＊ランダム 允许一行一条，里々 会随机挑。
 *
 * 产出 ghost/master/words.txt：
 *   ＊OnFirstBoot / ＊OnBoot（含今日番组播报）/ ＊OnClose / ＊OnMouseDoubleClick
 *   ＊ランダム（日常随机）/ ＊今日（单独的当日台词，方便手动测试）
 *
 * 一个源 data/talks.json 同时喂 Web 预览器和 SSP 人格。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildToday, timeline, summarize, cstParts } from '../lib/today.mjs';
import { writeFileAtomic } from '../lib/atomic.mjs';

const rootIndex = process.argv.indexOf('--root');
const ROOT = rootIndex >= 0 ? path.resolve(process.argv[rootIndex + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GHOST = path.join(ROOT, 'ghost', 'master');

/** 表情名 → \s[n]，与 shell/master/surfaceN.png 一一对应 */
const FACE = { normal: 0, happy: 1, sad: 2, surprise: 3, sleepy: 4, think: 5 };

/** shell/master 里实际存在哪几张 surface：缺的（比如 tiara 那套只有 0..3）
 *  一律退回 normal(0)，否则 \s[4] 找不到图会被画成空白 */
const HAVE = new Set([0]);
for (let i = 1; i <= 5; i++) {
  try {
    (await fs.access(path.join(ROOT, 'shell', 'master', `surface${i}.png`)), HAVE.add(i));
  } catch {}
}
if (HAVE.size < 6) console.log(`[build_ghost] 只有 ${HAVE.size} 张 surface，缺的表情退回 normal`);

const argv = process.argv.slice(2);
let dateArg = null;
for (let i = 0; i < argv.length; i++) if (argv[i] === '--date' && argv[i + 1]) dateArg = argv[++i];

function dateFromArg(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 4, 0, 0)); // CST 12:00
}

/** 文本 → さくらスクリプト 单行（真实换行转 \n）
 *
 *  SSP 没有变量系统，所以这里把 {nickname} 之类的占位符在生成时就替换掉，
 *  否则里々 会把 "{nickname}" 原样念出来。SUBST 在 main() 里按当前数据填。
 */
let SUBST = {};

function ss(text) {
  return String(text)
    .replace(/\{(\w+)\}/g, (m, k) => (SUBST[k] != null ? String(SUBST[k]) : m))
    // 反斜杠在 SakuraScript 里是转义引导符：台词里出现「C:\Users」会把 \U 当标签吞掉，
    // 所以先把自己家的反斜杠写成 \\，再做换行替换（那一步的 \n 是有意留的标签）。
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n');
}

/** 一行台词：\0 = 樱侧，\s[n] = 表情 */
function line(entry, tail = '\\e') {
  const e = typeof entry === 'string' ? { text: entry, face: 'normal' } : entry;
  let face = FACE[e.face] ?? 0;
  if (!HAVE.has(face)) face = 0;
  return `\\0\\s[${face}]${ss(e.text)}${tail}`;
}

function todayLine(t, lib) {
  const nick = lib.user?.nickname_for_pet || '会長';
  if (!t.today.length) {
    const backlog = t.behindAll?.length ? `积压 ${t.behindAll.length} 部，` : '';
    return `${t.weekday_cn}，案件 0 件。${backlog}${nick}，要不要清一点？`;
  }
  const parts = t.today.map((s) => {
    const name = s.name_cn;
    if (s.behind > 0) return `${s.time_cst ?? '时刻未定'} ${name}（未处理 ${s.behind} 话）`;
    return `${s.time_cst ?? '时刻未定'} ${name}`;
  });
  return `${t.weekday_cn}，${t.today.length} 件：${parts.join('、')}。`;
}

async function main() {
  const [talks, lib] = await Promise.all([
    fs.readFile(path.join(ROOT, 'data', 'talks.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(ROOT, 'data', 'library.json'), 'utf8').then(JSON.parse),
  ]);

  const now = dateArg ? dateFromArg(dateArg) : new Date();
  const t = buildToday(lib, now);
  const tl = timeline(t.today, now);

  // SSP 里没有变量，占位符在这里就地换成当前值
  SUBST = {
    nickname: lib.user?.nickname_for_pet || '会長',
    count: t.today.length,
    behind_count: t.behindAll?.length ?? 0,
    catchup_count: t.catchup?.length ?? 0,
    weekday_cn: t.weekday_cn,
    summary: summarize(t, lib),
    quote: lib.trivia?.quote_of_today ?? '',
    nade_today: 0,
    nade_total: 0,
    poke_total: 0,
    affinity: 0,
    // 时刻相关一律按 CST 算：以前用 new Date(now).getHours()，在西八区/UTC 的机器上
    // 会生成「早上好」然后晚上八点播出去；全项目其它地方都是 +08:00，这里必须跟上。
    hour: cstParts(now).hour,
  };

  const out = [];
  out.push('# 番组管家 · words.txt');
  out.push('# 由 tools/build_ghost.mjs 从 data/talks.json + data/library.json 生成，别手改。');
  out.push('# 编码 UTF-8。放到 ghost/master/ 下，SSP 里选「里々」当 SHIORI 即可。');
  out.push('');

  // ---- 首启 ----
  if (talks.firstBoot?.length) {
    out.push('＊OnFirstBoot');
    out.push(line({ text: talks.firstBoot.map((x) => x.text.replace(/\n/g, ' ')).join(''), face: 'normal' }));
    out.push('');
  }

  // ---- 每次启动：欢迎（随机挑一条）+ 今日播报 ----
  const bootPool = (talks.boot?.length ? talks.boot : [{ text: '番组管家，TIARA。', face: 'normal' }]);
  out.push('＊OnBoot');
  for (const b of bootPool) {
    out.push(line({ text: `${b.text}\\n${todayLine(t, lib)}`, face: b.face ?? 'normal' }));
  }
  out.push('');

  // ---- 自我介绍 ----
  if (talks.selfIntro?.length) {
    out.push('＊自己紹介');
    for (const e of talks.selfIntro) out.push(line(e));
    out.push('');
  }

  // ---- 摸头 / 滚轮 ----
  if (talks.nade?.length) {
    out.push('＊OnNadeNade');
    for (const e of talks.nade) out.push(line(e));
    out.push('');
  }
  if (talks.wheel?.length) {
    out.push('＊OnMouseWheel');
    for (const e of talks.wheel) out.push(line(e));
    out.push('');
  }

  // ---- 时段问候（里々 里手动点也行，方便调试）----
  for (const [key, head] of [['morning', '朝'], ['noon', '昼'], ['evening', '夜']]) {
    if (!talks[key]?.length) continue;
    out.push('＊' + head);
    for (const e of talks[key]) out.push(line(e));
    out.push('');
  }

  // ---- 关闭 ----
  if (talks.close?.length) {
    out.push('＊OnClose');
    out.push(line(talks.close[0]));
    out.push('');
  }

  // ---- 双击 ----
  if (talks.doubleclick?.length) {
    out.push('＊OnMouseDoubleClick');
    for (const e of talks.doubleclick) out.push(line(e));
    out.push('');
  }

  // ---- 随机 ----
  out.push('＊ランダム');
  for (const e of [...(talks.random || []), ...(talks.click || []), ...(talks.headpat || [])]) {
    out.push(line(e));
  }
  out.push('');

  // ---- 积压提醒（一条一部，名字/话数直接写死，SSP 里不依赖脚本）----
  if (t.behindAll?.length) {
    out.push('＊積み');
    for (const b of t.behindAll.slice(0, 6)) {
      out.push(line({
        text: `${b.name_cn}、未処理 ${b.behind} 件。${lib.user?.nickname_for_pet || '会長'}、催促はしません。ただ、記録しているだけです。`,
        face: 'think',
      }));
    }
    out.push('');
  }

  // ---- 单独一段今日 ----
  out.push('＊今日');
  out.push(line({ text: todayLine(t, lib), face: t.today.length ? 'normal' : 'sleepy' }));
  out.push('');
  if (tl.next) {
    out.push('＊つづき');
    out.push(line({ text: `接下来是 ${tl.next.name_cn}，${tl.next.time_cst}。`, face: 'happy' }));
    out.push('');
  }

  const text = out.join('\r\n');
  // 原子写：SSP 会在启动瞬间读 words.txt，覆写到一半被读走就是「里々 不说话」
  await writeFileAtomic(path.join(GHOST, 'words.txt'), text, 'utf8');

  let surfaces = null;
  try {
    surfaces = JSON.parse(await fs.readFile(path.join(ROOT, 'shell', 'master', 'surfaces.json'), 'utf8'));
  } catch {}

  const sections = text.split('\r\n').filter((l) => l.startsWith('＊')).length;
  console.log(`[build_ghost] ${t.date} ${t.weekday_cn} · ${t.today.length} 部`);
  console.log(`  ghost/master/words.txt  ${sections} 段  ${(Buffer.byteLength(text) / 1024).toFixed(1)}KB`);
  if (surfaces) console.log(`  shell: ${surfaces.slots.length} 张 surface ${surfaces.size.w}x${surfaces.size.h}`);
  console.log(`  播报: ${todayLine(t, lib)}`);
}

main().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
