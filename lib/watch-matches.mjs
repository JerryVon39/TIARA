import { createHash } from 'node:crypto';
import { isWatchFinished, isCatchup, WATCH_STATES } from './watch-lifecycle.mjs';

export function titleKey(value) {
  return typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '') : '';
}

function names(item) {
  return [item.name_cn, item.name, item.original_name, item.alias].flat().map(titleKey).filter(Boolean);
}

export function releaseYear(item) {
  return String(item.user_details?.year || (/^\d{4}/.exec(item.release_date || item.start_date || item.date || '') || [])[0] || '');
}

export function libraryMatches(lib, candidate) {
  const requested = new Set(names(candidate));
  const year = releaseYear(candidate);
  const rows = [];
  for (const state of WATCH_STATES) {
    for (const item of Array.isArray(lib[state]) ? lib[state] : []) {
      if (item?.id == null) continue;
      const id = String(item.id);
      const sameId = candidate.id != null && String(candidate.id) === id;
      const itemYear = releaseYear(item);
      // A different Bangumi ID or known release year identifies a separate work.
      if (!sameId && ((candidate.id != null && /^\d+$/.test(id)) || (year && itemYear && year !== itemYear) ||
        !names(item).some(name => requested.has(name)))) continue;
      rows.push({ id, name: item.name_cn || item.name || id, year: itemYear,
        state: state !== 'watching' ? state : isWatchFinished(item) ? 'finished' : isCatchup(item) ? 'catchup' : state,
        match: sameId ? 'id' : 'name' });
    }
  }
  return rows.sort((a, b) => a.match.localeCompare(b.match) || a.id.localeCompare(b.id));
}

export function duplicateReview(candidate, matches) {
  return createHash('sha256').update(JSON.stringify([candidate, matches])).digest('hex');
}

export function matchesSearch(item, query) {
  const key = titleKey(query);
  return key && names(item).some(name => name.includes(key));
}
