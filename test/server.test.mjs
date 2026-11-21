/**
 * server.mjs 的接口测试（第四轮审计里「server.mjs 零测试」那一条）。
 *
 * 做法：把 server.mjs 当成黑盒进程起来——
 *   node server.mjs --port 0 --root <fixture>
 * `--root` 让所有读写都落在临时目录（不碰用户的 data/），
 * `--port 0` 让系统分配端口，真实端口从 <fixture>/cache/panel_port.txt 拿。
 *
 * 覆盖的是这一轮改过契约的地方：4xx 必须带 ok:false、坏 JSON 不能弄死进程、
 * 写库要更新 updated、恢复要挡路径穿越、时刻只认一种写法、删掉的接口真的 404。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildToday, cstParts } from '../lib/today.mjs';
import { seasonOf } from '../lib/bgm.mjs';
import { remindStamp } from '../lib/reminder-snooze.mjs';
import http from 'node:http';
import { once } from 'node:events';
import { panelId, probePanel } from '../lib/panel-instance.mjs';
import { snapshot } from '../tools/snapshot_daily.mjs';
import { readZip } from '../lib/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = cstParts().date;

let seq = 0;
async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `tiara-srv-${process.pid}-${++seq}-`));
  const lib = {
    version: 1,
    updated: '2026-01-01', // 故意过期：写入后必须被改成今天
    note: '',
    user: { nickname: 'YG' },
    watching: [{ id: '554779', name_cn: '学生会也有洞！', eps: 12, ep_status: 0, weekday: 1, air_time_cst: '23:00' }],
    weekday: { 1: [{ id: '554779', name_cn: '学生会也有洞！', eps: 12, air_time_cst: '23:00' }] },
    trivia: {},
    dropped: [],
  };
  const files = {
    'data/library.json': JSON.stringify(lib, null, 2) + '\n',
    'data/talks.json': JSON.stringify({ random: ['测试台词'], rules: ['测试规则'] }, null, 2) + '\n',
    'data/settings.json': JSON.stringify({ nickname: 'YG' }, null, 2) + '\n',
    'data/history.jsonl': '',
    'panel/index.html': '<!doctype html><html><body><div id="app">tiara</div><script src="./app.js"></script></body></html>\n',
    'panel/style.css': 'body{color:#fff}\n',
    'panel/app.js': 'window.__TIARA_TEST__ = true;\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text, 'utf8');
  }
  // 重建工具用桩：测试里不关心 today.txt，只关心接口的 rebuilt 语义
  for (const name of ['build_today.mjs', 'build_ghost.mjs']) {
    await fs.mkdir(path.join(root, 'tools'), { recursive: true });
    await fs.writeFile(path.join(root, 'tools', name), 'process.exit(0);\n', 'utf8');
  }
  for (const offset of [-92, 0, 92]) {
    const q = seasonOf(new Date(Date.now() + offset * 86400000));
    await fs.mkdir(path.join(root, 'data/season'), { recursive: true });
    await fs.writeFile(path.join(root, `data/season/${q}.json`), JSON.stringify({ q, items: [], fetched_at: new Date().toISOString() }));
  }
  return root;
}

async function startServer(root, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', '0', '--root', root], {
    cwd: ROOT,
    env: { ...process.env, BGM_BASE: 'http://127.0.0.1:1', BGM_BROADCAST_URL: 'http://127.0.0.1:1',
      BGM_PROXY: '', BGM_USER: '', BGM_TOKEN: '', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += String(b); });
  const portFile = path.join(root, 'cache', 'panel_port.txt');
  const deadline = Date.now() + 20000;
  let port = 0;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server 提前退出（code=${child.exitCode}）：${stderr}`);
    try {
      const txt = (await fs.readFile(portFile, 'utf8')).trim();
      port = Number(txt);
      if (port > 0) break;
    } catch { /* 还没写出来 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!port) throw new Error(`20 秒内没等到 ${portFile}：${stderr}`);
  return { child, port, getStderr: () => stderr };
}

test('日历导出按实际日期区分开播和补番；闹铃沿用提前量与分日免打扰', async t => {
  const root = await makeFixture();
  const lib = await readLib(root);
  lib.watching[0].air_time_cst = '25:30';
  lib.weekday[1][0].time_cst = '25:30';
  lib.watching.push({ id: 'local-ics', name_cn: '日历补番测试', watch_mode: 'catchup',
    catchup_slot: { day: 2, time: '19:15' }, ep_status: 2, eps: 9 });
  await fs.writeFile(path.join(root, 'data/library.json'), JSON.stringify(lib));
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const post = body => req(srv.port, '/api/settings', { method: 'POST', body });
  assert.equal((await post({ reminder_lead: 23 })).status, 400);
  assert.equal((await post({ quiet_work_start: '25:30', quiet_work_end: '02:00' })).status, 400);
  const settings = { reminder_lead: 15, quiet_work_start: '23:00', quiet_work_end: '02:00',
    quiet_weekend_start: '', quiet_weekend_end: '' };
  assert.equal((await post(settings)).status, 200);
  const exportIcs = (kind, alarm) =>
    req(srv.port, '/api/export?fmt=ics&from=2026-11-17&to=2026-11-17&kind=' + kind + '&alarm=' + alarm);
  const both = await exportIcs('both', 1);
  assert.match(both.text, /DTSTART;TZID=Asia\/Shanghai:20261117T013000/);
  assert.match(both.text, /DTSTART;TZID=Asia\/Shanghai:20261117T191500/);
  assert.equal((both.text.match(/BEGIN:VALARM/g) || []).length, 1);
  assert.match(both.text, /TRIGGER:-PT15M/);
  const catchup = await exportIcs('catchup', 0);
  assert.match(catchup.text, /日历补番测试/);
  assert.doesNotMatch(catchup.text, /T013000|VALARM/);
  const airing = await exportIcs('airing', 0);
  assert.doesNotMatch(airing.text, /T191500/);
  assert.equal((await req(srv.port, '/api/export?from=2026-01-01&to=2026-05-01')).status, 400);
  const backup = (await req(srv.port, '/api/migration')).json.migration;
  for (const key of Object.keys(settings)) assert.equal(backup.settings[key], settings[key]);
});

test('本机订阅保留同一事件标识，改期、暂停、继续和归档可刷新', async t => {
  const root = await makeFixture();
  const lib = await readLib(root);
  const scheduled = cstParts(new Date(Date.now() + 2 * 86400000));
  const moved = cstParts(new Date(Date.now() + 3 * 86400000));
  Object.assign(lib.watching[0], { air_weekday: scheduled.weekday, air_time_cst: '22:30' });
  lib.weekday = { [scheduled.weekday]: [{ id: '554779', name_cn: '试验排片', time_cst: '22:30' }] };
  await fs.writeFile(path.join(root, 'data/library.json'), JSON.stringify(lib));
  let srv = await startServer(root);
  t.after(() => srv.child.kill());
  const endpoint = '/api/calendar/feed.ics';
  const read = tag => req(srv.port, endpoint, { headers: tag ? { 'If-None-Match': tag } : {} });
  const post = (endpoint, body) => req(srv.port, endpoint, { method: 'POST', body: { id: '554779', ...body } });
  const block = (text, id) => text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g)?.find(entry => entry.includes('UID:' + id + '\r\n'));
  const uid = 'kx-' + scheduled.date + '-554779@tiara.local';
  const original = await read();
  const tag = original.headers.get('etag');
  assert.equal(original.status, 200);
  assert.equal((await read(tag)).status, 304);
  assert.match(block(original.text, uid), /SEQUENCE:0/);
  assert.doesNotMatch(original.text, /VALARM/);
  assert.equal((await post('/api/watch/schedule', { action: 'move', at: moved.date + 'T01:50' })).status, 200);
  const rescheduled = await read(tag);
  assert.equal(rescheduled.status, 200);
  const changed = block(rescheduled.text, uid);
  assert.ok(changed.includes('DTSTART;TZID=Asia/Shanghai:' + moved.date.replaceAll('-', '') + 'T015000'));
  assert.match(changed, /SEQUENCE:1/);
  assert.doesNotMatch(changed, /CANCELLED/);
  assert.equal((await post('/api/watch/lifecycle', { action: 'pause' })).status, 200);
  const paused = await read();
  assert.match(block(paused.text, uid), /SEQUENCE:2[\s\S]*STATUS:CANCELLED/);
  assert.equal((await post('/api/watch/lifecycle', { action: 'resume' })).status, 200);
  assert.match(block((await read()).text, uid), /SEQUENCE:3/);
  assert.equal((await post('/api/progress', { set: 12 })).status, 200);
  assert.equal((await post('/api/watch/lifecycle', { action: 'archive' })).status, 200);
  const archived = await read();
  assert.match(block(archived.text, uid), /SEQUENCE:4[\s\S]*STATUS:CANCELLED/);
  const exited = once(srv.child, 'exit');
  srv.child.kill();
  await exited;
  await fs.unlink(path.join(root, 'cache/panel_port.txt')).catch(() => {});
  srv = await startServer(root);
  assert.equal((await read(archived.headers.get('etag'))).status, 304);
});

test('已完播条目新增默认补番，旧库确认后分流并保留历史', async t => {
  const root = await makeFixture();
  const file = name => path.join(root, 'data', name);
  const lib = await readLib(root);
  const name = '上伊那牡丹，酒醉身姿似百合花般';
  const future = cstParts(new Date(Date.now() + 8 * 86400000)).date;
  const weekDay = cstParts().weekday;
  lib.watching = [
    { id: 543360, name_cn: name, eps: 12, ep_status: 0, air_weekday: weekDay, air_time_cst: '22:30' },
    { id: 600001, name_cn: '跨季度仍在播', eps: 3, ep_status: 0, start_date: '2026-04-01', air_weekday: weekDay, air_time_cst: '23:30' },
    { id: 600002, name_cn: '有历史和排期的旧番', eps: 3, ep_status: 0, air_weekday: weekDay, air_time_cst: '23:30' },
    { id: 600005, name_cn: '明确继续追连载', eps: 3, ep_status: 0, watch_mode_manual: true },
    { id: 'local-unknown', name_cn: '资料不全的手动条目', eps: null, ep_status: 0 },
  ];
  lib.weekday = { [weekDay]: lib.watching.filter(w => w.air_weekday).map(w => ({ id: w.id, time_cst: w.air_time_cst })) };
  await fs.writeFile(file('library.json'), JSON.stringify(lib));
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const id = Number(url.pathname.split('/').at(-1));
    let value = {};
    if (url.pathname.startsWith('/v0/subjects/')) {
      value = { id, type: 2, name: id === 543360 ? name : 'Bangumi 测试条目 ' + id, date: '2026-04-10',
        eps: id === 543360 ? 12 : 3,
        infobox: [543360, 600003, 600005].includes(id) ? [{ key: '播放结束', value: '2026年6月26日' }] : [] };
    } else if (url.pathname === '/v0/episodes') {
      const subject = Number(url.searchParams.get('subject_id'));
      value = { total: 3, data: ['2026-06-01', '2026-06-08', [600001, 600004].includes(subject) ? future : '2026-06-15']
        .map((airdate, index) => ({ type: 0, ep: index + 1, name: '第 ' + (index + 1) + ' 集', airdate })) };
    } else if (url.pathname === '/broadcast') value = { items: [] };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(value));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => upstream.close());
  const base = 'http://127.0.0.1:' + upstream.address().port;
  const server = await startServer(root, { BGM_BASE: base, BGM_PROXY: '', BGM_BROADCAST_URL: base + '/broadcast' });
  t.after(() => server.child.kill());
  const get = url => req(server.port, url);
  const post = (url, body) => req(server.port, url, { method: 'POST', body });
  assert.equal((await post('/api/progress', { id: '600002', delta: 1 })).status, 200);
  const history = await fs.readFile(file('history.jsonl'), 'utf8');
  const before = await readLib(root);
  const suggestions = (await get('/api/library/catchup-review?refresh=1')).json;
  assert.deepEqual(suggestions.candidates.map(row => row.id), ['543360', '600002']);
  assert.equal(suggestions.candidates[0].watched_count, 0);
  assert.equal(suggestions.candidates[0].broadcast.date, '2026-06-26');
  assert.equal(suggestions.candidates[1].broadcast.source, 'episodes');
  assert.match(suggestions.skipped.find(row => row.id === '600001').reason, /仍有未播/);
  assert.match(suggestions.skipped.find(row => row.id === 'local-unknown').reason, /暂未确认/);
  assert.deepEqual((await get('/api/library/catchup-review')).json.candidates, suggestions.candidates);
  const input = { action: 'ended-catchup', ids: ['543360', '600001', '600002', '600005'] };
  assert.equal((await post('/api/library/batch', input)).status, 409);
  const plan = (await post('/api/library/batch', { ...input, preview: true })).json;
  assert.deepEqual(plan.plan.changed.map(row => row.id), ['543360', '600002']);
  assert.deepEqual(plan.plan.skipped.map(row => row.id), ['600001', '600005']);
  assert.deepEqual(await readLib(root), before);
  const saved = await post('/api/library/batch', { ...input, receipt: plan.receipt });
  assert.equal(saved.status, 200);
  assert.ok(saved.json.changed);
  assert.equal(await fs.readFile(file('history.jsonl'), 'utf8'), history);
  const after = await readLib(root);
  assert.deepEqual(after.weekday, before.weekday);
  assert.equal(after.watching.find(w => w.id === 543360).ep_status, 0);
  assert.equal(after.watching.find(w => w.id === 600002).ep_status, 1);
  const state = (await get('/api/state')).json;
  const desktop = (await get('/api/schedule/desktop')).json;
  assert.deepEqual(state.catchup_list.map(w => w.id), [543360, 600002]);
  assert.equal(state.catchup_reminders.length, 0);
  assert.ok(!desktop.rows.some(w => ['543360', '600002'].includes(w.id)));
  assert.ok(desktop.rows.some(w => w.id === '600001'));
  assert.equal((await post('/api/undo', { expected_revision: saved.json.revision })).status, 200);
  assert.equal((await get('/api/state')).json.catchup_list.length, 0);
  const undoneHistory = await fs.readFile(file('history.jsonl'), 'utf8');
  const events = undoneHistory.trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], JSON.parse(history));
  assert.equal(events[1].undo, true);
  const retry = (await post('/api/library/batch', { ...input, preview: true })).json;
  assert.equal((await post('/api/library/batch', { ...input, receipt: retry.receipt })).status, 200);
  const old = (await get('/api/watch/detail?id=600002')).json.detail;
  const personal = await post('/api/watch/detail', { id: old.id, name: old.name, eps: old.eps,
    ep_status: old.ep_status, air_weekday: old.air_weekday, air_time_cst: old.air_time_cst,
    catchup_slot: { day: weekDay, time: '19:45' } });
  assert.equal(personal.json.detail.watch_mode, 'catchup');
  assert.equal((await get('/api/schedule/desktop')).json.personal[0].id, 600002);
  assert.equal(await fs.readFile(file('history.jsonl'), 'utf8'), undoneHistory);

  const add = (subject_id, extra = {}) => post('/api/watch/detail', {
    subject_id, name: '新加入 ' + subject_id, eps: 3, ep_status: 0, ...extra,
  });
  assert.equal((await add(600003)).json.detail.watch_mode, 'catchup');
  assert.equal((await add(600004)).json.detail.watch_mode, 'airing');
  const explicit = (await add(600006, { watch_mode: 'airing' })).json.detail;
  assert.equal(explicit.watch_mode, 'airing');
  assert.equal(explicit.watch_mode_manual, true);
});

test('打开面板后核对未排期条目，只把确认完播的条目自动转到补番', async t => {
  const root = await makeFixture();
  const lib = await readLib(root);
  const old = { id: 543360, name_cn: '上伊那牡丹，酒醉身姿似百合花般', eps: 12, ep_status: 2,
    watch_url: 'https://example.invalid/watch' };
  const row = id => ({ id, eps: 12, ep_status: 0 });
  lib.watching = [old, row(600011), row(600012), { ...row(600013), watch_mode_manual: true },
    row(600014), { ...row(600015), schedule_manual: true }, { ...row('local-progress'), watch_mode: 'catchup' }];
  lib.weekday = { 1: [{ id: 600014, time_cst: '23:30' }] };
  await fs.writeFile(path.join(root, 'data/library.json'), JSON.stringify(lib));
  await installBuildTools(root);
  const future = cstParts(new Date(Date.now() + 86400000 * 8)).date;
  const queried = new Set();
  const upstream = http.createServer((req, res) => {
    const id = Number(req.url.match(/^\/v0\/subjects\/(\d+)$/)?.[1]);
    const date = id === 600011 ? future : '2026-04-10';
    if (id) queried.add(id);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(id ? { id, type: 2, name: String(id), eps: 12, date,
      infobox: id === 600012 ? [] : [{ key: '播放结束', value: '2026年6月26日' }] } : { data: [], total: 0 }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => upstream.close());
  const srv = await startServer(root, { BGM_BASE: 'http://127.0.0.1:' + upstream.address().port });
  t.after(() => srv.child.kill());
  const progress = await req(srv.port, '/api/progress', { method: 'POST', body: { id: 'local-progress', delta: 1 } });
  assert.equal(progress.status, 200);
  assert.equal((await req(srv.port, '/api/state')).status, 200);
  let today;
  for (let attempt = 0; attempt < 80; attempt++) {
    today = await fs.readFile(path.join(root, 'data/today.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (today?.catchup?.some(w => w.id === 543360)) break;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  assert.ok(today?.catchup?.some(w => w.id === 543360));
  const saved = await readLib(root);
  assert.deepEqual(saved.watching.slice(0, -1), [{ ...old, watch_mode: 'catchup', auto_catchup: true }, ...lib.watching.slice(1, -1)]);
  assert.deepEqual(saved.weekday, lib.weekday);
  assert.deepEqual([...queried].sort(), [543360, 600011, 600012]);
  const state = (await req(srv.port, '/api/state')).json;
  assert.deepEqual(state.catchup_list.map(w => w.id), [543360, 'local-progress']);
  assert.ok(!state.watching.some(w => w.id === 543360));
  const undo = await req(srv.port, '/api/undo', { method: 'POST', body: { expected_revision: progress.json.revision } });
  assert.equal(undo.status, 200, undo.text);
  const restored = await readLib(root);
  assert.equal(restored.watching[0].watch_mode, 'catchup');
  assert.equal(restored.watching.at(-1).ep_status, 0);
  assert.equal((await req(srv.port, '/api/stats')).json.total, 0);
});

test('季表漏页保留完整缓存，重试成功后替换', async t => {
  const root = await makeFixture();
  const q = '2026Q2';
  const row = id => ({ id, type: 2, name: '季表条目 ' + id, date: '2026-04-01' });
  const file = path.join(root, 'data', 'season', q + '.json');
  const old = { q, total: 2, items: [row(20), row(21)], fetched_at: '2026-07-01T00:00:00Z' };
  await fs.writeFile(file, JSON.stringify(old));
  let fails = true;
  const upstream = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const offset = Number(url.searchParams.get('offset'));
    response.setHeader('Content-Type', 'application/json');
    if (fails && offset) response.statusCode = 503;
    response.end(JSON.stringify({ total: 2, data: [row(30 + offset)] }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const srv = await startServer(root, { BGM_BASE: 'http://127.0.0.1:' + upstream.address().port });
  t.after(() => srv.child.kill());
  const refresh = () => req(srv.port, '/api/season?q=' + q + '&refresh=1');
  const fallback = (await refresh()).json;
  assert.equal(fallback.source, 'cache-stale');
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), old);
  fails = false;
  const updated = (await refresh()).json;
  assert.equal(updated.source, 'net');
  assert.deepEqual(updated.items.map(item => item.id), [30, 31]);
});

test('新目录可以离线读取周档和封面，已结束条目加入补番', async t => {
  const root = await makeFixture();
  const catalog = 'assets/season-catalog';
  await fs.mkdir(path.join(root, catalog, 'covers'), { recursive: true });
  await Promise.all(['2019Q4.json', '2026Q2.json', 'covers/543360.jpg'].map(rel =>
    fs.copyFile(path.join(ROOT, catalog, rel), path.join(root, catalog, rel))));
  const srv = await startServer(root, { BGM_PROXY: 'http://127.0.0.1:1' });
  t.after(() => srv.child.kill());
  const first = (await req(srv.port, '/api/season?q=2019Q4')).json;
  assert.equal(first.source, 'builtin');
  assert.ok(first.items.length > 50);
  assert.equal(first.article.url, 'https://yuc.wiki/201910/');
  const found = await req(srv.port, '/api/anime/search?local=1&q=' + encodeURIComponent('上伊那ぼたん'));
  assert.ok(found.json.candidates.some(item => item.id === 543360 && item.season === '2026Q2'));
  const q = '2026Q2';
  const listing = (await req(srv.port, '/api/season?q=' + q)).json;
  const reference = (await req(srv.port, '/api/season/reference?q=' + q + '&id=543360')).json.reference;
  assert.equal(reference.url, 'https://yuc.wiki/202604/');
  assert.equal(reference.review.status, 'unavailable');
  assert.deepEqual(listing.airings[543360], { weekday: 5, time_cst: '23:00' });
  assert.equal((await fetch('http://127.0.0.1:' + srv.port + '/cover/543360.jpg?local=1')).headers.get('content-type'), 'image/jpeg');
  const applied = await req(srv.port, '/api/season/apply', { method: 'POST', body: { q, add: [543360], start_mode: 'head' } });
  assert.equal(applied.json.added, 1);
  const library = JSON.parse(await fs.readFile(path.join(root, 'data/library.json'), 'utf8'));
  assert.equal(library.watching.find(entry => entry.id === 543360)?.watch_mode, 'catchup');
});

test('损坏事务记录保留原文件，并可启动只读面板', async t => {
  const root = await makeFixture();
  const journal = path.join(root, 'data', '.progress-pending.json');
  const original = await fs.readFile(path.join(root, 'data', 'library.json'), 'utf8');
  const damage = '{ bad history journal';
  await fs.writeFile(journal, damage);
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  assert.equal((await req(srv.port, '/api/health')).json.recovery.code, 'progress-recovery');
  assert.equal((await req(srv.port, '/api/state')).json.recovery.read_only, true);
  assert.equal((await req(srv.port, '/api/backups')).status, 200);
  assert.equal((await req(srv.port, '/api/stats')).status, 503);
  assert.equal((await req(srv.port, '/api/progress', { method: 'POST', body: { id: '554779', delta: 1 } })).status, 503);
  assert.equal(await fs.readFile(journal, 'utf8'), damage);
  assert.equal(await fs.readFile(path.join(root, 'data', 'library.json'), 'utf8'), original);
});

test('日备份缺项时保留先前文件，重新运行只补齐失败项', async () => {
  const root = await makeFixture();
  const file = path.join(root, 'data', 'settings.json');
  await fs.writeFile(file, '{ damaged');
  const previous = await snapshot({ root, dir: '2026-04-01' });
  assert.equal(previous.ok, false);
  assert.deepEqual(previous.missing, ['settings.json']);
  const firstLibrary = await fs.readFile(path.join(previous.dir, 'library.json'), 'utf8');
  await fs.writeFile(file, '{"clock":"24h"}');
  await fs.writeFile(path.join(root, 'data', 'library.json'), '{"watching":[]}');
  const current = await snapshot({ root, dir: '2026-04-01' });
  assert.equal(current.ok, true);
  assert.deepEqual(current.wrote, ['settings.json']);
  assert.equal(await fs.readFile(path.join(current.dir, 'library.json'), 'utf8'), firstLibrary);
  assert.equal(JSON.parse(await fs.readFile(path.join(current.dir, 'settings.json'), 'utf8')).clock, '24h');
});

test('副屏看板只读，显示未来排片和下一话，忽略暂停与已看完条目', async t => {
  const root = await makeFixture();
  const day = cstParts(new Date(Date.now() + 86400000));
  const lib = await readLib(root);
  Object.assign(lib.watching[0], { air_weekday: day.weekday, air_time_cst: '22:30' });
  lib.watching.push({ id: 'local-finished', name_cn: '已看完', ep_status: 12, eps: 12 });
  lib.paused = [{ id: 'local-paused', name_cn: '已暂停', ep_status: 2, eps: 12 }];
  lib.weekday = { [day.weekday]: [
    { id: '554779', name_cn: '学生会也有洞！', time_cst: '22:30', ep_expected: 6 },
    { id: 'local-paused', name_cn: '已暂停', time_cst: '16:00' },
    { id: 'local-finished', name_cn: '已看完', time_cst: '17:00' },
  ] };
  await fs.writeFile(path.join(root, 'data/library.json'), JSON.stringify(lib));
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const endpoint = '/api/schedule/board';
  const result = (await req(srv.port, endpoint)).json;
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.next, { id: '554779', date: day.date, name: '学生会也有洞！', kind: 'airing', time: '22:30',
    at: Date.parse(day.date + 'T22:30:00+08:00'), episode: 6 });
  assert.equal((await req(srv.port, endpoint, { method: 'POST', body: {} })).status, 405);
});

test('桌宠写入刷新标记，升级向导区分本版自启、旧路径和路径缺失', async t => {
  const root = await makeFixture();
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const current = path.join(root, 'Pet.exe');
  const old = path.join(root, 'old', 'Pet.exe');
  const cache = path.join(root, 'cache/pet-presence.json');
  const get = async url => (await req(srv.port, url)).json;
  const presence = async autostart => {
    await fs.writeFile(cache, JSON.stringify({ pid: process.pid, at: Date.now() / 1000, path: current, autostart }));
    return get('/api/startup-path');
  };
  assert.equal((await get('/api/startup-path')).available, false);
  assert.equal((await presence(old)).exists, false);
  await fs.mkdir(path.dirname(old));
  await fs.writeFile(old, '');
  assert.deepEqual(await presence(old), { ok: true, available: true, current, startup: old, exists: true, same: false });
  await fs.writeFile(current, '');
  assert.equal((await presence(current)).same, true);
  const before = await get('/api/panel-revision');
  assert.equal((await req(srv.port, '/api/progress', { method: 'POST', body: { id: '554779', delta: 1, client: 'desktop' } })).status, 200);
  const after = await get('/api/panel-revision');
  assert.notEqual(after.revision, before.revision);
  assert.equal((await get('/api/panel-revision')).revision, after.revision);
});

test('Bangumi 连接结果分别报告，确认只写预览中的变更', async t => {
  const root = await makeFixture();
  let accepted = false, id = 777002, collectionRequests = 0;
  const upstream = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const send = value => res.end(JSON.stringify(value));
    if (req.url === '/calendar') return send([{ weekday: { id: 1 }, items: [] }]);
    if (!accepted) { res.statusCode = 401; return send({ message: 'do-not-echo-token' }); }
    if (req.url === '/v0/me') return send({ username: 'tester', nickname: '测试账号', email: 'private' });
    collectionRequests++;
    return send({ data: [{ subject_id: id, ep_status: 4, subject: { id, name_cn: '测试番', eps: 12 } }] });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const srv = await startServer(root, { BGM_BASE: 'http://127.0.0.1:' + upstream.address().port, BGM_USER: '', BGM_TOKEN: '', BGM_PROXY: '' });
  t.after(() => srv.child.kill());
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  await post('/api/token', { token: 'test-token', user: 'tester' });
  const connection = await post('/api/token/test', {});
  assert.equal(connection.json.sources.collections.code, 'token_invalid');
  assert.equal(connection.json.sources.calendar.status, 'ok');
  assert.ok(!connection.text.includes('do-not-echo-token'));
  accepted = true;
  const wrong = await post('/api/token/test', { user: 'wrong' });
  assert.equal(wrong.json.sources.collections.code, 'account_mismatch');
  assert.equal(wrong.json.identity.user, 'tester');
  assert.ok(!wrong.text.includes('private'));
  const preview = await post('/api/sync', { dry_run: true, mode: 'progress' });
  assert.ok(preview.json.changes.some(c => c.id === 777002));
  id = 777003;
  const calls = collectionRequests;
  const applied = await post('/api/sync', { preview_id: preview.json.preview_id });
  assert.equal(applied.status, 200);
  assert.deepEqual(applied.json.changes, preview.json.changes);
  assert.equal(collectionRequests, calls);
  assert.equal((await readLib(root)).watching.find(w => w.id === 777002).ep_status, 4);
  const stale = await post('/api/sync', { dry_run: true });
  await post('/api/progress', { id: '554779', delta: 1 });
  assert.equal((await post('/api/sync', { preview_id: stale.json.preview_id })).status, 409);
  assert.ok(!(await readLib(root)).watching.some(w => w.id === 777003));
  const save = await post('/api/token', { proxy: 'http://fake-user:fake-secret@127.0.0.1:9999', token: '' });
  assert.equal(save.json.proxy, '127.0.0.1:9999');
  assert.equal(save.json.has_token, false);
  assert.ok(!save.text.includes('fake-secret'));
});

test('Bangumi 按字段确认并显示五种状态，手填字段和本地安排受保护', async t => {
  const root = await makeFixture();
  const lib = await readLib(root);
  Object.assign(lib.watching[0], { name_manual: true, schedule_manual: true, air_weekday: 1, air_time_cst: '25:30' });
  lib.watching.push({ id: 919109, name_cn: '跳集样本', ep_status: 2, eps: 12, episode_extras: [4] });
  lib.weekday[1][0].time_cst = '25:30';
  lib.paused = [{ id: 919101, name_cn: '暂停本机番', ep_status: 2, eps: 12, catchup_slot: { day: 5, time: '22:15' } }];
  await fs.writeFile(path.join(root, 'data/library.json'), JSON.stringify(lib));
  const items = [1, 2, 3, 4, 5].map(type => ({ subject_id: 919110 + type, type, ep_status: 3,
    subject: { name_cn: '远端状态样本 ' + type, eps: 12 } }));
  items.push({ subject_id: 554779, type: 4, ep_status: 3, subject: { name_cn: '线上番名', eps: 13 } },
    { subject_id: 919101, type: 3, ep_status: 9, subject: { name_cn: '线上暂停', eps: 15 } },
    { subject_id: 919109, type: 3, ep_status: 6, subject: { name_cn: '跳集样本', eps: 12 } });
  const upstream = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const val = req.url === '/calendar' ? [{ weekday: { id: 2 }, items: [{ id: 554779, name_cn: '番' }] }]
      : req.url === '/v0/me' ? { username: 'tester' } : { data: items, total: items.length };
    res.end(JSON.stringify(val));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const srv = await startServer(root, { BGM_BASE: 'http://127.0.0.1:' + upstream.address().port, BGM_PROXY: '', BGM_TOKEN: '', BGM_USER: '' });
  t.after(() => srv.child.kill());
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  await post('/api/token', { token: 'test-token', user: 'tester' });
  const preview = (await post('/api/sync', { dry_run: true, mode: 'progress' })).json;
  assert.deepEqual(preview.mappings.slice(0, 5).map(row => row.mapped), ['待看', '已看完', '在追', '暂停', '已弃番']);
  assert.equal(preview.mappings.find(row => row.id === 919101).protected, true);
  assert.deepEqual(preview.protected_fields.map(row => row.field).sort(), ['air_weekday', 'ep_status', 'name_cn']);
  assert.match(preview.protected_fields.find(row => row.field === 'ep_status').reason, /跳集/);
  const selected = preview.changes.filter(row => row.field === '(新增)' || row.field === 'eps').map(row => row.key);
  assert.equal((await post('/api/sync', { preview_id: preview.preview_id, selected: [...selected, 'unoffered'] })).status, 400);
  const saved = (await post('/api/sync', { preview_id: preview.preview_id, selected })).json;
  assert.deepEqual(saved.changes, preview.changes.filter(row => selected.includes(row.key)));
  const result = await readLib(root);
  assert.equal(result.planned[0].ep_status, 0);
  assert.equal(result.watching.find(row => row.id === 919112).manual_finished, true);
  assert.equal(result.watching[0].eps, 13);
  assert.equal(result.watching[0].ep_status, 0);
  assert.equal(result.watching[0].air_time_cst, '25:30');
  assert.deepEqual(result.paused[0], lib.paused[0]);
  assert.deepEqual(result.watching.find(w => w.id === 919109), lib.watching[1]);
  assert.equal(result.dropped[0].id, 919115);
});

test('Bangumi 分页第二页失败不提交半份收藏，可以取消或显式用完整缓存', async t => {
  const root = await makeFixture();
  let mode = 'success', secondRequest;
  const second = new Promise(resolve => { secondRequest = resolve; });
  const rows = Array.from({ length: 51 }, (_, i) => ({ subject_id: 593000 + i, type: 3, subject: { name: '样本 ' + i } }));
  const upstream = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/calendar') return res.end('[]');
    if (u.pathname === '/v0/me') return res.end('{"username":"tester"}');
    if (u.searchParams.has('type')) { res.statusCode = 400; return res.end('{}'); }
    const offset = Number(u.searchParams.get('offset'));
    if (offset && mode === 'failure') { res.statusCode = 503; return res.end('{}'); }
    if (offset && mode === 'hold') { secondRequest(); return; }
    res.end(JSON.stringify({ data: rows.slice(offset, offset + 50), total: rows.length }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const srv = await startServer(root, { BGM_BASE: 'http://127.0.0.1:' + upstream.address().port, BGM_PROXY: '', BGM_TOKEN: '', BGM_USER: '' });
  t.after(() => srv.child.kill());
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  await post('/api/token', { token: 'test-token', user: 'tester' });
  const preview = body => post('/api/sync', { dry_run: true, ...body });
  assert.equal((await preview()).json.changes.length, 51);
  mode = 'failure';
  const failure = (await preview()).json;
  assert.equal(failure.sources.collections.status, 'error');
  assert.equal(failure.sources.collections.cache_available, true);
  assert.equal(failure.sources.collections.cache_count, 51);
  assert.equal(failure.changes.length, 0);
  const cached = (await preview({ use_cache: true })).json;
  assert.equal(cached.sources.collections.status, 'cached');
  assert.equal(cached.changes.length, 51);
  mode = 'hold';
  const id = 'a'.repeat(36);
  const inFlight = preview({ request_id: id });
  await second;
  const job = (await req(srv.port, '/api/sync?request_id=' + id)).json;
  assert.deepEqual(job.sources.collections, { status: 'loading', count: 50, total: 51 });
  assert.equal((await post('/api/sync', { cancel: true, request_id: id })).json.cancelled, true);
  assert.equal((await inFlight).status, 409);
  assert.equal((await readLib(root)).watching.length, 1);
});

test('追平保留排片与提醒，已看完退出，撤销或同步新增集数后恢复', async t => {
  const root = await makeFixture();
  await installBuildTools(root);
  const id = '554779';
  const tomorrow = new Date(Date.now() + 86400000);
  const day = cstParts(tomorrow).weekday;
  const firstAired = cstParts(new Date(+tomorrow - 11 * 7 * 86400000)).date;
  const url = 'https://example.com/watch';
  const library = await readLib(root);
  Object.assign(library.watching[0], { ep_status: 11, air_weekday: day, start_date: firstAired, watch_url: url });
  library.paused = [{ ...library.watching[0], id: '554780', ep_status: 12 }];
  library.archived = [{ ...library.watching[0], id: '554781', ep_status: 12 }];
  library.weekday = { [day]: [{ id, name_cn: '完结验收番', time_cst: '23:00' }] };
  await fs.writeFile(path.join(root, 'data/library.json'), JSON.stringify(library));
  await fs.writeFile(path.join(root, 'data/bgm.json'), JSON.stringify({ proxy: 'http://127.0.0.1:1' }));
  const upstream = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v0/me') return res.end(JSON.stringify({ username: 'tester' }));
    if (req.url === '/calendar') return res.end('[]');
    res.end(JSON.stringify({ data: [554779, 554780, 554781].map(id => ({ subject_id: id, subject: { id, eps: 13 } })) }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const srv = await startServer(root, { BGM_BASE: 'http://127.0.0.1:' + upstream.address().port, BGM_USER: '', BGM_TOKEN: '', BGM_PROXY: '' });
  t.after(() => srv.child.kill());
  const get = url => req(srv.port, url);
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  const detail = async () => (await get('/api/watch/detail?id=' + id)).json;
  const scheduled = async () => Object.values((await get('/api/state')).json.week).flat().some(row => String(row.id) === id);
  const same = w => String(w.id) === id;
  assert.equal((await get('/api/state')).json.watching.find(same).expected_eps, 11);
  assert.equal((await detail()).reminder.status, 'scheduled');
  assert.equal(await scheduled(), true);
  let result = await post('/api/progress', { id, delta: 1 });
  assert.equal(result.json.became_finished, true);
  let state = (await get('/api/state')).json;
  assert.equal(state.finished.find(same).watch_url, url);
  assert.ok(!state.watching.some(same) && !state.catchup.some(same) && !state.reminders.some(same));
  assert.equal((await detail()).reminder.status, 'finished');
  assert.equal(await scheduled(), false);
  assert.ok(!(await get('/api/schedule/desktop')).json.rows.some(same));
  assert.ok(!(await get('/api/export?fmt=ics')).text.includes(id));
  assert.equal((await post('/api/undo', { expected_revision: result.json.revision })).status, 200);
  assert.equal((await detail()).detail.ep_status, 11);
  assert.equal((await detail()).reminder.status, 'scheduled');
  assert.equal(await scheduled(), true);
  assert.equal((await post('/api/progress', { id, delta: 1 })).json.finished, true);
  await post('/api/token', { token: 'test-token', user: 'tester', proxy: '' });
  const preview = await post('/api/sync', { dry_run: true, mode: 'collections' });
  assert.ok(preview.json.changes.some(change => change.field === 'eps' && change.to === 13));
  assert.equal((await post('/api/sync', { preview_id: preview.json.preview_id })).status, 200);
  state = (await get('/api/state')).json;
  assert.equal(state.watching.find(same).ep_status, 12);
  assert.equal(state.finished.some(same), false);
  assert.equal(state.paused.find(w => w.id === '554780').eps, 13);
  assert.equal(state.archived.find(w => w.id === '554781').eps, 12);
  assert.equal(await scheduled(), true);
  assert.equal((await detail()).reminder.status, 'scheduled');

  result = await post('/api/watch/detail', { name: '未知集数', start_mode: 'seen', ep_status: 4, air_weekday: day, air_time_cst: '22:00' });
  assert.equal(result.status, 201);
  const manualId = result.json.detail.id;
  const move = action => post('/api/watch/lifecycle', { id: manualId, action });
  assert.equal((await move('finish')).json.changed, true);
  assert.equal((await get('/api/watch/detail?id=' + manualId)).json.detail.manual_finished, true);
  assert.equal((await get('/api/watch/detail?id=' + manualId)).json.reminder.status, 'finished');
  assert.equal((await post('/api/progress', { id: manualId, delta: 1 })).status, 409);
  assert.equal((await move('unfinish')).json.changed, true);
  assert.equal((await get('/api/watch/detail?id=' + manualId)).json.detail.finished, false);
  assert.equal((await get('/api/watch/detail?id=' + manualId)).json.reminder.status, 'scheduled');
  await move('finish');
  assert.equal((await move('archive')).json.state, 'archived');
  assert.equal((await get('/api/state')).json.archived.find(w => w.id === manualId).ep_status, 4);
  assert.equal((await get('/api/stats')).json.finished, 2);
});

test('补番保留原周档，个人提醒独立，每周目标只统计补番记账并随撤销回退', async t => {
  const root = await makeFixture();
  await installBuildTools(root);
  const day = cstParts().weekday;
  const upstream = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v0/subjects/700111') return res.end(JSON.stringify({ id: 700111, type: 2, name_cn: '往季验收番', eps: 8 }));
    if (req.url === '/v0/subjects/700112') return res.end(JSON.stringify({ id: 700112, type: 1, name_cn: '一本书', eps: 8 }));
    res.statusCode = 404;
    res.end('{}');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const srv = await startServer(root, { BGM_BASE: 'http://127.0.0.1:' + upstream.address().port, BGM_PROXY: '' });
  t.after(() => srv.child.kill());
  const get = async url => (await req(srv.port, url)).json;
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  const subject = link => req(srv.port, '/api/catchup/subject?link=' + encodeURIComponent(link));
  const meta = await subject('https://bgm.tv/subject/700111');
  assert.deepEqual(meta.json, { ok: true, id: 700111, name: '往季验收番', eps: 8 });
  assert.equal((await subject('https://bgm.tv/subject/700112')).status, 400);
  assert.equal((await subject('https://bgm.tv.example.com/subject/700111')).status, 400);
  const watchUrl = 'https://example.com/show';
  const base = { name: meta.json.name, eps: meta.json.eps, ep_status: 6, start_mode: 'seen', watch_url: watchUrl,
    air_weekday: day, air_time_cst: '22:20', catchup_slot: { day, time: '09:05' }, watch_mode: 'catchup' };
  const added = await post('/api/watch/detail', { ...base, subject_id: meta.json.id });
  assert.equal(added.status, 201);
  const id = added.json.detail.id;
  assert.equal(id, '700111');
  assert.equal((await subject('https://bgm.tv/subject/700111')).status, 409);
  const same = w => String(w.id) === id;
  const state = () => get('/api/state');
  const detail = () => get('/api/watch/detail?id=' + id);
  const desktop = () => get('/api/schedule/desktop');
  const edit = (d, patch) => post('/api/watch/detail', { ...d, ...patch, expected_revision: d.revision });
  let s = await state();
  assert.equal(s.catchup_list.find(same).ep_status, 6);
  assert.equal(s.catchup_week.watched, 0);
  assert.ok(!s.watching.some(same) && !s.today.some(same) && !Object.values(s.weekly).flat().some(same));
  assert.equal((await detail()).reminder.kind, 'catchup');
  assert.equal((await detail()).detail.air_time_cst, '22:20');
  assert.equal((await desktop()).personal.find(same).time, '09:05');
  const todayText = await fs.readFile(path.join(root, 'ghost/master/today.txt'), 'utf8');
  assert.match(todayText, /personal1_id=700111/);
  assert.doesNotMatch(todayText, /show\d+_id=700111/);
  await post('/api/settings', { catchup_goal: 4, quiet_start: '09:00', quiet_end: '09:30' });
  assert.equal((await detail()).reminder.status, 'quiet');
  assert.equal((await state()).catchup_week.goal, 4);
  await post('/api/progress', { id: '554779', delta: 1 });
  assert.equal((await state()).catchup_week.watched, 0);
  const progress = await post('/api/progress', { id, delta: 1 });
  assert.equal(progress.json.ep_status, 7);
  assert.equal((await state()).catchup_week.watched, 1);
  await post('/api/undo', { expected_revision: progress.json.revision });
  assert.equal((await state()).catchup_week.watched, 0);
  const airing = await edit((await detail()).detail, { watch_mode: 'airing' });
  assert.equal(airing.status, 200);
  s = await state();
  assert.ok(s.watching.some(same) && !s.catchup_reminders.some(same));
  assert.ok(Object.values(s.weekly).flat().some(same));
  assert.equal((await detail()).detail.watch_url, watchUrl);
  const resumed = await edit((await detail()).detail, { watch_mode: 'catchup' });
  assert.equal(resumed.json.detail.catchup_slot.time, '09:05');
  const done = await post('/api/progress', { id, delta: 2 });
  assert.equal(done.json.became_finished, true);
  s = await state();
  assert.ok(s.finished.some(same) && !s.catchup_list.some(same) && !s.catchup_reminders.some(same));
  assert.equal(s.catchup_week.watched, 2);
  const manual = await post('/api/watch/detail', { name: '未知集数旧番', ep_status: 3, start_mode: 'seen', watch_mode: 'catchup' });
  assert.equal(manual.status, 201);
  const unknown = manual.json.detail.id;
  assert.equal((await post('/api/progress', { id: unknown, delta: 1 })).json.ep_status, 4);
  const migration = (await get('/api/migration')).migration;
  assert.equal(migration.settings.catchup_goal, 4);
  assert.equal(migration.library.watching.find(same).catchup_slot.time, '09:05');
  assert.ok(migration.history['history.jsonl'].some(row => row.watch_mode === 'catchup'));
});

test('提醒记录区分通知请求和已确认操作，只有仍在番库的条目可以跳转', async t => {
  const root = await makeFixture();
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const url = '/api/reminder/history';
  assert.deepEqual((await req(srv.port, url)).json.events, []);
  const at = Math.floor(Date.now() / 1000);
  const airing = { key: 'aired|554779|' + at, kind: 'airing', watch_id: '554779', name: '学生会也有洞！',
    status: 'requested', bubble: true, recovered: true, scheduled_at: at - 70, recorded_at: at - 40,
    reminder_at: at - 130, episode: 4, action: 'snoozed', action_at: at - 30, snoozed_until: at + 870 };
  const snoozed = { key: 'snooze|554779|' + at, kind: 'snooze', watch_id: '554779', name: airing.name,
    status: 'quiet', scheduled_at: at, recorded_at: at, bubble: false };
  const testRow = { key: 'test|abc', kind: 'test', name: '测试提醒', status: 'requested', recorded_at: at };
  const deleted = { ...airing, key: 'catchup|gone', kind: 'catchup', watch_id: 'deleted', status: 'inactive', action: null };
  await fs.writeFile(path.join(root, 'data/reminder-history.json'), JSON.stringify([
    testRow, snoozed, airing, deleted, null, { key: 'corrupt', recorded_at: 'unknown' },
  ]));
  await fs.writeFile(path.join(root, 'data/state.json'), JSON.stringify({
    quiet_until: at + 120, reminder_tray_only: true, pending_reminders: [{ Name: '排队样例' }],
  }));
  const result = (await req(srv.port, url)).json;
  assert.deepEqual(result.events, [
    { ...testRow, can_open: false }, { ...snoozed, can_open: true }, { ...airing, can_open: true }, { ...deleted, can_open: false },
  ]);
  assert.equal(result.mode.quiet_until, at + 120);
  assert.equal(result.mode.tray_only, true);
  assert.equal(result.mode.queued, 1);
  assert.doesNotMatch(JSON.stringify(result), /排队样例/);
  assert.equal((await req(srv.port, url, { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await req(srv.port, url, { method: 'POST', body: {} })).status, 405);
  assert.doesNotMatch((await req(srv.port, '/api/migration')).text, /snoozed_until|test\|abc/);
});

test('提醒中心逐部处理并保留历史，隐藏改期、过期和已确认的提醒', async t => {
  const root = await makeFixture();
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const now = Math.floor(Date.now() / 1000);
  const file = path.join(root, 'data/library.json');
  const lib = JSON.parse(await fs.readFile(file));
  lib.weekday[1][0].time_cst = '23:00';
  lib.watching.push({ id: 'local-2', name: '第二部番', watch_url: 'https://example.invalid/watch',
    watch_mode: 'catchup', catchup_slot: { day: 1, time: '21:00' }, eps: 12 });
  await fs.writeFile(file, JSON.stringify(lib));
  const event = (watch, key, kind, patch = {}) => ({
    key, kind, watch_id: watch.id, name: watch.name_cn || watch.name, status: 'bubble',
    scheduled_at: now - 60, reminder_at: now - 60, recorded_at: now - 60, source_stamp: remindStamp(lib, watch), ...patch,
  });
  const [a, b] = lib.watching;
  await fs.writeFile(path.join(root, 'data/reminder-history.json'), JSON.stringify([
    event(a, 'first', 'airing'), event(b, 'second', 'catchup'),
    event(a, 'expired', 'airing', { reminder_at: now - 21601 }),
    event(b, 'old-slot', 'catchup', { source_stamp: 'a'.repeat(24) }),
    event(a, 'handled', 'airing', { action: 'watch_clicked', action_at: now - 10 }),
  ]));
  await fs.writeFile(path.join(root, 'data/state.json'), JSON.stringify({
    pending_reminders: [{ Name: '等候提示', FireAt: now - 5 }],
  }));
  const load = async (query = '') => (await req(srv.port, '/api/reminder/history' + query)).json;
  const ack = key => req(srv.port, '/api/reminder/acknowledge', { method: 'POST', body: { key, action: 'acknowledged' } });
  const initial = await load();
  assert.deepEqual(initial.pending.map(row => row.key), ['first', 'second']);
  assert.equal(initial.pending[1].watch_url, 'https://example.invalid/watch');
  assert.deepEqual(initial.queued, [{ name: '等候提示', reminder_at: now - 5 }]);
  assert.equal((await ack('old-slot')).status, 409);
  assert.equal((await ack('first')).status, 200);
  assert.equal((await ack('first')).status, 200);
  const staleSnooze = await req(srv.port, '/api/reminder/snoozes', { method: 'POST', body: {
    action: 'create', event_key: 'first', minutes: 15, items: [ { id: a.id, kind: 'airing',
      slot_at: now - 60, stamp: remindStamp(lib, a) } ],
  } });
  assert.equal(staleSnooze.status, 409);
  assert.match(staleSnooze.json.error, /这条提醒已处理/);
  const staleMark = await req(srv.port, '/api/progress', { method: 'POST',
    body: { id: a.id, delta: 1, reminder_event: 'first' } });
  assert.equal(staleMark.status, 409);
  assert.deepEqual((await load()).pending.map(row => row.key), ['second']);
  const history = await load('?watch=' + a.id);
  assert.equal(history.events.length, 3);
  assert.equal(history.events[0].action, 'acknowledged');
  assert.deepEqual(history.pending, []);
  const stopped = once(srv.child, 'exit');
  srv.child.kill();
  await stopped;
  await fs.rm(path.join(root, 'cache/panel_port.txt'), { force: true });
  const next = await startServer(root);
  t.after(() => next.child.kill());
  assert.deepEqual((await req(next.port, '/api/reminder/history')).json.pending.map(row => row.key), ['second']);
});

test('单番提醒预览与保存使用同一提前量，覆盖或还原全局都保留原稍后时刻', async t => {
  const root = await makeFixture();
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  const at = Math.floor(Date.now() / 60000) * 60 + 35 * 60;
  const slot = cstParts(new Date(at * 1000));
  const saved = await post('/api/watch/detail', { name: '可覆盖的补番', ep_status: 0, eps: 12, watch_mode: 'catchup',
    catchup_slot: { day: slot.weekday, time: [slot.hour, slot.minute].map(x => String(x).padStart(2, '0')).join(':') } });
  const { id, revision } = saved.json.detail;
  const detail = async () => (await req(srv.port, '/api/watch/detail?id=' + id)).json;
  const draft = await post('/api/reminder/preview', { id, settings: { reminder_lead: 30 } });
  assert.equal(draft.json.preview.next.at, new Date((at - 1800) * 1000).toISOString());
  assert.equal(draft.json.preview.inherited, true);
  assert.equal((await detail()).reminder_preview.lead, 0);
  assert.equal((await post('/api/reminder/preview', { id, settings: { quiet_work_start: '22:00' } })).status, 400);
  const lib = await readLib(root);
  const before = await post('/api/reminder/snoozes', { action: 'create', minutes: 15, items: [{ id,
    kind: 'catchup', slot_at: at, stamp: remindStamp(lib, lib.watching.find(w => w.id === id)) }] });
  assert.equal(before.status, 200);
  const newRule = await post('/api/reminder/watch', { id, lead: 15, muted: false, expected_revision: revision });
  assert.equal(newRule.status, 200);
  assert.equal((await detail()).reminder_preview.lead, 15);
  assert.equal((await detail()).reminder_preview.next.kind, 'snooze');
  assert.equal((await post('/api/reminder/watch', { id, lead: 0, muted: false, expected_revision: revision })).status, 409);
  const inherit = await post('/api/reminder/watch', { id, lead: null, muted: false, expected_revision: newRule.json.detail.revision });
  assert.equal(inherit.json.detail.reminder_lead, null);
  assert.deepEqual((await req(srv.port, '/api/reminder/snoozes')).json.pending, before.json.pending);
  const muted = await post('/api/reminder/preview', { id, watch: { lead: 0, muted: true } });
  assert.equal(muted.json.preview.reason, 'muted');
  assert.equal((await detail()).detail.reminder_muted, false);
});

async function req(port, pathname, { method = 'GET', body, headers = {} } = {}) {
  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(10000) };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!init.headers['Content-Type'] && typeof body !== 'string') init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 静态文件不是 JSON */ }
  return { status: res.status, text, json, headers: res.headers };
}

async function readLib(root) {
  return JSON.parse(await fs.readFile(path.join(root, 'data', 'library.json'), 'utf8'));
}

async function installBuildTools(root) {
  await fs.cp(path.join(ROOT, 'lib'), path.join(root, 'lib'), { recursive: true });
  for (const name of ['build_today.mjs', 'build_ghost.mjs']) {
    await fs.copyFile(path.join(ROOT, 'tools', name), path.join(root, 'tools', name));
  }
  await fs.copyFile(path.join(ROOT, 'data/talks.json'), path.join(root, 'data/talks.json'));
}

test('本季能显示分钟级平台时刻，详情保存后周表与桌宠共用本地排期', async t => {
  const root = await makeFixture();
  await installBuildTools(root);
  const q = seasonOf(new Date());
  const id = '777005';
  const start = new Date(Date.now() + 86400000);
  await fs.writeFile(path.join(root, `data/season/${q}.json`), JSON.stringify({
    q, items: [{ id, name_cn: '本季测试番', eps: 12, weekday: null }],
    fetched_at: new Date().toISOString(),
  }));
  await fs.mkdir(path.join(root, 'cache/bgm'), { recursive: true });
  await fs.writeFile(path.join(root, 'cache/bgm/broadcast.json'), JSON.stringify({
    at: Date.now(), siteMeta: { demo: { title: '测试平台', regions: ['CN'] } },
    items: [{ title: '本季测试番', broadcast: 'R/' + start.toISOString() + '/P7D',
      sites: [{ site: 'bangumi', id }, { site: 'demo', broadcast: 'R/2090-01-01T15:12:00Z/P7D' }] }],
  }));
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  const airing = async () => (await req(srv.port, '/api/season/airing?q=' + q)).json.airings[id];
  const original = async (query = '') => (await req(srv.port, '/api/schedule/original' + query)).json.airings[id];
  assert.equal((await airing()).time_cst, '23:12');
  assert.equal((await airing()).platform, '测试平台');
  const { weekday, hour, minute } = cstParts(start);
  const slot = { weekday, time_cst: [hour, minute].map(n => String(n).padStart(2, '0')).join(':') };
  assert.deepEqual(await original('?q=' + q), slot);
  await post('/api/season/apply', { q, add: [id] });
  assert.deepEqual(await original(), slot, '在追未设置提醒也能读到原播周档');
  const lookup = await post('/api/schedule/lookup', { id, original_only: true });
  assert.equal(lookup.json.candidates.length, 1);
  assert.equal(lookup.json.candidates[0].platform, null);
  assert.ok(Number.isFinite(Date.parse(lookup.json.candidates[0].fetched_at)));
  assert.equal((await post('/api/season/time', { id, time: '23:10' })).status, 400);
  assert.equal((await req(srv.port, '/api/watch/detail?id=' + id)).json.airing.time_cst, '23:12');
  const saved = await post('/api/season/time', { id, weekday: 1, time: '25:30' });
  assert.equal(saved.json.rebuilt, true);
  assert.equal((await airing()).source, '本地排期');
  assert.deepEqual(await original(), slot, '自订提醒不改变公开原播周档');
  assert.equal(cstParts(new Date((await airing()).next)).hour, 1);
  const snapshot = JSON.parse(await fs.readFile(path.join(root, 'data/today.json'), 'utf8'));
  assert.equal(snapshot.all_shows.find(w => String(w.id) === id).time_cst, '01:30');
  assert.match(await fs.readFile(path.join(root, 'ghost/master/today.txt'), 'utf8'), /library_sha256=[0-9a-f]{64}/);
  const before = (await req(srv.port, '/api/watch/detail?id=' + id)).json.detail;
  const candidate = lookup.json.candidates[0];
  const adopted = (await post('/api/watch/detail', { id, expected_revision: before.revision,
    name: before.name, eps: before.eps, ep_status: before.ep_status, air_weekday: candidate.weekday,
    air_time_cst: candidate.time_cst, schedule_source: candidate.source, schedule_fetched_at: candidate.fetched_at })).json.detail;
  assert.equal(adopted.schedule_source, 'bangumi-data 原播');
  assert.equal(adopted.schedule_fetched_at, candidate.fetched_at);
  assert.equal(adopted.schedule_manual, true);
});

test('最新一话起点、撤销统计和单番备份恢复', async t => {
  const root = await makeFixture();
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  const added = await post('/api/watch/detail', { name: '最新一话测试', eps: 12, ep_status: 0, start_mode: 'latest', latest_episode: 8 });
  const { id } = added.json.detail;
  assert.equal(added.json.detail.ep_status, 0);
  assert.equal(added.json.detail.start_episode, 8);
  const first = await post('/api/progress', { id, delta: 1 });
  assert.equal(first.json.ep_status, 8);
  assert.equal((await req(srv.port, '/api/stats')).json.total, 1);
  assert.equal((await post('/api/undo', { expected_revision: first.json.revision })).status, 200);
  const stats = (await req(srv.port, '/api/stats')).json;
  assert.deepEqual([stats.total, stats.week, stats.streak], [0, 0, 0]);
  assert.equal((await req(srv.port, '/api/history')).json.gained, 0);
  const preview = (await post('/api/restore', { name: 'library.json.bak', dry_run: true })).json;
  assert.equal(preview.changes.find(change => change.id === id).to.ep_status, 8);
  const restore = { name: 'library.json.bak', id, expected_revision: preview.revision, backup_revision: preview.backup_revision };
  assert.equal((await post('/api/restore', restore)).status, 200);
  assert.equal((await req(srv.port, '/api/watch/detail?id=' + id)).json.detail.ep_status, 8);
  assert.equal((await req(srv.port, '/api/stats')).json.total, 0);
  assert.equal((await post('/api/restore', restore)).status, 409);
  assert.equal((await readLib(root)).watching.find(w => w.id === '554779').ep_status, 0);
});

test('桌宠原播周档跟随时制，临时调档和提醒单独计算', async t => {
  const root = await makeFixture();
  const lib = {
    watching: [
      { id: '554779', name_cn: '深夜档', eps: 12, ep_status: 4, air_weekday: 1, air_time_cst: '02:15' },
      { id: 'custom', name_cn: '自订档', air_weekday: 2, air_time_cst: '25:10' },
      { id: 'platform', name_cn: '仅平台', air_weekday: 2, air_time_cst: '23:12', schedule_source: 'bangumi-data · 测试平台' },
      { id: 'ended', name_cn: '结束排片', schedule_ended: true },
    ],
    paused: [{ id: 'paused' }], archived: [{ id: 'archived' }],
    weekday: { 1: [{ id: '554779', name_cn: '深夜档', time_cst: '02:15' }] },
  };
  await fs.writeFile(path.join(root, 'data/library.json'), JSON.stringify(lib));
  await fs.mkdir(path.join(root, 'cache/bgm'), { recursive: true });
  await fs.writeFile(path.join(root, 'cache/bgm/broadcast.json'), JSON.stringify({
    at: Date.now(),
    items: [{ title: '深夜档', broadcast: 'R/2026-01-04T17:30:00Z/P7D', sites: [{ site: 'bangumi', id: '554779' }] }],
  }));
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const route = '/api/schedule/desktop';
  const desktop = async () => (await req(srv.port, route)).json;
  assert.deepEqual((await desktop()).rows.map(({ id, weekday, time, source }) => [id, weekday, time, source]), [
    ['custom', 2, '25:10', 'custom'], ['554779', 7, '25:30', 'original'], ['platform', 0, '', ''],
  ]);
  const set = await req(srv.port, '/api/settings', { method: 'POST', body: { clock: '24h' } });
  assert.equal(set.status, 200);
  assert.deepEqual((await desktop()).rows.map(({ id, weekday, time }) => [id, weekday, time]), [
    ['554779', 1, '01:30'], ['custom', 3, '01:10'], ['platform', 0, ''],
  ]);
  const original = await req(srv.port, '/api/schedule/original');
  assert.deepEqual(original.json.airings['554779'], { weekday: 1, time_cst: '01:30' });
  const state = await req(srv.port, '/api/state');
  assert.equal(state.json.week[1][0].time_cst, '02:15');
  const before = (await req(srv.port, '/api/watch/detail?id=554779')).json.reminder;
  const skip = await req(srv.port, '/api/watch/schedule', { method: 'POST', body: { id: '554779', action: 'skip' } });
  assert.equal(skip.status, 200);
  assert.equal((await desktop()).rows[0].time, '01:30');
  const after = (await req(srv.port, '/api/watch/detail?id=554779')).json.reminder;
  assert.equal(Date.parse(after.at) - Date.parse(before.at), 7 * 86400000);
  const skippedSlotOutsideThisWeek = cstParts(new Date(before.at)).date > cstParts(new Date(Date.now() + 6 * 86400000)).date;
  assert.equal(((await req(srv.port, '/api/state')).json.week[1] || []).some(row => row.id === '554779'), skippedSlotOutsideThisWeek);
});

test('调档只移动一档、结束排片仍可补番、静音只取消提醒', async t => {
  const root = await makeFixture();
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  const id = '554779';
  const tomorrow = new Date(Date.now() + 86400000);
  const saved = await post('/api/season/time', { id, weekday: cstParts(tomorrow).weekday, time: '23:30' });
  assert.equal(saved.status, 200);
  const state = async () => (await req(srv.port, '/api/state')).json;
  const slots = async () => Object.values((await state()).week).flat().filter(row => String(row.id) === id);
  const recurring = async () => Object.values((await state()).weekly).flat().find(row => String(row.id) === id);
  const schedule = (action, more) => post('/api/watch/schedule', { id, action, ...more });
  const reminder = async () => (await req(srv.port, '/api/watch/detail?id=' + id)).json.reminder;
  assert.equal((await reminder()).status, 'scheduled');
  assert.equal((await schedule('skip')).status, 200);
  assert.deepEqual(await slots(), []);
  assert.equal((await recurring()).time_cst, '23:30');
  const todayAt = cstParts(new Date(Date.now() + 3600000)).date + 'T23:45';
  const moved = await schedule('move', { at: todayAt });
  assert.equal(moved.status, 200);
  const at = new Date(todayAt + ':00+08:00').toISOString();
  const changed = { status: 'scheduled', at, planned_at: at, kind: 'airing', moved: true };
  const desktop = async () => (await req(srv.port, '/api/schedule/desktop')).json.rows.find(row => row.id === id).reminder;
  assert.deepEqual(await reminder(), { ...changed, desktop_online: false });
  assert.deepEqual(await desktop(), changed);
  assert.equal((await slots())[0].time_cst, '23:45');
  assert.equal((await recurring()).time_cst, '23:30');
  assert.equal((await schedule('mute', { muted: true })).json.detail.reminder_muted, true);
  assert.deepEqual(await reminder(), { status: 'muted', planned_at: at, desktop_online: false });
  const calendar = (await req(srv.port, '/api/export')).text;
  assert.match(calendar, /T234500/);
  assert.ok(!calendar.includes('VALARM'));
  assert.equal((await schedule('end')).status, 200);
  assert.deepEqual(await reminder(), { status: 'ended', desktop_online: false });
  assert.deepEqual(await slots(), []);
  assert.ok(!(await state()).catchup.some(row => String(row.id) === id));
  assert.equal((await post('/api/progress', { id, delta: 1 })).json.ep_status, 1);
  assert.equal((await schedule('restart')).status, 200);
  assert.equal((await slots())[0].time_cst, '23:45');
  assert.equal((await post('/api/settings', { quiet_start: '23:00', quiet_end: '07:00' })).status, 200);
  assert.equal((await schedule('mute', { muted: false })).status, 200);
  assert.deepEqual(await reminder(), { ...changed, status: 'quiet', desktop_online: false });
  assert.deepEqual(await desktop(), { ...changed, status: 'quiet' });
});

test('个人资料可编辑归档番，首选链接同步到桌宠并随备份保留', async t => {
  const root = await makeFixture();
  await fs.writeFile(path.join(root, 'data/bgm.json'), JSON.stringify({ token: 'TEST-PRIVATE', proxy: 'http://user:pass@127.0.0.1:1' }));
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const get = async url => (await req(srv.port, url)).json;
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  const id = '554779';
  const detail = async () => (await get('/api/watch/detail?id=' + id)).detail;
  const old = await detail();
  const preferences = { year: 2006, tags: ['旧番', '备用', '旧番'], note: '笔记\n第二行', spoiler: true, pinned: true,
    links: [{ name: '首选', url: 'https://example.com/first' }, { name: '备用', url: 'https://example.com/second' }] };
  const store = (revision, values = preferences) => post('/api/watch/preferences', { id, expected_revision: revision, preferences: values });
  assert.equal((await store(old.revision, { ...preferences, links: [{ name: '坏链接', url: 'javascript:0' }] })).status, 400);
  const result = await store(old.revision);
  assert.equal(result.status, 200);
  assert.equal((await store(old.revision)).status, 409);
  assert.equal(result.json.detail.watch_url, preferences.links[0].url);
  assert.deepEqual(result.json.detail.user_details.tags, ['旧番', '备用']);
  assert.ok(result.json.detail.user_details.pinned_at);
  assert.equal((await get('/api/schedule/desktop')).rows[0].watch_url, preferences.links[0].url);
  await post('/api/progress', { id, delta: 12 });
  await post('/api/watch/lifecycle', { id, action: 'archive' });
  const archived = await detail();
  assert.equal(archived.state, 'archived');
  assert.equal((await store(archived.revision, { ...preferences, note: '归档后短评' })).status, 200);
  const migration = (await get('/api/migration')).migration;
  assert.equal(migration.library.archived[0].user_details.note, '归档后短评');
  const report = await req(srv.port, '/api/diagnostics/report');
  assert.equal(report.json.sync.configured, true);
  assert.equal(report.json.sync.proxy_enabled, true);
  assert.doesNotMatch(report.text, /TEST-PRIVATE|user:pass|554779|install_path|library/);
});

test('按北京时间补记过往日期，历史筛选、导出和撤销使用同一批记录', async t => {
  const root = await makeFixture();
  const lib = await readLib(root);
  lib.watching[0].watch_mode = 'catchup';
  await fs.writeFile(path.join(root, 'data/library.json'), JSON.stringify(lib));
  await fs.writeFile(path.join(root, 'data/history-2026.jsonl'), JSON.stringify({ id: 'archived-log', name: '历史归档番',
    date: '2025-01-01', watch_mode: 'rewatch', delta: 1, from: 0, to: 1 }) + '\n');
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const get = async url => (await req(srv.port, url)).json;
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  const id = '554779';
  const date = '2025-05-01';
  assert.equal((await post('/api/progress', { id, watched_on: '2025-02-31', delta: 1 })).status, 400);
  assert.equal((await post('/api/progress', { id, watched_on: '2999-05-01', delta: 1 })).status, 400);
  const detail = (await get('/api/watch/detail?id=' + id)).detail;
  const first = await post('/api/progress', { id, delta: 2, watched_on: date, expected_watch_revision: detail.revision });
  assert.equal(first.status, 200);
  assert.equal((await post('/api/progress', { id, delta: 1, watched_on: date, expected_watch_revision: detail.revision })).status, 409);
  assert.equal((await get('/api/state')).catchup_week.watched, 0);
  const route = '/api/history/browse?mode=catchup&from=' + date + '&to=' + date + '&q=' + id;
  const rows = (await get(route)).rows;
  assert.equal(rows[0].date, date);
  assert.equal(rows[0].source, 'backfill');
  assert.equal(rows[0].delta, 2);
  const downloaded = await req(srv.port, route + '&download=1');
  assert.deepEqual(downloaded.text.trim().split('\n').map(line => JSON.parse(line)), rows);
  assert.equal((await get('/api/history/browse?mode=rewatch')).total, 1);
  await post('/api/undo', { expected_revision: first.json.revision });
  assert.equal((await get(route)).total, 0);
});

test('撤销较早的一笔记录，保留后续记账并重新核算进度与本周目标', async t => {
  const root = await makeFixture();
  const library = await readLib(root);
  library.watching[0].watch_mode = 'catchup';
  await fs.writeFile(path.join(root, 'data/library.json'), JSON.stringify(library));
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const get = async url => (await req(srv.port, url)).json;
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  const id = '554779';
  const progress = delta => post('/api/progress', { id, delta });
  const browse = async () => (await get('/api/history/browse?q=' + id)).rows;
  const status = async () => (await get('/api/watch/detail?id=' + id)).detail.ep_status;
  const route = '/api/history/retract';
  const preview = historyId => post(route, { history_id: historyId, preview: true });
  const confirm = (historyId, receipt) => post(route, { history_id: historyId, receipt });
  await post('/api/settings', { catchup_goal: 4 });
  await progress(1);
  const first = (await browse())[0].history_id;
  await progress(2);
  const second = (await browse()).find(row => row.history_id !== first);
  const before = (await preview(first)).json;
  assert.equal(before.preview.later, 1);
  assert.equal(before.preview.from, 3);
  assert.equal(before.preview.to, 2);
  assert.equal(before.preview.goal_before, 3);
  assert.equal(before.preview.goal_after, 2);
  assert.equal(await status(), 3);
  assert.equal((await browse()).length, 2);
  await post('/api/settings', { catchup_goal: 5 });
  assert.equal((await confirm(first, before.receipt)).status, 409);
  const applied = await confirm(first, (await preview(first)).json.receipt);
  assert.equal(applied.status, 200);
  assert.equal(await status(), 2);
  assert.deepEqual(await browse(), [second]);
  assert.equal((await get('/api/stats')).total, 2);
  assert.equal((await get('/api/state')).catchup_week.watched, 2);
  assert.equal((await preview(first)).status, 409);
  await progress(1);
  const follow = (await preview(second.history_id)).json;
  assert.deepEqual([follow.preview.from, follow.preview.to], [3, 1]);
  assert.equal(follow.preview.later, 1);
  const removedAgain = await confirm(second.history_id, follow.receipt);
  assert.equal(removedAgain.status, 200);
  assert.equal(await status(), 1);
  const all = await get('/api/history');
  assert.equal(all.gained, 1);
  assert.equal((await get('/api/state')).catchup_week.watched, 1);
  assert.equal((await post('/api/undo', { expected_revision: removedAgain.json.revision })).status, 200);
  assert.equal(await status(), 3);
  assert.ok((await browse()).some(row => row.history_id === second.history_id));
  await post('/api/progress', { id, set: 5 });
  assert.equal((await preview(second.history_id)).status, 409);
  const backups = (await get('/api/backups')).backups;
  assert.ok(backups.length);
  assert.equal((await post('/api/restore', { name: backups.at(-1).name })).status, 200);
  assert.ok(!(await browse()).some(row => row.history_id === first));
});

test('指定撤销回到补番起点并拒绝已被后续减记抵消的一笔', async t => {
  const root = await makeFixture();
  const library = await readLib(root);
  library.watching[0].start_episode = 6;
  await fs.writeFile(path.join(root, 'data/library.json'), JSON.stringify(library));
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  const id = '554779';
  const route = '/api/history/retract';
  await post('/api/progress', { id, delta: 1 });
  const { history_id } = (await req(srv.port, '/api/history/browse')).json.rows[0];
  const plan = (await post(route, { history_id, preview: true })).json;
  assert.deepEqual([plan.preview.from, plan.preview.to], [6, 0]);
  await post('/api/progress', { id, delta: -1 });
  assert.equal((await post(route, { history_id, preview: true })).status, 409);
});

test('跨季度找番区分同名不同年份，标出已入库条目，保存时仍检查重复', async t => {
  const root = await makeFixture();
  const lib = await readLib(root);
  lib.watching.push({ id: 'local-ova', name_cn: '星空：剧场', alias: ['Star Cut'], release_date: '2001-03-01', ep_status: 1 });
  lib.archived = [{ id: 700123, name_cn: '星空', release_date: '1998-01-01', ep_status: 26, eps: 26 }];
  await fs.writeFile(path.join(root, 'data/library.json'), JSON.stringify(lib));
  const current = seasonOf(new Date());
  await fs.writeFile(path.join(root, 'data/season/' + current + '.json'), JSON.stringify({
    q: current, items: [{ id: 500, name_cn: '缓存番', alias: ['OFFLINE ALIAS'], date: '2006-01-01' }],
  }));
  let offline = false, requests = 0;
  const upstream = http.createServer(async (request, res) => {
    if (!request.url.startsWith('/v0/search/subjects')) { res.writeHead(404); res.end(); return; }
    if (offline) { res.writeHead(503); res.end(); return; }
    const parts = [];
    for await (const part of request) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts));
    requests += 1;
    assert.equal(body.keyword, 'Star Cut');
    assert.deepEqual(body.filter.type, [2]);
    assert.equal(request.headers.authorization, undefined);
    res.end(JSON.stringify({ total: 3, data: [
      { id: 700123, type: 2, name_cn: '星空', name: 'Star Cut', date: '1998-01-01', platform: 'TV', images: { small: 'https://lain.bgm.tv/pic/cover/s/test.jpg' } },
      { id: 700124, type: 2, name_cn: '星空剧场', name: 'Star Cut', date: '2001-03-01', platform: '剧场版' },
      { id: 700125, type: 2, name_cn: '星空剧场', name: 'Star Cut', date: '2020-03-01', platform: 'OVA' },
    ] }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const srv = await startServer(root, { BGM_BASE: 'http://127.0.0.1:' + upstream.address().port, BGM_PROXY: '' });
  t.after(() => srv.child.kill());
  const get = q => req(srv.port, '/api/anime/search?q=' + encodeURIComponent(q));
  const result = (await get('Star Cut')).json;
  assert.equal(requests, 1);
  assert.equal(result.candidates[0].duplicates[0].state, 'archived');
  assert.equal(result.candidates[0].duplicates[0].match, 'id');
  assert.equal(result.candidates[0].cover, '/cover/700123.jpg');
  assert.equal(result.candidates[1].duplicates[0].id, 'local-ova');
  assert.deepEqual(result.candidates[2].duplicates, []);
  const save = (id, confirmation) => req(srv.port, '/api/watch/detail', { method: 'POST', body: {
    name: '星空剧场', original_name: 'Star Cut', release_date: '2001-03-01', check_duplicates: true,
    duplicate_revision: confirmation, subject_id: id, watch_mode: 'catchup', ep_status: 0,
  } });
  assert.equal((await save(700123)).status, 409);
  const warned = await save(700124);
  assert.equal(warned.status, 409);
  assert.equal(warned.json.duplicates[0].id, 'local-ova');
  assert.equal((await save(700124, warned.json.duplicate_revision)).status, 201);
  assert.equal((await save(700124, warned.json.duplicate_revision)).status, 409);
  offline = true;
  const fallback = (await get('offline alias')).json;
  assert.match(fallback.warning, /本地缓存/);
  assert.equal(fallback.candidates[0].name, '缓存番');
});

test('弃番保留备注和进度，重看有单独回合，并保留首轮看完日期', async t => {
  const root = await makeFixture();
  const lib = await readLib(root);
  lib.watching[0].ep_status = 4;
  lib.watching.push({ id: 'local-complete', name_cn: '已经看完', eps: 2, ep_status: 2 });
  await fs.writeFile(path.join(root, 'data/library.json'), JSON.stringify(lib));
  await fs.writeFile(path.join(root, 'data/history-2025.jsonl'), JSON.stringify({ id: 'local-complete',
    date: '2025-09-04', ts: '2025-09-04T12:00:00.000Z', from: 1, to: 2, delta: 1 }) + '\n');
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const get = async url => (await req(srv.port, url)).json;
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  const details = async id => (await get('/api/watch/detail?id=' + id)).detail;
  const life = (id, action, more) => post('/api/watch/lifecycle', { id, action, ...more });
  const rounds = '/api/watch/rewatch';
  const rewatch = (detail, action, round) => post(rounds, { id: detail.id, action, round_id: round?.id, expected_revision: detail.revision });
  const entry = '554779';
  assert.equal((await rewatch(await details(entry), 'start')).status, 409);
  assert.equal((await life(entry, 'drop', { note: '下次再看' })).status, 200);
  const dropped = await details(entry);
  assert.equal(dropped.drop_note, '下次再看');
  assert.equal(dropped.state, 'dropped');
  assert.equal(dropped.ep_status, 4);
  const state = await get('/api/state');
  assert.equal(state.dropped.length, 1);
  assert.ok(Object.values(state.week).flat().every(w => String(w.id) !== entry));
  assert.equal((await get('/api/watch/detail?id=' + entry)).reminder.status, 'dropped');
  const started = await rewatch(dropped, 'start');
  assert.equal(started.status, 200);
  assert.equal((await rewatch(dropped, 'start')).status, 409);
  assert.equal((await rewatch(await details(entry), 'next', started.json.round)).status, 200);
  assert.equal((await details(entry)).ep_status, 4);
  assert.equal((await life(entry, 'resume')).status, 200);
  assert.equal((await details(entry)).ep_status, 4);
  const archived = 'local-complete';
  assert.equal((await life(archived, 'archive')).status, 200);
  const first = await rewatch(await details(archived), 'start');
  assert.equal(first.status, 200);
  assert.equal((await rewatch(await details(archived), 'next', first.json.round)).status, 200);
  const second = await rewatch(await details(archived), 'next', first.json.round);
  assert.equal(second.status, 200);
  const final = await details(archived);
  assert.equal(final.state, 'archived');
  assert.equal(final.finished_at, '2025-09-04');
  assert.equal(final.ep_status, 2);
  assert.equal(final.rewatches[0].ep_status, 2);
  assert.equal(final.rewatches[0].finished_at, TODAY);
  assert.equal((await get('/api/history/browse?id=' + archived + '&mode=rewatch')).total, 2);
  assert.equal((await post('/api/undo', { expected_revision: second.json.revision })).status, 200);
  assert.equal((await get('/api/history/browse?id=' + archived + '&mode=rewatch')).total, 1);
  assert.equal((await details(archived)).finished_at, '2025-09-04');
});

test('每话清单可离线读取正片缓存，网络失败不会丢掉章节标题', async t => {
  const root = await makeFixture();
  let online = true, requests = 0;
  const upstream = http.createServer((request, response) => {
    requests++;
    const route = new URL(request.url, 'http://localhost');
    assert.equal(route.pathname, '/v0/episodes');
    assert.equal(route.searchParams.get('subject_id'), '554779');
    assert.equal(route.searchParams.get('type'), '0');
    assert.equal(request.headers.authorization, undefined);
    response.setHeader('Content-Type', 'application/json');
    if (!online) { response.statusCode = 503; response.end('{}'); return; }
    response.end(JSON.stringify({ total: 2, data: [
      { id: 10, type: 0, ep: 1, sort: 13, name_cn: '正片标题' },
      { id: 11, type: 1, sort: 1, name_cn: '特别篇' },
    ] }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const srv = await startServer(root, { BGM_BASE: 'http://127.0.0.1:' + upstream.address().port, BGM_PROXY: '' });
  t.after(() => srv.child.kill());
  const endpoint = '/api/watch/episodes?id=554779';
  assert.deepEqual((await req(srv.port, endpoint)).json.chapters, []);
  assert.equal(requests, 0);
  const recent = (await req(srv.port, endpoint + '&refresh=1')).json;
  assert.deepEqual(recent.chapters, [{ number: 1, title: '正片标题' }]);
  assert.ok(Date.parse(recent.fetched_at) > 0);
  online = false;
  const fallback = (await req(srv.port, endpoint + '&refresh=1')).json;
  assert.deepEqual(fallback.chapters, recent.chapters);
  assert.match(fallback.warning, /缓存/);
});

test('逐集记账保留跳集，补齐后完结；首轮和重看可分别撤销并进入周报', async t => {
  const root = await makeFixture();
  const lib = await readLib(root);
  const id = String(lib.watching[0].id);
  lib.watching = [];
  const season = seasonOf(new Date());
  await fs.writeFile(path.join(root, 'data/season', season + '.json'), JSON.stringify({ q: season, total: 1,
    items: [{ id: Number(id), name: '同一部补番验收', eps: 4 }] }));
  await fs.writeFile(path.join(root, 'data/library.json'), JSON.stringify(lib));
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const get = async url => (await req(srv.port, url)).json;
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  const detail = async () => (await get('/api/watch/detail?id=' + id)).detail;
  const add = episodes => post('/api/progress', { id, episodes, watched_on: TODAY });
  const browse = async mode => (await get('/api/history/browse?id=' + id + '&mode=' + mode)).rows;
  async function retract(record) {
    const url = '/api/history/retract';
    const review = await post(url, { history_id: record.history_id, preview: true });
    assert.equal(review.status, 200, review.text);
    const done = await post(url, { history_id: record.history_id, receipt: review.json.receipt });
    assert.equal(done.status, 200, done.text);
    return done.json.preview;
  }
  const candidate = { season_q: season, catalog_id: id, name: '同一部补番验收', eps: 4, ep_status: 0, planned: true };
  const attempts = await Promise.all([post('/api/watch/detail', candidate), post('/api/watch/detail', candidate)]);
  assert.deepEqual(attempts.map(reply => reply.status).sort(), [201, 409]);
  assert.equal(attempts.find(reply => reply.status === 409).json.duplicates[0].match, 'id');
  const deferred = await detail();
  assert.equal(deferred.state, 'planned');
  assert.equal((await post('/api/watch/lifecycle', { id, action: 'start', mode: 'catchup',
    expected_revision: deferred.revision })).status, 200);
  const first = await add([1, 2, 4]);
  assert.equal(first.json.ep_status, 2);
  assert.equal(first.json.watched_count, 3);
  assert.deepEqual((await detail()).episode_extras, [4]);
  const desktop = buildToday(await readLib(root)).catchup.find(row => String(row.id) === id);
  assert.deepEqual([desktop.ep_status, desktop.episode_extras], [2, [4]]);
  assert.equal((await add([4])).json.changed, false);
  assert.equal((await browse('catchup')).length, 1);
  const anchored = await get('/api/history/browse?record=' + first.json.history_id + '&page=45');
  assert.equal(anchored.located, true);
  assert.equal(anchored.page, 1);
  assert.equal(anchored.rows[0].history_id, first.json.history_id);
  assert.equal((await add([3])).json.ep_status, 4);
  assert.equal((await detail()).finished_at, TODAY);
  const fill = (await browse('catchup')).find(row => row.episodes_added.toString() === '3');
  const rollback = await retract(fill);
  assert.deepEqual([rollback.from, rollback.to, rollback.watched_before, rollback.watched_after], [4, 2, 4, 3]);
  assert.deepEqual((await detail()).episode_extras, [4]);
  assert.equal((await detail()).finished_at, undefined);
  assert.equal((await add([3])).json.finished, true);
  const rewatch = async (action, body = {}) =>
    post('/api/watch/rewatch', { id, action, expected_revision: (await detail()).revision, ...body });
  const started = await rewatch('start');
  assert.equal(started.status, 200, started.text);
  const round_id = started.json.round.id;
  assert.equal((await rewatch('episodes', { round_id, episodes: [2, 4], watched_on: TODAY })).json.round.ep_status, 0);
  assert.equal((await rewatch('episodes', { round_id, episodes: [1, 3] })).json.round.finished_at, TODAY);
  const before = await get('/api/watch/report?week=' + TODAY);
  assert.deepEqual(before.mode, { airing: 0, catchup: 4, rewatch: 4 });
  assert.deepEqual(before.completed.map(row => row.kind).sort(), ['catchup', 'rewatch']);
  assert.equal(before.milestones.first_watch, TODAY);
  assert.equal(before.milestones.first_completion.id, id);
  assert.deepEqual(before.milestones.best_day, { date: TODAY, count: 8 });
  const record = (await browse('rewatch')).find(row => row.episodes_added.toString() === '2,4');
  assert.equal((await retract(record)).round_id, round_id);
  const restored = await detail();
  assert.equal(restored.ep_status, 4);
  assert.equal(restored.rewatches[0].ep_status, 1);
  assert.deepEqual(restored.rewatches[0].episode_extras, [3]);
  assert.equal(restored.rewatches[0].finished_at, null);
  const afterRetraction = await get('/api/watch/report');
  assert.deepEqual(afterRetraction.mode, { airing: 0, catchup: 4, rewatch: 2 });
  assert.deepEqual(afterRetraction.milestones.best_day, { date: TODAY, count: 6 });
  assert.equal((await get('/api/state')).catchup_week.watched, 4);
  const migration = (await get('/api/migration')).migration;
  assert.deepEqual(migration.library.watching[0].rewatches[0].episode_extras, [3]);
  assert.ok(migration.library.history_retractions.some(row => row.id === record.history_id && row.episode));
  for (const [action, next] of [['archive', 'archived'], ['remove', 'removed'], ['restore', 'archived']]) {
    const previous = await detail();
    const changed = await post('/api/watch/lifecycle', { id, action, expected_revision: previous.revision });
    assert.equal(changed.status, 200, changed.text);
    assert.equal((await detail()).state, next);
  }
  assert.deepEqual((await detail()).rewatches[0].episode_extras, [3]);
});

test('移除误加条目可从原分组找回，备份仍带进度、周档和观看记录', async t => {
  const root = await makeFixture();
  const lib = await readLib(root);
  lib.planned = [{ id: 'local-planned', name_cn: '待看误加', ep_status: 0 }];
  lib.archived = [{ id: 'local-done', name_cn: '已归档', ep_status: 4, eps: 4 }];
  lib.dropped = [{ id: 'local-dropped', name_cn: '已弃', ep_status: 2, drop_note: '保留' }];
  lib.paused = [{ id: 'local-paused', name_cn: '暂停', ep_status: 1 }];
  const id = String(lib.watching[0].id);
  lib.weekday[1][0].time_cst = '25:30';
  await fs.writeFile(path.join(root, 'data/library.json'), JSON.stringify(lib));
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const get = async url => (await req(srv.port, url)).json;
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  assert.equal((await post('/api/progress', { id, episodes: [1, 3] })).status, 200);
  const life = '/api/watch/lifecycle';
  const ids = { watching: id, planned: 'local-planned', paused: 'local-paused', archived: 'local-done', dropped: 'local-dropped' };
  for (const key of Object.values(ids)) {
    const preview = (await post(life, { id: key, action: 'remove', preview: true })).json;
    assert.equal(preview.history_count, key === id ? 1 : 0);
    assert.equal((await post(life, { id: key, action: 'remove', expected_revision: preview.detail.revision })).status, 200);
  }
  assert.equal((await get('/api/state')).removed.length, 5);
  assert.equal((await get('/api/watch/detail?id=' + id)).reminder.status, 'removed');
  assert.equal((await get('/api/history/browse?id=' + id)).total, 1);
  const migration = (await get('/api/migration')).migration;
  assert.equal(migration.library.removed.length, 5);
  const pre = await post('/api/migration', { migration, preview: true });
  assert.equal(pre.json.incoming.removed, 5);
  for (const [state, key] of Object.entries(ids)) {
    const { detail } = await get('/api/watch/detail?id=' + key);
    const restored = await post(life, { id: key, action: 'restore', expected_revision: detail.revision });
    assert.equal(restored.status, 200, restored.text);
    assert.equal(restored.json.state, state);
  }
  const saved = (await get('/api/watch/detail?id=' + id)).detail;
  assert.equal(saved.watched_count, 2);
  assert.deepEqual(saved.episode_extras, [3]);
  assert.equal(saved.air_time_cst, '25:30');
});

test('历史写入失败不前进，重试后可撤销并更正完结日；重看写入同样受保护', async t => {
  const root = await makeFixture();
  const lib = await readLib(root);
  const id = String(lib.watching[0].id), history = path.join(root, 'data/history.jsonl');
  lib.watching[0].eps = 1;
  await fs.writeFile(path.join(root, 'data/library.json'), JSON.stringify(lib));
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  const detail = async () => (await req(srv.port, '/api/watch/detail?id=' + id)).json.detail;
  const block = async () => { await fs.rename(history, history + '.hold'); await fs.mkdir(history); };
  const resume = async () => { await fs.rmdir(history); await fs.rename(history + '.hold', history); };
  const progress = date => post('/api/progress', { id, delta: 1, watched_on: date });
  await block();
  const failed = await progress('2025-05-10');
  assert.equal(failed.status, 500);
  assert.match(failed.json.error, /观看记录未保存/);
  assert.deepEqual(await readLib(root), lib);
  await resume();
  assert.equal((await progress('2025-05-10')).status, 200);
  let first = await detail();
  assert.equal(first.finished_at, '2025-05-10');
  const browse = async () => (await req(srv.port, '/api/history/browse?id=' + id)).json.rows;
  const [{ history_id }] = await browse();
  const url = '/api/history/retract';
  const { receipt } = (await post(url, { history_id, preview: true })).json;
  assert.equal((await post(url, { history_id, receipt })).status, 200);
  assert.equal((await detail()).finished_at, undefined);
  assert.equal((await progress('2025-05-12')).status, 200);
  first = await detail();
  assert.equal(first.finished_at, '2025-05-12');
  const rewatch = '/api/watch/rewatch';
  const started = await post(rewatch, { id, action: 'start', expected_revision: first.revision });
  const command = { id, action: 'next', round_id: started.json.round.id, expected_revision: (await detail()).revision };
  await block();
  assert.equal((await post(rewatch, command)).status, 500);
  assert.equal((await detail()).rewatches[0].ep_status, 0);
  await resume();
  assert.equal((await post(rewatch, command)).status, 200);
  assert.equal((await detail()).rewatches[0].ep_status, 1);
  assert.equal((await browse()).length, 2);
});

test('恢复损坏的本机番库前按原字节留存文件', async t => {
  const root = await makeFixture();
  const file = path.join(root, 'data/library.json');
  const valid = await fs.readFile(file);
  const damaged = Buffer.concat([Buffer.from('{ "watching": '), Buffer.from([0xff, 0xfe])]);
  await fs.writeFile(file + '.bak', valid);
  await fs.writeFile(file, damaged);
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const restore = patch => req(srv.port, '/api/restore', { method: 'POST', body: { name: 'library.json.bak', ...patch } });
  const preview = (await restore({ dry_run: true })).json;
  assert.equal(preview.current_readable, false);
  assert.equal(preview.target_root, root);
  const saved = await restore({ expected_revision: preview.revision, backup_revision: preview.backup_revision });
  assert.equal(saved.status, 200, saved.text);
  assert.match(saved.json.recovery, /^data\/backups\/pre-restore-[a-f0-9]+\.raw$/);
  assert.deepEqual(await fs.readFile(path.join(root, saved.json.recovery)), damaged);
  assert.equal((await readLib(root)).watching.length, 1);
});

test('迁移和普通恢复预览拒绝损坏的重看轮次，保留当前番库', async t => {
  const root = await makeFixture();
  const lib = await readLib(root);
  const damaged = structuredClone(lib);
  damaged.watching[0].rewatches = [null];
  await fs.writeFile(path.join(root, 'data/library.json.bak'), JSON.stringify(damaged));
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  const restore = await post('/api/restore', { name: 'library.json.bak', dry_run: true });
  assert.equal(restore.status, 400);
  assert.match(restore.json.error, /重看轮次/);
  const format = { format: 'tiara-migration', schema: 1 };
  const migrate = library => post('/api/migration', { preview: true, migration: { ...format, library } });
  const invalid = await migrate(damaged);
  assert.equal(invalid.status, 400);
  assert.match(invalid.json.error, /重看轮次/);
  delete damaged.watching[0].rewatches;
  damaged.watching[0].history_ids = ['local-alias', 'local-alias'];
  assert.match((await migrate(damaged)).json.error, /历史关联/);
  assert.equal((await migrate(lib)).status, 200);
  assert.deepEqual(await readLib(root), lib);
});

test('绑定与合并要求预览及核对版本，保留较高进度、链接和两个编号的历史', async t => {
  const root = await makeFixture();
  const file = name => path.join(root, 'data', name);
  const local = { id: 'local-s1', name_cn: '同名番', ep_status: 6, eps: 12, watch_url: 'https://example.test/a',
    user_details: { year: 2023 }, schedule_manual: true, last_watched: TODAY };
  const linked = { id: 810001, name_cn: '同名番', ep_status: 3, eps: 12, watch_url: 'https://example.test/b' };
  const lib = await readLib(root);
  lib.watching.push(local, linked, { ...linked, id: 810002 },
    { ...linked, id: 810004, release_date: '2023-01-01' },
    { ...local, id: 'local-conflict', air_weekday: 2, air_time_cst: '25:30' },
    { ...linked, id: 810005, schedule_manual: true, air_weekday: 3, air_time_cst: '21:00' });
  lib.weekday[2] = [{ id: local.id, time_cst: '25:30' }];
  lib.weekday[3] = [{ id: linked.id, time_cst: null }];
  await fs.writeFile(file('library.json'), JSON.stringify(lib));
  const raw = [local, linked].map((item, i) => JSON.stringify({ id: item.id, name: item.name_cn, date: TODAY,
    ts: TODAY + 'T12:00:0' + i + '.000Z', delta: 1, from: item.ep_status - 1, to: item.ep_status,
    history_id: String(i + 1).repeat(32) })).join('\n') + '\n';
  await fs.writeFile(file('history-2025.jsonl'), raw);
  let requests = 0;
  const upstream = http.createServer((request, response) => {
    const id = Number(request.url.split('/').at(-1));
    requests++;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id, type: 2, name_cn: '同名番', name: 'Season ' + id, eps: 12, platform: 'TV',
      date: id === 810002 ? '2024-10-03' : '2023-10-03' }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const srv = await startServer(root, { BGM_BASE: 'http://127.0.0.1:' + upstream.address().port, BGM_PROXY: '' });
  t.after(() => srv.child.kill());
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  const browse = id => req(srv.port, '/api/history/browse?id=' + id);
  const route = '/api/watch/binding';
  const preview = id => post(route, { id: local.id, subject_id: id, preview: true });
  const mismatch = (await preview('810002')).json;
  assert.match(mismatch.review.blocked, /首播年份不同/);
  assert.equal(mismatch.preview_id, undefined);
  const pre = (await preview('810001')).json;
  assert.equal(pre.review.source.history_count, 1);
  assert.equal(pre.review.target.history_count, 1);
  assert.equal(pre.review.result.ep_status, 6);
  assert.equal(pre.review.result.history_count, 2);
  assert.equal(pre.review.result.air_time_cst, '25:30');
  assert.deepEqual(await readLib(root), lib);
  assert.equal((await post(route, { preview_id: pre.preview_id, confirm_id: '810002' })).status, 409);
  const done = await post(route, { preview_id: pre.preview_id, confirm_id: '810001' });
  assert.equal(done.status, 200);
  assert.equal(requests, 2);
  const history = (await browse('810001')).json.rows;
  assert.deepEqual(history.map(row => row.id), [810001, 810001]);
  assert.equal(history.find(row => row.original_id)?.original_id, local.id);
  assert.equal(await fs.readFile(file('history-2025.jsonl'), 'utf8'), raw);
  const merged = (await readLib(root)).watching.find(item => item.id === 810001);
  assert.equal(merged.ep_status, 6);
  assert.equal(merged.watch_url, linked.watch_url);
  assert.ok((await readLib(root)).weekday[2].some(row => String(row.id) === '810001' && row.time_cst === '25:30'));
  assert.ok(!(await readLib(root)).weekday[3].some(row => String(row.id) === '810001'));
  assert.deepEqual(merged.user_details.links.map(link => link.url), [local.watch_url]);
  assert.equal((await post(route, { preview_id: pre.preview_id, confirm_id: '810001' })).status, 409);
  assert.equal((await post('/api/undo', { expected_revision: done.json.revision })).status, 200);
  assert.equal((await browse('810001')).json.total, 1);
  assert.equal((await browse(local.id)).json.total, 1);
  const stale = (await preview('810003')).json;
  assert.equal(stale.review.mode, 'bind');
  assert.equal((await post('/api/progress', { id: local.id, delta: 1 })).status, 200);
  assert.equal((await post(route, { preview_id: stale.preview_id })).status, 409);
  const fresh = (await preview('810003')).json;
  assert.equal((await post(route, { preview_id: fresh.preview_id })).status, 200);
  assert.equal((await browse('810003')).json.total, 2);
  const conflict = choice => post(route, { preview: true, id: 'local-conflict', subject_id: '810005', schedule_choice: choice });
  const wrongSeason = (await post(route, { preview: true, id: 'local-conflict', subject_id: '810004' })).json;
  assert.match(wrongSeason.review.blocked, /已绑定的条目首播日期或年份冲突/);
  assert.equal(wrongSeason.preview_id, undefined);
  const needsChoice = (await conflict()).json;
  assert.equal(needsChoice.review.schedule_conflict, true);
  assert.equal(needsChoice.preview_id, undefined);
  const linkedPreview = (await conflict('linked')).json;
  assert.equal(linkedPreview.review.result.air_time_cst, '21:00');
  const localPreview = (await conflict('local')).json;
  assert.equal(localPreview.review.result.air_time_cst, '25:30');
  const chosen = await post(route, { preview_id: localPreview.preview_id, confirm_id: '810005', schedule_choice: 'linked' });
  assert.equal(chosen.status, 200);
  assert.equal(chosen.json.review.result.air_time_cst, '25:30');
  assert.ok((await readLib(root)).weekday[2].some(row => row.id === 810005 && row.time_cst === '25:30'));
});

test('批量整理区分变更和跳过，预览不写入，整批只需一次撤销', async t => {
  const root = await makeFixture();
  const lib = await readLib(root);
  lib.watching.push({ id: 'done', name_cn: '完结番', eps: 6, ep_status: 6 },
    { id: 'queue', name_cn: '待补番', eps: 12, ep_status: 4, user_details: { tags: ['喜欢'] } });
  await fs.writeFile(path.join(root, 'data/library.json'), JSON.stringify(lib));
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  const route = '/api/library/batch';
  const run = async input => {
    const reviewed = await post(route, { ...input, preview: true });
    assert.equal(reviewed.status, 200);
    const done = await post(route, { ...input, receipt: reviewed.json.receipt });
    assert.equal(done.status, 200);
    assert.deepEqual(done.json.plan, reviewed.json.plan);
    return done.json;
  };
  const tag = { ids: ['554779', 'queue', 'done'], action: 'tag', tag: '喜欢' };
  const preview = await post(route, { ...tag, preview: true });
  assert.deepEqual(await readLib(root), lib);
  assert.equal((await post(route, { ...tag, tag: '其他', receipt: preview.json.receipt })).status, 409);
  const labeled = await run(tag);
  assert.equal(labeled.plan.changed.length, 2);
  assert.equal(labeled.plan.skipped[0].id, 'queue');
  assert.equal((await post('/api/undo', { expected_revision: labeled.revision })).status, 200);
  assert.equal((await readLib(root)).watching[0].user_details, undefined);
  const catchup = await run({ ids: ['queue', 'done'], action: 'catchup' });
  assert.equal(catchup.plan.skipped[0].id, 'done');
  assert.equal((await readLib(root)).watching.find(w => w.id === 'queue').ep_status, 4);
  const archived = await run({ ids: ['554779', 'done'], action: 'archive' });
  assert.equal(archived.plan.changed[0].id, 'done');
  assert.equal((await readLib(root)).archived[0].ep_status, 6);
  assert.equal((await post('/api/undo', { expected_revision: catchup.revision })).status, 409);
  assert.equal((await post('/api/undo', { expected_revision: archived.revision })).status, 200);
  assert.equal((await readLib(root)).watching.find(w => w.id === 'done').ep_status, 6);
});

test('续作资料按条目编号区分，手动排序有版本校验，断网时仍可读取缓存', async t => {
  const root = await makeFixture();
  let online = true;
  const upstream = http.createServer((request, response) => {
    if (!online) { response.writeHead(503); return response.end(); }
    assert.equal(request.url, '/v0/subjects/554779/subjects');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify([
      { id: 441003, type: 2, relation: '总集篇', name: 'Student Film', name_cn: '学生会' },
      { id: 441002, type: 2, relation: '续集', name: 'Student S2', name_cn: '学生会' },
      { id: 441001, type: 2, relation: '前传', name: 'Student S1', name_cn: '学生会' },
      { id: 441004, type: 2, relation: '不同演绎', name: 'Student 2026', name_cn: '学生会' },
      { id: 441001, type: 2, relation: '前传', name: 'Duplicate' },
      { id: 441009, type: 1, relation: '原作', name: 'Manga' },
    ]));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const srv = await startServer(root, { BGM_BASE: 'http://127.0.0.1:' + upstream.address().port, BGM_PROXY: '' });
  t.after(() => srv.child.kill());
  const id = '554779', route = '/api/watch/order';
  const get = async refresh => (await req(srv.port, route + '?id=' + id + (refresh ? '&refresh=1' : ''))).json;
  const save = (order, revision) => req(srv.port, route, { method: 'POST', body: { id, order, expected_revision: revision } });
  const initial = await get();
  const ids = result => result.items.map(row => row.id);
  const suggested = ['441001', id, '441002', '441003', '441004'];
  assert.deepEqual(ids(initial), suggested);
  assert.equal(initial.source, 'bangumi');
  const custom = ['441003', '441001', id, '441002', '441004'];
  assert.equal((await save(['441003', '441003'], initial.revision)).status, 400);
  assert.equal((await save(['991003', ...custom.slice(1)], initial.revision)).status, 409);
  assert.equal((await save(custom, initial.revision)).status, 200);
  assert.equal((await save([], initial.revision)).status, 409);
  online = false;
  const cached = await get(true);
  assert.equal(cached.source, 'offline');
  assert.deepEqual(ids(cached), custom);
  const backup = (await req(srv.port, '/api/migration')).json.migration;
  assert.deepEqual(backup.library.watching[0].watch_order, custom);
  assert.equal((await save([], cached.revision)).status, 200);
  assert.deepEqual(ids(await get()), suggested);
});

test('待看条目独立于排片和进度，可选择追连载或补番并随备份迁移', async t => {
  const root = await makeFixture();
  const file = path.join(root, 'data/library.json');
  const lib = await readLib(root);
  lib.weekday[2] = [{ id: 880001, name_cn: '未来放送', time_cst: '23:30' }];
  await fs.writeFile(file, JSON.stringify(lib));
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const get = url => req(srv.port, url);
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  const add = (name, id, extra) => post('/api/watch/detail', { name, ep_status: 0, eps: 12, planned: true, subject_id: id, ...extra });
  assert.equal((await add('无效计划', undefined, { ep_status: 1 })).status, 400);
  const airing = await add('未来放送', 880001);
  const catchup = await add('周末补番');
  assert.equal(airing.status, 201);
  assert.equal(catchup.status, 201);
  assert.equal((await add('未来放送', 880001)).status, 409);
  const state = (await get('/api/state')).json;
  assert.equal(state.planned.length, 2);
  assert.equal(Object.values(state.week).flat().some(w => String(w.id) === '880001'), false);
  assert.equal(state.catchup_list.length, 0);
  assert.equal(state.catchup_reminders.length, 0);
  assert.equal((await post('/api/progress', { id: '880001', delta: 1 })).status, 404);
  assert.equal((await get('/api/watch/detail?id=880001')).json.reminder.status, 'planned');
  const backup = (await get('/api/migration')).json.migration;
  assert.equal(backup.library.planned.length, 2);
  const begin = (id, mode, revision) => post('/api/watch/lifecycle', { id, action: 'start', mode, expected_revision: revision });
  const first = airing.json.detail, second = catchup.json.detail;
  assert.equal((await begin(first.id, undefined, first.revision)).status, 400);
  assert.equal((await begin(first.id, 'airing', 'stale')).status, 409);
  assert.equal((await begin(first.id, 'airing', first.revision)).status, 200);
  assert.equal((await begin(second.id, 'catchup', second.revision)).status, 200);
  const started = (await get('/api/state')).json;
  assert.equal(started.planned.length, 0);
  assert.ok(started.watching.some(w => String(w.id) === first.id && w.ep_status === 0));
  assert.ok(Object.values(started.week).flat().some(w => String(w.id) === first.id));
  assert.ok(started.catchup_list.some(w => String(w.id) === second.id && w.ep_status === 0));
});

test('迁移导出排除凭据，预览锁定源数据与目标数据，导入前留备份', async t => {
  const root = await makeFixture();
  const file = name => path.join(root, 'data', name);
  const old = await readLib(root);
  const credentials = { token: 'only-in-local-config', proxy: 'http://user:pass@localhost:1' };
  await fs.writeFile(file('bgm.json'), JSON.stringify(credentials));
  await fs.writeFile(file('settings.json'), JSON.stringify({ clock: '24h', access_token: 'hidden-setting' }));
  await fs.mkdir(file('undo'));
  await fs.writeFile(file('undo/step-migration-test.json'), '{}');
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const post = (body) => req(srv.port, '/api/migration', { method: 'POST', body });
  const initial = await req(srv.port, '/api/migration');
  assert.match(initial.json.migration.source_version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(initial.json.migration.settings, { clock: '24h' });
  assert.doesNotMatch(initial.text, /only-in-local-config|hidden-setting|user:pass/);

  const data = {
    ...initial.json.migration,
    settings: { clock: '30h', quiet_start: '23:00', quiet_end: '07:00' },
    library: { ...old, watching: [{ ...old.watching[0], ep_status: 4, accessToken: 'hidden-row' }],
      paused: [{ id: 'local-pause', ep_status: 5 }], archived: [{ id: 'local-archive', ep_status: 12 }] },
    history: { 'history-2025.jsonl': [{ id: 'local-archive', date: '2025-01-01', delta: 1 }] },
  };
  const preview = async () => (await post({ preview: true, migration: data })).json;
  let result = await preview();
  assert.equal(result.source_version, initial.json.migration.source_version);
  assert.equal(result.target_version, result.source_version);
  assert.equal(result.target_root, root);
  const apply = (migration = data) => post({ migration, source: result.source, target: result.target });
  assert.deepEqual(result.incoming, { watching: 1, paused: 1, archived: 1, planned: 0, history: 1 });
  assert.deepEqual(result.changes.totals, { added: 2, replaced: 1, removed: 0, kept: 0 });
  assert.equal(result.changes.examples.find(example => example.change === 'replaced').after.seen, 4);
  assert.equal((await apply({ ...data, settings: { clock: '24h' } })).status, 409);
  assert.equal((await req(srv.port, '/api/settings', { method: 'POST', body: { clock: '30h' } })).status, 200);
  assert.equal((await apply()).status, 409);
  result = await preview();
  const applied = await apply();
  assert.equal(applied.status, 200);
  assert.deepEqual(applied.json.readback, result.incoming);
  const backup = JSON.parse(await fs.readFile(file('backups/' + applied.json.backup), 'utf8'));
  assert.deepEqual(backup.library, old);
  assert.equal((await readLib(root)).watching[0].ep_status, 4);
  assert.deepEqual(JSON.parse(await fs.readFile(file('bgm.json'), 'utf8')), credentials);
  assert.deepEqual(await fs.readdir(file('undo')), []);
  const exported = (await req(srv.port, '/api/migration')).json.migration;
  assert.deepEqual(exported.history, data.history);
  assert.deepEqual(exported.settings, data.settings);
  assert.doesNotMatch(JSON.stringify(exported), /hidden-row|hidden-setting|only-in-local-config/);
});

test('用户备份可选便条、外观和台词收藏，可预览和回滚', async t => {
  const root = await makeFixture();
  const file = name => path.join(root, 'data', name);
  const targetNotes = [{ Id: '1'.repeat(32), Text: '新机已有便条', Done: true }];
  const saved = { vars: { affinity: 42, first_seen: '2026-08-01' }, desktop_notes: targetNotes,
    favorite_lines: ['新机收藏'], first_duty: '2026-08-02',
    new_year_letter: { received: '2026-01-04', read: true, announced: true, access_token: 'PRIVATE-LETTER-TOKEN' },
    desktop_shell: 'master', bubble_theme: 1, bubble_size: 0, pet_scale: 0.75, bgmToken: 'PRIVATE-STATE-TOKEN' };
  const credentials = { token: 'PRIVATE-BGM-TOKEN', proxy: 'http://private:secret@localhost:1' };
  await fs.writeFile(file('state.json'), JSON.stringify(saved));
  await fs.writeFile(file('bgm.json'), JSON.stringify(credentials));
  await fs.writeFile(file('settings.json'), JSON.stringify({ clock: '24h', pet_scale: 0.8 }));
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const get = async scope => (await req(srv.port, '/api/migration?desktop=' + scope)).json.migration;
  const post = body => req(srv.port, '/api/migration', { method: 'POST', body });
  const noSelection = await get('');
  assert.deepEqual(noSelection.desktop, {});
  assert.ok(noSelection.created_at);
  assert.equal(noSelection.settings.pet_scale, undefined);
  assert.equal(noSelection.companion.first_duty, '2026-08-02');
  assert.deepEqual(noSelection.companion.new_year_letter, { received: '2026-01-04', read: true, announced: true });
  const notesOnly = await get('notes');
  assert.equal(notesOnly.desktop.notes[0].Text, targetNotes[0].Text);
  assert.equal(notesOnly.desktop.appearance, undefined);
  const full = await get('notes,appearance,favorites');
  assert.deepEqual(full.desktop.appearance, { shell: 'master', theme: 1, size: 0, scale: 0.8 });
  assert.doesNotMatch(JSON.stringify(full), /PRIVATE-STATE-TOKEN|PRIVATE-BGM-TOKEN|PRIVATE-LETTER-TOKEN|private:secret/);
  assert.deepEqual(full.desktop.favorites, ['新机收藏']);
  const next = { ...full, desktop: { appearance: { shell: '自制立绘', theme: 2, size: 2, scale: 1.25,
    bubble_time: 3, reduce_motion: true, idle_chatter: false, hourly_chatter: true },
    notes: [{ Id: 'a'.repeat(32), Text: '恢复测试\n第二行', ShowId: '554779', ShowName: '关联番剧', Done: false,
      DueAt: 1794888600, NotifiedAt: 1794888601 }] } };
  const preview = async data => (await post({ preview: true, migration: data })).json;
  const apply = (data, plan) => post({ migration: data, source: plan.source, target: plan.target });
  let plan = await preview(next);
  assert.equal(plan.desktop.appearance.missing_shell, true);
  assert.equal(plan.desktop.appearance.effective_shell, 'master');
  assert.deepEqual(plan.desktop.notes, { current: { total: 1, done: 1 }, incoming: { total: 1, done: 0, scheduled: 1 } });
  assert.deepEqual(JSON.parse(await fs.readFile(file('state.json'), 'utf8')), saved);
  const shell = path.join(root, 'shell', '自制立绘');
  await fs.mkdir(shell, { recursive: true });
  await fs.writeFile(path.join(shell, 'surface0.png'), 'fixture');
  assert.equal((await apply(next, plan)).status, 409);
  plan = await preview(next);
  assert.equal(plan.desktop.appearance.missing_shell, false);
  await fs.writeFile(file('state.json'), JSON.stringify({ ...saved, desktop_notes: [] }));
  assert.equal((await apply(next, plan)).status, 409);
  await fs.writeFile(file('state.json'), JSON.stringify(saved));
  const result = await apply(next, await preview(next));
  assert.equal(result.status, 200);
  assert.equal(result.json.desktop_pending, true);
  assert.deepEqual((await get('notes,appearance')).desktop, next.desktop);
  assert.deepEqual((await get('favorites')).desktop.favorites, ['新机收藏']);
  const backup = JSON.parse(await fs.readFile(file('backups/' + result.json.backup), 'utf8'));
  assert.deepEqual(backup.desktop, full.desktop);
  assert.doesNotMatch(JSON.stringify(backup), /PRIVATE-BGM-TOKEN|private:secret/);
  assert.deepEqual(JSON.parse(await fs.readFile(file('bgm.json'), 'utf8')), credentials);
  const replacement = { ...next, desktop: { favorites: ['旧机收藏', '旧机收藏', '  ', '字'.repeat(321), { token: 'hidden' }] },
    companion: { ...full.companion, first_duty: '2026-08-03' } };
  const selected = await preview(replacement);
  assert.deepEqual(selected.desktop.favorites, { current: 1, incoming: 1 });
  assert.equal((await apply(replacement, selected)).status, 200);
  assert.deepEqual((await get('favorites')).desktop.favorites, ['旧机收藏']);
  assert.equal((await get('')).companion.first_duty, '2026-08-03');
  const rollback = await apply(backup, await preview(backup));
  assert.equal(rollback.status, 200);
  assert.deepEqual((await get('notes,appearance,favorites')).desktop, full.desktop);
  assert.equal((await get('')).companion.first_duty, '2026-08-02');
});

test('备份用量分别统计，日快照排除凭据且滚动保留', async t => {
  const root = await makeFixture();
  const file = name => path.join(root, 'data', name);
  await fs.writeFile(file('bgm.json'), JSON.stringify({ token: 'private-account-token' }));
  await fs.writeFile(file('settings.json'), JSON.stringify({ clock: '30h', accessToken: 'legacy-settings-token' }));
  await fs.writeFile(file('history.jsonl'), Array.from({ length: 805 }, (_, i) =>
    JSON.stringify({ id: '554779', delta: 1, index: i, cookie: 'private-import-field' })).join('\n') + '\n');
  await snapshot({ root, dir: '2025-12-01' });
  await snapshot({ root, dir: '2025-12-02', keep: 1 });
  await assert.rejects(fs.stat(file('backups/2025-12-01')), { code: 'ENOENT' });
  const latest = file('backups/2025-12-02');
  assert.deepEqual((await fs.readdir(latest)).sort(), ['_snapshot.json', 'history.jsonl', 'library.json', 'settings.json']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(latest, '_snapshot.json'), 'utf8')), { complete: true, missing: [] });
  assert.equal(JSON.parse(await fs.readFile(path.join(latest, 'settings.json'), 'utf8')).clock, '30h');
  assert.doesNotMatch(await fs.readFile(path.join(latest, 'settings.json'), 'utf8'), /legacy-settings-token/);
  const tail = (await fs.readFile(path.join(latest, 'history.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(tail.length, 800);
  assert.equal(JSON.parse(tail[0]).index, 5);
  assert.doesNotMatch(tail[0], /private-import-field/);
  await fs.writeFile(path.join(latest, 'bgm.json'), '{"token":"simulated-old-snapshot"}');
  await fs.writeFile(file('backups/migration-2025-12-02-fixture.json'), '{}');
  await fs.writeFile(file('library.json.bak'), '{"watching":[]}');
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const { inventory } = (await req(srv.port, '/api/backups')).json;
  assert.equal(inventory.daily.legacyCredentials, 1);
  assert.equal(inventory.daily.keep, 14);
  assert.equal(inventory.daily.historyTail, 800);
  assert.ok(inventory.daily.bytes >= Buffer.byteLength(tail.join('\n')));
  assert.deepEqual(inventory.migration, { count: 1, bytes: 2 });
  assert.deepEqual(inventory.library, { count: 1, bytes: 15, keep: 5 });
  assert.doesNotMatch(JSON.stringify(inventory), /simulated-old-snapshot|private-account-token/);
});

test('离线封面使用缓存，单条重试失败时保留有效图片', async t => {
  const root = await makeFixture();
  const covers = path.join(root, 'data/covers');
  await fs.mkdir(covers);
  const file = path.join(covers, '554779.jpg');
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=', 'base64');
  await fs.writeFile(file, image);
  const srv = await startServer(root, { BGM_BASE: 'http://127.0.0.1:1', BGM_PROXY: '' });
  t.after(() => srv.child.kill());
  const url = 'http://127.0.0.1:' + srv.port + '/cover/554779.jpg';
  const reply = await fetch(url);
  assert.equal(reply.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await reply.arrayBuffer()), image);
  const retry = () => req(srv.port, '/api/watch/cover', { method: 'POST', body: { id: '554779' } });
  assert.equal((await retry()).json.source, 'cached');
  assert.deepEqual(await fs.readFile(file), image);
  await fs.writeFile(file, '<html>Error</html>'.repeat(40));
  assert.equal((await fetch(url + '?test=damaged')).status, 404);
  assert.equal((await retry()).status, 503);
});

test('季度封面先读本机，缺图可用刚加入的季度地址补取和缓存', async t => {
  const root = await makeFixture();
  const imagePath = path.join(ROOT, 'assets/season-catalog/covers/543360.jpg');
  const preload = path.join(root, 'mock-cover.cjs');
  await fs.writeFile(preload, `
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      if (url === 'https://lain.bgm.tv/pic/cover/l/test.jpg')
        return Promise.resolve(new Response(require('node:fs').readFileSync(${JSON.stringify(imagePath)})));
      return originalFetch(url, options);
    };
  `);
  const srv = await startServer(root, { NODE_OPTIONS: `--require "${preload.replaceAll(path.sep, '/')}"` });
  t.after(() => srv.child.kill());
  const origin = 'http://127.0.0.1:' + srv.port;
  const cover = origin + '/cover/543360.jpg';
  assert.equal((await fetch(cover)).status, 404);

  const q = '2099Q1';
  await fs.writeFile(path.join(root, 'data/season', q + '.json'), JSON.stringify({
    q, total: 2, items: [{ id: 543360, image: 'https://lain.bgm.tv/pic/cover/l/test.jpg' }, { id: 616453 }],
  }));
  assert.equal((await fetch(cover + '?local=1')).status, 404);
  assert.equal((await fetch(cover + '?q=2099Q2')).status, 404);
  assert.equal((await fetch(origin + '/cover/616453.jpg?q=' + q)).status, 404);
  const response = await fetch(cover + '?q=' + q);
  const expected = await fs.readFile(imagePath);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  assert.deepEqual(await fs.readFile(path.join(root, 'data/covers/543360.jpg')), expected);
  assert.equal((await fetch(cover + '?local=1')).status, 200);
});

test('启动状态含季度封面时正常返回番库并可读本地图片', async t => {
  const root = await makeFixture();
  const q = seasonOf(new Date());
  const id = '554779';
  const image = 'https://lain.bgm.tv/pic/cover/l/test.jpg';
  await fs.writeFile(path.join(root, 'data/season', q + '.json'), JSON.stringify({
    q, total: 1, items: [{ id, image }], fetched_at: new Date().toISOString(),
  }));
  await fs.mkdir(path.join(root, 'data/covers'));
  await fs.copyFile(path.join(ROOT, 'assets/season-catalog/covers/543360.jpg'), path.join(root, 'data/covers', id + '.jpg'));
  const srv = await startServer(root, { BGM_PROXY: 'http://127.0.0.1:1' });
  t.after(() => srv.child.kill());
  const state = await req(srv.port, '/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.json.ok, true);
  assert.equal(state.json.images[id], image);
  assert.ok(state.json.watching.some(entry => String(entry.id) === id));
  const cover = await fetch('http://127.0.0.1:' + srv.port + '/cover/' + id + '.jpg?local=1');
  assert.equal(cover.headers.get('content-type'), 'image/jpeg');
});

test('季度缓存包含损坏行时，季度接口继续返回随包目录', async t => {
  const root = await makeFixture();
  const q = '2019Q1';
  const catalog = path.join(root, 'assets/season-catalog');
  await fs.mkdir(catalog, { recursive: true });
  await fs.copyFile(path.join(ROOT, 'assets/season-catalog', q + '.json'), path.join(catalog, q + '.json'));
  await fs.writeFile(path.join(root, 'data/season', q + '.json'), JSON.stringify({ q, total: 1, items: [null] }));
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const season = await req(srv.port, '/api/season?q=' + q);
  assert.equal(season.status, 200);
  assert.equal(season.json.source, 'builtin');
  assert.ok(season.json.items.length);
});

test('损坏的章节缓存不会让章节清单和完播查询失效', async t => {
  const root = await makeFixture();
  const id = '554779';
  const dir = path.join(root, 'cache/bgm/episodes');
  await fs.mkdir(dir, { recursive: true });
  const filename = path.join(dir, id + '.json');
  await fs.writeFile(filename, JSON.stringify({ items: [null] }));
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const status = await req(srv.port, '/api/broadcast/status?id=' + id);
  assert.equal(status.status, 200);
  assert.equal(status.json.status.state, 'unknown');
  assert.deepEqual((await req(srv.port, '/api/watch/episodes?id=' + id)).json.chapters, []);
  const items = [{ number: 1, title: '第 1 话' }];
  await fs.writeFile(filename, JSON.stringify({ items }));
  assert.deepEqual((await req(srv.port, '/api/watch/episodes?id=' + id)).json.chapters, items);
});

test('同步预览拒绝异常放送表并继续利用有效缓存', async t => {
  const root = await makeFixture();
  let calendar = [null];
  const upstream = http.createServer((_, res) => res.end(JSON.stringify(calendar)));
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const srv = await startServer(root, { BGM_BASE: 'http://127.0.0.1:' + upstream.address().port });
  t.after(() => srv.child.kill());
  const preview = () => req(srv.port, '/api/sync', { method: 'POST',
    body: { dry_run: true, mode: 'calendar', use_cache: true } });
  const failed = await preview();
  assert.equal(failed.status, 502);
  assert.equal(failed.json.sources.calendar.cache_available, false);
  calendar = [{ weekday: { id: 1 }, items: [{ id: 554779 }] }];
  assert.equal((await preview()).json.sources.calendar.status, 'ok');
  calendar = [{ items: [null] }];
  assert.equal((await preview()).json.sources.calendar.status, 'cached');
  const dir = path.join(root, 'cache/bgm');
  const name = (await fs.readdir(dir)).find(file => /^sync-.*-calendar\.json$/.test(file));
  assert.ok(name);
  await fs.writeFile(path.join(dir, name), JSON.stringify({ at: new Date().toISOString(), data: [null] }));
  const invalidCache = await preview();
  assert.equal(invalidCache.status, 502);
  assert.equal(invalidCache.json.sources.calendar.cache_available, false);
});

test('旧番库 CSV 离线预览，按编号和年份识别重复，确认只新增所选条目', async t => {
  const root = await makeFixture();
  const pathHistory = path.join(root, 'data/history.jsonl');
  const history = '{"id":"554779","date":"2026-10-20","delta":1}\n';
  await fs.writeFile(pathHistory, history);
  const srv = await startServer(root, { BGM_BASE: 'http://127.0.0.1:1' });
  t.after(() => srv.child.kill());
  const csv = '\uFEFF标题,已看集数,总集数,年份,Bangumi编号\r\n' + [
    '不同名但相同编号,8,12,2026,554779',
    '"有,逗号的旧番",3,12,2020,',
    '"有,逗号的旧番",12,12,2024,',
    '"有,逗号的旧番",5,12,2020,',
    '新收藏,0,,1999,922337',
    '错误进度,13,12,,',
  ].join('\r\n') + '\r\n';
  const post = body => req(srv.port, '/api/library/csv', { method: 'POST', body });
  const previous = await readLib(root);
  const preview = (await post({ preview: true, csv })).json;
  assert.deepEqual(preview.rows.map(row => row.action), ['duplicate', 'add', 'add', 'duplicate', 'add', 'invalid']);
  assert.equal(preview.rows[0].matches[0].id, '554779');
  assert.deepEqual(preview.rows[3].earlier, [3]);
  assert.deepEqual(await readLib(root), previous);
  assert.equal((await post({ revision: preview.revision, csv: csv.replace('新收藏', '另一部'), selected: [6] })).status, 409);
  assert.equal((await post({ revision: preview.revision, csv, selected: [2] })).status, 400);
  const applied = await post({ revision: preview.revision, csv, selected: [4, 6] });
  assert.equal(applied.status, 201);
  const after = await readLib(root);
  assert.equal(after.watching.length, 2);
  assert.equal(after.watching[1].ep_status, 12);
  assert.equal(after.watching[1].user_details.year, 2024);
  assert.equal(after.planned[0].id, 922337);
  assert.deepEqual(after.watching[0], previous.watching[0]);
  assert.equal(await fs.readFile(pathHistory, 'utf8'), history);
  assert.equal((await post({ revision: preview.revision, csv, selected: [4, 6] })).status, 409);
});

test('网页私人 SSP 导出以预览日期为准，独立于公开发行目录和凭据', async t => {
  const root = await makeFixture();
  for (const rel of ['tools', 'lib', 'package.json', 'ghost/master/descript.txt', 'shell/master'])
    await fs.cp(path.join(ROOT, rel), path.join(root, rel), { recursive: true });
  const libraryPath = path.join(root, 'data/library.json');
  const library = await readLib(root);
  const title = 'PRIVATE-SSP-WEB-SAMPLE';
  const token = 'PRIVATE-SSP-WEB-SAMPLE-TOKEN';
  library.watching[0].name_cn = title;
  library.watching[0].bgmToken = token;
  library.weekday[1][0].name_cn = title;
  library.watching.push({ id: 'local-ssp-catchup', name_cn: '本机补番项目', watch_mode: 'catchup', ep_status: 2, eps: 12 });
  await fs.writeFile(libraryPath, JSON.stringify(library));
  await fs.writeFile(path.join(root, 'data/bgm.json'), JSON.stringify({ token }));
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const endpoint = '/api/export/ssp';
  const preview = (await req(srv.port, endpoint)).json;
  assert.equal(Date.parse(preview.to) - Date.parse(preview.from), 6 * 86400000);
  library.user.nickname_for_pet = '测试称呼';
  await fs.writeFile(libraryPath, JSON.stringify(library));
  assert.equal((await req(srv.port, endpoint, { method: 'POST', body: { revision: preview.revision } })).status, 409);
  const current = (await req(srv.port, endpoint)).json;
  const address = 'http://127.0.0.1:' + srv.port;
  const reply = await fetch(address + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: address },
    body: JSON.stringify({ revision: current.revision }) });
  assert.equal(reply.status, 200);
  assert.match(reply.headers.get('content-disposition'), /private/);
  const entries = readZip(Buffer.from(await reply.arrayBuffer()));
  const snapshot = JSON.parse(entries.find(file => file.name === 'ghost/master/today.json').data);
  assert.equal(snapshot.date, current.from);
  assert.ok(snapshot.all_shows.some(row => row.name_cn === title));
  assert.equal(snapshot.catchup.find(row => row.id === 'local-ssp-catchup').ep_status, 2);
  assert.match(entries.find(file => file.name === 'ghost/master/basis.dic').data.toString('utf8'), /本机补番项目/);
  assert.ok(entries.find(file => file.name === 'readme.txt').data.toString('utf8').includes(current.from + ' 至 ' + current.to));
  assert.equal(entries.some(file => file.data.includes(Buffer.from(token))), false);
  await assert.rejects(fs.stat(path.join(root, 'dist')), { code: 'ENOENT' });
});

test('Bangumi 单集回写须确认，保护本机与线上冲突，并可安全重试未确认的响应', async t => {
  const root = await makeFixture();
  const library = await readLib(root);
  Object.assign(library.watching[0], { start_episode: 3, ep_status: 3 });
  await fs.writeFile(path.join(root, 'data/library.json'), JSON.stringify(library));
  let state = { type: 0, updated_at: 7 }, permission = false, lostConfirmation = true;
  const bodies = [];
  const upstream = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const reply = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
    if (request.headers.authorization !== 'Bearer fixture-writeback') return reply(401, {});
    const chapter = { id: 995511, type: 0, ep: 3, name_cn: '合成第三话' };
    if (url.pathname === '/v0/me') return reply(200, { username: 'writeback-fixture' });
    if (url.pathname === '/v0/users/writeback-fixture/collections/554779') return reply(200, { subject_id: 554779, subject_type: 2 });
    if (url.pathname === '/v0/users/-/collections/554779/episodes') return reply(200, { total: 1, data: [{ episode: chapter }] });
    if (url.pathname !== '/v0/users/-/collections/-/episodes/995511') return reply(404, {});
    if (request.method === 'GET') return reply(200, { episode: chapter, ...state });
    if (request.method !== 'PUT') return reply(405, {});
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!permission) return reply(403, { token: 'remote-field-must-stay-private' });
    state = { type: 2, updated_at: state.updated_at + 1 };
    if (lostConfirmation) return reply(503, {});
    response.writeHead(204);
    response.end();
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const srv = await startServer(root, { BGM_BASE: 'http://127.0.0.1:' + upstream.address().port,
    BGM_PROXY: '', BGM_USER: 'writeback-fixture', BGM_TOKEN: 'fixture-writeback' });
  t.after(() => { srv.child.kill(); upstream.close(); });
  const endpoint = '/api/watch/bgm-writeback';
  const submit = body => req(srv.port, endpoint, { method: 'POST', body: { id: '554779', episode: 3, ...body } });
  assert.equal((await submit({ episode: 1, preview: true })).status, 409);
  assert.equal((await submit({ confirmation: 'missing' })).status, 409);
  const preview = (await submit({ preview: true })).json;
  assert.equal(preview.remote, 0);
  assert.equal(preview.chapter.id, 995511);
  assert.equal(preview.user, 'writeback-fixture');
  assert.equal(bodies.length, 0);
  const denied = await submit({ confirmation: preview.confirmation });
  assert.equal(denied.status, 403);
  assert.match(denied.json.error, /write:collection/);
  assert.doesNotMatch(denied.text, /remote-field-must-stay-private/);
  assert.equal(state.type, 0);
  permission = true;
  state = { type: 1, updated_at: 8 };
  assert.equal((await submit({ confirmation: preview.confirmation })).status, 409);
  assert.equal(bodies.length, 1);
  const fresh = (await submit({ preview: true })).json;
  assert.equal((await submit({ confirmation: fresh.confirmation })).status, 502);
  assert.equal((await submit({ confirmation: fresh.confirmation })).json.already, true);
  assert.deepEqual(bodies, [{ type: 2 }, { type: 2 }]);
  await fs.writeFile(path.join(root, 'data/library.json'), JSON.stringify({ ...library, watching: [{ ...library.watching[0], ep_status: 0 }] }));
  assert.equal((await submit({ confirmation: fresh.confirmation })).status, 409);
  assert.equal(bodies.length, 2);
});

test('观看链接可新增、保留和清除，网页与桌宠只展示有效网址', async t => {
  const root = await makeFixture();
  await fs.writeFile(path.join(root, 'data/library.json'), '{"watching":[],"weekday":{}}');
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  const base = { name: '观看入口验收番', eps: 3, ep_status: 1, air_weekday: 2, air_time_cst: '23:00' };
  for (const watch_url of ['javascript:alert(1)', 'file:///C:/Windows/', 'https://user:password@example.org/',
    'https://example.org/has space', 'https://example.org/\\bad', 42]) {
    assert.equal((await post('/api/watch/detail', { ...base, watch_url })).status, 400);
  }
  const url = 'https://example.org/show?ep=2&quality=hd';
  const add = await post('/api/watch/detail', { ...base, watch_url: url });
  assert.equal(add.status, 201);
  const id = add.json.detail.id;
  const get = route => req(srv.port, route);
  const detail = () => get('/api/watch/detail?id=' + id).then(r => r.json.detail);
  assert.equal((await detail()).watch_url, url);
  assert.equal((await get('/api/schedule/desktop')).json.rows[0].watch_url, url);
  assert.equal((await get('/api/state')).json.watching[0].watch_url, url);
  assert.equal((await post('/api/watch/detail', { ...base, id, ep_status: 3 })).json.detail.watch_url, url);
  await post('/api/watch/lifecycle', { id, action: 'archive' });
  assert.equal((await detail()).watch_url, url);
  await post('/api/watch/lifecycle', { id, action: 'resume' });
  assert.equal((await post('/api/watch/detail', { ...base, id, watch_url: null })).json.detail.watch_url, null);
  assert.equal((await get('/api/schedule/desktop')).json.rows[0].watch_url, undefined);
});

test('导入中断后启动面板会回滚番库、设置和历史', async t => {
  const root = await makeFixture();
  const file = name => path.join(root, 'data', name);
  const library = await fs.readFile(file('library.json'), 'utf8');
  const original = { 'library.json': library, 'settings.json': '{"clock":"24h"}\n',
    'history.jsonl': '{"date":"2026-01-01","delta":1}\n', 'history-2025.jsonl': null };
  await fs.writeFile(file('.migration-pending.json'), JSON.stringify({ files: original }));
  await fs.writeFile(file('library.json'), '{"watching":[]}\n');
  await fs.writeFile(file('settings.json'), '{"clock":"30h"}\n');
  await fs.writeFile(file('history-2025.jsonl'), '{"delta":99}\n');
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  assert.equal((await req(srv.port, '/api/state')).json.watching.length, 1);
  for (const [name, data] of Object.entries(original)) {
    if (data === null) await assert.rejects(fs.access(file(name)), { code: 'ENOENT' });
    else assert.equal(await fs.readFile(file(name), 'utf8'), data);
  }
  await assert.rejects(fs.access(file('.migration-pending.json')), { code: 'ENOENT' });
});

test('迁移手账只带首次见面、好感和剧情，运行状态变化不会使预览失效', async t => {
  const root = await makeFixture();
  const file = name => path.join(root, 'data', name);
  const writeState = state => fs.writeFile(file('state.json'), JSON.stringify(state));
  const state = { vars: { first_seen: '2026-07-08', affinity: '27', token: 'local-only' },
    left: 30, reminded: ['a'], recent_lines: ['on-this-machine'], focus_until: 123 };
  await writeState(state);
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const post = body => req(srv.port, '/api/migration', { method: 'POST', body });
  const get = async () => (await req(srv.port, '/api/migration')).json.migration;
  const old = await get();
  assert.deepEqual(old.companion, { first_seen: '2026-07-08', affinity: 27, stories: {} });
  assert.doesNotMatch(JSON.stringify(old), /local-only|on-this-machine|focus_until/);
  const companion = { first_seen: '2026-04-09', affinity: 64,
    stories: { 'first-page': 2, 'after-credits': 0, 'two-cups': 1, 'after-duty': 2, 'president-note': 1 },
    affinity_daily: { date: TODAY, touch: 3, activity: 'tea', activity_points: 2, story: 6 } };
  const migration = { ...old, companion: { ...companion, stories: { ...companion.stories, injected: 1 }, access_token: 'hidden' } };
  const preview = async () => (await post({ preview: true, migration })).json;
  let plan = await preview();
  assert.deepEqual(plan.incoming.companion, { first_seen: '2026-04-09', affinity: 64, stories: 5 });
  const apply = () => post({ migration, source: plan.source, target: plan.target });
  state.vars.affinity = '28';
  await writeState(state);
  assert.equal((await apply()).status, 409);
  plan = await preview();
  state.left = 60;
  state.recent_lines.push('ambient update');
  await writeState(state);
  const applied = await apply();
  assert.equal(applied.status, 200);
  assert.deepEqual(JSON.parse(await fs.readFile(file('state.json'), 'utf8')), state);
  assert.deepEqual((await get()).companion, companion);
  const pending = JSON.parse(await fs.readFile(file('companion-import.json'), 'utf8'));
  assert.deepEqual(pending.companion, companion);
  const backup = JSON.parse(await fs.readFile(file('backups/' + applied.json.backup), 'utf8'));
  assert.equal(backup.companion.affinity, 28);
  await writeState({ ...state, companion_import: pending.id,
    vars: { first_seen: companion.first_seen, affinity: '65' }, stories: { ...companion.stories, 'after-credits': 1 },
    affinity_daily: companion.affinity_daily });
  assert.deepEqual((await get()).companion, { ...companion, affinity: 65, stories: { ...companion.stories, 'after-credits': 1 } });
});

test('离线新增和详情编辑共用备份与撤销，跨日排期按实际日期生成', async t => {
  const root = await makeFixture();
  await installBuildTools(root);
  await fs.writeFile(path.join(root, 'data/library.json'), JSON.stringify({ watching: [], weekday: {} }));
  await fs.writeFile(path.join(root, 'data/bgm.json'), JSON.stringify({ proxy: 'http://127.0.0.1:1' }));
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  const save = body => post('/api/watch/detail', body);
  const draft = { name: '离线番剧', eps: 12, ep_status: 3, air_weekday: 1, air_time_cst: '25:30' };
  assert.equal((await save({ ...draft, ep_status: 13 })).status, 400);
  assert.equal((await save({ ...draft, air_weekday: null })).status, 400);
  assert.equal((await save({ ...draft, name: '番名\n日期注入' })).status, 400);
  const added = await save(draft);
  assert.equal(added.status, 201);
  assert.equal(added.json.rebuilt, true);
  const { id, revision } = added.json.detail;
  assert.match(id, /^local-/);
  const read = () => req(srv.port, '/api/watch/detail?id=' + encodeURIComponent(id));
  assert.deepEqual((await read()).json.detail, added.json.detail);
  const generated = JSON.parse(await fs.readFile(path.join(root, 'data/today.json')));
  assert.deepEqual(generated.all_shows.filter(x => x.id === id).map(x => [x.weekday, x.time_cst]), [[2, '01:30']]);

  const edited = await save({ ...draft, id, expected_revision: revision, ep_status: 8, air_weekday: 5, air_time_cst: '9:05' });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.detail.ep_status, 8);
  const saved = await readLib(root);
  assert.equal(saved.weekday[1].length, 0);
  assert.equal(saved.weekday[5][0].time_cst, '09:05');
  assert.equal(await fs.readFile(path.join(root, 'data/history.jsonl'), 'utf8'), '');
  assert.equal((await save({ ...draft, id, expected_revision: revision })).status, 409);
  assert.equal((await post('/api/undo', { expected_revision: edited.json.revision })).status, 200);
  assert.equal((await read()).json.detail.ep_status, 3);
  const clear = await save({ ...draft, id, air_weekday: null, air_time_cst: null, eps: null });
  assert.equal(clear.json.detail.eps, null);
  assert.ok(Object.values((await readLib(root)).weekday).every(rows => rows.length === 0));
});

test('暂停、继续、归档保留排期和进度，并同步到提醒与导出', async t => {
  const root = await makeFixture();
  await installBuildTools(root);
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  const readState = async () => (await req(srv.port, '/api/state')).json;
  const draft = { name: '追番状态测试', eps: 12, ep_status: 3, air_weekday: cstParts().weekday, air_time_cst: '23:00' };
  const added = await post('/api/watch/detail', draft);
  assert.equal(added.status, 201);
  const { id, revision } = added.json.detail;
  const read = async () => (await req(srv.port, '/api/watch/detail?id=' + id)).json.detail;
  const move = (action, expected_revision) => post('/api/watch/lifecycle', { id, action, expected_revision });
  const isShow = w => w.id === id;
  const scheduled = async () => JSON.parse(await fs.readFile(path.join(root, 'data/today.json'))).all_shows.some(isShow);
  const exported = async () => (await req(srv.port, '/api/export?fmt=ics')).text.includes(id);

  assert.equal(await scheduled(), true);
  assert.equal(await exported(), true);
  assert.equal((await move('archive')).status, 409);
  const paused = await move('pause', revision);
  assert.equal(paused.json.rebuilt, true);
  assert.equal(paused.json.state, 'paused');
  assert.equal((await move('resume', revision)).status, 409);
  assert.equal((await read()).ep_status, 3);
  assert.equal((await readLib(root)).weekday[draft.air_weekday].find(isShow).time_cst, '23:00');
  const state = await readState();
  for (const key of ['watching', 'today', 'side', 'behind', 'catchup', 'reminders']) {
    assert.ok(!state[key].some(isShow), key);
  }
  assert.ok(!state.pending.shows.some(isShow));
  assert.ok(!Object.values(state.week).flat().some(isShow));
  assert.equal(state.paused.find(isShow).ep_status, 3);
  assert.equal(await scheduled(), false);
  assert.equal(await exported(), false);
  assert.equal((await post('/api/progress', { id, delta: 1 })).status, 404);
  assert.equal((await post('/api/watch', { id, action: 'add' })).status, 409);
  assert.equal((await post('/api/season/time-batch', { ids: [id], time: '22:10', weekday: 3 })).json.count, 0);

  assert.equal((await move('resume', (await read()).revision)).json.state, 'watching');
  assert.deepEqual(await read(), added.json.detail);
  assert.equal(await scheduled(), true);
  assert.equal(await exported(), true);
  assert.equal((await post('/api/progress', { id, set: 12 })).status, 200);

  const archived = await move('archive', (await read()).revision);
  assert.equal(archived.json.rebuilt, true);
  assert.equal(archived.json.state, 'archived');
  assert.equal((await readState()).archived.find(isShow).ep_status, 12);
  assert.equal((await read()).state, 'archived');
  assert.equal((await req(srv.port, '/api/stats')).json.finished, 1);
  assert.equal(await scheduled(), false);
  assert.equal(await exported(), false);
  assert.equal((await post('/api/watch/detail', { ...draft, id })).status, 409);
  assert.equal((await post('/api/undo', { expected_revision: archived.json.revision })).status, 200);
  assert.equal((await read()).ep_status, 12);
  assert.equal((await read()).state, 'watching');
});

test('第五轮：标量、设置保留、撤销版本和真实重建', async t => {
  const root = await makeFixture();
  await installBuildTools(root);
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  for (const body of ['null', 'false', '0', '""', '[]']) assert.equal((await post('/api/settings', body)).status, 400);
  await fs.writeFile(path.join(root, 'data/settings.json'), JSON.stringify({ clock: '30h', pet_scale: 1, birthday: '11-05' }));
  const settings = path.join(root, 'data/settings.json');
  const patches = await Promise.all([post('/api/settings', { clock: '24h', catchup_goal: 4 }),
    post('/api/settings', { pet_scale: 1.25 }), post('/api/settings', { power_save: true })]);
  assert.ok(patches.every(result => result.status === 200));
  const savedSettings = await fs.readFile(settings, 'utf8');
  assert.deepEqual(JSON.parse(savedSettings), { clock: '24h', pet_scale: 1.25, birthday: '11-05',
    catchup_goal: 4, power_save: true });
  assert.equal((await post('/api/settings', { power_save: 'yes' })).status, 400);
  await fs.writeFile(settings, '{"clock":');
  assert.equal((await post('/api/settings', { pet_scale: 1.5 })).status, 500);
  assert.equal(await fs.readFile(settings, 'utf8'), '{"clock":');
  await fs.writeFile(settings, savedSettings);
  const a = await post('/api/progress', { id: 554779, delta: 1 });
  assert.equal(a.json.rebuilt, true);
  assert.match(await fs.readFile(path.join(root, 'ghost/master/today.txt'), 'utf8'), /date=\d{4}-\d{2}-\d{2}/);
  assert.ok(JSON.parse(await fs.readFile(path.join(root, 'data/today.json'))));
  assert.match(await fs.readFile(path.join(root, 'ghost/master/basis.dic'), 'utf8'), /OnSecondChange/);
  assert.deepEqual(
    await fs.readFile(path.join(root, 'ghost/master/today.json')),
    await fs.readFile(path.join(root, 'data/today.json')),
  );
  await post('/api/progress', { id: 554779, delta: 1 });
  assert.equal((await post('/api/undo', { expected_revision: a.json.revision })).status, 409);
  assert.equal((await readLib(root)).watching[0].ep_status, 2);
  assert.ok((await fs.stat(path.join(root, `data/backups/${TODAY}/library.json`))).size > 0);
});

test('首页、周报、补番目标按同一周计算净观看集数，忽略手动更正', async t => {
  const root = await makeFixture();
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const get = async url => (await req(srv.port, url)).json;
  const post = (url, body) => req(srv.port, url, { method: 'POST', body });
  const { detail } = (await post('/api/watch/detail', {
    name: '手动补番统计', eps: 12, ep_status: 0, watch_mode: 'catchup',
  })).json;
  const id = detail.id;
  const now = new Date();
  const previousSunday = cstParts(new Date(+now - cstParts(now).weekday * 86400000)).date;
  const progress = async fields => assert.equal((await post('/api/progress', { id, ...fields })).status, 200);
  await progress({ delta: 1, watched_on: previousSunday });
  await progress({ delta: 1 });
  await progress({ delta: -1 });
  await progress({ set: 4 });
  const [stats, report, state] = await Promise.all([get('/api/stats'), get('/api/watch/report'), get('/api/state')]);
  assert.equal(stats.total, 1);
  assert.deepEqual([stats.week, report.count, report.mode.catchup, state.catchup_week.watched], [0, 0, 0, 0]);
  assert.equal((await get('/api/watch/report?week=' + previousSunday)).count, 1);
});

test('同步网络等待期间的进度不会丢；同步使用备份、撤销和成功时间戳', async t => {
  const root = await makeFixture();
  await fs.cp(path.join(ROOT, 'lib'), path.join(root, 'lib'), { recursive: true });
  await fs.copyFile(path.join(ROOT, 'tools/sync_bangumi.mjs'), path.join(root, 'tools/sync_bangumi.mjs'));
  let answer, arrived;
  const requested = new Promise(r => { arrived = r; });
  const remote = http.createServer((request, response) => {
    answer = () => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify([
      { weekday: { id: 2 }, items: [{ id: 554779, air_weekday: 2, type: 2 }] }
    ])); };
    arrived();
  });
  remote.listen(0, '127.0.0.1');
  await once(remote, 'listening');
  t.after(() => { remote.closeAllConnections(); remote.close(); });
  const srv = await startServer(root);
  t.after(() => srv.child.kill());
  const sync = spawn(process.execPath, [path.join(root, 'tools/sync_bangumi.mjs'), '--calendar-only', '--no-build', '--base', `http://127.0.0.1:${remote.address().port}`], {
    windowsHide: true, stdio: 'ignore', env: { ...process.env, BGM_BASE: '', BGM_PROXY: '', BGM_TOKEN: '' }
  });
  t.after(() => sync.kill());
  const exited = once(sync, 'exit');
  await Promise.race([requested, new Promise((_, reject) => setTimeout(() => reject(new Error('mock calendar timeout')), 5000).unref())]);
  const progress = await req(srv.port, '/api/progress', { method: 'POST', body: { id: 554779, delta: 1 } });
  assert.equal(progress.json.ep_status, 1);
  answer();
  assert.equal((await exited)[0], 0);
  const lib = await readLib(root);
  assert.equal(lib.watching[0].ep_status, 1);
  assert.equal(lib.watching[0].air_weekday, 2);
  assert.equal((await fs.readdir(path.join(root, 'data/undo'))).length, 2);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'data/library.json.bak'))).watching[0].ep_status, 1);
  assert.ok(JSON.parse(await fs.readFile(path.join(root, 'cache/bgm/sync-success.json'))).at);
});

test('server.mjs 接口契约', async (t) => {
  const root = await makeFixture();
  const srv = await startServer(root);
  const { port } = srv;
  let killed = false;
  t.after(() => {
    if (!killed) srv.child.kill();
    killed = true;
  });

  await t.test('GET /api/health：带 app/version/port，能被启动器认出来', async () => {
    const r = await req(port, '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.app, 'tiara');
    assert.match(r.json.version, /^\d+\.\d+\.\d+/);
    assert.equal(r.json.port, port);
    assert.ok(r.json.pid > 0);
  });

  await t.test('GET /api/version：不回绝对路径（以前会把 C:\\Users\\… 抖给页面）', async () => {
    const r = await req(port, '/api/version');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.match(r.json.version, /^\d+\.\d+\.\d+/);
    assert.ok(!('root' in r.json), '不能回 root');
    assert.ok(!r.text.includes(ROOT), '响应体里不能出现绝对路径');
  });

  await t.test('未知 /api：JSON 404 且 ok:false（以前是纯文本 "404 talks"）', async () => {
    const r = await req(port, '/api/talks');
    assert.equal(r.status, 404);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /no such api/);
  });

  await t.test('坏 JSON 的 POST：400 + ok:false，进程必须活着（原 P0 会 exit 1）', async () => {
    const r = await req(port, '/api/settings', { method: 'POST', body: '{oops', headers: { 'Content-Type': 'application/json' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /json/i);
    const alive = await req(port, '/api/health');
    assert.equal(alive.status, 200, '写过坏请求之后服务还得在');
  });

  await t.test('跨站写入被挡（本机来源才放行）', async () => {
    const r = await req(port, '/api/settings', {
      method: 'POST',
      body: { nickname: 'evil' },
      headers: { Origin: 'http://evil.example.com' },
    });
    assert.equal(r.status, 403);
    assert.equal(r.json.ok, false);
  });

  await t.test('POST /api/progress：+1 生效、updated 是今天（原 P0 时间戳慢一拍）', async () => {
    const r = await req(port, '/api/progress', { method: 'POST', body: { id: '554779', delta: 1 } });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.prev, 0);
    assert.equal(r.json.ep_status, 1);
    assert.equal(r.json.changed, true);
    const lib = await readLib(root);
    assert.equal(lib.watching[0].ep_status, 1);
    assert.equal(lib.updated, TODAY);
  });

  await t.test('POST /api/progress：非数字 delta / 不在追 → 400 与 404', async () => {
    const bad = await req(port, '/api/progress', { method: 'POST', body: { id: '554779', delta: 'abc' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.ok, false);
    const missing = await req(port, '/api/progress', { method: 'POST', body: { id: '99999999', delta: 1 } });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.ok, false);
  });

  await t.test('POST /api/progress：set 会被夹在 0..eps 之间', async () => {
    const hi = await req(port, '/api/progress', { method: 'POST', body: { id: '554779', set: 99 } });
    assert.equal(hi.json.ep_status, 12);
    const lo = await req(port, '/api/progress', { method: 'POST', body: { id: '554779', set: -5 } });
    assert.equal(lo.json.ep_status, 0);
  });

  await t.test('POST /api/undo：退回上一步并返回 depth', async () => {
    await req(port, '/api/progress', { method: 'POST', body: { id: '554779', set: 5 } });
    const r = await req(port, '/api/undo', { method: 'POST', body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.undone, true);
    assert.equal(typeof r.json.depth, 'number');
    const lib = await readLib(root);
    assert.notEqual(lib.watching[0].ep_status, 5);
  });

  await t.test('POST /api/restore：路径穿越与不存在的名字 → 404 且列出可用备份', async () => {
    for (const name of ['../../package.json', 'nope.json', 'sub/dir.json']) {
      const r = await req(port, '/api/restore', { method: 'POST', body: { name } });
      assert.equal(r.status, 404, `${name} 必须被拒`);
      assert.equal(r.json.ok, false);
      assert.ok(Array.isArray(r.json.backups));
    }
  });

  await t.test('时刻只有一种写法：abc 拒、25:30 收（单条与批量口径一致）', async () => {
    const badSingle = await req(port, '/api/season/time', { method: 'POST', body: { id: '554779', time: 'abc' } });
    assert.equal(badSingle.status, 400);
    const badBatch = await req(port, '/api/season/time-batch', { method: 'POST', body: { ids: ['554779'], time: 'abc' } });
    assert.equal(badBatch.status, 400);
    const ok = await req(port, '/api/season/time-batch', { method: 'POST', body: { ids: ['554779'], time: '25:30' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.deepEqual(ok.json.changed, ['554779']);
    assert.equal(ok.json.time_cst, '25:30');
  });

  await t.test('删掉的 /api/reload 真的 404（以前任意 GET 能拉起 3 个 node）', async () => {
    const r = await req(port, '/api/reload');
    assert.equal(r.status, 404);
    assert.equal(r.json.ok, false);
  });

  await t.test('静态服务：拆分后的 index.html / style.css / app.js 都拿得到', async () => {
    for (const [p, needle] of [['/', 'tiara'], ['/style.css', 'color'], ['/app.js', '__TIARA_TEST__']]) {
      const r = await req(port, p);
      assert.equal(r.status, 200, `${p} 应该是 200`);
      assert.ok(r.text.includes(needle), `${p} 内容不对`);
    }
    const traversal = await req(port, '/../package.json');
    assert.equal(traversal.status, 404, '目录穿越必须挡住');
  });

  await t.test('单实例：同一数据目录再起一个会直接退出（不再悄悄 +1 端口）', async () => {
    const second = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--root', root], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    second.stdout.on('data', (b) => { out += String(b); });
    second.stderr.on('data', (b) => { out += String(b); });
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => { second.kill(); resolve('timeout'); }, 15000);
      second.on('exit', (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.equal(code, 0, `第二个进程应当以 0 退出并打印已有地址；实际 ${code}，输出：${out}`);
    assert.match(out, /127\.0\.0\.1/);
  });
});

test('托管服务隔离目录、合并并发启动，桌宠管道关闭后只退出自己的服务', async t => {
  const foreignRoot = await makeFixture();
  const foreign = await startServer(foreignRoot);
  t.after(() => foreign.child.kill());
  const root = await makeFixture();
  const portFile = path.join(root, 'cache/panel_port.txt');
  await fs.mkdir(path.dirname(portFile), { recursive: true });
  await fs.writeFile(portFile, String(foreign.port));
  const children = Array.from({ length: 2 }, () => {
    const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--root', root, '--managed'], {
      cwd: ROOT, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
    });
    return { child, exited: once(child, 'exit') };
  });
  t.after(() => children.forEach(({ child }) => { if (child.exitCode == null) child.kill(); }));
  let own;
  for (let i = 0; i < 80 && !own; i++) {
    own = await probePanel(Number(await fs.readFile(portFile, 'utf8')), panelId(root));
    if (!own) await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(own, 'did not publish own service');
  const serving = children.find(x => x.child.pid === own.pid);
  assert.ok(serving);
  const redundant = children.find(x => x !== serving);
  assert.equal((await redundant.exited)[0], 0);
  const badStop = await req(own.port, '/api/_shutdown', { method: 'POST', body: {} });
  assert.equal(badStop.status, 403);
  serving.child.stdin.end();
  assert.equal((await serving.exited)[0], 0);
  assert.ok(await probePanel(foreign.port, panelId(foreignRoot)));
});

test('--no-portfile：临时实例不改写端口指针，主实例的 panel_port.txt 不被踩掉', async (t) => {
  const root = await makeFixture();
  const portFile = path.join(root, 'cache', 'panel_port.txt');
  // 先摆一个「主实例」留下的指针，模拟用户服务正在 7788 跑
  await fs.mkdir(path.dirname(portFile), { recursive: true });
  await fs.writeFile(portFile, '7788', 'utf8');

  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--port', '0', '--root', root, '--no-portfile'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let out = '';
  child.stderr.on('data', (b) => { stderr += String(b); });
  child.stdout.on('data', (b) => { out += String(b); });
  t.after(() => { child.kill(); });

  // 端口拿不到 panel_port.txt，只能从启动日志里读（logLine 打的是真端口）
  let port = 0;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !port && child.exitCode == null) {
    await new Promise((r) => setTimeout(r, 100));
    const m = out.match(/面板 → http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) port = Number(m[1]);
  }
  assert.ok(port > 0, `没从日志里读到端口：${out}\n${stderr}`);

  const health = await req(port, '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.app, 'tiara');

  // 指针文件必须还是 7788 —— 体检脚本/演示实例把这里改成 7860 的话，
  // 桌宠右键「打开网页番组表」就去找一个已经关掉的端口了。
  assert.equal((await fs.readFile(portFile, 'utf8')).trim(), '7788');
});
