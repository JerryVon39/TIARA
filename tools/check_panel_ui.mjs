// 面板交互自检：切制式 / 切页签之后，本季表不能停在「正在读缓存」
// 用 Edge 的 CDP 直接驱动真实浏览器。跑法：node tools/check_panel_ui.mjs
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const CDP_PORT = 9333;
const prof = path.join(root, 'cache', 'cdp_profile_' + Date.now());

/**
 * 面板服务自己起：以前这里写死 `http://127.0.0.1:7788/`，没人在跑 7788 时
 * 页面根本加载不出来，报错是「Cannot read properties of null (reading 'innerText')」——
 * 看着像面板 bug，其实是体检脚本对环境的要求没写出来。
 * 现在自己挑一个空闲端口起服务（显式 --port 不参与单实例探测），跑完关掉。
 */
let APP_PORT = 7860;
let url = '';

async function freePort() {
  for (let p = 7860; p <= 7899; p++) {
    const free = await new Promise((res) => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.once('listening', () => s.close(() => res(true)));
      s.listen(p, '127.0.0.1');
    });
    if (free) return p;
  }
  throw new Error('7860-7899 都被占了，先关掉多余的服务');
}

let serverProc = null;
function stopServer() {
  if (!serverProc) return;
  try { execFileSync('taskkill', ['/PID', String(serverProc.pid), '/T', '/F'], { stdio: 'ignore' }); }
  catch (e) { /* 已经退了 */ }
  serverProc = null;
}

async function startServer() {
  APP_PORT = await freePort();
  url = `http://127.0.0.1:${APP_PORT}/?tab=season`;
  serverProc = spawn(process.execPath, [path.join(root, 'server.mjs'), '--port', String(APP_PORT), '--no-portfile'], {
    cwd: root, stdio: 'ignore', detached: false,
  });
  for (let i = 0; i < 80; i++) {
    await sleep(150);
    try {
      const r = await fetch(`http://127.0.0.1:${APP_PORT}/api/health`);
      const j = await r.json();
      if (j && j.app === 'tiara') return;
    } catch (e) { /* 还没起来 */ }
  }
  throw new Error(`面板服务没起来（端口 ${APP_PORT}）——先在项目根跑一次 node server.mjs 看报错`);
}

// 自检会真的点「+ 追 / 记一话 / 切制式 / 改尺寸」，跑完必须把文件和设置都放回去，
// 否则用户数据被测试污染（上一版就把 clock 留在 24h、把测试条目留在库里）。
const TOUCHED = ['data/library.json', 'data/settings.json'];
const before = new Map();
for (const rel of TOUCHED) {
  const p = path.join(root, rel);
  before.set(rel, fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
}
function restoreFiles() {
  let dirty = false;
  for (const [rel, old] of before) {
    if (old == null) continue;
    const p = path.join(root, rel);
    try {
      if (fs.readFileSync(p, 'utf8') !== old) {
        fs.writeFileSync(p, old, 'utf8');
        dirty = true;
        console.log('已把 ' + rel + ' 还原成跑之前的样子');
      }
    } catch (e) { /* ignore */ }
  }
  // 库被还原了，但 today.txt / words.txt / basis.dic 还是测试期间生成的版本。
  // 不重算就留下一份「跟库对不上」的产物，下次桌宠读到会念错数。
  if (dirty) {
    for (const tool of ['build_today.mjs', 'build_ghost.mjs', 'build_yaya.mjs']) {
      try { execFileSync(process.execPath, [path.join(root, 'tools', tool)], { cwd: root, stdio: 'ignore' }); }
      catch (e) { console.log('产物重算失败：' + tool + '（' + e.message + '）'); }
    }
  }
}
process.on('exit', restoreFiles);
process.on('exit', stopServer);

const child = spawn(edge, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--remote-debugging-port=' + CDP_PORT,
  '--user-data-dir=' + prof,
  '--window-size=1400,1000',
  'about:blank'
], { stdio: 'ignore', detached: true });

/** Windows 上 Edge 会派生子进程，只 kill 父进程烧不干净，连调试端口一起带走。 */
function killEdge() {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch (e) { /* 已经没了 */ }
}
process.on('exit', killEdge);

/**
 * 走之前把这个临时 profile 删掉：一次 50–60 MB，忘了删几天就是几百 MB
 * （体检时 cache/ 里躺着 6 个 cdp_profile_*，合计 313 MB）。
 * 放在 exit 里做，边缘情况（中途 exit(1)）也能清。
 */
function dropProfile() {
  try {
    if (fs.existsSync(prof)) fs.rmSync(prof, { recursive: true, force: true });
  } catch (e) { /* 被占用就下次 clean_cache 收 */ }
}
process.on('exit', dropProfile);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let ws = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const r = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list');
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
    fs.writeFileSync(path.join(root, 'cache', 'audit', name), Buffer.from(r.data, 'base64'));
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

  await startServer();
  await send('Page.navigate', { url });
  await sleep(4500);

  const rows = () => evaluate("document.querySelectorAll('#seasonBody table.grid tbody tr').length");
  const head = () => evaluate("(document.querySelector('#seasonBody').innerText||'').slice(0,40)");

  const r1 = await rows();
  const m1 = await head();
  console.log('初次进入本季页：rows=' + r1 + ' 首行=' + JSON.stringify(m1));
  await shot('cdp_season.png');

  await evaluate("document.querySelector('#clockBtn').click()");
  await sleep(1400);
  const r2 = await rows();
  const m2 = await head();
  const clock = await evaluate("document.querySelector('#clockBtn').textContent");
  console.log('切制式后：rows=' + r2 + ' clock=' + clock + ' 首行=' + JSON.stringify(m2));
  await shot('cdp_after_clock.png');

  await evaluate("document.querySelector('.tab[data-tab=today]').click()");
  await sleep(700);
  await evaluate("document.querySelector('.tab[data-tab=season]').click()");
  await sleep(1400);
  const r3 = await rows();
  const m3 = await head();
  console.log('切到今天再切回：rows=' + r3 + ' 首行=' + JSON.stringify(m3));
  await shot('cdp_after_tab.png');

  await evaluate("var s=document.querySelector('#scaleSel');s.value='1';s.dispatchEvent(new Event('change'))");
  await sleep(1400);
  const r4 = await rows();
  console.log('改桌宠尺寸后：rows=' + r4);

  // 本周页：七列都在、今天那列有标记
  await evaluate("document.querySelector('.tab[data-tab=week]').click()");
  await sleep(900);
  const cols = await evaluate("document.querySelectorAll('#view .dcol').length");
  const todayCol = await evaluate("document.querySelectorAll('#view .dcol.today').length");
  console.log('本周页：列=' + cols + ' 今天列=' + todayCol);
  await shot('cdp_week.png');

  // 记一话 / 撤回：走一遍写接口，确认按钮接得上、数字会动
  // 先整页 reload：脚本可能刚还原过 library.json，页面里还是上一轮的旧数，
  // 不刷新会把「本来就一致」误判成「点了没变」。
  await evaluate("location.reload()");
  await sleep(2600);
  await evaluate("document.querySelector('.tab[data-tab=today]').click()");
  await sleep(800);
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

  const statusOf = (id) => evaluate(`(function(){
    var b = document.querySelector('.show .ops button[data-id="${id}"]');
    if (!b) return null;
    var card = b.closest('.show');
    var m = (card.innerText || '').match(/(\\d+)\\/(\\d+)/);
    return m ? Number(m[1]) : null;
  })()`);
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
  await sleep(700);
  const bumpToast = await measureToast();
  await sleep(1800);
  const after = clicked && clicked !== 'no-button' ? await statusOf(clicked) : null;
  console.log('记一话：id=' + clicked + ' 已看=' + before + '→' + after +
    (bumpToast ? ' 提示条「' + bumpToast.text + '」撤销=' + bumpToast.hasAct : ''));
  if (clicked && clicked !== 'no-button') {
    await evaluate(`(function(){
      var b = document.querySelector('.show .ops button[data-op="-1"]');
      if (b) b.click();
    })()`);
    await sleep(2200);
  }

  // 本季表行内「+ 追」：点一下就该进在追，并当场变成进度控件
  await evaluate("document.querySelector('.tab[data-tab=season]').click()");
  await sleep(1500);
  const inlineId = await evaluate(`(function(){
    var b = document.querySelector('#seasonBody [data-seadd]');
    if (!b) return 'no-button';
    var id = b.getAttribute('data-seadd');
    b.click();
    return id;
  })()`);
  // 点完 0.8 秒内先量提示条（它 2.2 秒后自己淡出），再去确认那一行已经变成进度控件
  await sleep(800);
  const toastInfo = await measureToast();
  await sleep(2200);
  const inlineAfter = inlineId === 'no-button' ? null : await evaluate(`(function(){
    var b = document.querySelector('#seasonBody [data-op="1"][data-id="${inlineId}"]');
    return !!b;
  })()`);
  if (toastInfo) console.log('提示条：「' + toastInfo.text + '」 ' + toastInfo.lines + ' 行 / 宽 ' + toastInfo.width + 'px / display=' + toastInfo.display + ' / 撤销按钮=' + toastInfo.hasAct);
  console.log('行内追番：id=' + inlineId + ' 变成进度控件=' + inlineAfter);
  await shot('cdp_inline_add.png');
  if (inlineAfter) {
    await evaluate(`(function(){
      var b = document.querySelector('#seasonBody [data-op="remove"][data-id="${inlineId}"]');
      if (b) b.click();
    })()`);
    await sleep(2600);
  }

  const okRows = r1 > 5 && r2 > 5 && r3 > 5 && r4 > 5;
  const okView = cols === 7 && todayCol === 1;
  const okClick = clicked === 'no-button' || (before != null && after === before + 1);
  const okInline = inlineId === 'no-button' || inlineAfter === true;
  // 提示条一句话就该是一行；两行以上说明又被别的 display/grid 规则挤扁了
  // display 允许 flex：带「撤销」按钮的提示条是 flex 布局
  const okToast = !toastInfo ||
    (toastInfo.lines === 1 && toastInfo.width >= 120 && /^(block|flex)$/.test(toastInfo.display));

  // 键盘：j 选中 + 空格记一话 + u 撤销。以前这三下只能靠鼠标点，且连点会被 BUSY 丢掉。
  await evaluate("document.querySelector('.tab[data-tab=today]').click()");
  await sleep(700);
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
  await sleep(1800);
  const kbAfter = kbId ? await statusOf(kbId) : null;
  await evaluate(`(function(){
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', bubbles: true }));
  })()`);
  await sleep(1600);
  const kbUndone = kbId ? await statusOf(kbId) : null;
  console.log('键盘：选中=' + kbSelected + ' id=' + kbId + ' ' + kbBefore + '→' + kbAfter + ' 撤销后=' + kbUndone);

  // 主题切换：暗 → 亮 → 自动 → 暗
  const themeSeq = [];
  for (let i = 0; i < 3; i++) {
    await evaluate("document.getElementById('themeBtn').click()");
    await sleep(120);
    themeSeq.push(await evaluate("document.documentElement.getAttribute('data-theme') || 'auto'"));
  }
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

  const okToastAct = !bumpToast || bumpToast.hasAct === true;
  const okKb = !kbId || (kbSelected && kbBefore != null && kbAfter === kbBefore + 1 && kbUndone === kbBefore);
  const okTheme = themeSeq.every((t, i) => t === ['light', 'auto', 'dark'][i]);
  const okPending = !pendingText || pendingOpened;
  const okClean = problems.length === 0;
  if (problems.length) {
    console.log('页面报错 ' + problems.length + ' 条：');
    problems.slice(0, 6).forEach((p) => console.log('  · ' + p.slice(0, 160)));
  }
  const ok = okRows && okView && okClick && okInline && okToast && okToastAct && okKb && okTheme &&
    okPending && okClean && !/正在读/.test(m2 + m3);
  console.log(ok
    ? 'PASS 切制式 / 切页签 / 改尺寸 / 本周七列 / 记一话 / 行内追番 / 提示条一行+撤销 / 键盘 / 主题 / 待看 / 无页面报错'
    : `FAIL 检查未通过：rows=${okRows} view=${okView} click=${okClick}(${before}→${after}) inline=${okInline}(${inlineId}) toast=${okToast}(${toastInfo ? toastInfo.lines + ' 行/' + toastInfo.width + 'px' : 'n/a'}) toastAct=${okToastAct} kb=${okKb}(${kbBefore}→${kbAfter}→${kbUndone}) theme=${okTheme}(${themeSeq.join(',')}) pending=${okPending} clean=${okClean}`);

  sock.close();
  killEdge();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('ERR', e.message);
  killEdge();
  process.exit(2);
});

// 兜底：CDP 卡住时别让调用方（和 CI）一直等，2 分钟直接收工。
const watchdog = setTimeout(() => {
  console.error('TIMEOUT 自检超过 120 秒，判失败');
  killEdge();
  process.exit(4);
}, 120000);
watchdog.unref();
