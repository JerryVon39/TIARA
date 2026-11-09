/**
 * 极简 iCalendar（RFC 5545 的子集）生成器。
 *
 * 为什么单独抽一个文件：导出 .ics 是唯一「出去以后还要被别的软件解析」的产物，
 * 以前它埋在 server.mjs 里、没有任何测试——TRIGGER 少个负号、换行用了 \n 都看不出来。
 * 这里只做纯字符串拼接，方便单测（test/ics.test.mjs）。
 */

const pad2 = (n) => String(n).padStart(2, '0');

/** 转义：反斜杠、分号、逗号、换行（RFC 5545 §3.3.11） */
export function icsText(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * UTC 时间戳（DTSTAMP 用）：20261105T013000Z
 *
 * DTSTAMP 按 RFC 5545 必须是「真实的 UTC 瞬时」。以前先 +8 小时再打 Z 后缀，
 * 于是每张事件都标着「8 小时后生成」，日历客户端显示「上次更新：未来」。
 */
export function icsStamp(date) {
  const t = new Date(date.getTime());
  return (
    `${t.getUTCFullYear()}${pad2(t.getUTCMonth() + 1)}${pad2(t.getUTCDate())}` +
    `T${pad2(t.getUTCHours())}${pad2(t.getUTCMinutes())}${pad2(t.getUTCSeconds())}Z`
  );
}

/** 'YYYY-MM-DD' + 当日分钟数（可 >=1440，跨到次日）→ iCal 本地时间 20261105T233000 */
function localStamp(dateStr, minutes) {
  const off = Math.floor(minutes / 1440);
  const m = minutes - off * 1440;
  const base = new Date(Date.parse(`${dateStr}T00:00:00+08:00`) + off * 86400e3);
  // +08:00 的日历字段 = UTC 瞬时 + 8 小时；年月日都从这一份里取，避免跨年时错位
  const cst = new Date(base.getTime() + 8 * 3600e3);
  const y = cst.getUTCFullYear();
  const mo = cst.getUTCMonth() + 1;
  const d = cst.getUTCDate();
  return `${y}${pad2(mo)}${pad2(d)}T${pad2(Math.floor(m / 60))}${pad2(m % 60)}00`;
}

/** '23:30' → 1410；解析不了返回 null */
export function timeToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!(mi >= 0 && mi < 60) || h > 47) return null;
  return h * 60 + mi;
}

/**
 * RFC 5545 §3.1 折行：一行最多 75 个八位组，超出部分用 CRLF + 一个空格续行。
 * 以前不折行——`DESCRIPTION` 里带一句长中文就是 130 字节，Outlook 会直接截断，
 * Google 日历虽然容忍，但导入校验工具会报「line too long」。
 * 按 UTF-8 字节切，不按字符切：一个汉字 3 字节，切在字节中间会变成乱码。
 */
export function foldLine(line, limit = 75) {
  const text = String(line ?? '');
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch, 'utf8');
    // 续行前面多一个空格（1 字节），所以第 2 行起预算少 1
    const cap = out.length === 0 ? limit : limit - 1;
    if (bytes + b > cap && cur) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += b;
  }
  if (cur) out.push(cur);
  return out.join('\r\n ');
}

/**
 * 生成一周的日历。
 * @param {Array<{uid:string,date:string,time?:string,summary:string,description?:string}>} events
 * @param {{now?:Date, calName?:string, tz?:string, durationMin?:number, alarmMin?:number, includeAlarm?:boolean}} opts
 * @returns {string} 带 CRLF 的 .ics 文本
 */
export function buildIcs(events, opts = {}) {
  const {
    now = new Date(),
    calName = 'TIARA 的本周番组',
    tz = 'Asia/Shanghai',
    durationMin = 30,
    alarmMin = 10,
    includeAlarm = true,
    prodId = '-//tiara//weekly//CN',
  } = opts;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${prodId}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(calName)}`,
    'BEGIN:VTIMEZONE',
    `TZID:${tz}`,
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0800',
    'TZOFFSETTO:+0800',
    'TZNAME:CST',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];

  for (const ev of events || []) {
    const mins = timeToMinutes(ev.time);
    if (mins == null) continue; // 没时刻的不进日历，免得一堆 00:00
    lines.push(
      'BEGIN:VEVENT',
      `UID:${ev.uid}`,
      `DTSTAMP:${icsStamp(now)}`,
      `DTSTART;TZID=${tz}:${localStamp(ev.date, mins)}`,
      `DTEND;TZID=${tz}:${localStamp(ev.date, mins + durationMin)}`,
      `SUMMARY:${icsText(ev.summary)}`,
      `DESCRIPTION:${icsText(ev.description || '')}`
    );
    if (includeAlarm && !ev.noAlarm) {
      lines.push(
        'BEGIN:VALARM',
        `TRIGGER:-PT${Math.max(0, Math.round(alarmMin))}M`,
        'ACTION:DISPLAY',
        `DESCRIPTION:${icsText(ev.summary)}`,
        'END:VALARM'
      );
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map((l) => foldLine(l)).join('\r\n') + '\r\n';
}
