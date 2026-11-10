import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileAtomic, writeJsonAtomic } from './atomic.mjs';

export const MIGRATION_LIMIT = 16 * 1024 * 1024;
const FORMAT = 'tiara-migration';
const HISTORY = /^history(?:-\d{4})?\.jsonl$/;
const UNDO = /^undo\/step-[\w.-]+\.json$/;
const JOURNAL = '.migration-pending.json';
const COMPANION_IMPORT = 'companion-import.json';
const STORIES = ['first-page', 'after-credits', 'next-season'];
const SETTINGS = ['clock', 'pet_scale', 'power_save', 'birthday', 'quiet_start', 'quiet_end'];
const privateKey = /^(?:bgm|bangumi|credentials?|(?:access|refresh|bgm|bangumi)?token|password|passwd|(?:client)?secret|proxy(?:url|password|user)?|authorization|apikey|cookie)$/i;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fileAt = (root, name) => path.join(root, 'data', name);
const revisionOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const targetName = name => ['library.json', 'settings.json', COMPANION_IMPORT].includes(name) || HISTORY.test(name) || UNDO.test(name);

function companionMemory(value) {
  if (!record(value)) return null;
  const memory = {};
  const first = value.first_seen;
  if (typeof first === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(first) &&
      Number.isFinite(Date.parse(first)) && new Date(first).toISOString().slice(0, 10) === first) memory.first_seen = first;
  const affinity = typeof value.affinity === 'string' && /^\d{1,3}$/.test(value.affinity) ? Number(value.affinity) : value.affinity;
  if (Number.isInteger(affinity) && affinity >= 0 && affinity <= 100) memory.affinity = affinity;
  if (record(value.stories) || Object.keys(memory).length) {
    memory.stories = Object.fromEntries(STORIES.filter(key => [0, 1, 2].includes(value.stories?.[key]))
      .map(key => [key, value.stories[key]]));
  }
  return Object.keys(memory).length ? memory : null;
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !privateKey.test(key.replace(/[-_]/g, '')) && !['__proto__', 'constructor', 'prototype'].includes(key))
    .map(([key, item]) => [key, redact(item)]));
}

export function parseMigration(input) {
  if (!record(input) || input.format !== FORMAT || input.schema !== 1) throw new Error('这不是 TIARA 数据迁移文件');
  const { library, settings = {}, history = {} } = input;
  const watchLists = ['watching', 'paused', 'archived'];
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
  if (!record(settings) || !record(history) || Object.entries(history).some(([name, rows]) =>
    !HISTORY.test(name) || !Array.isArray(rows) || rows.some(row => !record(row)))) {
    throw new Error('设置或观看历史格式无效，无法导入');
  }
  const companion = companionMemory(input.companion);
  return {
    format: FORMAT, schema: 1, library: redact(library),
    settings: Object.fromEntries(SETTINGS.filter(key => Object.hasOwn(settings, key) &&
      ['string', 'number', 'boolean'].includes(typeof settings[key])).map(key => [key, settings[key]])),
    history: redact(history),
    ...(companion ? { companion } : {}),
  };
}

export function migrationSummary({ library, history, companion }) {
  return { watching: library.watching.length, paused: library.paused?.length || 0,
    archived: library.archived?.length || 0, history: Object.values(history).reduce((n, rows) => n + rows.length, 0),
    ...(companion ? { companion: { first_seen: companion.first_seen, affinity: companion.affinity,
      stories: Object.keys(companion.stories).length } } : {}),
  };
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
  const companion = pending.id && pending.id !== state.companion_import ? pending.companion :
    { first_seen: state.vars?.first_seen, affinity: state.vars?.affinity, stories: state.stories };
  const data = parseMigration({ format: FORMAT, schema: 1, library: parse('library.json'), settings: parse('settings.json'), history, companion });
  return { data, files, revision: revisionOf({ files, companion: data.companion }) };
}

export const migrationSourceRevision = revisionOf;

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

export async function importMigration(root, current, data) {
  const backup = 'migration-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(4).toString('hex') + '.json';
  const original = { ...current.files };
  const next = Object.fromEntries(Object.keys(original).map(name => [name, null]));
  next[COMPANION_IMPORT] = data.companion
    ? JSON.stringify({ id: randomBytes(16).toString('hex'), companion: data.companion }) + '\n'
    : original[COMPANION_IMPORT];
  next['library.json'] = JSON.stringify(data.library, null, 2) + '\n';
  next['settings.json'] = JSON.stringify(data.settings, null, 2) + '\n';
  for (const [name, rows] of Object.entries(data.history)) {
    if (!Object.hasOwn(original, name)) original[name] = null;
    next[name] = rows.map(row => JSON.stringify(row) + '\n').join('');
  }
  const journal = fileAt(root, JOURNAL);
  // Reusable export of the destination before replacement, separate from the crash journal.
  await writeJsonAtomic(fileAt(root, 'backups/' + backup), current.data);
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
