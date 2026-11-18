import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from './atomic.mjs';

export function broadcastDate(value) {
  if (typeof value !== 'string') return null;
  const matched = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(value.trim());
  if (!matched || +matched[1] < 1900 || +matched[1] > 2200) return null;
  const date = matched.slice(1).map(part => part.padStart(2, '0')).join('-');
  const clock = new Date(date + 'T00:00:00Z');
  return Number.isFinite(+clock) && clock.toISOString().slice(0, 10) === date ? date : null;
}

export function subjectBroadcastEnd(infobox) {
  if (!Array.isArray(infobox)) return null;
  const dates = new Set(infobox.filter(field =>
    /^(?:播放结束|播放結束|放送结束|放送終了|放送結束|播出结束|播出結束)$/.test(field?.key?.trim?.()))
    .map(field => broadcastDate(field.value)).filter(Boolean));
  return dates.size === 1 ? dates.values().next().value : null;
}

export function broadcastStatus({ meta, episodes, today, manualEnd = false }) {
  const start = broadcastDate(meta?.date);
  const end = broadcastDate(meta?.broadcast_end);
  const rows = Array.isArray(episodes?.items) ? episodes.items : [];
  const dated = rows.map(row => ({ number: row.number, date: broadcastDate(row.airdate) }));
  if (start >= today || end >= today || dated.some(row => row.date >= today)) return { state: 'airing' };
  if (manualEnd) return { state: 'ended', source: 'manual' };
  const dates = new Map(dated.filter(row => row.date).map(row => [row.number, row.date]));
  const total = Number(meta?.regular_total);
  if (end && (!start || end >= start) && !dated.some(row => row.date > end))
    return { state: 'ended', source: 'subject', date: end };
  if (Number.isInteger(total) && total > 0 && total === rows.length && dates.size === total &&
      Array.from({ length: total }, (_, i) => dates.get(i + 1)).every(date => date && (!start || date >= start)))
    return { state: 'ended', source: 'episodes', date: [...dates.values()].sort().at(-1) };
  return { state: 'unknown' };
}

const metadataFile = (root, id) => path.join(root, 'cache', 'bgm', 'broadcast-status', id + '.json');

export async function readBroadcastMeta(root, id) {
  return fs.readFile(metadataFile(root, id), 'utf8').then(JSON.parse).catch(() => null);
}

export async function saveBroadcastMeta(root, id, meta) {
  const details = { date: meta.date, broadcast_end: meta.broadcast_end, regular_total: meta.regular_total };
  await writeJsonAtomic(metadataFile(root, id), details).catch(() => {});
  return details;
}
