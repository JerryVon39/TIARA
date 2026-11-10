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
import { fileURLToPath } from 'node:url';
import { buildToday, timeline, summarize, cstParts, reminders, DEFAULT_SETTINGS, toMin, expectedEpisode, scheduledWeek, displayClock } from './lib/today.mjs';
import { fetchSeason, fetchSubject, mergeLibrary, mergeSeason, seasonOf, seasonRange, weekdayFromInfobox, httpGet } from './lib/bgm.mjs';
import { readSeasonCache, writeSeasonCache, listCachedSeasons, hasSeasonCache } from './lib/season-cache.mjs';
import { coverIdOf, coverCachePath, pickCoverUrl, COVER_MAX_AGE } from './lib/cover.mjs';
import { isLocalOrigin, checkWriteOrigin, checkBodySize, parseJsonBody } from './lib/http-util.mjs';
import { buildIcs } from './lib/ics.mjs';
import { personaInfo, normalizeNickname, addressOf } from './lib/persona.mjs';
import { writeFileAtomic, writeJsonAtomic } from './lib/atomic.mjs';
import { readLibrary, writeLibrary, listBackups, readBackup, peekUndo, undoDepth } from './lib/library.mjs';
import { parseClock } from './lib/time.mjs';
import { APP_ID, VERSION } from './lib/version.mjs';
import { withLibraryLock } from './lib/library-lock.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { panelId, panelPortFile, panelControlFile, findPanel } from './lib/panel-instance.mjs';
import { actualSchedule } from './lib/today.mjs';
import { editWatchDetail, watchDetail } from './lib/watch-detail.mjs';
import { broadcastSuggestions, lookupBroadcast } from './lib/broadcast-lookup.mjs';
import { nextScheduledUpdate, nextWeeklyUpdate, parseWatchSlot, quietAt, scheduleRow, setWatchSlot } from './lib/watch-schedule.mjs';
import { applyWatchStart, remainingEpisodes, watchFloor, WATCH_STARTS } from './lib/watch-start.mjs';
import { findWatchEntry, inactiveWatchIds, moveWatchEntry } from './lib/watch-lifecycle.mjs';
import { BGM_REL, readBgmConfig as readStoredBgmConfig, effectiveBgmConfig, bgmConfigView, validateBgmProxy, fetchSyncData } from './lib/bgm-sync.mjs';

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

async function readSettings() {
  try {
    const s = JSON.parse(await fs.readFile(path.join(ROOT, SETTINGS_REL), 'utf8'));
    const scale = Number(s.pet_scale);
    return {
      ...s,
      clock: s.clock === '24h' || s.clock === '30h' ? s.clock : DEFAULT_SETTINGS.clock,
      pet_scale: Number.isFinite(scale) && scale >= 0.5 && scale <= 2 ? scale : DEFAULT_SETTINGS.pet_scale,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function writeSettings(patch) {
  const cur = await readSettings();
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

const COVER_DIR = path.join(ROOT, 'data', 'covers');
const coverInflight = new Map(); // id → Promise，防同一张图被并发拉多次
let coverIndexCache = { at: 0, urls: new Map() };

/** id → 远程封面地址：扫一遍已缓存的季度表，10 分钟内不重复扫 */
async function findCoverUrl(id) {
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

/**
 * `GET /cover/<id>.jpg`
 * 本地有就直接发（浏览器缓存 30 天）；没有就经代理取一次、落盘、再发。
 * 取不到回 404，面板那边会退化成首字方块，不会裂图。
 */
/**
 * 后台把「这一屏会用到」的封面先抓下来（并发 4，失败不管）。
 * 不阻塞 /api/state，也不影响首屏——只是让用户滚到那儿时图已经在盘上了。
 */
const coverPrefetchQueue = [];
let coverPrefetchRunning = 0;
const COVER_PREFETCH_CONC = 4;
const COVER_PREFETCH_MAX = 240;

function queueCoverPrefetch(ids) {
  for (const id of ids || []) {
    const safe = coverIdOf(id);
    if (safe && !coverPrefetchQueue.includes(safe) && coverPrefetchQueue.length < COVER_PREFETCH_MAX) {
      coverPrefetchQueue.push(safe);
    }
  }
  while (coverPrefetchRunning < COVER_PREFETCH_CONC && coverPrefetchQueue.length) {
    coverPrefetchRunning++;
    (async () => {
      try {
        while (coverPrefetchQueue.length) {
          const id = coverPrefetchQueue.shift();
          const file = coverCachePath(ROOT.replace(/\\/g, '/'), id);
          try {
            const st = await fs.stat(file);
            if (st.size > 512) continue;
          } catch { /* 没缓存，继续抓 */ }
          try {
            const url = await findCoverUrl(id);
            if (!url) continue;
            const cfg = await readBgmConfig().catch(() => ({}));
            const r = await httpGet(url, { proxy: cfg.proxy || '', timeoutMs: 20000 });
            if (r.status === 200 && r.body && r.body.length > 512) {
              await fs.mkdir(COVER_DIR, { recursive: true });
              await fs.writeFile(file, r.body);
            }
          } catch { /* 预取失败无所谓，用户真滚到那儿会再试一次 */ }
        }
      } finally {
        coverPrefetchRunning--;
      }
    })();
  }
}

async function apiCover(req, res, idRaw) {  const id = coverIdOf(idRaw);
  if (!id) return json(res, { error: 'bad id' }, 400, req);
  const file = coverCachePath(ROOT.replace(/\\/g, '/'), id);

  try {
    const st = await fs.stat(file);
    if (st.size > 512) return serveFile(res, file, `public, max-age=${COVER_MAX_AGE}`);
  } catch { /* 没有缓存，往下取 */ }

  if (!coverInflight.has(id)) {
    coverInflight.set(id, (async () => {
      const url = await findCoverUrl(id);
      if (!url) return null;
      const cfg = await readBgmConfig().catch(() => ({}));
      const r = await httpGet(url, { proxy: cfg.proxy || '', timeoutMs: 20000 });
      if (r.status !== 200 || !r.body || r.body.length < 512) return null;
      await fs.mkdir(COVER_DIR, { recursive: true });
      await fs.writeFile(file, r.body);
      return file;
    })().finally(() => coverInflight.delete(id)));
  }

  let got = null;
  try {
    got = await coverInflight.get(id);
  } catch (e) {
    logLine('error', `[cover] ${id} 取图失败：${e && e.message}`);
  }
  if (got) return serveFile(res, got, `public, max-age=${COVER_MAX_AGE}`);
  return json(res, { error: 'cover unavailable' }, 404, req);
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
  queueCoverPrefetch(Object.keys(images));

  json(
    res,
    {
      ok: true,
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
  watching: (lib.watching ?? []).map((w) => ({
    ...w,
    airing: watchAiring(w, w.start_date),
    expected_eps: expectedEpisode(w, lib, now, new Set(t.today.filter(x => x.aired).map((x) => String(x.id)))),
  })),
      // 待看队列：落后 ≥1 话的番（不问时刻、不催——只在这里安静列出来）
      pending: (() => {
        const todayIds = new Set(t.today.filter(x => x.aired).map((x) => String(x.id)));
        const list = [];
        for (const w of lib.watching ?? []) {
          const exp = expectedEpisode(w, lib, now, todayIds);
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
      watching_count: (lib.watching || []).length,
      paused: lib.paused ?? [],
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
function withWriteLock(fn) {
  const run = writeChain.then(() => withLibraryLock(ROOT, fn));
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
    rotateHistory().catch(() => {});
  } catch (e) {
    logLine('error', 'appendHistory: ' + e.message);
  }
}

/**
 * 写库 / 撤销栈的实现都搬到了 lib/library.mjs（纯磁盘逻辑，可以单测；
 * 也拦住了「某个路由绕过护栏直写 library.json」这类事）。这里只注入 root 与日志。
 */
const saveLibrary = (lib, opts = {}) => writeLibrary(ROOT, lib, { log: logLine, ...opts });
const undoDepthNow = () => undoDepth(ROOT);

/** POST /api/undo → 撤销最近一次写库；返回撤销前/后各自看了多少话，便于面板提示 */
async function apiUndo(req, res) {
  if (!guardWrite(req, res)) return;
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  const body = await readJsonBody(req, res);
  if (!body) return;
  return withWriteLock(async () => {
    const current = await librarySnapshot();
    if (body.expected_revision && current.revision !== body.expected_revision) {
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
  if (body.set !== undefined) {
    if (!Number.isFinite(Number(body.set))) return json(res, { ok: false, error: 'set 必须是数字' }, 400, req);
    wantSet = Number(body.set);
  } else {
    if (body.delta === undefined) return json(res, { ok: false, error: 'delta 或 set 必须给一个' }, 400, req);
    if (!Number.isFinite(Number(body.delta))) return json(res, { ok: false, error: 'delta 必须是数字' }, 400, req);
    wantDelta = Number(body.delta);
  }

  const outcome = await withWriteLock(async () => {
    const lib = await readLibrary(ROOT);
    const w = (lib.watching || []).find((x) => String(x.id) === id);
    if (!w) return { code: 404, payload: { ok: false, error: 'not watching: ' + id } };

    // eps 有可能是 0 / null（手动加的番、或 Bangumi 没给总集数）——
    // 这时不能把上限当 0 用，否则 +1 永远被夹回 0，用户看到的是「点了没反应」。
    const epsNum = Number(w.eps);
    const eps = Number.isFinite(epsNum) && epsNum > 0 ? Math.round(epsNum) : 0;
    const prev = Math.max(0, Math.round(Number(w.ep_status) || 0));
    const floor = watchFloor(w);
    let next = wantSet !== null ? wantSet : wantDelta > 0 ? Math.max(prev, floor) + wantDelta : prev + wantDelta;
    next = Math.max(0, Math.round(next));
    if (eps > 0) next = Math.min(eps, next);
    if (wantSet === null && wantDelta < 0 && next <= floor) next = 0;
    const watchedDelta = Math.max(next, floor) - Math.max(prev, floor);

    w.ep_status = next;
    if (next > prev) w.last_watched = cstParts().date;

    // 结论没变就别写盘：连点两下 + 到上限、或 delta:0 的探活请求都不该留备份与历史
    if (next === prev) {
      return { code: 200, payload: { ok: true, id, prev, ep_status: next, eps, changed: false, rebuilt: false } };
    }

    const historyId = randomBytes(16).toString('hex');
    const saved = await saveLibrary(lib, { source: 'progress', historyId });
    await appendHistory({
      history_id: historyId,
      ts: new Date().toISOString(),
      date: cstParts().date,
      id,
      name: w.name_cn || w.name || id,
      from: prev,
      to: next,
      delta: watchedDelta,
    });
    return { code: 200, payload: { ok: true, id, prev, ep_status: next, eps, changed: true,
      revision: createHash('sha256').update(saved).digest('hex') } };
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

/** 把放送表里的番加进 / 移出「在追」：{ id, action: 'add' | 'remove', weekday?, name? } */
async function apiWatch(req, res) {
  if (!guardWrite(req, res)) return;
  if (req.method !== 'POST') return json(res, { ok: false, error: 'use POST' }, 405, req);
  const body = await readJsonBody(req, res);
  if (!body) return;
  const id = String(body.id ?? '');
  if (!id) return json(res, { ok: false, error: 'missing id' }, 400, req);
  const action = body.action === 'remove' ? 'remove' : 'add';

  const outcome = await withWriteLock(async () => {
    const lib = await readLibrary(ROOT);
    lib.watching = lib.watching || [];
    const at = lib.watching.findIndex((x) => String(x.id) === id);

    if (action === 'remove') {
      if (at < 0) return { code: 404, payload: { ok: false, error: 'not watching: ' + id } };
      const gone = lib.watching.splice(at, 1)[0];
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
    const meta = await lookupSeasonItem(id);
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
    const latest = body.start_mode === 'latest' ? expectedEpisode({ ...entry, track_from: null }, lib) : null;
    if (!applyWatchStart(entry, body.start_mode, { seen: body.seen, latest })) {
      return { code: 400, payload: { error: '无法确定这个补番起点，可选择从头补或手填进度' } };
    }
    lib.watching.push(entry);
    await saveLibrary(lib, { source: 'watch:add' });
    return { code: 200, payload: { ok: true, action, id, name_cn: entry.name_cn, eps: entry.eps, air_weekday: entry.air_weekday, changed: true }, write: true };
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
    let airing = found.state === 'watching' ? watchAiring(detail, found.entry.start_date) : null;
    if (!airing && found.state === 'watching' && !detail.schedule_ended && !found.entry.schedule_manual && /^\d+$/.test(detail.id)) {
      airing = (await broadcastSuggestions(ROOT, [detail.id]).catch(() => ({})))[detail.id] || null;
    }
    return json(res, { ok: true, detail, airing }, 200, req);
  }
  if (req.method !== 'POST') return json(res, { error: 'use GET or POST' }, 405, req);
  if (!guardWrite(req, res)) return;
  const body = await readJsonBody(req, res);
  if (!body) return;
  // Absolute progress is a correction/baseline, so it should not add watch history.
  return updateWatch(req, res, body.id == null ? 'watch:manual' : 'watch:detail', lib => editWatchDetail(lib, body));
}

async function apiWatchLifecycle(req, res) {
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  if (!guardWrite(req, res)) return;
  const body = await readJsonBody(req, res);
  if (!body) return;
  if (typeof body.id !== 'string' || !body.id) return json(res, { error: '番剧编号无效' }, 400, req);
  return updateWatch(req, res, 'watch:lifecycle', lib => {
    const found = findWatchEntry(lib, body.id);
    if (!found) return { code: 404, error: '找不到这部番' };
    if (body.expected_revision !== undefined && body.expected_revision !== watchDetail(lib, found.entry, found.state).revision) {
      return { code: 409, error: '这部番已有修改，请重新打开详情' };
    }
    return moveWatchEntry(lib, found, body.action);
  });
}

async function apiWatchSchedule(req, res) {
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  if (!guardWrite(req, res)) return;
  const body = await readJsonBody(req, res);
  if (!body) return;
  return updateWatch(req, res, 'watch:schedule', lib => {
    const found = findWatchEntry(lib, body.id);
    if (!found || found.state !== 'watching') return { code: 409, error: '请先将番剧恢复到在追' };
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
  if (result.error) return json(res, { error: result.error }, result.code, req);
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
    const candidates = await lookupBroadcast({ root: ROOT, name, id, proxy: config.proxy, originalOnly: body.original_only === true });
    json(res, { ok: true, candidates }, 200, req);
  } catch {
    json(res, { error: '暂时连不上排期数据源。你可以先手填时刻，稍后再试。' }, 502, req);
  }
}

// ---------------- /api/history ----------------
/** 进度历史：最近 200 条 + 按番聚合（「这季追了多少话」） */
async function apiHistory(req, res) {
  const file = path.join(ROOT, 'data', 'history.jsonl');
  let lines = [];
  try {
    lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
  } catch {
    return json(res, { ok: true, total: 0, recent: [], byShow: [] }, 200, req);
  }

  const voided = new Set((await readLibrary(ROOT).catch(() => null))?.void_history || []);
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
    const k = String(h.id);
    const e = byId.get(k) || { id: h.id, name: h.name, count: 0, last: null };
    if (h.delta > 0) {
      e.count += h.delta;
      gained += h.delta;
      e.last = h.ts;
      e.name = h.name || e.name;
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
  json(res, { ok: true, backups: await listBackups(ROOT) }, 200, req);
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
  for (const state of ['watching','paused','archived']) {
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
  (current[source.state] ||= []).push(source.entry);
  if (Array.isArray(current.dropped)) current.dropped = current.dropped.filter(w => String(w.id) !== id);
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
      const raw = await fs.readFile(path.join(ROOT, 'data/library.json'), 'utf8').catch(e => {
        if (e.code !== 'ENOENT') throw e;
        return '';
      });
      const revision = hash(raw);
      let current;
      try { current = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch {}
      if (!Array.isArray(current?.watching)) current = null;
      const backup = await readBackup(ROOT, name);
      if (id && (!current || !findWatchEntry(backup.lib, id))) {
        return { code: 409, payload: { error: '这份备份找不到该番，或当前库不可读' } };
      }
      if (body.dry_run) {
        return { code: 200, payload: { ok: true, revision, backup_revision: backup.revision,
          entries: [...backupEntries(backup.lib).values()], changes: backupChanges(current, backup.lib, id), current_readable: !!current } };
      }
      if ((body.expected_revision && body.expected_revision !== revision) ||
          (body.backup_revision && body.backup_revision !== backup.revision)) {
        return { code: 409, payload: { error: '当前番库或备份已变动，请重新预览' } };
      }
      const restored = id ? restoreWatchFromBackup(current, backup.lib, id) : backup.lib;
      if (current?.void_history) restored.void_history = current.void_history;
      await saveLibrary(restored, { backup: !!current, source: 'restore:' + name });
      return { code: 200, payload: { ok: true, restored: name, id }, write: true };
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

// ---------------- /api/settings ----------------
/** GET 读偏好；POST { clock?: '24h'|'30h' } 写偏好并重算今日数据（桌宠尺寸在 data/state.json） */
async function apiSettings(req, res) {
  if (req.method === 'GET') return json(res, await readSettings(), 200, req);
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  if (!guardWrite(req, res)) return;
  const body = await readJsonBody(req, res);
  if (!body) return;   // 坏 JSON / 超限已经回过响应，别再往下走（以前就是这里让进程 exit 1）
  if (body.quiet_start !== undefined || body.quiet_end !== undefined) {
    const start = body.quiet_start, end = body.quiet_end;
    const valid = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    if (!(start === '' && end === '') && !(valid(start) && valid(end) && start !== end)) {
      return json(res, { error: '请填写两个不同的 24 小时时刻，或同时留空关闭免打扰' }, 400, req);
    }
  }
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
const SYNC_PREVIEW_TTL = 5 * 60 * 1000;

const hash = value => createHash('sha256').update(value).digest('hex');

async function librarySnapshot() {
  const raw = await fs.readFile(path.join(ROOT, 'data/library.json'), 'utf8');
  return { lib: JSON.parse(raw.replace(/^\uFEFF/, '')), revision: hash(raw) };
}

const readBgmConfig = async () => effectiveBgmConfig(await readStoredBgmConfig(ROOT));

async function apiSync(req, res) {
  if (!guardWrite(req, res)) return;
  if (req.method !== 'POST') return json(res, { error: 'use POST' }, 405, req);
  const body = await readJsonBody(req, res);
  if (!body) return;

  if (body.dry_run === true) {
    const config = await readBgmConfig();
    const mode = body.mode || (body.takeProgress ? 'progress' : 'collections');
    if (!['calendar', 'collections', 'progress'].includes(mode)) return json(res, { error: '同步方式无效' }, 400, req);
    if (mode === 'progress' && !config.token) return json(res, { error: '请先连接 Bangumi 账号，再导入进度' }, 400, req);
    const { data, usable, ...status } = await fetchSyncData(config, { mode });
    if (!usable) return json(res, { error: '这次没有取得可同步的数据', ...status }, 502, req);
    const snapshot = await librarySnapshot();
    const { next, changes } = mergeLibrary(snapshot.lib, data, {
      takeProgress: mode === 'progress', weekday: body.weekday === 'all' ? 'all' : 'watching',
    });
    const names = new Map((next.watching || []).map(w => [String(w.id), w.name_cn || w.name]));
    for (const change of changes) change.name = names.get(String(change.id)) || change.note && change.to || String(change.id);
    const preview_id = randomBytes(18).toString('hex');
    for (const [id, preview] of syncPreviews) if (preview.expires < Date.now()) syncPreviews.delete(id);
    if (syncPreviews.size >= 8) syncPreviews.delete(syncPreviews.keys().next().value);
    syncPreviews.set(preview_id, { ...status, next, changes, revision: snapshot.revision,
      configRevision: hash(JSON.stringify(config)), expires: Date.now() + SYNC_PREVIEW_TTL });
    return json(res, { ok: true, preview_id, changes, ...status }, 200, req);
  }

  const applied = await withWriteLock(async () => {
    const preview = syncPreviews.get(body.preview_id);
    if (!preview || preview.expires < Date.now()) return null;
    if (preview.revision !== (await librarySnapshot()).revision ||
        preview.configRevision !== hash(JSON.stringify(await readBgmConfig()))) {
      syncPreviews.delete(body.preview_id);
      return null;
    }
    if (preview.changes.length) await saveLibrary(preview.next, { source: 'sync' });
    syncPreviews.delete(body.preview_id);
    return preview;
  });
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
async function apiSeason(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.searchParams.get('list') === '1') {
    return json(res, { ok: true, seasons: await listCachedSeasons(ROOT), current: seasonOf(new Date()) }, 200, req);
  }
  const qRaw = u.searchParams.get('q');
  let q;
  try {
    q = seasonOf(qRaw || new Date());
  } catch (e) {
    return json(res, { ok: false, error: String(e.message || e), q: qRaw, hint: '季度写成 2026Q4 这种' }, 400, req);
  }
  const wantRefresh = u.searchParams.get('refresh') === '1';
  const cached = await readSeasonCache(ROOT, q);
  if (cached && !wantRefresh && !cached.stale) {
    // 本季表一开就会滚到这些封面，先把它们搬进 data/covers/
    queueCoverPrefetch((cached.items || []).map((it) => it.id));
    return json(res, { ok: true, source: 'cache', ...cached }, 200, req);
  }

  const cfg = await readBgmConfig();
  try {
    const data = await fetchSeason({ q, proxy: cfg.proxy, base: cfg.base });
    const saved = await writeSeasonCache(ROOT, data);
    queueCoverPrefetch((data.items || []).map((it) => it.id));
    return json(res, { ok: true, source: 'net', ...data, fetched_at: saved.fetched_at, stale: false, age_ms: 0 }, 200, req);
  } catch (e) {
    if (cached) {
      return json(res, { ok: true, source: 'cache-stale', warning: String(e.message || e), ...cached }, 200, req);
    }
    return json(res, { ok: false, error: String(e.message || e), q, hint: '检查系统代理 / 在面板里填 proxy' }, 502, req);
  }
}

function watchAiring(detail, since) {
  const next = nextScheduledUpdate(detail, new Date(), since);
  return next ? { next, source: detail.schedule_source || '本地排期' } : null;
}

async function apiOriginalSchedule(req, res) {
  if (req.method !== 'GET') return json(res, { error: 'use GET' }, 405, req);
  const q = new URL(req.url, 'http://127.0.0.1').searchParams.get('q');
  if (q != null && !/^\d{4}Q[1-4]$/.test(q)) return json(res, { error: '季度无效' }, 400, req);
  let ids;
  if (q) {
    const cached = await readSeasonCache(ROOT, q);
    ids = (cached?.items || []).map(item => item.id);
  } else {
    const lib = await readLibrary(ROOT);
    ids = (lib.watching || []).concat(Object.values(lib.weekday || {}).flat()).map(item => item.id);
  }
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
  const active = lib.watching.filter(w => !w.schedule_ended);
  const { clock } = await readSettings();
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
    return { id, name: w.name_cn || w.name || id, weekday: slot.weekday_disp || 0, time: slot.time_disp,
      source: original ? 'original' : time ? 'custom' : '', seen: w.ep_status ?? 0, total: w.eps ?? 0 };
  });
  rows.sort((a, b) => (a.weekday || 8) - (b.weekday || 8) || (a.time || '99:99').localeCompare(b.time || '99:99'));
  return json(res, { rows, clock, warning }, 200, req);
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
    if (inactive.has(id)) { delete suggestions[id]; continue; }
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
  const airings = body.start_mode === 'latest' ? await broadcastSuggestions(ROOT, usable).catch(() => ({})) : {};

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
        added: changes.filter((c) => c.scope === 'watching' && (c.field === '(新增)' || c.field === '(恢复)')).length,
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
    const active = new Map((lib.watching || []).map(w => [String(w.id), w]));
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
function upcomingDays(lib, now) {
  return scheduledWeek(lib, now).filter(day => day.rows.length).map(day => ({
    ...day, rows: day.rows.sort((a, b) => toMin(a.time_cst) - toMin(b.time_cst)),
  }));
}

/** Markdown 表格单元格：竖线和换行会直接把表拆坏 */
const mdCell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

async function apiExport(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const fmt = (u.searchParams.get('fmt') || 'ics').toLowerCase();
  let lib;
  try {
    lib = await readLibrary(ROOT);
  } catch (e) {
    // 以前这里没兜底，读库失败时浏览器直接跳一坨 JSON 错误页
    return json(res, { ok: false, error: String(e.message || e), hint: '先看看 data/library.json 还在不在' }, 500, req);
  }
  const now = new Date();
  const plan = upcomingDays(lib, now, 7);
  const settings = await readSettings();
  const muted = new Set((lib.watching || []).filter(w => w.reminder_muted).map(w => String(w.id)));

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
  const events = [];
  for (const day of plan) {
    for (const r of day.rows) {
      if (!r.time_cst) continue; // 没时刻的不进日历，免得一堆 00:00
      events.push({
        uid: `kx-${day.date}-${r.id}@tiara.local`,
        date: day.date,
        time: r.time_cst,
        summary: `${r.name_cn || r.id}${typeof r.ep_expected === 'number' ? ` 第${r.ep_expected}话` : ''}`,
        description: '由 TIARA 生成 · 本地番组表',
        noAlarm: muted.has(String(r.id)) || quietAt(settings,
          new Date(Date.parse(day.date + 'T00:00:00+08:00') + (toMin(r.time_cst) - 10) * 60000)),
      });
    }
  }
  res.writeHead(200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': `attachment; filename="tiara-week.ics"`,
    ...corsHeaders(req),
  });
  return res.end(buildIcs(events, { now, calName: 'TIARA的本周番组', durationMin: 30, alarmMin: 10 }));
}

/** GET /api/stats → 连续追番天数 / 本周看完 / 累计 */
async function apiStats(req, res) {
  const library = await readLibrary(ROOT).catch(() => ({}));
  const voided = new Set(library.void_history || []);
  let rows = [];
  try {
    const raw = await fs.readFile(path.join(ROOT, 'data', 'history.jsonl'), 'utf8');
    rows = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { rows = []; }

  const days = new Set();
  let weekCount = 0;
  let total = 0;
  const byDay = new Map();
  const today = cstParts().date;
  const weekAgo = cstParts(new Date(Date.now() - 6 * 86400e3)).date;
  for (const r of rows) {
    if (voided.has(r.history_id)) continue;
    if (r.event === 'season' || r.action === 'season') continue;
    const delta = Number(r.delta || 0);
    if (delta > 0 && r.date) {
      days.add(r.date);
      total += delta;
      byDay.set(r.date, (byDay.get(r.date) || 0) + delta);
      if (r.date >= weekAgo && r.date <= today) weekCount += delta;
    }
  }
  // 最近 14 天，从 13 天前排到今天
  const spark = [];
  for (let i = 13; i >= 0; i--) {
    const d = cstParts(new Date(Date.now() - i * 86400e3)).date;
    spark.push({ date: d, n: byDay.get(d) || 0 });
  }
  let finished = 0;
  try {
    const lib = library;
    for (const w of [...(lib.watching || []), ...(lib.paused || []), ...(lib.archived || [])]) {
      const eps = Number(w.eps || 0);
      const watched = Number(w.ep_status || 0);
      if (eps > 0 && watched >= eps) finished += 1;
    }
  } catch { finished = 0; }
  let streak = 0;
  let off = days.has(today) ? 0 : 1; // 今天还没看就从昨天开始数
  for (; off < 400; off++) {
    const d = cstParts(new Date(Date.now() - off * 86400e3)).date;
    if (!days.has(d)) break;
    streak += 1;
  }
  json(res, { ok: true, streak, week: weekCount, total, days: days.size, finished, byDay: spark }, 200, req);
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
  json(res, {
    ok: true,
    app: APP_ID,
    version: VERSION,
    pid: process.pid,
    started: STARTED_AT,
    port: PORT,
    today_txt: await exists('ghost/master/today.txt'),
    files,
  }, 200, req);
}

// ---------------- 路由 ----------------
const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0] || '/'; // 面板带 ?v=xxx 刷新也要能命中路由
  try {
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
    if (url.startsWith('/api/season/time')) return await apiSeasonTime(req, res);
    if (url.startsWith('/api/season')) return await apiSeason(req, res);
    if (url === '/api/token/test') return await apiToken(req, res, true);
    if (url === '/api/token') return await apiToken(req, res);
    if (url.startsWith('/api/export')) return await apiExport(req, res);
    if (url.startsWith('/api/stats')) return await apiStats(req, res);
    if (url.startsWith('/api/progress')) return await apiProgress(req, res);
    if (url.startsWith('/api/undo')) return await apiUndo(req, res);
    if (url === '/api/watch/detail') return await apiWatchDetail(req, res);
    if (url === '/api/watch/lifecycle') return await apiWatchLifecycle(req, res);
    if (url === '/api/watch/schedule') return await apiWatchSchedule(req, res);
    if (url === '/api/schedule/lookup') return await apiScheduleLookup(req, res);
    if (url === '/api/schedule/original') return await apiOriginalSchedule(req, res);
    if (url === '/api/schedule/desktop') return await apiDesktopSchedule(req, res);
    if (url === '/api/watch') return await apiWatch(req, res);
    if (url.startsWith('/api/sync')) return await apiSync(req, res);
    if (url.startsWith('/api/settings')) return await apiSettings(req, res);
    if (url.startsWith('/api/nickname')) return await apiNickname(req, res);
    if (url.startsWith('/api/history')) return await apiHistory(req, res);
    if (url.startsWith('/api/backups')) return await apiBackups(req, res);
    if (url.startsWith('/api/restore')) return await apiRestore(req, res);
    if (url.startsWith('/api/say')) return await apiSay(req, res);
    if (url.startsWith('/api/version')) return await apiVersion(req, res);
    if (url.startsWith('/api/logs')) return await apiLogs(req, res);
    if (url === '/api/health') {
      return json(res, { ok: true, app: APP_ID, version: VERSION, pid: process.pid, port: PORT, instance: INSTANCE }, 200, req);
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
  const started = PORT_EXPLICIT ? await startPanel() : await withLibraryLock(ROOT, startPanel);
  if (!started) return;
  if (MANAGED) {
    // 父进程退出（包括崩溃）后，私有标准输入管道关闭。
    process.stdin.once('end', shutdown);
    process.stdin.once('error', shutdown);
    process.stdin.resume();
  }
  prewarmSeasons().catch(() => {});
  // 每天第一把启动存一份数据快照（同一天重复启动会跳过）
  snapshotDaily().catch(() => {});
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
  console.error(`7788–${7788 + 11} 全被占用，起不来：${e.message}`);
  logLine('error', '启动失败：' + e.message);
  process.exit(1);
});

/**
 * 后台预热相邻季度：串行、单季 45 秒上限、失败静默。
 * 不阻塞首屏，也不和用户的手动「刷新」抢带宽。
 */
async function prewarmSeasons() {
  const now = new Date();
  const cur = seasonOf(now);
  const list = [cur, seasonOf(new Date(now.getTime() - 92 * 86400000)), seasonOf(new Date(now.getTime() + 92 * 86400000))];
  const cfg = await readBgmConfig().catch(() => ({}));
  for (const q of list) {
    try {
      if (await hasSeasonCache(ROOT, q)) continue;
      const t0 = Date.now();
      const data = await fetchSeason({ q, proxy: cfg.proxy, base: cfg.base });
      await writeSeasonCache(ROOT, data);
      logLine('info', `预热 ${q}：${data.items.length} 部 / ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      logLine('warn', `预热 ${q} 失败（不影响使用）：${String(e.message || e).slice(0, 80)}`);
    }
  }
}

/**
 * 每天第一把启动存一份数据快照（data/backups/YYYY-MM-DD/），同一天重复启动会跳过。
 * 实现放在 tools/snapshot_daily.mjs（手工也能跑），这里动态 import，失败只记日志。
 */
async function snapshotDaily() {
  try {
    const { snapshot } = await import('./tools/snapshot_daily.mjs');
    const r = snapshot({ root: ROOT, keep: 14 });
    if (r.wrote.length) logLine('info', `日快照 ${r.dir}：${r.wrote.join('、')}`);
  } catch (e) {
    logLine('warn', '日快照失败（不影响使用）：' + String(e.message || e).slice(0, 80));
  }
}
