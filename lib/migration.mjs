import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileAtomic, writeJsonAtomic } from './atomic.mjs';
import { historyIdValid, historyRetractions } from './history-retract.mjs';
import { validEpisodeExtras } from './watch-episodes.mjs';
import { WATCH_STATES } from './watch-lifecycle.mjs';
import { updateReminderEpochs } from './reminder-snooze.mjs';

export const MIGRATION_LIMIT = 16 * 1024 * 1024;
const FORMAT = 'tiara-migration';
const HISTORY = /^history(?:-\d{4})?\.jsonl$/;
const UNDO = /^undo\/step-[\w.-]+\.json$/;
const JOURNAL = '.migration-pending.json';
const COMPANION_IMPORT = 'companion-import.json';
const LAST_NOTE_SECOND = 253402214399;
const STORIES = ['first-page', 'after-credits', 'next-season', 'two-cups', 'after-duty', 'president-note'];
const SETTINGS = ['clock', 'pet_scale', 'power_save', 'birthday', 'quiet_start', 'quiet_end', 'catchup_goal',
  'quiet_work_start', 'quiet_work_end', 'quiet_weekend_start', 'quiet_weekend_end', 'reminder_lead'];
const privateKey = /^(?:bgm|bangumi|credentials?|(?:access|refresh|bgm|bangumi)?token|password|passwd|(?:client)?secret|proxy(?:url|password|user)?|authorization|apikey|cookie)$/i;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fileAt = (root, name) => path.join(root, 'data', name);
const revisionOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const targetName = name => ['library.json', 'settings.json', COMPANION_IMPORT].includes(name) || HISTORY.test(name) || UNDO.test(name);
const textField = (value, max) => typeof value === 'string' ? value.slice(0, max) : null;
const scaleValue = value => typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 2 ? value : null;

function desktopProfile(value) {
  if (!record(value)) return undefined;
  const profile = {};
  if (Array.isArray(value.notes)) {
    const ids = new Set();
    profile.notes = [];
    for (const note of value.notes) {
      if (!record(note) || typeof note.Id !== 'string' || !/^[\da-f]{32}$/i.test(note.Id) ||
          typeof note.Text !== 'string' || !note.Text.trim() || note.Text.length > 240) continue;
      const key = note.Id.toLowerCase();
      if (ids.has(key)) continue;
      ids.add(key);
      const clean = { Id: note.Id, Text: note.Text, ShowId: textField(note.ShowId, 200),
        ShowName: textField(note.ShowName, 160), Done: note.Done === true };
      if (Number.isSafeInteger(note.DueAt) && note.DueAt > 0 && note.DueAt <= LAST_NOTE_SECOND) {
        clean.DueAt = note.DueAt;
        if (Number.isSafeInteger(note.NotifiedAt) && note.NotifiedAt >= clean.DueAt && note.NotifiedAt <= LAST_NOTE_SECOND)
          clean.NotifiedAt = note.NotifiedAt;
      }
      profile.notes.push(clean);
      if (profile.notes.length === 30) break;
    }
  }
  if (Array.isArray(value.favorites)) {
    profile.favorites = [...new Set(value.favorites.filter(line =>
      typeof line === 'string' && line.trim() && line.length <= 320))].slice(0, 50);
  }
  const a = value.appearance;
  if (record(a)) {
    const shell = typeof a.shell === 'string' && a.shell.length <= 255 &&
      !/^[.]|[\\/:*?"<>|\x00-\x1f]|[. ]$/.test(a.shell) && a.shell.trim() ? a.shell : 'master';
    profile.appearance = { shell, theme: boundedInt(a.theme, 2),
      size: Number.isInteger(a.size) ? boundedInt(a.size, 2) : 1, scale: scaleValue(a.scale) ?? 1 };
    if (Number.isInteger(a.bubble_time)) profile.appearance.bubble_time = boundedInt(a.bubble_time, 3);
    for (const key of ['reduce_motion', 'idle_chatter', 'hourly_chatter']) {
      if (typeof a[key] === 'boolean') profile.appearance[key] = a[key];
    }
  }
  return profile;
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

const boundedInt = (value, max) => Number.isInteger(value) ? Math.min(max, Math.max(0, value)) : 0;

function companionMemory(value) {
  if (!record(value)) return null;
  const memory = {};
  const first = value.first_seen;
  if (validDate(first)) memory.first_seen = first;
  if (validDate(value.first_duty) || value.first_duty === '') memory.first_duty = value.first_duty;
  const letter = value.new_year_letter;
  if (record(letter) && validDate(letter.received) && /-01-0[1-7]$/.test(letter.received))
    memory.new_year_letter = { received: letter.received, read: letter.read === true, announced: letter.announced === true };
  const affinity = typeof value.affinity === 'string' && /^\d{1,3}$/.test(value.affinity) ? Number(value.affinity) : value.affinity;
  if (Number.isInteger(affinity) && affinity >= 0 && affinity <= 100) memory.affinity = affinity;
  const day = value.affinity_daily;
  if (record(day) && validDate(day.date)) {
    const activity = ['tea', 'duty'].includes(day.activity) ? day.activity : null;
    memory.affinity_daily = { date: day.date, touch: boundedInt(day.touch, 3), activity,
      activity_points: activity ? boundedInt(day.activity_points, 2) : 0, story: boundedInt(day.story, 9) };
  }
  if (record(value.stories) || Object.keys(memory).length) {
    memory.stories = Object.fromEntries(STORIES.filter(key => [0, 1, 2].includes(value.stories?.[key]))
      .map(key => [key, value.stories[key]]));
  }
  return Object.keys(memory).length ? memory : null;
}

export function redactCredentials(value) {
  if (Array.isArray(value)) return value.map(redactCredentials);
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !privateKey.test(key.replace(/[-_]/g, '')) && !['__proto__', 'constructor', 'prototype'].includes(key))
    .map(([key, item]) => [key, redactCredentials(item)]));
}

export function validateRestorableLibrary(library) {
  const watchLists = WATCH_STATES;
  const validRows = rows => Array.isArray(rows) && rows.every(row =>
    record(row) && (typeof row.id === 'number' || typeof row.id === 'string') && String(row.id).length > 0);
  if (!record(library) || !validRows(library.watching) ||
      watchLists.some(key => library[key] != null && !validRows(library[key])) ||
      (library.weekday != null && (!record(library.weekday) ||
        Object.entries(library.weekday).some(([day, rows]) => !/^[1-7]$/.test(day) || !validRows(rows)))) ||
      watchLists.some(key => (library[key] || []).some(row => row.schedule_adjustments != null &&
        (!Array.isArray(row.schedule_adjustments) || row.schedule_adjustments.some(change => !record(change)))))) {
    throw new Error('番库结构无效，无法导入');
  }
  const entries = watchLists.flatMap(key => library[key] || []);
  const ids = new Set(entries.map(entry => String(entry.id)));
  const aliases = new Set();
  const roundIds = new Set();
  const whole = value => Number.isSafeInteger(value) && value >= 0;
  for (const entry of entries) {
    const name = String(entry.name_cn || entry.name || entry.id).slice(0, 100);
    if (!validEpisodeExtras(entry)) throw new Error('「' + name + '」的跳集记录无效');
    if (entry.history_ids != null && (!Array.isArray(entry.history_ids) ||
      entry.history_ids.some(id => {
        if (typeof id !== 'string' || !/^local-[\w-]{1,80}$/.test(id) || ids.has(id) || aliases.has(id)) return true;
        aliases.add(id);
        return false;
      }))) throw new Error('「' + name + '」的观看历史关联不正确');
    if (entry.rewatches != null && (!Array.isArray(entry.rewatches) ||
      entry.rewatches.some(round => {
        if (!record(round) || typeof round.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(round.id) ||
            roundIds.has(round.id) || typeof round.started_at !== 'string' || !Number.isFinite(Date.parse(round.started_at)) ||
            !whole(round.ep_status) || (round.eps != null && (!whole(round.eps) || round.eps < 1 || round.ep_status > round.eps)) ||
            (round.finished_at != null && !validDate(round.finished_at)) || !validEpisodeExtras(round)) return true;
        roundIds.add(round.id);
        return false;
      }) || entry.rewatches.filter(round => !round.finished_at).length > 1))
      throw new Error('「' + name + '」的重看轮次格式无效');
  }
  if ((library.removed || []).some(entry => !WATCH_STATES.slice(0, -1).includes(entry.removed_from)))
    throw new Error('已移除条目缺少原本的番库状态');
  if ((library.void_history != null && (!Array.isArray(library.void_history) || !library.void_history.every(historyIdValid))) ||
      (library.history_retractions != null && (!Array.isArray(library.history_retractions) ||
        historyRetractions(library).length !== library.history_retractions.length ||
        new Set(library.history_retractions.map(row => row.id)).size !== library.history_retractions.length)))
    throw new Error('观看历史撤销关联无效');
}

export function parseMigration(input) {
  if (!record(input) || input.format !== FORMAT || input.schema !== 1) throw new Error('这不是 TIARA 数据迁移文件');
  const { library, settings = {}, history = {} } = input;
  validateRestorableLibrary(library);
  if (!record(settings) || !record(history) || Object.entries(history).some(([name, rows]) =>
    !HISTORY.test(name) || !Array.isArray(rows) || rows.some(row => !record(row)))) {
    throw new Error('设置或观看历史格式无效，无法导入');
  }
  const companion = companionMemory(input.companion);
  const exportedLibrary = redactCredentials(library);
  delete exportedLibrary.history_commit;
  const desktop = desktopProfile(input.desktop);
  const exportedSettings = Object.fromEntries(SETTINGS.filter(key => Object.hasOwn(settings, key) &&
    ['string', 'number', 'boolean'].includes(typeof settings[key])).map(key => [key, settings[key]]));
  if (desktop) delete exportedSettings.pet_scale;
  return {
    format: FORMAT, schema: 1, library: exportedLibrary,
    settings: exportedSettings,
    history: redactCredentials(history),
    ...(companion ? { companion } : {}),
    ...(desktop ? { desktop } : {}),
    ...(typeof input.created_at === 'string' && Number.isFinite(Date.parse(input.created_at)) ?
      { created_at: new Date(input.created_at).toISOString() } : {}),
  };
}

export function migrationSummary({ library, history, companion }) {
  return { watching: library.watching.length, paused: library.paused?.length || 0, planned: library.planned?.length || 0,
    archived: library.archived?.length || 0, history: Object.values(history).reduce((n, rows) => n + rows.length, 0),
    ...(library.removed?.length ? { removed: library.removed.length } : {}),
    ...(companion ? { companion: { first_seen: companion.first_seen, affinity: companion.affinity,
      stories: Object.keys(companion.stories).length } } : {}),
  };
}

export function migrationChanges(current, incoming) {
  function entries(data) {
    const list = new Map();
    for (const state of WATCH_STATES) {
      const items = data.library[state];
      if (!Array.isArray(items)) continue;
      for (const item of items) if (item?.id != null) list.set(String(item.id), { state, item });
    }
    return list;
  }
  const before = entries(current), after = entries(incoming);
  const totals = { added: 0, replaced: 0, removed: 0, kept: 0 };
  const examples = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(id), next = after.get(id);
    const change = !old ? 'added' : !next ? 'removed' : revisionOf(old) === revisionOf(next) ? 'kept' : 'replaced';
    totals[change] += 1;
    const item = next?.item || old.item;
    if (change !== 'kept' && examples.length < 20) examples.push({ change, title: item.name_cn || item.name || id,
      before: old && { state: old.state, seen: old.item.ep_status },
      after: next && { state: next.state, seen: next.item.ep_status } });
  }
  return { totals, examples, companion: incoming.companion ? 'replaced' : 'kept' };
}

async function readOptional(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

async function listOptional(dir) {
  try { return await fs.readdir(dir); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return []; }
}

export async function migrationState(root) {
  const dir = path.join(root, 'data');
  const names = ['library.json', 'settings.json', COMPANION_IMPORT, ...(await listOptional(dir)).filter(name => HISTORY.test(name)),
    ...(await listOptional(path.join(dir, 'undo'))).map(name => 'undo/' + name).filter(name => UNDO.test(name))].sort();
  const files = Object.fromEntries(await Promise.all(names.map(async name => [name, await readOptional(fileAt(root, name))])));
  const history = Object.fromEntries(names.filter(name => HISTORY.test(name)).map(name => [
    name, (files[name] || '').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line.replace(/^\uFEFF/, ''))),
  ]));
  const parse = name => JSON.parse((files[name] || '{}').replace(/^\uFEFF/, ''));
  // The desktop owns state.json. An unclaimed import represents the current memory until the desktop applies it.
  const state = JSON.parse(((await readOptional(fileAt(root, 'state.json'))) || '{}').replace(/^\uFEFF/, '')) || {};
  const pending = parse(COMPANION_IMPORT) || {};
  const unclaimed = pending.id && pending.id !== state.companion_import ? pending : {};
  const live = { first_seen: state.vars?.first_seen, affinity: state.vars?.affinity,
    stories: state.stories, affinity_daily: state.affinity_daily, first_duty: state.first_duty, new_year_letter: state.new_year_letter };
  const settings = parse('settings.json');
  const data = parseMigration({ format: FORMAT, schema: 1, library: parse('library.json'), settings, history,
    companion: unclaimed.companion || live });
  const desktop = desktopProfile({ notes: state.desktop_notes || [], favorites: state.favorite_lines || [], appearance: {
    shell: state.desktop_shell, theme: state.bubble_theme, size: state.bubble_size,
    scale: scaleValue(settings.pet_scale) ?? Number(state.pet_scale),
    bubble_time: state.bubble_time, reduce_motion: state.reduce_motion,
    idle_chatter: state.idle_chatter, hourly_chatter: state.hourly_chatter,
  }, ...unclaimed.desktop });
  return { data, desktop, pending: unclaimed, files,
    revision: revisionOf({ files, companion: data.companion, desktop }) };
}

export const migrationSourceRevision = revisionOf;

export function migrationExport(current, scope) {
  if (scope == null) return current.data;
  const fields = new Set(scope.split(','));
  return parseMigration({ ...current.data, created_at: new Date().toISOString(),
    desktop: Object.fromEntries(Object.entries(current.desktop).filter(([key]) => fields.has(key))) });
}

export async function desktopRestorePlan(root, current, desktop) {
  if (!desktop) return null;
  const plan = {};
  if (desktop.notes) {
    const summarizeNotes = notes => {
      const scheduled = notes.filter(note => note.DueAt).length;
      return { total: notes.length, done: notes.filter(note => note.Done).length, ...(scheduled ? { scheduled } : {}) };
    };
    plan.notes = { current: summarizeNotes(current.desktop.notes), incoming: summarizeNotes(desktop.notes) };
  }
  if (desktop.favorites) {
    plan.favorites = { current: current.desktop.favorites.length, incoming: desktop.favorites.length };
  }
  if (desktop.appearance) {
    const requested = desktop.appearance.shell;
    const dir = path.join(root, 'shell');
    const present = requested === 'master' || ((await listOptional(dir)).includes(requested) &&
      (await fs.stat(path.join(dir, requested, 'surface0.png')).catch(() => null))?.isFile());
    plan.appearance = { current: current.desktop.appearance, incoming: desktop.appearance,
      effective_shell: present ? requested : 'master', missing_shell: !present };
  }
  return plan;
}

async function writeFiles(root, files) {
  // Publish the library last, so desktop reminders keep rejecting stale snapshots during recovery.
  const entries = Object.entries(files).sort(([a], [b]) => Number(a === 'library.json') - Number(b === 'library.json'));
  for (const [name, text] of entries) {
    const dest = fileAt(root, name);
    if (text == null) await fs.rm(dest, { force: true });
    else await writeFileAtomic(dest, text, { encoding: 'utf8' });
  }
}

export async function recoverMigration(root) {
  const file = fileAt(root, JOURNAL);
  const raw = await readOptional(file);
  if (raw == null) return;
  const { files } = JSON.parse(raw);
  if (!record(files) || Object.entries(files).some(([name, value]) =>
    !targetName(name) || (value !== null && typeof value !== 'string'))) throw new Error('迁移恢复日志无效');
  await writeFiles(root, files);
  await fs.rm(file);
}

export async function importMigration(root, current, data, plan) {
  const backup = 'migration-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(4).toString('hex') + '.json';
  const original = { ...current.files };
  const next = Object.fromEntries(Object.keys(original).map(name => [name, null]));
  const desktop = { ...current.pending.desktop, ...data.desktop };
  if (plan?.appearance) desktop.appearance = { ...desktop.appearance, shell: plan.appearance.effective_shell };
  const companion = data.companion || current.pending.companion;
  next[COMPANION_IMPORT] = companion || Object.keys(desktop).length
    ? JSON.stringify({ id: randomBytes(16).toString('hex'), companion,
      ...(Object.keys(desktop).length ? { desktop } : {}) }) + '\n'
    : original[COMPANION_IMPORT];
  const library = structuredClone(data.library);
  updateReminderEpochs(current.data.library, library, true);
  next['library.json'] = JSON.stringify(library, null, 2) + '\n';
  const settings = { ...data.settings };
  if (data.desktop || desktop.appearance) settings.pet_scale = desktop.appearance?.scale ?? current.desktop.appearance.scale;
  next['settings.json'] = JSON.stringify(settings, null, 2) + '\n';
  for (const [name, rows] of Object.entries(data.history)) {
    if (!Object.hasOwn(original, name)) original[name] = null;
    next[name] = rows.map(row => JSON.stringify(row) + '\n').join('');
  }
  const journal = fileAt(root, JOURNAL);
  // Reusable export of the destination before replacement, separate from the crash journal.
  await writeJsonAtomic(fileAt(root, 'backups/' + backup), migrationExport(current, 'notes,appearance,favorites'));
  await writeJsonAtomic(journal, { files: original });
  try {
    await writeFiles(root, next);
    await fs.rm(journal);
  } catch (error) {
    await recoverMigration(root);
    throw error;
  }
  return backup;
}
