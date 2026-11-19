// 面板交互自检：切制式 / 切页签之后，本季表不能停在「正在读缓存」
// 用 Edge 的 CDP 直接驱动真实浏览器。跑法：node tools/check_panel_ui.mjs
import { spawn, execFileSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seasonOf } from '../lib/bgm.mjs';
import { cstParts } from '../lib/today.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];
const edge = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!edge) {
  console.error('找不到 Edge，跳过');
  process.exit(2);
}
if (!globalThis.WebSocket) throw new Error('Edge 面板自检需要支持全局 WebSocket 的 Node.js（CI 使用 Node.js 24）');

const temp = fs.realpathSync(os.tmpdir());
const fixture = fs.mkdtempSync(path.join(temp, 'tiara-ui-'));
const prof = path.join(fixture, 'edge-profile');
const screenshots = path.join(root, 'cache', 'audit', path.basename(fixture));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let serverProc;
let child;
let APP_PORT;

function stop(proc) {
  if (!proc?.pid || proc.exitCode !== null) return;
  try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); }
  catch { proc.kill(); }
}

process.on('exit', () => {
  stop(child);
  stop(serverProc);
  try {
    const real = fs.realpathSync(fixture);
    if (path.dirname(real) === temp && path.basename(real).startsWith('tiara-ui-'))
      fs.rmSync(real, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) { console.warn('临时自检目录清理失败：' + error.message); }
});
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

function prepareFixture() {
  for (const dir of ['data/season', 'cache/bgm', 'ghost/master', 'tools'])
    fs.mkdirSync(path.join(fixture, dir), { recursive: true });
  fs.mkdirSync(screenshots, { recursive: true });
  for (const rel of ['lib', 'panel', 'shell/master', 'tools/build_today.mjs', 'tools/build_ghost.mjs'])
    fs.cpSync(path.join(root, rel), path.join(fixture, rel), { recursive: true });
  fs.copyFileSync(path.join(root, 'tools/release/talks.json'), path.join(fixture, 'data/talks.json'));

  const now = new Date();
  const { weekday } = cstParts(now);
  const { date } = cstParts(new Date(+now - 14 * 86400000));
  const subjects = ['沿海列车的最后一站', '听说图书馆闭馆之后还有一班开往山谷的夜间列车', '窗台上的小小观测站'].map((name, i) => ({
    id: 900000001 + i, name, name_cn: name, eps: 12, weekday, date,
  }));
  const watching = subjects.slice(0, 2).map(subject => ({ ...subject, watch_mode: 'airing',
    start_date: date, track_from: date, ep_status: 1, air_weekday: weekday, air_time_cst: '22:00' }));
  watching[0].last_watched = date;
  watching[0].watch_url = 'https://example.invalid/tiara-demo';
  watching[0].alias = ['海岸终点站'];
  const catchup = { id: 'sample-catchup', name: '傍晚的手绘地图', eps: 13, ep_status: 3,
    watch_mode: 'catchup', catchup_slot: { day: weekday, time: '19:15' } };
  const write = (rel, value) => fs.writeFileSync(path.join(fixture, rel), JSON.stringify(value));
  write('data/library.json', { watching: [...watching, catchup], weekday: { [weekday]: watching.map(w => ({
    id: w.id, name_cn: w.name_cn, time_cst: w.air_time_cst,
  })) } });
  write('data/settings.json', { clock: '30h', pet_scale: 1, reminder_lead: 15 });
  write('cache/bgm/broadcast.json', { at: +now, items: [{
    title: subjects[0].name,
    sites: [{ site: 'bangumi', id: String(subjects[0].id) }],
    broadcast: 'R/' + new Date(date + 'T20:30:00+08:00').toISOString() + '/P7D',
    end: new Date(+now + 45 * 86400000).toISOString(),
  }] });
  for (const offset of [-92, 0, 92]) {
    const q = seasonOf(new Date(+now + offset * 86400000));
    write('data/season/' + q + '.json', { q, items: subjects, fetched_at: now.toISOString() });
  }
}

async function startServer() {
  serverProc = spawn(process.execPath, [path.join(root, 'server.mjs'), '--port', '0', '--root', fixture], {
    cwd: fixture, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, BGM_BASE: 'http://127.0.0.1:1', BGM_BROADCAST_URL: 'http://127.0.0.1:1',
      BGM_PROXY: '', BGM_USER: '', BGM_TOKEN: '' },
  });
  for (let i = 0; i < 80; i++) {
    await sleep(150);
    try {
      APP_PORT = Number(fs.readFileSync(path.join(fixture, 'cache/panel_port.txt'), 'utf8'));
      const origin = 'http://127.0.0.1:' + APP_PORT;
      const health = await fetch(origin + '/api/health').then(r => r.json());
      if (health.app === 'tiara' && health.pid === serverProc.pid) return origin;
    } catch { /* 启动中 */ }
  }
  throw new Error('临时面板服务未启动');
}

async function main() {
  prepareFixture();
  const origin = await startServer();
  child = spawn(edge, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--disable-background-networking',
    '--remote-debugging-port=0', '--user-data-dir=' + prof, '--window-size=1400,1000', 'about:blank'],
  { stdio: 'ignore', windowsHide: true });
  let ws = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const port = fs.readFileSync(path.join(prof, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0];
      const r = await fetch('http://127.0.0.1:' + port + '/json/list');
      const targets = await r.json();
      const page = targets.find((t) => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) { ws = page.webSocketDebuggerUrl; break; }
    } catch (e) { /* 还没起来 */ }
  }
  if (!ws) throw new Error('CDP 没起来');

  const sock = new WebSocket(ws);
  let seq = 0;
  const pending = new Map();
  sock.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  await new Promise((res, rej) => {
    sock.addEventListener('open', res);
    sock.addEventListener('error', rej);
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    sock.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      // 只给 "Uncaught" 没法查，把描述也带上（页面里抛的具体错在这）
      const d = r.exceptionDetails;
      const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text;
      throw new Error(String(msg).split('\n')[0]);
    }
    return r.result.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(screenshots, name), Buffer.from(r.data, 'base64'));
  };
  const waitFor = async (probe, label) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      const value = await probe();
      if (value) return value;
      await sleep(100);
    }
    throw new Error('等待超时：' + label);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  try { await send('Log.enable'); } catch (e) { /* 老浏览器没有 Log 域 */ }

  // 面板里「移出在追」用的是 confirm()，无头浏览器会把它当模态框挂住，
  // 不接管就会永远等不到下一条 CDP 回包（曾经就是这么卡死的）。
  await send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
  await send('Page.setBypassCSP', { enabled: false }).catch(() => {});
  sock.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.method === 'Page.javascriptDialogOpening') {
      send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    }
  });

  // 全程收集页面报错：任何一条未捕获异常 / console.error 都算体检不合格
  const problems = [];
  sock.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      problems.push('exception: ' + (d.exception?.description || d.text || '?'));
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      problems.push('console.error: ' + (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry?.level === 'error') {
      const text = msg.params.entry.text || '';
      // 机器上的系统代理挂了会连本地资源都报 ERR_PROXY_CONNECTION_FAILED，
      // 那是环境噪声，不是面板的 bug。
      if (/ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_INTERNET_DISCONNECTED/.test(text)) return;
      if (msg.params.entry.source === 'network' && !new RegExp('127\\.0\\.0\\.1:' + APP_PORT).test(text)) return;
      problems.push('log: ' + text);
    }
  });

  await send('Page.navigate', { url: origin + '/' });
  await waitFor(() => evaluate(`document.querySelector('#schedule-view-today[aria-pressed="true"]') &&
    document.querySelector('#schedule-continue-900000001-mark') &&
    document.querySelector('#schedule-today-sample-catchup-mark') !== null`), '默认打开今日排片和接着看');
  await shot('cdp_schedule_today.png');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await shot('cdp_schedule_narrow.png');
  await send('Emulation.clearDeviceMetricsOverride');
  await evaluate("document.querySelector('.tab[data-tab=season]').click()");
  await waitFor(() => evaluate("document.querySelector('#seasonBody [data-seadd]')?.dataset.seadd"), '本季缓存');

  const rows = () => evaluate("document.querySelectorAll('#seasonBody table.grid tbody tr').length");
  const head = () => evaluate("(document.querySelector('#seasonBody')?.innerText||'').slice(0,40)");

  const r1 = await rows();
  const m1 = await head();
  console.log('初次进入本季页：rows=' + r1 + ' 首行=' + JSON.stringify(m1));
  await shot('cdp_season.png');

  const openSettings = () => evaluate("document.querySelector('#settingsNav').click()");
  const closeDialog = () => evaluate("document.querySelector('#dlg [data-close]').click()");
  const changeSelect = (id, value) => evaluate(`(function() {
    var select = document.getElementById(${JSON.stringify(id)});
    select.value = ${JSON.stringify(value)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await openSettings();
  await changeSelect('clockSel', '24h');
  await waitFor(() => evaluate("document.querySelector('#clockSel')?.value === '24h' && !document.querySelector('#clockSel').disabled"), '保存排片时制');
  const clock = await evaluate("fetch('/api/settings').then(r=>r.json()).then(s=>s.clock)");
  await closeDialog();
  await waitFor(() => evaluate("!!document.querySelector('#seasonBody [data-seadd]')"), '切换时制后的本季表');
  const r2 = await rows();
  const m2 = await head();
  console.log('切制式后：rows=' + r2 + ' clock=' + clock + ' 首行=' + JSON.stringify(m2));
  await shot('cdp_after_clock.png');

  await evaluate("document.querySelector('.tab[data-tab=today]').click()");
  await waitFor(() => evaluate("!!document.querySelector('#view .show[data-card]')"), '今天番剧卡片');
  await evaluate("document.querySelector('.tab[data-tab=season]').click()");
  await waitFor(() => evaluate("!!document.querySelector('#seasonBody [data-seadd]')"), '切换页签后的本季表');
  const r3 = await rows();
  const m3 = await head();
  console.log('切到今天再切回：rows=' + r3 + ' 首行=' + JSON.stringify(m3));
  await shot('cdp_after_tab.png');

  await openSettings();
  await changeSelect('scaleSel', '1.25');
  await waitFor(() => evaluate("!document.querySelector('#scaleSel').disabled && fetch('/api/settings').then(r=>r.json()).then(s=>s.pet_scale === 1.25)"), '保存桌宠尺寸');
  await closeDialog();
  await waitFor(() => evaluate("!!document.querySelector('#seasonBody [data-seadd]')"), '设置返回本季');
  const r4 = await rows();
  console.log('改桌宠尺寸后：rows=' + r4);

  await evaluate("document.querySelector('.tab[data-tab=today]').click()");
  await evaluate("document.querySelector('#schedule-view-week').click()");
  await waitFor(() => evaluate("!!document.querySelector('.schedule-day')"), '本周排片');
  await shot('cdp_week.png');
  await evaluate(`document.querySelector('.schedule-days [aria-current="date"]').click()`);
  const okView = await evaluate(`document.querySelectorAll('.schedule-days button').length === 7 &&
    document.querySelector('#schedule-view-week[aria-pressed="true"]') !== null &&
    document.activeElement.matches('.schedule-day h3')`);

  // 记一话 / 撤回：走一遍写接口，确认按钮接得上、数字会动
  await evaluate("document.querySelector('.tab[data-tab=today]').click()");
  await waitFor(() => evaluate("!!document.querySelector('.show .ops button[data-op=\"1\"]')"), '记一话按钮');
  // 底部提示条：曾经因为状态类叫 .show，撞上卡片样式（display:grid + 36px 列），
  // 一行只塞得下两个字。这里量行数与宽度，防止再犯。
  const measureToast = () => evaluate(`(function(){
    var el = document.getElementById('toast');
    if (!el || !el.classList.contains('is-up')) return null;
    var cs = getComputedStyle(el), r = el.getBoundingClientRect();
    // 提示条现在是 <span>文字</span><button>撤销</button>，量行数得量 span 里的那个文本节点
    var span = el.querySelector('span');
    var tn = span ? span.firstChild : el.firstChild;
    var text = tn ? tn.textContent : '', lines = 1, prev = null;
    var range = document.createRange();
    if (tn && tn.nodeType === 3) {
      for (var i = 1; i <= text.length; i++) {
        range.setStart(tn, i - 1); range.setEnd(tn, i);
        var top = range.getBoundingClientRect().top;
        if (prev !== null && Math.abs(top - prev) > 1) lines++;
        prev = top;
      }
    }
    return { text: text, lines: lines, width: Math.round(r.width), display: cs.display, hasAct: !!el.querySelector('.act') };
  })()`);

  const statusOf = id => evaluate(`Number(document.querySelector('.show[data-card="${id}"] [data-schedule-seen]')?.dataset.scheduleSeen ?? NaN)`);
  // 先认 id、再读旧值、最后才点——顺序反了会把「点完的值」当成旧值（曾经因此误判 20→20）
  const clicked = await evaluate(`(function(){
    var b = document.querySelector('.show .ops button[data-op="1"]');
    return b ? b.getAttribute('data-id') : 'no-button';
  })()`);
  const before = clicked !== 'no-button' ? await statusOf(clicked) : null;
  if (clicked !== 'no-button') {
    await evaluate(`(function(){
      var b = document.querySelector('.show .ops button[data-op="1"][data-id="${clicked}"]');
      if (b) b.click();
    })()`);
  }
  // 记一话的提示条带「撤销」，趁它还在（5 秒）先量一次
  const bumpToast = await waitFor(async () => {
    const result = await measureToast();
    return result?.hasAct ? result : null;
  }, '记一话和撤销提示');
  const after = clicked && clicked !== 'no-button' ? await statusOf(clicked) : null;
  console.log('记一话：id=' + clicked + ' 已看=' + before + '→' + after +
    (bumpToast ? ' 提示条「' + bumpToast.text + '」撤销=' + bumpToast.hasAct : ''));
  if (clicked && clicked !== 'no-button') {
    await evaluate(`(function(){
      var card = document.querySelector('.show[data-card="${clicked}"]');
      card.querySelector('summary').click();
      card.querySelector('[data-op="-1"]').click();
    })()`);
    await waitFor(() => evaluate("fetch('/api/watch/detail?id=" + clicked + "').then(r=>r.json()).then(r=>r.detail.ep_status === " + before + ")"), '减一话');
  }

  // 本季表行内「+ 追」：点一下就该进在追，并当场变成进度控件
  await evaluate("document.querySelector('.tab[data-tab=season]').click()");
  await waitFor(() => evaluate("!!document.querySelector('#seasonBody [data-seadd]')"), '本季可加入条目');
  const inlineId = await evaluate(`(function(){
    var b = document.querySelector('#seasonBody [data-seadd]');
    if (!b) return 'no-button';
    var id = b.getAttribute('data-seadd');
    b.click();
    return id;
  })()`);
  if (inlineId !== 'no-button') await evaluate("document.querySelector('#joinGo')?.click()");
  const toastInfo = await waitFor(async () => {
    const result = await measureToast();
    return result?.text.startsWith('已加入') ? result : null;
  }, '行内加入提示');
  const inlineAfter = await waitFor(() => evaluate(`(function(){
    var b = document.querySelector('#seasonBody [data-op="1"][data-id="${inlineId}"]');
    return !!b;
  })()`), '加入后出现进度控件');
  if (toastInfo) console.log('提示条：「' + toastInfo.text + '」 ' + toastInfo.lines + ' 行 / 宽 ' + toastInfo.width + 'px / display=' + toastInfo.display + ' / 撤销按钮=' + toastInfo.hasAct);
  console.log('行内追番：id=' + inlineId + ' 变成进度控件=' + inlineAfter);
  await shot('cdp_inline_add.png');
  const okRows = r1 > 0 && [r2, r3, r4].every(count => count === r1) && clock === '24h';
  const okClick = clicked !== 'no-button' && before != null && after === before + 1;
  const okInline = inlineId === '900000003' && inlineAfter === true;
  // 提示条一句话就该是一行；两行以上说明又被别的 display/grid 规则挤扁了
  // display 允许 flex：带「撤销」按钮的提示条是 flex 布局
  const okToast = toastInfo.lines === 1 && /^(block|flex)$/.test(toastInfo.display);

  // 键盘：j 选中 + 空格记一话 + u 撤销。以前这三下只能靠鼠标点，且连点会被 BUSY 丢掉。
  await evaluate("document.querySelector('.tab[data-tab=today]').click()");
  await waitFor(() => evaluate("!document.querySelector('#mask').classList.contains('show') && !!document.querySelector('#view .show[data-card]')"), '键盘操作前的卡片');
  await evaluate(`(function(){
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
  })()`);
  await sleep(200);
  const kbSelected = await evaluate("!!document.querySelector('#view .show.sel[data-card]')");
  const kbId = await evaluate("(function(){var r=document.querySelector('#view .show.sel[data-card]');return r?r.getAttribute('data-card'):null;})()");
  const kbBefore = kbId ? await statusOf(kbId) : null;
  await evaluate(`(function(){
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  })()`);
  await waitFor(async () => kbId && (await statusOf(kbId)) === kbBefore + 1, '键盘记一话');
  const kbAfter = kbId ? await statusOf(kbId) : null;
  await evaluate(`(function(){
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', bubbles: true }));
  })()`);
  await waitFor(async () => kbId && (await statusOf(kbId)) === kbBefore, '键盘撤销');
  const kbUndone = kbId ? await statusOf(kbId) : null;
  console.log('键盘：选中=' + kbSelected + ' id=' + kbId + ' ' + kbBefore + '→' + kbAfter + ' 撤销后=' + kbUndone);

  // 主题偏好与系统最终配色分别校验
  const themeSeq = [];
  const expectedTheme = ['auto', 'dark', 'light'];
  const systemTheme = await evaluate("matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'");
  await openSettings();
  for (const theme of expectedTheme) {
    await changeSelect('themeSel', theme);
    themeSeq.push(await evaluate("[localStorage.getItem('kx.theme'), document.documentElement.dataset.theme]"));
  }
  await waitFor(() => evaluate("!document.querySelector('#toast.is-up')"), '设置截图前提示收起');
  await shot('cdp_settings.png');
  await closeDialog();
  console.log('主题：' + themeSeq.join(' → '));

  // 待看：顶栏按钮在落后时会显示，点开能看到是哪几部
  const pendingText = await evaluate("(function(){var b=document.getElementById('pendingBtn');return b&&!b.hidden?b.textContent.trim():'';})()");
  let pendingOpened = false;
  if (pendingText) {
    await evaluate("document.getElementById('pendingBtn').click()");
    await sleep(400);
    pendingOpened = await evaluate("(function(){var m=document.getElementById('mask');return !!(m&&m.classList.contains('show'));})()");
    await evaluate("(function(){var m=document.getElementById('mask');if(m)m.click();})()");
    await sleep(200);
  }
  console.log('待看：按钮「' + pendingText + '」 弹窗=' + pendingOpened);

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await evaluate('window.scrollTo(0, 0)');
  await waitFor(() => evaluate('innerWidth === 390'), '390px 窄窗');
  const narrow = await evaluate(`(function() {
    var mark = document.querySelector('#schedule-continue-900000001-mark');
    var card = mark.closest('.schedule-entry');
    var box = mark.getBoundingClientRect();
    return { noOverflow: document.documentElement.scrollWidth === innerWidth,
      hitArea: box.width >= 40 && box.height >= 40, watchLink: card.querySelector('.watch-link')?.href === 'https://example.invalid/tiara-demo',
      menuHidden: card.querySelector('.schedule-menu').getBoundingClientRect().width === 0 };
  })()`);
  await evaluate("document.querySelector('#schedule-continue-900000001-more').click()");
  await waitFor(() => evaluate("!!document.querySelector('.schedule-more[open]')"), '窄窗更多操作');
  await shot('cdp_schedule_menu.png');
  await evaluate(`document.querySelector('.schedule-more[open] [data-schedule-episodes]').click()`);
  await waitFor(() => evaluate("!!document.querySelector('#episodeRows .episode-cell')"), '卡片打开每话清单');
  await evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))");
  const narrowBefore = await statusOf('900000001');
  await evaluate("document.querySelector('#schedule-continue-900000001-mark').click()");
  await waitFor(async () => (await statusOf('900000001')) === narrowBefore + 1, '窄窗记一话');
  const sameProgress = await evaluate(`[...document.querySelectorAll('.show[data-card="900000001"] [data-schedule-seen]')]
    .every(node => Number(node.dataset.scheduleSeen) === ${narrowBefore + 1})`);
  await evaluate("document.querySelector('#toast .act').click()");
  await waitFor(async () => (await statusOf('900000001')) === narrowBefore, '窄窗点击撤销');
  const okNarrow = Object.values(narrow).every(Boolean) && sameProgress;
  if (!okNarrow) console.log('窄窗检查：' + JSON.stringify({ ...narrow, sameProgress }));

  const openDetail = async (group, id) => {
    await evaluate(`document.querySelector('#schedule-${group}-${id} .nm-link').click()`);
    await waitFor(() => evaluate("!!document.querySelector('#watchSummary')"), '番剧详情摘要');
  };
  const closeDetail = () => evaluate("document.querySelector('#dlg [data-close]').click()");
  await send('Emulation.clearDeviceMetricsOverride');
  await waitFor(() => evaluate("!document.querySelector('#toast.is-up')"), '撤销提示收起');
  await openDetail('continue', '900000001');
  const summaryOk = await evaluate(`(function() {
    var summary = document.querySelector('#watchSummary');
    return ['观看进度', '播放入口', '下次提醒'].every(label => summary.textContent.includes(label)) &&
      summary.querySelector('a[href="https://example.invalid/tiara-demo"]') !== null &&
      !document.querySelector('.watch-detail-group[open]') &&
      document.activeElement.id === 'dlgTitle' &&
      document.querySelector('#watchSeen').closest('details').id === 'watchProgressGroup' &&
      document.querySelector('#watchTime').closest('details').id === 'watchScheduleGroup' &&
      document.querySelector('#watchUrl').closest('details').id === 'watchAboutGroup';
  })()`);
  await shot('cdp_watch_detail.png');
  await evaluate(`document.querySelector('#dlgTitle').dispatchEvent(new KeyboardEvent('keydown', {key:'Tab', shiftKey:true, bubbles:true}))`);
  const detailFocus = await evaluate("document.activeElement.id === 'watchSave'");
  await evaluate("document.querySelector('[data-watch-section=watchScheduleGroup]').click()");
  const checkTimes = (slot, actual) => evaluate(`(function() {
    var cells = [...document.querySelectorAll('.watch-schedule-facts > div')];
    return document.querySelector('#watchScheduleGroup').open && cells.length === 3 &&
      cells[0].textContent.includes('原播时间') && cells[0].textContent.includes('20:30') &&
      cells[1].textContent.includes('本机排片') && cells[1].textContent.includes('${slot}') &&
      cells[2].textContent.includes('实际提醒时间') && cells[2].querySelector('time')?.textContent.endsWith('${actual}') &&
      cells[2].textContent.includes('提前 15 分钟');
  })()`);
  const timesOk = await checkTimes('22:00', '21:45');
  await shot('cdp_watch_schedule.png');
  await closeDetail();
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await openDetail('continue', '900000001');
  const detailNarrow = await evaluate(`(function() {
    var body = document.querySelector('#dlg > .body');
    var save = document.querySelector('#watchSave').getBoundingClientRect();
    return body.scrollWidth === body.clientWidth && save.bottom <= innerHeight && save.height >= 40;
  })()`);
  await shot('cdp_watch_detail_narrow.png');
  await evaluate(`(function() {
    document.querySelector('#watchName').value = '';
    document.querySelector('#watchSave').click();
  })()`);
  const invalidOpened = await evaluate("document.querySelector('#watchAboutGroup').open && document.activeElement.id === 'watchName'");
  await evaluate(`(function() {
    document.querySelector('#watchName').value = '沿海列车的最后一站';
    document.querySelector('#watchAboutGroup').open = false;
    document.querySelector('[data-watch-section=watchScheduleGroup]').click();
    document.querySelector('#watchTime').value = '22:20';
    document.querySelector('#watchSave').click();
  })()`);
  await waitFor(() => evaluate("document.querySelector('#mask').hidden"), '保存本机排片');
  await openDetail('continue', '900000001');
  await evaluate("document.querySelector('[data-watch-section=watchScheduleGroup]').click()");
  const updatedTimes = await checkTimes('22:20', '22:05');
  await closeDetail();
  await openDetail('today', 'sample-catchup');
  await evaluate("document.querySelector('[data-watch-focus=watchUrl]').click()");
  const linkFocus = await evaluate("document.querySelector('#watchAboutGroup').open && document.activeElement.id === 'watchUrl'");
  await evaluate("document.querySelector('[data-watch-section=watchScheduleGroup]').click()");
  const catchupTimes = await evaluate(`(function() {
    var facts = document.querySelector('.watch-schedule-facts');
    return facts.textContent.includes('暂无原播周档') && facts.textContent.includes('19:15') &&
      facts.querySelector('time')?.textContent.endsWith('19:00') &&
      document.querySelector('#catchupTime').value === '19:15' && document.querySelector('#watchTime').closest('label').hidden;
  })()`);
  await closeDetail();
  const quietSaved = await evaluate(`fetch('/api/settings', { method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ quiet_start: '21:55', quiet_end: '22:10' }) }).then(r => r.ok)`);
  await openDetail('continue', '900000001');
  const quietOk = await evaluate(`(function() {
    var summary = document.querySelector('#watchSummary');
    return summary.querySelector('time')?.textContent.endsWith('22:05') && summary.textContent.includes('免打扰，本次不通知');
  })()`);
  await closeDetail();
  const detailChecks = { summaryOk, detailFocus, timesOk, detailNarrow, invalidOpened, updatedTimes, linkFocus, catchupTimes, quietSaved, quietOk };
  const okDetail = Object.values(detailChecks).every(Boolean);
  if (!okDetail) console.log('详情检查：' + JSON.stringify(detailChecks));

  const useSearch = text => evaluate(`(function() {
    var input = document.getElementById('q');
    input.focus();
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  })()`);
  await waitFor(() => evaluate("!document.querySelector('#toast.is-up')"), '导航截图前提示收起');
  await evaluate("document.querySelector('.tab[data-tab=library]').click()");
  await shot('cdp_library_navigation.png');
  await evaluate("document.querySelector('#watchHistoryBtn').click()");
  await waitFor(() => evaluate("!!document.querySelector('#watchHistoryForm')"), '番库内的观看历史');
  await closeDialog();
  await evaluate("document.querySelector('#watchReportBtn').click()");
  await waitFor(() => evaluate("!!document.querySelector('#weekReportForm')"), '番库内的本地周报');
  await closeDialog();
  await changeSelect('libraryFilter', 'catchup_list');
  const beforeSearch = await evaluate("document.querySelector('#view .library-row').textContent");
  const compositionPreserved = await evaluate(`(function() {
    var input = document.getElementById('q');
    input.value = 'hai';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    return document.querySelector('#globalSearch').hidden && !document.querySelector('#view').hidden;
  })()`);
  await useSearch('海岸终点站');
  const listOnly = await evaluate(`(function() {
    var view = document.querySelector('#view'), results = document.querySelector('#globalSearch');
    return view.hidden && view.getClientRects().length === 0 && !results.hidden &&
      results.querySelectorAll('[data-detail]').length === 1 && results.querySelector('[data-detail]').dataset.detail === '900000001';
  })()`);
  await shot('cdp_search_narrow.png');
  await send('Emulation.clearDeviceMetricsOverride');
  await shot('cdp_global_search.png');
  await evaluate("document.querySelector('#search-show-900000001').focus(); document.querySelector('#search-show-900000001').click()");
  await waitFor(() => evaluate("!!document.querySelector('#watchSummary')"), '搜索结果打开详情');
  await closeDialog();
  const searchFocus = await evaluate("document.activeElement.id === 'search-show-900000001'");
  await evaluate("document.querySelector('#clearSearch').click()");
  const restored = await evaluate(`!document.querySelector('#view').hidden && document.querySelector('#globalSearch').hidden &&
    document.querySelector('#libraryFilter').value === 'catchup_list' &&
    document.querySelector('#view .library-row').textContent === ${JSON.stringify(beforeSearch)}`);
  await evaluate("document.querySelector('.tab[data-tab=season]').click()");
  const seasonCount = await rows();
  await useSearch('离线样例无结果');
  const seasonPreserved = await evaluate(`document.querySelector('#view').hidden &&
    document.querySelector('#globalSearch [role=status]').textContent.includes('0') &&
    document.querySelectorAll('#seasonBody table.grid tbody tr').length === ${seasonCount}`);
  await evaluate("document.querySelector('#q').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  const seasonRestored = await evaluate("!document.querySelector('#view').hidden && document.querySelector('#globalSearch').hidden");
  const expectedSettings = { account: 'Bangumi 账号', migration: '升级与换机', restore: '备份与恢复', sync: '同步 Bangumi' };
  for (const [action, title] of Object.entries(expectedSettings)) {
    await openSettings();
    await evaluate(`document.querySelector('[data-settings-open="${action}"]').click()`);
    await waitFor(() => evaluate(`document.querySelector('#dlgTitle')?.textContent === ${JSON.stringify(title)}`), '设置入口 ' + title);
    await closeDialog();
  }
  const simpleHeader = await evaluate(`[...document.querySelectorAll('#panelHeader .tools button')].map(button => button.textContent).join('|') === '新增|设置' &&
    !document.querySelector('#panelFooter button')`);
  const navChecks = { compositionPreserved, listOnly, searchFocus, restored, seasonPreserved, seasonRestored, simpleHeader };
  const okNavigation = Object.values(navChecks).every(Boolean);
  if (!okNavigation) console.log('导航与搜索检查：' + JSON.stringify(navChecks));

  const migrationPath = path.join(fixture, 'migration-fixture.json');
  const migration = {
    format: 'tiara-migration', schema: 1,
    library: { watching: [{ id: 'local-migration-ui', name: '迁移样例', eps: 12, ep_status: 5 }] },
    settings: { clock: '30h', reminder_lead: 30 },
    desktop: { appearance: { shell: 'master', theme: 1, size: 1, scale: 0.85 } },
    browser: { 'kx.theme': 'dark', 'tiara.home': 'week', 'tiara.compactWeek': '1',
      'tiara.libraryView': { state: 'catchup_list' } },
  };
  fs.writeFileSync(migrationPath, JSON.stringify(migration));
  await openSettings();
  await evaluate("document.querySelector('[data-settings-open=migration]').click()");
  await waitFor(() => evaluate("!!document.querySelector('#migrationFile')"), '打开升级与换机');
  const { root: documentNode } = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: documentNode.nodeId, selector: '#migrationFile' });
  await send('DOM.setFileInputFiles', { nodeId, files: [migrationPath] });
  const previewReady = () => evaluate("!document.querySelector('#migrationApply').disabled");
  await waitFor(previewReady, '预览旧版格式迁移文件');
  const expectedSelection = await evaluate(`document.querySelector('#restoreAppearance').checked &&
    !document.querySelector('#restoreBrowser').checked && localStorage.getItem('kx.theme') === 'light'`);
  await evaluate("document.querySelector('#restoreBrowser').click()");
  await waitFor(previewReady, '预览选中的桌宠和网页偏好');
  await evaluate("document.querySelector('#migrationApply').click()");
  await waitFor(() => evaluate("document.querySelector('#migrationStatus').textContent.includes('导入成功')"), '确认恢复迁移文件');
  const restoredMigration = await evaluate(`(async () => {
    const result = await fetch('/api/migration').then(response => response.json());
    const { library, settings } = result.migration;
    return {
      progress: library.watching.length === 1 && library.watching[0].ep_status === 5,
      settings: settings.clock === '30h' && settings.reminder_lead === 30 && settings.pet_scale === 0.85,
      theme: localStorage.getItem('kx.theme') === 'dark' && document.documentElement.dataset.theme === 'dark',
      home: localStorage.getItem('tiara.home') === 'week' && localStorage.getItem('tiara.compactWeek') === '1',
      libraryView: JSON.parse(localStorage.getItem('tiara.libraryView'))?.state === 'catchup_list',
      browserStatus: document.querySelector('#migrationStatus').textContent.includes('已应用当前浏览器的网页偏好'),
    };
  })()`);
  const okMigration = expectedSelection && Object.values(restoredMigration).every(Boolean);
  if (!okMigration) console.log('迁移检查：' + JSON.stringify({ expectedSelection, ...restoredMigration }));

  const okToastAct = bumpToast.hasAct && bumpToast.lines === 1;
  const okKb = kbSelected && kbBefore != null && kbAfter === kbBefore + 1 && kbUndone === kbBefore;
  const okTheme = themeSeq.every(([preference, effective], i) => preference === expectedTheme[i] &&
    effective === (preference === 'auto' ? systemTheme : preference));
  const okPending = Boolean(pendingText) && pendingOpened;
  const okClean = problems.length === 0;
  if (problems.length) {
    console.log('页面报错 ' + problems.length + ' 条：');
    problems.slice(0, 6).forEach((p) => console.log('  · ' + p.slice(0, 160)));
  }
  const ok = okRows && okView && okClick && okInline && okToast && okToastAct && okKb && okTheme && okPending && okNarrow && okDetail && okNavigation && okMigration && okClean;
  console.log(ok
    ? 'PASS 顶栏 / 设置 / 番库记录 / 独立搜索 / 排片 / 番剧详情 / 390px 窄窗 / 记一话和撤销 / 键盘 / 本季 / 迁移预览与恢复'
    : `FAIL 检查未通过：rows=${okRows} view=${okView} click=${okClick}(${before}→${after}) inline=${okInline}(${inlineId}) toast=${okToast}(${toastInfo ? toastInfo.lines + ' 行/' + toastInfo.width + 'px' : 'n/a'}) toastAct=${okToastAct} kb=${okKb}(${kbBefore}→${kbAfter}→${kbUndone}) theme=${okTheme}(${themeSeq.join(',')}) pending=${okPending} narrow=${okNarrow} detail=${okDetail} navigation=${okNavigation} migration=${okMigration} clean=${okClean}`);

  console.log('截图：' + screenshots);
  sock.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(2);
});

// 兜底：CDP 卡住时别让调用方（和 CI）一直等，2 分钟直接收工。
const watchdog = setTimeout(() => {
  console.error('TIMEOUT 自检超过 120 秒，判失败');
  process.exit(4);
}, 120000);
watchdog.unref();
