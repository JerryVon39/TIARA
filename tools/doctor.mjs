#!/usr/bin/env node
/**
 * tools/doctor.mjs —— 一次把「该有的文件 / 数据是否合法 / 立绘是否到位 / 服务与桌宠是否在跑」全查一遍。
 *
 *   node tools/doctor.mjs          # 只看结论
 *   node tools/doctor.mjs --json   # 给别的脚本吃
 *
 * 退出码：0 = 没有 error；1 = 有 error（warning 不影响）。
 * 只读，不改任何文件 —— 敢在出问题时随便跑。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { expectedEpisode } from '../lib/today.mjs';
import { DEFAULT_NICKNAME, normalizeNickname } from '../lib/persona.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AS_JSON = process.argv.includes('--json');
const PORT = Number(process.env.PANEL_PORT || 7788);

const results = [];
const add = (level, name, detail) => results.push({ level, name, detail });

const exists = async (rel) => {
  try {
    await fs.access(path.join(ROOT, rel));
    return true;
  } catch {
    return false;
  }
};
const readJson = async (rel) => JSON.parse(await fs.readFile(path.join(ROOT, rel), 'utf8'));

// ---------- 1. Node 版本 ----------
const major = Number(process.versions.node.split('.')[0]);
add(major >= 18 ? 'ok' : 'error', 'node 版本', `${process.versions.node}${major >= 18 ? '' : '（需要 18 以上）'}`);

// ---------- 2. 关键文件 ----------
const critical = [
  ['server.mjs', true],
  ['lib/today.mjs', true],
  ['panel/index.html', true],
  ['data/library.json', true],
  ['data/talks.json', false],
  ['ghost/master/today.txt', false],
  ['pet/Pet.exe', false],
  ['pet/Pet.cs', false],
];
for (const [rel, must] of critical) {
  const okFile = await exists(rel);
  add(okFile ? 'ok' : must ? 'error' : 'warn', `文件 ${rel}`, okFile ? '在' : '缺失');
}

// ---------- 2.5 面板拆分 / 版本真源 / 发布包 ----------
// 面板拆成 index.html + style.css + app.js 之后，「文件在不在」和「引用对不对」会悄悄分叉：
// 少一个 app.js，浏览器只在控制台报 404，页面看起来「什么都没发生」。
try {
  const html = await fs.readFile(path.join(ROOT, 'panel', 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1]);
  const missing = [];
  for (const rel of refs) if (!(await exists(path.join('panel', rel)))) missing.push(rel);
  if (missing.length) add('error', '面板引用的文件', missing.map((x) => `panel/${x} 缺失`).join('、'));
  else add('ok', '面板引用的文件', refs.length ? `${refs.length} 个都在` : '单文件面板');
  if (/<script[^>]+type="module"/i.test(html)) {
    add('error', '面板脚本类型', '用了 type="module"：file:// 打开时会被 CORS 拦死，改成普通 <script src>');
  }
} catch (e) {
  add('error', 'panel/index.html', e.message);
}

try {
  const pkg = await readJson('package.json');
  const readme = await fs.readFile(path.join(ROOT, 'README.md'), 'utf8');
  const m = /^当前版本 v([\d.]+) · (\d{4}-\d{2}-\d{2})$/m.exec(readme);
  if (!m) add('warn', 'README 版本行', '找不到「当前版本 vX · YYYY-MM-DD」，跑 node tools/sync_docs.mjs');
  else if (m[1] !== pkg.version) {
    add('warn', 'README 版本行', `README 是 v${m[1]}，package.json 是 v${pkg.version}（跑 node tools/sync_docs.mjs）`);
  } else add('ok', '版本号', `v${pkg.version} · ${m[2]}`);
} catch (e) {
  add('warn', '版本号', e.message);
}

try {
  await fs.access(path.join(ROOT, 'dist', 'manifest.json'));
  const man = await readJson('dist/manifest.json');
  const built = String(man.built_at || '').slice(0, 10);
  const t = new Date(Date.now() + 8 * 3600e3);
  const todayStr = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
  const ageDays = built ? Math.round((Date.parse(todayStr) - Date.parse(built)) / 86400e3) : 999;
  if (ageDays > 14) add('warn', 'dist 发布包', `上次打包 ${built || '未知'}（${ageDays} 天前），跑 npm run pack 重打`);
  else add('ok', 'dist 发布包', `built_at ${built}`);
} catch {
  add('info', 'dist 发布包', '还没有 dist/（跑 npm run pack 生成）');
}

// ---------- 3. 番组库 ----------
let lib = null;
try {
  lib = await readJson('data/library.json');
} catch (e) {
  add('error', 'library.json 解析', e.message);
}

if (lib) {
  const watching = Array.isArray(lib.watching) ? lib.watching : [];
  if (!watching.length) add('warn', 'library.json watching', '一部都没有，桌宠只会说空话');

  // 编码体检：宁可在写坏的那一刻就被发现，也别等到发现追番全没了
  try {
    const raw = await fs.readFile(path.join(ROOT, 'data/library.json'));
    const text = raw.toString('utf8');
    const clean = Buffer.from(text, 'utf8').equals(raw) && !text.includes('\uFFFD');
    // 双重编码成「锛绾鐢」这种形状：正常中文里几乎不会出现这几个字
    const garbled = /[锛銆绾鐢瓒鍦鏄]/.test(text);
    if (!clean) add('error', 'library.json 编码', '不是干净的 UTF-8（写回时可能已经损坏，用 data/backups 里的备份恢复）');
    else if (garbled) add('error', 'library.json 编码', '疑似 GBK 乱码（工具用 Set-Content 写过？从 data/backups 恢复）');
    else add('ok', 'library.json 编码', 'UTF-8 正常');
  } catch (e) {
    add('error', 'library.json 编码', e.message);
  }

  const bad = watching.filter((w) => typeof w.id !== 'number' || typeof w.eps !== 'number');
  add(bad.length ? 'error' : 'ok', 'library.json 必填字段', bad.length ? `${bad.length} 条缺 id/eps` : `${watching.length} 部`);

  const noCn = watching.filter((w) => !w.name_cn).map((w) => w.id);
  if (noCn.length) add('warn', 'library.json name_cn', `这些没有中文名：${noCn.join(', ')}（界面会退回 name）`);

  // 时刻是可选的：只影响「本周排片」里的先后与到点提醒，不该阻止开工
  const noTime = watching.filter((w) => w.air_weekday != null && !w.air_time_cst).map((w) => w.id);
  if (noTime.length) {
    add('info', 'library.json air_time_cst',
      `${noTime.length} 部只有星期没有时刻：${noTime.slice(0, 5).join(', ')}${noTime.length > 5 ? ' …' : ''}（可选；不填就按「不定期」排，也不到点提醒）`);
  }

  const wrongWeekday = watching.filter((w) => w.air_weekday != null && (w.air_weekday < 1 || w.air_weekday > 7));
  add(wrongWeekday.length ? 'error' : 'ok', 'library.json air_weekday', wrongWeekday.length ? '必须 1–7（周一=1）' : '范围正常');

  const weekday = lib.weekday || {};
  const missing = ['1', '2', '3', '4', '5', '6', '7'].filter((d) => !Array.isArray(weekday[d]));
  if (missing.length) add('warn', 'library.json weekday', `缺第 ${missing.join('/')} 天（会当成没有排片）`);
  else add('ok', 'library.json weekday', '七天齐');

  // 同一部番在 watching 与 weekday 里名字对不上，会被当成两部
  const byId = new Map(watching.map((w) => [w.id, w]));
  const drift = [];
  for (const d of Object.keys(weekday)) {
    for (const it of weekday[d] || []) {
      const w = byId.get(it.id);
      if (w && it.name_cn && w.name_cn && it.name_cn !== w.name_cn) drift.push(`${it.id}:${it.name_cn} ≠ ${w.name_cn}`);
    }
  }
  if (drift.length) add('warn', 'library.json 名字一致性', drift.slice(0, 3).join('；'));

  // 同一部番在 watching.air_weekday 与 weekday 桶里挂在不同的天 → 本周排片会「消失」
  const bucketDrift = [];
  for (const d of Object.keys(weekday)) {
    for (const it of weekday[d] || []) {
      const w = byId.get(it.id);
      if (w && w.air_weekday != null && String(w.air_weekday) !== String(d)) {
        bucketDrift.push(`${it.id}（在追写周${w.air_weekday}，桶在周${d}）`);
      }
    }
  }
  if (bucketDrift.length) {
    add('warn', 'library.json 放送日一致性',
      `${bucketDrift.length} 部对不上：${bucketDrift.slice(0, 3).join('；')}（本周排片会按桶算，可能不显示）`);
  } else {
    add('ok', 'library.json 放送日一致性', '在追与星期表一致');
  }

  // 待看（落后于播出进度）只当信息报：这不是错误，是「今天该补」的提示。
  // 口径与面板一致：expectedEpisode(本周该看到第几话) − ep_status，不是「总话数 − 已看」。
  const nowD = new Date();
  const behind = watching
    .map((w) => {
      const exp = expectedEpisode(w, lib, nowD);
      const gap = exp == null ? 0 : exp - Number(w.ep_status || 0);
      return { id: w.id, gap: Number.isFinite(gap) ? gap : 0 };
    })
    .filter((x) => x.gap > 0);
  if (behind.length) {
    add('info', '待看队列', `${behind.length} 部落后合计 ${behind.reduce((s, x) => s + x.gap, 0)} 话（面板顶栏「待看 N」能看到）`);
  } else {
    add('ok', '待看队列', '都看齐了');
  }
}

// ---------- 4. 台词池 ----------
if (await exists('data/talks.json')) {
  try {
    const talks = await readJson('data/talks.json');
    const pools = Object.entries(talks).filter(([, v]) => Array.isArray(v));
    const empty = pools.filter(([, v]) => !v.length).map(([k]) => k);
    add(empty.length ? 'warn' : 'ok', 'talks.json 台词池', `${pools.length} 个池${empty.length ? `，空的：${empty.join(',')}` : ''}`);
  } catch (e) {
    add('error', 'talks.json 解析', e.message);
  }
}

// ---------- 4.5 偏好：时间制式 / 桌宠尺寸 / 称呼 ----------
if (await exists('data/settings.json')) {
  try {
    const st = await readJson('data/settings.json');
    add(st.clock === '24h' || st.clock === '30h' ? 'ok' : 'warn', '时间制式', `${st.clock || '未设置'}`);
    const sc = Number(st.pet_scale);
    add(sc >= 0.5 && sc <= 2 ? 'ok' : 'warn', '桌宠尺寸', `${(Number.isFinite(sc) ? sc : 1) * 100}%`);
  } catch (e) {
    add('error', 'settings.json 解析', e.message);
  }
} else {
  add('ok', '时间制式', '默认 30 小时制（没用 settings.json）');
  add('ok', '桌宠尺寸', '默认 100%（没用 settings.json）');
}

// ---------- 4.6 称呼（她怎么叫用户） ----------
// 称呼是用户数据，存在 library.json 的 user.nickname_for_pet；
// 库里写了非法值时要显式指出来，因为运行时会静默回落到「会長」——
// 用户改了半天空白/超长，却没生效，会以为程序坏了。
if (await exists('data/library.json')) {
  try {
    const lib = await readJson('data/library.json');
    const raw = lib?.user?.nickname_for_pet;
    const r = normalizeNickname(raw);
    if (raw == null) add('ok', '称呼', `${DEFAULT_NICKNAME}（库里没写，用默认值）`);
    else if (r.ok) add('ok', '称呼', `${r.value}${r.value === raw ? '' : `（已规整，原值「${raw}」）`}`);
    else add('warn', '称呼', `library.json 的 user.nickname_for_pet 不可用（${r.error}），实际会用「${DEFAULT_NICKNAME}」`);
  } catch (e) {
    add('error', 'library.json 解析（称呼）', e.message);
  }
}

// ---------- 5. 立绘 ----------
const faceFiles = ['surface0', 'surface1', 'surface2', 'surface3', 'surface4', 'surface5', 'talk'];
const present = [];
for (const name of faceFiles) {
  if (await exists(`shell/master/${name}.png`)) present.push(name);
}
if (!present.length) add('error', 'shell/master 立绘', '一张都没有，桌宠会白屏');
else if (present.length < 5) add('warn', 'shell/master 立绘', `${present.length} 张（缺的表情会自动回退到 normal/sad）`);
else add('ok', 'shell/master 立绘', `${present.length} 张`);

// PNG 尺寸（IHDR 宽高在第 16–24 字节）
try {
  const buf = await fs.readFile(path.join(ROOT, 'shell/master/surface0.png'));
  if (buf.slice(1, 4).toString() === 'PNG') {
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    add(w === 384 && h === 576 ? 'ok' : 'warn', 'surface0 尺寸', `${w}x${h}（推荐 384x576）`);
  } else {
    add('warn', 'surface0 格式', '不是 PNG');
  }
} catch {
  add('warn', 'surface0 尺寸', '读不到');
}

// faces.json（分层立绘/分区命中）——桌宠缺它会退回「整图 + 上部 26% 算头」
try {
  const { checkFaces } = await import('./check_faces.mjs');
  const fc = checkFaces();
  if (!fc.ok) add('error', 'faces.json', fc.errors.slice(0, 3).join('；'));
  else if (fc.warns.length) add('warn', 'faces.json', fc.warns.slice(0, 2).join('；'));
  else add('ok', 'faces.json', `${fc.faces} 个表情 / ${fc.regions} 个区域`);
} catch (e) {
  add('warn', 'faces.json', '校验失败：' + e.message);
}

// ---------- 6. today.txt 是否新鲜 ----------
const pad = (n) => String(n).padStart(2, '0');
const nowCst = new Date(Date.now() + 8 * 3600 * 1000);
const todayStr = `${nowCst.getUTCFullYear()}-${pad(nowCst.getUTCMonth() + 1)}-${pad(nowCst.getUTCDate())}`;
if (await exists('ghost/master/today.txt')) {
  const txt = await fs.readFile(path.join(ROOT, 'ghost/master/today.txt'), 'utf8');
  const m = /^date=(.*)$/m.exec(txt);
  const d = m ? m[1].trim() : '';
  if (d === todayStr) add('ok', 'today.txt 日期', d);
  else add('warn', 'today.txt 日期', `${d || '?'} 不是今天（${todayStr}），跑一下 node tools/build_today.mjs`);
} else {
  add('warn', 'today.txt', '还没生成（桌宠会说读不到数据）');
}

// ---------- 7. 面板服务 / 桌宠 ----------
const probe = (port) =>
  new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.end();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(600, () => {
      sock.destroy();
      resolve(false);
    });
  });

const portOpen = await probe(PORT);
add(portOpen ? 'ok' : 'warn', `面板端口 ${PORT}`, portOpen ? '有服务在听' : '没在跑（双击 打开番组表.bat）');

let petLogAt = 0;
try {
  petLogAt = (await fs.stat(path.join(ROOT, 'pet/pet.log'))).mtimeMs;
} catch {}
const petAlive = Date.now() - petLogAt < 120000;
add(petAlive ? 'ok' : 'warn', '桌宠', petAlive ? '刚写过日志，应该在跑' : '最近两分钟没日志（可能没开，或刚启动）');

// ---------- 8. 桌宠状态文件 ----------
if (await exists('data/state.json')) {
  try {
    const st = JSON.parse(await fs.readFile(path.join(ROOT, 'data/state.json'), 'utf8'));
    const layerOk = !st.layer || ['top', 'normal', 'bottom'].includes(st.layer);
    add(layerOk ? 'ok' : 'warn', 'state.json layer', st.layer ? `layer=${st.layer}` : '没写（默认 top）');
    const r = Array.isArray(st.reminded) ? st.reminded.length : 0;
    add('ok', 'state.json 提醒记录', `${r} 条（防止重启后重复提醒）`);
    const num = (v) => typeof v === 'number' && Number.isFinite(v);
    if (st.left != null && !num(st.left)) add('warn', 'state.json 位置', 'left 不是数字，窗口会回到右下角');
  } catch (e) {
    add('warn', 'state.json 解析', `${e.message}（删掉它就会回到默认位置）`);
  }
}

// ---------- 9. 备份 / 历史 ----------
const bak = await exists('data/library.json.bak');
add(bak ? 'ok' : 'warn', 'data/library.json.bak', bak ? '在（面板「恢复上一版」可用）' : '还没有（第一次写入后才有）');

let histLines = 0;
if (await exists('data/history.jsonl')) {
  const txt = await fs.readFile(path.join(ROOT, 'data/history.jsonl'), 'utf8');
  histLines = txt.split('\n').filter((l) => l.trim()).length;
  add('ok', 'data/history.jsonl', `${histLines} 条记录`);
}
try {
  const files = await fs.readdir(path.join(ROOT, 'data/backups'));
  add('ok', 'data/backups', `${files.length} 份滚动备份${files.length >= 5 ? '（已到上限，旧的会被顶掉）' : ''}`);
} catch {
  /* 没有就跳过，不算问题 */
}

// 按日快照（data/backups/YYYY-MM-DD/）——出事了能退回某一天的整份数据
try {
  const { snapshotInfo } = await import('./snapshot_daily.mjs');
  const si = snapshotInfo();
  const pad2 = (n) => String(n).padStart(2, '0');
  const cst = new Date(Date.now() + 8 * 3600 * 1000);
  const today = `${cst.getUTCFullYear()}-${pad2(cst.getUTCMonth() + 1)}-${pad2(cst.getUTCDate())}`;
  if (!si.days.length) add('info', '按日快照', '还没有（第一次写入库或启动面板后会有）');
  else if (si.latest !== today) add('info', '按日快照', `最新 ${si.latest}，今天还没存（下次启动面板会补）`);
  else add('ok', '按日快照', `共 ${si.days.length} 天，最新 ${si.latest}`);
} catch (e) {
  add('warn', '按日快照', '检查失败：' + e.message);
}

// ---------- 10. 面板端口（可能不是 7788） ----------
let livePort = null;
for (let p = 7788; p <= 7799 && livePort == null; p++) {
  if (await probe(p)) livePort = p;
}
if (livePort != null && livePort !== PORT) {
  add('warn', `面板端口 ${PORT}`, `实际在 ${livePort}（7788 被占了，桌宠会自动找到它）`);
}

// ---------- 10.5 Bangumi 同步配置 / 本季缓存 ----------
{
  let cfg = null;
  try {
    cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'data/bgm.json'), 'utf8'));
  } catch {
    add('warn', 'data/bgm.json', '还没建（面板「账号」或 tools/sync_bangumi.mjs 第一次写入时会建）');
  }
  if (cfg) {
    const bits = [];
    bits.push(cfg.user ? `账号 ${cfg.user}` : '未填账号');
    bits.push(cfg.token ? '有 token' : '无 token（只能拉公共放送表）');
    bits.push(cfg.proxy ? `代理 ${cfg.proxy}` : '直连');
    add('ok', 'data/bgm.json', bits.join(' · '));
  }
  try {
    const files = (await fs.readdir(path.join(ROOT, 'data/season'))).filter((f) => f.endsWith('.json'));
    if (!files.length) {
      add('warn', 'data/season', '还没有本季缓存（面板「本季番剧」点一次刷新就有了）');
    } else {
      let fresh = 0;
      const nowMs = Date.now();
      for (const f of files) {
        try {
          const j = JSON.parse(await fs.readFile(path.join(ROOT, 'data/season', f), 'utf8'));
          if (nowMs - new Date(j.fetched_at || 0).getTime() < 12 * 3600 * 1000) fresh++;
        } catch {
          /* 坏文件忽略 */
        }
      }
      add(fresh ? 'ok' : 'warn', 'data/season', `${files.length} 份缓存，${fresh} 份还在 12 小时内${fresh ? '' : '（要点一次刷新）'}`);
    }
  } catch {
    add('warn', 'data/season', '目录还没建（正常，拉过一次本季表就有）');
  }
}

// ---------- 11. SSP 人格（到点提醒） ----------
{
  const yayaFiles = ['ghost/master/yaya.txt', 'ghost/master/basis.dic', 'ghost/master/today.json'];
  const lack = [];
  for (const f of yayaFiles) if (!(await exists(f))) lack.push(f);
  if (lack.length) {
    add('warn', 'SSP 人格', `缺 ${lack.join(', ')}（跑 node tools/build_ghost.mjs）`);
  } else {
    const dic = await fs.readFile(path.join(ROOT, 'ghost/master/basis.dic'), 'utf8');
    const hasTick = dic.includes('OnSecondChange');
    let shows = -1;
    try {
      const j = await readJson('ghost/master/today.json');
      shows = Array.isArray(j.all_shows) ? j.all_shows.length : -1;
    } catch {
      /* 无法读取提醒快照时，下面会报告警告。 */
    }
    add(
      hasTick && shows > 0 ? 'ok' : 'warn',
      'SSP 人格',
      hasTick
        ? `OnSecondChange 在，all_shows ${shows} 部（提醒靠 ghost/master/today.json）`
        : 'basis.dic 里没有 OnSecondChange，到点不会提醒'
    );
  }
}

// ---------- 11.5 产物是否同步 ----------
try {
  const a = await fs.stat(path.join(ROOT, 'data', 'today.json'));
  const b = await fs.stat(path.join(ROOT, 'ghost/master/today.json'));
  const lagMin = (a.mtimeMs - b.mtimeMs) / 60000;
  if (lagMin > 60) {
    add('warn', 'SSP 产物', `ghost/master/today.json 比 data/today.json 旧 ${Math.round(lagMin)} 分钟（跑 node tools/build_ghost.mjs）`);
  } else {
    add('ok', 'SSP 产物', 'ghost/master/today.json 与 data/today.json 同步');
  }
} catch {
  /* 缺文件已在上一节报过 */
}

// ---------- 11.8 cache/ 体积（临时浏览器 profile 会悄悄堆到几百 MB） ----------
try {
  const cacheDir = path.join(ROOT, 'cache');
  let total = 0;
  let profiles = 0;
  const walk = async (dir) => {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else total += (await fs.stat(p)).size;
    }
  };
  const base = await fs.readdir(cacheDir, { withFileTypes: true });
  for (const e of base) if (e.isDirectory() && /^(cdp_profile_|probe_prof_|edgeprof_)/.test(e.name)) profiles += 1;
  await walk(cacheDir);
  const mb = total / 1024 / 1024;
  if (mb > 200) add('warn', 'cache/ 体积', `${mb.toFixed(0)} MB 偏大（跑 node tools/clean_cache.mjs --dry-run 看看）`);
  else if (profiles > 0) add('warn', 'cache/ 临时 profile', `残留 ${profiles} 个，跑 node tools/clean_cache.mjs`);
  else add('ok', 'cache/ 体积', `${mb.toFixed(1)} MB`);
} catch {
  add('ok', 'cache/ 体积', '没有 cache/（正常）');
}

// ---------- 11.9 封面缓存（远端图床直连基本拿不到，全靠这一层） ----------
try {
  const dir = path.join(ROOT, 'data', 'covers');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jpg'));
  let bytes = 0;
  for (const f of files) bytes += (await fs.stat(path.join(dir, f))).size;
  const mb = bytes / 1024 / 1024;
  if (files.length === 0) add('info', '封面缓存', '还没有（打开面板「本季」或「本周」就会陆续抓）');
  else add('ok', '封面缓存', `${files.length} 张 / ${mb.toFixed(2)} MB（data/covers/）`);
} catch {
  add('info', '封面缓存', '还没有（打开面板就会抓）');
}

// ---------- 12. 单测 ----------
try {
  const tests = (await fs.readdir(path.join(ROOT, 'test'))).filter((f) => f.endsWith('.test.mjs'));
  add(tests.length ? 'ok' : 'warn', '单测', tests.length ? `${tests.length} 个文件（node --test "test/*.test.mjs"）` : '没有 test/*.test.mjs');
} catch {
  add('warn', '单测', '没有 test/ 目录');
}

// ---------- 输出 ----------
const icon = { ok: '✅', warn: '⚠️ ', error: '❌', info: 'ℹ️ ' };
const errors = results.filter((r) => r.level === 'error');
const warns = results.filter((r) => r.level === 'warn');
const infos = results.filter((r) => r.level === 'info');

if (AS_JSON) {
  console.log(JSON.stringify({ ok: !errors.length, errors: errors.length, warnings: warns.length, infos: infos.length, results }, null, 2));
} else {
  for (const r of results) {
    if (r.level === 'ok' && !process.argv.includes('-v')) continue;
    console.log(`${icon[r.level]} ${r.name}：${r.detail}`);
  }
  console.log('');
  if (errors.length) {
    console.log(`❌ ${errors.length} 个问题需要先修：`);
    for (const e of errors) console.log(`   · ${e.name} —— ${e.detail}`);
  } else {
    const bits = [];
    if (warns.length) bits.push(`${warns.length} 条提醒`);
    if (infos.length) bits.push(`${infos.length} 条信息`);
    console.log(`✅ 可以开工。${bits.length ? `另有 ${bits.join('、')}（不影响使用）。` : ''}`);
  }
}

process.exit(errors.length ? 1 : 0);
