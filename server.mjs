#!/usr/bin/env node
/**
 * server.mjs — 伪春菜本地预览器 / 数据服务（零依赖，纯 Node）
 *
 *   node server.mjs              # http://127.0.0.1:7788
 *   node server.mjs --port 9000
 *
 * 它做四件事：
 *   1. 把 panel/ 当静态站点发出去（浏览器版桌宠 + 番组表）
 *   2. 把 shell/master/ 的立绘发出去（/sprite/*.png）
 *   3. 用 lib/today.mjs 从 data/library.json 现算今日番组（GET /api/state）
 *   4. 记一笔进度：+1 话 / 回退一话（POST /api/progress），写完顺手重算 today.txt
 *
 * 不联网。只监听 127.0.0.1。写库是原子的（临时文件 + rename），
 * 并发点两次 +1 也不会写坏 JSON。
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildToday, timeline, summarize, cstParts, reminders, DEFAULT_SETTINGS, toMin, expectedEpisode, expectedEpisodes, scheduledWeek, displayClock } from './lib/today.mjs';
import { fetchSeason, fetchSubject, searchAnime, mergeSeason, seasonOf, seasonRange, weekdayFromInfobox, httpGet } from './lib/bgm.mjs';
import { reviewBgmLibrary } from './lib/bgm-review.mjs';
import { libraryMatches, matchesSearch, titleKey } from './lib/watch-matches.mjs';
import { animeRelations, orderedRelations, readRelationCache, relationId, setWatchOrder } from './lib/watch-order.mjs';
import { organizeLibrary, planBinding, watchHistoryOwners } from './lib/library-organize.mjs';
import { changeRewatch, firstWatchCompleted } from './lib/watch-rewatch.mjs';
import { historyIdValid, historyRetractions, retraceHistory } from './lib/history-retract.mjs';
import { episodeCoverage, episodeDiff, quickEpisodeDiff, storeEpisodeDiff, validEpisodeList } from './lib/watch-episodes.mjs';
import { readEpisodeCatalog, refreshEpisodeCatalog } from './lib/episode-catalog.mjs';
import { broadcastDate, broadcastStatus, readBroadcastMeta, saveBroadcastMeta } from './lib/broadcast-status.mjs';
import { watchHistoryDelta, watchWeekStart, watchWeekReport } from './lib/watch-report.mjs';
import { commitProgress, progressJournal, recoverProgress } from './lib/progress-commit.mjs';
import { readSeasonCache, writeSeasonCache, listCachedSeasons, CATALOG_DIRECTORY, FIRST_CATALOG_SEASON, currentSeason, seasonRefreshState, shiftSeason } from './lib/season-cache.mjs';
import { lookupYuc, yucReference } from './lib/yuc-source.mjs';
import { coverIdOf, coverCachePath, coverMediaType, isAllowedCoverUrl, downloadCover, pickCoverUrl,
  COVER_MAX_AGE, COVER_MAX_BYTES } from './lib/cover.mjs';
import { isLocalOrigin, checkWriteOrigin, checkBodySize, parseJsonBody } from './lib/http-util.mjs';
import { buildIcs, timeToMinutes } from './lib/ics.mjs';
import { personaInfo, normalizeNickname, addressOf } from './lib/persona.mjs';
import { readJsonFile, writeFileAtomic, writeJsonAtomic } from './lib/atomic.mjs';
import { BACKUP_KEEP, automaticUndoBase, readLibrary, writeLibrary, listBackups, readBackup, peekUndo, undoDepth } from './lib/library.mjs';
import { parseClock } from './lib/time.mjs';
import { APP_ID, VERSION } from './lib/version.mjs';
import { withLibraryLock } from './lib/library-lock.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { panelId, panelPortFile, panelControlFile, findPanel } from './lib/panel-instance.mjs';
import { actualSchedule } from './lib/today.mjs';
import { editWatchDetail, editWatchPreferences, watchDetail, watchUrl } from './lib/watch-detail.mjs';
import { broadcastSuggestions, lookupBroadcast } from './lib/broadcast-lookup.mjs';
import { nextScheduledUpdate, nextWeeklyUpdate, parseWatchSlot, quietAt, reminderLead, reminderOverride, reminderPreview, reminderTiming, REMINDER_LEADS, scheduleRow, setWatchSlot, personalReminder, catchupReminders } from './lib/watch-schedule.mjs';
import { remindStamp, reminderSnoozeKey, reminderSnoozeStates, reminderSnoozes } from './lib/reminder-snooze.mjs';
import { applyWatchStart, remainingEpisodes, watchFloor, WATCH_STARTS } from './lib/watch-start.mjs';
import { findWatchEntry, inactiveWatchIds, isWatchFinished, isCatchup, moveWatchEntry, WATCH_STATES } from './lib/watch-lifecycle.mjs';
import { BGM_REL, readBgmConfig as readStoredBgmConfig, effectiveBgmConfig, bgmConfigView, validateBgmProxy, fetchSyncData } from './lib/bgm-sync.mjs';
import { applyCsvImport, CSV_BYTES, previewCsvImport } from './lib/library-csv.mjs';
import { publicRelease, RELEASE_PAGE, sspSnapshotWindow } from './lib/release-info.mjs';
import { FEED_DAYS, refreshCalendarFeed } from './lib/calendar-feed.mjs';
import { findRemoteChapter, identifyWriteback, readRemoteChapter, writeRemoteChapter, writebackError, writebackWatched } from './lib/bgm-writeback.mjs';
import { desktopRestorePlan, importMigration, migrationChanges, migrationExport, MIGRATION_LIMIT, migrationSourceRevision, migrationState, migrationSummary, parseMigration, recoverMigration, validateRestorableLibrary } from './lib/migration.mjs';
import { launchDiagnostics } from './lib/launch-diagnostics.mjs';

const DEFAULT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const STARTED_AT = new Date().toISOString();

const argv = process.argv.slice(2);
let PORT = 7788;
/** 显式给了 --port 就「按你说的办」：跑测试、起第二份副本都不会被单实例检查拦下 */
let PORT_EXPLICIT = false;
/** --root 指向别的目录：单测把服务端挂到临时 fixture 上，绝不碰真实 data/ */
let ROOT = DEFAULT_ROOT;
/** --no-portfile：临时实例别改写 cache/panel_port.txt（见下方用法） */
let NO_PORTFILE = false;
const MANAGED = argv.includes('--managed');
for (let i = 0; i < argv.length; i++) {
  if ((argv[i] === '--port' || argv[i] === '-p') && argv[i + 1]) {
    PORT = Number(argv[++i]);
    PORT_EXPLICIT = true;
  }
  if (argv[i] === '--root' && argv[i + 1]) {
    ROOT = path.resolve(argv[++i]);
    // 注意：不要顺手置 PORT_EXPLICIT —— 单测里「第二个实例应当认出第一个」正是靠
    // 探测 ROOT/cache/panel_port.txt 来实现的；只有 --port 才算「按你说的办」。
  }
  if (argv[i] === '--force-new' || argv[i] === '--allow-multi') PORT_EXPLICIT = true;
  // 临时实例（体检脚本、演示、单元测试）不该改写 cache/panel_port.txt：
  // 那个文件是「用户那只服务在哪个端口」的唯一指针，被 7860 覆盖之后
  // 桌宠右键「打开网页番组表」就会去找一个已经关掉的端口。
  if (argv[i] === '--no-portfile') NO_PORTFILE = true;
}
const INSTANCE = panelId(ROOT);
const CONTROL_TOKEN = randomBytes(32).toString('hex');

/** 表情名 → shell 文件。生成脚本会维护这张表。 */
const FACES = {
  normal: 'surface0.png',
  happy: 'surface1.png',
  sad: 'surface2.png',
  surprise: 'surface3.png',
  sleepy: 'surface4.png',
  think: 'surface5.png',
  bashful: 'surface6.png',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function readJSON(rel) {
  return JSON.parse(await fs.readFile(path.join(ROOT, rel), 'utf8'));
}

// ---------------- 用户偏好（data/settings.json） ----------------
const SETTINGS_REL = 'data/settings.json';

async function readSettings({ strict = false } = {}) {
  try {
    const raw = await fs.readFile(path.join(ROOT, SETTINGS_REL), 'utf8');
    const s = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('invalid settings');
    const scale = Number(s.pet_scale);
    return {
      ...s,
      clock: s.clock === '24h' || s.clock === '30h' ? s.clock : DEFAULT_SETTINGS.clock,
      pet_scale: Number.isFinite(scale) && scale >= 0.5 && scale <= 2 ? scale : DEFAULT_SETTINGS.pet_scale,
    };
  } catch (error) {
    if (strict && error.code !== 'ENOENT') throw new Error('无法读取现有设置，未保存变更。请检查 data/settings.json。');
    return { ...DEFAULT_SETTINGS };
  }
}

async function writeSettings(patch) {
  const cur = await readSettings({ strict: true });
  const scale = Number(patch.pet_scale);
  const next = {
    ...cur,
    clock: patch.clock === '24h' || patch.clock === '30h' ? patch.clock : cur.clock,
    pet_scale: Number.isFinite(scale) && scale >= 0.5 && scale <= 2 ? scale : cur.pet_scale,
  };
  if (patch.quiet_start !== undefined) {
    next.quiet_start = patch.quiet_start;
    next.quiet_end = patch.quiet_end;
  }
  for (const key of ['quiet_work', 'quiet_weekend']) {
    if (patch[key + '_start'] === undefined) continue;
    next[key + '_start'] = patch[key + '_start'];
    next[key + '_end'] = patch[key + '_end'];
  }
  if (patch.reminder_lead !== undefined) next.reminder_lead = patch.reminder_lead;
  if (patch.catchup_goal !== undefined) next.catchup_goal = patch.catchup_goal;
  if (patch.power_save !== undefined) next.power_save = patch.power_save;
  await fs.mkdir(path.dirname(path.join(ROOT, SETTINGS_REL)), { recursive: true });
  await writeFileAtomic(path.join(ROOT, SETTINGS_REL), JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8' });
  return next;
}

async function exists(rel) {
  try {
    await fs.access(path.join(ROOT, rel));
    return true;
  } catch {
    return false;
  }
}

async function mtime(rel) {
  try {
    return (await fs.stat(path.join(ROOT, rel))).mtimeMs;
  } catch {
    return 0;
  }
}

/** 只发 base 内的文件，挡掉 ../ 与兄弟目录前缀（panel 和 panelX 是两回事） */
function safeJoin(base, urlPath) {
  let clean;
  try {
    clean = decodeURIComponent(String(urlPath).split('?')[0]).replace(/\\/g, '/');
  } catch {
    return null; // 非法 %zz 编码
  }
  const baseNorm = path.normalize(base);
  const target = path.normalize(path.join(baseNorm, clean));
  if (target !== baseNorm && !target.startsWith(baseNorm + path.sep)) return null;
  return target;
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  if (!isLocalOrigin(origin)) return {};
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

async function serveFile(res, absPath, cacheControl = 'no-store') {
  try {
    const buf = await fs.readFile(absPath);
    const mime = MIME[path.extname(absPath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': cacheControl,
      'Content-Length': buf.length,
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 ' + path.basename(absPath));
  }
}

/* ---------- 封面缓存 ---------- */

const coverInflight = new Map();
const searchCoverUrls = new Map();
let coverIndexCache = { at: 0, urls: new Map() };

/** id → 远程封面地址：扫一遍已缓存的季度表，10 分钟内不重复扫 */
async function findCoverUrl(id) {
  if (searchCoverUrls.has(id)) return searchCoverUrls.get(id);
  const now = Date.now();
  if (now - coverIndexCache.at > 10 * 60 * 1000) {
    const urls = new Map();
    const seasons = await listCachedSeasons(ROOT).catch(() => []);
    for (const q of seasons) {
      const c = await readSeasonCache(ROOT, q, 365 * 24 * 3600 * 1000).catch(() => null);
      for (const it of (c && c.items) || []) {
        if (it && it.image && !urls.has(String(it.id))) urls.set(String(it.id), it.image);
      }
    }
    coverIndexCache = { at: now, urls };
  }
  const direct = coverIndexCache.urls.get(String(id));
  if (direct) return pickCoverUrl([{ id, image: direct }], id);
  return null;
}

async function readCoverFile(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > COVER_MAX_BYTES) return null;
    const bytes = await fs.readFile(file);
    const mime = coverMediaType(bytes);
    return mime ? { bytes, mime } : null;
  } catch {
    return null;
  }
}

async function cachedCover(id) {
  return await readCoverFile(coverCachePath(ROOT, id))
    || await readCoverFile(path.join(ROOT, CATALOG_DIRECTORY, 'covers', id + '.jpg'));
}

async function refreshCover(id, lookupSubject = false, source = null) {
  const pending = coverInflight.get(id);
  if (pending) {
    const current = await pending.promise;
    const canLookUpSubject = lookupSubject && !pending.lookupSubject;
    const hasDifferentSource = source && source !== pending.source;
    if (current || (!canLookUpSubject && !hasDifferentSource)) return current;
    return refreshCover(id, lookupSubject, source);
  }
  const work = (async () => {
    const url = source || await findCoverUrl(id);
    if (!url && !lookupSubject) return null;
    const cfg = await readBgmConfig().catch(() => ({}));
    const signal = AbortSignal.timeout(12000);
    const fetchImage = source => httpGet(source, { proxy: cfg.proxy, timeoutMs: 9000, signal, redirect: 'manual' });
    let bytes = url && await downloadCover(url, fetchImage).catch(() => null);
    if (!bytes && lookupSubject) {
      const subject = await fetchSubject(id, { base: cfg.base, proxy: cfg.proxy, timeoutMs: 5000, retries: 0, signal, animationOnly: true });
      const candidate = pickCoverUrl([{ id, image: subject.image }], id);
      if (candidate && candidate !== url) bytes = await downloadCover(candidate, fetchImage);
    }
    const mime = coverMediaType(bytes);
    if (!mime) return null;
    await writeFileAtomic(coverCachePath(ROOT, id), bytes);
    return { bytes, mime };
  })().catch(error => {
    logLine('warn', '[cover] ' + id + ' 获取失败：' + (error.code || error.name || 'unknown'));
    return null;
  }).finally(() => coverInflight.delete(id));
  coverInflight.set(id, { promise: work, lookupSubject, source });
  return work;
}

/**
 * 后台把「这一屏会用到」的封面先抓下来（并发 4，失败不管）。
 * 不阻塞 /api/state，也不影响首屏——只是让用户滚到那儿时图已经在盘上了。
 */
const coverPrefetchQueue = [];
let coverPrefetchRunning = 0;
const COVER_PREFETCH_CONC = 4;
const COVER_PREFETCH_MAX = 240;

function queueCoverPrefetch(items) {
  for (const item of items) {
    const id = coverIdOf(item.id);
    const source = isAllowedCoverUrl(item.image) ? item.image : null;
    if (id && source && !coverPrefetchQueue.some(job => job.id === id) && coverPrefetchQueue.length < COVER_PREFETCH_MAX) {
      coverPrefetchQueue.push({ id, source });
    }
  }
  while (coverPrefetchRunning < COVER_PREFETCH_CONC && coverPrefetchQueue.length) {
    coverPrefetchRunning++;
    (async () => {
      try {
        while (coverPrefetchQueue.length) {
          const { id, source } = coverPrefetchQueue.shift();
          if (!await cachedCover(id)) await refreshCover(id, false, source);
        }
      } finally {
        coverPrefetchRunning--;
      }
    })();
  }
}

async function apiCover(req, res, idRaw) {
  const id = coverIdOf(idRaw);
  if (!id) return json(res, { error: 'bad id' }, 400, req);
  const params = new URL(req.url, 'http://localhost').searchParams;
  const q = params.get('q');
  let image = await cachedCover(id);
  if (!image && params.get('local') !== '1') {
    if (q === null) {
      image = await refreshCover(id);
    } else {
      const season = await readSeasonCache(ROOT, q);
      const source = pickCoverUrl(season?.items, id);
      if (source) image = await refreshCover(id, false, source);
    }
  }
  if (!image) return json(res, { error: 'cover unavailable' }, 404, req);
  res.writeHead(200, {
    'Content-Type': image.mime,
    'Content-Length': image.bytes.length,
    'Cache-Control': `public, max-age=${COVER_MAX_AGE}`,
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : image.bytes);
}

async function apiCoverRetry(req, res) {
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  if (!guardWrite(req, res)) return;
  const body = await readJsonBody(req, res);
  if (!body) return;
  const id = coverIdOf(body.id);
  if (!id || !findWatchEntry(await readLibrary(ROOT), id))
    return json(res, { error: '番库中没有可联网查询的条目' }, 404, req);
  const fresh = await refreshCover(id, true);
  if (fresh) return json(res, { ok: true, source: 'updated' }, 200, req);
  if (await cachedCover(id)) return json(res, { ok: true, source: 'cached' }, 200, req);
  return json(res, { error: '暂时取不到封面，请检查联网和代理设置后重试。' }, 503, req);
}

/**
 * 统一的 JSON 响应。
 *
 * 两条硬规则（都是踩过坑才加的）：
 *  1. 已经发过响应就直接返回。以前 readJsonBody 回了 400、调用方继续往下走又回一次，
 *     writeHead 抛 ERR_HTTP_HEADERS_SENT，而它发生在一个 async 回调里 —— 没人接住，
 *     整个服务端进程直接 exit 1。一个坏 JSON 就能把面板打死。
 *  2. 4xx/5xx 一律补 ok:false。前端判成功用的是 `j.ok === false || j.error`，
 *     以前错误体只有 {error}，于是「时刻写成 25:30」会提示「已写入」。
 */
function json(res, obj, code = 200, req = null) {
  if (res.headersSent || res.writableEnded) {
    logLine('warn', `响应已发出，忽略重复的 json(${code})`);
    return;
  }
  const payload = code >= 400 && obj && typeof obj === 'object' && !('ok' in obj) ? { ok: false, ...obj } : obj;
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...(req ? corsHeaders(req) : {}),
  });
  res.end(body);
}

// ---------------- /api/state ----------------
async function apiState(req, res) {
  let lib;
  try {
    lib = actualSchedule(await readLibrary(ROOT));
  } catch (e) {
    // 库坏了别只丢一句 JSON 解析错误：告诉用户还能从备份救回来
    return json(res, {
      ok: false,
      error: 'data/library.json 读不出来：' + String(e.message || e),
      hint: '面板底栏「恢复上一版」可以回滚；或看 GET /api/backups',
    }, 500, req);
  }
  // 以前这里还预读了一次 data/talks.json，读完从没用过（台词早就挪到 /api/say 了）。
  // talks.json 一旦被删/写坏，首屏就 500，还把绝对路径回显给浏览器。
  const now = new Date();
  const settings = await readSettings();
  const t = buildToday(lib, now, { clock: settings.clock });
  const tl = timeline(t.today, now);
  const active = lib.watching.filter(w => !isWatchFinished(w) && !isCatchup(w));
  const catchup = t.catchup;
  const finished = [...lib.watching, ...(lib.paused || [])].filter(isWatchFinished);
  const todayIds = new Set(t.today.filter(x => x.aired).map(x => String(x.id)));
  const expectedByEntry = expectedEpisodes(active, lib, now, todayIds);

  const faces = {};
  for (const [k, f] of Object.entries(FACES)) {
    faces[k] = (await exists(path.join('shell', 'master', f))) ? `/sprite/${f}` : null;
  }
  const talk = (await exists(path.join('shell', 'master', 'talk.png'))) ? '/sprite/talk.png' : null;

  // 封面：只带「本周排片 + 在追」用得到的那十几条，别把整季 166 张塞进首屏
  // （此前 /api/state 28.4 KB，其中 22 KB 是没人看的封面；面板本季页自己有 image 字段）
  const images = {};
  try {
    const need = new Set();
    for (const s of t.today) need.add(String(s.id));
    for (const [, list] of Object.entries(t.week || {})) {
      for (const s of list || []) need.add(String(s.id));
    }
    for (const w of lib.watching || []) need.add(String(w.id));
    const seasonNow = seasonOf(now);
    const cache = await readSeasonCache(ROOT, seasonNow);
    for (const it of (cache?.items || [])) {
      const id = String(it.id);
      if (it.image && need.has(id)) images[id] = it.image;
    }
  } catch {
    /* 缓存坏了就当没有封面，不影响主流程 */
  }
  // 这一屏用得到的封面，后台先抓；抓不到的等用户滚过去再试（面板走 /cover/<id>.jpg）
  queueCoverPrefetch(Object.entries(images).map(([id, image]) => ({ id, image })));

  json(
    res,
    {
      ok: true,
      ...(recoveryIssue ? { recovery: recoveryIssue } : {}),
      generated: new Date().toISOString(),
      date: t.date,
      weekday_cn: t.weekday_cn,
      weekday: t.weekday,
      today: t.today,
      side: t.side,
      behind: t.behindAll,
      behind_today: t.behind,
      catchup: t.catchup,
      reminders: reminders(t.today, now, 60).filter(row => !quietAt(settings, new Date(Date.parse(t.date + 'T00:00:00+08:00') + toMin(row.time_cst) * 60000))),
      timeline: { aired: tl.aired, upcoming: tl.upcoming, next: tl.next, last: tl.last },
      summary: summarize(t, lib),
      quote: lib.trivia?.quote_of_today ?? '',
      user: lib.user ?? {},
      // 她怎么称呼你（可改：面板「账号」里改，存 library.json 的 user.nickname_for_pet）
      nickname: addressOf(lib),
      persona: personaInfo(lib),
      // 在追列表带上「本周该看到第几话」，面板要靠它区分「剩 N 话」和「落后 N 话」
      watching: active.map(w => ({
        ...w,
        airing: watchAiring(w, w.start_date),
        expected_eps: expectedByEntry.get(w),
      })),
      // 待看队列：落后 ≥1 话的番（不问时刻、不催——只在这里安静列出来）
      pending: (() => {
        const list = [];
        for (const w of active) {
          const exp = expectedByEntry.get(w);
          const seen = Number(w.ep_status) || 0;
          const behind = remainingEpisodes(w, exp);
          if (typeof exp === 'number' && behind) {
            list.push({
              id: w.id,
              name: w.name_cn || w.name || String(w.id),
              behind,
              seen,
              expected: exp,
            });
          }
        }
        list.sort((a, b) => b.behind - a.behind);
        return { count: list.length, shows: list };
      })(),
      week: slimWeek(Object.fromEntries(scheduledWeek(lib, now).map(day => [day.weekday, day.rows]))),
      weekly: slimWeek(lib.weekday || {}),
      watching_count: active.length,
      catchup_list: catchup,
      catchup_reminders: catchupReminders(lib, now).map(slot => ({ ...slot,
        quiet: reminderTiming(slot.at, settings, reminderLead(settings, findWatchEntry(lib, slot.id)?.entry)).quiet })),
      catchup_week: await catchupWeek(lib, settings, now),
      paused: (lib.paused || []).filter(w => !isWatchFinished(w)),
      planned: lib.planned ?? [],
      dropped: lib.dropped ?? [],
      removed: lib.removed ?? [],
      finished,
      archived: lib.archived ?? [],
      faces,
      talk,
      clock: cstParts(now),
      settings,
      images,
      server: { app: APP_ID, version: VERSION, pid: process.pid, started: STARTED_AT, port: PORT },
    },
    200,
    req
  );
  queueUnscheduledBroadcastCheck();
}

// ---------------- POST /api/progress ----------------
async function readBody(req, limit = 64 * 1024) {
  return await new Promise((resolve, reject) => {
    let size = 0;
    let overflow = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        // 超限别直接 destroy（会把连接重置成 ECONNRESET，前端只看到 fetch failed），
        // 把剩下的读完扔掉，再回 413
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (overflow) {
        const e = new Error('body too large');
        e.code = 'ETOOLARGE';
        e.limit = limit;
        reject(e);
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/** 读 JSON body；失败时自己回响应并返回 null（413 / 400）。判定逻辑在 lib/http-util.mjs。 */
async function readJsonBody(req, res, limit) {
  let raw;
  try {
    raw = await readBody(req, limit);
  } catch (e) {
    if (e.code === 'ETOOLARGE') {
      json(res, { error: 'body too large', limit: e.limit }, 413, req);
      return null;
    }
    json(res, { error: 'bad request body' }, 400, req);
    return null;
  }
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    json(res, parsed.body, parsed.status, req);
    return null;
  }
  const size = checkBodySize(Buffer.byteLength(raw, 'utf8'), limit || 1024 * 1024);
  if (!size.ok) {
    json(res, size.body, size.status, req);
    return null;
  }
  return parsed.value;
}

/**
 * 写库串行化。library.json 是「读-改-写」，两请求并发时后写的会把先写的覆盖掉
 * （实测 10 次并发 +1 只落了 1 次），所以所有写接口都从这个队列里过。
 */
let writeChain = Promise.resolve();
let recoveryIssue = null;

function enterRecovery(error) {
  const history = error.code === 'EPROGRESSRECOVERY';
  recoveryIssue = { code: history ? 'progress-recovery' : 'migration-recovery', read_only: true,
    message: (history ? '观看记录恢复文件无法安全核对。' : '迁移恢复文件无法安全核对。') +
      '当前以只读方式运行。请保留原 data 文件夹，在独立安装目录从确认有效的完整迁移备份恢复。' };
  logLine('error', '后台进入只读恢复模式：' + (error.cause?.code || error.code || error.name));
}

function withWriteLock(fn) {
  const run = writeChain.then(async () => {
    if (recoveryIssue) throw Object.assign(new Error(recoveryIssue.message), { code: 'ERECOVERYREADONLY' });
    try { return await withLibraryLock(ROOT, fn); }
    catch (error) {
      if (error.code === 'EPROGRESSRECOVERY') enterRecovery(error);
      throw error;
    }
  });
  writeChain = run.then(() => {}, () => {});
  return run;
}

/** 写接口的门：浏览器跨站请求会带别人的 Origin，直接 403；本机页面/curl（无 Origin）放行 */
function guardWrite(req, res) {
  const bad = checkWriteOrigin(req.headers.origin, PORT);
  if (!bad) return true;
  json(res, bad.body, bad.status, req);
  return false;
}

/**
 * 记一笔进度历史（一行一个 JSON）。
 * 不轮转的话一天几十上百行、几年就是几万行 —— 统计和「诊断」都会变慢。
 * 超过 HISTORY_MAX_LINES 行时按年份归档到 data/history-YYYY.jsonl，主文件只留当年的。
 */
const HISTORY_REL = path.join('data', 'history.jsonl');
const HISTORY_MAX_LINES = 5000;

async function rotateHistory() {
  const abs = path.join(ROOT, HISTORY_REL);
  let text;
  try {
    text = await fs.readFile(abs, 'utf8');
  } catch {
    return;
  }
  const lines = text.split('\n').filter(Boolean);
  if (lines.length <= HISTORY_MAX_LINES) return;

  const year = String(cstParts().date || '').slice(0, 4) || String(new Date().getFullYear());
  const keep = [];
  const archive = [];
  for (const line of lines) {
    let y = '';
    try {
      y = String(JSON.parse(line).at || JSON.parse(line).date || '').slice(0, 4);
    } catch { /* 坏行算当年，别丢 */ }
    (y && y < year ? archive : keep).push(line);
  }
  if (!archive.length) return;   // 全是今年的行，没得归档

  const archName = path.join('data', `history-${year}.jsonl`);   // 归档文件以「切分年份」命名
  await fs.appendFile(path.join(ROOT, archName), archive.join('\n') + '\n', 'utf8');
  const tmp = abs + '.tmp';
  await fs.writeFile(tmp, keep.length ? keep.join('\n') + '\n' : '', 'utf8');
  await fs.rename(tmp, abs);
  logLine('info', `历史轮转：归档 ${archive.length} 行 → ${archName}，主文件留 ${keep.length} 行`);
}

async function appendHistory(rec) {
  try {
    await fs.appendFile(path.join(ROOT, HISTORY_REL), JSON.stringify(rec) + '\n', 'utf8');
    await rotateHistory().catch(() => {});
  } catch (e) {
    logLine('error', 'appendHistory: ' + e.message);
  }
}

/**
 * 写库 / 撤销栈的实现都搬到了 lib/library.mjs（纯磁盘逻辑，可以单测；
 * 也拦住了「某个路由绕过护栏直写 library.json」这类事）。这里只注入 root 与日志。
 */
const saveLibrary = (lib, opts = {}) => writeLibrary(ROOT, lib, { log: logLine, ...opts });
async function saveProgress(lib, record, source) {
  const saved = await commitProgress(ROOT, lib, record,
    () => saveLibrary(lib, { source, historyId: record.history_id }), logLine);
  // 轮转不是事务的一部分：只能在事务完成、恢复文件已清理后移动历史。
  if (!await progressJournal(ROOT).catch(() => true)) await rotateHistory().catch(() => {});
  return saved;
}
const undoDepthNow = () => undoDepth(ROOT);

/** POST /api/undo → 撤销最近一次写库；返回撤销前/后各自看了多少话，便于面板提示 */
async function apiUndo(req, res) {
  if (!guardWrite(req, res)) return;
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  const body = await readJsonBody(req, res);
  if (!body) return;
  return withWriteLock(async () => {
    const current = await librarySnapshot();
    if (body.expected_revision && current.revision !== body.expected_revision &&
        automaticUndoBase(current.lib) !== body.expected_revision) {
      return json(res, { error: '番组库已有其他修改，这次撤销未执行，请刷新后确认' }, 409, req);
    }
    let step;
    let lib;
    try {
      step = await peekUndo(ROOT);
      if (!step) return json(res, { error: '没有可撤销的操作' }, 409, req);
      lib = JSON.parse(step.text.replace(/^\uFEFF/, ''));
    } catch (e) {
      return json(res, { ok: false, error: '撤销快照坏了：' + e.message }, 500, req);
    }
    if (!Array.isArray(lib.watching)) return json(res, { ok: false, error: '快照里没有 watching' }, 500, req);
    const autoIds = new Set(current.lib.watching.filter(entry =>
      entry.auto_catchup === true && isCatchup(entry) && !entry.watch_mode_manual).map(entry => String(entry.id)));
    for (const entry of lib.watching) {
      if (!autoIds.has(String(entry.id)) || !needsUnscheduledBroadcastCheck(lib, entry)) continue;
      entry.watch_mode = 'catchup';
      entry.auto_catchup = true;
    }
    const voided = new Set(current.lib.void_history || []);
    if (step.historyId) voided.add(step.historyId);
    if (voided.size) lib.void_history = [...voided];
    await saveLibrary(lib, { pushUndo: false, source: 'undo' });
    await step.remove();
    await appendHistory({ ts: new Date().toISOString(), date: cstParts().date, undo: true, watching: lib.watching.length });
    const rebuilt = await rebuildToday();
    logLine('info', `撤销：回到 watching=${lib.watching.length} 份快照`);
    json(res, { ok: true, undone: true, watching: lib.watching.length, depth: await undoDepthNow(), ...rebuildInfo(rebuilt) }, 200, req);
  });
}


/**
 * 日志：以前所有诊断都走 console.*，而启动器是「最小化窗口」起的服务 —— 出问题时
 * rebuild 失败、预热失败全都看不见。现在同时写 cache/server.log（1 MB 轮转 3 份）。
 */
const LOG_DIR = path.join(ROOT, 'cache');
const LOG_PATH = path.join(LOG_DIR, 'server.log');
const LOG_MAX = 1024 * 1024;

async function rotateLog() {
  try {
    const st = await fs.stat(LOG_PATH);
    if (st.size < LOG_MAX) return;
    for (let i = 2; i >= 1; i--) {
      const from = LOG_PATH + '.' + i;
      const to = LOG_PATH + '.' + (i + 1);
      await fs.rename(from, to).catch(() => {});
    }
    await fs.rename(LOG_PATH, LOG_PATH + '.1').catch(() => {});
  } catch { /* 没有日志文件就没什么可转的 */ }
}

/** 日志时间戳：统一 CST(+08:00)。
 *  以前用 toISOString()（UTC），面板「诊断」里显示的时间比用户看到的晚 8 小时，
 *  排查「刚才那一下为什么没记上」时对不上。 */
function logStamp(date = new Date()) {
  const t = new Date(date.getTime() + 8 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}+08:00`;
}

function logLine(kind, msg) {
  const line = `${logStamp()} [${kind}] ${msg}`;
  // 前台跑的时候还能看见；后台跑也不丢
  (kind === 'error' ? console.error : console.log)(line);
  fs.mkdir(LOG_DIR, { recursive: true })
    .then(() => rotateLog())
    .then(() => fs.appendFile(LOG_PATH, line + '\n', 'utf8'))
    .catch(() => {});
}

function runTool(rel) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, 'tools', rel)], { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || stdout || err.message || '').trim().split('\n').slice(-3).join(' ⏎ ');
        logLine('error', `[rebuild] ${rel} failed: ${err.message}${detail ? ' :: ' + detail : ''}`);
      }
      resolve(!err);
    });
  });
}

/** 最近一次重建失败的原因（面板据此弹 toast，而不是默默不动） */
let LAST_REBUILD_ERROR = '';

async function doRebuildToday() {
  LAST_REBUILD_ERROR = '';
  const okToday = await runTool('build_today.mjs');
  if (!okToday) {
    LAST_REBUILD_ERROR = 'build_today 失败，今天的番表没更新（细节见 诊断 → 服务日志）';
    return false;
  }
  const okGhost = await runTool('build_ghost.mjs');
  if (!okGhost) LAST_REBUILD_ERROR = 'build_ghost 失败，SSP 人格没能更新（细节见 诊断 → 服务日志）';
  return okGhost;
}

/**
 * 重算产物：串行 + 拖尾合并。
 *
 * 两个改动：
 *  1. 从写锁里挪出来（以前 +1 的整个重建都在写锁内，一次点击 450ms、连点十次 4.2s，
 *     期间别人连读都得排队；现在只锁「读-改-写」，重建在锁外做）。
 *  2. 拖尾合并：正在重建时又来了新写入，不另起一轮，等这一轮结束再补一轮 ——
 *     保证最后落盘的数据一定是最新的，同时不会因为连点而堆出十个 build_today。
 */
let rebuilding = null;
let rebuildQueued = null;

function rebuildToday() {
  if (rebuilding) {
    if (!rebuildQueued) {
      rebuildQueued = rebuilding.then(
        () => { rebuildQueued = null; return rebuildToday(); },
        () => { rebuildQueued = null; return rebuildToday(); }
      );
    }
    return rebuildQueued;
  }
  rebuilding = doRebuildToday();
  return rebuilding.finally(() => { rebuilding = null; });
}

/** 拼进响应里的重建结果，省得每个接口重复写 */
function rebuildInfo(rebuilt) {
  return rebuilt ? { rebuilt: true } : { rebuilt: false, rebuild_error: LAST_REBUILD_ERROR || '重建失败' };
}

async function apiProgress(req, res) {
  if (!guardWrite(req, res)) return;
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  const body = await readJsonBody(req, res);
  if (!body) return;   // readJsonBody 已经回过 400/413，别再往下走

  const id = String(body.id ?? '');
  if (!id) return json(res, { ok: false, error: 'missing id' }, 400, req);

  // 数字必须真的是数字：以前 `delta:'abc'` 会被 Number() 变成 NaN，再被 `|| 0` 吞成 0，
  // 接口回 200 changed:false —— 调用方以为写成功了，其实什么都没发生。
  let wantSet = null;
  let wantDelta = 0;
  const explicit = body.episodes !== undefined;
  if (explicit) {
    if (body.set !== undefined || body.delta !== undefined || !validEpisodeList(body.episodes))
      return json(res, { error: '请提供 1–500 个互不重复的正片集数' }, 400, req);
  } else if (body.set !== undefined) {
    if (!Number.isFinite(Number(body.set))) return json(res, { ok: false, error: 'set 必须是数字' }, 400, req);
    wantSet = Number(body.set);
  } else {
    if (body.delta === undefined) return json(res, { ok: false, error: 'delta 或 set 必须给一个' }, 400, req);
    if (!Number.isFinite(Number(body.delta))) return json(res, { ok: false, error: 'delta 必须是数字' }, 400, req);
    wantDelta = Number(body.delta);
  }
  const today = cstParts().date;
  const date = body.watched_on ?? today;
  if (body.watched_on != null && (!validHistoryDate(date) || date > today ||
      (!explicit && (wantSet !== null || !Number.isSafeInteger(wantDelta) || wantDelta < 1))))
    return json(res, { error: '补记只接受今天或过去的有效日期，以及正整数集数' }, 400, req);

  const outcome = await withWriteLock(async () => {
    const lib = await readLibrary(ROOT);
    const w = (lib.watching || []).find((x) => String(x.id) === id);
    if (!w) return { code: 404, payload: { ok: false, error: 'not watching: ' + id } };
    if (body.reminder_event !== undefined) {
      const { pending } = await reminderEntries(lib, Math.floor(Date.now() / 1000));
      if (!pending.some(row => row.key === body.reminder_event && row.watch_id === id))
        return { code: 409, payload: { ok: false, error: '这条提醒已处理或变动，请刷新提醒中心' } };
    }
    if (body.expected_watch_revision !== undefined && watchDetail(lib, w).revision !== body.expected_watch_revision)
      return { code: 409, payload: { ok: false, error: '进度已经更新，请重新打开详情后补记' } };

    // eps 有可能是 0 / null（手动加的番、或 Bangumi 没给总集数）——
    // 这时不能把上限当 0 用，否则 +1 永远被夹回 0，用户看到的是「点了没反应」。
    const epsNum = Number(w.eps);
    const eps = Number.isFinite(epsNum) && epsNum > 0 ? Math.round(epsNum) : 0;
    const prev = Math.max(0, Math.round(Number(w.ep_status) || 0));
    const floor = watchFloor(w);
    const before = episodeCoverage(w);
    const changes = explicit ? episodeDiff(w, body.episodes) :
      wantSet === null && Array.isArray(w.episode_extras) ? quickEpisodeDiff(w, Math.round(wantDelta)) : null;
    if (changes?.error) return { code: 409, payload: { ok: false, error: changes.error } };
    let next = wantSet !== null ? wantSet : wantDelta > 0 ? Math.max(prev, floor) + wantDelta : prev + wantDelta;
    next = Math.max(0, Math.round(next));
    if (eps > 0) next = Math.min(eps, next);
    if (wantSet === null && wantDelta < 0 && next <= floor) next = 0;
    if (changes) next = changes.to;
    const watchedDelta = changes ? changes.delta : wantSet !== null ? Math.max(next, floor) - floor - before.count :
      Math.max(next, floor) - Math.max(prev, floor);
    if (w.manual_finished === true && watchedDelta > 0) return { code: 409, payload: { error: '请先取消已看完标记' } };
    if (!explicit && body.watched_on != null && watchedDelta !== wantDelta)
      return { code: 409, payload: { ok: false, error: '补记集数超过剩余集数，请重新确认' } };

    const wasFinished = isWatchFinished(w);
    const priorDate = w.last_watched;
    const changed = changes ? !!changes.delta : next !== prev || wantSet !== null && before.extras.length > 0;
    if (changes && changed) storeEpisodeDiff(w, changes);
    else if (changed) {
      w.ep_status = next;
      if (wantSet !== null) {
        delete w.episode_extras;
        w.progress_edited_at = new Date().toISOString();
      }
    }
    if (watchedDelta > 0 && wantSet === null && (!w.last_watched || date >= w.last_watched)) {
      w.last_watched = date;
      w.last_watched_at = new Date().toISOString();
    }

    // 结论没变就别写盘：连点两下 + 到上限、或 delta:0 的探活请求都不该留备份与历史
    if (!changed) {
      return { code: 200, payload: { ok: true, id, prev, ep_status: next, eps, watched_count: before.count,
        finished: isWatchFinished(w), changed: false, rebuilt: false } };
    }

    const historyId = randomBytes(16).toString('hex');
    const finished = isWatchFinished(w);
    if (!wasFinished && finished && wantSet === null) w.finished_at = date;
    if (wasFinished && !finished) delete w.finished_at;
    const saved = await saveProgress(lib, {
      history_id: historyId,
      ts: new Date().toISOString(),
      date,
      id,
      name: w.name_cn || w.name || id,
      from: prev,
      to: next,
      delta: watchedDelta,
      ...(changes ? { episodes_added: changes.episodes_added, episodes_removed: changes.episodes_removed } : {}),
      source: body.watched_on != null ? 'backfill' : wantSet !== null ? 'absolute' :
        ['desktop', 'panel'].includes(body.client) ? body.client : 'progress',
      ...(priorDate ? { prior_last_watched: priorDate } : {}),
      ...(isCatchup(w) ? { watch_mode: 'catchup' } : {}),
    }, 'progress');
    return { code: 200, payload: { ok: true, id, prev, ep_status: next, eps, watched_count: episodeCoverage(w).count,
      finished, became_finished: finished && !wasFinished, changed: true,
      history_id: historyId, revision: createHash('sha256').update(saved).digest('hex') } };
  });

  // 重建在锁外：见 rebuildToday() 的注释。返回码 200 时统一补 rebuilt 信息。
  if (outcome.code === 200 && outcome.payload.changed) {
    const rebuilt = await rebuildToday();
    outcome.payload = { ...outcome.payload, ...rebuildInfo(rebuilt) };
  }
  json(res, outcome.payload, outcome.code, req);
}

// ---------------- /api/watch ----------------
/**
 * 从已缓存的季度表里翻一条元数据（总集数、星期、原名）。
 * 加番时拿不到 eps 就是真 bug：/api/progress 会把「上限」当成 0，+1 永远被夹回去。
 */
async function lookupSeasonItem(id) {
  const want = String(id);
  const seasons = await listCachedSeasons(ROOT).catch(() => []);
  // 当前季优先，其次新的在前
  const cur = seasonOf(new Date());
  const ordered = [cur, ...seasons.filter((q) => q !== cur)];
  for (const q of ordered) {
    if (!seasons.includes(q) && q !== cur) continue;
    const c = await readSeasonCache(ROOT, q).catch(() => null);
    for (const it of (c && c.items) || []) {
      if (it && String(it.id) === want) return it;
    }
  }
  return null;
}

async function showBroadcastStatus(id, { config, meta, entry } = {}) {
  const today = cstParts().date;
  const fallback = { date: entry?.release_date || entry?.start_date, ...meta };
  if (!relationId(id)) return broadcastStatus({ meta: fallback, today, manualEnd: entry?.schedule_ended === true });
  let [saved, episodes] = await Promise.all([readBroadcastMeta(ROOT, id), readEpisodeCatalog(ROOT, id)]);
  const combine = value => ({ ...fallback, ...value, date: broadcastDate(value?.date) || fallback.date,
    broadcast_end: broadcastDate(value?.broadcast_end) || fallback.broadcast_end });
  let details = combine(saved);
  const assess = () => broadcastStatus({ meta: details, episodes, today, manualEnd: entry?.schedule_ended === true });
  if (config) {
    try {
      const subject = await fetchSubject(id, { base: config.base, proxy: config.proxy, timeoutMs: 5000, retries: 0, animationOnly: true });
      saved = await saveBroadcastMeta(ROOT, id, subject);
      details = combine(saved);
    } catch {}
    if (assess().state === 'unknown' && details.regular_total > 0) {
      try { episodes = await refreshEpisodeCatalog(ROOT, id, config); } catch {}
    }
  }
  return assess();
}

async function reviewBroadcastRows(entries, config, { cachedFirst = false } = {}) {
  const statuses = new Map();
  for (let i = 0; i < entries.length; i += 4) {
    await Promise.all(entries.slice(i, i + 4).map(async entry => {
      const id = String(entry.id);
      const meta = relationId(id) ? await lookupSeasonItem(id) : null;
      const options = { entry, meta: meta || undefined };
      const cached = cachedFirst ? await showBroadcastStatus(id, options) : null;
      statuses.set(id, cached && cached.state !== 'unknown' ? cached : await showBroadcastStatus(id, { ...options, config }));
    }));
  }
  return statuses;
}

function needsUnscheduledBroadcastCheck(lib, entry) {
  if (!relationId(String(entry.id)) || isCatchup(entry) || isWatchFinished(entry) ||
      entry.watch_mode_manual || entry.schedule_manual || entry.schedule_ended ||
      entry.schedule_adjustments?.some(change => Date.parse(change.at) >= Date.now())) return false;
  const slot = scheduleRow(lib, entry);
  return !nextWeeklyUpdate(slot?.day ?? Number(entry.air_weekday), slot ? slot.row.time_cst : entry.air_time_cst);
}

async function reconcileUnscheduledBroadcasts() {
  const lib = await readLibrary(ROOT);
  const entries = lib.watching.filter(entry => needsUnscheduledBroadcastCheck(lib, entry));
  if (!entries.length) return;
  const statuses = await reviewBroadcastRows(entries, await readBgmConfig(), { cachedFirst: true });
  if (![...statuses.values()].some(status => status.state === 'ended') || stopping) return;
  const changed = await withWriteLock(async () => {
    if (stopping) return false;
    const current = await readLibrary(ROOT);
    const ended = current.watching.filter(entry => statuses.get(String(entry.id))?.state === 'ended' &&
      needsUnscheduledBroadcastCheck(current, entry));
    if (!ended.length) return false;
    for (const entry of ended) {
      entry.watch_mode = 'catchup';
      entry.auto_catchup = true;
    }
    await saveLibrary(current, { source: 'watch:auto-catchup', pushUndo: false, automaticCatchup: true });
    return true;
  });
  if (changed) await rebuildToday();
}

let nextUnscheduledBroadcastCheck = 0;
function queueUnscheduledBroadcastCheck() {
  if (NO_PORTFILE || stopping || recoveryIssue || Date.now() < nextUnscheduledBroadcastCheck) return;
  nextUnscheduledBroadcastCheck = Date.now() + 24 * 60 * 60 * 1000;
  void reconcileUnscheduledBroadcasts().catch(error =>
    logLine('warn', '未排期条目完播检查失败：' + error.message));
}

async function apiBroadcastStatus(req, res, review = false) {
  if (req.method !== 'GET') return json(res, { error: 'use GET' }, 405, req);
  if (!guardWrite(req, res)) return;
  const params = new URL(req.url, 'http://localhost').searchParams;
  const config = params.get('refresh') === '1' ? await readBgmConfig() : undefined;
  if (!review) {
    const id = params.get('id');
    if (!relationId(id)) return json(res, { error: '没有可查询的 Bangumi 条目编号' }, 400, req);
    const meta = await lookupSeasonItem(id);
    const entry = findWatchEntry(await readLibrary(ROOT), id)?.entry;
    const status = await showBroadcastStatus(id, { config, meta: meta || undefined, entry });
    return json(res, { ok: true, status }, 200, req);
  }
  const offset = Number(params.get('offset') ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) return json(res, { error: '页码无效' }, 400, req);
  const lib = await readLibrary(ROOT);
  const entries = lib.watching.filter(w => !isCatchup(w) && !isWatchFinished(w) && w.watch_mode_manual !== true);
  const page = entries.slice(offset, offset + 12);
  const statuses = await reviewBroadcastRows(page, config);
  const rows = organizeLibrary(lib, { ids: page.map(w => String(w.id)), action: 'ended-catchup' }, false, statuses);
  return json(res, { ok: true, candidates: rows.changed || [], skipped: rows.skipped || [],
    next: offset + page.length < entries.length ? offset + page.length : null }, 200, req);
}

/** 把放送表里的番加进 / 移出「在追」：{ id, action: 'add' | 'remove', weekday?, name? } */
async function apiWatch(req, res) {
  if (!guardWrite(req, res)) return;
  if (req.method !== 'POST') return json(res, { ok: false, error: 'use POST' }, 405, req);
  const body = await readJsonBody(req, res);
  if (!body) return;
  const id = String(body.id ?? '');
  if (!id) return json(res, { ok: false, error: 'missing id' }, 400, req);
  const action = body.action === 'remove' ? 'remove' : 'add';

  const meta = action === 'add' ? await lookupSeasonItem(id) : null;
  let broadcast;
  if (action === 'add' && relationId(id)) {
    broadcast = await showBroadcastStatus(id, { meta: meta || undefined });
    if (broadcast.state === 'unknown' && !findWatchEntry(await readLibrary(ROOT), id))
      broadcast = await showBroadcastStatus(id, { meta: meta || undefined, config: await readBgmConfig() });
  }
  const outcome = await withWriteLock(async () => {
    const lib = await readLibrary(ROOT);
    lib.watching = lib.watching || [];
    const at = lib.watching.findIndex((x) => String(x.id) === id);

    if (action === 'remove') {
      if (at < 0) return { code: 404, payload: { ok: false, error: 'not watching: ' + id } };
      const gone = lib.watching[at];
      moveWatchEntry(lib, { state: 'watching', index: at, entry: gone }, 'remove');
      await saveLibrary(lib, { source: 'watch:remove' });
      return { code: 200, payload: { ok: true, action, id, removed: true, name_cn: gone.name_cn || gone.name || id }, write: true };
    }

    if (at >= 0) {
      return { code: 200, payload: { ok: true, action, id, already: true, changed: false } };
    }
    if (inactiveWatchIds(lib).has(id)) {
      return { code: 409, payload: { ok: false, error: '这部番已在番库，请从原状态恢复' } };
    }

    // 从星期表里把这条找出来，继承它的星期 / 时间 / 名字；再从季度缓存补 eps
    let src = null;
    let wd = null;
    for (const key of Object.keys(lib.weekday || {})) {
      const hit = (lib.weekday[key] || []).find((x) => String(x.id) === id);
      if (hit) { src = hit; wd = Number(key); break; }
    }
    const epsRaw = Number(meta?.eps ?? body.eps);
    const entry = {
      id: Number(id) || id,
      name: meta?.name || src?.name || body.name || id,
      name_cn: meta?.name_cn || src?.name_cn || body.name || id,
      eps: Number.isFinite(epsRaw) && epsRaw > 0 ? epsRaw : null,
      ep_status: 0,
      air_weekday: (meta && meta.weekday) || wd || Number(body.weekday) || null,
      air_time_cst: src?.time_cst || body.air_time_cst || null,
      rate: null,
      priority: '在追',
      last_watched: null,
      track_from: cstParts().date,
      ...(meta?.date || src?.start_date ? { start_date: meta?.date || src.start_date } : {}),
    };
    if (broadcast?.state === 'ended') entry.watch_mode = 'catchup';
    const latest = body.start_mode === 'latest' ? (isCatchup(entry) && entry.eps > 0
      ? entry.eps : expectedEpisode({ ...entry, track_from: null }, lib)) : null;
    if (!applyWatchStart(entry, body.start_mode, { seen: body.seen, latest })) {
      return { code: 400, payload: { error: '无法确定这个补番起点，可选择从头补或手填进度' } };
    }
    lib.watching.push(entry);
    await saveLibrary(lib, { source: 'watch:add' });
    return { code: 200, payload: { ok: true, action, id, name_cn: entry.name_cn, eps: entry.eps,
      air_weekday: entry.air_weekday, watch_mode: isCatchup(entry) ? 'catchup' : 'airing', changed: true }, write: true };
  });

  if (outcome.write) await rebuildToday();
  json(res, outcome.payload, outcome.code, req);
}

async function apiWatchDetail(req, res) {
  if (req.method === 'GET') {
    const id = new URL(req.url, 'http://localhost').searchParams.get('id');
    const lib = await readLibrary(ROOT);
    const found = findWatchEntry(lib, id);
    if (!found) return json(res, { error: '找不到这部番' }, 404, req);
    const detail = watchDetail(lib, found.entry, found.state);
    const original = relationId(detail.id) ? (await broadcastSuggestions(ROOT, [detail.id], { originalOnly: true })
      .catch(() => ({})))[detail.id] || null : null;
    const active = found.state === 'watching' && !detail.finished && !isCatchup(detail);
    let airing = active ? watchAiring(detail, found.entry.start_date) : null;
    if (!airing && active && !detail.schedule_ended && !found.entry.schedule_manual && /^\d+$/.test(detail.id)) {
      airing = (await broadcastSuggestions(ROOT, [detail.id]).catch(() => ({})))[detail.id] || null;
    }
    const now = new Date();
    const [settings, pet, state, snoozes] = await Promise.all([readSettings(), desktopPresence(), readReminderState(),
      reminderSnoozes(ROOT, lib, null, Math.floor(+now / 1000)).catch(() => ({ pending: [] }))]);
    const reminder = { ...reminderStatus(detail, scheduleRow(lib, found.entry), settings, found.entry.start_date),
      desktop_online: !!pet };
    const reminder_preview = previewWatchReminder(lib, detail, found.entry, settings, state, now, snoozes.pending, pet);
    return json(res, { ok: true, detail, airing, original, reminder, reminder_preview }, 200, req);
  }
  if (req.method !== 'POST') return json(res, { error: 'use GET or POST' }, 405, req);
  if (!guardWrite(req, res)) return;
  const body = await readJsonBody(req, res);
  if (!body) return;
  // Absolute progress is a correction/baseline, so it should not add watch history.
  let catalog;
  if (body.season_q != null || body.catalog_id != null) {
    if (body.id != null || typeof body.season_q !== 'string' || !/^\d{4}Q[1-4]$/.test(body.season_q))
      return json(res, { error: '季度无效' }, 400, req);
    const cache = await readSeasonCache(ROOT, body.season_q);
    catalog = cache?.items.find(item => String(item.id) === String(body.catalog_id));
    if (!catalog) return json(res, { error: '季度条目已有变化，请返回季度目录重新选择' }, 409, req);
  }
  const subject = String(body.subject_id ?? '');
  const autoMode = body.id == null && body.watch_mode === undefined && body.planned !== true && relationId(subject);
  let defaultCatchup = false;
  if (catalog) {
    defaultCatchup = (await showBroadcastStatus(String(catalog.id), { meta: catalog })).state === 'ended';
  } else if (autoMode) {
    const meta = await lookupSeasonItem(subject);
    let status = await showBroadcastStatus(subject, { meta: meta || undefined });
    if (status.state === 'unknown' && !body.broadcast_checked)
      status = await showBroadcastStatus(subject, { meta: meta || undefined, config: await readBgmConfig() });
    defaultCatchup = status.state === 'ended';
  }
  return updateWatch(req, res, body.id == null ? 'watch:manual' : 'watch:detail',
    lib => editWatchDetail(lib, body, { defaultCatchup, catalog }));
}

function reminderStatus(detail, slot, settings, since) {
  if (['dropped', 'removed'].includes(detail.state)) return { status: detail.state };
  if (detail.finished && detail.state !== 'archived') return { status: 'finished' };
  if (detail.state !== 'watching') return { status: detail.state };
  function when(planned_at, kind) {
    const timing = reminderTiming(planned_at, settings, reminderLead(settings, detail));
    return { status: timing.quiet ? 'quiet' : 'scheduled', at: timing.at, planned_at: timing.planned_at, kind };
  }
  if (isCatchup(detail)) {
    const slot = personalReminder(detail);
    if (detail.reminder_muted) return { status: 'muted', kind: 'catchup', planned_at: slot?.at };
    return slot ? when(slot.at, 'catchup') :
      { status: 'unscheduled', kind: 'catchup' };
  }
  if (detail.schedule_ended) return { status: 'ended' };
  const next = slot && nextScheduledUpdate(detail, new Date(), since);
  if (detail.reminder_muted) return { status: 'muted', planned_at: next || undefined };
  if (!next) return { status: 'unscheduled' };
  const status = when(next, 'airing');
  return { ...status, moved: (detail.schedule_adjustments || []).some(change => change.at === next) };
}

async function apiWatchLifecycle(req, res) {
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  if (!guardWrite(req, res)) return;
  const body = await readJsonBody(req, res);
  if (!body) return;
  if (typeof body.id !== 'string' || !body.id) return json(res, { error: '番剧编号无效' }, 400, req);
  if (body.action === 'remove' && body.preview === true) {
    const lib = await readLibrary(ROOT);
    const found = findWatchEntry(lib, body.id);
    if (!found || found.state === 'removed') return json(res, { error: '找不到可移除的番剧' }, 404, req);
    const owners = watchHistoryOwners(lib);
    const history = (await readHistoryRows(lib)).filter(row => owners.get(String(row.id)) === found.entry && Number.isFinite(row.delta));
    return json(res, { ok: true, detail: watchDetail(lib, found.entry, found.state), history_count: history.length }, 200, req);
  }
  return updateWatch(req, res, 'watch:lifecycle', lib => {
    const found = findWatchEntry(lib, body.id);
    if (!found) return { code: 404, error: '找不到这部番' };
    if (body.expected_revision !== undefined && body.expected_revision !== watchDetail(lib, found.entry, found.state).revision) {
      return { code: 409, error: '这部番已有修改，请重新打开详情' };
    }
    const result = moveWatchEntry(lib, found, body.action, body.mode, body.note);
    if (body.action === 'finish' && result.changed) found.entry.finished_at = cstParts().date;
    if (body.action === 'unfinish' && result.changed && !isWatchFinished(found.entry)) delete found.entry.finished_at;
    return result;
  });
}

async function apiWatchRewatch(req, res) {
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  if (!guardWrite(req, res)) return;
  const body = await readJsonBody(req, res);
  if (!body) return;
  if (body.watched_on != null && (!['episodes', 'next'].includes(body.action) ||
      !validHistoryDate(body.watched_on) || body.watched_on > cstParts().date))
    return json(res, { error: '只能补记今天或过去的观看日期' }, 400, req);
  const outcome = await withWriteLock(async () => {
    const lib = await readLibrary(ROOT);
    const found = findWatchEntry(lib, body.id);
    if (!found) return { code: 404, error: '找不到这部番' };
    if (found.state === 'removed') return { code: 409, error: '请先找回条目，再修改重看' };
    if (body.expected_revision !== watchDetail(lib, found.entry, found.state).revision)
      return { code: 409, error: '重看进度有变化，请重新打开详情' };
    const now = new Date(), ts = now.toISOString(), date = body.watched_on ?? cstParts(now).date;
    const result = changeRewatch(found, body, date, ts);
    if (result.error) return result;
    if (result.unchanged) return { round: result.round, changed: false };
    if (body.action === 'start' && !found.entry.finished_at) {
      const completed = firstWatchCompleted(found.entry, await readHistoryRows(lib), watchHistoryOwners(lib));
      if (completed) found.entry.finished_at = completed;
    }
    const historyId = result.history ? randomBytes(16).toString('hex') : null;
    const saved = result.history
      ? await saveProgress(lib, { ...result.history, history_id: historyId, ts, date, id: String(found.entry.id),
        name: found.entry.name_cn || found.entry.name || String(found.entry.id), source: body.watched_on == null ? 'panel' : 'backfill' }, 'watch:rewatch')
      : await saveLibrary(lib, { source: 'watch:rewatch' });
    return { round: result.round, changed: true, history_id: historyId, revision: hash(saved) };
  });
  if (outcome.error) return json(res, { error: outcome.error }, outcome.code, req);
  return json(res, { ok: true, ...outcome }, 200, req);
}

async function apiWatchPreferences(req, res) {
  if (!guardWrite(req, res)) return;
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  const body = await readJsonBody(req, res);
  if (!body) return;
  return updateWatch(req, res, 'watch:preferences', lib => {
    const found = findWatchEntry(lib, body.id);
    return found ? editWatchPreferences(lib, found, body) : { code: 404, error: '找不到这部番' };
  });
}

const bindingPreviews = new Map();

async function apiWatchBinding(req, res) {
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  if (!guardWrite(req, res)) return;
  const body = await readJsonBody(req, res);
  if (!body) return;
  const previewing = body.preview === true;
  let subject, previous;
  if (previewing) {
    if (typeof body.id !== 'string' || !body.id.startsWith('local-') || !relationId(body.subject_id))
      return json(res, { error: '请选择手动条目并填写 Bangumi 条目编号' }, 400, req);
    try {
      const cfg = await readBgmConfig();
      subject = await fetchSubject(body.subject_id, { base: cfg.base, proxy: cfg.proxy, timeoutMs: 5000, retries: 0, animationOnly: true });
      if (String(subject.id) !== body.subject_id) throw new Error('Unexpected Bangumi ID');
    } catch (error) {
      const missing = error.status === 404 || error.code === 'subject_type';
      return json(res, { error: missing ? 'Bangumi 没有对应的动画条目' : '暂时读不到 Bangumi 资料，请重试' }, missing ? 404 : 502, req);
    }
  } else {
    previous = bindingPreviews.get(body.preview_id);
    if (!previous || previous.expires < Date.now()) return json(res, { error: '预览已过期，请重新核对' }, 409, req);
    subject = previous.subject;
  }
  const outcome = await withWriteLock(async () => {
    const { lib, revision } = await librarySnapshot();
    const rows = await readHistoryRows(lib);
    const receipt = hash(JSON.stringify([revision, rows]));
    if (previous && previous.receipt !== receipt) return { code: 409, error: '番库或观看历史已有修改，请重新预览' };
    const id = previous?.id || body.id;
    const scheduleChoice = previous ? previous.scheduleChoice : body.schedule_choice;
    const plan = planBinding(lib, id, subject, rows, new Date().toISOString(), scheduleChoice);
    if (plan.error) return plan;
    if (previewing) {
      if (plan.review.blocked) return { review: plan.review };
      const ticket = randomBytes(18).toString('hex');
      bindingPreviews.set(ticket, { id, subject, receipt, scheduleChoice, expires: Date.now() + 5 * 60000 });
      if (bindingPreviews.size > 24) bindingPreviews.delete(bindingPreviews.keys().next().value);
      return { review: plan.review, preview_id: ticket };
    }
    if (plan.review.blocked || (plan.review.mode === 'merge' && body.confirm_id !== String(subject.id)))
      return { code: 409, error: plan.review.blocked || '请核对并输入 Bangumi 条目编号，确认是同一季同一版本' };
    const saved = await saveLibrary(lib, { source: 'watch:binding' });
    bindingPreviews.delete(body.preview_id);
    return { review: plan.review, changed: true, revision: hash(saved) };
  });
  if (outcome.error) return json(res, { error: outcome.error }, outcome.code, req);
  if (outcome.changed) Object.assign(outcome, rebuildInfo(await rebuildToday()));
  return json(res, { ok: true, ...outcome }, 200, req);
}

async function apiLibraryBatch(req, res) {
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  if (!guardWrite(req, res)) return;
  const body = await readJsonBody(req, res);
  if (!body) return;
  const outcome = await withWriteLock(async () => {
    const { lib, revision } = await librarySnapshot();
    const initial = organizeLibrary(lib, body);
    if (initial.error) return initial;
    const ids = new Set(body.ids);
    const statuses = body.action === 'ended-catchup'
      ? await reviewBroadcastRows(lib.watching.filter(w => ids.has(String(w.id)))) : undefined;
    const plan = statuses ? organizeLibrary(lib, body, false, statuses) : initial;
    if (plan.error) return plan;
    const receipt = hash(JSON.stringify([revision, plan]));
    if (body.preview === true) return { plan, receipt };
    if (receipt !== body.receipt) return { code: 409, error: '选中的条目或番库已有变化，请重新预览' };
    if (!plan.changed.length) return { plan };
    organizeLibrary(lib, body, true, statuses);
    const saved = await saveLibrary(lib, { source: 'library:batch' });
    return { plan, changed: true, revision: hash(saved) };
  });
  if (outcome.error) return json(res, { error: outcome.error }, outcome.code, req);
  if (outcome.changed) Object.assign(outcome, rebuildInfo(await rebuildToday()));
  return json(res, { ok: true, ...outcome }, 200, req);
}

async function apiWatchOrder(req, res) {
  if (!guardWrite(req, res)) return;
  if (req.method === 'GET') {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const id = params.get('id');
    const lib = await readLibrary(ROOT);
    const found = findWatchEntry(lib, id);
    if (!found) return json(res, { error: '找不到这部番' }, 404, req);
    if (!relationId(id)) return json(res, { error: '此条目没有 Bangumi 编号' }, 400, req);
    const data = await animeRelations(ROOT, id, await readBgmConfig(), params.get('refresh') === '1');
    return json(res, { ok: true, items: orderedRelations(found.entry, data.rows), source: data.source,
      fetched_at: data.fetched_at || null, customized: !!found.entry.watch_order?.length,
      revision: watchDetail(lib, found.entry, found.state).revision }, 200, req);
  }
  if (req.method !== 'POST') return json(res, { error: 'use GET or POST' }, 405, req);
  const body = await readJsonBody(req, res);
  if (!body) return;
  if (!relationId(body.id)) return json(res, { error: '此条目没有 Bangumi 编号' }, 400, req);
  const cache = await readRelationCache(ROOT, body.id);
  return updateWatch(req, res, 'watch:order', lib => {
    const found = findWatchEntry(lib, body.id);
    if (!found) return { code: 404, error: '找不到这部番' };
    if (body.expected_revision !== watchDetail(lib, found.entry, found.state).revision)
      return { code: 409, error: '条目已修改，请重新打开观看顺序' };
    return setWatchOrder(found.entry, cache, body.order);
  });
}

async function apiWatchSchedule(req, res) {
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  if (!guardWrite(req, res)) return;
  const body = await readJsonBody(req, res);
  if (!body) return;
  return updateWatch(req, res, 'watch:schedule', lib => {
    const found = findWatchEntry(lib, body.id);
    if (!found || found.state !== 'watching' || isWatchFinished(found.entry) || isCatchup(found.entry))
      return { code: 409, error: '仅追连载中的番剧可调整原播提醒' };
    const w = found.entry;
    const detail = watchDetail(lib, w);
    if (body.expected_revision && body.expected_revision !== detail.revision) {
      return { code: 409, error: '番剧资料已变动，请重新打开详情' };
    }
    const action = body.action;
    if (action === 'mute') {
      if (typeof body.muted !== 'boolean') return { code: 400, error: '静音设置无效' };
      w.reminder_muted = body.muted;
    } else if (action === 'end' || action === 'restart') {
      w.schedule_ended = action === 'end';
    } else if (['skip', 'move', 'clear'].includes(action)) {
      const now = new Date();
      const changes = w.schedule_adjustments || [];
      const past = changes.filter(change => Math.max(Date.parse(change.original_at), Date.parse(change.at) || 0) < +now);
      if (action === 'clear') {
        w.schedule_adjustments = past;
      } else {
        const pending = changes.find(change => !past.includes(change));
        const original = pending?.original_at || nextWeeklyUpdate(detail.air_weekday, detail.air_time_cst, now, w.start_date);
        if (detail.schedule_ended || !original || !scheduleRow(lib, w)) return { code: 409, error: '请先保存周播星期和时刻' };
        let at = null;
        if (action === 'move') {
          const value = body.at;
          const stamp = typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value) ? Date.parse(value + ':00+08:00') : NaN;
          if (!Number.isFinite(stamp) || stamp <= +now || stamp >= Date.parse(original) + 7 * 86400000 ||
              new Date(stamp + 8 * 3600000).toISOString().slice(0, 16) !== value) {
            return { code: 400, error: '新时刻须在当前时间之后，且早于下一周的常规档' };
          }
          at = new Date(stamp).toISOString();
        }
        w.schedule_adjustments = [...past, { date: cstParts(new Date(original)).date, original_at: original, at }];
      }
    } else {
      return { code: 400, error: '排期操作无效' };
    }
    const next = watchDetail(lib, w);
    return { changed: next.revision !== detail.revision, detail: next };
  });
}

async function apiWatchReminder(req, res) {
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  if (!guardWrite(req, res)) return;
  const body = await readJsonBody(req, res);
  if (!body) return;
  if (typeof body.id !== 'string' || typeof body.muted !== 'boolean' || !validReminderOverride(body.lead))
    return json(res, { error: '单番提醒设置无效' }, 400, req);
  return updateWatch(req, res, 'watch:reminder', lib => {
    const found = findWatchEntry(lib, body.id);
    if (!found || !['watching', 'paused'].includes(found.state) || isWatchFinished(found.entry))
      return { code: 409, error: '请先将这部番加入在追或补番' };
    const { entry, state } = found;
    const before = watchDetail(lib, entry, state);
    if (body.expected_revision !== before.revision) return { code: 409, error: '番剧资料已变动，请重新打开详情' };
    if (body.lead === null) delete entry.reminder_lead;
    else entry.reminder_lead = body.lead;
    if (body.muted) entry.reminder_muted = true;
    else delete entry.reminder_muted;
    const detail = watchDetail(lib, entry, state);
    return { changed: detail.revision !== before.revision, detail };
  });
}

async function updateWatch(req, res, source, change) {
  const result = await withWriteLock(async () => {
    const lib = await readLibrary(ROOT);
    const edited = change(lib);
    if (edited.changed) {
      const saved = await saveLibrary(lib, { source });
      edited.revision = createHash('sha256').update(saved).digest('hex');
    }
    return edited;
  });
  if (result.error) return json(res, { error: result.error, duplicates: result.duplicates,
    duplicate_revision: result.duplicate_revision }, result.code, req);
  if (result.changed) Object.assign(result, rebuildInfo(await rebuildToday()));
  json(res, { ok: true, ...result }, result.added ? 201 : 200, req);
}

async function apiScheduleLookup(req, res) {
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  if (!guardWrite(req, res)) return;
  const body = await readJsonBody(req, res);
  if (!body) return;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const id = typeof body.id === 'string' && /^\d{1,10}$/.test(body.id) ? body.id : '';
  if ((!name && !id) || name.length > 160) return json(res, { error: '请先填番名，再查开播时间' }, 400, req);
  try {
    const config = await readBgmConfig();
    const candidates = await lookupBroadcast({ root: ROOT, name, id, proxy: config.proxy,
      originalOnly: body.original_only === true, force: body.force === true });
    json(res, { ok: true, candidates }, 200, req);
  } catch {
    json(res, { error: '暂时连不上排期数据源。你可以先手填时刻，稍后再试。' }, 502, req);
  }
}

// ---------------- /api/history ----------------
function validHistoryDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
}

// The archive name records the rotation year, not necessarily the year of the entries.
function hiddenHistoryIds(library, includeRetracted = false) {
  return new Set([...(library.void_history || []), ...(includeRetracted ? [] : historyRetractions(library).map(row => row.id))]);
}

async function readHistoryRows(library, { includeRetracted = false } = {}) {
  const dir = path.join(ROOT, 'data');
  const names = (await fs.readdir(dir)).filter(name => /^history(?:-\d{4})?\.jsonl$/.test(name));
  const voided = hiddenHistoryIds(library, includeRetracted);
  const pending = await progressJournal(ROOT);
  if (pending && pending.id !== library.history_commit) voided.add(pending.id);
  const seen = new Set();
  const rows = [];
  for (const name of names) {
    let raw;
    try { raw = await fs.readFile(path.join(dir, name), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const line of raw.split('\n')) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || voided.has(row.history_id) || (row.history_id && seen.has(row.history_id))) continue;
      if (row.history_id) seen.add(row.history_id);
      rows.push(row);
    }
  }
  return rows;
}

async function apiHistoryRetract(req, res) {
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  if (!guardWrite(req, res)) return;
  const body = await readJsonBody(req, res);
  if (!body) return;
  if (!historyIdValid(body.history_id)) return json(res, { error: '请选择带有记录编号的观看记录' }, 400, req);
  const outcome = await withWriteLock(async () => {
    const { lib, revision } = await librarySnapshot();
    const owners = watchHistoryOwners(lib);
    const idOf = id => owners.get(String(id))?.id ?? id;
    const retractions = historyRetractions(lib).map(row => ({ ...row, watch_id: String(idOf(row.watch_id)) }));
    if (retractions.some(row => row.id === body.history_id)) return { code: 409, error: '这笔观看记录已经撤销' };
    const rows = (await readHistoryRows(lib, { includeRetracted: true })).map(row => ({ ...row, id: idOf(row.id) }));
    const target = rows.find(row => row.history_id === body.history_id);
    if (!target) return { code: 404, error: '找不到这笔观看记录' };
    if (!validHistoryDate(target.date)) return { code: 409, error: '这条记录缺少有效的观看日期' };
    const found = findWatchEntry(lib, target.id);
    if (!found) return { code: 409, error: '这部番已移出番库，无法调整进度' };
    const plan = retraceHistory(rows, found, target, retractions);
    if (plan.error) return { code: 409, error: plan.error };
    const removedIds = new Set(retractions.map(item => item.id));
    const activeRows = rows.filter(row => !removedIds.has(row.history_id));
    const afterRows = activeRows.filter(row => row !== target);
    const settings = await readSettings();
    const now = new Date();
    const beforeWeek = catchupWeekFromRows(activeRows, settings, now);
    const afterWeek = catchupWeekFromRows(afterRows, settings, now);
    const statsDelta = target.delta;
    const sevenDays = target.date >= cstParts(new Date(+now - 6 * 86400000)).date && target.date <= cstParts(now).date;
    const preview = { title: found.entry.name_cn || found.entry.name || String(found.entry.id), date: target.date,
      from: plan.from, to: plan.to, later: plan.later, total_delta: -statsDelta,
      recent_delta: sevenDays ? -statsDelta : 0, goal: beforeWeek.goal,
      goal_before: beforeWeek.watched, goal_after: afterWeek.watched, state: found.state,
      ...(plan.episode ? { episodes: plan.episodes, watched_before: plan.before, watched_after: plan.after, round_id: plan.roundId } : {}) };
    const receipt = hash(JSON.stringify({ revision, target, plan, preview }));
    if (body.preview === true) return { receipt, preview };
    if (body.receipt !== receipt) return { code: 409, error: '番库或观看记录已有变化，请重新预览这次撤销' };
    if (plan.roundId) {
      const round = found.entry.rewatches.find(item => item.id === plan.roundId);
      storeEpisodeDiff(round, plan);
      if (!plan.keepsFinished) round.finished_at = null;
    } else {
      if (plan.episode) storeEpisodeDiff(found.entry, plan);
      else found.entry.ep_status = plan.to;
      if (!isWatchFinished(found.entry)) delete found.entry.finished_at;
      found.entry.last_watched = plan.lastDate;
      if (plan.lastAt) found.entry.last_watched_at = plan.lastAt;
      else delete found.entry.last_watched_at;
    }
    lib.history_retractions = [...retractions, { id: target.history_id, anchor: plan.anchor, watch_id: String(found.entry.id),
      from: plan.from, to: plan.to, ...(plan.episode ? { episode: true } : {}) }];
    const saved = await saveLibrary(lib, { source: 'history:retract' });
    return { preview, changed: true, revision: hash(saved) };
  });
  if (outcome.error) return json(res, { error: outcome.error }, outcome.code, req);
  if (outcome.changed) Object.assign(outcome, rebuildInfo(await rebuildToday()));
  return json(res, { ok: true, ...outcome }, 200, req);
}

async function apiHistoryBrowse(req, res) {
  if (req.method !== 'GET') return json(res, { error: 'use GET' }, 405, req);
  if (!guardWrite(req, res)) return;
  const params = new URL(req.url, 'http://localhost').searchParams;
  const start = params.get('from'), end = params.get('to'), mode = params.get('mode') || '';
  if ((start && !validHistoryDate(start)) || (end && !validHistoryDate(end)) || (start && end && start > end) ||
    !['', 'airing', 'catchup', 'rewatch'].includes(mode)) return json(res, { error: '请检查起止日期和观看方式' }, 400, req);
  const query = (params.get('q') || '').trim().toLowerCase();
  const watchId = params.get('id');
  let page = Math.max(1, Math.min(100000, Number.parseInt(params.get('page'), 10) || 1));
  const record = params.get('record');
  if (record && !historyIdValid(record)) return json(res, { error: '观看记录编号无效' }, 400, req);
  const rows = await withWriteLock(async () => {
    const lib = await readLibrary(ROOT);
    const owners = watchHistoryOwners(lib);
    return (await readHistoryRows(lib)).flatMap(row => {
      if (row.id == null || !validHistoryDate(row.date) || !Number.isFinite(row.delta) || row.event === 'season' || row.action === 'season') return [];
      const owner = owners.get(String(row.id));
      const searchable = [row.name, row.id, owner?.id, owner?.name_cn, owner?.name, owner?.alias].flat().join(' ').toLowerCase();
      if ((start && row.date < start) || (end && row.date > end) || (mode && (row.watch_mode || 'airing') !== mode) ||
        (watchId && String(owner?.id ?? row.id) !== watchId) || (query && !searchable.includes(query))) return [];
      return [owner && String(owner.id) !== String(row.id) ?
        { ...row, original_id: row.id, id: owner.id, name: owner.name_cn || owner.name || row.name } : row];
    }).sort((a, b) => b.date.localeCompare(a.date) || String(b.ts || '').localeCompare(String(a.ts || '')));
  });
  if (params.get('download') === '1') {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': 'attachment; filename="TIARA-watch-history.jsonl"', 'Cache-Control': 'no-store' });
    return res.end(rows.length ? rows.map(row => JSON.stringify(row)).join('\n') + '\n' : '');
  }
  const located = record ? rows.findIndex(row => row.history_id === record) : -1;
  if (located >= 0) page = Math.floor(located / 40) + 1;
  return json(res, { ok: true, total: rows.length, page, rows: rows.slice((page - 1) * 40, page * 40),
    ...(record ? { located: located >= 0 } : {}) }, 200, req);
}
/** 进度历史：最近 200 条 + 按番聚合（「这季追了多少话」） */
async function apiHistory(req, res) {
  const file = path.join(ROOT, 'data', 'history.jsonl');
  let lines = [];
  try {
    lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
  } catch {
    return json(res, { ok: true, total: 0, recent: [], byShow: [] }, 200, req);
  }

  const library = await readLibrary(ROOT).catch(() => ({}));
  const voided = hiddenHistoryIds(library);
  const owners = watchHistoryOwners(library);
  const all = [];
  for (const l of lines.slice(-2000)) {
    try {
      const row = JSON.parse(l);
      if (!voided.has(row.history_id)) all.push(row);
    } catch {}
  }

  const byId = new Map();
  let gained = 0;
  for (const h of all) {
    const owner = owners.get(String(h.id));
    const k = String(owner?.id ?? h.id);
    const name = owner?.name_cn || owner?.name || h.name;
    const e = byId.get(k) || { id: owner?.id ?? h.id, name, count: 0, last: null };
    if (h.delta > 0) {
      e.count += h.delta;
      gained += h.delta;
      e.last = h.ts;
      e.name = name || e.name;
    }
    byId.set(k, e);
  }

  json(
    res,
    {
      ok: true,
      total: all.length,
      gained,
      recent: all.slice(-200).reverse(),
      byShow: [...byId.values()].sort((a, b) => b.count - a.count),
    },
    200,
    req
  );
}

// ---------------- /api/backups + /api/restore ----------------
/** GET /api/backups → 可回滚的备份清单（只读，不设 Origin 门） */
async function apiBackups(req, res) {
  if (req.method !== 'GET') return json(res, { error: 'use GET' }, 405, req);
  const { DAILY_BACKUP_KEEP, DAILY_BACKUP_NAME, DAILY_HISTORY_TAIL } = await import('./tools/snapshot_daily.mjs');
  const dir = path.join(ROOT, 'data', 'backups');
  const backups = await listBackups(ROOT);
  const daily = { count: 0, bytes: 0, legacyCredentials: 0, keep: DAILY_BACKUP_KEEP, historyTail: DAILY_HISTORY_TAIL };
  const migration = { count: 0, bytes: 0 };
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  async function size(file) {
    const stat = await fs.lstat(file).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    return stat?.isFile() ? stat.size : 0;
  }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && DAILY_BACKUP_NAME.test(entry.name)) {
      const members = await fs.readdir(file, { withFileTypes: true }).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return [];
      });
      daily.count++;
      if (members.some(member => member.isFile() && member.name === 'bgm.json')) daily.legacyCredentials++;
      for (const member of members)
        if (member.isFile()) daily.bytes += await size(path.join(file, member.name));
    } else if (entry.isFile() && /^migration-[\w-]+\.json$/.test(entry.name)) {
      migration.count++;
      migration.bytes += await size(file);
    }
  }
  const library = { count: backups.length, bytes: backups.reduce((sum, item) => sum + item.size, 0), keep: BACKUP_KEEP };
  json(res, { ok: true, backups, inventory: { daily, migration, library } }, 200, req);
}

/**
 * POST /api/restore {name}
 *
 * 旧实现有三个问题，都在 lib/library.mjs 里修掉了：
 *   · 读 body 失败后 `|| {}` 让它继续按默认名 library.json.bak 静默回滚
 *   · 直接 fs.writeFile 覆盖 library.json —— 不压撤销栈、不更新 updated、不是原子写
 *   · 覆盖之前先调 backupLibrary()，把「正在用的好数据」写进 .bak，
 *     等下一次误操作再恢复时拿到的是坏的那份
 */
function backupEntries(lib) {
  const rows = new Map();
  for (const state of WATCH_STATES) {
    for (const w of lib[state] || []) rows.set(String(w.id), watchDetail(lib, w, state));
  }
  return rows;
}

function backupChanges(current, backup, id) {
  const before = backupEntries(current || {});
  const after = backupEntries(backup);
  const ids = id ? [id] : [...new Set([...before.keys(), ...after.keys()])];
  return ids.flatMap(key => {
    const from = before.get(key), to = after.get(key);
    return from?.revision === to?.revision ? [] : [{ id: key, from, to }];
  });
}

function restoreWatchFromBackup(current, backup, id) {
  const source = findWatchEntry(backup, id);
  if (!source) return null;
  const existing = findWatchEntry(current, id);
  if (existing) current[existing.state].splice(existing.index, 1);
  if (source.state !== 'dropped' && Array.isArray(current.dropped)) current.dropped = current.dropped.filter(w => String(w.id) !== id);
  (current[source.state] ||= []).push(source.entry);
  current.weekday ||= {};
  for (const key of Object.keys(current.weekday)) current.weekday[key] = current.weekday[key].filter(w => String(w.id) !== id);
  for (const [day, rows] of Object.entries(backup.weekday || {})) {
    for (const row of rows) if (String(row.id) === id) (current.weekday[day] ||= []).push(row);
  }
  return current;
}

async function apiRestore(req, res) {
  if (!guardWrite(req, res)) return;
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  const body = await readJsonBody(req, res);
  if (!body) return;
  const name = String(body.name || '');
  const id = body.id == null ? null : String(body.id);
  if (!name) return json(res, { error: '请选择备份' }, 400, req);

  const outcome = await withWriteLock(async () => {
    try {
      const raw = await fs.readFile(path.join(ROOT, 'data/library.json')).catch(e => {
        if (e.code !== 'ENOENT') throw e;
        return Buffer.alloc(0);
      });
      const revision = hash(raw);
      let current;
      try { current = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')); } catch {}
      if (!Array.isArray(current?.watching)) current = null;
      const backup = await readBackup(ROOT, name);
      try { validateRestorableLibrary(backup.lib); }
      catch (error) { return { code: 400, payload: { error: error.message } }; }
      if (id && (!current || !findWatchEntry(backup.lib, id))) {
        return { code: 409, payload: { error: '这份备份找不到该番，或当前库不可读' } };
      }
      if (id) {
        const oldOwners = watchHistoryOwners(backup.lib);
        const currentOwners = watchHistoryOwners(current);
        const owner = currentOwners.get(id);
        const next = oldOwners.get(id);
        if ((owner && String(owner.id) !== id) || JSON.stringify(owner?.history_ids || []) !== JSON.stringify(next?.history_ids || []))
          return { code: 409, payload: { error: '这部番有绑定或合并历史，请恢复整份番库备份以保留对应关系' } };
      }
      if (body.dry_run) {
        return { code: 200, payload: { ok: true, revision, backup_revision: backup.revision,
          entries: [...backupEntries(backup.lib).values()], changes: backupChanges(current, backup.lib, id),
          current_readable: !!current, target_version: VERSION, target_root: ROOT,
          recovery: current ? 'data/library.json.bak' : raw.length ? 'data/backups/ 原文件副本' : null } };
      }
      if ((body.expected_revision && body.expected_revision !== revision) ||
          (body.backup_revision && body.backup_revision !== backup.revision)) {
        return { code: 409, payload: { error: '当前番库或备份已变动，请重新预览' } };
      }
      const restored = id ? restoreWatchFromBackup(current, backup.lib, id) : backup.lib;
      if (current?.void_history) restored.void_history = current.void_history;
      if (current) {
        if (current.history_retractions) restored.history_retractions = current.history_retractions;
        else delete restored.history_retractions;
      }
      try { validateRestorableLibrary(restored); }
      catch (error) { return { code: 409, payload: { error: error.message } }; }
      let recovery = current ? 'data/library.json.bak' : null;
      if (!current && raw.length) {
        recovery = 'data/backups/pre-restore-' + randomBytes(8).toString('hex') + '.raw';
        await fs.mkdir(path.join(ROOT, 'data/backups'), { recursive: true });
        await writeFileAtomic(path.join(ROOT, recovery), raw);
      }
      await saveLibrary(restored, { backup: !!current, source: 'restore:' + name });
      return { code: 200, payload: { ok: true, restored: name, id, recovery }, write: true };
    } catch (e) {
      if (e.code === 'ENOBACKUP') {
        return { code: 404, payload: { error: '找不到这份备份', backups: (await listBackups(ROOT)).map(b => b.name) } };
      }
      logLine('error', 'restore: ' + e.message);
      return { code: 400, payload: { error: e.message } };
    }
  });
  if (outcome.write) Object.assign(outcome.payload, rebuildInfo(await rebuildToday()));
  json(res, outcome.payload, outcome.code, req);
}

async function apiMigration(req, res) {
  if (!guardWrite(req, res)) return;
  if (req.method === 'GET') return withWriteLock(async () => {
    const scope = new URL(req.url, 'http://localhost').searchParams.get('desktop');
    const data = { ...migrationExport(await migrationState(ROOT), scope), source_version: VERSION };
    const size = Buffer.byteLength(JSON.stringify({ migration: data, source: '0'.repeat(64), target: '0'.repeat(64) }));
    if (size > MIGRATION_LIMIT) return json(res, { error: '迁移数据超过 16 MB' }, 413, req);
    return json(res, { ok: true, migration: data }, 200, req);
  });
  if (req.method !== 'POST') return json(res, { error: 'use GET or POST' }, 405, req);
  const body = await readJsonBody(req, res, MIGRATION_LIMIT);
  if (!body) return;
  let data;
  try { data = parseMigration(body.migration); }
  catch (error) { return json(res, { error: error.message }, 400, req); }
  const result = await withWriteLock(async () => {
    const current = await migrationState(ROOT);
    const desktop = await desktopRestorePlan(ROOT, current, data.desktop);
    const source = migrationSourceRevision(desktop ? { data, desktop } : data);
    const target = migrationSourceRevision({ revision: current.revision, version: VERSION, root: ROOT });
    if (body.preview === true) return { code: 200, payload: {
      ok: true, source, target, incoming: migrationSummary(data), current: migrationSummary(current.data),
      source_version: data.source_version, target_version: VERSION, target_root: ROOT, created_at: data.created_at,
      changes: migrationChanges(current.data, data),
      ...(desktop ? { desktop } : {}),
    } };
    if (source !== body.source || target !== body.target) {
      return { code: 409, payload: { error: '文件或当前数据已有变化，请重新预览后再导入' } };
    }
    const backup = await importMigration(ROOT, current, data, desktop);
    const readback = await migrationState(ROOT).catch(() => null);
    return { code: 200, payload: { ok: true, backup, readback: readback ? migrationSummary(readback.data) : null,
      desktop_pending: Boolean(data.desktop?.notes || data.desktop?.appearance || data.desktop?.favorites) }, write: true };
  });
  if (result.write) Object.assign(result.payload, rebuildInfo(await rebuildToday()));
  return json(res, result.payload, result.code, req);
}

async function apiLibraryCsv(req, res) {
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  if (!guardWrite(req, res)) return;
  const body = await readJsonBody(req, res, CSV_BYTES * 3);
  if (!body) return;
  const result = await withWriteLock(async () => {
    const library = await readLibrary(ROOT);
    let preview;
    try { preview = previewCsvImport(library, body.csv); }
    catch (error) { return { code: 400, payload: { error: error.message } }; }
    if (body.preview === true) return { code: 200, payload: { ok: true, ...preview } };
    if (body.revision !== preview.revision) return { code: 409, payload: { error: 'CSV 或番库已有变化，请重新预览' } };
    let added;
    try { added = applyCsvImport(library, preview.rows, body.selected); }
    catch (error) { return { code: 400, payload: { error: error.message } }; }
    await saveLibrary(library, { source: 'library:csv' });
    return { code: 201, payload: { ok: true, added }, write: true };
  });
  if (result.write) Object.assign(result.payload, rebuildInfo(await rebuildToday()));
  return json(res, result.payload, result.code, req);
}

let latestRelease, checkingRelease;
async function apiReleaseInfo(req, res) {
  if (req.method !== 'GET') return json(res, { error: 'use GET' }, 405, req);
  if (!latestRelease || Date.now() - latestRelease.at >= 5 * 60 * 1000) {
    if (!checkingRelease) checkingRelease = publicRelease(VERSION)
      .then(info => { latestRelease = { at: Date.now(), info }; return info; })
      .finally(() => { checkingRelease = null; });
    try { await checkingRelease; }
    catch (error) {
      const message = error.message?.startsWith('GitHub') ? error.message : '暂时连不上 GitHub，可直接打开发行页面';
      return json(res, { error: message, installed: VERSION, url: RELEASE_PAGE }, 503, req);
    }
  }
  return json(res, { ok: true, ...latestRelease.info }, 200, req);
}

async function privateSspPreview() {
  const library = await readLibrary(ROOT);
  const settings = await readSettings();
  const from = cstParts().date;
  const revision = createHash('sha256').update(JSON.stringify([from, library, settings])).digest('hex');
  return { ...sspSnapshotWindow(from), revision };
}

async function apiPrivateSsp(req, res) {
  if (!guardWrite(req, res)) return;
  if (req.method === 'GET') return json(res, { ok: true, ...(await withWriteLock(privateSspPreview)) }, 200, req);
  if (req.method !== 'POST') return json(res, { error: 'use GET or POST' }, 405, req);
  const body = await readJsonBody(req, res);
  if (!body) return;
  const output = await withWriteLock(async () => {
    const plan = await privateSspPreview();
    if (plan.revision !== body.revision)
      return { code: 409, error: '番库、设置或日期已变动，请重新预览私人快照' };
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tiara-ssp-export-'));
    const name = 'TIARA-ssp-private-' + plan.from + '.zip';
    const file = path.join(directory, name);
    try {
      await new Promise((resolve, reject) => {
        execFile(process.execPath, [path.join(ROOT, 'tools', 'pack_ssp.mjs'), '--private-snapshot', '--out', file],
          { timeout: 18000, windowsHide: true }, error => error ? reject(error) : resolve());
      });
      if (cstParts().date !== plan.from) return { code: 409, error: '今日日期已变动，请重新预览私人快照' };
      return { name, bytes: await fs.readFile(file) };
    } catch (error) {
      logLine('warn', '[ssp] 私人快照生成失败：' + (error.code || error.name || 'unknown'));
      return { code: 500, error: '私人快照生成失败，请检查立绘和程序文件是否齐全' };
    } finally {
      await fs.rm(file, { force: true }).catch(() => {});
      await fs.rmdir(directory).catch(() => {});
    }
  });
  if (!output.bytes) return json(res, { error: output.error }, output.code, req);
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Cache-Control': 'no-store',
    'Content-Disposition': 'attachment; filename="' + output.name + '"', 'Content-Length': output.bytes.length });
  res.end(output.bytes);
}

// ---------------- /api/settings ----------------
/** GET 读偏好；POST { clock?: '24h'|'30h' } 写偏好并重算今日数据（桌宠尺寸在 data/state.json） */
const validReminderOverride = value => value === null || REMINDER_LEADS.includes(value);

function reminderSettingsError(body) {
  for (const key of ['quiet', 'quiet_work', 'quiet_weekend']) {
    const start = body[key + '_start'], end = body[key + '_end'];
    if (start === undefined && end === undefined) continue;
    const valid = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    if (!(start === '' && end === '') && !(valid(start) && valid(end) && start !== end)) {
      return '请填写两个不同的 24 小时时刻，或同时留空关闭免打扰';
    }
  }
  if (body.reminder_lead !== undefined && !REMINDER_LEADS.includes(body.reminder_lead))
    return '请从可选的提前量中选择';
  return null;
}

async function apiSettings(req, res) {
  if (req.method === 'GET') return json(res, await readSettings(), 200, req);
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  if (!guardWrite(req, res)) return;
  const body = await readJsonBody(req, res);
  if (!body) return;
  const error = reminderSettingsError(body);
  if (error) return json(res, { error }, 400, req);
  if (body.catchup_goal !== undefined && (!Number.isInteger(body.catchup_goal) || body.catchup_goal < 0 || body.catchup_goal > 999))
    return json(res, { error: '每周补番目标须为 0–999 集，0 表示关闭' }, 400, req);
  if (body.power_save !== undefined && typeof body.power_save !== 'boolean')
    return json(res, { error: '省电模式必须是布尔值' }, 400, req);
  const next = await withWriteLock(() => writeSettings(body));
  const rebuilt = await rebuildToday();
  json(res, { ok: true, settings: next, ...rebuildInfo(rebuilt) }, 200, req);
}

// ---------------- /api/nickname ----------------
/**
 * POST /api/nickname { nickname }
 *
 * 她怎么称呼你。存在 `data/library.json` 的 `user.nickname_for_pet`（属于用户数据，
 * 不是设备偏好），写完立刻重算 today.txt，桌宠下次取数据就会换称呼。
 * 生气时的「不届き者」这类固定说法不走这里（见 lib/persona.mjs 的 RESERVED_TERMS）。
 */
async function apiNickname(req, res) {
  if (!guardWrite(req, res)) return;
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  const body = await readJsonBody(req, res);
  if (!body) return;   // 坏 JSON / 超限已经回过响应，别再往下走（以前就是这里让进程 exit 1）
  const r = normalizeNickname(body.nickname);
  if (!r.ok) return json(res, { ok: false, error: r.error }, 400, req);
  await withWriteLock(async () => {
    const lib = await readLibrary(ROOT);
    lib.user = lib.user || {};
    lib.user.nickname_for_pet = r.value;
    await saveLibrary(lib, { source: 'nickname' });
  });
  const rebuilt = await rebuildToday();
  json(res, { ok: true, nickname: r.value, ...rebuildInfo(rebuilt) }, 200, req);
}

// ---------------- /api/sync ----------------
/**
 * 手动拉一次 Bangumi 放送表 + 收藏。
 * 参数：{ takeProgress?: boolean, proxy?: string, fixture?: string }
 * 拿不到网就原样返回 CLI 的报错，面板只负责把它显示出来。
 */
const syncPreviews = new Map();
const syncJobs = new Map();
const SYNC_PREVIEW_TTL = 5 * 60 * 1000;

const hash = value => createHash('sha256').update(value).digest('hex');

async function librarySnapshot() {
  const raw = await fs.readFile(path.join(ROOT, 'data/library.json'), 'utf8');
  return { lib: JSON.parse(raw.replace(/^\uFEFF/, '')), revision: hash(raw) };
}

const readBgmConfig = async () => effectiveBgmConfig(await readStoredBgmConfig(ROOT));

const writebackPlans = new Map();
async function apiBgmWriteback(req, res) {
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  if (!guardWrite(req, res)) return;
  const body = await readJsonBody(req, res);
  if (!body) return;
  const id = body.id;
  const episode = body.episode;
  if (!relationId(id)) return json(res, { error: '请先把本机条目绑定到 Bangumi。' }, 400, req);

  async function local() {
    const library = await readLibrary(ROOT);
    const found = findWatchEntry(library, id);
    if (!found || found.state === 'removed' || !writebackWatched(found.entry, episode)) return null;
    return watchDetail(library, found.entry, found.state);
  }
  const configRevision = config => createHash('sha256').update(JSON.stringify(config)).digest('hex');
  function conflict(text) { return { code: 409, error: text }; }
  try {
    if (body.preview === true) {
      const detail = await local();
      if (!detail) return json(res, { error: '这集在本机首轮没有已看记录。' }, 409, req);
      const config = await readBgmConfig();
      const identity = await identifyWriteback(config);
      const chapter = await findRemoteChapter(config, id, episode, identity);
      const remote = await readRemoteChapter(config, chapter.id);
      const plan = { id, episode, chapter, remote, revision: detail.revision, config: configRevision(config),
        expires: Date.now() + 5 * 60 * 1000 };
      const key = randomBytes(18).toString('hex');
      for (const [saved, value] of writebackPlans) if (value.expires < Date.now()) writebackPlans.delete(saved);
      if (writebackPlans.size >= 64) writebackPlans.delete(writebackPlans.keys().next().value);
      writebackPlans.set(key, plan);
      return json(res, { ok: true, confirmation: key, name: detail.name, episode, chapter,
        user: identity.user, remote: remote.type }, 200, req);
    }
    const plan = writebackPlans.get(body.confirmation);
    if (!plan || plan.expires < Date.now() || plan.id !== id || plan.episode !== episode)
      return json(res, { error: '请先重新预览这集，再确认写回。' }, 409, req);
    const result = await withWriteLock(async () => {
      const detail = await local();
      const config = await readBgmConfig();
      if (Date.now() > plan.expires || !detail || detail.revision !== plan.revision || configRevision(config) !== plan.config)
        return conflict('本机记录或账号已变化，请重新预览。');
      const current = await readRemoteChapter(config, plan.chapter.id);
      if (current.type === 2) return { already: true, episode };
      if (current.type !== plan.remote.type || current.stamp !== plan.remote.stamp || current.type === 3)
        return conflict('Bangumi 上的单集状态已变化或标为弃看，请重新预览核对。');
      await writeRemoteChapter(config, plan.chapter.id);
      const after = await readRemoteChapter(config, plan.chapter.id);
      if (after.type !== 2) return conflict('Bangumi 暂未确认已看，请重新预览核对。');
      return { already: false, episode };
    });
    return json(res, result.error ? { error: result.error } : { ok: true, ...result }, result.code || 200, req);
  } catch (error) {
    const failure = writebackError(error);
    return json(res, { error: failure.error }, failure.code, req);
  }
}

async function apiSync(req, res) {
  if (req.method === 'GET') {
    const id = new URL(req.url, 'http://localhost').searchParams.get('request_id');
    const job = syncJobs.get(id);
    return json(res, { ok: true, running: !!job, sources: job?.sources || {} }, 200, req);
  }
  if (!guardWrite(req, res)) return;
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  const body = await readJsonBody(req, res, 1024 * 1024);
  if (!body) return;
  if (body.cancel === true) {
    const job = syncJobs.get(body.request_id);
    job?.controller.abort();
    return json(res, { ok: true, cancelled: !!job }, 200, req);
  }

  if (body.dry_run === true) {
    const config = await readBgmConfig();
    const mode = body.mode || (body.takeProgress ? 'progress' : 'collections');
    if (!['calendar', 'collections', 'progress'].includes(mode)) return json(res, { error: '同步方式无效' }, 400, req);
    if (mode === 'progress' && !config.token) return json(res, { error: '请先连接 Bangumi 账号，再导入进度' }, 400, req);
    const requestId = body.request_id ?? randomBytes(18).toString('hex');
    if (typeof requestId !== 'string' || !/^[\da-f-]{32,38}$/i.test(requestId))
      return json(res, { error: '无效的同步请求编号' }, 400, req);
    if (syncJobs.has(requestId) || syncJobs.size >= 4)
      return json(res, { error: '已有同步请求正在运行' }, 409, req);
    const controller = new AbortController();
    const job = { controller, sources: {} };
    syncJobs.set(requestId, job);
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });
    const configRevision = hash(JSON.stringify(config));
    const cacheFile = key => path.join(ROOT, 'cache', 'bgm', 'sync-' + configRevision + '-' + key + '.json');
    let fetched;
    try {
      fetched = await fetchSyncData(config, { mode, signal: controller.signal,
        progress: (key, value) => { job.sources[key] = value; },
        cache: key => fs.readFile(cacheFile(key), 'utf8').then(JSON.parse).catch(() => null),
        useCache: body.use_cache === true,
        remember: (key, value) => writeJsonAtomic(cacheFile(key), value).catch(() => {}),
      });
      controller.signal.throwIfAborted();
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      if (!res.destroyed) return json(res, { error: '同步已取消，番库没有改动' }, 409, req);
      return;
    } finally {
      syncJobs.delete(requestId);
    }
    const { data, usable, ...status } = fetched;
    if (!usable) return json(res, { error: '这次没有取得可同步的数据', ...status }, 502, req);
    const snapshot = await librarySnapshot();
    const existingIds = new Set([...(snapshot.lib.watching || []).map(w => String(w.id)), ...inactiveWatchIds(snapshot.lib)]);
    const ended = new Set();
    for (const item of data.collections || []) {
      const id = String(item?.subject_id ?? item?.subject?.id ?? '');
      if (!relationId(id) || existingIds.has(id) || Number(item?.type ?? 3) !== 3) continue;
      const subject = item.subject;
      const evidence = await showBroadcastStatus(id, { meta: { date: subject?.date, regular_total: subject?.eps } });
      if (evidence.state === 'ended') ended.add(id);
    }
    const plan = reviewBgmLibrary(snapshot.lib, data, {
      takeProgress: mode === 'progress', allWeek: body.weekday === 'all',
      stamp: Object.fromEntries(Object.entries(status.sources).map(([key, value]) => [key, value.fetched_at])),
      ended,
    });
    const preview_id = randomBytes(18).toString('hex');
    for (const [id, preview] of syncPreviews) if (preview.expires < Date.now()) syncPreviews.delete(id);
    if (syncPreviews.size >= 8) syncPreviews.delete(syncPreviews.keys().next().value);
    syncPreviews.set(preview_id, { ...status, plan, revision: snapshot.revision,
      configRevision, expires: Date.now() + SYNC_PREVIEW_TTL });
    return json(res, { ok: true, preview_id, changes: plan.changes, mappings: plan.mappings,
      protected_fields: plan.protectedFields, ...status }, 200, req);
  }

  const applied = await withWriteLock(async () => {
    const preview = syncPreviews.get(body.preview_id);
    if (!preview || preview.expires < Date.now()) return null;
    if (preview.revision !== (await librarySnapshot()).revision ||
        preview.configRevision !== hash(JSON.stringify(await readBgmConfig()))) {
      syncPreviews.delete(body.preview_id);
      return null;
    }
    const allowed = new Set(preview.plan.changes.map(change => change.key));
    if (body.selected !== undefined && (!Array.isArray(body.selected) || body.selected.some(key => !allowed.has(key))))
      return { invalid: true };
    syncPreviews.delete(body.preview_id);
    const { next, changes } = preview.plan.apply(body.selected);
    if (changes.length) await saveLibrary(next, { source: 'sync' });
    return { ...preview, changes };
  });
  if (applied?.invalid) return json(res, { error: '有选项不属于本次预览，请重新核对' }, 400, req);
  if (!applied) return json(res, { error: '同步预览已失效，可能是番库或账号已修改，请重新预览。' }, 409, req);
  if (!applied.partial && applied.sources.calendar.status === 'ok') {
    await writeJsonAtomic(path.join(ROOT, 'cache/bgm/sync-success.json'), { at: new Date().toISOString() })
      .catch(() => logLine('error', '无法保存 Bangumi 同步时间'));
  }
  const rebuilt = applied.changes.length ? rebuildInfo(await rebuildToday()) : {};
  json(res, { ok: true, changes: applied.changes, sources: applied.sources, partial: applied.partial, ...rebuilt }, 200, req);
}

function patchBgmConfig(config, patch) {
  const next = { ...config };
  for (const key of ['user', 'token', 'proxy']) {
    if (patch[key] === undefined) continue;
    if (typeof patch[key] !== 'string' || patch[key].length > 2048 || /[\x00-\x1f\x7f]/.test(patch[key])) return null;
    next[key] = patch[key].trim();
  }
  return validateBgmProxy(next.proxy) ? next : null;
}

async function apiToken(req, res, test = false) {
  if (!test && req.method === 'GET') return json(res, { ok: true, ...bgmConfigView(await readStoredBgmConfig(ROOT)) }, 200, req);
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  if (!guardWrite(req, res)) return;
  const body = await readJsonBody(req, res);
  if (!body) return;
  const update = async () => {
    const next = patchBgmConfig(await readStoredBgmConfig(ROOT), body);
    if (next && !test) {
      await fs.mkdir(path.join(ROOT, 'data'), { recursive: true });
      await writeJsonAtomic(path.join(ROOT, BGM_REL), next);
    }
    return next;
  };
  const next = test ? await update() : await withWriteLock(update);
  if (!next) return json(res, { error: '账号设置格式不正确。代理请填写 HTTP 代理地址，例如 http://127.0.0.1:7890。' }, 400, req);
  if (!test) return json(res, { ok: true, ...bgmConfigView(next) }, 200, req);
  const { data, usable, ...status } = await fetchSyncData(effectiveBgmConfig(next), { connection: true });
  json(res, { ok: usable, ...status, ...bgmConfigView(next), ...(usable ? {} : { error: 'Bangumi 连接失败' }) }, usable ? 200 : 502, req);
}

/**
 * GET /api/season?q=2026Q4[&refresh=1][&list=1]
 *   · 有新鲜缓存 → 直接用（source=cache）
 *   · 否则拉网（source=net）；拉不到但有旧缓存 → 回退（source=cache-stale + warning）
 *   · list=1 → 只列已缓存季度
 */
const seasonInflight = new Map();
const seasonRetryAfter = new Map();
const SEASON_RETRY_MS = 15 * 60_000;

function seasonAirings(items) {
  return Object.fromEntries(items.filter(item => item.weekday && item.time_cst)
    .map(item => [String(item.id), { weekday: item.weekday, time_cst: item.time_cst }]));
}

async function seasonData(q, cached, { warning, refreshed = false } = {}) {
  const state = seasonRefreshState(q, cached);
  const items = cached?.items || [];
  const known = await broadcastSuggestions(ROOT, items.map(item => item.id), { online: false, originalOnly: true }).catch(() => ({}));
  const airings = {
    ...seasonAirings(items),
    ...Object.fromEntries(Object.entries(known).map(([id, item]) => [id, {
      weekday: item.weekday, time_cst: item.time_cst,
    }])),
  };
  const source = refreshed ? 'net' : warning && cached ? 'cache-stale' : cached?.built_in ? 'builtin' : cached ? 'cache' : 'empty';
  return { ...cached, ok: true, q, source, items, total: cached?.total ?? 0, airings,
    article: yucReference(q),
    catalog_status: state.status, refresh_due: state.due && Date.now() >= (seasonRetryAfter.get(q) || 0),
    ...(warning ? { warning } : {}) };
}

function seasonRefreshWarning(error) {
  if (error.code === 'season_incomplete') return 'Bangumi 返回的季度目录不完整';
  if (error.status === 407 || /代理.*(拒绝|格式)/.test(error.message)) return 'Bangumi 代理设置或认证有误';
  if (error.name === 'TimeoutError' || error.name === 'AbortError' || /超时/.test(error.message)) return '连接 Bangumi 超时';
  if (error.status === 429) return 'Bangumi 请求过于频繁';
  if (error.status >= 400) return 'Bangumi 返回 HTTP ' + error.status;
  return '暂时无法连接 Bangumi';
}

function refreshSeason(q) {
  if (seasonInflight.has(q)) return seasonInflight.get(q);
  const work = (async () => {
    let warning;
    try {
      const cached = await readSeasonCache(ROOT, q);
      const cfg = await readBgmConfig();
      const data = await fetchSeason({ q, proxy: cfg.proxy, base: cfg.base, retries: 1, timeoutMs: 10_000,
        signal: AbortSignal.timeout(36_000) });
      if (!data.items.length && (cached?.items.length || q < currentSeason()))
        warning = 'Bangumi 返回空目录，无法核验';
      else {
        try { await writeSeasonCache(ROOT, data); }
        catch { warning = '已取到目录，但无法写入本地缓存'; }
        if (!warning) {
          if (q >= currentSeason()) queueCoverPrefetch(data.items);
          seasonRetryAfter.delete(q);
          return { refreshed: true };
        }
      }
    } catch (error) {
      warning = seasonRefreshWarning(error);
    }
    seasonRetryAfter.set(q, Date.now() + SEASON_RETRY_MS);
    logLine('warn', '季度 ' + q + ' 联网更新：' + warning);
    return { warning };
  })().finally(() => seasonInflight.delete(q));
  seasonInflight.set(q, work);
  return work;
}

async function apiSeason(req, res) {
  const params = new URL(req.url, 'http://127.0.0.1').searchParams;
  if (params.get('list') === '1') {
    return json(res, { ok: true, seasons: await listCachedSeasons(ROOT), current: currentSeason() }, 200, req);
  }
  const qRaw = params.get('q');
  let q;
  try {
    q = seasonOf(qRaw || new Date());
  } catch (error) {
    return json(res, { ok: false, error: String(error.message || error), q: qRaw, hint: '季度写成 2026Q4 这种' }, 400, req);
  }
  const cached = await readSeasonCache(ROOT, q);
  const refresh = params.get('refresh');
  if (refresh === '1' || (refresh === 'auto' && seasonRefreshState(q, cached).due &&
      Date.now() >= (seasonRetryAfter.get(q) || 0))) {
    const result = await refreshSeason(q);
    return json(res, await seasonData(q, result.refreshed ? await readSeasonCache(ROOT, q) : cached, result), 200, req);
  }
  if (!cached && q >= FIRST_CATALOG_SEASON && q > shiftSeason(currentSeason(), 2))
    return json(res, { ok: false, error: '该季度尚未开放', q }, 400, req);
  return json(res, await seasonData(q, cached), 200, req);
}

async function apiSeasonReference(req, res) {
  if (req.method !== 'GET') return json(res, { error: 'use GET' }, 405, req);
  if (!guardWrite(req, res)) return;
  const params = new URL(req.url, 'http://127.0.0.1').searchParams;
  const q = params.get('q') || '';
  if (!/^\d{4}Q[1-4]$/.test(q) || q < FIRST_CATALOG_SEASON || q > shiftSeason(currentSeason(), 2))
    return json(res, { error: '季度不在当前目录范围内' }, 400, req);
  const id = params.get('id');
  const cached = id ? await readSeasonCache(ROOT, q) : null;
  const item = cached?.items.find(row => String(row.id) === id);
  if (id && !item) return json(res, { error: '当前季表找不到这部番' }, 404, req);
  const { proxy } = await readBgmConfig();
  const reference = await lookupYuc(q, item, proxy).catch(() => yucReference(q));
  return json(res, { ok: true, reference }, 200, req);
}

function watchAiring(detail, since) {
  const next = nextScheduledUpdate(detail, new Date(), since);
  return next ? { next, source: detail.schedule_source || '本地排期' } : null;
}

async function apiOriginalSchedule(req, res) {
  if (req.method !== 'GET') return json(res, { error: 'use GET' }, 405, req);
  const q = new URL(req.url, 'http://127.0.0.1').searchParams.get('q');
  if (q != null && !/^\d{4}Q[1-4]$/.test(q)) return json(res, { error: '季度无效' }, 400, req);
  if (q) {
    const data = await seasonData(q, await readSeasonCache(ROOT, q));
    return json(res, { ok: true, airings: data.airings }, 200, req);
  }
  const lib = await readLibrary(ROOT);
  let ids = (lib.watching || []).concat(Object.values(lib.weekday || {}).flat()).map(item => item.id);
  ids = ids.filter(id => /^\d+$/.test(String(id)));
  const config = await readBgmConfig();
  try {
    const found = await broadcastSuggestions(ROOT, ids, { proxy: config.proxy, online: true, originalOnly: true });
    const airings = Object.fromEntries(Object.entries(found).map(([id, item]) => [id, {
      weekday: item.weekday, time_cst: item.time_cst,
    }]));
    return json(res, { ok: true, airings }, 200, req);
  } catch {
    return json(res, { error: '暂时无法刷新原播周档' }, 502, req);
  }
}

async function apiDesktopSchedule(req, res) {
  if (req.method !== 'GET') return json(res, { error: 'use GET' }, 405, req);
  const lib = actualSchedule(await readLibrary(ROOT));
  const active = lib.watching.filter(w => !w.schedule_ended && !isWatchFinished(w) && !isCatchup(w));
  const settings = await readSettings();
  const { clock } = settings;
  const { proxy } = await readBgmConfig();
  let warning = '';
  const airings = await broadcastSuggestions(ROOT, active.map(w => w.id).filter(id => /^\d+$/.test(String(id))),
    { proxy, online: true, originalOnly: true }).catch(() => {
    warning = '原播周档暂时无法读取。';
    return {};
  });
  const rows = active.map(w => {
    const id = String(w.id);
    const original = airings[id];
    const platformOnly = /^bangumi-data ·/.test(w.schedule_source || '');
    const local = platformOnly ? null : scheduleRow(lib, w);
    const weekday = original?.weekday ?? local?.day ?? (platformOnly ? null : w.air_weekday);
    const time = original?.time_cst ?? (platformOnly ? '' : (local ? local.row.time_cst : w.air_time_cst));
    const slot = displayClock(time, weekday, clock);
    const url = watchUrl(w.watch_url);
    const reminder = reminderStatus({ ...w, state: 'watching' }, scheduleRow(lib, w), settings, w.start_date);
    return { id, name: w.name_cn || w.name || id, weekday: slot.weekday_disp || 0, time: slot.time_disp, reminder,
      source: original ? 'original' : time ? 'custom' : '', seen: w.ep_status ?? 0, total: w.eps ?? 0,
      ...(url ? { watch_url: url } : {}) };
  });
  rows.sort((a, b) => (a.weekday || 8) - (b.weekday || 8) || (a.time || '99:99').localeCompare(b.time || '99:99'));
  const personalById = new Map(lib.watching.filter(isCatchup).map(item => [String(item.id), item]));
  const personal = catchupReminders(lib).map(slot => ({
    ...slot, reminder: reminderStatus({ ...personalById.get(String(slot.id)), state: 'watching' }, null, settings),
  }));
  return json(res, { rows, personal, clock, warning }, 200, req);
}

async function apiCatchupSubject(req, res) {
  if (req.method !== 'GET') return json(res, { error: 'use GET' }, 405, req);
  const link = new URL(req.url, 'http://localhost').searchParams.get('link')?.trim() || '';
  const id = /^https?:\/\/(?:www\.)?(?:bgm\.tv|bangumi\.tv|chii\.in)\/subject\/([1-9]\d{0,9})(?:\/?(?:[?#].*)?)$/i.exec(link)?.[1];
  if (!id) return json(res, { error: '请粘贴 Bangumi 动画条目的链接，例如 https://bgm.tv/subject/123' }, 400, req);
  const lib = await readLibrary(ROOT);
  if (findWatchEntry(lib, id)) return json(res, { error: '这部番已在番库，可以在详情切换为补番。', id }, 409, req);
  const cfg = await readBgmConfig();
  try {
    const meta = await fetchSubject(id, { base: cfg.base, proxy: cfg.proxy, timeoutMs: 5000, retries: 0, animationOnly: true });
    await saveBroadcastMeta(ROOT, id, meta);
    json(res, { ok: true, id: Number(id), name: meta.name_cn,
      ...(meta.name ? { original_name: meta.name } : {}), ...(meta.date ? { date: meta.date } : {}),
      eps: meta.eps > 0 ? meta.eps : null }, 200, req);
  } catch (error) {
    const message = error.status === 404 ? 'Bangumi 找不到这个条目。' : error.code === 'subject_type' ?
      '这个链接指向的条目不是动画。' : '暂时连不上 Bangumi，可以手动填写番名和集数。';
    json(res, { error: message }, error.status === 404 ? 404 : error.code === 'subject_type' ? 400 : 502, req);
  }
}

async function searchSeasonCatalog(query, offset) {
  const quarters = await listCachedSeasons(ROOT);
  const snapshots = await Promise.all(quarters.map(q => readSeasonCache(ROOT, q)));
  const matches = new Map();
  for (const season of snapshots) {
    for (const item of season?.items || []) {
      if (matchesSearch(item, query) && !matches.has(String(item.id)))
        matches.set(String(item.id), { ...item, season: season.q });
    }
  }
  const items = [...matches.values()].slice(offset, offset + 12);
  return { items, next: offset + items.length < matches.size ? offset + items.length : null };
}

async function apiAnimeSearch(req, res) {
  if (req.method !== 'GET') return json(res, { error: 'use GET' }, 405, req);
  if (!guardWrite(req, res)) return;
  const params = new URL(req.url, 'http://localhost').searchParams;
  const query = (params.get('q') || '').trim();
  const offset = Number(params.get('offset') ?? 0);
  if (query.length > 100 || !titleKey(query) || !Number.isSafeInteger(offset) || offset < 0 || offset > 1200)
    return json(res, { error: '请输入 1–100 字的番名，或缩小搜索范围' }, 400, req);
  const lib = await readLibrary(ROOT);
  const local = params.get('local') === '1';
  let items, next, warning;
  if (local) {
    ({ items, next } = await searchSeasonCatalog(query, offset));
  } else try {
    const cfg = await readBgmConfig();
    const options = { base: cfg.base, proxy: cfg.proxy, timeoutMs: 5000, retries: 0, offset };
    try { ({ items, next } = await searchAnime(query, options)); }
    catch (error) {
      if (!cfg.token || ![401, 403].includes(error.status)) throw error;
      ({ items, next } = await searchAnime(query, { ...options, token: cfg.token }));
    }
  } catch (error) {
    warning = [401, 403].includes(error.status) ? 'Bangumi 拒绝搜索请求。可检查账号设置、查看本地缓存或手动添加。' :
      'Bangumi 搜索暂不可用。可查看本地缓存或手动添加。';
    ({ items, next } = await searchSeasonCatalog(query, offset));
  }
  const candidates = items.map(item => {
    const id = coverIdOf(item.id);
    const image = id && pickCoverUrl([item], id);
    if (image) {
      searchCoverUrls.delete(id);
      searchCoverUrls.set(id, image);
      if (searchCoverUrls.size > 256) searchCoverUrls.delete(searchCoverUrls.keys().next().value);
    }
    return { id: item.id, name: item.name_cn || item.name, original_name: item.name || '', date: item.date || '',
      platform: item.platform || '', eps: item.eps > 0 ? item.eps : null,
      cover: id && (item.season || image) ? '/cover/' + id + '.jpg' + (item.season ? '?local=1' : '') : null,
      ...(item.season ? { season: item.season, weekday: item.weekday, broadcast_end: item.broadcast_end } : {}),
      duplicates: libraryMatches(lib, item) };
  });
  json(res, { ok: true, candidates, next: next > 1200 ? null : next, warning }, 200, req);
}

async function apiSeasonAiring(req, res) {
  if (req.method !== 'GET') return json(res, { error: 'use GET' }, 405, req);
  const q = new URL(req.url, 'http://127.0.0.1').searchParams.get('q');
  if (!/^\d{4}Q[1-4]$/.test(q || '')) return json(res, { error: '季度无效' }, 400, req);
  const cached = await readSeasonCache(ROOT, q);
  const ids = (cached?.items || []).map(item => String(item.id));
  const config = await readBgmConfig();
  let suggestions = {}, warning = '';
  if (ids.length) {
    try { suggestions = await broadcastSuggestions(ROOT, ids, { online: true, proxy: config.proxy }); }
    catch { warning = '暂时无法刷新分钟级排期'; }
  }
  const lib = await readLibrary(ROOT);
  const tracked = new Map([...(lib.watching || []), ...(lib.paused || []), ...(lib.archived || [])].map(w => [String(w.id), w]));
  const inactive = inactiveWatchIds(lib);
  for (const id of ids) {
    if (inactive.has(id) || (tracked.has(id) && (isWatchFinished(tracked.get(id)) || isCatchup(tracked.get(id))))) {
      delete suggestions[id]; continue;
    }
    const w = tracked.get(id);
    if (!w) continue;
    const saved = watchAiring(watchDetail(lib, w), w.start_date);
    if (saved) suggestions[id] = saved;
    else if (w.schedule_manual || w.schedule_ended) delete suggestions[id];
  }
  json(res, { ok: true, airings: suggestions, warning }, 200, req);
}

/**
 * POST /api/season/apply {q, add:[ids], remove:[ids], track_from?, items?:[...]}
 *
 * 关键修复：以前 q 缺省就按「当前季」匹配，而面板跨季勾选时没传 q —— 于是服务端拿
 * 当前季的 items 去查一部上季番，查不到就按 `String(id)` 造名字，写进库后
 * name_cn="363957"、air_weekday=null，三个页面都看不见（数据脏了还不好找）。
 * 现在：q 必须能解析；add 里查不到元数据的 id 一律拒绝并回 missing 清单。
 */
async function apiSeasonApply(req, res) {
  if (!guardWrite(req, res)) return;
  if (req.method !== 'POST') return json(res, { ok: false, error: 'use POST' }, 405, req);
  const body = await readJsonBody(req, res);
  if (!body) return;   // 坏 JSON / 超限已经回过响应，别再往下走（以前就是这里让进程 exit 1）

  const add = Array.isArray(body.add) ? body.add.map(String).filter(Boolean) : [];
  // 兼容 items 形式：把名字一起带进来（面板本季页就是这么传的）
  const inlineItems = [];
  if (Array.isArray(body.items)) {
    for (const it of body.items) {
      if (!it) continue;
      const id = String(it.id ?? it);
      if (!id || id === 'undefined' || id === 'null') continue;
      inlineItems.push({ ...(typeof it === 'object' ? it : { id }), id });
      if (!add.includes(id)) add.push(id);
    }
  }
  const remove = Array.isArray(body.remove) ? body.remove.map(String).filter(Boolean) : [];
  if (body.mode != null && !['planned', 'airing', 'catchup'].includes(body.mode))
    return json(res, { error: '观看方式无效' }, 400, req);
  if (body.mode === 'planned' && body.start_mode != null)
    return json(res, { error: '开始观看后再设置进度' }, 400, req);
  if (body.start_mode != null && !WATCH_STARTS.includes(body.start_mode)) return json(res, { error: '补番起点无效' }, 400, req);
  if (body.start_mode === 'seen' && (!Number.isSafeInteger(body.seen) || body.seen < 0)) return json(res, { error: '请填写已看到第几话' }, 400, req);
  if (!add.length && !remove.length) return json(res, { ok: false, error: 'add / remove 都是空的' }, 400, req);

  let q = null;
  if (body.q) {
    try {
      q = seasonOf(body.q);
    } catch (e) {
      return json(res, { ok: false, error: String(e.message || e), q: body.q, hint: '季度写成 2026Q4 这种' }, 400, req);
    }
  }
  const cache = q ? await readSeasonCache(ROOT, q) : null;
  // 传了 q 就必须拿得到那一季的表，否则无从校验 id，宁可不写
  if (add.length && q && !cache) {
    return json(res, { ok: false, error: `还没有 ${q} 的番剧表，先在「本季」页刷新一次`, q }, 409, req);
  }
  const items = [...(cache?.items || []), ...inlineItems];
  const known = new Set(items.map((x) => String(x.id)));
  const missing = add.filter((id) => !known.has(id));
  const usable = add.filter((id) => known.has(id));
  if (add.length && !usable.length) {
    return json(res, { ok: false, error: '这些 id 在本季表里找不到，没有写入（避免写出只有 id 的脏条目）', missing }, 400, req);
  }
  const airings = body.start_mode === 'latest'
    ? { ...await broadcastSuggestions(ROOT, usable, { online: false }).catch(() => ({})), ...seasonAirings(items) } : {};
  const usableIds = new Set(usable);
  const candidates = items.filter(item => usableIds.has(String(item.id)));
  const classified = [];
  for (let i = 0; i < candidates.length; i += 4) {
    const states = await Promise.all(candidates.slice(i, i + 4).map(async item => [String(item.id),
      await showBroadcastStatus(String(item.id), { meta: item })]));
    classified.push(...states);
  }
  const ended = new Set(classified.filter(([, status]) => status.state === 'ended').map(([id]) => id));

  const outcome = await withWriteLock(async () => {
    const lib = await readLibrary(ROOT);
    const { next, changes, skipped } = mergeSeason(lib, items, {
      add: usable,
      remove,
      track_from: body.track_from || cstParts().date,
      now: new Date(),
      start_mode: body.start_mode,
      seen: body.seen,
      airings,
      ended,
      mode: body.mode,
    });
    if (!changes.length) return { code: 200, payload: { ok: true, q, added: 0, changes: 0, detail: [], missing, skipped } };
    await saveLibrary(next, { source: 'season:apply' });
    for (const c of changes) {
      await appendHistory({ ts: new Date().toISOString(), date: cstParts().date, event: 'season', ...c });
    }
    return {
      code: 200,
      payload: {
        ok: true,
        q,
        // added 是「新进在追的部数」（面板拿它报「加了 N 部」），别把 weekday 那条也算进去；
        // changes 保留字段级 diff 条数，两个数字用途不同。
        added: changes.filter((c) => ['watching', 'planned'].includes(c.scope) && (c.field === '(新增)' || c.field === '(恢复)')).length,
        changes: changes.length,
        detail: changes.slice(0, 20),
        missing,
        skipped,
      },
      write: true,
    };
  });
  if (outcome.write) {
    const rebuilt = await rebuildToday();
    outcome.payload = { ...outcome.payload, ...rebuildInfo(rebuilt) };
  }
  json(res, outcome.payload, outcome.code, req);
}

/**
 * 周表瘦身：面板只用 id / 名字 / 时刻三样，其余（note、alias、tags、meta…）
 * 在「本季」页从 season 缓存拿。整周 119 条 × 多余字段 = 白传 8 KB。
 */
function slimWeek(weekday) {
  const out = {};
  for (const [d, list] of Object.entries(weekday)) {
    out[d] = (Array.isArray(list) ? list : []).map((x) => {
      // 只发面板真用得到、且非空的字段：空值也占 key 的字节，119 条就是 1–2 KB
      const o = { id: x.id };
      const name = x.name_cn || x.name || '';
      if (name) o.name_cn = name;
      if (x.time_cst) o.time_cst = x.time_cst;
      if (x.next_day_note) o.next_day_note = x.next_day_note;
      return o;
    });
  }
  return out;
}


async function apiSeasonSubject(req, res) {
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  const body = await readJsonBody(req, res);
  if (!body) return;   // 坏 JSON / 超限已经回过响应，别再往下走（以前就是这里让进程 exit 1）
  const id = Number(body.id);
  if (!id) return json(res, { error: 'missing id' }, 400, req);
  const cfg = await readBgmConfig();
  try {
    const meta = await fetchSubject(id, { proxy: cfg.proxy, base: cfg.base });
    json(res, { ok: true, ...meta }, 200, req);
  } catch (e) {
    json(res, { ok: false, error: String(e.message || e) }, 502, req);
  }
}

/** 手填时刻的单条、批量接口共用同一套校验和写库逻辑。 */
async function apiSeasonTime(req, res, batch = false) {
  if (!guardWrite(req, res)) return;
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  const body = await readJsonBody(req, res);
  if (!body) return;
  const ids = batch ? (Array.isArray(body.ids) ? body.ids : []) : [body.id];
  const want = [...new Set(ids.filter(id => id != null && id !== '').map(String))];
  if (!want.length || want.length > 500) return json(res, { error: '请选择 1–500 部在追番剧' }, 400, req);
  const rawTime = body.time_cst ?? body.time ?? '';
  const initial = parseWatchSlot(body.weekday ?? 1, rawTime);
  if (initial.error) return json(res, { error: initial.error }, 400, req);
  const outcome = await withWriteLock(async () => {
    const lib = await readLibrary(ROOT);
    const changed = [], missing = [], needs_weekday = [];
    const active = new Map((lib.watching || []).filter(w => !isCatchup(w)).map(w => [String(w.id), w]));
    for (const id of want) {
      const w = active.get(id);
      if (!w) { missing.push(id); continue; }
      const previous = scheduleRow(lib, w);
      const day = body.weekday ?? (previous?.day || Number(w.air_weekday) || null);
      const slot = parseWatchSlot(day, rawTime);
      if (slot.error) { needs_weekday.push(id); continue; }
      if (slot.time === (previous ? previous.row.time_cst || null : w.air_time_cst || null) &&
          (slot.day === null || previous?.day === slot.day) && w.schedule_manual) continue;
      setWatchSlot(lib, w, slot);
      changed.push(id);
    }
    if (!batch && missing.length) return { code: 404, payload: { error: '只能批量调整在追番剧，暂停番请从详情修改' } };
    if (!batch && needs_weekday.length) return { code: 400, payload: { error: '请先在详情里选择开播星期' } };
    if (changed.length) await saveLibrary(lib, { source: batch ? 'season:time-batch' : 'season:time' });
    return { code: 200, payload: { ok: true, count: changed.length, changed, missing, needs_weekday, time_cst: initial.time }, write: changed.length > 0 };
  });
  if (outcome.write) Object.assign(outcome.payload, rebuildInfo(await rebuildToday()));
  json(res, outcome.payload, outcome.code, req);
}

/* ---------- 导出（.ics / Markdown）与统计 ---------- */

const pad2 = (n) => String(n).padStart(2, '0');

/** 未来 7 天要播的番（含 30h 制式换算后的归属日） */
function upcomingDays(lib, now, length = 7) {
  return scheduledWeek(lib, now, length).filter(day => day.rows.length).map(day => ({
    ...day, rows: day.rows.sort((a, b) => toMin(a.time_cst) - toMin(b.time_cst)),
  }));
}

/** Markdown 表格单元格：竖线和换行会直接把表拆坏 */
const mdCell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function calendarEvents(lib, plan, { since, length, kind, settings, alarmMin, personalOnly = false }) {
  const events = [];
  const watching = new Map((lib.watching || []).map(w => [String(w.id), w]));
  const tracked = new Set((lib.watching || []).filter(w => !isWatchFinished(w) && !isCatchup(w) && !w.schedule_ended).map(w => String(w.id)));
  function alarmFields(id, date, time) {
    const entry = watching.get(String(id));
    const lead = reminderOverride(entry?.reminder_lead) ?? alarmMin;
    const slot = Date.parse(date + 'T00:00:00+08:00') + toMin(time) * 60000;
    return { alarmMin: lead, noAlarm: !!entry?.reminder_muted || reminderTiming(slot, settings, lead).quiet };
  }
  if (kind !== 'catchup') for (const day of plan) {
    for (const r of day.rows) {
      if (!r.time_cst || (personalOnly && !tracked.has(String(r.id)))) continue;
      events.push({
        uid: `kx-${r.original_at ? cstParts(new Date(r.original_at)).date : day.date}-${r.id}@tiara.local`,
        date: day.date,
        time: r.time_cst,
        summary: `${r.name_cn || r.id}${typeof r.ep_expected === 'number' ? ` 第${r.ep_expected}话` : ''}`,
        description: 'TIARA · 开播排期（含手动时刻和临时改期） · 北京时间 UTC+8',
        ...alarmFields(r.id, day.date, r.time_cst),
      });
    }
  }
  if (kind !== 'airing') {
    for (const slot of catchupReminders(lib, since)) {
      for (let at = Date.parse(slot.at); at < +since + length * 86400000; at += 7 * 86400000) {
        const { date, hour, minute } = cstParts(new Date(at));
        const time = pad2(hour) + ':' + pad2(minute);
        events.push({ uid: `catchup-${date}-${slot.id}@tiara.local`, date, time,
          summary: '补番 · ' + slot.name, description: 'TIARA · 个人补番提醒 · 北京时间 UTC+8',
          ...alarmFields(slot.id, date, time) });
      }
    }
  }
  return events.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
}

async function apiCalendarFeed(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, { error: 'use GET or HEAD' }, 405, req);
  if (!guardWrite(req, res)) return;
  const feed = await withWriteLock(async () => {
    const file = path.join(ROOT, 'cache', 'calendar-feed.json');
    const previous = await readJsonFile(file).catch(() => []);
    const lib = await readLibrary(ROOT);
    const now = new Date();
    const start = cstParts(now).date;
    const since = new Date(start + 'T00:00:00+08:00');
    const settings = await readSettings();
    const alarmMin = reminderLead(settings);
    const events = calendarEvents(lib, upcomingDays(lib, since, FEED_DAYS), {
      since, length: FEED_DAYS, kind: 'both', settings, alarmMin, personalOnly: true,
    }).map(({ noAlarm, alarmMin, ...event }) => event);
    const refreshed = refreshCalendarFeed(previous, events, { start, now });
    if (JSON.stringify(previous) !== JSON.stringify(refreshed.stored)) await writeJsonAtomic(file, refreshed.stored);
    return refreshed;
  });
  const headers = { 'Content-Type': 'text/calendar; charset=utf-8', ETag: feed.etag, 'Cache-Control': 'private, max-age=0, must-revalidate' };
  const tags = (req.headers['if-none-match'] || '').split(',').map(tag => tag.trim().replace(/^W\//, ''));
  if (tags.includes(feed.etag) || tags.includes('*')) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : feed.text);
}

async function apiScheduleBoard(req, res) {
  if (req.method !== 'GET') return json(res, { error: 'use GET' }, 405, req);
  const library = await readLibrary(ROOT);
  const now = new Date();
  const { date } = cstParts(now);
  const entries = (library.watching || []).filter(item => !isWatchFinished(item));
  const activeAiring = new Map(entries.filter(item => !item.schedule_ended && !isCatchup(item)).map(item => [String(item.id), item]));
  const rows = [];
  for (const day of upcomingDays(library, now)) {
    for (const row of day.rows) {
      const entry = activeAiring.get(String(row.id));
      if (!entry) continue;
      const time = row.time_cst || null;
      const minute = timeToMinutes(time);
      const stamp = minute == null ? NaN : Date.parse(day.date + 'T00:00:00+08:00') + minute * 60000;
      rows.push({
        id: String(row.id), date: day.date, time, name: entry.name_cn || row.name_cn || String(row.id), kind: 'airing',
        at: Number.isFinite(stamp) ? stamp : null, episode: Number.isInteger(row.ep_expected) ? row.ep_expected : null,
      });
    }
  }
  const until = Date.parse(date + 'T00:00:00+08:00') + 7 * 86400000;
  for (const slot of catchupReminders(library, new Date(date + 'T00:00:00+08:00'))) {
    const at = Date.parse(slot.at);
    if (!Number.isFinite(at) || at >= until) continue;
    const parts = cstParts(new Date(at));
    rows.push({ at, date: parts.date, time: pad2(parts.hour) + ':' + pad2(parts.minute), name: slot.name, kind: 'catchup' });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '99:99').localeCompare(b.time || '99:99') || a.name.localeCompare(b.name));
  const next = rows.find(row => row.at != null && row.at > +now) || null;
  if (next?.kind === 'airing' && next.episode == null)
    next.episode = expectedEpisode(activeAiring.get(next.id), library, new Date(next.at));
  return json(res, { ok: true, date, next, rows }, 200, req);
}

async function apiExport(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const fmt = (u.searchParams.get('fmt') || 'ics').toLowerCase();
  if (!['ics', 'md'].includes(fmt)) return json(res, { error: '请选择 ICS 或 Markdown' }, 400, req);
  let lib;
  try {
    lib = await readLibrary(ROOT);
  } catch (e) {
    // 以前这里没兜底，读库失败时浏览器直接跳一坨 JSON 错误页
    return json(res, { ok: false, error: String(e.message || e), hint: '先看看 data/library.json 还在不在' }, 500, req);
  }
  const now = new Date();
  const start = u.searchParams.get('from') || cstParts(now).date;
  const end = u.searchParams.get('to') || cstParts(new Date(Date.parse(start + 'T00:00:00+08:00') + 6 * 86400000)).date;
  const kind = u.searchParams.get('kind') || 'airing';
  const alarm = u.searchParams.get('alarm');
  const length = (Date.parse(end) - Date.parse(start)) / 86400000 + 1;
  if (!validHistoryDate(start) || !validHistoryDate(end) || !Number.isSafeInteger(length) || length < 1 || length > 93 ||
      !['airing', 'catchup', 'both'].includes(kind) || alarm !== null && alarm !== '0' && alarm !== '1')
    return json(res, { error: '请选择有效日期（最多 93 天）、排片类型和闹铃选项' }, 400, req);
  const since = new Date(start + 'T00:00:00+08:00');
  const plan = upcomingDays(lib, since, length);
  const settings = await readSettings();

  if (fmt === 'md') {
    const lines = ['# TIARA的本周番组', '', `> 生成于 ${cstParts(now).date} ${pad2(cstParts(now).hour)}:${pad2(cstParts(now).minute)}（CST）`, ''];
    for (const day of plan) {
      lines.push(`## ${day.date}（${'一二三四五六日'[day.weekday - 1]}）`, '');
      lines.push('| 时间 | 番名 | 话 |', '| --- | --- | --- |');
      for (const r of day.rows) {
        lines.push(`| ${mdCell(r.time_cst || '未定')} | ${mdCell(r.name_cn || r.id)} | ${typeof r.ep_expected === 'number' ? r.ep_expected : '-'} |`);
      }
      lines.push('');
    }
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      // 旧的写法把 filename* 塞进了 filename 的引号里，等于两个参数都废掉
      'Content-Disposition': `attachment; filename="tiara-week.md"; filename*=UTF-8''${encodeURIComponent('本周番组.md')}`,
      ...corsHeaders(req),
    });
    return res.end('\ufeff' + lines.join('\n'));
  }

  // 事件拼装交给 lib/ics.mjs（纯函数、有单测）；这里只负责把周表映射成事件
  const alarmMin = settings.reminder_lead === undefined && alarm === null ? 10 : reminderLead(settings);
  const events = calendarEvents(lib, plan, { since, length, kind, settings, alarmMin });
  res.writeHead(200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `attachment; filename="tiara-${start}.ics"`,
    ...corsHeaders(req),
  });
  return res.end(buildIcs(events, { now, calName: 'TIARA 的排片和提醒', durationMin: 30, alarmMin, includeAlarm: alarm !== '0' }));
}

function catchupWeekFromRows(rows, settings, now) {
  const { date } = cstParts(now);
  const monday = cstParts(watchWeekStart(now)).date;
  const goal = Number.isInteger(settings.catchup_goal) ? settings.catchup_goal : 0;
  let watched = 0;
  for (const row of rows) {
    if (row.watch_mode !== 'catchup' || row.date < monday || row.date > date || !row.date) continue;
    watched += watchHistoryDelta(row);
  }
  return { goal, watched, monday };
}

async function catchupWeek(library, settings, now) {
  try {
    return catchupWeekFromRows(await readHistoryRows(library), settings, now);
  } catch (error) {
    logLine('warn', '补番周统计无法读取观看记录: ' + (error.code || error.name));
    return { ...catchupWeekFromRows([], settings, now), watched: null };
  }
}

/** GET /api/stats → 连续追番天数 / 本周看完 / 累计 */
async function apiStats(req, res) {
  const library = await readLibrary(ROOT).catch(() => ({}));
  let rows;
  try { rows = await readHistoryRows(library); }
  catch { return json(res, { ok: false, error: '观看历史暂时无法读取，统计不可用' }, 503, req); }

  let weekCount = 0;
  let total = 0;
  const byDay = new Map();
  const now = new Date();
  const today = cstParts(now).date;
  const monday = cstParts(watchWeekStart(now)).date;
  for (const r of rows) {
    const delta = watchHistoryDelta(r);
    if (!delta || !validHistoryDate(r.date) || r.date > today) continue;
    total += delta;
    byDay.set(r.date, (byDay.get(r.date) || 0) + delta);
    if (r.date >= monday) weekCount += delta;
  }
  const days = new Set([...byDay].filter(([, count]) => count > 0).map(([date]) => date));
  // 最近 14 天，从 13 天前排到今天
  const spark = [];
  for (let i = 13; i >= 0; i--) {
    const d = cstParts(new Date(+now - i * 86400e3)).date;
    spark.push({ date: d, n: byDay.get(d) || 0 });
  }
  let finished = 0;
  try {
    const lib = library;
    for (const w of [...(lib.watching || []), ...(lib.paused || []), ...(lib.archived || [])]) {
      if (isWatchFinished(w)) finished += 1;
    }
  } catch { finished = 0; }
  let streak = 0;
  let off = days.has(today) ? 0 : 1; // 今天还没看就从昨天开始数
  for (; off < 400; off++) {
    const d = cstParts(new Date(+now - off * 86400e3)).date;
    if (!days.has(d)) break;
    streak += 1;
  }
  json(res, { ok: true, streak, week: weekCount, total, days: days.size, finished, byDay: spark }, 200, req);
}

async function apiWatchReport(req, res) {
  if (req.method !== 'GET') return json(res, { error: 'use GET' }, 405, req);
  if (!guardWrite(req, res)) return;
  const param = new URL(req.url, 'http://localhost').searchParams.get('week');
  if (param && (!validHistoryDate(param) || param > cstParts().date))
    return json(res, { error: '请选择今天或更早的有效日期' }, 400, req);
  return withWriteLock(async () => {
    const library = await readLibrary(ROOT);
    const rows = await readHistoryRows(library);
    json(res, { ok: true, ...watchWeekReport(library, rows, param) }, 200, req);
  });
}

async function apiEpisodeCatalog(req, res) {
  if (req.method !== 'GET') return json(res, { error: 'use GET' }, 405, req);
  const q = new URL(req.url, 'http://localhost').searchParams;
  const id = q.get('id');
  if (!relationId(id)) return json(res, { error: '没有可查询的 Bangumi 条目编号' }, 400, req);
  if (!findWatchEntry(await readLibrary(ROOT), id)) return json(res, { error: '找不到这部番' }, 404, req);
  let cached = await readEpisodeCatalog(ROOT, id);
  let offline = false;
  if (q.get('refresh') === '1') {
    const config = await readBgmConfig();
    try { cached = await refreshEpisodeCatalog(ROOT, id, config); } catch { offline = true; }
  }
  json(res, { ok: true, chapters: cached?.items || [], fetched_at: cached?.fetched_at || null,
    warning: offline ? '连不上 Bangumi。可使用现有缓存或继续按集数记账。' : null }, 200, req);
}

// ---------------- /api/logs ----------------
/** 面板「诊断」面板读它：只回最近 N 行，默认 200，最多 1000。 */
async function readLogTail(tail) {
  const out = [];
  let budget = tail;
  for (const file of [LOG_PATH + '.1', LOG_PATH]) {
    if (budget <= 0) break;
    let text = '';
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n').filter(Boolean);
    const take = lines.slice(Math.max(0, lines.length - budget));
    budget -= take.length;
    out.unshift(...take);
  }
  return out;
}

async function apiLogs(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const tail = Math.min(1000, Math.max(1, Number(u.searchParams.get('tail')) || 200));
  const lines = await readLogTail(tail);
  let size = 0;
  try {
    size = (await fs.stat(LOG_PATH)).size;
  } catch { /* 还没写过日志 */ }
  json(res, { ok: true, path: path.relative(ROOT, LOG_PATH), size, lines }, 200, req);
}

/**
 * GET /api/say?tab=... → 随机一句台词（服务端挑、服务端填占位符）
 *
 * 以前把整个 data/talks.json（5.6 KB、28 个池）塞进 /api/state 让前端挑一句，
 * 占位符替换也在前端做，{names}/{count} 这种还得前端自己拼。挪到这里更省也更准。
 */
async function apiSay(req, res) {
  let lib;
  let talks;
  try {
    lib = await readLibrary(ROOT);
    talks = await readJSON('data/talks.json');
  } catch (e) {
    return json(res, { ok: false, error: String(e.message || e) }, 500, req);
  }
  const now = new Date();
  const t = buildToday(lib, now, { clock: (await readSettings()).clock });
  const nick = lib.user?.nickname_for_pet || '主人';
  const skip = new Set(['remind', 'midnight']);
  // ?pool=bump 只从那个池里抽 —— 调台词时不用开桌宠等它随机挑
  const wantPool = new URL(req.url, 'http://127.0.0.1').searchParams.get('pool');
  if (wantPool && !Array.isArray(talks[wantPool])) {
    return json(res, { ok: false, error: `没有这个台词池：${wantPool}`, pools: Object.keys(talks) }, 404, req);
  }
  const lines = [];
  for (const [k, pool] of Object.entries(talks)) {
    if (skip.has(k) || !Array.isArray(pool)) continue;
    if (wantPool && k !== wantPool) continue;
    // 记下来自哪个池：面板调试时能看出「这句是从 random 还是 nade 里挑的」
    for (const l of pool) if (l && l.text) lines.push({ ...l, _pool: k });
  }
  if (!lines.length) return json(res, { ok: false, error: 'talks.json 里没有可用台词' }, 404, req);
  const l = lines[Math.floor(Math.random() * lines.length)];
  const text = String(l.text)
    .replace(/\{nickname\}/g, nick)
    .replace(/\{weekday_cn\}/g, t.weekday_cn)
    .replace(/\{date\}/g, t.date)
    .replace(/\{count\}/g, String(t.today.length))
    .replace(/\{behind\}/g, String(t.behindAll?.[0]?.behind ?? 0))
    .replace(/\{summary\}/g, summarize(t, lib))
    .replace(/\{names\}/g, t.today.map((s) => s.name_cn || s.name).join('、'))
    .replace(/\{name_cn\}/g, t.today[0]?.name_cn || t.today[0]?.name || '')
    .replace(/\{time_cst\}/g, t.today[0]?.time_cst || '');
  json(res, { ok: true, text, face: l.face ?? 0, pool: l._pool || '' }, 200, req);
}

// ---------------- /api/version + /api/health ----------------
/**
 * GET /api/version → 面板「诊断」看版本与各文件 mtime。
 * 以前只回 mtime 和 root 绝对路径：面板显示不出「你用的是哪个版本」，
 * 而把本机绝对路径回给浏览器也没必要（还会被截图带出去）。
 */
async function apiVersion(req, res) {
  const files = {};
  for (const rel of ['server.mjs', 'panel/index.html', 'pet/Pet.exe', 'data/library.json', 'data/talks.json']) {
    files[rel] = await mtime(rel);
  }
  const running = await desktopPresence();
  json(res, {
    ok: true,
    app: APP_ID,
    version: VERSION,
    installed_version: (await readJSON('package.json').catch(() => null))?.version || VERSION,
    install_path: ROOT,
    desktop: running && { pid: running.pid, version: running.version },
    desktop_path: running?.path || null,
    server_path: fileURLToPath(import.meta.url),
    launch: await launchDiagnostics(ROOT),
    pid: process.pid,
    started: STARTED_AT,
    port: PORT,
    today_txt: await exists('ghost/master/today.txt'),
    files,
  }, 200, req);
}

async function desktopPresence() {
  const pet = await readJSON('cache/pet-presence.json').catch(() => null);
  if (!pet || !Number.isSafeInteger(pet.pid) || pet.pid <= 0 ||
      !Number.isFinite(pet.at) || Math.abs(Date.now() / 1000 - pet.at) > 100) return null;
  try { process.kill(pet.pid, 0); } catch { return null; }
  return { pid: pet.pid, version: typeof pet.version === 'string' ? pet.version : null,
    path: typeof pet.path === 'string' && path.isAbsolute(pet.path) ? pet.path : null,
    autostart: typeof pet.autostart === 'string' && path.isAbsolute(pet.autostart) ? pet.autostart : null,
    startup_known: Object.hasOwn(pet, 'autostart') };
}

const readReminderState = () => readJSON('data/state.json').catch(() => null);

function previewWatchReminder(library, detail, entry, settings, state, now, snoozes, pet) {
  const scheduled = isCatchup(detail) || scheduleRow(library, entry);
  const forecast = reminderPreview(scheduled ? detail : { ...detail, air_weekday: null, air_time_cst: null, schedule_adjustments: [] }, settings, {
    since: entry.start_date, state: detail.state, now, quietUntil: state?.quiet_until, snoozes,
    scanned: new Set(Array.isArray(state?.reminded) ? state.reminded : []),
  });
  const focus_until = Number.isSafeInteger(state?.focus_until) && state.focus_until * 1000 > +now ? state.focus_until : null;
  const queued = Array.isArray(state?.pending_reminders) ? state.pending_reminders.filter(item => item?.Id === detail.id).length : 0;
  return { ...forecast, desktop_online: Boolean(pet), tray_only: state?.reminder_tray_only === true,
    focus: Boolean(pet && (state?.focus_paused_seconds > 0 || focus_until * 1000 > Date.parse(forecast.next?.at))), queued };
}

async function apiReminderPreview(req, res) {
  if (!guardWrite(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST') return json(res, { error: 'use GET or POST' }, 405, req);
  const body = req.method === 'POST' ? await readJsonBody(req, res) :
    { id: new URL(req.url, 'http://localhost').searchParams.get('id') };
  if (!body) return;
  const settingsPatch = body.settings ?? {};
  const override = body.watch;
  if (typeof settingsPatch !== 'object' || Array.isArray(settingsPatch) ||
      (override !== undefined && (!override || !validReminderOverride(override.lead) || typeof override.muted !== 'boolean')))
    return json(res, { error: '提醒预览参数无效' }, 400, req);
  const error = reminderSettingsError(settingsPatch);
  if (error) return json(res, { error }, 400, req);
  const now = new Date();
  const [library, saved, state, pet] = await Promise.all([readLibrary(ROOT), readSettings(), readReminderState(), desktopPresence()]);
  const targets = (library.watching || []).filter(entry => !isWatchFinished(entry)).map(entry => ({
    id: String(entry.id), name: entry.name_cn || entry.name || String(entry.id),
  }));
  const id = body.id ?? targets[0]?.id;
  if (!id) return json(res, { ok: true, settings: saved, targets, preview: null }, 200, req);
  const target = findWatchEntry(library, id);
  if (!target) return json(res, { error: '找不到这部番，请重新选择' }, 404, req);
  const detail = watchDetail(library, target.entry, target.state);
  const { pending } = await reminderSnoozes(ROOT, library, null, Math.floor(+now / 1000));
  if (override) {
    detail.reminder_lead = override.lead;
    detail.reminder_muted = override.muted;
  }
  const settings = { ...saved, ...settingsPatch };
  const preview = previewWatchReminder(library, detail, target.entry, settings, state, now, pending, pet);
  return json(res, { ok: true, settings: saved, targets, preview: { ...preview, id: detail.id, name: detail.name } }, 200, req);
}

async function apiStartupPath(req, res) {
  if (req.method !== 'GET') return json(res, { error: 'use GET' }, 405, req);
  if (!guardWrite(req, res)) return;
  const pet = await desktopPresence();
  if (!pet?.startup_known) return json(res, { ok: true, available: false }, 200, req);
  const exists = pet.autostart ? await fs.access(pet.autostart).then(() => true, () => false) : null;
  json(res, { ok: true, available: true, current: pet.path, startup: pet.autostart, exists,
    same: !!pet.path && pet.autostart?.toLowerCase() === pet.path.toLowerCase() }, 200, req);
}

async function apiPanelRevision(req, res) {
  if (req.method !== 'GET') return json(res, { error: 'use GET' }, 405, req);
  const files = await Promise.all(['data/library.json', 'data/settings.json', 'data/history.jsonl']
    .map(file => fs.stat(path.join(ROOT, file)).then(stat => [stat.mtimeMs, stat.size, stat.ino]).catch(() => null)));
  return json(res, { ok: true, revision: hash(JSON.stringify(files)), version: VERSION }, 200, req);
}

async function apiDiagnosticsReport(req, res) {
  if (req.method !== 'GET') return json(res, { error: 'use GET' }, 405, req);
  if (!guardWrite(req, res)) return;
  const [launch, desktop, config, sync] = await Promise.all([
    launchDiagnostics(ROOT), desktopPresence(), readBgmConfig(),
    readJSON('cache/bgm/sync-success.json').catch(() => null),
  ]);
  const checkedTime = typeof sync?.at === 'string' && Number.isFinite(Date.parse(sync.at))
    ? new Date(sync.at).toISOString() : null;
  const version = await readJSON('package.json').catch(() => null);
  const installed = /^\d+\.\d+\.\d+$/.test(version?.version || '') ? version.version : null;
  json(res, { ok: true,
    startup: { server_version: VERSION, installed_version: installed,
      desktop_running: Boolean(desktop), desktop_version: /^\d+\.\d+\.\d+$/.test(desktop?.version || '') ? desktop.version : null,
      launcher_present: launch.script.exists, launcher_target_present: launch.script.binary?.exists ?? null,
      launcher_target_version: launch.script.binary?.version ?? null, desktop_file_version: launch.binary.version,
      runtime: process.versions.node },
    sync: { configured: Boolean(config.token), proxy_enabled: Boolean(config.proxy), last_success_at: checkedTime },
  }, 200, req);
}

async function apiReminderTest(req, res) {
  if (!guardWrite(req, res)) return;
  if (req.method === 'GET') {
    const id = new URL(req.url, 'http://localhost').searchParams.get('id');
    const ack = await readJSON('cache/reminder-test-result.json').catch(() => null);
    return json(res, { ok: true, delivered: Boolean(id && ack?.id === id) }, 200, req);
  }
  if (req.method !== 'POST') return json(res, { error: 'use GET or POST' }, 405, req);
  if (!(await desktopPresence())) return json(res, { error: '请启动这个安装目录中的新版桌宠，再试一次' }, 409, req);
  const id = randomBytes(16).toString('hex');
  await writeJsonAtomic(path.join(ROOT, 'cache/reminder-test.json'), { id, expires: Math.floor(Date.now() / 1000) + 12 });
  return json(res, { ok: true, id }, 200, req);
}

const REMINDER_ACTIONS = 'data/reminder-actions.json';
const REMINDER_HANDLED = new Set(['acknowledged', 'watch_clicked', 'details_opened', 'mark_clicked']);
const REMINDER_PRESENTED = new Set(['bubble', 'requested', 'unavailable']);
const REMINDER_WINDOW_SECONDS = 6 * 3600;

async function readReminderRows(file) {
  try {
    const rows = await readJSON(file);
    if (!Array.isArray(rows)) throw new Error('本机提醒记录的格式不正确');
    return rows;
  }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function reminderPending(event, library, now) {
  if (!REMINDER_PRESENTED.has(event.status) || REMINDER_HANDLED.has(event.action) || event.snooze ||
      !['airing', 'catchup', 'snooze'].includes(event.kind) || !Number.isSafeInteger(event.scheduled_at) ||
      (event.reminder_at || event.scheduled_at) < now - REMINDER_WINDOW_SECONDS) return null;
  const target = findWatchEntry(library, event.watch_id);
  if (target?.state !== 'watching') return null;
  const stamp = remindStamp(library, target.entry, target.state);
  if (!stamp || (event.source_stamp && event.source_stamp !== stamp)) return null;
  return { ...event, watch_url: watchUrl(target.entry.watch_url) || null,
    watch_revision: watchDetail(library, target.entry, target.state).revision };
}

async function reminderEntries(library, now, subject = null) {
  const [rows, actionRows, snoozes] = await Promise.all([
    readReminderRows('data/reminder-history.json'),
    readReminderRows(REMINDER_ACTIONS),
    reminderSnoozeStates(ROOT, now, library).catch(() => new Map()),
  ]);
  const actions = new Map(actionRows.filter(row => row && REMINDER_HANDLED.has(row.action) &&
    Number.isSafeInteger(row.action_at)).map(row => [row.key, row]));
  const known = new Set(['watching', 'paused', 'archived'].flatMap(key => (library[key] || []).map(w => String(w.id))));
  const events = rows.filter(row => row && typeof row.key === 'string' && Number.isSafeInteger(row.recorded_at) &&
    (subject === null || row.watch_id === subject))
    .slice(0, 200).map(({ key, kind, watch_id, name, scheduled_at, reminder_at, episode, recorded_at, status, reason, bubble, recovered, action, action_at, snoozed_until, source_stamp }) => {
      const source = ['airing', 'catchup'].includes(kind) && /^[a-f0-9]{24}$/.test(source_stamp || '');
      const snooze = source && snoozes.get(reminderSnoozeKey(watch_id, kind, scheduled_at, source_stamp));
      const handled = actions.get(key);
      const latestAction = handled && handled.action_at >= (action_at || 0) ? handled : { action, action_at };
      return { key, kind, watch_id, name, scheduled_at, recorded_at, status, bubble, recovered,
        action: latestAction.action, action_at: latestAction.action_at, snoozed_until,
        ...(typeof reason === 'string' ? { reason } : {}),
        ...(Number.isSafeInteger(reminder_at) && reminder_at > 0 ? { reminder_at } : {}),
        ...(Number.isSafeInteger(episode) && episode > 0 ? { episode } : {}),
        ...(source ? { source_stamp } : {}),
        ...(snooze ? { snooze } : {}),
        can_open: typeof watch_id === 'string' && known.has(watch_id) };
    });
  const pending = events.map(event => reminderPending(event, library, now)).filter(Boolean);
  return { events, pending, actionRows };
}

async function apiReminderHistory(req, res) {
  if (req.method !== 'GET') return json(res, { error: 'use GET' }, 405, req);
  if (!guardWrite(req, res)) return;
  const library = await readLibrary(ROOT).catch(() => ({}));
  const subject = new URL(req.url, 'http://localhost').searchParams.get('watch');
  const now = new Date();
  let entries;
  try { entries = await reminderEntries(library, Math.floor(+now / 1000), subject); }
  catch { return json(res, { error: '读不到本机提醒记录' }, 500, req); }
  const [desktop, state, settings] = await Promise.all([
    desktopPresence(), readJSON('data/state.json').catch(() => null), readSettings(),
  ]);
  const quiet_until = Number.isSafeInteger(state?.quiet_until) && state.quiet_until * 1000 > +now ? state.quiet_until : null;
  const mode = {
    scheduled_quiet: quietAt(settings, now), quiet_until,
    focus: Boolean(desktop && (state?.focus_until * 1000 > +now || state?.focus_paused_seconds > 0)),
    tray_only: state?.reminder_tray_only === true,
    queued: Array.isArray(state?.pending_reminders) ? state.pending_reminders.length : 0,
  };
  const queued = (mode.queued ? state.pending_reminders : []).filter(row => typeof row?.Name === 'string' &&
    Number.isSafeInteger(row.FireAt) && row.FireAt > +now / 1000 - REMINDER_WINDOW_SECONDS)
    .sort((a, b) => a.FireAt - b.FireAt).slice(0, 40)
    .map(row => ({ name: row.Name, reminder_at: row.FireAt }));
  return json(res, { ok: true, events: entries.events, pending: entries.pending, queued, desktop_online: Boolean(desktop), mode }, 200, req);
}

async function apiReminderAcknowledge(req, res) {
  if (!guardWrite(req, res)) return;
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  const input = await readJsonBody(req, res);
  if (!input) return;
  const { key, action } = input;
  if (typeof key !== 'string' || !key || key.length > 200 || !REMINDER_HANDLED.has(action))
    return json(res, { error: '提醒操作无效' }, 400, req);
  const handled = await withWriteLock(async () => {
    const now = Math.floor(Date.now() / 1000);
    const library = await readLibrary(ROOT);
    const { events, pending, actionRows } = await reminderEntries(library, now);
    const event = events.find(row => row.key === key);
    if (event && REMINDER_HANDLED.has(event.action)) return true;
    // 完结可能发生在网页刚记下最后一话时，此时仍要保存这次操作。
    if (!pending.some(row => row.key === key) &&
        !(action === 'mark_clicked' && event?.can_open && REMINDER_PRESENTED.has(event.status) &&
          event.recorded_at >= now - REMINDER_WINDOW_SECONDS)) return false;
    const next = [{ key, action, action_at: now }, ...actionRows.filter(row => row?.key !== key)].slice(0, 200);
    await writeJsonAtomic(path.join(ROOT, REMINDER_ACTIONS), next);
    return true;
  });
  return handled ? json(res, { ok: true }, 200, req)
    : json(res, { error: '这条提醒已变动，请刷新提醒中心' }, 409, req);
}

async function apiReminderSnoozes(req, res) {
  if (!guardWrite(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'POST') return json(res, { error: 'use GET or POST' }, 405, req);
  const input = req.method === 'POST' ? await readJsonBody(req, res) : null;
  if (req.method === 'POST' && !input) return;
  const result = await withWriteLock(async () => {
    const library = await readLibrary(ROOT);
    const now = Math.floor(Date.now() / 1000);
    if (input?.action === 'create' && input.event_key !== undefined) {
      const { events } = await reminderEntries(library, now);
      const event = events.find(row => row.key === input.event_key);
      const item = Array.isArray(input.items) && input.items.length === 1 ? input.items[0] : null;
      if (!event || !item || !REMINDER_PRESENTED.has(event.status) ||
          event.watch_id !== item.id || event.kind !== item.kind || event.scheduled_at !== item.slot_at ||
          event.source_stamp !== item.stamp || REMINDER_HANDLED.has(event.action))
        return { code: 409, error: '这条提醒已处理或变动，请刷新提醒中心' };
    }
    return reminderSnoozes(ROOT, library, input, now);
  });
  if (result.error) return json(res, { error: result.error }, result.code, req);
  return json(res, { ok: true, ...result }, 200, req);
}

// ---------------- 路由 ----------------
const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0] || '/'; // 面板带 ?v=xxx 刷新也要能命中路由
  try {
    if (recoveryIssue && req.method === 'POST' && url !== '/api/_shutdown') {
      return json(res, { ok: false, error: recoveryIssue.message, recovery: recoveryIssue }, 503, req);
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...corsHeaders(req),
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }

    if (url.startsWith('/api/state')) return await apiState(req, res);
    if (url === '/api/season/airing') return await apiSeasonAiring(req, res);
    if (url.startsWith('/api/season/apply')) return await apiSeasonApply(req, res);
    if (url.startsWith('/api/season/subject')) return await apiSeasonSubject(req, res);
    if (url === '/api/season/time-batch') return await apiSeasonTime(req, res, true);
    if (url === '/api/season/reference') return await apiSeasonReference(req, res);
    if (url.startsWith('/api/season/time')) return await apiSeasonTime(req, res);
    if (url.startsWith('/api/season')) return await apiSeason(req, res);
    if (url === '/api/token/test') return await apiToken(req, res, true);
    if (url === '/api/token') return await apiToken(req, res);
    if (url === '/api/export/ssp') return await apiPrivateSsp(req, res);
    if (url === '/api/calendar/feed.ics') return await apiCalendarFeed(req, res);
    if (url.startsWith('/api/export')) return await apiExport(req, res);
    if (url.startsWith('/api/stats')) return await apiStats(req, res);
    if (url === '/api/watch/report') return await apiWatchReport(req, res);
    if (url === '/api/watch/episodes') return await apiEpisodeCatalog(req, res);
    if (url.startsWith('/api/progress')) return await apiProgress(req, res);
    if (url.startsWith('/api/undo')) return await apiUndo(req, res);
    if (url === '/api/watch/detail') return await apiWatchDetail(req, res);
    if (url === '/api/catchup/subject') return await apiCatchupSubject(req, res);
    if (url === '/api/broadcast/status') return await apiBroadcastStatus(req, res);
    if (url === '/api/library/catchup-review') return await apiBroadcastStatus(req, res, true);
    if (url === '/api/anime/search') return await apiAnimeSearch(req, res);
    if (url === '/api/migration') return await apiMigration(req, res);
    if (url === '/api/release/latest') return await apiReleaseInfo(req, res);
    if (url === '/api/startup-path') return await apiStartupPath(req, res);
    if (url === '/api/panel-revision') return await apiPanelRevision(req, res);
    if (url === '/api/reminder/test') return await apiReminderTest(req, res);
    if (url === '/api/reminder/history') return await apiReminderHistory(req, res);
    if (url === '/api/reminder/preview') return await apiReminderPreview(req, res);
    if (url === '/api/reminder/watch') return await apiWatchReminder(req, res);
    if (url === '/api/reminder/acknowledge') return await apiReminderAcknowledge(req, res);
    if (url === '/api/reminder/snoozes') return await apiReminderSnoozes(req, res);
    if (url === '/api/watch/lifecycle') return await apiWatchLifecycle(req, res);
    if (url === '/api/watch/preferences') return await apiWatchPreferences(req, res);
    if (url === '/api/watch/order') return await apiWatchOrder(req, res);
    if (url === '/api/watch/binding') return await apiWatchBinding(req, res);
    if (url === '/api/watch/rewatch') return await apiWatchRewatch(req, res);
    if (url === '/api/watch/cover') return await apiCoverRetry(req, res);
    if (url === '/api/watch/bgm-writeback') return await apiBgmWriteback(req, res);
    if (url === '/api/library/batch') return await apiLibraryBatch(req, res);
    if (url === '/api/library/csv') return await apiLibraryCsv(req, res);
    if (url === '/api/watch/schedule') return await apiWatchSchedule(req, res);
    if (url === '/api/schedule/lookup') return await apiScheduleLookup(req, res);
    if (url === '/api/schedule/original') return await apiOriginalSchedule(req, res);
    if (url === '/api/schedule/desktop') return await apiDesktopSchedule(req, res);
    if (url === '/api/schedule/board') return await apiScheduleBoard(req, res);
    if (url === '/api/watch') return await apiWatch(req, res);
    if (url.startsWith('/api/sync')) return await apiSync(req, res);
    if (url.startsWith('/api/settings')) return await apiSettings(req, res);
    if (url.startsWith('/api/nickname')) return await apiNickname(req, res);
    if (url === '/api/history/browse') return await apiHistoryBrowse(req, res);
    if (url === '/api/history/retract') return await apiHistoryRetract(req, res);
    if (url.startsWith('/api/history')) return await apiHistory(req, res);
    if (url.startsWith('/api/backups')) return await apiBackups(req, res);
    if (url.startsWith('/api/restore')) return await apiRestore(req, res);
    if (url.startsWith('/api/say')) return await apiSay(req, res);
    if (url.startsWith('/api/version')) return await apiVersion(req, res);
    if (url === '/api/diagnostics/report') return await apiDiagnosticsReport(req, res);
    if (url.startsWith('/api/logs')) return await apiLogs(req, res);
    if (url === '/api/health') {
      return json(res, { ok: true, app: APP_ID, version: VERSION, pid: process.pid, port: PORT, instance: INSTANCE,
        ...(recoveryIssue ? { recovery: recoveryIssue } : {}) }, 200, req);
    }
    if (url === '/api/_shutdown') {
      if (req.method !== 'POST' || req.headers.origin || req.headers['x-tiara-control'] !== CONTROL_TOKEN) {
        return json(res, { ok: false, error: 'forbidden' }, 403, req);
      }
      res.once('finish', shutdown);
      return json(res, { ok: true }, 200, req);
    }

    // 未命中的 /api/* 一律回 JSON：以前会掉进静态文件分支，返回纯文本 "404 talks"，
    // 面板 fetch 后 JSON.parse 抛错，报错信息完全看不出是「接口不存在」
    if (url.startsWith('/api/')) {
      return json(res, { ok: false, error: 'no such api: ' + url, version: VERSION }, 404, req);
    }

    if (url.startsWith('/cover/')) {
      const m = /^\/cover\/(\d{1,10})(?:\.jpg)?$/.exec(url);
      if (!m) return json(res, { ok: false, error: 'bad cover path' }, 400, req);
      return await apiCover(req, res, m[1]);
    }

    if (url.startsWith('/sprite/')) {
      const p = safeJoin(path.join(ROOT, 'shell', 'master'), url.slice('/sprite'.length));
      return p ? serveFile(res, p) : json(res, { ok: false, error: 'bad path' }, 400, req);
    }

    if (url === '/' || url.startsWith('/index.html')) {
      return serveFile(res, path.join(ROOT, 'panel', 'index.html'));
    }

    const p = safeJoin(path.join(ROOT, 'panel'), url);
    if (!p) return json(res, { ok: false, error: 'bad path' }, 400, req);
    return serveFile(res, p);
  } catch (e) {
    // 兜底：任何没被接住的异常都记日志，并按「还没发过响应」决定要不要回 500。
    // 这条 catch 以前是二次 writeHead 的源头（ERR_HTTP_HEADERS_SENT 直接把进程带走）。
    if (e.code === 'EPROGRESSRECOVERY' && !recoveryIssue) enterRecovery(e);
    if (!res.headersSent && ['EPROGRESSRECOVERY', 'ERECOVERYREADONLY'].includes(e.code))
      return json(res, { ok: false, error: recoveryIssue.message, recovery: recoveryIssue }, 503, req);
    const msg = String(e && e.message ? e.message : e);
    logLine('error', `处理 ${req.method} ${url} 时出错：${msg}`);
    if (!res.headersSent) json(res, { ok: false, error: msg }, 500, req);
    else res.end();
  }
});

/** 端口被占就往后试，最多 +11；都占了才放弃 */
function listenWithFallback(startPort, maxTries = 12) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    let port = startPort;

    const tryOnce = () => {
      const onError = (e) => {
        server.removeListener('listening', onListening);
        if (e && e.code === 'EADDRINUSE' && attempt < maxTries - 1) {
          attempt += 1;
          port += 1;
          logLine('info', `端口 ${port - 1} 被占用，换 ${port} 试试`);
          tryOnce();
          return;
        }
        reject(e);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        // 用真实绑定端口：--port 0 时由系统分配，不能回 0
        const addr = server.address();
        resolve(addr && typeof addr === 'object' ? addr.port : port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    };

    tryOnce();
  });
}

async function startPanel() {
  if (!PORT_EXPLICIT) {
    const running = await findPanel(ROOT, PORT);
    if (running) {
      const url = `http://127.0.0.1:${running.port}`;
      logLine('info', `已在运行（pid ${running.pid}${running.version ? ' v' + running.version : ''}）→ ${url}，本次不重复启动`);
      console.log(`TIARA 已经在跑了：${url}`);
      console.log('（要再起一份，用 --port 7790 指定别的端口）');
      if (!NO_PORTFILE) await writeFileAtomic(panelPortFile(ROOT), String(running.port), { encoding: 'utf8' });
      return false;
    }
  }

  try {
    await recoverProgress(ROOT);
    await recoverMigration(ROOT);
  } catch (error) {
    enterRecovery(error);
  }
  const actualPort = await listenWithFallback(PORT);
  PORT = actualPort;
  logLine('info', `TIARA ${VERSION} 面板 → http://127.0.0.1:${PORT}`);
  logLine('info', '数据源: data/library.json   台词: data/talks.json   立绘: shell/master/');
  // 桌宠右键「打开网页番组表」靠这个文件找端口（自动回退后也是真值）
  try {
    if (NO_PORTFILE) logLine('info', '--no-portfile：不改写 cache/panel_port.txt（临时实例）');
    else {
      await fs.mkdir(path.join(ROOT, 'cache'), { recursive: true });
      await writeFileAtomic(panelControlFile(ROOT), JSON.stringify({ instance: INSTANCE, pid: process.pid, port: PORT, token: CONTROL_TOKEN }), { encoding: 'utf8', mode: 0o600 });
      await writeFileAtomic(panelPortFile(ROOT), String(PORT), { encoding: 'utf8' });
    }
  } catch (e) {
    logLine('error', '写 cache/panel_port.txt 失败：' + e.message);
  }
  return true;
}

async function main() {
  // 按目录串行执行「发现 → 监听 → 发布端口」，避免桌宠和独立入口同时冷启动。
  const started = await withLibraryLock(ROOT, startPanel, { recover: false });
  if (!started) return;
  if (MANAGED) {
    // 父进程退出（包括崩溃）后，私有标准输入管道关闭。
    process.stdin.once('end', shutdown);
    process.stdin.once('error', shutdown);
    process.stdin.resume();
  }
  if (!NO_PORTFILE) {
    void maintainSeasonCatalog().catch(() => {});
    setInterval(() => void maintainSeasonCatalog().catch(() => {}), 60 * 60_000).unref();
  }
  // 每天第一把启动存一份数据快照（同一天重复启动会跳过）
  if (!NO_PORTFILE) {
    void snapshotDaily();
    setInterval(snapshotDaily, 60 * 60 * 1000).unref();
  }
}

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(async () => {
    await writeChain;
    process.exit(0);
  });
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(0), 5000).unref();
}

// 进程级兜底：以前任何一个漏网的 Promise 拒绝都会让 node 静默退出，
// 面板上表现为「突然连不上」，日志里什么都没有。
process.on('unhandledRejection', (e) => {
  const msg = e && e.stack ? String(e.stack).split('\n').slice(0, 3).join(' | ') : String(e);
  logLine('error', '未接住的 Promise 拒绝：' + msg);
});
process.on('uncaughtException', (e) => {
  logLine('error', '未捕获异常：' + (e && e.stack ? e.stack : String(e)));
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((e) => {
  const reason = e.code === 'EADDRINUSE' ? '面板端口被占用' :
    e.code === 'ELIBRARYLOCK' ? '数据目录正在写入' :
    ['EACCES', 'EPERM', 'EROFS'].includes(e.code) ? '无法访问启动目录或监听端口，请检查权限' : '面板启动失败';
  console.error(reason + '：' + e.message);
  logLine('error', '启动失败：' + e.message);
  process.exit(1);
});

/** Try recent quarters even when the season page is never opened. */
async function maintainSeasonCatalog() {
  if (stopping) return;
  await fs.access(path.join(ROOT, CATALOG_DIRECTORY, 'index.json'));
  const now = new Date();
  const current = currentSeason(now);
  const quarters = [current, shiftSeason(current, 1), shiftSeason(current, 2)];
  for (let q = shiftSeason(current, -1); q >= FIRST_CATALOG_SEASON; q = shiftSeason(q, -1)) quarters.push(q);
  for (const q of quarters) {
    if (stopping) return;
    if (Date.now() < (seasonRetryAfter.get(q) || 0)) continue;
    if (!seasonRefreshState(q, await readSeasonCache(ROOT, q), now).due) continue;
    await refreshSeason(q);
  }
}

/**
 * 每天第一把启动存一份数据快照（data/backups/YYYY-MM-DD/），同一天重复启动会跳过。
 * 实现放在 tools/snapshot_daily.mjs（手工也能跑），这里动态 import，失败只记日志。
 */
async function snapshotDaily() {
  if (stopping || recoveryIssue) return;
  try {
    const { snapshot } = await import('./tools/snapshot_daily.mjs');
    const r = await withWriteLock(() => snapshot({ root: ROOT }));
    if (r.wrote.length) logLine('info', `日快照 ${r.dir}：${r.wrote.join('、')}`);
    if (!r.ok) logLine('warn', '日快照待补齐：' + r.missing.join('、'));
  } catch (e) {
    logLine('warn', '日快照失败（不影响使用）：' + String(e.message || e).slice(0, 80));
  }
}
