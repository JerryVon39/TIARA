import { cstParts } from './today.mjs';
import { WATCH_STATES, isWatchFinished } from './watch-lifecycle.mjs';
import { watchHistoryOwners } from './library-organize.mjs';
import { firstWatchCompleted } from './watch-rewatch.mjs';

export function watchWeekReport(library, rows, date, now = new Date()) {
  const focus = date ? new Date(date + 'T12:00:00+08:00') : now;
  const monday = +focus - (cstParts(focus).weekday - 1) * 86400000;
  const days = Array.from({ length: 7 }, (_, i) => ({ date: cstParts(new Date(monday + i * 86400000)).date, count: 0 }));
  const byDay = new Map(days.map(d => [d.date, d]));
  const from = days[0].date, to = days[6].date;
  const owners = watchHistoryOwners(library);
  const mode = { airing: 0, catchup: 0, rewatch: 0 };
  const titles = new Map();
  for (const row of rows) {
    const day = byDay.get(row.date);
    if (!day || row.id == null || !Number.isFinite(row.delta) || row.source === 'absolute' ||
        row.event === 'season' || row.action === 'season') continue;
    const owner = owners.get(String(row.id)), id = String(owner?.id ?? row.id);
    const title = owner?.name_cn || owner?.name || row.name || id;
    const current = titles.get(id) || { id, title, count: 0 };
    current.count += row.delta;
    titles.set(id, current);
    const key = Object.hasOwn(mode, row.watch_mode) ? row.watch_mode : 'airing';
    mode[key] += row.delta;
    day.count += row.delta;
  }
  const completed = [];
  for (const w of WATCH_STATES.flatMap(state => library[state] || [])) {
    if (isWatchFinished(w)) {
      const at = firstWatchCompleted(w, rows, owners);
      if (byDay.has(at)) completed.push({ id: String(w.id), title: w.name_cn || w.name || String(w.id),
        kind: w.watch_mode === 'catchup' ? 'catchup' : 'airing', date: at });
    }
    for (const round of w.rewatches || [])
      if (byDay.has(round.finished_at)) completed.push({ id: String(w.id), title: w.name_cn || w.name || String(w.id),
        kind: 'rewatch', date: round.finished_at });
  }
  return { from, to, today: cstParts(now).date, days, mode,
    count: Object.values(mode).reduce((sum, value) => sum + value, 0),
    titles: [...titles.values()].filter(row => row.count !== 0).sort((a, b) => b.count - a.count),
    completed: completed.sort((a, b) => b.date.localeCompare(a.date)) };
}
