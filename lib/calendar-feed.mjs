import { createHash } from 'node:crypto';
import { buildIcs } from './ics.mjs';

export const FEED_DAYS = 28;

export function refreshCalendarFeed(previous, events, { start, now }) {
  const old = new Map((Array.isArray(previous) ? previous : []).filter(item =>
    item && typeof item.uid === 'string' && typeof item.date === 'string' &&
    typeof item.stamp === 'string' && Number.isFinite(Date.parse(item.stamp)) &&
    Number.isSafeInteger(item.sequence) && item.sequence >= 0).map(item => [item.uid, item]));
  const next = new Map();
  const stamp = now.toISOString();
  for (const event of events) {
    const before = old.get(event.uid);
    const { stamp: ignored, sequence, ...details } = before || {};
    if (before && JSON.stringify(event) === JSON.stringify(details)) next.set(event.uid, before);
    else next.set(event.uid, { ...event, stamp, sequence: before ? sequence + 1 : 0 });
  }
  for (const [uid, event] of old) {
    if (next.has(uid) || event.date < start) continue;
    next.set(uid, event.cancelled ? event : { ...event, cancelled: true, stamp, sequence: event.sequence + 1 });
  }
  const stored = [...next.values()].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.uid.localeCompare(b.uid));
  const text = buildIcs(stored, { now, calName: 'TIARA · 本机日历订阅', includeAlarm: false });
  const etag = '"' + createHash('sha256').update(text).digest('hex') + '"';
  return { stored, text, etag };
}
