/**
 * lib/today.mjs — 番组日程计算（纯本地，无网络，无副作用）
 *
 * 约定：
 *   · 所有时间都是 CST(+08:00)，`weekday` 键为 1..7（1=周一）；
 *   · 本文件只做纯函数计算，被 tools/build_today.mjs、tools/build_ghost.mjs、server.mjs 共用；
 *   · 不读文件、不写文件、不看系统时区。
 */

import { parseClock, splitClock } from './time.mjs';
import { inactiveWatchIds } from './watch-lifecycle.mjs';

export const WEEK_CN = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 存储允许广播日 + 25:30；计算统一使用真实星期和 01:30，不修改原库。 */
export function actualSchedule(lib) {
  const shift = (clock, weekday) => {
    const p = parseClock(clock);
    if (!p.ok || p.minutes < 1440) return { clock, weekday, offset: 0 };
    const s = splitClock(p.minutes);
    return { clock: s.hhmm, weekday: weekday == null ? null : ((Number(weekday) - 1 + s.dayOffset) % 7) + 1, offset: s.dayOffset };
  };
  const weekday = {};
  const inactive = inactiveWatchIds(lib);
  for (const [d, entries] of Object.entries(lib.weekday || {})) {
    for (const e of entries || []) {
      if (inactive.has(String(e.id))) continue;
      const s = shift(e.time_cst, Number(d));
      (weekday[s.weekday] ||= []).push({ ...e, time_cst: s.clock });
    }
  }
  const watching = (lib.watching || []).map(w => {
    const s = shift(w.air_time_cst, w.air_weekday);
    const start = cstEpochDay(w.start_date);
    return { ...w, air_time_cst: s.clock, air_weekday: s.weekday,
      ...(s.offset && start != null ? { start_date: new Date((start + s.offset) * 86400000).toISOString().slice(0, 10) } : {}) };
  });
  return { ...lib, weekday, watching };
}

/** 默认偏好：30 小时制；data/settings.json 可以覆盖（桌宠尺寸归 data/state.json，那是桌宠自己的） */
export const DEFAULT_SETTINGS = { clock: '30h', pet_scale: 1 };

/** 30 小时制里，05:00 之前的档算「前一天深夜」——所以 01:00 会写成 25:00 */
export const CLOCK_30_CUTOFF = 5 * 60;

/**
 * 把「真实时间」翻成显示用的时间。
 *
 * 日本电视圈习惯用 30 小时制：周三 25:00 = 周四 01:00。
 * 我们库里存的是真实 CST 时间，只在这一层换显示，不影响任何计算。
 *
 * @returns {{time:string, time_disp:string, weekday:number|null, weekday_disp:number|null, shifted:boolean}}
 */
export function displayClock(time_cst, weekday, mode = DEFAULT_SETTINGS.clock, cutoff = CLOCK_30_CUTOFF) {
  const wd = Number.isFinite(Number(weekday)) && Number(weekday) >= 1 && Number(weekday) <= 7 ? Number(weekday) : null;
  const m = minutesOfDay(time_cst);
  const plain = { time: time_cst || '', time_disp: time_cst || '', weekday: wd, weekday_disp: wd, shifted: false };
  if (mode !== '30h' || !time_cst || m >= 24 * 60 + 1 || m >= cutoff) return plain;
  const h = Math.floor(m / 60) + 24;
  const mm = m % 60;
  return {
    time: time_cst,
    time_disp: `${h}:${String(mm).padStart(2, '0')}`,
    weekday: wd,
    weekday_disp: wd == null ? null : wd === 1 ? 7 : wd - 1,
    shifted: true,
  };
}

/** 取某 Date 在 CST 下的星期（1..7）与日期串 */
export function cstParts(date = new Date()) {
  // 统一换算到 UTC+8，避免宿主机时区干扰
  const utc8 = new Date(date.getTime() + 8 * 3600 * 1000);
  const y = utc8.getUTCFullYear();
  const m = utc8.getUTCMonth() + 1;
  const d = utc8.getUTCDate();
  const dow = utc8.getUTCDay() === 0 ? 7 : utc8.getUTCDay();
  const pad = (n) => String(n).padStart(2, '0');
  return { date: `${y}-${pad(m)}-${pad(d)}`, weekday: dow, hour: utc8.getUTCHours(), minute: utc8.getUTCMinutes(), second: utc8.getUTCSeconds() };
}

/** "23:00" → 分钟数；非法值排到最后 */
export function toMin(hhmm) {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return 24 * 60 + 1;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** "23:00" → 当天分钟数（容忍 25:30 这种跨日写法） */
export function minutesOfDay(hhmm) {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(hhmm)) return 24 * 60 + 1;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** "YYYY-MM-DD" → CST 日序号（只用来算差几天，不受时区影响） */
export function cstEpochDay(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000;
}

/** 某 Date 的 CST 日序号 */
export function epochDayOf(date) {
  return cstEpochDay(cstParts(date).date);
}

/**
 * 推算「到现在为止应该已经播到第几话」。
 * 优先用手工维护的 weekday[..].ep_expected（用户最清楚），
 * 没有就按 start_date + 周更推算（air_weekday 缺失则返回 null）。
 *
 * @param {object} w        watching 里的一条
 * @param {object} lib      library
 * @param {Date}   now
 * @param {number[]} [todayIdsOfDay] 当天已经播完的 weekday 条目（可选，用来减掉「今天还没播」）
 */
export function expectedEpisode(w, lib, now = new Date(), airedTodayIds = null) {
  if (!w || typeof w.eps !== 'number') return null;
  const normalized = actualSchedule({ ...lib, watching: [w] });
  w = normalized.watching[0];
  lib = normalized;
  const wd = w.air_weekday;
  const entry = wd == null ? null : (lib.weekday?.[String(wd)] || []).find((x) => String(x.id) === String(w.id));
  // 不给 airedTodayIds 就自己算一次：单独调用这个函数时也能得到正确结果
  const aired = airedTodayIds || airedIdSet(lib.weekday?.[String(cstParts(now).weekday)] || [], now);
  const delta = weekDelta(w.id, wd, now, aired);
  const n = deriveExpected(w, entry, delta, now);

  // 3) 「从加入那天开始追」：加入之前播掉的集数不算欠账
  //    （整季 12 部加入时 ep_status=0，不这么处理的话落后会直接爆表）
  const tf = cstEpochDay(w.track_from);
  if (tf == null || n == null) return n;
  const start = cstEpochDay(w.start_date);
  if (start == null || wd == null) return n;
  const skipped = Math.max(0, Math.floor((tf - start) / 7));
  return clamp(n - skipped, 0, w.eps);
}

function deriveExpected(w, entry, delta, now) {
  // 1) 手工值优先
  if (entry && typeof entry.ep_expected === 'number') {
    return clamp(entry.ep_expected + delta, 0, w.eps);
  }

  // 2) 用 start_date 推算
  const start = cstEpochDay(w.start_date);
  if (start == null || w.air_weekday == null) return null;
  const clock = parseClock(w.air_time_cst || entry?.time_cst);
  const first = start * 86400000 - 8 * 3600000 + (clock.ok ? clock.minutes : 1440) * 60000;
  const weeks = Math.floor((now.getTime() - first) / (7 * 86400000));
  if (weeks < 0) return 0;
  return clamp((w.ep_start || 1) + weeks, 0, w.eps);
}

/**
 * 「这一周的播出算不算已经过去了」→ 0 / -1。
 *  - 今天就是它的播出日：还没到点算 -1，播完了算 0
 *  - 播出日在本周更后面：这周还没到，算 -1
 *  - 播出日已经过去：算 0
 */
function weekDelta(id, wd, now, airedTodayIds) {
  if (wd == null || !airedTodayIds) return 0;
  const todayWd = cstParts(now).weekday;
  const w = Number(wd);
  if (w === todayWd) return airedTodayIds.has(String(id)) ? 0 : -1;
  return w > todayWd ? -1 : 0;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** 今天这一天里，已经开播的 id 集合（只用于「今天还没播」的判断） */
function airedIdSet(list, now) {
  const { hour, minute } = cstParts(now);
  const cur = hour * 60 + minute;
  const set = new Set();
  for (const it of list) {
    if (minutesOfDay(it.time_cst) <= cur) set.add(String(it.id));
  }
  return set;
}

/**
 * 今日番组 + 追番进度差（含「非放送日也看得见的落后」）
 * @returns {{date:string, weekday:number, weekday_cn:string, today:Array, behind:Array,
 *            behindAll:Array, catchup:Array, aired:Array, upcoming:Array, next:object|null}}
 */
export function buildToday(lib, date = new Date(), opts = {}) {
  lib = actualSchedule(lib);
  const clock = opts.clock === '24h' || opts.clock === '30h' ? opts.clock : DEFAULT_SETTINGS.clock;
  const { date: dateStr, weekday } = cstParts(date);
  const raw = (lib.weekday?.[String(weekday)] || []).slice().sort((a, b) => toMin(a.time_cst) - toMin(b.time_cst));
  const byId = new Map((lib.watching || []).map((w) => [String(w.id), w]));
  const airedIds = airedIdSet(raw, date);

  // 今天这一档里，只有「自己在追」的才进今日清单；
  // 剩下的本季新番单独算一份 side，免得把别人的番塞满主人的节目表。
  const today = [];
  const side = [];
  for (const it of raw) {
    const w = byId.get(String(it.id));
    const expected = w ? expectedEpisode(w, lib, date, airedIds) : (typeof it.ep_expected === 'number' ? it.ep_expected : null);
    const behind = w && typeof w.ep_status === 'number' && typeof expected === 'number' ? Math.max(0, expected - w.ep_status) : 0;
    const dc = displayClock(it.time_cst, weekday, clock);
    const row = {
      ...it,
      watched_eps: w ? w.ep_status : null,
      total_eps: w ? w.eps : null,
      expected_eps: expected,
      behind,
      aired: airedIds.has(String(it.id)),
      priority: w?.priority ?? it.priority ?? '—',
      name: w?.name ?? '',
      name_cn: w?.name_cn ?? it.name_cn ?? '',
      rate: w?.rate ?? null,
      last_watched: w?.last_watched ?? null,
      comment: w?.comment ?? '',
      time_disp: dc.time_disp,
      weekday_disp: dc.weekday_disp,
      disp_shifted: dc.shifted,
    };
    (w ? today : side).push(row);
  }

  // 进度落后（今天这一天）
  const behind = today.filter((t) => t.behind > 0);

  // 全量落后：不放送的日子也报
  const behindAll = [];
  for (const w of lib.watching || []) {
    if (typeof w.ep_status !== 'number' || typeof w.eps !== 'number') continue;
    if (w.air_weekday == null) continue;                 // 完结的走 catchup
    const expected = expectedEpisode(w, lib, date, airedIds);
    if (expected == null) continue;
    const gap = expected - w.ep_status;
    if (gap > 0) {
      const dc = displayClock(w.air_time_cst, w.air_weekday, clock);
      behindAll.push({
        id: w.id,
        name_cn: w.name_cn || w.name || String(w.id),
        behind: gap,
        expected_eps: expected,
        watched_eps: w.ep_status,
        total_eps: w.eps,
        air_weekday: w.air_weekday,
        air_time_cst: w.air_time_cst || null,
        time_disp: dc.time_disp,
        weekday_disp: dc.weekday_disp,
        priority: w.priority ?? '',
      });
    }
  }
  behindAll.sort((a, b) => b.behind - a.behind || String(a.name_cn).localeCompare(String(b.name_cn)));

  // 已完结但没补完的
  const catchup = (lib.watching || []).filter(
    (w) => w.air_weekday == null && typeof w.eps === 'number' && typeof w.ep_status === 'number' && w.ep_status < w.eps
  );

  const tl = timeline(today, date);
  return {
    date: dateStr,
    weekday,
    weekday_cn: WEEK_CN[weekday],
    clock,
    today,
    side,
    behind,
    behindAll,
    catchup,
    allShows: allShows(lib),
    aired: tl.aired,
    upcoming: tl.upcoming,
    next: tl.next,
    last: tl.last,
  };
}

/**
 * 整周番组的扁平表：给 YAYA 版 SSP 用（它读 today.json，
 * 按 weekday + min 直接和当前时间比，不需要再解析 "HH:MM"）。
 *
 * @returns {Array<{id:any, name_cn:string, weekday:number, time_cst:string|null,
 *                  min:number, ep_expected:number|null}>}
 */
export function allShows(lib) {
  lib = actualSchedule(lib || {});
  const out = [];
  const seen = new Set();
  const mineIds = new Set((lib?.watching || []).map((w) => String(w.id)));
  const push = (id, name_cn, wd, time_cst, ep_expected, mine) => {
    const key = `${id}|${wd}|${time_cst || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      id,
      name_cn: name_cn || String(id),
      weekday: wd,
      time_cst: time_cst || null,
      min: minutesOfDay(time_cst),
      ep_expected: typeof ep_expected === 'number' ? ep_expected : null,
      mine: mine != null ? !!mine : mineIds.has(String(id)),
    });
  };

  // 1) 在追列表里带放送日的
  for (const w of lib?.watching || []) {
    const wd = Number(w.air_weekday);
    if (!Number.isFinite(wd) || wd < 1 || wd > 7) continue;
    push(w.id, w.name_cn || w.name, wd, w.air_time_cst, w.ep_expected, true);
  }

  // 2) 手写的整周排片表（示例数据里有些番只在表里、不在在追列表里）
  const week = lib?.weekday ?? {};
  for (let d = 1; d <= 7; d++) {
    for (const s of week[String(d)] ?? []) {
      push(s.id, s.name_cn || s.name, d, s.time_cst, s.ep_expected, mineIds.has(String(s.id)));
    }
  }

  out.sort((a, b) => a.weekday - b.weekday || a.min - b.min);
  return out;
}

/** 现在/接下来：把今天的番切成 已播 / 下一部 / 稍后 */
export function timeline(todayList, date = new Date()) {
  const { hour, minute } = cstParts(date);
  const now = hour * 60 + minute;
  const aired = [];
  const upcoming = [];
  for (const it of todayList) {
    const t = minutesOfDay(it.time_cst);
    if (t <= now) aired.push(it);
    else upcoming.push(it);
  }
  aired.sort((a, b) => minutesOfDay(b.time_cst) - minutesOfDay(a.time_cst));
  upcoming.sort((a, b) => minutesOfDay(a.time_cst) - minutesOfDay(b.time_cst));
  return { aired, upcoming, next: upcoming[0] || null, last: aired[0] || null };
}

/**
 * 到点提醒：今天还没开播、且距离开播 <= withinMinutes 的番
 * 桌宠每 30 秒扫一次，返回空数组就什么都不做。
 */
export function reminders(todayList, date = new Date(), withinMinutes = 30) {
  const { hour, minute } = cstParts(date);
  const now = hour * 60 + minute;
  const out = [];
  for (const it of todayList) {
    if (it.behindPaused) continue;
    const t = minutesOfDay(it.time_cst);
    const left = t - now;
    if (left >= 0 && left <= withinMinutes) {
      out.push({ ...it, minutes_left: left });
    }
  }
  out.sort((a, b) => a.minutes_left - b.minutes_left);
  return out;
}

/** 时段：台词池按这个挑 */
export function timeOfDay(date = new Date()) {
  const h = cstParts(date).hour;
  if (h >= 1 && h < 5) return 'lateNight';
  if (h >= 5 && h < 11) return 'morning';
  if (h >= 11 && h < 17) return 'noon';
  if (h >= 17 && h < 23) return 'evening';
  return 'lateNight';
}

/** 组装成「今日一句话」——给台词/面板用 */
export function summarize(t, lib) {
  const nick = lib.user?.nickname_for_pet || '主人';
  if (!t.today.length) {
    const tail = t.behindAll?.length
      ? `积压 ${t.behindAll.length} 部没补（${t.behindAll[0].name_cn} 差 ${t.behindAll[0].behind} 话）。`
      : `${nick}，要不要去补番？`;
    return `${t.weekday_cn}没有要追的番。${tail}`;
  }
  const names = t.today.map((x) => x.name_cn || x.name).join('、');
  let s = `${t.weekday_cn}有 ${t.today.length} 部：${names}。`;
  const gap = t.behindAll?.length ? t.behindAll : t.behind;
  if (gap.length) s += `其中 ${gap.map((b) => `${b.name_cn}还差 ${b.behind} 话`).join('，')}。`;
  return s;
}
