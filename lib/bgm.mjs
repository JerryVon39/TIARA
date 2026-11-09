/**
 * lib/bgm.mjs — 和 Bangumi 打交道的最小实现（零依赖）
 *
 * 设计要点：
 *   · 默认用全局 fetch；给了 proxy 就自己开 CONNECT 隧道（Node 的 fetch 不认 HTTP_PROXY 环境变量）
 *   · 网络权威字段：eps / air_weekday / 番名；本地权威字段：priority / rate / comment / last_watched / ep_status
 *   · mergeLibrary() 是纯函数：输入 library + 接口数据，输出新 library + 变更清单，方便单测和 --dry-run
 *
 * 接口参考：
 *   GET /calendar                                   本周放送表（无需登录）
 *   GET /v0/users/{user}/collections?subject_type=2&type=3  在看（需 token）
 */

import { inactiveWatchIds } from './watch-lifecycle.mjs';

export const UA = 'tiara/0.4 (local; +https://bgm.tv)';

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 并发跑一批异步任务，保持结果顺序（不引第三方库） */
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  const workers = new Array(Math.min(limit, list.length)).fill(0).map(async () => {
    while (i < list.length) {
      const k = i++;
      out[k] = await fn(list[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}

export function decodeChunked(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf('\r\n', i);
    if (nl < 0) break;
    const size = parseInt(buf.slice(i, nl).toString('latin1'), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    out.push(buf.slice(nl + 2, nl + 2 + size));
    i = nl + 2 + size + 2;
  }
  return Buffer.concat(out);
}

export function parseResponse(buf) {
  const sep = buf.indexOf('\r\n\r\n');
  if (sep < 0) throw new Error('响应不是合法 HTTP：找不到头部结尾');
  const head = buf.slice(0, sep).toString('latin1').split('\r\n');
  const status = Number((head[0].split(' ')[1] || 0));
  const headers = {};
  for (let i = 1; i < head.length; i++) {
    const k = head[i].indexOf(':');
    if (k > 0) headers[head[i].slice(0, k).trim().toLowerCase()] = head[i].slice(k + 1).trim();
  }
  let body = buf.slice(sep + 4);
  if ((headers['transfer-encoding'] || '').includes('chunked')) body = decodeChunked(body);
  return { status, headers, body };
}

/**
 * 代理串 → {host, port, auth}。
 * 支持 127.0.0.1:7890、http://host:port、以及带凭据的 http://user:pass@host:port。
 * 以前是 `replace(/^https?:\/\//,'').split(':')`：带凭据时会去连一个叫 user 的主机，
 * 端口变成 NaN；带协议前缀的 https:// 也一样错位。
 */
export function parseProxy(proxy) {
  const raw = String(proxy || '').trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'http://' + raw;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (!u.hostname) return null;
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 8080));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const auth = u.username
    ? 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || '')}`).toString('base64')
    : '';
  return { host: u.hostname.replace(/^\[|\]$/g, ''), port, auth };
}

/** 走代理：CONNECT 开隧道，再在隧道里发一条 HTTP/1.1 请求 */
async function httpsViaProxy(urlStr, { proxy, headers, timeoutMs, method = 'GET', body = null }) {
  const net = await import('node:net');
  const tls = await import('node:tls');
  const u = new URL(urlStr);
  const cfg = parseProxy(proxy);
  if (!cfg) throw new Error('代理地址看不懂：' + proxy);
  const verb = String(method || 'GET').toUpperCase();
  const payload = body || null;
  const head = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
  const proxyAuth = cfg.auth ? `Proxy-Authorization: ${cfg.auth}\r\n` : '';

  return new Promise((resolve, reject) => {
    const sock = net.connect(cfg.port, cfg.host, () => {
      sock.write(`CONNECT ${u.hostname}:443 HTTP/1.1\r\nHost: ${u.hostname}:443\r\n${proxyAuth}\r\n`);
    });
    let stage = 'connect';
    let raw = Buffer.alloc(0);
    const fail = (e) => { try { sock.destroy(); } catch {} reject(e); };
    const timer = setTimeout(() => fail(new Error('代理超时')), timeoutMs);
    sock.on('error', (e) => { clearTimeout(timer); fail(e); });

    sock.on('data', (chunk) => {
      raw = Buffer.concat([raw, chunk]);
      if (stage === 'connect') {
        const idx = raw.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const line = raw.slice(0, idx).toString('latin1').split('\r\n')[0];
        if (!/^HTTP\/1\.[01] 2\d\d/.test(line)) return fail(new Error('代理拒绝 CONNECT：' + line));
        raw = raw.slice(idx + 4);
        stage = 'tls';
        const secure = tls.connect({ socket: sock, servername: u.hostname }, () => {
          secure.write(`${verb} ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.hostname}\r\n${head}\r\nConnection: close\r\n\r\n`);
          if (payload) secure.write(payload);
          stage = 'body';
        });
        secure.on('data', (d) => { raw = Buffer.concat([raw, d]); });
        secure.on('end', () => {
          clearTimeout(timer);
          try { resolve(parseResponse(raw)); } catch (e) { reject(e); }
        });
        secure.on('error', (e) => { clearTimeout(timer); fail(e); });
      }
    });
  });
}

/**
 * 取一段 HTTP 响应（GET/POST 都走这里）。
 * @returns {Promise<{status:number, headers:object, body:Buffer}>}
 */
export async function httpRequest(urlStr, { timeoutMs = 15000, proxy = '', headers = {}, method = 'GET', body = null } = {}) {
  const hdrs = { 'User-Agent': UA, 'Accept-Encoding': 'identity', ...headers };
  const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  if (payload) {
    hdrs['Content-Type'] = hdrs['Content-Type'] || 'application/json';
    hdrs['Content-Length'] = String(payload.length);
  }
  if (proxy) return httpsViaProxy(urlStr, { proxy, headers: hdrs, timeoutMs, method, body: payload });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(urlStr, { method, headers: hdrs, body: payload, signal: ctrl.signal, redirect: 'follow' });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: Object.fromEntries(res.headers), body: buf };
  } finally {
    clearTimeout(timer);
  }
}

/** 兼容老调用（纯 GET） */
export function httpGet(urlStr, opts = {}) {
  return httpRequest(urlStr, { ...opts, method: 'GET' });
}

/**
 * 带重试的 JSON 请求：bgm 偶发 5xx / 限流，重试比直接失败体验好。
 *
 * 但 403/404 不该重试：以前 `throw` 写在 try 里，被自己的 catch 接住 → 照样重试 3 次，
 * 面板上表现为「点了同步，转 3.6 秒才告诉你 token 不对」。
 */
export async function getJson(urlStr, opts = {}) {
  const retries = opts.retries ?? 2;
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    let res = null;
    try {
      res = await httpRequest(urlStr, opts);
    } catch (e) {
      lastErr = e;   // 网络层错误（超时 / DNS / 代理）值得重试
    }
    if (res) {
      const text = res.body.toString('utf8');
      if (res.status === 200) {
        try {
          return JSON.parse(text);
        } catch (e) {
          lastErr = new Error(`返回的不是 JSON：${text.slice(0, 120)}`);
        }
      } else if (res.status === 403 || res.status === 404) {
        // 鉴权 / 不存在：立刻失败，别浪费用户 3 秒
        const err = new Error(`HTTP ${res.status}：${text.slice(0, 160)}`);
        err.noRetry = true;
        throw err;
      } else {
        lastErr = new Error(`HTTP ${res.status}：${text.slice(0, 160)}`);
      }
    }
    if (i < retries) await sleep(1200 * (i + 1));
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ *
 * 接口
 * ------------------------------------------------------------------ */

/** 本周放送表：返回 [{weekday:{id,cn,en}, items:[{id,name,name_cn,air_date?}]}]
 *  线上接口实际返回的是 {"0":{weekday:{...},items:[...]}, …}（0=周一），
 *  也兼容文档里的数组写法，统一成数组返回。 */
export async function fetchCalendar(opts = {}) {
  const url = (opts.base || 'https://api.bgm.tv') + '/calendar';
  const data = await getJson(url, opts);
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    return Object.keys(data)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => data[k])
      .filter((d) => d && Array.isArray(d.items));
  }
  throw new Error('/calendar 返回的结构不认识');
}

/** 在看收藏（需要 token） */
export async function fetchCollections(user, token, opts = {}) {
  if (!user || !token) throw new Error('缺少 user / token');
  const base = opts.base || 'https://api.bgm.tv';
  const out = [];
  for (let offset = 0; offset < 500; offset += 50) {
    const url = `${base}/v0/users/${encodeURIComponent(user)}/collections?subject_type=2&type=3&limit=50&offset=${offset}`;
    const page = await getJson(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } });
    const items = (page && page.data) || [];
    out.push(...items);
    if (items.length < 50) break;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 季度：整季浏览（POST /v0/search/subjects）
 * ------------------------------------------------------------------ */

const pad2 = (n) => String(n).padStart(2, '0');

/** 季度名：'2026Q4'；也接受 '2026-10' / '2026-10-05' / Date */
export function seasonOf(d = new Date()) {
  if (d instanceof Date) {
    const t = new Date(d.getTime() + 8 * 3600e3);
    const q = Math.floor(t.getUTCMonth() / 3) + 1;
    return `${t.getUTCFullYear()}Q${q}`;
  }
  const s = String(d).trim();
  const mq = /^(\d{4})-?Q([1-4])$/i.exec(s);
  if (mq) return `${mq[1]}Q${mq[2]}`;
  const md = /^(\d{4})[-/](\d{1,2})/.exec(s);
  if (!md) throw new Error('看不懂的季度 / 日期：' + s);
  const q = Math.floor((Number(md[2]) - 1) / 3) + 1;
  return `${md[1]}Q${q}`;
}

/** 季度窗口：[from, to)，to 是下季度的第一天 */
export function seasonRange(q) {
  const s = seasonOf(q);
  const [ys, qs] = s.split('Q');
  const y = Number(ys);
  const n = Number(qs);
  const startM = (n - 1) * 3 + 1;
  const endY = n === 4 ? y + 1 : y;
  const endM = n === 4 ? 1 : startM + 3;
  return { q: s, from: `${y}-${pad2(startM)}-01`, to: `${endY}-${pad2(endM)}-01` };
}

const WD_CN = { 星期一: 1, 星期二: 2, 星期三: 3, 星期四: 4, 星期五: 5, 星期六: 6, 星期日: 7, 星期天: 7 };

/** 从 infobox 里抠「放送星期」（bgm 的详情接口没有单独的 air_weekday 字段） */
export function weekdayFromInfobox(subject) {
  const box = Array.isArray(subject?.infobox) ? subject.infobox : [];
  const hit = box.find((x) => /放送星期|播放星期/.test(String(x?.key || '')));
  if (!hit) return null;
  const v = Array.isArray(hit.value) ? hit.value.map((x) => x?.v ?? x).join(' ') : String(hit.value ?? '');
  for (const k of Object.keys(WD_CN)) if (v.includes(k)) return WD_CN[k];
  return null;
}

/** 详情 → 统一结构（时间接口没有，只能留空等手填） */
export function subjectMeta(subject) {
  if (!subject || !subject.id) throw new Error('subject 没有 id');
  const img = subject.images || {};
  return {
    id: Number(subject.id),
    name: subject.name || '',
    name_cn: subject.name_cn || subject.name || String(subject.id),
    date: subject.date || '',
    eps: Number(subject.eps || subject.total_episodes || 0) || 0,
    weekday: weekdayFromInfobox(subject),
    rating: Number(subject.rating?.score) || null,
    tags: (Array.isArray(subject.tags) ? subject.tags : []).slice(0, 4).map((t) => t?.name).filter(Boolean),
    meta: Array.isArray(subject.meta_tags) ? subject.meta_tags : [],
    platform: subject.platform || '',
    // 封面：面板/桌宠摊开看时好认；小图够用（grid 约 100px）
    image: img.grid || img.small || img.common || img.medium || img.large || '',
    image_large: img.large || img.common || '',
  };
}

/** 单部详情（懒加载：点开某一行才拉，省得 167 次请求） */
export async function fetchSubject(id, opts = {}) {
  const base = opts.base || 'https://api.bgm.tv';
  const data = await getJson(`${base}/v0/subjects/${Number(id)}`, opts);
  return subjectMeta(data);
}

/**
 * 拉整季番剧：/v0/search/subjects 按放送日窗口 + 热度排序，分页取完。
 * @returns {{q:string, from:string, to:string, total:number, items:Array}}
 */
export async function fetchSeason(opts = {}) {
  const base = opts.base || 'https://api.bgm.tv';
  const { q, from, to } = seasonRange(opts.q || new Date());
  const limit = Math.min(Number(opts.limit) || 50, 50);
  const maxPages = Math.max(1, Number(opts.maxPages) || 12);
  const conc = Math.max(1, Math.min(Number(opts.concurrency) || 4, 6));
  const mkBody = () => ({
    keyword: '',
    sort: opts.sort || 'heat',
    filter: { type: [2], air_date: [`>=${from}`, `<${to}`], nsfw: !!opts.nsfw },
  });
  const page = (offset) =>
    getJson(`${base}/v0/search/subjects?limit=${limit}&offset=${offset}`, {
      ...opts,
      method: 'POST',
      body: mkBody(),
    });

  // 第 1 页拿 total 与「实际一页几条」，剩下的一次并发抓完。
  // 以前是 12 页串行（实测 16–21 秒），并发 4 之后 4–6 秒。
  const first = await page(0);
  const firstData = Array.isArray(first?.data) ? first.data : [];
  const total = Number(first?.total) || 0;
  const items = [];
  for (const it of firstData) items.push(subjectMeta(it));

  const per = firstData.length || limit;      // 接口可能不按 limit 给（实测一页 20 条）
  const offsets = [];
  const want = Math.min(maxPages, Math.max(1, Math.ceil((total || per * maxPages) / per)));
  for (let i = 1; i < want; i++) offsets.push(i * per);

  if (offsets.length) {
    const rest = await mapLimit(offsets, conc, async (off) => {
      try {
        const r = await page(off);
        return Array.isArray(r?.data) ? r.data.map(subjectMeta) : [];
      } catch {
        return [];                             // 单页失败不影响整季
      }
    });
    for (const arr of rest) for (const it of arr) items.push(it);
  }

  const seen = new Set();
  const uniq = [];
  for (const x of items) {
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    uniq.push(x);
  }
  // 已有放送日的按日期排，同一天保持接口给的热度顺序
  uniq.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { q, from, to, total: total || uniq.length, items: uniq };
}

/* ------------------------------------------------------------------ *
 * 合并（纯函数）
 * ------------------------------------------------------------------ */

/** 把 /calendar 翻成 id → 星期(1..7) */
export function weekdayMap(calendar) {
  const map = new Map();
  for (const day of calendar || []) {
    const wd = Number(day?.weekday?.id);
    for (const item of day.items || []) map.set(String(item.id), wd);
  }
  return map;
}

const same = (a, b) => String(a ?? '') === String(b ?? '');

/**
 * 放送表 → 扁平的条目清单。
 * Bgm 的 /calendar 只给「周几播 + 首播日期」，没有具体时刻（那是各家电视台的事），
 * 所以 time_cst 留空，界面上会显示「不定期」，等你手填。
 * @returns {Array<{id:number, name:string, name_cn:string, weekday:number, air_date:string|null}>}
 */
export function calendarEntries(calendar) {
  const out = [];
  for (const day of calendar || []) {
    const wd = Number(day?.weekday?.id) || Number(day?.weekday?.id) || null;
    for (const it of day.items || []) {
      const id = Number(it?.id);
      if (!id) continue;
      out.push({
        id,
        name: it.name || '',
        name_cn: it.name_cn || it.name || String(id),
        weekday: Number(it.air_weekday) || wd || null,
        air_date: it.air_date || null,
      });
    }
  }
  return out;
}

/**
 * 合并接口数据到 library。
 * @param {object} lib              原 library
 * @param {object} data             { calendar, collections }
 * @param {object} [opts]           { takeProgress=false, now=new Date() }
 * @returns {{ next:object, changes:Array<{scope:string,id:any,field:string,from:any,to:any,note?:string}> }}
 */
export function mergeLibrary(lib, data, opts = {}) {
  const takeProgress = !!opts.takeProgress;
  const weekdayMode = opts.weekday === 'all' || opts.weekday === 'watching' ? opts.weekday : 'watching';
  const next = JSON.parse(JSON.stringify(lib));
  const changes = [];
  const wmap = weekdayMap(data.calendar);
  const watching = Array.isArray(next.watching) ? next.watching : (next.watching = []);
  const byId = new Map(watching.map((w) => [String(w.id), w]));
  const inactive = inactiveWatchIds(next);

  const set = (scope, obj, id, field, value, note) => {
    if (same(obj[field], value)) return;
    changes.push({ scope, id, field, from: obj[field] ?? null, to: value ?? null, note });
    if (value === undefined) delete obj[field];
    else obj[field] = value;
  };

  // 1) 收藏里的「在看」：新番入库 / 老番补名字与集数
  for (const it of data.collections || []) {
    const id = it?.subject_id ?? it?.subject?.id;
    if (!id || inactive.has(String(id))) continue;
    const subject = it.subject || {};
    const wd = wmap.has(String(id)) ? wmap.get(String(id)) : undefined;
    const epsTotal = Number(subject.eps || subject.total_episodes || 0) || undefined;

    let w = byId.get(String(id));
    if (!w) {
      w = { id: Number(id), name_cn: subject.name_cn || subject.name || String(id), name: subject.name || '', eps: epsTotal || 0, ep_status: takeProgress ? Number(it.ep_status || 0) : 0, air_weekday: wd ?? null, air_time_cst: null, rate: null, priority: '在追', last_watched: null, comment: '' };
      watching.push(w);
      byId.set(String(id), w);
      changes.push({ scope: 'watching', id, field: '(新增)', from: null, to: w.name_cn, note: '来自在看收藏' });
      continue;
    }
    if (subject.name_cn && !w.name_manual) set('watching', w, id, 'name_cn', subject.name_cn);
    if (subject.name) set('watching', w, id, 'name', subject.name);
    if (epsTotal && !w.eps_manual) {
      const before = Number(w.eps) || 0;
      set('watching', w, id, 'eps', epsTotal);
      // 总话数变多 = 有新集（或官方补登）。记下时间，面板与桌宠据此显示「新」标记，
      // 不做推送、不打断——判断要不要看是用户的事。
      if (epsTotal > before) {
        w.eps_updated_at = isoDate(opts.now || new Date());
        w.eps_prev = before || null;
      }
    }
    if (wd != null && !w.schedule_manual) set('watching', w, id, 'air_weekday', wd);
    if (takeProgress) set('watching', w, id, 'ep_status', Number(it.ep_status || 0));
  }

  // 2) 放送表里的番：即使没在收藏里，也把「周几播」补上（不动进度）
  if (data.calendar) {
    const entries = calendarEntries(data.calendar);
    const startById = new Map(entries.filter((e) => e.air_date).map((e) => [String(e.id), e.air_date]));
    for (const w of watching) {
      const wd = wmap.get(String(w.id));
      if (wd != null && !w.schedule_manual && !same(w.air_weekday, wd)) set('watching', w, String(w.id), 'air_weekday', wd, '来自本周放送表');
      const sd = startById.get(String(w.id));
      if (sd && !w.start_date) set('watching', w, String(w.id), 'start_date', sd, '来自放送表首播日');
    }

    // 3) 周表里已有条目的名字跟着 watching 校准
    for (const key of Object.keys(next.weekday || {})) {
      for (const entry of next.weekday[key]) {
        const w = byId.get(String(entry.id));
        if (w && w.name_cn && !same(entry.name_cn, w.name_cn)) set('weekday', entry, entry.id, 'name_cn', w.name_cn);
      }
    }

    // 4) 把放送表里还缺的番补进周表（mode=watching 只补在追的，mode=all 补全表）
    next.weekday = next.weekday || {};
    for (let d = 1; d <= 7; d++) if (!Array.isArray(next.weekday[String(d)])) next.weekday[String(d)] = [];
    const haveIds = new Set();
    for (let d = 1; d <= 7; d++) for (const e of next.weekday[String(d)]) haveIds.add(String(e.id));
    const pool = weekdayMode === 'all' ? entries : entries.filter((e) => byId.has(String(e.id)));
    for (const e of pool) {
      const wd = Number(e.weekday);
      if (!(wd >= 1 && wd <= 7)) continue;
      if (haveIds.has(String(e.id)) || inactive.has(String(e.id)) || byId.get(String(e.id))?.schedule_manual) continue;
      next.weekday[String(wd)].push({ id: e.id, name_cn: e.name_cn, time_cst: null, ep_expected: null });
      haveIds.add(String(e.id));
      changes.push({ scope: 'weekday', id: e.id, field: '(新增)', from: null, to: e.name_cn, note: `放送表周${wd}` });
    }
    for (let d = 1; d <= 7; d++) {
      next.weekday[String(d)].sort((a, b) => (a.time_cst || '99:99').localeCompare(b.time_cst || '99:99'));
    }
  }

  if (changes.length) next.updated = (opts.now ? isoDate(opts.now) : isoDate(new Date()));
  return { next, changes };
}

/**
 * 本季表勾选 → library（纯函数）。
 * @param {object} lib   原 library
 * @param {Array}  items fetchSeason 的 items
 * @param {object} opts  { add:[ids], remove:[ids], track_from:'2026-11-04', now:Date }
 * @returns {{next:object, changes:Array}}
 */
export function mergeSeason(lib, items, opts = {}) {
  const add = (opts.add || []).map(String);
  const remove = (opts.remove || []).map(String);
  const now = opts.now || new Date();
  const trackFrom = opts.track_from || isoDate(now);
  const next = JSON.parse(JSON.stringify(lib));
  const changes = [];
  const watching = Array.isArray(next.watching) ? next.watching : (next.watching = []);
  const dropped = Array.isArray(next.dropped) ? next.dropped : (next.dropped = []);
  const byId = new Map(watching.map((w) => [String(w.id), w]));
  const droppedById = new Map(dropped.map((w) => [String(w.id), w]));
  const itemById = new Map((items || []).map((x) => [String(x.id), x]));
  const inactive = inactiveWatchIds(next);

  // 1) 退追：watching → dropped（保留进度，再追能接上）
  for (const id of remove) {
    const w = byId.get(id);
    if (!w) continue;
    const i = watching.findIndex((x) => String(x.id) === id);
    if (i >= 0) watching.splice(i, 1);
    byId.delete(id);
    w.dropped_at = isoDate(now);
    dropped.push(w);
    droppedById.set(id, w);
    changes.push({ scope: 'watching', id, field: '(退追)', from: w.name_cn, to: null });
  }

  // 2) 追番：新加 / 从弃番里恢复
  for (const id of add) {
    if (inactive.has(id)) continue;
    if (byId.has(id)) {
      changes.push({ scope: 'watching', id, field: '(已在追)', from: null, to: null, note: '跳过' });
      continue;
    }
    const it = itemById.get(id) || {};
    const old = droppedById.get(id);
    const w = old ? { ...old } : {
      id: Number(id),
      name: it.name || '',
      name_cn: it.name_cn || it.name || String(id),
      eps: Number(it.eps) || 0,
      ep_status: 0,
      air_weekday: it.weekday ?? null,
      air_time_cst: null,
      rate: null,
      priority: '在追',
      last_watched: null,
      comment: '',
      start_date: it.date || null,
    };
    delete w.dropped_at;
    if (it.eps && !w.eps_manual) w.eps = Number(it.eps);
    if (it.weekday && !w.schedule_manual) w.air_weekday = it.weekday;
    if (it.date && !w.start_date) w.start_date = it.date;
    if (!w.name_cn) w.name_cn = it.name_cn || it.name || String(id);
    // 新番和老番的区别只在这儿：新番从加入日开始记账
    w.track_from = w.track_from || trackFrom;
    watching.push(w);
    byId.set(id, w);
    const di = dropped.findIndex((x) => String(x.id) === id);
    if (di >= 0) dropped.splice(di, 1);
    changes.push({ scope: 'watching', id, field: old ? '(恢复)' : '(新增)', from: null, to: w.name_cn, note: old ? '从弃番里恢复' : '本季表勾选' });

    // 星期表补一条，今日/本周排片立刻能看到
    const wd = Number(w.air_weekday);
    if (wd >= 1 && wd <= 7) {
      next.weekday = next.weekday || {};
      const key = String(wd);
      if (!Array.isArray(next.weekday[key])) next.weekday[key] = [];
      if (!next.weekday[key].some((e) => String(e.id) === id)) {
        next.weekday[key].push({ id: Number(id), name_cn: w.name_cn, time_cst: w.air_time_cst || null, ep_expected: null });
        changes.push({ scope: 'weekday', id, field: '(新增)', from: null, to: w.name_cn, note: `周${wd}` });
      }
      next.weekday[key].sort((a, b) => (a.time_cst || '99:99').localeCompare(b.time_cst || '99:99'));
    }
  }

  if (changes.length) next.updated = isoDate(now);
  return { next, changes };
}

function isoDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}
