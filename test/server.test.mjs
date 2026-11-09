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
import { cstParts } from '../lib/today.mjs';
import { seasonOf } from '../lib/bgm.mjs';
import http from 'node:http';
import { once } from 'node:events';
import { panelId, probePanel } from '../lib/panel-instance.mjs';

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
  for (const name of ['build_today.mjs', 'build_ghost.mjs', 'build_yaya.mjs']) {
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
    env: { ...process.env, ...extraEnv },
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
  for (const name of ['build_today.mjs', 'build_ghost.mjs', 'build_yaya.mjs']) {
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
  assert.equal((await airing()).time_cst, '23:12');
  assert.equal((await airing()).platform, '测试平台');
  await post('/api/season/apply', { q, add: [id] });
  assert.equal((await post('/api/season/time', { id, time: '23:10' })).status, 400);
  assert.equal((await req(srv.port, '/api/watch/detail?id=' + id)).json.airing.time_cst, '23:12');
  const saved = await post('/api/season/time', { id, weekday: 1, time: '25:30' });
  assert.equal(saved.json.rebuilt, true);
  assert.equal((await airing()).source, '本地排期');
  assert.equal(cstParts(new Date((await airing()).next)).hour, 1);
  const snapshot = JSON.parse(await fs.readFile(path.join(root, 'data/today.json'), 'utf8'));
  assert.equal(snapshot.all_shows.find(w => String(w.id) === id).time_cst, '01:30');
  assert.match(await fs.readFile(path.join(root, 'ghost/master/today.txt'), 'utf8'), /library_sha256=[0-9a-f]{64}/);
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
  const schedule = (action, more) => post('/api/watch/schedule', { id, action, ...more });
  assert.equal((await schedule('skip')).status, 200);
  assert.deepEqual(await slots(), []);
  const todayAt = cstParts(new Date(Date.now() + 3600000)).date + 'T23:45';
  const moved = await schedule('move', { at: todayAt });
  assert.equal(moved.status, 200);
  assert.equal((await slots())[0].time_cst, '23:45');
  assert.equal((await schedule('mute', { muted: true })).json.detail.reminder_muted, true);
  const calendar = (await req(srv.port, '/api/export')).text;
  assert.match(calendar, /T234500/);
  assert.ok(!calendar.includes('VALARM'));
  assert.equal((await schedule('end')).status, 200);
  assert.deepEqual(await slots(), []);
  assert.ok((await state()).catchup.some(row => String(row.id) === id));
  assert.equal((await post('/api/progress', { id, delta: 1 })).json.ep_status, 1);
  assert.equal((await schedule('restart')).status, 200);
  assert.equal((await slots())[0].time_cst, '23:45');
  assert.equal((await post('/api/settings', { quiet_start: '23:00', quiet_end: '07:00' })).status, 200);
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
  await Promise.all([post('/api/settings', { clock: '24h' }), post('/api/settings', { pet_scale: 1.25 })]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'data/settings.json'))), { clock: '24h', pet_scale: 1.25, birthday: '11-05' });
  const a = await post('/api/progress', { id: 554779, delta: 1 });
  assert.equal(a.json.rebuilt, true);
  assert.match(await fs.readFile(path.join(root, 'ghost/master/today.txt'), 'utf8'), /date=\d{4}-\d{2}-\d{2}/);
  assert.ok(JSON.parse(await fs.readFile(path.join(root, 'data/today.json'))));
  assert.ok((await fs.stat(path.join(root, 'ghost-yaya/master/basis.dic'))).size > 0);
  await post('/api/progress', { id: 554779, delta: 1 });
  assert.equal((await post('/api/undo', { expected_revision: a.json.revision })).status, 409);
  assert.equal((await readLib(root)).watching[0].ep_status, 2);
  assert.ok((await fs.stat(path.join(root, `data/backups/${TODAY}/library.json`))).size > 0);
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
