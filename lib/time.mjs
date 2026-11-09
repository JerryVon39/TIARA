/**
 * lib/time.mjs — 开播时刻的「唯一一种写法」
 *
 * 起因：同一个 '25:00' 在 POST /api/season/time 被判 400，在 /api/season/time-batch
 * 却能写进库；更糟的是 'abc' 两边都收——因为它走的是 lib/today.mjs 的 toMin()，
 * 而 toMin() 对非法串返回 1441（一个为了排序把脏数据排到最后而设计的哨兵值），
 * 1441 恰好落在「合法范围」里。校验和排序共用一个函数，迟早出事。
 *
 * 这里只做校验与规范化，不碰排序：
 *   · '23:30' / '9:05' → 合法，规范化为 '23:30' / '09:05'
 *   · '25:30'          → 合法（30 小时制，按次日 01:30 算）
 *   · 'abc' '2:3' '24:60' '29:00' → 非法
 * 上限 28:59：面板的 30 小时制最晚显示到「次日 04:59」，再晚就没有意义了。
 */

export const MINUTES_PER_DAY = 24 * 60;
/** 允许的最大分钟数：28:59（30h 制的次日 04:59） */
export const MAX_CLOCK_MINUTES = 28 * 60 + 59;

/**
 * 解析一个时刻串。
 * @param {unknown} text
 * @returns {{ok:true, minutes:number, text:string} | {ok:false, error:string}}
 */
export function parseClock(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, error: '时刻不能为空（写 23:30 这种）' };
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(raw);
  if (!m) return { ok: false, error: `时刻要写成 23:30 这种（收到「${raw}」）` };
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (minutes > MAX_CLOCK_MINUTES) {
    return { ok: false, error: `时刻最晚 28:59（收到「${raw}」）` };
  }
  return { ok: true, minutes, text: clockText(minutes) };
}

/** 分钟数 → 'HH:MM'（25:30 这种跨日写法保留） */
export function clockText(minutes) {
  const n = Math.max(0, Math.round(Number(minutes) || 0));
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

/** 跨日拆分：1500 → { dayOffset: 1, hhmm: '01:00' } */
export function splitClock(minutes) {
  const n = Math.max(0, Math.round(Number(minutes) || 0));
  const dayOffset = Math.floor(n / MINUTES_PER_DAY);
  return { dayOffset, hhmm: clockText(n - dayOffset * MINUTES_PER_DAY) };
}

/** 宽松版：合法就返回规范串，非法返回 null（给「清空时刻」这类调用点用） */
export function normalizeClockOrNull(text) {
  if (text == null) return null;
  const r = parseClock(text);
  return r.ok ? r.text : null;
}
