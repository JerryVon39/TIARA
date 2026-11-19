/* TIARA 面板脚本（从 index.html 拆出，v0.26.1）。
 * 经典脚本：桌宠在没有服务时会用 file:// 打开面板，type="module" 会被 CORS 拦死。
 */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var CN = ['', '一', '二', '三', '四', '五', '六', '日'];
  var WEEK_ORDER = [1, 2, 3, 4, 5, 6, 7];
  var VIEWS = ['week', 'today', 'season', 'library', 'catchup', 'continue'];
  var WATCH_STATE_LABEL = { watching: '在追', paused: '已暂停', finished: '已看完', archived: '已归档', catchup: '补番中', planned: '待看', dropped: '已弃番', removed: '已移除' };
  var LIBRARY_STATES = { watching: '在追', catchup_list: '补番中', planned: '待看', paused: '已暂停', finished: '已看完', archived: '已归档', dropped: '已弃番', removed: '已移除' };
  var libraryFilter = '', searchFilter = '', searchLimit = 8;
  var searchScroll = 0, searchViewDirty = false;
  var libraryBatch = false;
  var libraryView = { year: '', tag: '', link: '' }, savedLibraryViews = {};
  var compactWeek = false, homeView = '';

  var STATE = null;
  var STATS = null;
  var IMAGES = {};
  var missingCovers = new Map();
  var coverVersions = new Map();
  var TAB = 'today';
  /** ?welcome=1 时强制给一遍新手引导（老用户想复习时用） */
  var WELCOME_FORCE = false;
  var QUERY = '';
  var CLOCK = '30h';
  var WEEK_ALL = false;
  var BUSY = false;
  /** 键盘当前选中的卡片。同一番剧可以出现在不同分组。 */
  var SEL = null;
  var SEASON = null;
  var SEASON_MARK = {};
  var SEASON_Q = '';
  var SEASON_ERR = '';
  var seasonRequest = 0;
  var ORIGINAL = {};
  var originalRequest = null;
  var originalKey = '';
  var originalAt = 0;
  var originalWarning = '';
  /** 本季筛选条件（放在这里，refresh 重绘后不会被 reset） */
  var SEASON_FILTER = { onlyTv: true, hideWatching: false, onlyTodo: false, sortBy: 'weekday' };
  var COVER = { sm: [28, 38], md: [36, 48], lg: [46, 62], xl: [58, 78] };
  var coverSize = 'md';

  // ---------------- 工具 ----------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function enc(s) { return encodeURIComponent(String(s == null ? '' : s)); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function watchGap(w, expected) {
    var end = num(expected), prefix = Math.max(num(w.ep_status), num(w.start_episode) - 1);
    var extras = (w.episode_extras || []).filter(function (n) { return n > prefix && n <= end; }).length;
    return Math.max(0, end - prefix - extras);
  }

  /** 总话数在最近 3 天内变多 → 显示「新」（同步时 lib/bgm.mjs 写的 eps_updated_at） */
  function isFresh(w) {
    if (!w || !w.eps_updated_at) return false;
    var t = Date.parse(String(w.eps_updated_at) + 'T00:00:00+08:00');
    return isFinite(t) && Date.now() - t < 3 * 86400e3;
  }

  /** 在 STATE.watching 里找一条（乐观更新要就地改它，别整页重绘） */
  function findWatch(id) {
    var list = STATE ? (STATE.watching || []).concat(STATE.catchup_list || []) : [];
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
    return null;
  }
  function json(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        j = j || {};
        if (!r.ok) {
          // 服务端 4xx/5xx 只回 {error}；这里补上 ok:false，调用方就能只认一种形状
          j.ok = false;
          throw Object.assign(new Error(j.error || ('HTTP ' + r.status)), { body: j, status: r.status });
        }
        return j;
      });
    });
  }
  var POST_CHAIN = Promise.resolve();
  var LAST_WRITE = null;
  var panelRevision = null, revisionCheck = null;
  var tabs = typeof BroadcastChannel === 'function' ? new BroadcastChannel('tiara-library') : null;
  if (tabs) tabs.onmessage = function () { if (!document.hidden) checkPanelRevision(); };
  function post(url, body) {
    // 所有页面写入按触发顺序提交，撤销不能越过尚在等待的记账。
    if (url !== '/api/progress') flushAllBumps();
    var run = POST_CHAIN.then(function () {
      if (url === '/api/undo' && !body.expected_revision && LAST_WRITE && ['/api/progress', '/api/watch/detail', '/api/watch/lifecycle', '/api/watch/schedule'].indexOf(LAST_WRITE.url) >= 0) {
        if (!LAST_WRITE.result || !LAST_WRITE.result.changed) return { ok: false, error: '刚才没有写入新改动，无需撤销' };
        body = Object.assign({}, body, { expected_revision: LAST_WRITE.result.revision });
      }
      return sendPost(url, body).then(function (j) {
        LAST_WRITE = { url: url, result: j };
        if (tabs && j.ok && (j.changed || j.revision || j.undone)) tabs.postMessage('change');
        return j;
      }, function (e) { LAST_WRITE = { url: url, result: null }; throw e; });
    });
    POST_CHAIN = run.catch(function () {});
    return run;
  }
  function sendPost(url, body) {
    return fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return { ok: r.ok }; }).then(function (j) {
        j = j || {};
        // 双保险：即使服务端这次没给 ok 字段，HTTP 状态也能说明失败
        if (!r.ok) j.ok = false;
        Object.defineProperty(j, 'httpStatus', { value: r.status });
        // 服务端重建失败时以前是静默的：数据写进去了、页面也顺，但 today.txt 没动。
        if (j.rebuild_error) toast('改了库，但 ' + j.rebuild_error);
        return j;
      });
    });
  }
  function q() { return QUERY.normalize('NFKC').trim().toLowerCase(); }
  function matchLibrary(item, words) {
    var hay = [item.name_cn, item.name, item.original_name, item.id, item.priority, item.alias, item.tags, item.user_details?.tags]
      .flat().join(' ').normalize('NFKC').toLowerCase();
    return words.every(function (word) { return hay.includes(word); });
  }
  /** 本季表「算 TV」的口径：写了平台看平台，没写就按话数猜。过滤与「全选」共用它，别各写一套。 */
  function tvLike(x) {
    var p = String(x.platform || '');
    if (p) return p === 'TV';
    return num(x.eps) > 1;
  }
  var toastTimer = null;
  /**
   * 底部提示条。action 给了就带一个按钮（例如「撤销」）：
   *   toast('记了一话', { label: '撤销', fn: undo })
   * 记录类操作一律带撤销——误点一下不该去翻备份。
   */
  function toast(msg, action) {
    var el = $('#toast');
    el.innerHTML = '';
    var span = document.createElement('span');
    span.textContent = msg;
    el.appendChild(span);
    (action ? [].concat(action) : []).forEach(function (item) {
      var b = document.createElement('button');
      b.className = 'act';
      b.type = 'button';
      b.textContent = item.label || '撤销';
      b.addEventListener('click', function () {
        el.classList.remove('is-up');
        item.fn();
      });
      el.appendChild(b);
    });
    el.classList.add('is-up');
    clearTimeout(toastTimer);
    // 带操作的停留久一点（点得到），纯提示 2.2 秒
    toastTimer = setTimeout(function () { el.classList.remove('is-up'); }, action ? 5000 : 2200);
  }

  /** 撤销最近一次写库（服务端 data/undo 栈） */
  function undo(revision) {
    post('/api/undo', { expected_revision: revision }).then(function (j) {
      if (j.ok === false || j.error) return toast(j.error || '没得撤销了');
      toast('已撤销');
      refresh();
    }).catch(function () { toast('服务没响应'); });
  }

  /** 30h/24h 折算：凌晨 5 点前算前一天 */
  function dispShow(time, weekday) {
    if (!time) return { time: '', wd: weekday || 0 };
    if (CLOCK !== '30h') return { time: time, wd: weekday || 0 };
    var m = /^(\d{1,2}):(\d{2})$/.exec(time);
    if (!m) return { time: time, wd: weekday || 0 };
    var h = Number(m[1]);
    if (h >= 5) return { time: time, wd: weekday || 0 };
    var wd = weekday ? (weekday === 1 ? 7 : weekday - 1) : 0;
    return { time: String(h + 24) + ':' + m[2], wd: wd };
  }
  /** 封面尺寸：小 / 中 / 大 / 特大（记在 localStorage） */
  function setCover(key) {
    coverSize = Object.hasOwn(COVER, key) ? key : 'md';
    var size = COVER[coverSize];
    document.documentElement.style.setProperty('--cv-w', size[0] + 'px');
    document.documentElement.style.setProperty('--cv-h', size[1] + 'px');
    try { localStorage.setItem('kx.cover', coverSize); } catch (e) {}
  }

  /**
   * 封面：一律走本机 /cover/<id>.jpg。
   *
   * 以前直接用 IMAGES[id] 的远端地址，问题是：
   *   1. `lain.bgm.tv` 不走服务端——浏览器没有代理就全白（实测直连 24 张 0 成功）；
   *   2. `images` 里只有「今天 / 本周 / 在追」这十几条，本季表 167 条压根没有地址；
   *   3. 一屏 100+ 张、单域名 6 条连接，平均 1.3 秒/张，滚到哪儿哪儿是空白。
   * 现在统一由服务端取一次落盘（data/covers/），浏览器拿本机图；没有图的条目退化成首字方块。
   */
  function cover(id, name) {
    var ch = Array.from(String(name || '?').trim())[0] || '?';
    var sid = String(id == null ? '' : id);
    if (!/^\d{1,10}$/.test(sid) || Date.now() - (missingCovers.get(sid) || 0) < 600000) return '<span class="cover">' + esc(ch) + '</span>';
    var version = coverVersions.get(sid);
    return '<span class="cover"><img loading="lazy" src="/cover/' + enc(sid) + '.jpg' +
      (version ? '?v=' + version : '') + '" alt="" data-cover-id="' + sid + '" data-ch="' + esc(ch) + '" /></span>';
  }
  /**
   * 封面加载失败 → 换成首字方块。
   * 以前写成 onerror="…textContent='<首字>'"：名字以 ' 开头时会把内联 JS 的字符串截断（SyntaxError），
   * 现在改成全局捕获阶段监听，不再把数据拼进代码。
   */
  document.addEventListener('error', function (e) {
    var img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.parentNode) return;
    if (String(img.parentNode.className || '').indexOf('cover') < 0) return;
    var id = img.getAttribute('data-cover-id');
    if (id) missingCovers.set(id, Date.now());
    img.parentNode.textContent = img.getAttribute('data-ch') || '?';
  }, true);

  // ---------------- 数据 ----------------
  function showNetbar(msg) {
    var bar = $('#netbar');
    if (!bar) return;
    var t = $('#netbarText');
    if (t) t.textContent = msg;
    bar.hidden = false;
  }
  function hideNetbar() {
    var bar = $('#netbar');
    if (bar) bar.hidden = true;
  }
  /**
   * 连不上服务：顶栏给一条可重试的提示条，别把已经渲染好的页面整块换掉。
   * 端口从 /api/health 取（服务可能回退到 7789/7790），拿不到就不提端口。
   */
  function offlineNote(e) {
    var msg = '连不上本机 TIARA 后台。请打开桌宠或「打开番组表.bat」，然后重试。';
    showNetbar(msg + '　点右边「重试」');
    return fetch('/api/health', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (h) { if (h && h.port) showNetbar(msg + '　服务端口 ' + h.port + '，点「重试」再连一次'); })
      .catch(function () {});
  }

  function refresh() {
    return Promise.all([json('/api/state'), json('/api/stats').catch(function () { return null; })])
      .then(function (arr) {
        if (Object.keys(OUTSTANDING).some(function (id) { return OUTSTANDING[id]; })) return;
        STATE = arr[0];
        STATS = arr[1];
        IMAGES = (STATE && STATE.images) || {};
        CLOCK = STATE.settings?.clock || '30h';
        hideNetbar();
        $('#footHint').textContent = 'TIARA · 本地番库 · 在追 ' + num(STATE.watching_count) + ' 部';
        render();
        loadOriginal();
      })
      .catch(function (e) {
        if (STATE) return offlineNote(e);   // 已经有内容：只提示，不拆页面
        showNetbar('连不上本地服务：' + (e.message || '网络错误'));
        $('#view').innerHTML = '<div class="panel"><div class="empty">读不到本地服务：' + esc(e.message) +
          '<br /><br />先跑 <b>node server.mjs --port 7788</b>，或用「打开番组表.bat」。<br />' +
          '起好服务后点上面的「重试」。</div></div>';
      });
  }

  function checkPanelRevision() {
    if (document.hidden || revisionCheck) return;
    revisionCheck = json('/api/panel-revision').then(function (result) {
      var key = result.version + ':' + result.revision;
      if (key !== panelRevision) {
        panelRevision = key;
        return refresh();
      }
    }).catch(offlineNote).finally(function () { revisionCheck = null; });
  }

  function loadOriginal() {
    var ids = new Set((STATE.watching || []).map(function (w) { return String(w.id); }));
    Object.values(STATE.weekly || {}).forEach(function (rows) {
      rows.forEach(function (row) { ids.add(String(row.id)); });
    });
    var key = Array.from(ids).filter(function (id) { return /^\d+$/.test(id); }).sort().join(',');
    if (!key || originalRequest || (key === originalKey && Date.now() - originalAt < 10 * 60 * 1000)) return;
    originalRequest = json('/api/schedule/original').then(function (result) {
      ORIGINAL = result.airings || {};
      originalKey = key;
      originalAt = Date.now();
      originalWarning = '';
      if ((TAB === 'week' || TAB === 'today') && !$('#view').contains(document.activeElement)) render();
    }).catch(function (error) {
      originalWarning = scheduleErrorText(error);
    }).finally(function () {
      originalRequest = null;
      var warning = $('#weekScheduleStatus');
      if (warning) warning.textContent = originalWarning;
      var originalLabel = $('#watchOriginal');
      if (originalLabel) originalLabel.textContent = watchOriginalText(originalLabel.dataset.id, originalLabel.dataset.cachedOriginal);
    });
  }

  // ---------------- 渲染 ----------------
  function activeNav(tab) {
    return TAB === tab || tab === 'today' && (TAB === 'week' || TAB === 'continue');
  }

  function switchTab(to) {
    if (VIEWS.indexOf(to) < 0) return;
    if ($('#q').value || q()) setLibrarySearch('', false);
    TAB = to;
    try { localStorage.setItem('kx.tab', TAB); } catch (e) {}
    document.querySelectorAll('.tab').forEach(function (x) {
      var active = activeNav(x.dataset.tab);
      x.classList.toggle('on', active);
      if (active) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current');
    });
    render();
    if (to === 'season' && !SEASON) loadSeason(false);
    window.scrollTo(0, 0);
  }

  function render() {
    if (!STATE) return;
    if (q()) {
      searchViewDirty = true;
      renderLibrarySearch();
      return;
    }
    searchViewDirty = false;
    var v = $('#view');
    // 整体重绘会把焦点丢到 body：记住当前焦点控件的 id，画完还回去
    var focusId = document.activeElement && document.activeElement.id;
    if (TAB === 'week' || TAB === 'today') v.innerHTML = viewSchedule(TAB === 'week');
    else if (TAB === 'library') v.innerHTML = viewLibrary();
    else if (TAB === 'catchup') v.innerHTML = viewCatchup();
    else if (TAB === 'continue') v.innerHTML = '<div class="schedule-view">' + viewContinueWatching() +
      '<button data-goto="today">查看我的排片</button></div>';
    else v.innerHTML = viewSeason();
    bind();
    paintPending();
    if (focusId) {
      var again = document.getElementById(focusId);
      if (again && again.focus && again !== document.activeElement) {
        try { again.focus({ preventScroll: true }); } catch (e) { again.focus(); }
      }
    }
  }

  function scheduleProgress(w) {
    var seen = num(w.ep_status), total = num(w.eps), start = Math.max(1, num(w.start_episode));
    var extras = w.episode_extras || [];
    var count = Math.max(0, seen - start + 1) + extras.length;
    var complete = total > 0 && !watchGap(w, total);
    var behind = w.watch_mode !== 'catchup' ? watchGap(w, w.expected_eps) : 0;
    var progress = start > 1 || extras.length ? '已记 ' + count + ' 集' + (seen >= start ? ' · 连续至第 ' + seen + ' 集' : '') :
      '已看 ' + seen + (total ? ' / ' + total : '') + ' 集';
    if (behind && !complete) progress += ' · 落后 ' + behind + ' 集';
    else if (!complete && w.watch_mode !== 'catchup' && num(w.expected_eps) > 0) progress += ' · 已追平';
    return { seen: seen, next: complete ? '已看完' : '下一集 · 第 ' + Math.max(seen + 1, start) + ' 集',
      text: progress, complete: complete, canRewind: count > 0 };
  }

  function showCard(x, group) {
    var id = String(x.id), entry = x.entry, progress = entry && scheduleProgress(entry);
    var controlId = 'schedule-' + group + '-' + enc(id);
    var bangumi = /^[1-9]\d{0,9}$/.test(id) ?
      '<a href="https://bgm.tv/subject/' + id + '" target="_blank" rel="noopener noreferrer">Bangumi 条目 ↗</a>' : '';
    var ops = entry ? watchLink(entry.watch_url, x.name) +
      '<button type="button" class="schedule-mark" id="' + controlId + '-mark" data-op="1" data-id="' + esc(id) + '"' +
      (progress.complete ? ' aria-disabled="true"' : '') + '>记一话</button>' +
      '<details class="schedule-more"><summary id="' + controlId + '-more" aria-label="《' + esc(x.name) + '》的更多操作">···</summary>' +
      '<div class="schedule-menu"><button type="button" data-schedule-episodes="' + esc(id) + '">每话清单</button>' +
      '<button type="button" data-op="-1" data-id="' + esc(id) + '"' + (progress.canRewind ? '' : ' disabled') + '>退回一话</button>' +
      bangumi + '<button type="button" class="schedule-remove" data-op="remove" data-id="' + esc(id) + '">移除条目</button></div></details>' :
      '<button type="button" data-add="' + esc(id) + '" data-name="' + esc(x.name) + '">加入在追</button>';
    var label = [x.label, entry?.priority].filter(function (text) { return text && text !== '—'; }).join(' · ');
    return '<article id="' + controlId + '" class="show schedule-entry' + (entry && SEL === controlId ? ' sel' : '') + '"' +
      (entry ? ' data-card="' + esc(id) + '"' : '') + '>' + cover(id, x.name) +
      '<div class="schedule-info">' +
      (x.time || label ? '<div class="schedule-slot">' + (x.time ? '<b>' + esc(x.time) + '</b>' : '') +
        (label ? '<span>' + esc(label) + '</span>' : '') + '</div>' : '') +
      '<h4 class="schedule-name" title="' + esc(x.name) + '">' + (entry ? watchTitle(id, x.name, true) : (bangumi ?
        '<a href="https://bgm.tv/subject/' + id + '" target="_blank" rel="noopener noreferrer">' + esc(x.name) + ' ↗</a>' : esc(x.name))) +
      '</h4>' + (progress ? '<div class="schedule-progress"><strong data-schedule-next>' + esc(progress.next) +
        '</strong><span data-schedule-seen="' + progress.seen + '">' + esc(progress.text) + '</span>' +
        (isFresh(entry) ? '<span class="schedule-fresh">总集数更新</span>' : '') + '</div>' : '') +
      '</div><div class="ops schedule-actions">' + ops + '</div></article>';
  }

  function closeScheduleMenu(menu, restoreFocus) {
    if (!menu?.open) return;
    menu.open = false;
    if (restoreFocus) $('summary', menu).focus({ preventScroll: true });
  }

  function watchTitle(id, name, editable, controlId) {
    if (!editable) return esc(name);
    return '<button type="button" class="nm-link" data-detail="' + esc(id) + '"' +
      (controlId ? ' id="' + esc(controlId) + '"' : '') + ' aria-label="打开《' + esc(name) + '》详情">' + esc(name) + '</button>';
  }

  function watchLink(value, name, platform) {
    if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\//i.test(value) || /[\s\\\x00-\x1f\x7f]/.test(value)) return '';
    try {
      var url = new URL(value);
      if (!url.hostname || url.username || url.password || url.href.length > 2048) return '';
      return '<a class="watch-link" href="' + esc(url.href) + '" target="_blank" rel="noopener noreferrer" aria-label="打开《' +
        esc(name) + '》的观看链接">' + esc(platform || '去观看') + ' ↗</a>';
    } catch (e) { return ''; }
  }

  function viewLibrary() {
    var all = Object.keys(LIBRARY_STATES).flatMap(function (state) { return STATE[state] || []; });
    var yearOf = function (w) { return String(w.user_details?.year || (/^\d{4}/.exec(w.release_date || w.start_date || '') || [])[0] || ''); };
    var years = [...new Set(all.map(yearOf).filter(Boolean))].sort().reverse();
    var tags = [...new Set(all.flatMap(function (w) { return w.user_details?.tags || []; }))].sort();
    function options(items, current) {
      return '<option value="">全部</option>' + items.map(function (item) {
        return '<option' + (item === current ? ' selected' : '') + '>' + esc(item) + '</option>';
      }).join('');
    }
    function section(state, title, empty) {
      var entries = (STATE[state] || []).filter(function (w) {
        return (!libraryView.year || yearOf(w) === libraryView.year) &&
          (!libraryView.tag || (w.user_details?.tags || []).includes(libraryView.tag)) &&
          (!libraryView.link || Boolean(watchLink(w.watch_url, '')) === (libraryView.link === 'yes'));
      });
      var rows = entries.map(function (w) {
        var name = w.name_cn || w.name || String(w.id);
        var progress = w.episode_extras?.length ? (num(w.watched_count) || Math.max(0, num(w.ep_status) - Math.max(0, num(w.start_episode) - 1)) + w.episode_extras.length) +
          ' 集 · 连续至第 ' + num(w.ep_status) + ' 集' : num(w.ep_status) + '/' + (num(w.eps) || '?');
        return '<div class="trow library-row">' +
          '<div class="tn"><div class="nm">' +
          (libraryBatch ? '<input type="checkbox" data-library-pick value="' + esc(w.id) + '" aria-label="选中 ' + esc(name) + '">' : '') +
          watchTitle(w.id, name, true) + '</div>' +
          '<small>' + (state === 'planned' ? (w.eps ? '共 ' + esc(w.eps) + ' 集' : '集数待定') : '已看 ' + esc(progress)) + '</small>' +
          (w.user_details?.tags || []).map(function (tag) {
            return '<span class="tag mut">' + esc(tag) + '</span>';
          }).join('') + watchLink(w.watch_url, name) + '</div>' +
          (state === 'finished' ? '<button type="button" data-archive="' + esc(w.id) + '">归档</button>' :
            state === 'paused' || state === 'archived' ? '<button type="button" data-resume="' + esc(w.id) + '">' +
            (state === 'archived' ? '取消归档' : '继续观看') + '</button>' : '') + '</div>';
      }).join('');
      return '<section class="panel"><div class="ph">' + title + '<span class="count">' + entries.length + '</span></div>' +
        '<div class="pb">' + (rows || '<div class="empty">' + empty + '</div>') + '</div></section>';
    }
    var keys = libraryFilter ? [libraryFilter] : Object.keys(LIBRARY_STATES).filter(function (key) {
      return key !== 'removed' || (STATE.removed || []).length;
    });
    return '<div class="sec"><div class="sec-head library-page-heading"><h2>番剧库</h2><div class="library-records" aria-label="观看记录">' +
      '<button type="button" id="watchHistoryBtn">观看历史</button><button type="button" id="watchReportBtn">本地周报</button></div></div>' +
      '<div class="fbar library-tools">' +
      '<button type="button" id="libraryCsv">导入 CSV</button><button type="button" id="catchupReviewOpen">查找已完播待补</button>' +
      '<button type="button" id="libraryBatchToggle" aria-pressed="' +
      libraryBatch + '">' + (libraryBatch ? '退出批量整理' : '批量整理') + '</button></div>' +
      (libraryBatch ? '<div class="fbar"><button type="button" id="libraryBatchSelect">全选当前列表</button>' +
        '<button type="button" id="libraryBatchClear">取消全选</button><button type="button" id="libraryBatchOpen" disabled>整理所选（0）</button></div>' : '') +
      '<div class="fbar library-filters">' +
      libraryFilterHtml('libraryFilter', libraryFilter) +
      '<label>年份 <select id="libraryYear">' + options(years, libraryView.year) + '</select></label>' +
      '<label>标签 <select id="libraryTag">' + options(tags, libraryView.tag) + '</select></label>' +
      '<label>观看链接 <select id="libraryLink"><option value="">全部</option><option value="yes"' +
      (libraryView.link === 'yes' ? ' selected' : '') + '>有链接</option><option value="no"' +
      (libraryView.link === 'no' ? ' selected' : '') + '>无链接</option></select></label>' +
      '<label>已保存视图 <select id="libraryPreset"><option value="">选择视图</option>' +
      Object.keys(savedLibraryViews).map(function (name) { return '<option>' + esc(name) + '</option>'; }).join('') +
      '</select></label><button type="button" id="saveLibraryPreset">保存视图</button><button type="button" id="clearLibraryFilters">清除筛选</button></div>' +
      '<div class="library-sections">' + keys.map(function (state) {
        return section(state, LIBRARY_STATES[state], '这个分组还没有番剧');
      }).join('') + '</div></div>';
  }

  function storeLibraryView() {
    try { localStorage.setItem('tiara.libraryView', JSON.stringify({ state: libraryFilter, filters: libraryView, presets: savedLibraryViews })); }
    catch (e) { toast('浏览器无法保存视图'); }
  }

  var BROWSER_FIELDS = {
    'kx.theme': ['light', 'dark', 'auto'],
    'kx.cover': Object.keys(COVER),
    'kx.tab': VIEWS,
    'kx.weekAll': ['0', '1'],
    'tiara.home': ['', 'today', 'week', 'continue', 'catchup'],
    'tiara.compactWeek': ['0', '1'],
    'tiara.libraryView': null
  };

  function cleanLibraryView(input) {
    function view(value) {
      var info = value && typeof value === 'object' ? value : {};
      var fields = info.filters || {};
      return {
        state: Object.hasOwn(LIBRARY_STATES, info.state) ? info.state : '',
        filters: {
          year: typeof fields.year === 'string' && /^\d{4}$/.test(fields.year) ? fields.year : '',
          tag: typeof fields.tag === 'string' ? fields.tag.slice(0, 30) : '',
          link: ['yes', 'no'].includes(fields.link) ? fields.link : ''
        }
      };
    }
    var current = view(input);
    current.presets = Object.fromEntries(Object.entries(input?.presets || {}).filter(function (pair) {
      return pair[0].trim() && pair[0].length <= 40 && pair[1] && typeof pair[1] === 'object';
    }).slice(0, 100).map(function (pair) { return [pair[0], view(pair[1])]; }));
    return current;
  }

  function applyLibraryView(saved) {
    var view = cleanLibraryView(saved);
    libraryFilter = view.state;
    libraryView = view.filters;
    savedLibraryViews = view.presets;
  }

  function browserPreferences(input) {
    var out = {};
    for (var [key, values] of Object.entries(BROWSER_FIELDS)) {
      var value = input?.[key];
      if (values && values.includes(value)) out[key] = value;
      if (!values && value && typeof value === 'object' && !Array.isArray(value)) out[key] = cleanLibraryView(value);
    }
    return out;
  }

  function readBrowserPreferences() {
    var values = {};
    for (var key of Object.keys(BROWSER_FIELDS)) {
      var raw = localStorage.getItem(key);
      if (BROWSER_FIELDS[key]) values[key] = raw;
      else try { values[key] = JSON.parse(raw); } catch (e) {}
    }
    return browserPreferences(values);
  }

  function saveBrowserPreferences(prefs) {
    var previous = new Map();
    try {
      for (var [key, value] of Object.entries(prefs)) {
        var old = localStorage.getItem(key);
        localStorage.setItem(key, BROWSER_FIELDS[key] ? value : JSON.stringify(value));
        previous.set(key, old);
      }
    } catch (error) {
      for (var [key, old] of previous) {
        if (old === null) localStorage.removeItem(key);
        else localStorage.setItem(key, old);
      }
      throw error;
    }
  }

  function bindLibraryFilters() {
    if (!$('#libraryFilter')) return;
    $('#libraryCsv').onclick = openLibraryCsv;
    $('#libraryBatchToggle').onclick = function () { libraryBatch = !libraryBatch; render(); (libraryBatch ? $('#libraryBatchSelect') : $('#libraryBatchToggle')).focus(); };
    if (libraryBatch) {
      var boxes = [...document.querySelectorAll('[data-library-pick]')], batchOpen = $('#libraryBatchOpen');
      function selected() { return boxes.filter(function (box) { return box.checked; }).map(function (box) { return box.value; }); }
      function countSelected() {
        var count = selected().length;
        batchOpen.textContent = '整理所选（' + count + '）';
        batchOpen.disabled = count === 0;
      }
      boxes.forEach(function (box) { box.onchange = countSelected; });
      $('#libraryBatchSelect').onclick = function () { boxes.forEach(function (box) { box.checked = true; }); countSelected(); };
      $('#libraryBatchClear').onclick = function () { boxes.forEach(function (box) { box.checked = false; }); countSelected(); };
      batchOpen.onclick = function () { openLibraryBatch(selected()); };
    }
    [['#libraryFilter', 'state'], ['#libraryYear', 'year'], ['#libraryTag', 'tag'], ['#libraryLink', 'link']].forEach(function (field) {
      $(field[0]).addEventListener('change', function () {
        if (field[1] === 'state') libraryFilter = this.value;
        else libraryView[field[1]] = this.value;
        storeLibraryView(); render();
      });
    });
    $('#libraryPreset').addEventListener('change', function () {
      if (!Object.hasOwn(savedLibraryViews, this.value)) return;
      var view = savedLibraryViews[this.value];
      libraryFilter = view.state;
      libraryView = Object.assign({}, view.filters);
      storeLibraryView(); render();
    });
    $('#clearLibraryFilters').addEventListener('click', function () {
      libraryFilter = ''; libraryView = { year: '', tag: '', link: '' }; storeLibraryView(); render();
    });
    $('#saveLibraryPreset').addEventListener('click', function () {
      openDlg('保存番库视图', '<form id="libraryPresetForm"><label>名称 <input id="libraryPresetName" maxlength="40" required></label></form>',
        '<button data-close>取消</button><button type="submit" class="primary" form="libraryPresetForm">保存</button>');
      $('#libraryPresetForm').addEventListener('submit', function (event) {
        event.preventDefault();
        var name = $('#libraryPresetName').value.trim();
        if (!name) return;
        savedLibraryViews = Object.assign(Object.create(null), savedLibraryViews);
        savedLibraryViews[name] = { state: libraryFilter, filters: Object.assign({}, libraryView) };
        storeLibraryView(); closeDlg(); render();
      });
    });
  }

  function openLibraryCsv() {
    openDlg('从表格导入番剧',
      '<p>使用模板整理旧番库，保存为 UTF-8 CSV。0 集加入待看，已有进度加入补番。导入前可核对重复并选择要新增的行。</p>' +
      '<button type="button" id="csvTemplate">下载 CSV 模板</button>' +
      '<label class="row"><span>选择 CSV</span><input type="file" id="csvFile" accept=".csv,text/csv"></label>' +
      '<p id="csvStatus" role="status"></p><div id="csvPreview"></div>',
      '<button data-close>关闭</button><button class="primary" id="csvApply" disabled>确认导入</button>');
    var file = $('#csvFile'), status = $('#csvStatus'), result = $('#csvPreview'), apply = $('#csvApply');
    var revision = null, raw = '', request = 0, busy = false;
    $('#csvTemplate').onclick = function () {
      var text = '\uFEFF标题,已看集数,总集数,年份,Bangumi编号\r\n示例番剧,0,12,2020,\r\n';
      var url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
      var link = document.createElement('a');
      link.href = url;
      link.download = 'TIARA-番库导入模板.csv';
      link.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    };
    function selected() {
      return Array.from(result.querySelectorAll('[data-csv-line]:checked'), function (input) { return Number(input.dataset.csvLine); });
    }
    function update() {
      var count = selected().length;
      apply.disabled = busy || !revision || count === 0;
      apply.textContent = '确认导入' + (count ? ' ' + count + ' 部' : '');
    }
    result.addEventListener('change', update);
    file.onchange = function () {
      var ticket = ++request, item = file.files[0];
      revision = null;
      result.textContent = '';
      update();
      if (!item) { status.textContent = ''; return; }
      if (item.size > 512 * 1024) { status.textContent = '请选择 512 KiB 以内的 UTF-8 CSV。'; return; }
      status.textContent = '正在预览…';
      item.text().then(function (data) {
        if (ticket !== request || !status.isConnected) return null;
        raw = data;
        flushAllBumps();
        return POST_CHAIN.then(function () { return sendPost('/api/library/csv', { preview: true, csv: data }); });
      }).then(function (reply) {
        if (!reply || ticket !== request || !status.isConnected) return;
        if (!reply.ok) throw new Error(reply.error || '无法预览 CSV');
        revision = reply.revision;
        var offered = reply.rows.filter(function (row) { return row.action === 'add'; }).length;
        status.textContent = '可新增 ' + offered + ' 部，需核对或修正 ' + (reply.rows.length - offered) + ' 行。';
        result.innerHTML = '<ul class="csv-preview">' + reply.rows.map(function (row) {
          var caption = '第 ' + row.line + ' 行 · ' + (row.name || '标题为空');
          if (row.action === 'add') return '<li><label><input type="checkbox" data-csv-line="' + row.line + '" checked> ' +
            esc(caption) + '</label> <small>' + esc(WATCH_STATE_LABEL[row.state] + ' · ' + row.seen + ' / ' + (row.total ?? '?') +
              ' 集' + (row.year ? ' · ' + row.year : '')) + '</small></li>';
          if (row.action === 'invalid') return '<li>' + esc(caption + ' · ' + row.error) + '</li>';
          return '<li>' + esc(caption + ' · 跳过可能重复的条目') +
            (row.matches.length ? duplicateRows(row.matches) : '') +
            (row.earlier.length ? '<small>与表格第 ' + row.earlier.join('、') + ' 行相同</small>' : '') + '</li>';
        }).join('') + '</ul>';
        update();
      }).catch(function (error) {
        if (ticket === request && status.isConnected) status.textContent = error.message || '无法预览 CSV';
      });
    };
    apply.onclick = function () {
      var picked = selected();
      busy = file.disabled = true;
      update();
      status.textContent = '正在导入 ' + picked.length + ' 部番剧…';
      sendPost('/api/library/csv', { csv: raw, revision: revision, selected: picked }).then(function (reply) {
        if (!reply.ok) throw new Error(reply.error || '导入失败');
        status.textContent = '已新增 ' + reply.added.length + ' 部番剧。';
        result.textContent = '';
        file.value = '';
        revision = null;
        refresh();
      }).catch(function (error) {
        status.textContent = error.message || '导入失败，请重新预览';
        file.value = '';
        revision = null;
      }).finally(function () {
        busy = file.disabled = false;
        update();
      });
    };
  }

  function broadcastLabel(status) {
    if (!status || status.state === 'unknown') return '暂未确认原播结束';
    if (status.state === 'airing') return '仍有未播正片或未来播出日';
    var sources = { manual: '本机已标记排片结束', subject: 'Bangumi 条目完播', episodes: 'Bangumi 正片均已播出' };
    return (sources[status.source] || '已完播') + (status.date ? ' · ' + status.date : '');
  }

  function openCatchupReview() {
    openDlg('查找已完播待补', '<p id="catchupReviewStatus" role="status"></p><div id="catchupReviewList"></div>',
      '<button data-close>关闭</button><button type="button" id="catchupReviewOnline">联网核对本页</button>' +
      '<button type="button" id="catchupReviewNext" hidden>下一页</button>' +
      '<button type="button" id="catchupReviewPreview" class="primary" disabled>预览转入补番</button>');
    var status = $('#catchupReviewStatus'), list = $('#catchupReviewList'), online = $('#catchupReviewOnline');
    var next = $('#catchupReviewNext'), preview = $('#catchupReviewPreview'), offset = 0, following = null;
    function selection() {
      return [...list.querySelectorAll('input:checked')].map(function (box) { return box.value; });
    }
    list.onchange = function () { preview.disabled = !selection().length; };
    preview.onclick = function () { openLibraryBatch(selection(), true); };
    online.onclick = function () { load(true); };
    next.onclick = function () { offset = following; load(false); };
    function load(refreshStatus) {
      status.textContent = refreshStatus ? '正在核对这页的播出状态…' : '正在检查本机记录与缓存…';
      online.disabled = next.disabled = preview.disabled = true;
      list.replaceChildren();
      json('/api/library/catchup-review?offset=' + offset + (refreshStatus ? '&refresh=1' : '')).then(function (reply) {
        if (!list.isConnected) return;
        following = reply.next;
        next.hidden = following == null;
        list.innerHTML = (reply.candidates.length ? '<h4>可转入补番</h4>' : '') + reply.candidates.map(function (row) {
          return '<label class="row"><input type="checkbox" value="' + esc(row.id) + '" checked> ' + esc(row.name) +
            '<small>' + esc(' · 已看 ' + row.watched_count + ' / ' + (row.eps || '？') + ' · ' + broadcastLabel(row.broadcast)) + '</small></label>';
        }).join('') + (reply.skipped.length ? '<h4>本页保留</h4><ul>' + reply.skipped.map(function (row) {
          return '<li>' + esc(row.name + ' · ' + row.reason) + '</li>';
        }).join('') + '</ul>' : '');
        preview.disabled = !selection().length;
        status.textContent = reply.candidates.length ? '勾选要转入补番的条目。预览后再确认。' : '这页暂时没有已确认完播的条目。';
      }).catch(function (error) {
        if (status.isConnected) status.textContent = error.message || '暂时无法读取番库。';
      }).finally(function () { online.disabled = next.disabled = false; });
    }
    load(false);
  }

  function openLibraryBatch(ids, endedOnly) {
    if (ids.length > 200) return toast('一次最多整理 200 部，请缩小筛选范围');
    openDlg('批量整理番库', '<form id="batchForm" class="watch-fields">' +
      '<label class="watch-field">操作<select id="batchAction">' + (endedOnly ?
        '<option value="ended-catchup">转入补番</option>' : '<option value="tag">添加标签</option>' +
        '<option value="catchup">切换为补番</option><option value="archive">归档已看完</option>') + '</select></label>' +
      '<label class="watch-field" id="batchTagRow">标签<input id="batchTag" maxlength="30" required></label></form>' +
      '<p id="batchStatus" role="status">已选 ' + ids.length + ' 部。</p><div id="batchReview"></div>',
      '<button type="button" data-close>关闭</button><button type="submit" form="batchForm" id="batchPreview">预览整理</button>' +
      '<button type="button" id="batchApply" class="primary" hidden>确认执行</button><button type="button" id="batchUndo" hidden>撤销本次整理</button>');
    var form = $('#batchForm'), action = $('#batchAction'), tag = $('#batchTag'), apply = $('#batchApply');
    var status = $('#batchStatus'), output = $('#batchReview'), preview = $('#batchPreview'), restore = $('#batchUndo'), ready, busy = false;
    function resetBatch() {
      ready = null;
      apply.hidden = true;
      output.replaceChildren();
      $('#batchTagRow').hidden = action.value !== 'tag';
      tag.required = action.value === 'tag';
      tag.disabled = action.value !== 'tag';
    }
    function describe(plan, done) {
      function rows(values) {
        return '<ul>' + values.map(function (item) {
          return '<li>' + esc(item.name) + (item.reason ? ' · ' + esc(item.reason) : '') +
            (item.broadcast ? ' · ' + esc(broadcastLabel(item.broadcast)) : '') + '</li>';
        }).join('') + '</ul>';
      }
      output.innerHTML = '<h4>' + (done ? '已处理 ' : '将处理 ') + plan.changed.length + ' 部</h4>' + rows(plan.changed) +
        '<h4>跳过 ' + plan.skipped.length + ' 部</h4>' + rows(plan.skipped);
    }
    function run(payload, done) {
      busy = true;
      action.disabled = tag.disabled = preview.disabled = apply.disabled = true;
      post('/api/library/batch', payload).then(function (reply) {
        if (!form.isConnected) return;
        if (!reply.ok) throw new Error(reply.error);
        describe(reply.plan, done);
        if (!done) {
          ready = Object.assign({}, payload, { preview: false, receipt: reply.receipt });
          apply.hidden = !reply.plan.changed.length;
          status.textContent = '请确认下方范围。';
          return;
        }
        ready = null;
        apply.hidden = preview.hidden = true;
        form.hidden = true;
        restore.hidden = !reply.changed;
        restore.onclick = function () { undo(reply.revision); closeDlg(); };
        status.textContent = reply.rebuild_error ? '已写入番库，桌宠数据暂未刷新。' : '批量整理已完成。';
        refresh();
      }).catch(function (error) {
        if (!form.isConnected) return;
        ready = null;
        apply.hidden = true;
        status.textContent = error.message || '请求失败，请重新预览。';
      }).finally(function () {
        busy = action.disabled = preview.disabled = apply.disabled = false;
        tag.disabled = action.value !== 'tag';
      });
    }
    form.oninput = resetBatch;
    form.onsubmit = function (event) {
      event.preventDefault();
      if (!busy) run({ ids: ids, action: action.value, tag: tag.value, preview: true }, false);
    };
    apply.onclick = function () { if (!busy && ready) run(ready, true); };
    resetBatch();
  }


  function viewContinueWatching() {
    var items = (STATE.watching || []).concat(STATE.catchup_list || []).filter(function (w) {
      return w.user_details?.pinned_at || w.last_watched;
    }).sort(function (a, b) {
      var pinned = String(b.user_details?.pinned_at || '').localeCompare(String(a.user_details?.pinned_at || ''));
      return pinned || recentWatchOrder(a, b);
    }).slice(0, 5);
    return '<section class="schedule-section" aria-labelledby="scheduleContinue"><div class="schedule-section-head">' +
      '<h3 id="scheduleContinue">接着看</h3><button type="button" data-goto="library" class="schedule-link">查看番库 ↗</button></div>' +
      (items.length ? '<div class="schedule-list">' + items.map(function (w) {
        var label = [w.watch_mode === 'catchup' ? '补番' : '连载', w.user_details?.pinned_at ? '已置顶' : ''].filter(Boolean).join(' · ');
        return showCard({ id: w.id, name: w.name_cn || w.name || String(w.id), entry: w, label: label }, 'continue');
      }).join('') + '</div>' : '<p class="schedule-empty">记过一话或置顶的番剧会出现在这里。</p>') + '</section>';
  }

  function recentWatchOrder(a, b) {
    return String(b?.last_watched || '').localeCompare(String(a?.last_watched || '')) ||
      String(b?.last_watched_at || '').localeCompare(String(a?.last_watched_at || ''));
  }

  function libraryFilterHtml(id, value) {
    return '<label class="library-filter">状态 <select id="' + id + '"><option value="">全部</option>' +
      Object.keys(LIBRARY_STATES).map(function (key) {
        return '<option value="' + key + '"' + (value === key ? ' selected' : '') + '>' + LIBRARY_STATES[key] + '</option>';
      }).join('') + '</select></label>';
  }

  function setLibrarySearch(value, restore = true) {
    var previous = q();
    QUERY = value;
    var terms = q();
    if ($('#q').value !== value) $('#q').value = value;
    $('#clearSearch').hidden = !value;
    if (terms === previous) return;
    searchLimit = 8;
    if (!previous) searchScroll = window.scrollY;
    if (!terms) searchFilter = '';
    renderLibrarySearch();
    if (!terms && restore) {
      if (searchViewDirty) render();
      window.scrollTo(0, searchScroll);
    } else if (terms && !previous) window.scrollTo(0, 0);
  }

  function renderLibrarySearch() {
    var region = $('#globalSearch');
    var terms = q();
    region.hidden = !terms || !STATE;
    $('#view').hidden = !region.hidden;
    if (region.hidden) { region.replaceChildren(); return; }
    var focusId = region.contains(document.activeElement) ? document.activeElement.id : '';
    var returnId = region.contains(dlgReturnFocus) ? dlgReturnFocus.id : '';
    var keys = searchFilter ? [searchFilter] : Object.keys(LIBRARY_STATES);
    var words = terms.split(/\s+/);
    var seen = new Set();
    var matches = keys.flatMap(function (state) {
      return (STATE[state] || []).flatMap(function (item) {
        var id = String(item.id);
        if (seen.has(id) || !matchLibrary(item, words)) return [];
        seen.add(id);
        return [{ item: item, state: state }];
      });
    });
    var rows = matches.slice(0, searchLimit).map(function (row) {
      var item = row.item, name = item.name_cn || item.name || String(item.id);
      var original = item.name && item.name !== name ? item.name : '';
      return '<li>' + cover(item.id, name) + '<div class="library-search-name">' +
        watchTitle(item.id, name, true, 'search-show-' + enc(item.id)) +
        (original ? '<small>' + esc(original) + '</small>' : '') + '</div>' +
        '<span class="tag mut">' + LIBRARY_STATES[row.state] + '</span></li>';
    }).join('');
    region.innerHTML = '<div class="library-search-head"><div><h2>全番库搜索</h2>' +
      '<p role="status">找到 ' + matches.length + ' 部</p></div><div class="library-search-tools">' +
      libraryFilterHtml('globalLibraryFilter', searchFilter) + '<button type="button" data-anime-search>跨季度找番</button></div></div>' +
      '<div class="panel library-search">' +
      (rows ? '<ul>' + rows + '</ul>' : '<p class="library-search-empty">番库中没有匹配的条目。可以换个番名或到 Bangumi 查找。</p>') +
      (matches.length > searchLimit ? '<div class="library-search-more"><button type="button" id="globalSearchMore">显示更多</button></div>' : '') + '</div>';
    if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
    if (returnId) dlgReturnFocus = document.getElementById(returnId) || $('#q');
    $('#globalLibraryFilter').addEventListener('change', function () {
      searchFilter = this.value; searchLimit = 8; renderLibrarySearch();
    });
    var more = $('#globalSearchMore');
    if (more) more.addEventListener('click', function () {
      var previous = searchLimit;
      searchLimit += 8;
      renderLibrarySearch();
      var next = region.querySelectorAll('[data-detail]')[previous];
      if (next) next.focus();
    });
  }

  function viewCatchup() {
    var week = STATE.catchup_week || { goal: 0, watched: 0 };
    var slots = new Map((STATE.catchup_reminders || []).map(function (slot) { return [String(slot.id), slot]; }));
    var entries = (STATE.catchup_list || []).slice().sort(recentWatchOrder);
    var list = entries.map(function (w) {
      var seen = num(w.ep_status), total = num(w.eps), name = w.name_cn || w.name || String(w.id), id = esc(w.id);
      var next = Math.max(seen + 1, num(w.start_episode) || 1);
      var slot = slots.get(String(w.id));
      var extra = (w.episode_extras || []).length;
      var progress = extra ? '累计已看 ' + (Math.max(0, seen - Math.max(0, num(w.start_episode) - 1)) + extra) +
        ' 集 · 连续至第 ' + seen + ' 集' + (total ? ' · 剩 ' + watchGap(w, total) + ' 集' : '') :
        '已看 ' + seen + (total ? ' / ' + total + ' 集 · 剩 ' + watchGap(w, total) + ' 集' : ' 集 · 总数未定');
      return '<article class="panel catchup-card" data-catchup="' + id + '">' +
        '<div>' + watchTitle(w.id, name, true) + '<p>下一集 · 第 ' + next + ' 集</p><small>' + esc(progress) + '</small>' +
        (slot ? '<small class="catchup-slot">补番提醒 · 周' + CN[slot.day] + ' ' + esc(slot.time) +
          (slot.quiet ? ' · 免打扰' : '') + '</small>' : '') + '</div>' +
        '<div class="catchup-actions">' + watchLink(w.watch_url, name) +
        '<button data-op="1" data-id="' + id + '">记一话</button></div></article>';
    }).join('');
    return '<section class="sec"><div class="sec-head"><h2>补番清单</h2><button type="button" data-new-watch>新增补番</button></div>' +
      '<div class="panel catchup-goal"><div><b>' + (week.watched == null ? '暂时读不到本周观看记录' : '本周已补 ' + week.watched + ' 集') + '</b>' +
      (week.goal && week.watched != null ? '<progress aria-label="每周补番目标" value="' + Math.max(0, Math.min(week.watched, week.goal)) + '" max="' +
        week.goal + '"></progress>' : '') + (week.goal ? '<small>目标 ' + week.goal + ' 集</small>' : '') +
      '</div><button type="button" id="catchupGoal">每周目标</button></div>' +
      '<div class="catchup-list">' + (list || '<div class="panel empty">还没有补番。可以手动添加旧番，或在番剧详情切换为补番。</div>') + '</div></section>';
  }

  function weekBuckets(all) {
    var t = STATE;
    var watch = {};
    (t.watching || []).forEach(function (w) { watch[String(w.id)] = w; });
    var buckets = { 0: [] };
    var listed = new Set();
    var catchup = STATE.catchup_list || [];
    var personalIds = new Set(catchup.map(function (w) { return String(w.id); }));
    WEEK_ORDER.forEach(function (d) { buckets[d] = []; });
    function add(x, w, day, time) {
      var id = String(x.id);
      var origin = ORIGINAL[id];
      var fromPlatform = w && /^bangumi-data ·/.test(w.schedule_source || '');
      if (origin) {
        day = origin.weekday;
        time = origin.time_cst;
      } else if (fromPlatform) {
        day = 0;
        time = '';
      }
      var slot = dispShow(time, day);
      (buckets[slot.wd] || buckets[0]).push({
        id: x.id, name: w?.name_cn || w?.name || x.name_cn || x.name || String(x.id), entry: w,
        time: slot.time, label: origin ? '原播' : time ? (w ? '自订排片' : '放送') : '时刻待定',
      });
      listed.add(id);
    }
    WEEK_ORDER.forEach(function (d) {
      ((t.weekly && t.weekly[d]) || []).forEach(function (x) {
        var id = String(x.id);
        var w = watch[id];
        if ((!all && !w) || listed.has(id) || personalIds.has(id)) return;
        add(x, w, d, x.time_cst);
      });
    });
    Object.values(watch).forEach(function (w) {
      if (listed.has(String(w.id)) || w.schedule_ended) return;
      add(w, w, num(w.air_weekday), w.air_time_cst);
    });
    catchup.forEach(function (w) {
      var slot = w.catchup_slot;
      if (!slot?.time || !WEEK_ORDER.includes(slot.day)) return;
      buckets[slot.day].push({ id: w.id, name: w.name_cn || w.name || String(w.id), entry: w,
        time: slot.time, label: '补番安排' });
    });
    Object.keys(buckets).forEach(function (d) {
      buckets[d].sort(function (a, b) {
        if (!a.time && !b.time) return 0;
        if (!a.time) return 1;
        if (!b.time) return -1;
        return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
      });
    });
    return buckets;
  }


  function scheduleWeekIndex(buckets) {
    var today = num(STATE.weekday);
    return '<nav class="schedule-days" aria-label="按星期查看本周排片">' + WEEK_ORDER.map(function (day) {
      var count = buckets[day].length;
      return '<button type="button" id="schedule-day-' + day + '" data-week-day="' + day + '"' +
        (day === today ? ' aria-current="date"' : '') + ' aria-label="星期' + CN[day] + '，' + count + ' 部"' +
        (count ? '' : ' disabled') + '><span>周' + CN[day] + '</span><b>' + count + '</b></button>';
    }).join('') + '</nav>';
  }

  function scheduleEmpty(text, actions) {
    return '<div class="schedule-empty">' + esc(text) + (actions ? '<div class="schedule-empty-actions">' + actions + '</div>' : '') + '</div>';
  }

  function scheduleAddActions() {
    return '<button type="button" data-goto="season">去本季选番</button><button type="button" data-new-watch>手动添加</button>';
  }

  function viewScheduleWeek(buckets) {
    var days = WEEK_ORDER.concat(0).filter(function (day) { return buckets[day].length; });
    var controls = '<div class="schedule-week-tools"><label><input type="checkbox" id="weekAll"' + (WEEK_ALL ? ' checked' : '') +
      ' /> 同时显示未追番剧</label><button type="button" id="catchupReviewOpen" class="schedule-link">查找已完播待补</button></div>';
    return controls + (days.length ? '<div class="schedule-week' + (compactWeek ? ' is-compact' : '') + '">' + days.map(function (day) {
      var rows = buckets[day], isToday = day === num(STATE.weekday);
      return '<section id="weekDay' + day + '" class="schedule-section schedule-day" aria-labelledby="weekLabel' + day + '">' +
        '<div class="schedule-section-head"><h3 id="weekLabel' + day + '" tabindex="-1">' + (day ? '星期' + CN[day] : '时段待定') +
        '</h3>' + (isToday ? '<span class="schedule-today-tag">今天</span>' : '') + '<small>' + rows.length + ' 部</small></div>' +
        '<div class="schedule-list">' + rows.map(function (row) { return showCard(row, 'week'); }).join('') + '</div></section>';
    }).join('') + '</div>' : scheduleEmpty('本周还没有排片。', scheduleAddActions()));
  }

  function viewScheduleToday() {
    var today = num(STATE.weekday);
    var rows = (STATE.today || []).map(function (s) {
      return { id: s.id, name: s.name_cn || s.name || String(s.id), entry: findWatch(s.id), actualTime: s.time_cst,
        time: s.time_disp || s.time_cst, label: s.disp_shifted ? '周' + CN[s.weekday_disp] + '深夜档' : '连载排片' };
    });
    (STATE.catchup_list || []).forEach(function (w) {
      var slot = w.catchup_slot;
      if (slot?.day !== today || !slot.time) return;
      rows.push({ id: w.id, name: w.name_cn || w.name || String(w.id), entry: w,
        actualTime: slot.time, time: slot.time, label: '补番安排' });
    });
    rows.sort(function (a, b) { return String(a.actualTime || '99:00').localeCompare(String(b.actualTime || '99:00')); });
    var hasWatch = (STATE.watching || []).length || (STATE.catchup_list || []).length;
    var entries = rows.length ? '<div class="schedule-list">' + rows.map(function (row) { return showCard(row, 'today'); }).join('') + '</div>' :
      scheduleEmpty(hasWatch ? '今天没有安排，看看本周还有什么。' : '添加想看的番剧，开始安排追番。',
        hasWatch ? '<button type="button" data-goto="week">查看本周</button>' : scheduleAddActions());
    return viewContinueWatching() + '<section class="schedule-section" aria-labelledby="scheduleTodayList">' +
      '<div class="schedule-section-head"><h3 id="scheduleTodayList">今日排片</h3><small>' + rows.length + ' 部</small></div>' + entries + '</section>' +
      (WELCOME_FORCE ? '<section class="schedule-section"><div class="schedule-section-head"><h3>开始使用</h3></div>' +
        scheduleEmpty('从本季选番，或手动添加并在详情里安排时间。',
          scheduleAddActions() + '<button type="button" data-goto="sync">同步 Bangumi</button>') + '</section>' : '');
  }

  function scheduleSidebar(buckets) {
    var totals = STATS ? '<dl class="schedule-stats"><div><dt>本周</dt><dd>' + num(STATS.week) + '</dd></div>' +
      '<div><dt>累计</dt><dd>' + num(STATS.total) + '</dd></div><div><dt>连续天</dt><dd>' + num(STATS.streak) + '</dd></div></dl>' :
      '<p class="schedule-side-note">暂时读不到观看统计。</p>';
    if (STATS?.byDay?.length) {
      totals += '<div class="spark schedule-trend" aria-label="最近 14 天观看记录">' + STATS.byDay.map(function (d) {
        var count = num(d.n), height = Math.min(28, 3 + 5 * Math.max(0, count));
        return '<i' + (count > 0 ? ' class="on"' : '') + ' style="height:' + height + 'px" title="' +
          esc(d.date + ' · ' + count + ' 集') + '"></i>';
      }).join('') + '</div>';
    }
    return '<aside class="schedule-sidebar"><section class="schedule-section"><div class="schedule-section-head">' +
      '<h3>放送日历</h3><small>北京时间</small></div>' + scheduleWeekIndex(buckets) +
      '<p id="weekScheduleStatus" class="schedule-side-note" role="status">' + esc(originalWarning) + '</p></section>' +
      '<section class="schedule-section"><div class="schedule-section-head"><h3>观看统计</h3></div>' + totals + '</section>' +
      '<section class="schedule-section schedule-companion"><div class="schedule-section-head"><h3>TIARA 说</h3>' +
      '<button type="button" id="sayBtn" class="schedule-link">再说一句</button></div>' +
      '<p id="sayText">' + esc(STATE.summary || '') + '</p>' + (STATE.quote ? '<small>' + esc(STATE.quote) + '</small>' : '') + '</section></aside>';
  }

  function viewSchedule(weekly) {
    var buckets = weekBuckets(weekly && WEEK_ALL);
    return '<section class="schedule-view" aria-labelledby="scheduleHeading"><header class="schedule-head"><div>' +
      '<h2 id="scheduleHeading">我的排片</h2><p><time datetime="' + esc(STATE.date) + '">' + esc(STATE.date) + '</time> · 星期' +
      CN[num(STATE.weekday)] + '</p></div><div class="schedule-head-actions">' +
      '<button type="button" id="pendingBtn" class="ghost" title="查看落后至少一话的番剧" hidden>待看</button>' +
      '<nav class="schedule-views" aria-label="排片范围">' +
      '<button type="button" id="schedule-view-today" data-goto="today" aria-pressed="' + !weekly + '">今天</button>' +
      '<button type="button" id="schedule-view-week" data-goto="week" aria-pressed="' + weekly + '">本周</button></nav></div></header>' +
      '<div class="schedule-layout"><div class="schedule-main">' + (weekly ? viewScheduleWeek(buckets) : viewScheduleToday()) +
      '</div>' + scheduleSidebar(buckets) + '</div></section>';
  }

  // ---------------- 本季 ----------------
  function curSeason(d) {
    d = d || new Date();
    var m = d.getMonth() + 1;
    var y = d.getFullYear();
    var yy = m >= 10 ? y : (m >= 7 ? y : (m >= 4 ? y : y - 1));
    var qq = m >= 10 ? 4 : (m >= 7 ? 3 : (m >= 4 ? 2 : 1));
    return yy + 'Q' + qq;
  }

  /** "2026Q4" 前后挪 n 个季度 */
  function shiftSeason(q, n) {
    var m = /^(\d{4})Q([1-4])$/.exec(String(q || ''));
    if (!m) return q;
    var idx = Number(m[1]) * 4 + (Number(m[2]) - 1) + n;
    var y = Math.floor(idx / 4);
    var quarter = (idx % 4) + 1;
    return y + 'Q' + quarter;
  }

  function viewSeason() {
    if (!SEASON_Q) SEASON_Q = curSeason();
    var nowQ = curSeason();
    var pills = '';
    for (var k = -6; k <= 1; k++) {
      var qq = shiftSeason(nowQ, k);
      pills += '<button class="qpill' + (qq === SEASON_Q ? ' on' : '') + '" data-q="' + qq + '">' +
        qq + (qq === nowQ ? '<span class="dot"></span>' : '') + '</button>';
    }
    // 工具条用 .fbar（普通流内布局）。以前借了顶栏的 .bar：sticky + 深色底，
    // 滚动后正好压在 header 上，亮色主题下还是深底深字。
    var bar = '<div class="fbar season-bar">' +
      '<button class="icon qstep" data-step="-1" title="上一季">‹</button>' +
      '<div class="qstrip">' + pills + '</div>' +
      '<button class="icon qstep" data-step="1" title="下一季">›</button>' +
      '<button id="seasonRefresh" class="ghost">刷新</button>' +
      '<span class="sep"></span>' +
      '<label><input type="checkbox" id="onlyTv"' + (SEASON_FILTER.onlyTv ? ' checked' : '') + ' /> 只看 TV</label>' +
      '<label><input type="checkbox" id="hideWatching"' + (SEASON_FILTER.hideWatching ? ' checked' : '') + ' /> 隐藏已在追</label>' +
      '<label><input type="checkbox" id="onlyTodo"' + (SEASON_FILTER.onlyTodo ? ' checked' : '') + ' /> 只看没追的</label>' +
      '<select id="sortBy">' +
      '<option value="weekday"' + (SEASON_FILTER.sortBy === 'weekday' ? ' selected' : '') + '>按放送日</option>' +
      '<option value="rating"' + (SEASON_FILTER.sortBy === 'rating' ? ' selected' : '') + '>按评分</option>' +
      '<option value="recent"' + (SEASON_FILTER.sortBy === 'recent' ? ' selected' : '') + '>按最近观看</option>' +
      '<option value="name"' + (SEASON_FILTER.sortBy === 'name' ? ' selected' : '') + '>按名字</option>' +
      '</select>' +
      '<span class="grow"></span>' +
      '<button id="markAll">全选</button><button id="markNone">清空</button>' +
      '<button id="batchTime" title="给勾选的番批量设开播时刻">批量时刻</button>' +
      '<button class="primary" id="applyBtn">加入在追</button>' +
      '</div>';
    return '<div class="sec"><div class="sec-head season-page-heading"><h2>本季番剧</h2>' +
      '<span class="note">原播周档 · 北京时间</span><button type="button" data-anime-search>跨季度找番</button></div>' +
      '<div class="panel">' + bar + '<div id="seasonBody">' + seasonBodyHtml() + '</div></div></div>';
  }

  /**
   * 筛选条件是「视图状态」不是「DOM 状态」：refresh() 会整体重绘，
   * 以前重绘后全被打回默认值，用户刚选的「按评分」一刷新就没了。
   */
  function readSeasonFilter() {
    if ($('#onlyTv')) {
      SEASON_FILTER.onlyTv = $('#onlyTv').checked;
      SEASON_FILTER.hideWatching = $('#hideWatching').checked;
      SEASON_FILTER.onlyTodo = $('#onlyTodo').checked;
      SEASON_FILTER.sortBy = $('#sortBy').value || 'weekday';
    }
    return SEASON_FILTER;
  }

  function seasonBodyHtml() {
    if (SEASON_ERR && !SEASON) return '<div class="empty" role="status">暂时读不到这季的番剧表。检查网络或代理后，点上方「刷新」重试。</div>';
    if (!SEASON) {
      return '<div class="pb">' +
        '<div class="skel" style="width:60%"></div>' +
        '<div class="skel" style="width:80%;margin-top:10px"></div>' +
        '<div class="skel" style="width:45%;margin-top:10px"></div>' +
        '<div class="empty" role="status">正在读 ' + esc(SEASON_Q) + ' 的番剧表…</div></div>';
    }
    var j = SEASON;
    var f = readSeasonFilter();
    var onlyTv = f.onlyTv, hideW = f.hideWatching, onlyTodo = f.onlyTodo, sortBy = f.sortBy;
    var watching = (STATE && STATE.watching) || [];
    var inactiveById = new Map();
    ['paused', 'finished', 'archived', 'planned', 'dropped', 'removed', 'catchup_list'].forEach(function (state) {
      ((STATE && STATE[state]) || []).forEach(function (w) { inactiveById.set(String(w.id), { state: state === 'catchup_list' ? 'catchup' : state, entry: w }); });
    });

    var list = (j.items || []).slice();
    if (onlyTv) list = list.filter(tvLike);
    if (hideW || onlyTodo) {
      list = list.filter(function (x) {
        return !watching.some(function (w) { return String(w.id) === String(x.id); }) && (!onlyTodo || !inactiveById.has(String(x.id)));
      });
    }
    var watchingById = {};
    watching.forEach(function (w) { watchingById[String(w.id)] = w; });
    function trackedEntry(item) { return watchingById[String(item.id)] || inactiveById.get(String(item.id))?.entry; }
    function broadcastDay(x) {
      var airing = (j.airings || {})[String(x.id)];
      return airing ? dispShow(airing.time_cst, airing.weekday).wd : x.weekday || 0;
    }
    list.sort(function (a, b) {
      if (sortBy === 'rating') return num(b.rating) - num(a.rating);
      if (sortBy === 'name') return String(a.name_cn || a.name).localeCompare(String(b.name_cn || b.name), 'zh');
      if (sortBy === 'recent') {
        var order = recentWatchOrder(trackedEntry(a), trackedEntry(b));
        if (order) return order;
      }
      var aw = broadcastDay(a) || 9, bw = broadcastDay(b) || 9;
      return aw - bw || String(a.date || '').localeCompare(String(b.date || ''));
    });


    // 分组计数先算一遍，别在每一行里再 filter 整表
    var perDay = {};
    list.forEach(function (x) { var d = broadcastDay(x); perDay[d] = (perDay[d] || 0) + 1; });

    // 按放送日分组（只有按放送日排序时才分组）
    var rows = '';
    var lastW = null;
    list.forEach(function (x) {
      var id = String(x.id);
      var w = watchingById[id];
      var inactive = inactiveById.get(id);
      var tracked = w || (inactive && inactive.entry);
      var mark = !!SEASON_MARK[id];
      var wd = broadcastDay(x);
      if (sortBy === 'weekday' && wd !== lastW) {
        lastW = wd;
        var label = wd ? '周' + CN[wd] : '放送日未定';
        var n = perDay[wd] || 0;
        var isToday = wd && num(STATE.weekday) === wd;
        rows += '<tr class="dayrow' + (isToday ? ' today' : '') + '"><td colspan="6">' + label +
          '<span class="n">' + n + ' 部</span></td></tr>';
      }
      var meta = [(x.tags || []).slice(0, 3).join(' / '), x.platform || ''].filter(Boolean).join(' · ');
      var airing = (j.airings || {})[id];
      var opCell;
      if (w) {
        var tt = num(w.eps);
        var ww = num(w.ep_status);
        opCell = '<div class="ops-wrap">' +
          '<div class="ops-line"><span class="ep" data-season-id="' + esc(id) + '">' + ww + '/' + (tt || '?') + '</span>' +
          '<button data-op="-1" data-id="' + esc(id) + '" title="回退一话">−</button>' +
          '<button data-op="1" data-id="' + esc(id) + '" title="记一话">+</button>' +
          '<button class="x" data-op="remove" data-id="' + esc(id) + '" title="移出在追">×</button></div>' +
          (w.air_weekday ? '<input class="tin" type="text" data-time="' + esc(id) + '" value="' + esc(w.air_time_cst || '') +
          '" placeholder="时刻 23:00" title="按本地排期保存" />' :
          '<button type="button" data-detail="' + esc(id) + '">补星期和时刻</button>') +
          '</div>';
      } else if (inactive) {
        opCell = '<span class="tag mut">' + WATCH_STATE_LABEL[inactive.state] + '</span>';
      } else {
        opCell = '<button class="mini add" data-seadd="' + esc(id) + '" title="直接加进在追">+ 追</button>';
      }
      rows += '<tr>' +
        '<td class="ck"><input type="checkbox" aria-label="选中 ' + esc(x.name_cn || x.name) + '" data-mark="' + esc(id) + '"' +
        (tracked || mark ? ' checked' : '') + (tracked ? ' disabled' : '') + ' /></td>' +
        '<td class="pc">' + cover(id, x.name_cn || x.name) + '</td>' +
        '<td class="nm-cell">' +
        '<div class="nm" title="' + esc(x.name_cn || x.name) + '">' + watchTitle(id, tracked ? tracked.name_cn || tracked.name : x.name_cn || x.name, !!tracked) + '</div>' +
        '<div class="meta">' + esc(meta) + '</div>' +
        '<div class="meta season-airing">' + esc(formatAiring(airing) || (j.airings ? '暂无原播周档' : '—')) + '</div>' +
        '<div class="meta season-mobile-meta">' +
        (x.eps ? esc(x.eps) + ' 话' : '话数未定') + (x.rating ? ' · 评分 ' + num(x.rating).toFixed(1) : '') + '</div></td>' +
        '<td class="cn">' + (x.eps ? esc(String(x.eps)) + ' 话' : '—') + '</td>' +
        '<td class="rt">' + (x.rating ? num(x.rating).toFixed(1) : '—') + '</td>' +
        '<td class="op">' + opCell + '</td></tr>';
    });

    // 服务端会把拉取失败的原始错误塞进 warning（含 ECONNREFUSED 127.0.0.1:7890 这种），
    // 对用户没意义：换成一句能照做的，细节留给「诊断」页。
    var warn = j.warning ? String(j.warning) : SEASON_ERR;
    var warnText = '';
    if (warn) {
      warnText = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|proxy|socket hang up/i.test(warn)
        ? ' · 联网失败，正在显示缓存旧数据'
        : ' · ' + warn;
    }
    var info = '<div class="fbar" style="padding:10px 14px;border-bottom:1px solid var(--line)">' +
      esc(j.q || '') + ' 共 ' + (j.total || list.length) + ' 部 · 显示 ' + list.length + ' 部 · ' +
      (j.source === 'net' ? '刚拉取' : '来自缓存') + esc(warnText) +
      '<span id="seasonScheduleStatus" role="status">' + esc(seasonScheduleStatus(j)) + '</span></div>';

    return info + '<table class="grid">' +
      '<thead><tr><th class="ck"></th><th class="pc"></th><th>番名</th>' +
      '<th class="cn">话数</th><th class="rt">评分</th><th class="op">状态 / 时刻</th></tr></thead>' +
      '<tbody>' + (rows || '<tr><td colspan="6"><div class="empty">这一季没有匹配的番。</div></td></tr>') + '</tbody></table>';
  }

  function loadSeason(refreshNet) {
    if (!SEASON_Q) SEASON_Q = curSeason();
    SEASON_ERR = '';
    var request = ++seasonRequest;
    var url = '/api/season?q=' + encodeURIComponent(SEASON_Q) + (refreshNet ? '&refresh=1' : '');
    return json(url)
      .then(function (j) {
        if (request !== seasonRequest) return;
        if (!j || !j.items) {
          SEASON = null;
          SEASON_ERR = (j && (j.error || j.message)) || '没有返回数据';
        } else {
          SEASON = j;
        }
        if (TAB === 'season') {
          var body = $('#seasonBody');
          if (body) body.innerHTML = seasonBodyHtml();
          bindSeason();
        }
        if (!SEASON || !SEASON.items.length) return;
        return json('/api/schedule/original?q=' + encodeURIComponent(SEASON_Q)).then(function (schedule) {
          if (request !== seasonRequest || !SEASON) return;
          SEASON.airings = schedule.airings || {};
        }).catch(function (error) {
          if (request === seasonRequest && SEASON) SEASON.airingWarning = scheduleErrorText(error);
        }).then(function () {
          if (request !== seasonRequest || TAB !== 'season' || !SEASON) return;
          var current = $('#seasonBody');
          if (current && !current.contains(document.activeElement)) {
            current.innerHTML = seasonBodyHtml();
            bindSeason();
          } else {
            var status = $('#seasonScheduleStatus');
            if (status) status.textContent = seasonScheduleStatus(SEASON);
          }
        });
      })
      .catch(function (e) {
        if (request !== seasonRequest) return;
        SEASON_ERR = e.message || '网络错误';
        if (TAB === 'season') {
          var body = $('#seasonBody');
          if (body) body.innerHTML = seasonBodyHtml();
          bindSeason();
        }
      });
  }

  function formatAiring(airing) {
    if (!airing || !CN[airing.weekday] || !airing.time_cst) return '';
    var slot = dispShow(airing.time_cst, airing.weekday);
    return '每周' + CN[slot.wd] + ' ' + slot.time + ' 更新';
  }

  function scheduleErrorText(error) {
    return error.status === 404
      ? '网页服务版本较旧，请退出 TIARA 后重新打开，再刷新网页。'
      : '原播周档暂时无法读取，请稍后重试。';
  }

  function seasonScheduleStatus(season) {
    if (season.airingWarning) return season.airingWarning;
    return !season.airings && season.items.length ? '正在读取原播周档…' : '';
  }

  function watchOriginalText(id, cached) {
    return formatAiring(ORIGINAL[id]) || cached || (/^\d+$/.test(String(id)) &&
      (originalWarning || (originalRequest ? '正在读取原播周档…' : ''))) || '暂无原播周档';
  }

  // ---------------- 交互 ----------------
  function bind() {
    bindLibraryFilters();
    var catchupGoal = $('#catchupGoal');
    if (catchupGoal) catchupGoal.addEventListener('click', openCatchupGoal);
    var v = $('#view');
    var pendingButton = $('#pendingBtn', v);
    if (pendingButton) pendingButton.onclick = showPending;
    var historyButton = $('#watchHistoryBtn', v);
    if (historyButton) historyButton.onclick = function () { openWatchHistory(); };
    var reportButton = $('#watchReportBtn', v);
    if (reportButton) reportButton.onclick = openWatchReport;
    v.querySelectorAll('[data-week-day]').forEach(function (button) {
      button.addEventListener('click', function () {
        if (TAB !== 'week') switchTab('week');
        var section = $('#weekDay' + button.dataset.weekDay);
        if (section) {
          $('h3', section).focus({ preventScroll: true });
          section.scrollIntoView({ block: 'start' });
        }
      });
    });

    v.querySelectorAll('[data-goto]').forEach(function (el) {
      el.addEventListener('click', function () {
        var to = el.getAttribute('data-goto');
        if (to === 'sync') return doSync();
        switchTab(to);
        if (el.id) document.getElementById(el.id)?.focus({ preventScroll: true });
      });
    });

    v.querySelectorAll('[data-op]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        if (el.getAttribute('aria-disabled') === 'true') return;
        closeScheduleMenu(el.closest('.schedule-more'), true);
        var id = el.getAttribute('data-id');
        if (el.getAttribute('data-op') === 'remove') return removeWatch(id);
        bump(id, Number(el.getAttribute('data-op')));
      });
    });

    v.querySelectorAll('[data-schedule-episodes]').forEach(function (button) {
      button.addEventListener('click', function () {
        closeScheduleMenu(button.closest('.schedule-more'), true);
        openWatchDetail(button.dataset.scheduleEpisodes, true);
      });
    });
    v.querySelectorAll('.schedule-more').forEach(function (menu) {
      menu.addEventListener('toggle', function () {
        if (menu.open) v.querySelectorAll('.schedule-more[open]').forEach(function (other) {
          if (other !== menu) closeScheduleMenu(other);
        });
      });
      var external = $('a', menu);
      if (external) external.addEventListener('click', function () { closeScheduleMenu(menu, true); });
    });
    v.querySelectorAll('[data-add]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        addWatch(el.getAttribute('data-add'), el.getAttribute('data-name'));
      });
    });

    var wa = $('#weekAll');
    if ($('#catchupReviewOpen')) $('#catchupReviewOpen').onclick = openCatchupReview;
    if (wa) wa.addEventListener('change', function () {
      WEEK_ALL = wa.checked;
      try { localStorage.setItem('kx.weekAll', WEEK_ALL ? '1' : '0'); } catch (e) {}
      render();
    });

    var sayBtn = $('#sayBtn');
    if (sayBtn) sayBtn.addEventListener('click', function () {
      // 台词由服务端挑并填好占位符（/api/say），前端不再持有整份 talks.json
      json('/api/say').then(function (j) {
        if (j.ok === false || j.error) return toast(j.error || '没读到台词');
        var sayText = $('#sayText');
        if (sayText) sayText.textContent = j.text;
      }).catch(function () { toast('没读到台词'); });
    });

    if (TAB === 'season') bindSeason();
  }

  function openCatchupGoal() {
    var goal = (STATE.catchup_week || {}).goal || 0;
    openDlg('每周补番目标', '<form id="catchupGoalForm"><label class="row"><span>每周想看几集</span>' +
      '<input id="catchupGoalValue" type="number" min="0" max="999" step="1" required value="' + goal + '"></label>' +
      '<p class="note">按北京时间周一至周日统计。填 0 可关闭目标。</p><p id="catchupGoalError" role="alert"></p></form>',
      '<button data-close>取消</button><button class="primary" id="catchupGoalSave" type="submit" form="catchupGoalForm">保存</button>');
    var form = $('#catchupGoalForm'), save = $('#catchupGoalSave');
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      save.disabled = true;
      post('/api/settings', { catchup_goal: Number($('#catchupGoalValue').value) }).then(function (result) {
        if (!result.ok) throw new Error(result.error || '保存失败');
        if (form.isConnected) closeDlg();
        toast('每周目标已保存');
        return refresh();
      }).catch(function (e) {
        if (form.isConnected) $('#catchupGoalError').textContent = e.message || '面板服务未响应';
      }).finally(function () { save.disabled = false; });
    });
  }

  /**
   * 记一话：先改界面，再发请求（乐观更新）。
   *
   * 以前是「点一下 → 等请求 → 整页重绘」：连点第二下会被 BUSY 静默丢掉，
   * 而且每点一次都要重绘整个视图。现在改成：
   *   · 立刻改本地数据与 DOM（paintWatch 只动那一行）
   *   · 260ms 内的连点合并成一个 delta，只发一次请求
   *   · 失败就 refresh() 回到服务端的真相
   */
  var PEND = {};      // id -> 还没发出去的 delta
  var PTIMER = {};    // id -> 合并窗口
  var OUTSTANDING = {}; // 含已排队和正在提交的乐观增量
  var PORDER = {};
  var bumpSeq = 0;

  function flushAllBumps() {
    Object.keys(PEND).sort(function (a, b) { return PORDER[a] - PORDER[b]; }).forEach(flushBump);
  }

  function bump(id, delta) {
    var w = findWatch(id);
    if (!w) return;
    if (w.start_episode > 1 || w.episode_extras?.length) {
      post('/api/progress', { id: id, delta: delta }).then(function (result) {
        if (!result.ok) return toast(result.error || '进度保存失败');
        if (!result.changed) return toast('进度没有变化');
        if (result.became_finished) return showCompletion(id, result.revision);
        toast('进度已保存 · 连续至第 ' + result.ep_status + ' 集 · 累计 ' + result.watched_count + ' 集', { label: '撤销', fn: undo });
        return refresh();
      }).catch(function () { toast('面板服务未响应'); });
      return;
    }
    var seen = num(w.ep_status);
    var total = num(w.eps);
    var next = seen + (delta > 0 ? 1 : -1);
    if (total > 0) next = Math.max(0, Math.min(total, next));
    else next = Math.max(0, next);
    if (next === seen) {
      return toast(delta > 0 ? '已经看到最后一话了' : '已经是最前面了');
    }
    w.ep_status = next;
    paintWatch(id);

    PEND[id] = (PEND[id] || 0) + (next - seen);
    OUTSTANDING[id] = (OUTSTANDING[id] || 0) + (next - seen);
    PORDER[id] = ++bumpSeq;
    clearTimeout(PTIMER[id]);
    PTIMER[id] = setTimeout(function () { flushBump(id); }, 260);

    toast(
      (delta > 0 ? '记了一话' : '退回一话') + ' · ' + (seen + (next - seen)) + '/' + (total || '?'),
      { label: '撤销', fn: undo }
    );
  }

  function flushBump(id) {
    clearTimeout(PTIMER[id]);
    var d = PEND[id];
    delete PEND[id];
    if (d === undefined) return;
    post('/api/progress', { id: id, delta: d, client: 'panel' }).then(function (j) {
      OUTSTANDING[id] -= d;
      if (j.ok === false || j.error) { toast(j.error || '没记上'); return refresh(); }
      if (j.became_finished) return showCompletion(id, j.revision);
      var w = findWatch(id);
      if (TAB === 'catchup' || (w && (w.watch_mode === 'catchup' ||
          ((TAB === 'today' || TAB === 'continue') && d > 0 && !w.last_watched)))) return refresh();
      // 服务端可能把值夹到上限，以它为准；不重绘整页，只校正这一行
      if (w && typeof j.ep_status === 'number') {
        w.ep_status = Math.max(0, j.ep_status + (OUTSTANDING[id] || 0));
        if (num(w.eps) > 0) w.ep_status = Math.min(num(w.eps), w.ep_status);
        paintWatch(id);
      }
    }).catch(function () { OUTSTANDING[id] -= d; toast('服务没响应，请刷新确认进度'); refresh(); });
  }

  function showCompletion(id, revision) {
    toast('已看完，可在番剧库找到', [
      { label: '归档', fn: function () {
        changeWatchState(id, 'archive').catch(function (e) { toast(e.message); });
      } },
      { label: '撤销', fn: function () { undo(revision); } }
    ]);
    return refresh();
  }

  /** 只重绘某一条番的进度数字与进度条（不整页重绘、不打断滚动与焦点） */
  function paintWatch(id) {
    var w = findWatch(id);
    if (!w) return;
    var seen = num(w.ep_status);
    var total = num(w.eps);
    var progress = scheduleProgress(w);
    var cards = document.querySelectorAll('[data-card="' + CSS.escape(String(id)) + '"]');
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      var next = $('[data-schedule-next]', c), count = $('[data-schedule-seen]', c);
      next.textContent = progress.next;
      count.textContent = progress.text;
      count.dataset.scheduleSeen = seen;
      var mark = $('[data-op="1"]', c);
      if (progress.complete) mark.setAttribute('aria-disabled', 'true'); else mark.removeAttribute('aria-disabled');
      $('[data-op="-1"]', c).disabled = !progress.canRewind;
    }
    // 本季表的行没有 data-card（它不是周历卡片），但行内也有 ww/tt 和进度
    var epsCells = document.querySelectorAll('[data-season-id="' + CSS.escape(String(id)) + '"]');
    for (var k = 0; k < epsCells.length; k++) {
      epsCells[k].textContent = seen + '/' + (total || '?');
    }
    // 顶栏「待看 N」跟着变
    paintPending();
  }

  /** 顶栏的「待看 N」：落后 ≥1 话的番有几部（不问时刻、不弹窗，只安静摆着） */
  function paintPending() {
    var btn = $('#pendingBtn');
    if (!btn) return;
    var list = (STATE && STATE.watching) || [];
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      if (watchGap(list[i], list[i].expected_eps) > 0) n += 1;
    }
    if (!n) { btn.hidden = true; return; }
    btn.hidden = false;
    btn.textContent = '待看 ' + n;
    btn.title = '落后至少一话的有 ' + n + ' 部（点开看是哪几部）';
  }

  function showPending() {
    var list = (STATE && STATE.watching) || [];
    var bad = [];
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      var gap = watchGap(w, w.expected_eps);
      if (gap > 0) bad.push({ w: w, gap: gap });
    }
    if (!bad.length) return openDlg('待看', '<div class="empty">没有落后的番，都看齐了。</div>');
    var rows = bad.map(function (x) {
      var name = x.w.name_cn || x.w.name || x.w.id;
      return '<div class="trow" style="grid-template-columns:1fr auto">' +
        '<div class="tn">' + esc(name) + '<small>已看 ' + num(x.w.ep_status) + ' / 本周该看 ' + num(x.w.expected_eps) + '</small></div>' +
        '<div class="ts"><button class="mini" data-op="1" data-id="' + esc(x.w.id) + '">+1</button></div></div>';
    }).join('');
    openDlg('待看 ' + bad.length + ' 部', '<div>' + rows + '</div>',
      '<button data-close>关掉</button>');
    $('#dlg').querySelectorAll('[data-op]').forEach(function (b) {
      b.addEventListener('click', function () {
        bump(b.getAttribute('data-id'), 1);
        closeDlg();
      });
    });
  }

  function removeWatch(id) {
    if (BUSY) return;
    openDlg('移除误加条目', '<div id="removeWatchReview" role="status">正在核对进度和观看历史…</div>',
      '<button data-close>取消</button><button id="removeWatchGo" disabled>移入已移除</button>');
    var status = $('#removeWatchReview'), go = $('#removeWatchGo');
    flushAllBumps();
    POST_CHAIN.then(function () { return sendPost('/api/watch/lifecycle', { id: String(id), action: 'remove', preview: true }); })
      .then(function (reply) {
        if (!status.isConnected) return;
        if (!reply.ok) throw new Error(reply.error);
        var w = reply.detail;
        status.textContent = '《' + w.name + '》会从「' + (WATCH_STATE_LABEL[w.state] || w.state) +
          '」移入「已移除」并停止提醒。保留排片、已看 ' + w.watched_count + ' 集和 ' + reply.history_count +
          ' 笔观看历史；以后可在番库找回。若只是暂时不看，可在详情选择暂停。';
        go.disabled = false;
        go.onclick = function () {
          go.disabled = true;
          post('/api/watch/lifecycle', { id: String(id), action: 'remove', expected_revision: w.revision }).then(function (saved) {
            if (!saved.ok) throw new Error(saved.error);
            closeDlg();
            toast('已移除，可在番库找回', { label: '撤销', fn: function () { undo(saved.revision); } });
            refresh();
          }).catch(function (error) { if (status.isConnected) status.textContent = error.message || '移除失败，请重试。'; });
        };
      }).catch(function (error) { if (status.isConnected) status.textContent = error.message || '打不开本机番库。'; });
  }

  function startOptions() {
    return '<option value="head">从头补</option><option value="seen">填写已看到第几话</option><option value="latest">从最新一话开始</option>';
  }

  function openJoin(count, submit) {
    if (BUSY) return;
    openDlg('加入在追',
      '<form id="joinForm"><p>为 ' + count + ' 部番剧选择起点。最新一话按已知排期估算。</p>' +
      '<label class="row"><span>补番起点</span><select id="joinMode">' + startOptions() + '</select></label>' +
      '<label class="row" id="joinSeenRow" hidden><span>已看到第几话</span><input type="number" id="joinSeen" min="0" value="0" /></label>' +
      '<p id="joinResult" role="status"></p></form>',
      '<button data-close>取消</button><button class="primary" type="submit" form="joinForm" id="joinGo">加入</button>');
    var form = $('#joinForm'), mode = $('#joinMode'), go = $('#joinGo'), result = $('#joinResult');
    mode.addEventListener('change', function () { $('#joinSeenRow').hidden = mode.value !== 'seen'; });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      go.disabled = true;
      submit({ start_mode: mode.value, seen: Number($('#joinSeen').value) }).then(function (response) {
        if (!response.ok) { result.textContent = response.error || '没有加入番库'; return; }
        var count = response.added == null ? Number(!!response.changed) : response.added;
        var skipped = (response.skipped || []).length;
        if (!count && skipped) { result.textContent = '这批番无法确定该起点，请调整选择后再试。'; return; }
        if (form.isConnected) closeDlg();
        toast('已加入 ' + count + ' 部' + (skipped ? '，跳过 ' + skipped + ' 部起点未定的番' : ''));
        SEASON_MARK = {};
        return refresh();
      }).catch(function () { result.textContent = '面板服务未响应'; })
        .finally(function () { go.disabled = false; });
    });
  }

  function addWatch(id, name) {
    openJoin(1, function (start) { return post('/api/watch', Object.assign({ id: id, action: 'add', name: name }, start)); });
  }

  function addFromSeason(id) {
    addSeasonSelection([id]);
  }

  function addSeasonSelection(ids) {
    openJoin(ids.length, function (start) { return post('/api/season/apply', Object.assign({ q: SEASON_Q, add: ids }, start)); });
  }

  function bindSeason() {
    var body = $('#seasonBody');
    if (!body) return;
    var strip = $('.qstrip');
    var activeQuarter = strip && $('.qpill.on', strip);
    if (activeQuarter && (activeQuarter.offsetLeft < strip.scrollLeft ||
        activeQuarter.offsetLeft + activeQuarter.offsetWidth > strip.scrollLeft + strip.clientWidth)) {
      strip.scrollLeft = activeQuarter.offsetLeft - (strip.clientWidth - activeQuarter.offsetWidth) / 2;
    }

    // 行内操作（+ 追 / 记一话 / 移出）用事件委托，整表重画也不用重新绑
    if (!body._opsBound) {
      body._opsBound = true;
      body.addEventListener('click', function (e) {
        var goBtn = e.target.closest('[data-goto]');
        if (goBtn) {
          e.stopPropagation();
          var to = goBtn.getAttribute('data-goto');
          if (to === 'sync') return doSync();
          return switchTab(to);
        }
        var addBtn = e.target.closest('[data-seadd]');
        if (addBtn) {
          e.stopPropagation();
          return addFromSeason(addBtn.getAttribute('data-seadd'));
        }
        var opBtn = e.target.closest('[data-op]');
        if (!opBtn) return;
        e.stopPropagation();
        var id = opBtn.getAttribute('data-id');
        var op = opBtn.getAttribute('data-op');
        if (op === 'remove') return removeWatch(id);
        bump(id, Number(op));
      });
    }

    body.querySelectorAll('[data-mark]').forEach(function (el) {
      el.addEventListener('change', function () {
        var id = el.getAttribute('data-mark');
        if (el.checked) SEASON_MARK[id] = true; else delete SEASON_MARK[id];
      });
    });

    body.querySelectorAll('[data-time]').forEach(function (el) {
      el.addEventListener('click', function (e) { e.stopPropagation(); });
      el.addEventListener('change', function () {
        var id = el.getAttribute('data-time');
        var time = el.value.trim();
        post('/api/season/time', { id: id, time: time }).then(function (j) {
          if (j.ok === false || j.error) { el.value = (findWatch(id) || {}).air_time_cst || ''; return toast(j.error || '没写进去'); }
          toast(time ? '时刻已写入 ' + time : '清空了时刻');
          refresh();
        }).catch(function () { toast('服务没响应'); });
      });
    });

    var onlyTv = $('#onlyTv');
    if (onlyTv && !onlyTv._bound) {
      onlyTv._bound = true;
      var redraw = function () {
        var b = $('#seasonBody');
        if (b) b.innerHTML = seasonBodyHtml();
        bindSeason();
      };
      onlyTv.addEventListener('change', redraw);
      $('#hideWatching').addEventListener('change', redraw);
      $('#onlyTodo').addEventListener('change', redraw);
      $('#sortBy').addEventListener('change', redraw);

      // 批量设时刻：勾了几部就一次写完，省得 167 行里一个个点输入框
      $('#batchTime').addEventListener('click', function () {
        var ids = new Set((SEASON && SEASON.items || []).map(function (item) { return String(item.id); }));
        var entries = (STATE.watching || []).filter(function (item) { return ids.has(String(item.id)); });
        if (!entries.length) return toast('这一季没有在追的番剧');
        openDlg('批量设开播时刻',
          '<form id="batchForm"><div class="sync-changes">' + entries.map(function (item) {
            return '<label class="row"><span>' + esc(item.name_cn || item.name || item.id) + '</span>' +
              '<input type="checkbox" name="ids" value="' + esc(item.id) + '" /></label>';
          }).join('') + '</div>' +
          '<label class="row"><span>时刻</span><input id="btTime" placeholder="如 23:00 或 25:30" required /></label>' +
          '<label class="row"><span>星期</span><select id="btDay"><option value="">保留各自星期</option>' +
          WEEK_ORDER.map(function (day) { return '<option value="' + day + '">周' + CN[day] + '</option>'; }).join('') +
          '</select></label><p id="btStatus" role="status"></p></form>',
          '<button data-close>取消</button><button class="primary" id="btGo" type="submit" form="batchForm">写入</button>');
        $('#batchForm').addEventListener('submit', function (event) {
          event.preventDefault();
          var form = event.currentTarget;
          var selected = new FormData(form).getAll('ids');
          var day = Number($('#btDay').value) || undefined;
          var status = $('#btStatus');
          var go = $('#btGo');
          if (!selected.length) { status.textContent = '请至少选择一部番剧'; return; }
          go.disabled = true;
          post('/api/season/time-batch', { ids: selected, time: $('#btTime').value.trim(), weekday: day }).then(function (result) {
            if (!result.ok) { status.textContent = result.error || '保存失败'; return; }
            var skipped = (result.missing || []).length + (result.needs_weekday || []).length;
            if (form.isConnected) closeDlg();
            toast('已更新 ' + result.count + ' 部' + (skipped ? '，跳过 ' + skipped + ' 部不在追或缺星期的番剧' : ''));
            return refresh();
          }).catch(function () { status.textContent = '面板服务未响应'; })
            .finally(function () { go.disabled = false; });
        });
      });

      var goSeason = function (q) {
        if (!q || q === SEASON_Q) return;
        SEASON_Q = q;
        SEASON_MARK = {};
        SEASON = null;
        var strip = document.querySelector('.qstrip');
        if (strip) {
          strip.querySelectorAll('.qpill').forEach(function (p) {
            p.classList.toggle('on', p.getAttribute('data-q') === SEASON_Q);
          });
        }
        redraw();
        loadSeason(false);
      };
      document.querySelectorAll('.qpill').forEach(function (p) {
        p.addEventListener('click', function () { goSeason(p.getAttribute('data-q')); });
      });
      document.querySelectorAll('.qstep').forEach(function (b) {
        b.addEventListener('click', function () {
          goSeason(shiftSeason(SEASON_Q, Number(b.getAttribute('data-step'))));
        });
      });
      $('#seasonRefresh').addEventListener('click', function () {
        SEASON = null;
        redraw();
        loadSeason(true);
      });
      // 「全选」只勾当前看得见的行（尊重「只看 TV / 隐藏已追 / 搜索」），跟用户眼睛看到的一致
      $('#markAll').addEventListener('click', function () {
        var boxes = $('#seasonBody') ? $('#seasonBody').querySelectorAll('[data-mark]:not(:disabled)') : [];
        for (var i = 0; i < boxes.length; i++) {
          boxes[i].checked = true;
          SEASON_MARK[boxes[i].getAttribute('data-mark')] = true;
        }
      });
      $('#markNone').addEventListener('click', function () {
        SEASON_MARK = {};
        var boxes = $('#seasonBody') ? $('#seasonBody').querySelectorAll('[data-mark]') : [];
        for (var i = 0; i < boxes.length; i++) boxes[i].checked = false;
      });
      $('#applyBtn').addEventListener('click', function () {
        var ids = Object.keys(SEASON_MARK);
        if (!ids.length) return toast('先勾几部');
        addSeasonSelection(ids);
      });

    }
  }

  // ---------------- 弹层 ----------------
  var dlgReturnFocus = null;
  function openDlg(title, bodyHtml, footHtml, options = {}) {
    if (!$('#mask').classList.contains('show')) dlgReturnFocus = document.activeElement;
    var dlg = $('#dlg');
    dlg.classList.toggle('watch-detail-dialog', Boolean(options.watchDetail));
    dlg.innerHTML = '<h3 id="dlgTitle"' + (options.watchDetail ? ' tabindex="-1"' : '') + '>' + esc(title) + '</h3>' +
      '<div class="body">' + bodyHtml + '</div>' +
      '<div class="foot">' + (footHtml || '<button data-close>关掉</button>') + '</div>';
    var mask = $('#mask');
    mask.hidden = false;
    mask.setAttribute('aria-hidden', 'false');
    mask.classList.add('show');
    ['panelHeader', 'panelMain', 'panelFooter', 'toast'].forEach(function (id) { document.getElementById(id).inert = true; });
    $('#dlg').querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', closeDlg);
    });
    // 焦点进弹窗（第一颗按钮或输入框），Esc 关掉后还回去
    dlg.scrollTop = 0;
    var first = options.focus ? $(options.focus, dlg) : dlg.querySelector('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]');
    (first || dlg).focus({ preventScroll: true });
  }
  function closeDlg() {
    var mask = $('#mask');
    if (!mask.classList.contains('show')) return;
    mask.classList.remove('show');
    mask.setAttribute('aria-hidden', 'true');
    mask.hidden = true;
    ['panelHeader', 'panelMain', 'panelFooter', 'toast'].forEach(function (id) { document.getElementById(id).inert = false; });
    var back = dlgReturnFocus;
    dlgReturnFocus = null;
    if (back && back.focus && document.contains(back)) {
      try { back.focus({ preventScroll: true }); } catch (e) { back.focus(); }
    }
  }

  function openWatchDetail(id, episodes) {
    if (!id) return showWatchForm({ ep_status: 0, watch_mode: TAB === 'catchup' ? 'catchup' : 'airing' });
    openDlg('番剧详情', '<p id="watchLoading" role="status">正在读取番剧资料…</p>');
    var marker = $('#watchLoading');
    flushAllBumps();
    POST_CHAIN.then(function () { return json('/api/watch/detail?id=' + enc(id)); }).then(function (j) {
      if (!marker.isConnected) return;
      if (episodes) openEpisodeList(j.detail);
      else showWatchForm(j.detail, j.reminder, j.original);
    }).catch(function (e) {
      if (marker.isConnected) openDlg('读不到番剧详情', '<p role="alert">' + esc(e.message || '请刷新后再试') + '</p>');
    });
  }

  function duplicateRows(matches) {
    var states = Object.assign({ dropped: '已弃番' }, WATCH_STATE_LABEL);
    return '<ul class="duplicate-hits">' + matches.map(function (row) {
      return '<li>' + watchTitle(row.id, row.name, true) +
        ' <small>' + esc([row.year, states[row.state], row.match === 'id' ? '同一 Bangumi 条目' : '名称相同，需核对'].filter(Boolean).join(' · ')) +
        '</small></li>';
    }).join('') + '</ul>';
  }

  function openAnimeSearch() {
    openDlg('跨季度找番', '<form id="animeSearchForm"><label class="watch-field">中文名、原名或别名' +
      '<input type="search" id="animeSearchQuery" required maxlength="100" value="' + esc($('#q').value.trim().slice(0, 100)) + '"></label>' +
      '<button type="submit">搜索 Bangumi</button></form><p id="animeSearchStatus" role="status"></p><div id="animeCandidates"></div>',
      '<button data-close>关闭</button><button type="button" data-new-watch>离线手动添加</button>');
    var form = $('#animeSearchForm'), input = $('#animeSearchQuery'), status = $('#animeSearchStatus'), results = $('#animeCandidates'), request = 0;
    function load(query, offset) {
      var ticket = ++request;
      status.textContent = '正在找番…';
      results.replaceChildren();
      json('/api/anime/search?q=' + enc(query) + '&offset=' + offset).then(function (reply) {
        if (!form.isConnected || request !== ticket) return;
        status.textContent = reply.warning || (reply.candidates.length ? '请核对年份、类型和番库中的同名条目。' : '没有匹配的动画。');
        results.innerHTML = reply.candidates.map(function (item, index) {
          var same = item.duplicates.some(function (row) { return row.match === 'id'; });
          return '<article class="anime-candidate">' + (item.cover ? '<img src="' + esc(item.cover) + '" alt="" loading="lazy">' : '') +
            '<div><strong>' + esc(item.name) + '</strong><p>' + esc([
              item.original_name !== item.name ? item.original_name : '', item.date.slice(0, 4) || '年份未定', item.platform || '动画',
              item.eps ? item.eps + ' 集' : '集数未定', '#' + item.id].filter(Boolean).join(' · ')) + '</p>' +
            (item.duplicates.length ? duplicateRows(item.duplicates) : '') +
            (same ? '' : '<button type="button" data-anime-pick="' + index + '">使用这部番的资料</button>') + '</div></article>';
        }).join('') + (reply.next != null ? '<button type="button" id="animeNext">下一页</button>' : '');
        results.querySelectorAll('img').forEach(function (img) { img.onerror = function () { img.remove(); }; });
        results.querySelectorAll('[data-anime-pick]').forEach(function (button) {
          button.onclick = function () {
            var item = reply.candidates[Number(button.dataset.animePick)];
            showWatchForm({ ep_status: 0, name: item.name, eps: item.eps, watch_mode: 'airing', subject: item });
          };
        });
        if ($('#animeNext')) $('#animeNext').onclick = function () { load(query, reply.next); };
      }).catch(function (error) { if (form.isConnected && request === ticket) status.textContent = error.message || '搜索失败，可手动添加。'; });
    }
    form.onsubmit = function (event) { event.preventDefault(); load(input.value.trim(), 0); };
  }

  function openReminderHistory(watch) {
    openDlg('提醒记录', '<p id="reminderHistoryLoading" role="status">正在读取本机记录…</p>');
    var marker = $('#reminderHistoryLoading');
    var types = { airing: '开播提醒', catchup: '补番提醒', snooze: '稍后提醒', test: '测试提醒' };
    var statuses = { requested: '已请求 Windows 通知', unavailable: '无法请求 Windows 通知', inactive: '单番状态或设置已阻止提醒',
      quiet: '免打扰时段', expired: '已过提醒时段', merged: '已并入同一部番的开播提醒' };
    var actions = { snoozed: '选择了稍后提醒', opened: '已点查看清单', acknowledged: '已点确认', mark_clicked: '已点记一话',
      history_opened: '已点查看提醒记录' };
    function clock(value) {
      if (!value) return '';
      var date = new Date(Number(value) * 1000);
      if (!Number.isFinite(+date)) return '';
      return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    }
    json('/api/reminder/history' + (watch ? '?watch=' + enc(watch) : '')).then(function (result) {
      if (!marker.isConnected) return;
      var events = result.events || [];
      var rows = events.map(function (event, index) {
        var title = event.can_open ? watchTitle(event.watch_id, event.name || '番剧', true) : '<strong>' + esc(event.name || '提醒') + '</strong>';
        var detail = clock(event.scheduled_at) + ' 计划 · ' + clock(event.recorded_at) + ' 处理 · ' + (statuses[event.status] || '已记录');
        var action = actions[event.action] ? clock(event.action_at) + ' ' + actions[event.action] :
          event.status === 'requested' ? '暂无已确认的操作' : '';
        if (event.snoozed_until) action += ' · 下次 ' + clock(event.snoozed_until);
        return '<li><span class="tag mut">' + esc(types[event.kind] || '提醒') + '</span>' + title +
          '<small>' + esc(detail + (event.recovered ? ' · 错过提醒摘要' : '') + (event.bubble ? ' · 气泡渠道已启用' : '')) + '</small>' +
          (action ? '<small>' + esc(action) + '</small>' : '') +
          (event.source_stamp && event.can_open && !event.snoozed_until && Math.abs(Date.now() / 1000 - event.scheduled_at) <= 21600
            ? '<button type="button" data-snooze-event="' + index + '">15 分钟后提醒</button>' : '') + '</li>';
      }).join('');
      openDlg(watch ? '这部番的提醒记录' : '提醒记录', '<p class="note">时间为北京时间。Windows 是否实际显示通知由系统决定。' +
        (result.desktop_online === false ? ' 此安装目录的桌宠当前未连接。' : '') + '</p>' +
        (rows ? '<ul class="reminder-history">' + rows + '</ul>' : '<p>本机还没有提醒记录。可以先在「提醒设置」发送测试提醒。</p>'),
        '<button data-close>关闭</button><button type="button" id="refreshReminderHistory">刷新</button><button type="button" id="openSnoozesFromHistory">稍后提醒</button>');
      $('#refreshReminderHistory').addEventListener('click', function () { openReminderHistory(watch); });
      $('#openSnoozesFromHistory').onclick = openReminderSnoozes;
      $('#dlg').querySelectorAll('[data-snooze-event]').forEach(function (button) {
        button.onclick = function () {
          var row = events[Number(button.dataset.snoozeEvent)];
          button.disabled = true;
          post('/api/reminder/snoozes', { action: 'create', minutes: 15, items: [
            { id: String(row.watch_id), kind: row.kind, slot_at: row.scheduled_at, stamp: row.source_stamp }
          ] }).then(function (reply) {
            if (!reply.ok) throw new Error(reply.error);
            openReminderSnoozes();
          }).catch(function (error) {
            button.disabled = false;
            button.textContent = error.message || '未能设置，请刷新';
          });
        };
      });
    }).catch(function (e) { if (marker.isConnected) marker.textContent = e.message || '暂时读不到提醒记录'; });
  }

  function openReminderSnoozes() {
    openDlg('稍后提醒', '<p class="note">按北京时间显示。暂停、静音、完结或改期后，旧档位不再提醒。</p>' +
      '<p id="snoozeStatus" role="status"></p><div id="snoozeRows"></div>',
      '<button data-close>关闭</button><button type="button" id="snoozeRefresh">刷新</button>');
    var status = $('#snoozeStatus'), rows = $('#snoozeRows'), busy = false;
    function render(items) {
      if (!rows.isConnected) return;
      status.textContent = items.length ? '待生效 ' + items.length + ' 条' : '没有待生效的稍后提醒。';
      rows.innerHTML = items.map(function (item, i) {
        var when = new Date(item.due_at * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false,
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        return '<div class="original-note"><p><strong>' + esc(item.name) + '</strong> · ' +
          (item.kind === 'catchup' ? '补番' : '开播') + ' · ' + esc(when) + '</p><div class="watch-link-list">' +
          '<label>重新设置 <select data-snooze-minutes="' + i + '"><option>5</option><option selected>15</option><option>30</option><option>60</option></select> 分钟后</label>' +
          '<button type="button" data-change-snooze="' + i + '" data-snooze-action="delay">延后</button>' +
          '<button type="button" data-change-snooze="' + i + '" data-snooze-action="cancel">取消提醒</button></div></div>';
      }).join('');
      rows.querySelectorAll('[data-change-snooze]').forEach(function (button) {
        button.onclick = function () {
          if (busy) return;
          var i = Number(button.dataset.changeSnooze), action = button.dataset.snoozeAction;
          busy = button.disabled = true;
          post('/api/reminder/snoozes', { action: action, key: items[i].key, minutes: Number(rows.querySelector('[data-snooze-minutes="' + i + '"]').value) })
            .then(function (reply) {
              if (!reply.ok) throw new Error(reply.error);
              render(reply.pending || []);
            }).catch(function (error) {
              if (status.isConnected) status.textContent = error.message || '本机后台未响应，请刷新';
            }).finally(function () { button.disabled = busy = false; });
        };
      });
    }
    function load() {
      status.textContent = '正在读取…';
      json('/api/reminder/snoozes').then(function (reply) { render(reply.pending || []); })
        .catch(function (error) { if (status.isConnected) status.textContent = error.message || '无法连接本机后台'; });
    }
    $('#snoozeRefresh').onclick = load;
    load();
  }

  function openCalendarExport() {
    var first = STATE?.date || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    var last = new Date(Date.parse(first + 'T00:00:00Z') + 6 * 86400000).toISOString().slice(0, 10);
    openDlg('导出日历',
      '<form id="calendarForm"><div class="watch-fields">' +
      '<label class="watch-field">开始日期<input id="calendarFrom" type="date" required value="' + esc(first) + '"></label>' +
      '<label class="watch-field">结束日期（含）<input id="calendarTo" type="date" required value="' + esc(last) + '"></label>' +
      '</div><p><label><input id="calendarAiring" type="checkbox" checked> 开播</label> ' +
      '<label><input id="calendarCatchup" type="checkbox"> 个人补番</label> ' +
      '<label><input id="calendarAlarm" type="checkbox" checked> 带闹铃</label></p>' +
      '<p class="note">两类都是北京时间（UTC+8）。周一 25:30 在日历里是周二 01:30。可选 1–93 天。' +
      '闹铃沿用提醒设置的提前量和免打扰，只在生成时计算。</p><p id="calendarStatus" role="status"></p></form>' +
      '<details><summary>本机日历订阅试验</summary><p>提供接下来 28 天的在追和个人补番排期。使用能直接访问本机地址的日历客户端，面板服务需保持运行。</p>' +
      '<label class="watch-field">订阅地址<input id="calendarFeedUrl" type="url" readonly></label>' +
      '<button type="button" id="calendarFeedCopy">复制订阅地址</button> <span id="calendarFeedStatus" role="status"></span></details>',
      '<button data-close>关闭</button><button class="primary" type="submit" form="calendarForm">下载 ICS</button>');
    $('#calendarForm').onsubmit = function (event) {
      event.preventDefault();
      var from = $('#calendarFrom').value, to = $('#calendarTo').value;
      var airing = $('#calendarAiring').checked, catchup = $('#calendarCatchup').checked;
      var days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
      if ((!airing && !catchup) || !(days >= 1 && days <= 93)) {
        $('#calendarStatus').textContent = '请选择至少一种类型，并核对日期范围。';
        return;
      }
      location.href = '/api/export?' + new URLSearchParams({ fmt: 'ics', from: from, to: to,
        kind: airing && catchup ? 'both' : airing ? 'airing' : 'catchup', alarm: $('#calendarAlarm').checked ? '1' : '0' });
      $('#calendarStatus').textContent = '已请求下载。';
    };
    var feed = $('#calendarFeedUrl'), copy = $('#calendarFeedCopy'), status = $('#calendarFeedStatus');
    if (location.protocol === 'http:' || location.protocol === 'https:') feed.value = new URL('/api/calendar/feed.ics', location.href).href;
    else { copy.disabled = true; status.textContent = '请从桌宠启动本机面板。'; }
    copy.onclick = function () {
      function selectLink() { feed.focus(); feed.select(); status.textContent = '已选中链接，可以复制。'; }
      if (navigator.clipboard) navigator.clipboard.writeText(feed.value)
        .then(function () { status.textContent = '已复制。'; }, selectLink);
      else selectLink();
    };
  }

  function changeWatchState(id, action, revision, dialog, mode, note) {
    return post('/api/watch/lifecycle', { id: String(id), action: action, expected_revision: revision, mode: mode, note: note }).then(function (j) {
      if (!j.ok) throw new Error(j.error || '没有改成，请重试');
      if (dialog && dialog.isConnected) closeDlg();
      if (j.changed) {
        var messages = { pause: '已暂停，停止开播提醒', archive: '已归档，可在番库找到',
          finish: '已标记看完，可在番库找到', unfinish: '已取消看完标记', resume: '已恢复，保留原进度',
          start: mode === 'catchup' ? '已开始补番' : '已开始追连载', drop: '已移到番库的「已弃番」',
          restore: '已找回到原分组，进度和历史保留' };
        var message = messages[action];
        toast(j.rebuild_error ? '状态已保存，桌宠数据暂未刷新' : message, { label: '撤销', fn: undo });
      }
      return refresh().then(function () {
        if (action === 'start') switchTab(mode === 'catchup' ? 'catchup' : 'today');
      });
    });
  }

  function openWatchBinding(detail) {
    openDlg('绑定 Bangumi', '<form id="bindingForm"><label class="watch-field">Bangumi 条目链接或编号' +
      '<input id="bindingSubject" required maxlength="240" placeholder="https://bgm.tv/subject/123"></label></form>' +
      '<p id="bindingStatus" role="status"></p><div id="bindingReview"></div>',
      '<button type="button" id="bindingBack">返回详情</button><button type="submit" id="bindingPreview" form="bindingForm">预览</button>' +
      '<button type="button" id="bindingApply" class="primary" hidden>确认绑定</button>');
    var form = $('#bindingForm'), input = $('#bindingSubject'), status = $('#bindingStatus'), output = $('#bindingReview');
    var preview = $('#bindingPreview'), apply = $('#bindingApply'), ticket, busy = false;
    $('#bindingBack').onclick = function () { openWatchDetail(detail.id); };
    function resetBinding() { ticket = null; apply.hidden = true; output.replaceChildren(); status.textContent = ''; }
    function setBusy(value) { busy = input.disabled = preview.disabled = apply.disabled = value; }
    function entry(label, item) {
      return '<h4>' + label + '</h4><p><strong>' + esc(item.name) + '</strong> · ' +
        esc(item.release_date || item.year || '首播年份未填写') + ' · ' + esc(WATCH_STATE_LABEL[item.state] || item.state) + '</p>' +
        '<p>原播周档：' + esc(item.schedule_ended ? '已结束' : item.air_weekday ?
          '周' + CN[item.air_weekday] + ' ' + (item.air_time_cst || '时刻未定') : '未排期') + '</p>' +
        '<p>已看 ' + esc(item.ep_status) + '/' + esc(item.eps || '?') + ' · 观看历史 ' + esc(item.history_count) + ' 条' +
        (item.history_recent ? ' · 最近 ' + esc(item.history_recent) : '') + '</p><div class="watch-link-list">' +
        (item.links.map(function (link) { return watchLink(link.url, item.name, link.name); }).join('') || '暂无观看链接') + '</div>';
    }
    input.oninput = resetBinding;
    form.onsubmit = function (event) {
      event.preventDefault();
      previewBinding();
    };
    function previewBinding(scheduleChoice) {
      if (busy) return;
      resetBinding();
      var id = /^(?:https?:\/\/(?:www\.)?(?:bgm\.tv|bangumi\.tv|chii\.in)\/subject\/)?([1-9]\d{0,9})(?:\/?(?:[?#].*)?)$/i.exec(input.value.trim())?.[1];
      if (!id) { status.textContent = '请填写有效的 Bangumi 条目链接或编号。'; return; }
      setBusy(true);
      status.textContent = '正在核对 Bangumi 资料和本机观看历史…';
      post('/api/watch/binding', { id: detail.id, subject_id: id, preview: true, schedule_choice: scheduleChoice }).then(function (reply) {
        if (!form.isConnected) return;
        if (!reply.ok) throw new Error(reply.error);
        var review = reply.review, online = review.online;
        var merging = review.mode === 'merge';
        status.textContent = review.blocked || '请核对首播年份、季数和版本。确认前不会修改番库。';
        output.innerHTML = entry('手动条目', review.source) + '<h4>Bangumi 上的条目</h4><p><a href="https://bgm.tv/subject/' +
          esc(online.id) + '" target="_blank" rel="noopener noreferrer">' + esc(online.name) + ' #' + esc(online.id) +
          '</a> · ' + esc([online.original, online.date || '年份未知', online.platform, online.eps ? online.eps + ' 集' : '集数未知'].filter(Boolean).join(' · ')) + '</p>' +
          (review.target ? entry('番库中已绑定的条目', review.target) : '') +
          (review.schedule_conflict ? '<div class="watch-link-list"><button type="button" id="bindingKeepLocal">预览保留手动条目排期</button>' +
            '<button type="button" id="bindingKeepLinked">预览保留已绑定条目排期</button></div>' : '') +
          (review.result ? entry(merging ? '合并后的条目' : '绑定后的条目',
            Object.assign({}, review.result, { year: online.date?.slice(0, 4) || review.source.year })) : '') +
          (reply.preview_id && merging ? '<p>进度取较大值，两边的观看记录都保留。</p><label class="watch-field">输入 #' +
            esc(online.id) + ' 的编号，确认属于同一季同一版本<input id="bindingConfirm" inputmode="numeric" maxlength="10"></label>' : '');
        ticket = reply.preview_id;
        apply.hidden = !ticket;
        apply.textContent = merging ? '确认合并' : '确认绑定';
        if (review.schedule_conflict) {
          $('#bindingKeepLocal').onclick = function () { previewBinding('local'); };
          $('#bindingKeepLinked').onclick = function () { previewBinding('linked'); };
        }
      }).catch(function (error) {
        if (form.isConnected) status.textContent = error.message || '预览失败，请重试。';
      }).finally(function () { setBusy(false); });
    }
    apply.onclick = function () {
      if (!ticket || busy) return;
      setBusy(true);
      post('/api/watch/binding', { preview_id: ticket, confirm_id: $('#bindingConfirm')?.value.trim() }).then(function (reply) {
        if (!form.isConnected) return;
        if (!reply.ok) throw new Error(reply.error);
        openWatchDetail(reply.review.online.id);
        toast(reply.review.mode === 'merge' ? '已合并两条番剧' : '已绑定 Bangumi', {
          label: '撤销', fn: function () { closeDlg(); undo(reply.revision); },
        });
        refresh();
      }).catch(function (error) {
        if (form.isConnected) status.textContent = error.message || '保存失败，请重新预览。';
      }).finally(function () { setBusy(false); });
    };
  }

  function openBgmWriteback(detail) {
    var episode = Math.max(num(detail.ep_status), ...(detail.episode_extras || []));
    openDlg('回写一集到 Bangumi（试验）',
      '<p>选择本机首轮已经看过的一集，预览账号和单集状态，再确认写到 Bangumi。</p>' +
      '<form id="writebackForm"><label class="watch-field">集数<input id="writebackEpisode" type="number" min="1" max="10000" required value="' +
      esc(episode) + '"></label><button type="submit" id="writebackPreview">读取预览</button></form>' +
      '<p id="writebackStatus" role="status"></p>',
      '<button type="button" id="writebackBack">返回详情</button><button type="button" id="writebackApply" class="primary" disabled>确认标为已看</button>');
    var form = $('#writebackForm'), value = $('#writebackEpisode'), status = $('#writebackStatus');
    var preview = $('#writebackPreview'), apply = $('#writebackApply'), plan = null, ticket = 0;
    $('#writebackBack').onclick = function () { openWatchDetail(detail.id); };
    value.oninput = function () { ++ticket; plan = null; apply.disabled = true; status.textContent = ''; };
    form.onsubmit = function (event) {
      event.preventDefault();
      var current = ++ticket;
      plan = null;
      preview.disabled = apply.disabled = true;
      status.textContent = '正在查询 Bangumi…';
      var ordinal = Number(value.value);
      flushAllBumps();
      POST_CHAIN.then(function () {
        return sendPost('/api/watch/bgm-writeback', { id: detail.id, episode: ordinal, preview: true });
      }).then(function (reply) {
        if (!status.isConnected || current !== ticket) return;
        if (!reply.ok) throw new Error(reply.error || '无法预览');
        plan = reply;
        var names = ['无单集标记', '想看', '已看', '弃看'];
        status.textContent = reply.user + ' · ' + reply.name + ' 第 ' + reply.episode + ' 集' +
          (reply.chapter.title ? '《' + reply.chapter.title + '》' : '') + '。Bangumi 当前状态：' + names[reply.remote] + '。' +
          (reply.remote === 0 || reply.remote === 1 ? '确认时会核对写权限。' : '');
        apply.disabled = reply.remote === 2 || reply.remote === 3;
      }).catch(function (error) {
        if (status.isConnected && current === ticket) status.textContent = error.message || '无法预览';
      }).finally(function () { preview.disabled = false; });
    };
    apply.onclick = function () {
      if (!plan) return;
      value.disabled = preview.disabled = apply.disabled = true;
      status.textContent = '正在核对并写回…';
      sendPost('/api/watch/bgm-writeback', { id: detail.id, episode: plan.episode, confirmation: plan.confirmation })
        .then(function (reply) {
          if (!reply.ok) throw Object.assign(new Error(reply.error || '写回失败'), { status: reply.httpStatus });
          status.textContent = reply.already ? 'Bangumi 已把这集标为已看。' : 'Bangumi 已确认第 ' + reply.episode + ' 集为已看。';
          plan = null;
        }).catch(function (error) {
          status.textContent = error.message || '写回失败';
          if (error.status && error.status !== 502 && error.status !== 429) plan = null;
          apply.disabled = !plan;
        }).finally(function () { value.disabled = preview.disabled = false; });
    };
  }

  function openWatchOrder(detail, reload) {
    openDlg('续作与观看顺序', '<p id="watchOrderStatus" role="status">正在载入关联动画…</p><ol id="watchOrderList" class="watch-order-list"></ol>',
      '<button type="button" id="closeWatchOrder">返回详情</button><button type="button" id="refreshWatchOrder">刷新资料</button>' +
      '<button type="button" id="resetWatchOrder" disabled>恢复建议顺序</button>' +
      '<button type="button" id="saveWatchOrder" class="primary" disabled>保存顺序</button>');
    var status = $('#watchOrderStatus'), list = $('#watchOrderList'), save = $('#saveWatchOrder');
    var reset = $('#resetWatchOrder'), refreshData = $('#refreshWatchOrder'), back = $('#closeWatchOrder');
    back.onclick = function () { openWatchDetail(detail.id); };
    refreshData.disabled = true;
    json('/api/watch/order?id=' + enc(detail.id) + (reload ? '&refresh=1' : '')).then(function (result) {
      if (!status.isConnected) return;
      var items = result.items.slice(), dirty = false, busy = false;
      var messages = {
        bangumi: '资料来自 Bangumi。可按自己的观看顺序排列。',
        cache: '正在使用 Bangumi 资料的本地缓存。',
        offline: result.fetched_at ? '暂时连不上 Bangumi，已显示上次缓存。' : '暂时连不上 Bangumi，当前没有缓存。',
        temporary: '已获得关联资料，但保存缓存失败。可刷新后重试。',
      };
      status.textContent = (messages[result.source] || '') +
        (items.length < 2 && result.fetched_at ? ' 暂无关联动画。' : '');
      function renderOrder() {
        list.innerHTML = items.map(function (row, index) {
          var name = esc(row.name);
          var move = function (direction, label, disabled) {
            return '<button type="button" data-order-index="' + index + '" data-order-step="' + direction + '" aria-label="' +
              esc(label + row.name) + '"' + (disabled ? ' disabled' : '') + '>' + label + '</button>';
          };
          return '<li><div>' + (row.current ? '<strong>' + name + '</strong>' :
            '<a href="https://bgm.tv/subject/' + esc(row.id) + '" target="_blank" rel="noopener noreferrer">' + name + '</a>') +
            '<small>' + esc([row.relation, row.original !== row.name ? row.original : '', '#' + row.id].filter(Boolean).join(' · ')) + '</small></div>' +
            '<div class="watch-link-list">' + move(-1, '上移', index === 0) + move(1, '下移', index === items.length - 1) + '</div></li>';
        }).join('');
        save.disabled = !dirty || busy || result.source === 'temporary';
        reset.disabled = !result.customized || busy;
      }
      list.onclick = function (event) {
        var button = event.target.closest('[data-order-step]');
        if (!button || busy) return;
        var index = Number(button.dataset.orderIndex), step = Number(button.dataset.orderStep), target = index + step;
        var item = items[index];
        items[index] = items[target];
        items[target] = item;
        dirty = true;
        renderOrder();
        (list.querySelector('[data-order-index="' + target + '"][data-order-step="' + step + '"]:not(:disabled)') ||
          list.querySelector('[data-order-index="' + target + '"]:not(:disabled)'))?.focus();
      };
      function persist(order) {
        if (busy) return;
        busy = true;
        refreshData.disabled = true;
        renderOrder();
        post('/api/watch/order', { id: detail.id, expected_revision: result.revision, order: order }).then(function (reply) {
          if (!reply.ok) throw new Error(reply.error);
          toast(order.length ? '已保存观看顺序' : '已恢复建议顺序');
          if (status.isConnected) openWatchOrder(detail, false);
        }).catch(function (error) {
          if (status.isConnected) status.textContent = error.message || '顺序未保存，请重试。';
        }).finally(function () {
          busy = false;
          refreshData.disabled = false;
          if (status.isConnected) renderOrder();
        });
      }
      save.onclick = function () { persist(items.map(function (item) { return item.id; })); };
      reset.onclick = function () { persist([]); };
      renderOrder();
    }).catch(function (error) {
      if (status.isConnected) status.textContent = error.message || '暂时读不到观看顺序。';
    }).finally(function () { refreshData.disabled = false; });
    refreshData.onclick = function () { openWatchOrder(detail, true); };
  }

  function openDropWatch(detail) {
    openDlg('标为弃番', '<form id="dropWatchForm"><p>目前看至第 ' + esc(detail.ep_status) + ' 集。此进度和历史会保留，排片和提醒会停止。</p>' +
      '<label class="watch-field">备注（可选）<textarea id="dropNote" maxlength="500"></textarea></label><p id="dropError" role="alert"></p></form>',
      '<button type="button" id="dropBack">返回详情</button><button type="submit" form="dropWatchForm" id="dropSave">确认弃番</button>');
    var form = $('#dropWatchForm'), button = $('#dropSave'), issue = $('#dropError');
    $('#dropBack').onclick = function () { openWatchDetail(detail.id); };
    form.onsubmit = function (event) {
      event.preventDefault();
      if (button.disabled) return;
      button.disabled = true;
      changeWatchState(detail.id, 'drop', detail.revision, form, undefined, $('#dropNote').value).catch(function (error) {
        if (form.isConnected) issue.textContent = error.message;
      }).finally(function () { button.disabled = false; });
    };
  }

  function rewatchAction(detail, action, round, button) {
    button.disabled = true;
    post('/api/watch/rewatch', { id: detail.id, action: action, round_id: round?.id, expected_revision: detail.revision }).then(function (reply) {
      if (!reply.ok) throw new Error(reply.error);
      if (button.isConnected) openWatchDetail(detail.id);
      toast(action === 'start' ? '已开启一轮重看' : (reply.round.finished_at ? '这轮重看已完成' : '已记重看第 ' + reply.round.ep_status + ' 集'),
        { label: '撤销', fn: function () { closeDlg(); undo(reply.revision); } });
      refresh();
    }).catch(function (error) {
      if (button.isConnected) {
        $('#watchError').hidden = false;
        $('#watchError').textContent = error.message || '重看进度未保存';
      }
    }).finally(function () { button.disabled = false; });
  }

  function watchCstTime(at) {
    var time = new Date(Date.parse(at) + 8 * 3600000);
    return Number.isFinite(+time) ? time.toISOString().slice(0, 16).replace('T', ' ') : '';
  }

  function watchReminderFact(reminder) {
    var messages = { paused: '追番已暂停', archived: '已归档', dropped: '已弃番', removed: '已移除',
      planned: '开始观看后可设置', finished: '已看完', ended: '排片已停止', muted: '本番已静音',
      unscheduled: reminder?.kind === 'catchup' ? '未设置个人补番时段' : '未设置本机排片' };
    var value = watchCstTime(reminder?.at);
    if (!value) return { value: messages[reminder?.status] || '暂无提醒状态' };
    var lead = (Date.parse(reminder.planned_at) - Date.parse(reminder.at)) / 60000;
    var notes = [];
    if (reminder.status === 'quiet') notes.push('免打扰，本次不通知');
    else if (Date.parse(reminder.at) < Date.now()) notes.push('本次提醒时间已过');
    if (lead > 0) notes.push('提前 ' + lead + ' 分钟');
    if (reminder.moved) notes.push('本次已改期');
    return { value: value, at: reminder.at, note: notes.join(' · ') };
  }

  function watchReminderMarkup(fact) {
    return (fact.at ? '<time datetime="' + esc(fact.at) + '">' + esc(fact.value) + '</time>' : esc(fact.value)) +
      (fact.note ? '<small>' + esc(fact.note) + '</small>' : '');
  }

  function watchSummary(detail, reminder, readonly) {
    var info = detail.user_details || {};
    var state = detail.state === 'watching' ? (detail.finished ? 'finished' : detail.watch_mode === 'catchup' ? 'catchup' : 'watching') : detail.state;
    var progress = scheduleProgress(detail);
    var count = detail.watched_count ?? detail.ep_status;
    var playback = watchLink(detail.watch_url, detail.name, info.primary_name || '去观看');
    if (!playback) playback = (info.links || []).map(function (link) {
      return watchLink(link.url, detail.name, link.name || '去观看');
    }).find(Boolean);
    var fact = watchReminderFact(reminder);
    return '<div class="watch-identity"><span id="watchCover">' + cover(detail.id, detail.name) +
      '</span><div><h4>' + esc(detail.name) + '</h4><span class="watch-subject-state">' + esc(WATCH_STATE_LABEL[state] || '番库条目') + '</span></div></div>' +
      '<dl class="watch-summary-facts"><div><dt>观看进度</dt><dd>' +
      (state === 'planned' ? '尚未开始' : '已看 <strong>' + esc(count) + (detail.eps ? ' / ' + esc(detail.eps) : '') + '</strong> 集') +
      '</dd>' + (state === 'planned' ? '' : '<dd><small>' + esc(detail.finished ? '已看完' : progress.next) + '</small></dd>') + '</div>' +
      '<div><dt>播放入口</dt><dd>' + (playback || (readonly ? '暂无已保存入口' :
        '<button type="button" class="watch-summary-link" data-watch-section="watchAboutGroup" data-watch-focus="watchUrl">添加播放入口</button>')) + '</dd></div>' +
      '<div><dt>下次提醒 <span>' + (fact.at ? '北京时间' : '') + '</span></dt><dd>' + watchReminderMarkup(fact) +
      '</dd><dd><button type="button" class="watch-summary-link" data-watch-section="watchScheduleGroup">查看排期与提醒</button></dd></div></dl>';
  }

  function watchScheduleFacts(detail, reminder, original) {
    var cached = formatAiring(original);
    var catchup = detail.watch_mode === 'catchup';
    var slot = catchup ? detail.catchup_slot : { day: detail.air_weekday, time: detail.air_time_cst };
    var local = slot?.day ? '每周' + CN[slot.day] + (slot.time ? ' ' + slot.time : ' · 时刻待定') : '未设置';
    var localNote = catchup ? '个人补番时段' : detail.schedule_source || (detail.schedule_manual ? '手动设置' : '本地周档');
    if (!catchup) {
      if (detail.schedule_manual && detail.schedule_source) localNote += ' · 同步时保护';
      if (detail.schedule_ended) localNote = '排片已停止';
    }
    var plannedAt = reminder?.planned_at || reminder?.at;
    if (reminder?.moved || (plannedAt && detail.schedule_adjustments?.some(function (change) { return change.at === plannedAt; })))
      localNote = '本次改到 ' + watchCstTime(plannedAt);
    return '<dl class="watch-schedule-facts"><div><dt>原播时间</dt><dd><span id="watchOriginal" data-id="' + esc(detail.id) +
      '" data-cached-original="' + esc(cached) + '">' + esc(watchOriginalText(detail.id, cached)) + '</span></dd></div>' +
      '<div><dt>本机排片</dt><dd>' + esc(local) + (slot?.day ? '<small>' + esc(localNote) + '</small>' : '') + '</dd></div>' +
      '<div><dt>实际提醒时间</dt><dd id="watchReminderStatus">' + watchReminderMarkup(watchReminderFact(reminder)) + '</dd></div></dl>';
  }

  function watchGroup(id, title, hint, body, expanded) {
    return '<details class="watch-detail-group" id="' + id + '"' + (expanded ? ' open' : '') +
      '><summary><strong>' + title + '</strong><span>' + hint + '</span></summary><div class="watch-group-content">' + body + '</div></details>';
  }

  function showWatchForm(detail, reminder, original) {
    var archived = detail.state === 'archived';
    var planned = detail.state === 'planned';
    var dropped = detail.state === 'dropped';
    var removed = detail.state === 'removed';
    var readonly = archived || dropped || removed;
    var rounds = detail.rewatches || [];
    var activeRound = rounds.find(function (round) { return !round.finished_at; });
    var canStartRewatch = !removed && (dropped || (detail.finished && !planned));
    var rewatch = !removed && (rounds.length || canStartRewatch) ? '<section class="original-note"><h4>重看</h4><p>首轮 ' +
      (detail.finished ? '已看完' : '看到第 ' + esc(detail.ep_status) + ' 集') + (detail.finished_at ? ' · 首次看完 ' + esc(detail.finished_at) : '') + '</p>' +
      (rounds.length ? '<ul>' + rounds.map(function (round, index) {
        return '<li>第 ' + (rounds.length - index) + ' 轮 · 已看 ' + esc(num(round.ep_status) + (round.episode_extras || []).length) + '/' + esc(round.eps || '?') +
          ' 集' + (round.finished_at ? ' · 看完于 ' + esc(round.finished_at) : ' · 进行中') +
          ' <button type="button" data-episode-round="' + index + '">本轮每话清单</button></li>';
      }).join('') + '</ul>' : '') +
      (activeRound ? '<button type="button" data-rewatch="next">重看记一集</button>' +
        (!activeRound.eps && (activeRound.ep_status || activeRound.episode_extras?.length) ? '<button type="button" data-rewatch="finish">完成这轮重看</button>' : '') :
        (canStartRewatch ? '<button type="button" data-rewatch="start">开启一轮重看</button>' : '')) +
      '</section>' : '';
    var info = detail.user_details || {};
    var entryLinks = (info.links || []).map(function (link) { return watchLink(link.url, detail.name, link.name || '备用入口'); }).join('');
    var note = info.note ? '<details class="watch-wide watch-note"' + (info.spoiler ? '' : ' open') +
      '><summary>' + (info.spoiler ? '展开含剧透的笔记' : '番剧笔记') + '</summary><p>' + esc(info.note) + '</p></details>' : '';
    var controls = '';
    if (removed) {
      controls = '<div class="watch-lifecycle"><span class="tag mut">已移除 · 原状态 ' + esc(WATCH_STATE_LABEL[detail.removed_from]) +
        '</span><button type="button" data-life="restore">找回到原分组</button></div>';
    } else if (dropped) {
      controls = '<div class="watch-lifecycle"><span class="tag mut">已弃番</span>' +
        '<button type="button" data-life="resume">从第 ' + esc(detail.ep_status + 1) + ' 集继续</button></div>' +
        (detail.drop_note ? '<p>弃番备注：' + esc(detail.drop_note) + '</p>' : '');
    } else if (planned) {
      controls = '<div class="watch-lifecycle"><span class="tag mut">待看</span>' +
        '<button type="button" data-life="start" data-mode="airing">开始追连载</button>' +
        '<button type="button" data-life="start" data-mode="catchup">开始补番</button></div>';
    } else if (detail.id) {
      controls = '<div class="watch-lifecycle"><span class="tag mut">' + WATCH_STATE_LABEL[!archived && detail.finished ? 'finished' :
        detail.state === 'watching' && detail.watch_mode === 'catchup' ? 'catchup' : detail.state] + '</span>' +
        (archived ? '<button type="button" data-life="resume">取消归档</button>' : '') +
        (!detail.finished && !archived ? (detail.state === 'watching' ? '<button type="button" data-life="pause">暂停追番</button>' :
          '<button type="button" data-life="resume">继续追番</button>') : '') +
        (!archived && detail.finished ? '<button type="button" data-life="archive">归档已看完</button>' : '') +
        (!archived && (detail.manual_finished || !detail.eps) ?
          (detail.manual_finished ? '<button type="button" data-life="unfinish">取消已看完标记</button>' :
            '<button type="button" data-life="finish">标记已看完</button>') : '') +
        (!archived && !detail.finished ? '<button type="button" id="watchDrop">标为弃番</button>' : '') +
        '</div>';
    }
    var opts = '<option value="">未排期</option>' + WEEK_ORDER.map(function (d) {
      return '<option value="' + d + '"' + (d === detail.air_weekday ? ' selected' : '') + '>周' + CN[d] + '</option>';
    }).join('');
    var personal = detail.catchup_slot || {};
    var personalDays = '<option value="">未安排</option>' + WEEK_ORDER.map(function (d) {
      return '<option value="' + d + '"' + (d === personal.day ? ' selected' : '') + '>周' + CN[d] + '</option>';
    }).join('');

    var existing = Boolean(detail.id);
    var fields = '<fieldset class="watch-fields" data-watch-fields' + (readonly ? ' disabled' : '') + '>';
    var progressGroup = watchGroup('watchProgressGroup', '进度', '观看方式、补记与每话清单', fields +
      '<label class="watch-field watch-wide"' + (planned ? ' hidden' : '') + '>观看方式<select id="watchMode"><option value="airing">追连载</option><option value="catchup"' +
      (detail.watch_mode === 'catchup' ? ' selected' : '') + '>补番</option>' + (!existing ? '<option value="planned">加入待看</option>' : '') + '</select></label>' +
      (!existing ? '<label class="watch-field watch-wide" data-watch-mode="airing catchup">追番起点<select id="watchStart">' +
        startOptions().replace('value="seen"', 'value="seen" selected') + '</select></label>' +
        '<label class="watch-field watch-wide" id="watchLatestRow" hidden>最新一话是第几话<input id="watchLatest" type="number" min="1" /></label>' : '') +
      '<label class="watch-field" data-watch-mode="airing catchup">连续看到第几集<input id="watchSeen" type="number" min="0" step="1" required inputmode="numeric" value="' + esc(detail.ep_status) + '" /></label>' +
      '<p class="watch-wide watch-hint" data-watch-mode="airing catchup">改连续进度用于更正记录。补记观看或补看跳过的集数时，可用下方的观看工具。</p>' +
      (detail.episode_extras?.length ? '<p class="watch-wide watch-hint">累计已看 ' + esc(detail.watched_count) + ' 集。修改连续进度会重设跳集记录。</p>' : '') +
      (detail.start_episode > 1 ? '<p class="watch-wide watch-hint">记录从第 ' + esc(detail.start_episode) + ' 集开始。</p>' : '') +
      '</fieldset>' + (existing ? '<div class="watch-group-actions">' +
        (!planned ? '<button type="button" id="watchEpisodesOpen">首轮每话清单</button>' : '') +
        (detail.state === 'watching' && !detail.finished ? '<button type="button" id="watchBackfill">补记观看</button>' : '') +
        '<button type="button" id="watchEntryHistory">观看历史</button></div>' : '') + rewatch, !existing);
    var scheduleGroup = watchGroup('watchScheduleGroup', '排期与提醒', '原播时间、本机排片、实际提醒时间',
      (existing ? '<div id="watchScheduleFacts">' + watchScheduleFacts(detail, reminder, original) + '</div>' : '') + fields +
      '<label class="watch-field" data-watch-mode="airing">本机排片星期<select id="watchDay">' + opts + '</select></label>' +
      '<label class="watch-field" data-watch-mode="airing">本机排片时间<input id="watchTime" type="text" maxlength="12" placeholder="如 23:30" aria-describedby="watchTimeHint" value="' + esc(detail.air_time_cst) + '" /></label>' +
      '<label class="watch-field" data-watch-mode="catchup">个人补番星期<select id="catchupDay">' + personalDays + '</select></label>' +
      '<label class="watch-field" data-watch-mode="catchup">个人补番时间<input id="catchupTime" type="time" value="' + esc(personal.time) + '" /></label>' +
      '<p id="watchTimeHint" class="watch-wide watch-hint" data-watch-mode="airing">北京时间。周一 25:30 等于周二 01:30；时间可留空。</p>' +
      '<p class="watch-wide watch-hint" data-watch-mode="catchup">按北京时间填写你的观看时段。实际提醒还会应用提前量与免打扰设置。</p>' +
      (planned ? '<p class="watch-wide watch-hint">开始观看后可设置本机排片和提醒。</p>' : '') +
      (!readonly ? '<div class="watch-wide watch-lookup" data-watch-mode="airing"><button type="button" id="watchLookup">联网查原播时间</button>' +
        '<a href="https://github.com/bangumi-data/bangumi-data" target="_blank" rel="noopener noreferrer">资料来源 ↗</a></div>' +
        '<div id="watchMatches" class="watch-wide" role="status" hidden></div>' : '') +
      '</fieldset>' + (existing ? '<div class="watch-group-actions">' +
        (detail.state === 'watching' && !detail.finished && detail.watch_mode !== 'catchup' ? '<button type="button" id="watchSchedule">临时改期与静音</button>' : '') +
        '<button type="button" id="watchReminderHistory">本番提醒记录</button></div>' : ''), false);
    var aboutGroup = watchGroup('watchAboutGroup', '番剧资料', '番名、总集数、播放链接与条目管理', fields +
      (!existing ? '<div class="watch-wide"><label class="watch-field">Bangumi 条目链接（可选）' +
        '<input id="catchupSubjectLink" type="text" maxlength="400" placeholder="https://bgm.tv/subject/…" /></label>' +
        '<button type="button" id="catchupLookup">读取番名与集数</button><p id="catchupLookupStatus" role="status"></p></div>' : '') +
      '<label class="watch-field watch-wide">番名<input id="watchName" type="text" maxlength="160" required value="' + esc(detail.name) + '" /></label>' +
      '<label class="watch-field">总集数<input id="watchTotal" type="number" min="1" step="1" inputmode="numeric" placeholder="未知可留空" value="' + esc(detail.eps) + '" /></label>' +
      '<label class="watch-field watch-wide">首选播放链接<input id="watchUrl" type="url" maxlength="2048" placeholder="https://…" value="' + esc(detail.watch_url) + '" /></label>' +
      (!readonly ? '<div class="watch-wide watch-lookup"><span id="watchBroadcastHint" role="status"></span>' +
        (/^[1-9]\d*$/.test(detail.id || '') && !detail.finished ? '<button type="button" id="watchBroadcastCheck">查播出状态</button><button type="button" id="watchBroadcastCatchup" hidden>转为补番</button>' : '') + '</div>' : '') +
      '</fieldset>' + (entryLinks ? '<div class="watch-group-actions" aria-label="备用播放入口">' + entryLinks + '</div>' : '') + note +
      (existing ? '<div class="watch-group-actions">' +
        (/^[1-9]\d{0,9}$/.test(detail.id) ? '<button type="button" id="watchCoverRetry">联网重试封面</button><span id="watchCoverStatus" role="status"></span>' : '') +
        '<button type="button" id="watchPreferences">整理标签、笔记与观看入口</button>' +
        (/^[1-9]\d{0,9}$/.test(detail.id) ? '<button type="button" id="watchOrder">续作与观看顺序</button>' +
          (!removed && detail.watched_count > 0 ? '<button type="button" id="watchBgmWriteback">回写一集到 Bangumi</button>' : '') : '') +
        (detail.id.startsWith('local-') ? '<button type="button" id="watchBinding">绑定 Bangumi</button>' : '') +
        (!removed ? '<button type="button" id="watchRemove" class="watch-danger">移除误加条目</button>' : '') + '</div>' : '') +
      (detail.state === 'watching' ? controls : ''), !existing);
    openDlg(existing ? '番剧详情' : '手动添加番剧',
      '<form id="watchForm">' + (existing ? '<section id="watchSummary" aria-label="番剧概要">' + watchSummary(detail, reminder, readonly) + '</section>' : '') +
      (existing && detail.state !== 'watching' ? controls : '') +
      (existing ? progressGroup + scheduleGroup + aboutGroup : aboutGroup + progressGroup + scheduleGroup) +
      '<p id="watchError" class="watch-error" role="alert" hidden></p><div id="duplicateReview"></div></form>',
      '<button type="button" data-close>' + (readonly ? '关闭' : '取消') + '</button>' +
      (readonly ? '' : '<button type="submit" form="watchForm" id="watchSave" class="primary">' + (existing ? '保存修改' : '加入在追') + '</button>'),
      { watchDetail: true, focus: existing ? '#dlgTitle' : '#watchName' });
    var form = $('#watchForm');
    form.addEventListener('click', function (event) {
      var shortcut = event.target.closest('[data-watch-section]');
      if (!shortcut) return;
      var group = document.getElementById(shortcut.dataset.watchSection);
      group.open = true;
      var target = shortcut.dataset.watchFocus ? document.getElementById(shortcut.dataset.watchFocus) : $('summary', group);
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'nearest' });
    });
    form.addEventListener('invalid', function (event) {
      var group = event.target.closest('.watch-detail-group');
      if (group) group.open = true;
    }, true);
    var writeback = $('#watchBgmWriteback');
    if (writeback) writeback.onclick = function () { openBgmWriteback(detail); };
    var retryCover = $('#watchCoverRetry');
    if (retryCover) retryCover.onclick = function () {
      var status = $('#watchCoverStatus');
      retryCover.disabled = true;
      status.textContent = '正在查询封面…';
      sendPost('/api/watch/cover', { id: detail.id }).then(function (result) {
        if (!result.ok) throw new Error(result.error || '暂时取不到封面');
        missingCovers.delete(String(detail.id));
        coverVersions.set(String(detail.id), Date.now());
        if (status.isConnected) {
          $('#watchCover').innerHTML = cover(detail.id, detail.name);
          status.textContent = result.source === 'cached' ? '仍可使用现有的本地封面。' : '封面已保存，离线也可查看。';
        }
        render();
      }).catch(function (error) {
        if (status.isConnected) status.textContent = error.message || '暂时取不到封面';
      }).finally(function () { retryCover.disabled = false; });
    };
    var name = $('#watchName', form), seen = $('#watchSeen', form), total = $('#watchTotal', form);
    var day = $('#watchDay', form), time = $('#watchTime', form), url = $('#watchUrl', form), error = $('#watchError', form);
    var matches = $('#watchMatches', form), lookup = $('#watchLookup', form);
    var save = $('#watchSave');
    var mode = $('#watchMode'), personalDay = $('#catchupDay'), personalTime = $('#catchupTime');
    var subjectInfo = detail.subject || null, subject = subjectInfo?.id || null;
    var subjectLink = $('#catchupSubjectLink'), subjectLookup = $('#catchupLookup'), subjectStatus = $('#catchupLookupStatus');
    var broadcastHint = $('#watchBroadcastHint'), broadcastCheck = $('#watchBroadcastCheck'), catchupAction = $('#watchBroadcastCatchup');
    var modePicked = !detail.id && detail.watch_mode === 'catchup', broadcastChecked = false, broadcastLoading = false;
    function updateWatchMode() {
      var deferred = planned || mode.value === 'planned';
      var selectedMode = deferred ? 'planned' : mode.value;
      form.querySelectorAll('[data-watch-mode]').forEach(function (field) { field.hidden = !field.dataset.watchMode.split(' ').includes(selectedMode); });
      personalTime.required = mode.value === 'catchup' && !!personalDay.value;
      if (mode.value !== 'airing' && start && start.value === 'latest') {
        start.value = 'seen';
        start.dispatchEvent(new Event('change'));
      }
      seen.disabled = deferred || Boolean(start && start.value !== 'seen');
      if (start) start.querySelector('[value="latest"]').hidden = mode.value !== 'airing';
      if (save && !detail.id) save.textContent = deferred ? '加入待看' : mode.value === 'catchup' ? '加入补番' : '加入在追';
    }
    mode.addEventListener('change', function () { modePicked = true; updateWatchMode(); });
    personalDay.addEventListener('change', function () { if (!personalDay.value) personalTime.value = ''; updateWatchMode(); });
    function checkBroadcast(id) {
      if (!broadcastHint || !id) return;
      broadcastChecked = false;
      broadcastLoading = true;
      if (broadcastCheck) broadcastCheck.disabled = true;
      if (catchupAction) catchupAction.hidden = true;
      broadcastHint.textContent = '正在核对原播是否结束…';
      json('/api/broadcast/status?id=' + enc(id) + '&refresh=1').then(function (reply) {
        if (!form.isConnected || (!detail.id && subject !== id)) return;
        broadcastChecked = true;
        broadcastHint.textContent = broadcastLabel(reply.status);
        if (reply.status.state === 'ended') {
          if (catchupAction) catchupAction.hidden = mode.value === 'catchup';
          if (!detail.id && !modePicked && mode.value !== 'planned') {
            mode.value = 'catchup';
            updateWatchMode();
          }
        } else if (!detail.id && !modePicked && mode.value === 'catchup') {
          mode.value = 'airing';
          updateWatchMode();
        }
      }).catch(function () {
        if (form.isConnected && (detail.id || subject === id)) broadcastHint.textContent = '暂时查不到播出状态，可以手动选择观看方式。';
      }).finally(function () {
        if (detail.id || subject === id || subject == null) broadcastLoading = false;
        if (broadcastCheck) broadcastCheck.disabled = false;
      });
    }
    if (broadcastCheck) broadcastCheck.onclick = function () { checkBroadcast(detail.id); };
    if (catchupAction) catchupAction.onclick = function () {
      mode.value = 'catchup';
      mode.dispatchEvent(new Event('change'));
      catchupAction.hidden = true;
    };
    if (subjectLink) subjectLink.addEventListener('input', function () {
      subject = subjectInfo = null;
      subjectStatus.textContent = '';
      if (broadcastHint) broadcastHint.textContent = '';
      if (!modePicked && mode.value === 'catchup') { mode.value = 'airing'; updateWatchMode(); }
    });
    if (subjectLookup) subjectLookup.addEventListener('click', function () {
      var link = subjectLink.value.trim();
      subjectLookup.disabled = true;
      subjectStatus.textContent = '正在读取条目…';
      json('/api/catchup/subject?link=' + enc(link)).then(function (entry) {
        if (subjectLink.value.trim() !== link) return;
        subject = entry.id;
        subjectInfo = entry;
        name.value = entry.name;
        total.value = entry.eps == null ? '' : entry.eps;
        subjectStatus.textContent = '资料已填入，确认后保存。';
        checkBroadcast(subject);
      }).catch(function (e) {
        if (subjectLink.value.trim() !== link) return;
        subjectStatus.textContent = e.message || '读取失败，可以手动添加。';
        if (e.status === 409 && e.body && e.body.id) {
          var existing = document.createElement('button');
          existing.type = 'button';
          existing.textContent = '打开原条目';
          existing.addEventListener('click', function () { openWatchDetail(e.body.id); });
          subjectStatus.appendChild(existing);
        }
      }).finally(function () { subjectLookup.disabled = false; });
    });
    var adopted = null;
    var start = $('#watchStart', form), latest = $('#watchLatest', form);
    if (start) start.addEventListener('change', function () {
      latest.required = start.value === 'latest';
      $('#watchLatestRow').hidden = !latest.required;
      seen.disabled = start.value !== 'seen';
    });
    updateWatchMode();
    if (!detail.id && subject) checkBroadcast(subject);
    var draftFields = [
      [name, '番名', function (d) { return d.name; }],
      [seen, '进度', function (d) { return d.ep_status; }],
      [total, '总集数', function (d) { return d.eps; }],
      [day, '开播星期', function (d) { return d.air_weekday; }],
      [time, '开播时刻', function (d) { return d.air_time_cst; }],
      [url, '观看链接', function (d) { return d.watch_url; }],
      [mode, '观看方式', function (d) { return d.watch_mode; }],
      [personalDay, '补番提醒星期', function (d) { return d.catchup_slot?.day; }],
      [personalTime, '补番提醒时刻', function (d) { return d.catchup_slot?.time; }],
    ];
    function recheckWatch() {
      var box = $('#duplicateReview', form);
      box.innerHTML = '<button type="button" id="loadWatchConflict">读取最新版本，保留我的输入</button>';
      $('#loadWatchConflict', box).onclick = function () {
        var button = this;
        button.disabled = true;
        json('/api/watch/detail?id=' + enc(detail.id)).then(function (reply) {
          if (!form.isConnected) return;
          var current = reply.detail, collisions = [];
          if (current.state !== detail.state) {
            showError('该番的状态已改变，无法在此保存。仍可复制你的输入。');
            return;
          }
          draftFields.forEach(function (row) {
            var previous = String(row[2](detail) ?? ''), latest = String(row[2](current) ?? '');
            if (row[0].value === previous) row[0].value = latest;
            else if (previous !== latest && row[0].value !== latest) collisions.push(row[1] + '（本机 ' + (latest || '空') + '）');
          });
          detail = current;
          reminder = reply.reminder;
          personal = detail.catchup_slot || {};
          $('#watchSummary', form).innerHTML = watchSummary(detail, reminder, readonly);
          $('#watchScheduleFacts', form).innerHTML = watchScheduleFacts(detail, reminder, reply.original);
          updateWatchMode();
          box.replaceChildren();
          showError(collisions.length ? '同一字段两边都修改了：' + collisions.join('、') + '。目前保留你的输入，核对后再点保存。'
            : '已读取最新版本，并合入你没有编辑的字段。请核对后再点保存。');
        }).catch(function () { if (form.isConnected) showError('暂时读不到最新版本，你的输入仍在。'); })
          .finally(function () { button.disabled = false; });
      };
    }
    var saving = false;
    function setBusy(value) {
      saving = value;
      if (save) save.disabled = value;
      form.querySelectorAll('[data-watch-fields]').forEach(function (fieldset) { fieldset.disabled = value || readonly; });
      form.querySelectorAll('[data-life]').forEach(function (b) { b.disabled = value; });
    }
    function showError(message) {
      error.textContent = message;
      error.hidden = false;
      if (error.isConnected) error.scrollIntoView({ block: 'nearest' });
    }
    function edited() {
      return name.value.trim() !== detail.name || Number(seen.value) !== detail.ep_status ||
        (Number(total.value) || null) !== detail.eps || (Number(day.value) || null) !== detail.air_weekday ||
        (time.value.trim() || null) !== detail.air_time_cst ||
        (url.value.trim() || null) !== (detail.watch_url || null) || adopted || mode.value !== (detail.watch_mode || 'airing') ||
        (Number(personalDay.value) || null) !== (personal.day || null) || (personalTime.value || null) !== (personal.time || null);
    }
    if (detail.id) $('#watchPreferences').addEventListener('click', function () {
      if ((!archived && edited()) || saving) return showError('请先保存当前详情，再编辑个人资料');
      openWatchPreferences(detail);
    });
    if (detail.id) $('#watchReminderHistory').addEventListener('click', function () {
      if ((!archived && edited()) || saving) return showError('请先保存当前详情，再查看提醒记录');
      openReminderHistory(detail.id);
    });
    var order = $('#watchOrder', form);
    if (order) order.addEventListener('click', function () {
      if ((!archived && edited()) || saving) return showError('请先保存当前详情，再查看观看顺序');
      openWatchOrder(detail, false);
    });
    var binding = $('#watchBinding', form);
    if (binding) binding.addEventListener('click', function () {
      if ((!archived && edited()) || saving) return showError('请先保存当前详情，再绑定 Bangumi');
      openWatchBinding(detail);
    });
    if (detail.id) $('#watchEntryHistory').onclick = function () {
      if ((!archived && edited()) || saving) return showError('请先保存当前详情，再查看观看历史');
      openWatchHistory(new URLSearchParams({ id: String(detail.id) }));
    };
    if ($('#watchDrop', form)) $('#watchDrop', form).onclick = function () {
      if (saving || edited()) return showError('请先保存详情修改，再标为弃番');
      openDropWatch(detail);
    };
    form.querySelectorAll('[data-rewatch]').forEach(function (button) {
      button.onclick = function () {
        if (saving || (!readonly && edited())) return showError('请先保存详情修改，再操作重看');
        rewatchAction(detail, button.dataset.rewatch, activeRound, button);
      };
    });
    var backfill = $('#watchBackfill');
    if ($('#watchEpisodesOpen', form)) $('#watchEpisodesOpen', form).onclick = function () {
      if (!readonly && edited() || saving) return showError('请先保存或撤回当前详情修改。');
      openEpisodeList(detail);
    };
    form.querySelectorAll('[data-episode-round]').forEach(function (button) {
      button.onclick = function () {
        if (!readonly && edited() || saving) return showError('请先保存或撤回当前详情修改。');
        openEpisodeList(detail, rounds[Number(button.dataset.episodeRound)]);
      };
    });
    if ($('#watchRemove', form)) $('#watchRemove', form).onclick = function () {
      if (!readonly && edited() || saving) return showError('请先保存或撤回当前详情修改。');
      removeWatch(detail.id);
    };
    if (backfill) backfill.addEventListener('click', function () {
      if (edited() || saving) return showError('请先保存当前详情，再补记观看');
      openWatchBackfill(detail);
    });
    var schedule = $('#watchSchedule', form);
    if (schedule) schedule.addEventListener('click', function () {
      if (saving) return;
      if (edited()) return showError('请先保存详情修改，再调整排期。');
      openScheduleControls(detail);
    });
    form.querySelectorAll('[data-life]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (saving) return;
        if (!archived && edited()) {
          return showError('请先保存详情修改，再调整追番状态。');
        }
        error.hidden = true;
        setBusy(true);
        changeWatchState(detail.id, b.getAttribute('data-life'), detail.revision, form, b.dataset.mode)
          .catch(function (e) { showError(e.message || '没有改成，请重试'); })
          .finally(function () { setBusy(false); });
      });
    });

    if (readonly) return;

    day.addEventListener('change', function () { if (!day.value) time.value = ''; });

    lookup.addEventListener('click', function () {
      var query = name.value.trim();
      matches.hidden = false;
      if (!query) { matches.textContent = '请先填番名'; name.focus(); return; }
      lookup.disabled = true;
      matches.textContent = '正在查周播时刻…';
      // This request only searches; it does not change the last library write or its undo target.
      sendPost('/api/schedule/lookup', { id: detail.id, name: query, original_only: true, force: true }).then(function (j) {
        if (!form.isConnected) return;
        if (!j.ok) { matches.textContent = j.error || '查时刻失败，可以手填后保存。'; return; }
        var candidates = j.candidates || [];
        if (!candidates.length) {
          matches.textContent = '暂无可用的原播周档。可检查番名，或手动设置提醒。';
          return;
        }
        matches.textContent = '';
        var hint = document.createElement('p');
        hint.textContent = '本机：' + (detail.air_weekday ? '周' + CN[detail.air_weekday] + ' ' +
          (detail.air_time_cst || '时刻未定') : '未排期') + '。下方是查到的原播周档（北京时间）。不选择即可保留现状。';
        matches.appendChild(hint);
        candidates.forEach(function (item) {
          var button = document.createElement('button');
          button.type = 'button';
          var label = document.createElement('strong');
          label.textContent = item.name;
          var caption = document.createElement('span');
          caption.textContent = formatAiring(item) + ' · ' + item.source +
            (item.fetched_at ? ' · ' + (item.cached ? '缓存于 ' : '查于 ') + new Date(item.fetched_at).toLocaleString('zh-CN') : '') +
            (item.original_name !== item.name ? ' · ' + item.original_name : '') + ' · 采用为长期周档';
          button.appendChild(label);
          button.appendChild(caption);
          button.addEventListener('click', function () {
            day.value = String(item.weekday);
            time.value = item.time_cst;
            adopted = item;
            matches.textContent = '已填入周' + CN[item.weekday] + ' ' + item.time_cst + '。保存后生效。';
            time.focus();
          });
          matches.appendChild(button);
          if (detail.id && detail.state === 'watching' && !detail.finished && !detail.schedule_ended &&
              detail.air_time_cst && item.next && item.next !== reminder?.at) {
            var once = document.createElement('button');
            once.type = 'button';
            once.textContent = '预览只改下一次';
            once.onclick = function () {
              if (edited()) return showError('请先保存或撤回详情中的修改。');
              var at = new Date(Date.parse(item.next) + 8 * 3600000).toISOString().slice(0, 16);
              var decision = document.createElement('p');
              decision.textContent = '只将下一次改到 ' + at.replace('T', ' ') + '（北京时间），原播周档不变。 ';
              var confirm = document.createElement('button');
              confirm.type = 'button';
              confirm.textContent = '确认这一次改期';
              decision.appendChild(confirm);
              once.replaceWith(decision);
              confirm.onclick = function () {
                if (edited()) return showError('请先保存或撤回详情中的修改。');
                confirm.disabled = true;
                post('/api/watch/schedule', { id: detail.id, action: 'move', at: at, expected_revision: detail.revision })
                  .then(function (result) {
                    if (!result.ok) { showError(result.error); return; }
                    toast('已保存单次改期');
                    openWatchDetail(detail.id);
                    refresh();
                  }).catch(function () { showError('本机后台未响应，请核对后再试。'); })
                  .finally(function () { confirm.disabled = false; });
              };
            };
            matches.appendChild(once);
          }
        });
      }).catch(function () { matches.textContent = '查询未完成，可以手填后保存。'; })
        .finally(function () { lookup.disabled = false; });
    });

    function submitWatch(duplicateRevision) {
      if (saving) return;
      if (broadcastLoading && !detail.id && !modePicked && mode.value !== 'planned') {
        showError('播出状态正在核对。请稍候，或手动选择观看方式。');
        return;
      }
      error.hidden = true;
      $('#duplicateReview').replaceChildren();
      var payload = { id: detail.id, expected_revision: detail.revision, name: name.value.trim(),
        eps: total.value === '' ? null : Number(total.value), ep_status: Number(seen.value),
        air_weekday: day.value ? Number(day.value) : null, air_time_cst: time.value.trim() || null, watch_url: url.value.trim() || null };
      if (mode.value === 'planned') {
        payload.planned = true;
        payload.ep_status = 0;
        payload.air_weekday = null;
        payload.air_time_cst = null;
      } else if (modePicked) {
        payload.watch_mode = mode.value;
      }
      if (!detail.id) {
        payload.check_duplicates = true;
        payload.duplicate_revision = duplicateRevision;
        if (subject) {
          payload.subject_id = subject;
          payload.broadcast_checked = broadcastChecked;
          if (subject === subjectInfo?.id) {
            payload.release_date = subjectInfo.date;
            payload.original_name = subjectInfo.original_name;
          }
        }
      }
      if (mode.value === 'catchup') {
        if (personalTime.value && !personalDay.value) { showError('请为补番提醒选择星期'); return; }
        payload.catchup_slot = personalDay.value ? { day: Number(personalDay.value), time: personalTime.value } : null;
      }
      if (start && !payload.planned) {
        payload.start_mode = start.value;
        if (start.value !== 'seen') payload.ep_status = 0;
        if (start.value === 'latest') payload.latest_episode = Number(latest.value);
      }
      if (adopted && payload.air_weekday === adopted.weekday && payload.air_time_cst === adopted.time_cst) {
        payload.schedule_source = adopted.source;
        payload.schedule_fetched_at = adopted.fetched_at;
      }
      setBusy(true);
      post('/api/watch/detail', payload).then(function (j) {
        if (!j.ok) {
          showError(j.error || '保存失败');
          if (j.duplicates?.length && form.isConnected) {
            $('#duplicateReview').innerHTML = duplicateRows(j.duplicates) + (j.duplicate_revision ?
              '<button type="button" id="duplicateAdd">确认是另一部，继续添加</button>' : '');
            if ($('#duplicateAdd')) $('#duplicateAdd').onclick = function () { submitWatch(j.duplicate_revision); };
          } else if (j.httpStatus === 409 && detail.id && form.isConnected) recheckWatch();
          return;
        }
        if (form.isConnected) closeDlg();
        if (j.changed && j.detail.finished && !detail.finished) {
          if (j.added) switchTab('library');
          return showCompletion(j.detail.id, j.revision);
        }
        if (j.changed) toast(j.rebuild_error ? '已保存，桌宠数据暂未刷新' :
          (j.added ? (j.detail.state === 'planned' ? '已加入待看' :
            j.detail.watch_mode === 'catchup' ? '已加入补番' : '已加入在追') : '详情已保存'), { label: '撤销', fn: undo });
        return refresh().then(function () {
          if (j.added || (detail.watch_mode && detail.watch_mode !== j.detail.watch_mode && j.detail.state === 'watching' && !j.detail.finished)) {
            if (j.detail.state === 'planned') {
              libraryFilter = 'planned';
              libraryView = { year: '', tag: '', link: '' };
              return switchTab('library');
            }
            switchTab(j.detail.watch_mode === 'catchup' ? 'catchup' : j.detail.air_weekday ? 'week' : 'today');
          }
        });
      }).catch(function () { error.textContent = '服务没有响应，请刷新后确认是否已经保存'; error.hidden = false; })
        .finally(function () { setBusy(false); });
    }
    form.addEventListener('submit', function (event) { event.preventDefault(); submitWatch(); });
  }

  function openWatchPreferences(detail) {
    var info = detail.user_details || {};
    var links = (detail.watch_url ? [{ url: detail.watch_url, name: info.primary_name }] : []).concat(info.links || []);
    var rows = Array.from({ length: 4 }, function (_, i) {
      var link = links[i] || {};
      return '<div class="watch-pref-link"><label>平台 ' + (i + 1) +
        '<input class="platform-name" maxlength="40" value="' + esc(link.name) + '"></label>' +
        '<label>地址 ' + (i + 1) + '<input class="platform-url" type="url" maxlength="2048" value="' + esc(link.url) + '"></label>' +
        '<label><input name="preferred" type="radio" value="' + i + '"' + (i === 0 ? ' checked' : '') + '> 首选</label></div>';
    }).join('');
    openDlg('番剧个人资料', '<form id="watchPrefsForm"><p>' + esc(detail.name) + '</p>' +
      '<label class="watch-field">年份<input id="watchYear" type="number" min="1900" max="2200" value="' + esc(info.year) + '"></label>' +
      '<label class="watch-field">标签（逗号分隔）<input id="watchTags" maxlength="248" value="' + esc((info.tags || []).join('，')) + '"></label>' +
      '<label class="watch-field">笔记与短评<textarea id="watchNote" rows="4" maxlength="3000">' + esc(info.note) + '</textarea></label>' +
      '<label><input id="watchSpoiler" type="checkbox"' + (info.spoiler ? ' checked' : '') + '> 含剧透，默认折叠</label> ' +
      '<label><input id="watchPinned" type="checkbox"' + (info.pinned_at ? ' checked' : '') + '> 置顶到「接着看」</label>' +
      '<fieldset><legend>观看入口</legend>' + rows + '</fieldset><p id="watchPrefsError" role="alert"></p></form>',
      '<button type="button" id="watchPrefsBack">返回详情</button><button id="watchPrefsSave" class="primary" type="submit" form="watchPrefsForm">保存</button>');
    $('#watchPrefsBack').addEventListener('click', function () { openWatchDetail(detail.id); });
    var form = $('#watchPrefsForm');
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var submit = $('#watchPrefsSave'), error = $('#watchPrefsError');
      var chosen = Number(form.querySelector('input[name="preferred"]:checked').value);
      var options = Array.from(form.querySelectorAll('.watch-pref-link')).map(function (row) {
        return { name: $('.platform-name', row).value.trim(), url: $('.platform-url', row).value.trim() };
      });
      if (!options[chosen].url && options.some(function (link) { return link.url; })) {
        error.textContent = '请把首选设为已填写地址的入口'; return;
      }
      options.unshift(options.splice(chosen, 1)[0]);
      var preferences = { year: Number($('#watchYear').value) || null,
        tags: $('#watchTags').value.split(/[,，]/).map(function (tag) { return tag.trim(); }).filter(Boolean),
        note: $('#watchNote').value, spoiler: $('#watchSpoiler').checked, pinned: $('#watchPinned').checked,
        links: options.filter(function (link) { return link.url || link.name; }) };
      submit.disabled = true;
      post('/api/watch/preferences', { id: detail.id, expected_revision: detail.revision, preferences: preferences }).then(function (reply) {
        if (!reply.ok) throw new Error(reply.error || '保存失败');
        if (form.isConnected) openWatchDetail(detail.id);
        refresh();
      }).catch(function (e) { error.textContent = e.message || '访问失败，请重试'; })
        .finally(function () { submit.disabled = false; });
    });
  }

  function openEpisodeList(detail, round) {
    var progress = round || detail;
    var extras = new Set(progress.episode_extras || []);
    var floor = round ? 0 : Math.max(0, num(detail.start_episode) - 1);
    var end = num(progress.ep_status);
    var count = Math.max(0, end - floor) + extras.size;
    var editable = round ? !round.finished_at && detail.state !== 'removed' : detail.state === 'watching' && !detail.finished;
    var day = STATE?.date || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    var online = /^[1-9]\d{0,9}$/.test(detail.id);
    var picked = new Set(), titles = new Map(), page = Math.max(0, Math.floor(Math.max(floor, end) / 24));
    openDlg(round ? '重看 · 每话清单' : '首轮 · 每话清单',
      '<p><strong>' + esc(detail.name) + '</strong> · 累计已看 ' + count + ' 集 · ' +
      (end > floor ? '连续看到第 ' + end + ' 集' : '尚无连续进度') +
      (floor ? ' · 从第 ' + (floor + 1) + ' 集开始' : '') + '</p>' +
      (extras.size ? '<p class="note">已跳着看：' + esc(Array.from(extras).slice(0, 15).join('、')) +
        (extras.size > 15 ? ' 等 ' + extras.size + ' 集' : '') + '。</p>' : '') +
      (online ? '<p><button type="button" id="episodeTitles">查询 Bangumi 章节</button> ' +
        '<label><input type="checkbox" id="episodeSpoilers"> 显示章节标题</label></p>' : '') +
      '<p id="episodeCatalogStatus" class="note" role="status"></p><div id="episodeRows" class="episode-grid"></div>' +
      '<p><button type="button" id="episodePrev">前 24 集</button> <span id="episodePage"></span> ' +
      '<button type="button" id="episodeNext">后 24 集</button></p>' +
      (editable ? '<div class="watch-fields"><label class="watch-field">也可填写集数（如 1、2、4 或 6-8）' +
        '<input id="episodeNumbers" maxlength="240"></label><label class="watch-field">观看日期（北京时间）' +
        '<input type="date" id="episodeDate" value="' + esc(day) + '" max="' + esc(day) + '" required></label></div>' : '') +
      '<p id="episodeStatus" role="status"></p>',
      '<button type="button" id="episodeBack">返回详情</button>' +
      (editable ? '<button type="button" class="primary" id="episodeSave">记入所选集数</button>' : ''));
    var grid = $('#episodeRows'), status = $('#episodeStatus'), catalogStatus = $('#episodeCatalogStatus');
    var max = num(progress.eps) || 10000;
    page = Math.min(page, Math.ceil(Math.min(10000, max) / 24) - 1);
    $('#episodeBack').onclick = function () { openWatchDetail(detail.id); };
    var save = $('#episodeSave');
    function renderList() {
      var showTitles = $('#episodeSpoilers')?.checked;
      var first = page * 24 + 1, last = Math.min(max, 10000, first + 23);
      grid.innerHTML = Array.from({ length: Math.max(0, last - first + 1) }, function (_, i) {
        var n = first + i, watched = n > floor && n <= end || extras.has(n), skipped = n <= floor;
        var title = showTitles ? titles.get(n) : '';
        return editable && !skipped && !watched ? '<label class="episode-cell"><input type="checkbox" value="' + n + '"' +
          (picked.has(n) ? ' checked' : '') + '> 第 ' + n + ' 集' + (title ? '<small>' + esc(title) + '</small>' : '') + '</label>' :
          '<span class="episode-cell' + (watched ? ' episode-seen' : '') + '">第 ' + n + ' 集 · ' +
          (skipped ? '早于补番起点' : watched ? '已看' : '未看') + (title ? '<small>' + esc(title) + '</small>' : '') + '</span>';
      }).join('');
      grid.querySelectorAll('input').forEach(function (input) {
        input.onchange = function () {
          if (input.checked) picked.add(Number(input.value));
          else picked.delete(Number(input.value));
          status.textContent = '勾选 ' + picked.size + ' 集。';
        };
      });
      $('#episodePage').textContent = first + '–' + last + ' 集';
      $('#episodePrev').disabled = !page;
      $('#episodeNext').disabled = last >= Math.min(max, 10000);
    }
    $('#episodePrev').onclick = function () { page--; renderList(); };
    $('#episodeNext').onclick = function () { page++; renderList(); };
    if (online) {
      var button = $('#episodeTitles');
      function loadTitles(refreshOnline) {
        button.disabled = true;
        json('/api/watch/episodes?id=' + enc(detail.id) + (refreshOnline ? '&refresh=1' : '')).then(function (reply) {
          if (!grid.isConnected) return;
          titles = new Map((reply.chapters || []).map(function (entry) { return [entry.number, entry.title]; }));
          var date = reply.fetched_at ? new Date(reply.fetched_at).toLocaleString('zh-CN') : '';
          catalogStatus.textContent = [reply.warning, date ? '章节资料获取于 ' + date : '可离线按集数记录。'].filter(Boolean).join(' ');
          renderList();
        }).catch(function () { if (grid.isConnected) catalogStatus.textContent = '本机后台未响应，已勾选的集数仍在。'; })
          .finally(function () { button.disabled = false; });
      }
      button.onclick = function () { loadTitles(true); };
      $('#episodeSpoilers').onchange = renderList;
      loadTitles(false);
    }
    if (save) save.onclick = function () {
      var numbers = new Set(picked), input = $('#episodeNumbers').value.trim();
      if (input) {
        var items = input.split(/[、,，\s]+/);
        for (var i = 0; i < items.length; i++) {
          var range = /^(\d{1,5})(?:[-–](\d{1,5}))?$/.exec(items[i]);
          var from = range ? Number(range[1]) : 0, to = range ? Number(range[2] || range[1]) : 0;
          if (!range || !from || to < from || to - from >= 500 || to > Math.min(max, 10000)) {
            status.textContent = '请检查集数格式、总集数和每次最多 500 集的限制。'; return;
          }
          for (var n = from; n <= to; n++) numbers.add(n);
        }
      }
      if (!numbers.size || numbers.size > 500 || Array.from(numbers).some(function (n) { return n <= floor; })) {
        status.textContent = '请选择 1–500 个补番起点之后的集数。'; return;
      }
      var dateInput = $('#episodeDate');
      if (!dateInput.reportValidity()) return;
      save.disabled = true;
      var payload = { id: detail.id, episodes: Array.from(numbers), watched_on: dateInput.value, client: 'panel' };
      if (round) Object.assign(payload, { action: 'episodes', round_id: round.id, expected_revision: detail.revision });
      else payload.expected_watch_revision = detail.revision;
      post(round ? '/api/watch/rewatch' : '/api/progress', payload).then(function (reply) {
        if (!reply.ok) throw new Error(reply.error);
        toast(reply.changed ? '已记入观看历史' : '所选集数已经看过');
        if (grid.isConnected) openWatchDetail(detail.id);
        refresh();
      }).catch(function (error) { if (grid.isConnected) status.textContent = error.message || '暂时没有保存，输入仍在。'; })
        .finally(function () { save.disabled = false; });
    };
    renderList();
  }

  function openWatchBackfill(detail) {
    var today = STATE?.date || new Date().toISOString().slice(0, 10);
    openDlg('补记观看', '<form id="backfillForm"><p>' + esc(detail.name) + '</p>' +
      '<label class="watch-field">实际观看日期（北京时间）<input id="backfillDate" type="date" max="' + esc(today) +
      '" value="' + esc(today) + '" required></label>' +
      '<label class="watch-field">连续看了几集<input id="backfillCount" type="number" min="1" value="1" required></label>' +
      '<p class="note">从当前进度接着记，日期用于观看历史和补番目标。</p><p id="backfillError" role="alert"></p></form>',
      '<button type="button" id="backfillBack">返回详情</button><button id="backfillSave" class="primary" type="submit" form="backfillForm">补记</button>');
    $('#backfillBack').onclick = function () { openWatchDetail(detail.id); };
    var form = $('#backfillForm');
    form.onsubmit = function (event) {
      event.preventDefault();
      var submit = $('#backfillSave');
      submit.disabled = true;
      post('/api/progress', { id: detail.id, delta: Number($('#backfillCount').value), watched_on: $('#backfillDate').value,
        expected_watch_revision: detail.revision }).then(function (reply) {
        if (!reply.ok) throw new Error(reply.error || '补记失败');
        if (form.isConnected) closeDlg();
        if (reply.became_finished) return showCompletion(detail.id, reply.revision);
        toast('观看记录已补记', { label: '撤销', fn: function () { undo(reply.revision); } });
        return refresh();
      }).catch(function (error) { if (form.isConnected) $('#backfillError').textContent = error.message || '补记失败'; })
        .finally(function () { submit.disabled = false; });
    };
  }

  function openWatchHistory(savedFilters, reversibleRevision) {
    openDlg('观看历史', '<form id="watchHistoryForm" class="history-filters"><input name="id" type="hidden">' +
      '<label>番名或编号<input name="q" type="search"></label><label>开始日期<input name="from" type="date"></label>' +
      '<label>截至日期<input name="to" type="date"></label><label>观看方式<select name="mode"><option value="">全部</option>' +
      '<option value="airing">追连载</option><option value="catchup">补番</option><option value="rewatch">重看</option></select></label>' +
      '<button type="submit">筛选</button></form><div id="watchHistoryRows" aria-live="polite"></div>',
      '<button data-close>关闭</button><a id="watchHistoryDownload" class="watch-link" hidden download>导出筛选结果</a>' +
      (reversibleRevision ? '<button type="button" id="restoreRetraction">恢复撤销前状态</button>' : ''));
    var form = $('#watchHistoryForm'), output = $('#watchHistoryRows'), download = $('#watchHistoryDownload'), seq = 0;
    if (savedFilters instanceof URLSearchParams) {
      Array.from(form.elements).forEach(function (field) { if (field.name) field.value = savedFilters.get(field.name) || ''; });
    }
    var restore = $('#restoreRetraction');
    if (restore) restore.onclick = function () {
      restore.disabled = true;
      post('/api/undo', { expected_revision: reversibleRevision }).then(function (reply) {
        if (!reply.ok) throw new Error(reply.error || '无法恢复');
        if (form.isConnected) openWatchHistory(savedFilters);
        refresh();
      }).catch(function (error) {
        if (form.isConnected) {
          var message = document.createElement('p');
          message.setAttribute('role', 'alert');
          message.textContent = error.message || '无法恢复';
          output.prepend(message);
        }
      });
    };
    function load(page) {
      var params = new URLSearchParams(new FormData(form)), current = ++seq;
      params.set('page', String(page));
      download.hidden = true;
      output.textContent = '正在读取观看记录…';
      json('/api/history/browse?' + params).then(function (reply) {
        if (current !== seq || !output.isConnected) return;
        var modeNames = { airing: '追连载', catchup: '补番', rewatch: '重看' };
        var sources = { backfill: '按观看日期补记', absolute: '旧版手动调整', progress: '进度记账', desktop: '桌宠记账', panel: '网页记账' };
        output.innerHTML = '<p>共 ' + reply.total + ' 条 · 北京时间</p>' + (reply.total ? '<ul class="watch-history">' +
          reply.rows.map(function (r) {
            return '<li><details><summary>' + esc(r.date) + ' · ' + esc(r.name || r.id) + ' · ' +
              (r.delta > 0 ? '+' : '') + esc(r.delta) + ' 集</summary><p>' +
              esc(modeNames[r.watch_mode || 'airing'] || '其他') + ' · ' + esc(sources[r.source] || '旧版记录') +
              ' · 记账时进度 ' + esc(r.from ?? '—') + ' → ' + esc(r.to ?? '—') + '</p>' +
              (r.episodes_added?.length ? '<p>记入第 ' + esc(r.episodes_added.join('、')) + ' 集</p>' : '') +
              (r.episodes_removed?.length ? '<p>退回第 ' + esc(r.episodes_removed.join('、')) + ' 集</p>' : '') +
              (r.delta > 0 && r.source !== 'absolute' && (r.watch_mode !== 'rewatch' || r.rewatch_id) && /^[a-f\d]{32}$/.test(r.history_id || '') ?
                '<button type="button" data-retract-history="' + esc(r.history_id) + '">撤销这笔记录</button>' : '') + '</details></li>';
          }).join('') + '</ul>' : '<p>没有匹配的观看记录。</p>') +
          (page > 1 ? '<button type="button" id="historyPrev">上一页</button>' : '') +
          (page * 40 < reply.total ? '<button type="button" id="historyNext">下一页</button>' : '');
        if ($('#historyPrev')) $('#historyPrev').onclick = function () { load(page - 1); };
        if ($('#historyNext')) $('#historyNext').onclick = function () { load(page + 1); };
        output.querySelectorAll('[data-retract-history]').forEach(function (button) {
          button.onclick = function () { previewHistoryRetraction(button.dataset.retractHistory, params); };
        });
        params.set('download', '1');
        download.href = '/api/history/browse?' + params;
        download.hidden = reply.total === 0;
      }).catch(function (e) { if (current === seq && output.isConnected) output.textContent = e.message || '读取失败'; });
    }
    form.onsubmit = function (event) { event.preventDefault(); load(1); };
    load(Number(savedFilters instanceof URLSearchParams ? savedFilters.get('page') : 1) || 1);
  }

  function previewHistoryRetraction(id, filters) {
    openDlg('预览撤销观看记录', '<div id="retractPreview" role="status">正在核对进度和后续记录…</div>',
      '<button type="button" id="retractBack">返回观看历史</button><button class="primary" type="button" id="retractConfirm" disabled>确认撤销</button>');
    var body = $('#retractPreview'), confirm = $('#retractConfirm');
    $('#retractBack').onclick = function () { openWatchHistory(filters); };
    flushAllBumps();
    POST_CHAIN.then(function () {
      return sendPost('/api/history/retract', { history_id: id, preview: true });
    }).then(function (reply) {
      if (!body.isConnected) return;
      if (!reply.ok) throw new Error(reply.error || '无法预览撤销');
      var change = reply.preview;
      body.innerHTML = '<p><strong>' + esc(change.title) + '</strong>　' + esc(change.date) + '</p><ul>' +
        '<li>' + (change.round_id ? '这一轮重看的' : '首轮') + '连续进度 ' + change.from + ' → ' + change.to + ' 集</li>' +
        (change.episodes ? '<li>撤销第 ' + esc(change.episodes.join('、')) + ' 集；本轮累计 ' +
          change.watched_before + ' → ' + change.watched_after + ' 集</li>' : '') +
        '<li>保留后续 ' + change.later + ' 笔观看记录</li>' +
        '<li>累计观看 ' + change.total_delta + ' 集，近 7 天 ' + change.recent_delta + ' 集</li>' +
        '<li>本周补番 ' + change.goal_before + ' → ' + change.goal_after + ' 集' + (change.goal ? '，目标 ' + change.goal + ' 集' : '') + '</li>' +
        (change.state === 'archived' ? '<li>保留当前归档状态</li>' : '') + '</ul><p id="retractError" role="alert"></p>';
      confirm.disabled = false;
      confirm.onclick = function () {
        confirm.disabled = true;
        post('/api/history/retract', { history_id: id, receipt: reply.receipt }).then(function (applied) {
          if (!applied.ok) throw new Error(applied.error || '撤销失败');
          if (body.isConnected) {
            var returned = new URLSearchParams(filters);
            returned.set('page', '1');
            openWatchHistory(returned, applied.revision);
          } else {
            toast('已撤销这笔观看记录', { label: '恢复撤销前状态', fn: function () { undo(applied.revision); } });
          }
          refresh();
        }).catch(function (error) {
          if (body.isConnected) $('#retractError').textContent = error.message || '撤销未完成，请返回后重新预览';
        });
      };
    }).catch(function (error) { if (body.isConnected) body.textContent = error.message || '预览失败'; });
  }

  function openWatchReport() {
    openDlg('本地观看周报',
      '<form id="weekReportForm"><label class="watch-field">选择某一天，查看那一周（北京时间）' +
      '<input type="date" id="weekReportDate"></label><button type="submit">查看这一周</button></form>' +
      '<div id="weekReportBody" role="status"></div>',
      '<button data-close>关闭</button><button type="button" id="weekReportHistory" disabled>核对这周的观看历史</button>');
    var form = $('#weekReportForm'), date = $('#weekReportDate'), box = $('#weekReportBody'), history = $('#weekReportHistory');
    var seq = 0;
    date.max = STATE?.date || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    date.value = date.max;
    function load() {
      var request = ++seq;
      history.disabled = true;
      box.textContent = '正在计算…';
      json('/api/watch/report?week=' + enc(date.value)).then(function (r) {
        if (!box.isConnected || request !== seq) return;
        box.innerHTML = '<p><strong>' + esc(r.from) + ' 至 ' + esc(r.to) + '</strong> · 净记 ' + r.count +
          ' 集（追连载 ' + r.mode.airing + '、补番 ' + r.mode.catchup + '、重看 ' + r.mode.rewatch + '）。</p>' +
          '<p class="note">按记账日期汇总。已撤销的记录和手动更正连续进度不计入；负数表示当天有退回。</p>' +
          '<ul class="watch-history">' + r.days.map(function (day) {
            return '<li>' + esc(day.date) + ' · ' + day.count + ' 集</li>';
          }).join('') + '</ul><h4>本周看完</h4>' +
          (r.completed.length ? '<ul>' + r.completed.map(function (entry) {
            return '<li>' + esc(entry.date) + ' · ' + watchTitle(entry.id, entry.title, true) +
              ' · ' + (entry.kind === 'rewatch' ? '重看' : entry.kind === 'catchup' ? '补番' : '首轮') + '</li>';
          }).join('') + '</ul>' : '<p>还没有可核对的看完日期。</p>') +
          '<h4>按番剧核对</h4>' + (r.titles.length ? '<ul>' + r.titles.map(function (entry) {
            return '<li>' + esc(entry.title) + ' · ' + entry.count + ' 集</li>';
          }).join('') + '</ul>' : '<p>这一周没有需要合计的记录。</p>');
        box.querySelectorAll('[data-detail]').forEach(function (button) {
          button.onclick = function () { openWatchDetail(button.dataset.detail); };
        });
        history.disabled = false;
        history.onclick = function () { openWatchHistory(new URLSearchParams({ from: r.from, to: r.to })); };
      }).catch(function (error) { if (box.isConnected && request === seq) box.textContent = error.message || '未能读到本地周报。'; });
    }
    form.onsubmit = function (event) { event.preventDefault(); load(); };
    load();
  }

  function openScheduleControls(detail) {
    var pending = (detail.schedule_adjustments || []).find(function (entry) {
      return Math.max(Date.parse(entry.original_at), Date.parse(entry.at) || 0) >= Date.now();
    });
    openDlg('调档与提醒',
      '<form id="scheduleForm"><p>' + esc(detail.name) + '</p>' +
      (pending ? '<p class="note">' + esc(pending.at ? '提醒已改到 ' + new Date(pending.at).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai', hour12: false
      }) : '已跳过 ' + pending.date + ' 的周播档') + '</p>' : '') +
      '<label class="row"><span>操作</span><select id="scheduleAction">' +
      '<option value="mute">' + (detail.reminder_muted ? '恢复单番提醒' : '静音此番') + '</option>' +
      (detail.schedule_ended ? '<option value="restart">恢复排片</option>' :
        '<option value="skip">跳过下一次周播</option><option value="move">调整下一次开播</option><option value="end">完结或停止排片</option>') +
      (pending ? '<option value="clear">撤销待生效的调档</option>' : '') +
      '</select></label><label id="scheduleAtRow" class="row" hidden><span>新时刻（北京时间）</span><input type="datetime-local" id="scheduleAt" /></label>' +
      '<p id="scheduleResult" role="status"></p></form>',
      '<button id="scheduleBack">返回详情</button><button class="primary" type="submit" form="scheduleForm" id="scheduleGo">确认</button>');
    var form = $('#scheduleForm'), action = $('#scheduleAction'), at = $('#scheduleAt'), result = $('#scheduleResult'), go = $('#scheduleGo');
    action.addEventListener('change', function () { at.required = action.value === 'move'; $('#scheduleAtRow').hidden = !at.required; });
    $('#scheduleBack').addEventListener('click', function () { openWatchDetail(detail.id); });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      go.disabled = true;
      post('/api/watch/schedule', { id: detail.id, action: action.value, at: at.value, muted: !detail.reminder_muted,
        expected_revision: detail.revision }).then(function (reply) {
        if (!reply.ok) { result.textContent = reply.error || '没有保存'; return; }
        if (form.isConnected) closeDlg();
        toast(reply.changed ? '排期与提醒已保存' : '设置没有变化', reply.changed ? { label: '撤销', fn: undo } : undefined);
        return refresh();
      }).catch(function () { result.textContent = '面板服务未响应'; })
        .finally(function () { go.disabled = false; });
    });
  }

  // ---------------- 同步 ----------------
  function syncSources(result, sample) {
    var sources = result.sources || {};
    var names = { calendar: '公开日历', collections: '动画收藏' };
    return ['calendar', 'collections'].map(function (key) {
      var source = sources[key];
      if (!source) return '';
      var message = source.status === 'ok'
        ? (sample && key === 'collections' ? '可读取' : '已读取 ' + source.count + (key === 'calendar' ? ' 组' : ' 部'))
        : source.status === 'loading' ? '已读 ' + source.count + (source.total != null ? ' / ' + source.total : '') + '，正在读取…'
        : source.status === 'cached' ? '采用已缓存的 ' + source.count + ' 条 · ' + source.error
        : source.status === 'skipped' ? (source.reason === 'no_token' ? '未设置令牌' : '此次不读取') : source.error;
      if (source.fetched_at && !sample) message += ' · 资料于 ' + new Date(source.fetched_at).toLocaleString('zh-CN') + ' 获取';
      return '<p><strong>' + names[key] + '</strong> · ' + esc(message) + '</p>';
    }).join('');
  }

  function doSync() {
    if (BUSY) return toast('同步正在进行');
    var mode = 'collections', useCache = false, request = null;
    var fields = { '(新增)': '新增条目', collection_state: '收藏状态', name: '原名', name_cn: '番名',
      eps: '总集数', ep_status: '已看集数', air_weekday: '播出星期', start_date: '首播日', calendar_entry: '公开排期' };
    function options() {
      openDlg('同步 Bangumi',
        '<label class="row"><span>同步范围</span><select id="syncMode">' +
        '<option value="collections">同步动画收藏，保留本地进度</option><option value="calendar">只同步公开日历</option>' +
        '<option value="progress">同步动画收藏并预览观看进度</option></select></label>' +
        '<label><input type="checkbox" id="syncCache"> 在线读取失败时允许预览上次完整缓存</label>' +
        '<p class="note">先核对差异，再选择要写入的条目和字段。</p>',
        '<button data-close>关闭</button><button class="primary" id="syncPreview">预览</button>');
      $('#syncMode').value = mode;
      $('#syncCache').checked = useCache;
      $('#syncPreview').onclick = function () {
        mode = $('#syncMode').value;
        useCache = $('#syncCache').checked;
        start();
      };
    }
    function start() {
      var id = crypto.randomUUID();
      request = id;
      openDlg('正在读取 Bangumi', '<div id="syncProgress" role="status">正在连接…</div>',
        '<button id="syncCancel">取消读取</button>');
      var marker = $('#syncProgress');
      var cancel = $('#syncCancel');
      var poll = setInterval(function () {
        if (request !== id || !marker.isConnected) return;
        json('/api/sync?request_id=' + enc(id)).then(function (job) {
          if (job.running && request === id && marker.isConnected)
            marker.innerHTML = syncSources(job) || '正在连接…';
        }).catch(function () {});
      }, 350);
      cancel.onclick = function () {
        cancel.disabled = true;
        marker.textContent = '正在取消…';
        sendPost('/api/sync', { cancel: true, request_id: id }).then(function () {
          if (request === id) request = null;
          if (marker.isConnected) options();
        }).catch(function () {
          if (marker.isConnected) { cancel.disabled = false; marker.textContent = '暂时无法取消，可稍后重试。'; }
        });
      };
      BUSY = true;
      flushAllBumps();
      POST_CHAIN.then(function () {
        if (request !== id) return null;
        return sendPost('/api/sync', { dry_run: true, mode: mode, request_id: id, use_cache: useCache });
      }).then(function (result) {
        if (request !== id || !result || !marker.isConnected || !$('#mask').classList.contains('show')) return;
        if (!result.ok) {
          openDlg('同步预览失败', '<p>' + esc(result.error || '无法取得同步资料') + '</p>' + syncSources(result),
            '<button data-close>关闭</button><button id="syncRetry">调整选项或重试</button>');
          $('#syncRetry').onclick = options;
          return;
        }
        review(result);
      }).catch(function () {
        if (request === id && marker.isConnected) {
          marker.textContent = '本机面板后台未响应。启动 TIARA 后可在这里重试。';
          cancel.textContent = '返回选项';
          cancel.disabled = false;
          cancel.onclick = options;
        }
      }).finally(function () {
        clearInterval(poll);
        if (request === id || request === null) { request = null; BUSY = false; }
      });
    }
    function review(result) {
      var changes = result.changes || [], mapped = result.mappings || [], locks = result.protected_fields || [];
      var groups = new Map(), selected = new Set(changes.filter(function (row) { return row.selected; }).map(function (row) { return row.key; }));
      function group(row) {
        if (!groups.has(String(row.id))) groups.set(String(row.id), { name: row.name, items: [], locks: [], mapping: null });
        return groups.get(String(row.id));
      }
      changes.forEach(function (row) { group(row).items.push(row); });
      locks.forEach(function (row) { group(row).locks.push(row); });
      mapped.forEach(function (row) { group(row).mapping = row; });
      var rows = Array.from(groups.values()), page = 0, size = 25;
      openDlg(result.partial ? '同步预览 · 部分来源未在线读到' : '同步预览',
        syncSources(result) + '<p class="note">暂停、归档、弃番和补番安排会保留。默认不改已有条目的收藏状态或调低进度。</p>' +
        '<p id="syncSelection" role="status"></p><div id="syncRows"></div>' +
        '<p><button id="syncPrev">上一页</button> <span id="syncPage"></span> <button id="syncNext">下一页</button></p>',
        '<button data-close>关闭</button><button id="syncRetry">重新读取</button>' +
        '<button class="primary" id="syncGo">写入选中项</button>');
      var go = $('#syncGo'), view = $('#syncRows');
      function count() {
        $('#syncSelection').textContent = '选中 ' + selected.size + ' / ' + changes.length + ' 项 · 核对 ' + rows.length + ' 部';
        go.disabled = !selected.size;
      }
      function value(v) { return esc(v == null ? '空' : v); }
      function draw() {
        var shown = rows.slice(page * size, (page + 1) * size);
        function field(row) { return esc(fields[row.field] || row.field) + '：' + value(row.from) + ' → ' + value(row.to); }
        view.innerHTML = shown.map(function (g, i) {
          var mapping = g.mapping;
          return '<fieldset class="watch-field"><legend>' + esc(g.name) + '</legend>' +
            (mapping ? '<div>线上：' + esc(mapping.remote) + ' → 对应 ' + esc(mapping.mapped) +
              ' · 本机：' + esc(mapping.current || '未入库') + (mapping.protected ? '（保留）' : '') + '</div>' : '') +
            (g.items.length > 1 ? '<label><input type="checkbox" data-sync-group="' + i + '"> 此条目所有字段</label>' : '') +
            g.items.map(function (row) {
              return '<label><input type="checkbox" data-sync-key="' + esc(row.key) + '"' +
                (selected.has(row.key) ? ' checked' : '') + '> ' + field(row) +
                ' · ' + (row.source === 'collections' ? 'Bangumi 收藏' : '公开日历') +
                (row.note ? ' · ' + esc(row.note) : '') + '</label>';
            }).join('') +
            g.locks.map(function (row) { return '<p class="note">' + field(row) + ' · 已保护：' + esc(row.reason) + '</p>'; }).join('') +
            '</fieldset>';
        }).join('') || '<p>没有可核对的条目。</p>';
        view.querySelectorAll('[data-sync-key]').forEach(function (input) {
          input.onchange = function () {
            if (input.checked) selected.add(input.dataset.syncKey);
            else selected.delete(input.dataset.syncKey);
            groupChecks();
            count();
          };
        });
        function groupChecks() {
          view.querySelectorAll('[data-sync-group]').forEach(function (input) {
            var items = shown[Number(input.dataset.syncGroup)].items;
            var n = items.filter(function (row) { return selected.has(row.key); }).length;
            input.checked = n === items.length;
            input.indeterminate = n > 0 && n < items.length;
          });
        }
        view.querySelectorAll('[data-sync-group]').forEach(function (input) {
          input.onchange = function () {
            shown[Number(input.dataset.syncGroup)].items.forEach(function (row) {
              if (input.checked) selected.add(row.key);
              else selected.delete(row.key);
            });
            draw();
          };
        });
        groupChecks();
        $('#syncPage').textContent = (page + 1) + ' / ' + (Math.ceil(rows.length / size) || 1);
        $('#syncPrev').disabled = page === 0;
        $('#syncNext').disabled = (page + 1) * size >= rows.length;
        count();
      }
      $('#syncPrev').onclick = function () { page--; draw(); };
      $('#syncNext').onclick = function () { page++; draw(); };
      $('#syncRetry').onclick = options;
      go.onclick = function () {
        go.disabled = true;
        BUSY = true;
        post('/api/sync', { preview_id: result.preview_id, selected: Array.from(selected) }).then(function (applied) {
          if (!applied.ok) {
            openDlg('未写入同步结果', '<p>' + esc(applied.error || '请重新预览') + '</p>',
              '<button data-close>关闭</button><button class="primary" id="syncRetry">重新预览</button>');
            $('#syncRetry').onclick = options;
            return;
          }
          if (view.isConnected) closeDlg();
          toast('已写入 ' + applied.changes.length + ' 项变更');
          return refresh().then(function () { if (TAB === 'season') return loadSeason(false); });
        }).catch(function () {
          if (view.isConnected) $('#syncSelection').textContent = '本机后台未响应。请刷新番库核对后重试。';
        }).finally(function () { BUSY = false; });
      };
      draw();
    }
    options();
  }

  function openBgmAccount() {
    json('/api/token').then(function (config) {
      openDlg('Bangumi 账号',
        '<form id="bgmAccount"><label class="row"><span>用户名</span><input id="tkUser" value="' + esc(config.user) + '" placeholder="留空可从令牌识别" /></label>' +
        '<label class="row"><span>访问令牌</span><input type="password" autocomplete="new-password" id="tkTok" placeholder="' +
        (config.has_token ? '已保存，留空保留' : '尚未设置') + '" /></label>' +
        '<label class="row"><span>HTTP 代理</span><input type="password" autocomplete="off" id="tkProxy" placeholder="' +
        esc(config.proxy ? '已配置 ' + config.proxy + '，留空保留' : '例如 http://127.0.0.1:7890') + '" /></label>' +
        '<p><label><input id="tkClear" type="checkbox" /> 清除令牌</label> <label><input id="proxyClear" type="checkbox" /> 清除代理</label></p>' +
        (config.overrides.length ? '<p class="note">环境变量优先 · ' + esc(config.overrides.join(' / ')) + '</p>' : '') +
        '<p class="note">公开日历可直接使用。令牌只保存到本机配置。</p><div id="tkResult" role="status"></div></form>',
        '<button data-close>关闭</button><button id="tkTest">测试连接</button><button class="primary" id="tkSave">保存</button>');
      var form = $('#bgmAccount');
      var message = $('#tkResult');
      function submit(test) {
        var draft = { user: $('#tkUser').value.trim(), token: $('#tkClear').checked ? '' : $('#tkTok').value.trim() || undefined,
          proxy: $('#proxyClear').checked ? '' : $('#tkProxy').value.trim() || undefined };
        var buttons = [$('#tkSave'), $('#tkTest')];
        buttons.forEach(function (b) { b.disabled = true; });
        message.textContent = test ? '正在检查连接…' : '正在保存…';
        sendPost(test ? '/api/token/test' : '/api/token', draft).then(function (result) {
          if (!form.isConnected) return;
          if (test) {
            message.innerHTML = (result.identity ? '<p>令牌对应账号 · ' + esc(result.identity.user) + '</p>' : '') +
              (result.error ? '<p>' + esc(result.error) + '</p>' : '') + syncSources(result, true);
          } else if (!result.ok) {
            message.textContent = result.error || '保存失败';
          } else {
            closeDlg();
            toast('Bangumi 设置已保存');
          }
        }).catch(function () { message.textContent = '面板服务未响应'; })
          .finally(function () { buttons.forEach(function (b) { b.disabled = false; }); });
      }
      $('#tkTest').addEventListener('click', function () { submit(true); });
      $('#tkSave').addEventListener('click', function () { submit(false); });
      form.addEventListener('submit', function (event) { event.preventDefault(); submit(true); });
    }).catch(function () { toast('读取账号设置失败'); });
  }

  function openNickname() {
    if (!STATE) return;
    openDlg('桌宠称呼', '<label class="row"><span>她叫你</span><input id="tkNick" maxlength="12" value="' +
      esc(STATE.nickname || '') + '" /></label>', '<button data-close>取消</button><button class="primary" id="nickSave">保存</button>');
    $('#nickSave').addEventListener('click', function () {
      post('/api/nickname', { nickname: $('#tkNick').value.trim() }).then(function (result) {
        if (!result.ok) return toast(result.error || '称呼保存失败');
        closeDlg();
        toast('称呼已保存');
        return refresh();
      }).catch(function () { toast('面板服务未响应'); });
    });
  }

  // ---------------- 启动 ----------------
  function boot() {
    try { applyLibraryView(JSON.parse(localStorage.getItem('tiara.libraryView') || '{}')); } catch (e) {}
    try {
      homeView = localStorage.getItem('tiara.home') || '';
      compactWeek = localStorage.getItem('tiara.compactWeek') === '1';
      TAB = VIEWS.includes(homeView) ? homeView : localStorage.getItem('kx.tab') || 'today';
    } catch (e) { TAB = 'today'; }
    try { WEEK_ALL = localStorage.getItem('kx.weekAll') === '1'; } catch (e) {}
    try {
      var want = new URLSearchParams(location.search).get('tab');
      if (VIEWS.indexOf(want) >= 0) TAB = want;
      if (new URLSearchParams(location.search).get('all') === '1') WEEK_ALL = true;
      if (new URLSearchParams(location.search).get('welcome') === '1') WELCOME_FORCE = true;
    } catch (e) {}
    if (VIEWS.indexOf(TAB) < 0) TAB = 'today';
    if (new URLSearchParams(location.search).get('sync') === '1') {
      var url = new URL(location.href);
      url.searchParams.delete('sync');
      history.replaceState(null, '', url);
      doSync();
    }

    document.querySelectorAll('.tab').forEach(function (b) {
      var active = activeNav(b.dataset.tab);
      b.classList.toggle('on', active);
      if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
    });

    var searchInput = $('#q');
    $('#panelSearch').addEventListener('submit', function (event) {
      event.preventDefault();
      setLibrarySearch(searchInput.value);
    });
    searchInput.addEventListener('input', function (event) {
      if (!event.isComposing) setLibrarySearch(searchInput.value);
    });
    searchInput.addEventListener('compositionend', function () { setLibrarySearch(searchInput.value); });
    $('#clearSearch').onclick = function () { setLibrarySearch(''); searchInput.focus({ preventScroll: true }); };

    var coverSaved = 'md';
    try { coverSaved = localStorage.getItem('kx.cover') || 'md'; } catch (e) {}
    try {
      var cv = new URLSearchParams(location.search).get('cover');
      if (cv && COVER[cv]) coverSaved = cv;
    } catch (e) {}
    setCover(coverSaved);
    function openMigration() {
      openDlg('升级与换机',
        '<p>把番库、观看历史、偏好和陪伴记忆迁到另一份 TIARA。Bangumi 令牌和代理凭据需要在新安装里重新填写。</p>' +
        '<div id="startupPathNote" class="note" role="status">正在核对开机自启路径…</div>' +
        '<fieldset><legend>随备份导出</legend><label><input type="checkbox" id="backupNotes"> 桌面便条</label> ' +
        '<label><input type="checkbox" id="backupAppearance"> 桌宠外观与聊天偏好</label> ' +
        '<label><input type="checkbox" id="backupFavorites"> 收藏台词</label> ' +
        '<label><input type="checkbox" id="backupBrowserPrefs"> 当前浏览器的网页偏好</label></fieldset>' +
        '<button type="button" id="migrationExport">导出迁移文件</button>' +
        '<hr /><label class="row"><span>导入迁移文件</span><input id="migrationFile" type="file" accept=".json,application/json" /></label>' +
        '<label class="row"><span>旧版的 data 文件夹</span><input id="migrationFolder" type="file" webkitdirectory /></label>' +
        '<fieldset id="restoreDesktop" hidden><legend>此次恢复的可选资料</legend>' +
        '<label id="restoreNotesLabel"><input type="checkbox" id="restoreNotes"> 桌面便条</label> ' +
        '<label id="restoreAppearanceLabel"><input type="checkbox" id="restoreAppearance"> 桌宠外观与聊天偏好</label> ' +
        '<label id="restoreFavoritesLabel"><input type="checkbox" id="restoreFavorites"> 收藏台词</label> ' +
        '<label id="restoreBrowserLabel"><input type="checkbox" id="restoreBrowser"> 当前浏览器的网页偏好</label></fieldset>' +
        '<p>番库和提醒设置位于安装目录。主题、封面大小、首页、排片显示和番库视图保存在当前浏览器。</p>' +
        '<p class="note">选择文件后先预览，再确认恢复。确认时会备份当前数据。自定义立绘需要复制套装文件夹。</p>' +
        '<div id="migrationStatus" role="status"></div>',
        '<button data-close>关闭</button><button type="button" class="primary" id="migrationApply" disabled>确认替换</button>');
      var message = $('#migrationStatus'), file = $('#migrationFile'), folder = $('#migrationFolder');
      var pathNote = $('#startupPathNote');
      json('/api/startup-path').then(function (result) {
        if (!pathNote.isConnected) return;
        if (!result.available) { pathNote.textContent = '启动新版桌宠后可在这里核对开机自启路径。'; return; }
        pathNote.textContent = result.startup
          ? '开机自启：' + result.startup + (result.same ? '（当前版本）' :
            (result.exists ? '（指向另一份安装）' : '（路径已不存在）') + '。当前版本：' + result.current +
            '。请在桌宠右键 → 桌宠设置 → 开机自启路径，确认切换。')
          : '尚未设置开机自启。可在桌宠右键 → 桌宠设置中按需启用。';
      }).catch(function () { if (pathNote.isConnected) pathNote.textContent = '暂时无法核对自启路径。'; });
      var apply = $('#migrationApply'), download = $('#migrationExport');
      var current = null, preview = null, request = 0, limit = 16 * 1024 * 1024;
      var restoreDesktop = $('#restoreDesktop'), notes = $('#restoreNotes'), appearance = $('#restoreAppearance');
      var favorites = $('#restoreFavorites'), browser = $('#restoreBrowser'), currentBrowser = {};
      var sourceData = null;
      function counts(info) {
        var base = '在追 ' + info.watching + ' 部、待看 ' + (info.planned || 0) + ' 部、暂停 ' + info.paused +
          ' 部、归档 ' + info.archived + ' 部、' + (info.removed ? '已移除 ' + info.removed + ' 部、' : '') + '观看记录 ' + info.history + ' 条';
        var memory = info.companion;
        if (!memory) return base;
        var details = [];
        if (memory.first_seen) details.push('首次见面 ' + memory.first_seen);
        if (memory.affinity != null) details.push('好感 ' + memory.affinity);
        details.push('剧情 ' + memory.stories + ' 段有进度');
        return base + '；' + details.join('、');
      }
      function readJson(item) {
        return item ? item.text().then(function (text) { return JSON.parse(text.replace(/^\uFEFF/, '')); }) : Promise.resolve({});
      }
      function fromFolder(files) {
        var entries = {};
        Array.from(files).forEach(function (item) {
          if (/^[^/]+\/(library\.json|settings\.json|state\.json|companion-import\.json|history(?:-\d{4})?\.jsonl)$/.test(item.webkitRelativePath)) entries[item.name] = item;
        });
        if (!entries['library.json']) throw new Error('请选择旧版的 data 文件夹，其中应有 library.json');
        if (Object.values(entries).reduce(function (n, item) { return n + item.size; }, 0) > limit) throw new Error('迁移数据超过 16 MB');
        var histories = Object.keys(entries).filter(function (name) { return name.startsWith('history'); });
        return Promise.all([readJson(entries['library.json']), readJson(entries['settings.json']),
          Promise.all(histories.map(function (name) {
            return entries[name].text().then(function (text) {
              return [name, text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(function (line) { return line.trim(); })
                .map(function (line) { return JSON.parse(line.replace(/^\uFEFF/, '')); })];
            });
          })), readJson(entries['state.json']), readJson(entries['companion-import.json'])]).then(function (values) {
          var state = values[3] || {}, pending = values[4] || {};
          var unclaimed = pending.id && pending.id !== state.companion_import ? pending : {};
          var memory = unclaimed.companion ||
            { first_seen: (state.vars || {}).first_seen, affinity: (state.vars || {}).affinity,
              stories: state.stories, affinity_daily: state.affinity_daily, first_duty: state.first_duty, new_year_letter: state.new_year_letter };
          var storyProgress = {};
          ['first-page', 'after-credits', 'next-season', 'two-cups', 'after-duty', 'president-note'].forEach(function (key) {
            if (memory && memory.stories && [0, 1, 2].indexOf(memory.stories[key]) >= 0) storyProgress[key] = memory.stories[key];
          });
          var desktop = {};
          if (Array.isArray(state.desktop_notes)) desktop.notes = state.desktop_notes;
          if (Array.isArray(state.favorite_lines)) desktop.favorites = state.favorite_lines;
          if (entries['state.json'] || values[1].pet_scale != null) desktop.appearance = {
            shell: state.desktop_shell, theme: state.bubble_theme, size: state.bubble_size,
            scale: Number(values[1].pet_scale ?? state.pet_scale ?? 1),
            bubble_time: state.bubble_time, reduce_motion: state.reduce_motion,
            idle_chatter: state.idle_chatter, hourly_chatter: state.hourly_chatter
          };
          Object.assign(desktop, unclaimed.desktop);
          return { format: 'tiara-migration', schema: 1, library: values[0], settings: values[1], history: Object.fromEntries(values[2]), desktop: desktop,
            companion: memory ? { first_seen: memory.first_seen, affinity: memory.affinity,
              stories: memory.stories ? storyProgress : undefined, affinity_daily: memory.affinity_daily,
              first_duty: memory.first_duty, new_year_letter: memory.new_year_letter } : undefined };
        });
      }
      function previewData(data) {
        var ticket = ++request;
        apply.disabled = true;
        message.textContent = '正在检查备份…';
        var selection = {};
        if (notes.checked) selection.notes = data.desktop.notes;
        if (appearance.checked) selection.appearance = data.desktop.appearance;
        if (favorites.checked) selection.favorites = data.desktop.favorites;
        var candidate = Object.assign({}, data, { desktop: selection });
        delete candidate.browser;
        currentBrowser = browser.checked ? browserPreferences(data.browser) : {};
        current = candidate;
        flushAllBumps();
        POST_CHAIN.then(function () {
          if (ticket !== request || !message.isConnected) return null;
          return sendPost('/api/migration', { migration: candidate, preview: true });
        }).then(function (reply) {
          if (!reply || ticket !== request || !message.isConnected) return;
          if (!reply.ok) throw new Error(reply.error || '无法预览');
          preview = reply;
          var desktop = reply.desktop || {};
          var a = desktop.appearance;
          var b = desktop.notes;
          var f = desktop.favorites;
          var changes = reply.changes;
          var diff = '';
          if (changes) {
            var labels = { added: '新增', removed: '移除', replaced: '覆盖', kept: '保留' };
            var states = Object.assign({ dropped: '已弃番' }, WATCH_STATE_LABEL);
            function describe(item) { return item ? states[item.state] + ' · 已看 ' + (item.seen || 0) + ' 集' : '—'; }
            diff = '<p>番剧 ' + Object.entries(changes.totals).map(function (status) { return labels[status[0]] + ' ' + status[1] + ' 部'; }).join(' · ') +
              '。陪伴手账 ' + labels[changes.companion] + '。</p>';
            if (changes.examples.length) diff += '<details><summary>查看番剧变化（最多 20 部）</summary><ul>' +
              changes.examples.map(function (item) { return '<li>' + labels[item.change] + ' · ' + esc(item.title) + ' · ' +
                esc(describe(item.before)) + ' → ' + esc(describe(item.after)) + '</li>'; }).join('') + '</ul></details>';
          }
          function look(item) {
            return esc(item.shell) + ' · ' + ['暖白', '樱粉', '晴蓝'][item.theme] + ' · 字号' + ['小', '标准', '大'][item.size] +
              ' · 桌宠 ' + Math.round(item.scale * 100) + '%';
          }
          function noteCount(info) {
            return info.total + ' 条（已完成 ' + info.done + ' 条' + (info.scheduled ? '，设有到期时间 ' + info.scheduled + ' 条' : '') + '）';
          }
          message.innerHTML = '<p>' + (reply.created_at ? '备份日期 ' +
            esc(new Date(reply.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })) + '（北京时间）' : '备份未记录导出日期') + '</p>' +
            '<p>导入前：' + esc(counts(reply.current)) + '。导入后：' + esc(counts(reply.incoming)) + '。</p>' +
            diff +
            '<ul><li>桌面便条 ' + (b ? noteCount(b.current) + ' → ' + noteCount(b.incoming) + '，替换当前便条' : '保留当前便条') + '</li>' +
            '<li>桌宠外观 ' + (a ? look(a.current) + ' → ' + look(a.incoming) : '保留当前外观') + '</li>' +
            '<li>收藏台词 ' + (f ? f.current + ' 条 → ' + f.incoming + ' 条，替换当前收藏' : '保留当前收藏') + '</li>' +
            '<li>当前浏览器的网页偏好 ' + (browser.checked ? '套用备份中 ' + Object.keys(currentBrowser).length + ' 类偏好' : '保留当前偏好') + '</li></ul>' +
            (a && a.missing_shell ? '<p class="watch-error">当前目录缺少立绘「' + esc(a.incoming.shell) + '」。确认恢复时使用默认套装，其他外观照常恢复。复制套装后可重新预览。</p>' : '');
          apply.disabled = false;
        }).catch(function (error) {
          if (ticket === request && message.isConnected) message.textContent = error.message || '文件读取失败';
        });
      }
      function review(read) {
        var ticket = ++request;
        apply.disabled = true;
        restoreDesktop.hidden = true;
        message.textContent = '正在读取备份…';
        Promise.resolve().then(read).then(function (data) {
          if (ticket !== request || !message.isConnected) return;
          sourceData = data;
          notes.checked = Array.isArray(data.desktop?.notes);
          appearance.checked = Boolean(data.desktop?.appearance);
          $('#restoreNotesLabel').hidden = !notes.checked;
          $('#restoreAppearanceLabel').hidden = !appearance.checked;
          favorites.checked = false;
          browser.checked = false;
          $('#restoreFavoritesLabel').hidden = !Array.isArray(data.desktop?.favorites);
          $('#restoreBrowserLabel').hidden = Object.keys(browserPreferences(data.browser)).length === 0;
          restoreDesktop.hidden = !notes.checked && !appearance.checked && $('#restoreFavoritesLabel').hidden && $('#restoreBrowserLabel').hidden;
          previewData(data);
        }).catch(function (error) {
          if (ticket === request && message.isConnected) message.textContent = error.message || '文件读取失败';
        });
      }
      notes.onchange = appearance.onchange = favorites.onchange = browser.onchange = function () { if (sourceData) previewData(sourceData); };
      file.onchange = function () {
        if (!file.files.length) return;
        folder.value = '';
        review(function () {
          if (file.files[0].size > limit) throw new Error('迁移数据超过 16 MB');
          return readJson(file.files[0]);
        });
      };
      folder.onchange = function () {
        if (!folder.files.length) return;
        file.value = '';
        review(function () { return fromFolder(folder.files); });
      };
      download.onclick = function () {
        download.disabled = true;
        flushAllBumps();
        var includeBrowser = $('#backupBrowserPrefs').checked;
        var include = [$('#backupNotes').checked ? 'notes' : '', $('#backupAppearance').checked ? 'appearance' : '',
          $('#backupFavorites').checked ? 'favorites' : ''].filter(Boolean);
        POST_CHAIN.then(function () { return json('/api/migration?desktop=' + enc(include.join(','))); }).then(function (result) {
          if (!message.isConnected) return;
          var data = result.migration;
          if (includeBrowser) data.browser = readBrowserPreferences();
          var fileText = JSON.stringify(data) + '\n';
          if (new Blob([fileText]).size > limit) throw new Error('迁移数据超过 16 MB');
          var url = URL.createObjectURL(new Blob([fileText], { type: 'application/json' }));
          var link = document.createElement('a');
          link.href = url;
          link.download = 'TIARA-备份-' + new Date(result.migration.created_at || Date.now()).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) + '.json';
          link.click();
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        }).catch(function (error) { if (message.isConnected) toast(error.message || '导出失败，请检查番库和观看历史'); })
          .finally(function () { download.disabled = false; });
      };
      apply.onclick = function () {
        apply.disabled = file.disabled = folder.disabled = notes.disabled = appearance.disabled = favorites.disabled = browser.disabled = true;
        message.textContent = '正在导入…';
        post('/api/migration', { migration: current, source: preview.source, target: preview.target }).then(function (reply) {
          if (!reply.ok) throw new Error(reply.error || '导入失败');
          var browserStatus = '';
          if (Object.keys(currentBrowser).length) {
            try {
              saveBrowserPreferences(currentBrowser);
              if (currentBrowser['kx.theme']) { themeNow = currentBrowser['kx.theme']; applyTheme(themeNow); }
              if (currentBrowser['kx.cover']) setCover(currentBrowser['kx.cover']);
              if (Object.hasOwn(currentBrowser, 'tiara.home')) homeView = currentBrowser['tiara.home'];
              if (currentBrowser['tiara.compactWeek']) compactWeek = currentBrowser['tiara.compactWeek'] === '1';
              if (currentBrowser['kx.weekAll']) WEEK_ALL = currentBrowser['kx.weekAll'] === '1';
              if (currentBrowser['tiara.libraryView']) applyLibraryView(currentBrowser['tiara.libraryView']);
              if (currentBrowser['kx.tab']) switchTab(currentBrowser['kx.tab']);
              browserStatus = '。已应用当前浏览器的网页偏好';
            } catch (error) { browserStatus = '。本机数据已恢复，浏览器偏好无法写入'; }
          }
          if (message.isConnected) {
            message.textContent = '导入成功。导入前的备份在 data/backups/' + reply.backup + browserStatus;
            if (reply.desktop_pending) message.textContent += '。此目录的桌宠运行时会应用选中的桌宠资料。';
            if (reply.rebuild_error) message.textContent += '。桌宠数据重算失败，请查看诊断。';
          }
          refresh();
        }).catch(function (error) { if (message.isConnected) message.textContent = error.message; })
          .finally(function () {
            file.disabled = folder.disabled = notes.disabled = appearance.disabled = favorites.disabled = browser.disabled = false;
            file.value = folder.value = ''; sourceData = null; restoreDesktop.hidden = true;
          });
      };
    }

    function openRestore() {
      openDlg('备份与恢复', '<p id="restoreLoading" role="status">正在读取备份列表…</p>');
      var loading = $('#restoreLoading');
      json('/api/backups').then(function (result) {
        if (!loading.isConnected) return;
        var list = result.backups || [];
        var info = result.inventory;
        function size(bytes) {
          if (bytes < 1024) return bytes + ' B';
          if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KiB';
          return (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
        }
        function amount(group) { return group.count + ' 份 · ' + size(group.bytes); }
        var overview = info ? '<ul class="backup-inventory">' +
          '<li><strong>番库回滚</strong> · ' + amount(info.library) +
          '。位置 <code>data/library.json.bak</code> 和 <code>data/backups</code>，保留最近一次和 ' + info.library.keep + ' 份滚动版本。</li>' +
          '<li><strong>每日快照</strong> · ' + amount(info.daily) +
          '。位置 <code>data/backups/日期</code>，留最近 ' + info.daily.keep + ' 份。含番库、设置、桌宠状态和当年活跃历史末尾 ' +
          info.daily.historyTail + ' 条。</li>' +
          '<li><strong>迁移前备份</strong> · ' + amount(info.migration) +
          '。位置 <code>data/backups/migration-*.json</code>，由用户按需保留，可通过「升级与换机」预览和导入。</li></ul>' +
          (info.daily.legacyCredentials ? '<p class="note">发现 ' + info.daily.legacyCredentials +
           ' 份旧日快照含 Bangumi 配置，请留在本机。新版日快照会排除账号配置。</p>' : '') : '';
        if (!list.length) return openDlg('备份与恢复', overview + '<p>还没有可用的番库回滚版本。</p>', '<button data-close>关闭</button>');
        openDlg('备份与恢复',
          overview + '<label class="row"><span>备份版本</span><select id="restoreVersion">' + list.map(function (backup) {
            return '<option value="' + esc(backup.name) + '">' + esc(new Date(backup.mtime).toLocaleString('zh-CN') +
              (backup.fixed ? ' · 最近一次' : ' · ' + backup.name)) + '</option>';
          }).join('') + '</select></label>' +
          '<label class="row"><span>恢复范围</span><select id="restoreEntry"><option value="">整份番库</option></select></label>' +
          '<p class="note">这里仅回滚番库里的状态、进度和排期。观看历史、账号和偏好设置不回滚；如需从整份备份恢复历史，请使用「升级与换机」。</p><div id="restoreDiff" role="status"></div>',
          '<button data-close>取消</button><button class="primary" id="restoreGo" disabled>确认恢复</button>');
        var version = $('#restoreVersion'), entry = $('#restoreEntry'), diff = $('#restoreDiff'), go = $('#restoreGo');
        var request = 0, preview;
        function describe(item) {
          if (!item) return '库中无此番';
          return WATCH_STATE_LABEL[item.state] + ' · ' + item.ep_status + '/' + (item.eps || '?') + ' · ' +
            (item.air_weekday ? '周' + CN[item.air_weekday] + ' ' + (item.air_time_cst || '时刻未定') : '未排期');
        }
        function show() {
          var id = entry.value;
          var changes = preview.changes.filter(function (change) { return !id || change.id === id; });
          diff.innerHTML = changes.length ? '<ul class="sync-changes">' + changes.map(function (change) {
            return '<li><strong>' + esc((change.to || change.from).name) + '</strong><br />' +
              esc(describe(change.from) + ' → ' + describe(change.to)) + '</li>';
          }).join('') + '</ul>' : '<p>这个范围内没有可见的进度、状态或排期差异。</p>';
          go.textContent = id ? '确认恢复这一部' : '确认恢复整份番库';
          go.disabled = false;
        }
        function load() {
          var seq = ++request;
          preview = null;
          go.disabled = true;
          diff.textContent = '正在读取备份…';
          sendPost('/api/restore', { name: version.value, dry_run: true }).then(function (data) {
            if (seq !== request || !version.isConnected) return;
            if (!data.ok) { diff.textContent = data.error || '读不到备份'; return; }
            preview = data;
            entry.innerHTML = '<option value="">整份番库</option>' + (data.current_readable ? data.entries.map(function (row) {
              return '<option value="' + esc(row.id) + '">' + esc(row.name) + '</option>';
            }).join('') : '');
            show();
          }).catch(function () { if (seq === request) diff.textContent = '读不到备份'; });
        }
        version.addEventListener('change', load);
        entry.addEventListener('change', function () { if (preview) show(); });
        go.addEventListener('click', function () {
          if (!preview) return;
          go.disabled = true;
          post('/api/restore', { name: version.value, id: entry.value || undefined,
            expected_revision: preview.revision, backup_revision: preview.backup_revision }).then(function (applied) {
            if (!applied.ok) { load(); toast(applied.error || '恢复失败'); return; }
            if (version.isConnected) closeDlg();
            toast(applied.id ? '番剧已恢复' : '番库已恢复');
            return refresh();
          }).catch(function () { go.disabled = false; toast('没有收到恢复结果'); });
        });
        load();
      }).catch(function () { if (loading.isConnected) loading.textContent = '读不到备份列表'; });
    }

    function openReminderSettings() {
      openDlg('提醒设置', '<p id="reminderSettingsLoading" role="status">正在读取提醒设置…</p>');
      var loading = $('#reminderSettingsLoading');
      json('/api/settings').then(function (settings) {
        if (!loading.isConnected) return;
        openDlg('提醒设置',
          '<form id="quietForm"><p>以北京时间（UTC+8）计算。跨午夜时沿用开始那一天的规则。每组同时留空时关闭。</p>' +
          '<fieldset><legend>周一至周五免打扰</legend>' +
          '<label class="row"><span>开始</span><input id="quietStart" type="time" value="' + esc(settings.quiet_work_start ?? settings.quiet_start) + '" /></label>' +
          '<label class="row"><span>结束</span><input id="quietEnd" type="time" value="' + esc(settings.quiet_work_end ?? settings.quiet_end) + '" /></label></fieldset>' +
          '<fieldset><legend>周六与周日免打扰</legend>' +
          '<label class="row"><span>开始</span><input id="quietWeekendStart" type="time" value="' + esc(settings.quiet_weekend_start ?? settings.quiet_start) + '" /></label>' +
          '<label class="row"><span>结束</span><input id="quietWeekendEnd" type="time" value="' + esc(settings.quiet_weekend_end ?? settings.quiet_end) + '" /></label></fieldset>' +
          '<label class="row"><span>开播与补番提醒</span><select id="reminderLead">' +
          [0, 5, 10, 15, 30, 60].map(function (n) { return '<option value="' + n + '"' +
            (n === (settings.reminder_lead || 0) ? ' selected' : '') + '>' + (n ? '提前 ' + n + ' 分钟' : '准点') + '</option>'; }).join('') +
          '</select></label>' +
          '<p id="quietStatus" role="status"></p></form>' +
          '<button type="button" id="reminderTest">测试提醒</button> <button type="button" id="reminderSnoozes">稍后提醒</button>' +
          '<p class="note">测试会让当前桌宠显示一条通知。</p>' +
          '<p id="reminderTestStatus" role="status"></p>',
          '<button data-close>取消</button><button class="primary" type="submit" form="quietForm">保存</button>');
        $('#reminderSnoozes').onclick = openReminderSnoozes;
        $('#reminderTest').onclick = function () {
          var button = this, status = $('#reminderTestStatus');
          button.disabled = true;
          status.textContent = '正在联系桌宠…';
          sendPost('/api/reminder/test', {}).then(function (reply) {
            if (!reply.ok) throw new Error(reply.error || '无法发送测试提醒');
            var until = Date.now() + 12500;
            function waitForDesktop() {
              if (!status.isConnected) return;
              return json('/api/reminder/test?id=' + enc(reply.id)).then(function (result) {
                if (!status.isConnected) return;
                if (result.delivered) { status.textContent = '桌宠已触发测试提醒'; return; }
                if (Date.now() >= until) throw new Error('桌宠未回应。请检查桌宠和网页是否来自同一安装目录。');
                return new Promise(function (resolve) { setTimeout(resolve, 500); }).then(waitForDesktop);
              });
            }
            return waitForDesktop();
          }).catch(function (error) { if (status.isConnected) status.textContent = error.message; })
            .finally(function () { button.disabled = false; });
        };
        $('#quietForm').addEventListener('submit', function (event) {
          event.preventDefault();
          var status = $('#quietStatus');
          post('/api/settings', { quiet_work_start: $('#quietStart').value, quiet_work_end: $('#quietEnd').value,
            quiet_weekend_start: $('#quietWeekendStart').value, quiet_weekend_end: $('#quietWeekendEnd').value,
            reminder_lead: Number($('#reminderLead').value) }).then(function (reply) {
            if (!reply.ok) { status.textContent = reply.error || '设置保存失败'; return; }
            if (status.isConnected) closeDlg();
            toast('提醒设置已保存');
            return refresh();
          }).catch(function () { status.textContent = '面板服务未响应'; });
        });
      }).catch(function () { if (loading.isConnected) loading.textContent = '读取提醒设置失败'; });
    }

    $('#settingsNav').onclick = openSettingsNav;

    function openReleaseInfo() {
      var publicPage = 'https://github.com/JerryVon39/TIARA/releases';
      var installed = STATE?.server?.version;
      openDlg('检查更新', '<p id="releaseStatus" role="status">' + (installed ? '当前 v' + esc(installed) + '。' : '') +
        '正在查询 GitHub…</p><div id="releasePackages"></div>' +
        '<p><a href="' + publicPage + '" target="_blank" rel="noopener noreferrer">打开 GitHub 发行页面</a></p>',
        '<button data-close>关闭</button>');
      var status = $('#releaseStatus'), packages = $('#releasePackages');
      json('/api/release/latest').then(function (info) {
        if (!status.isConnected) return;
        var relation = info.update ? '可下载新版本' : info.available === info.installed ? '已是最新正式版' : '当前版本较新';
        status.textContent = '当前 v' + info.installed + ' · GitHub 正式版 v' + info.available + ' · ' + relation;
        packages.innerHTML = info.assets.length ? '<ul class="release-assets">' + info.assets.map(function (asset) {
          var kind = asset.kind === 'portable' ? 'Windows 便携包' : 'SSP 公开安装包';
          return '<li><a href="' + esc(asset.url) + '" target="_blank" rel="noopener noreferrer">' + kind + '</a>' +
            (asset.size ? ' · ' + (asset.size / (1024 * 1024)).toFixed(1) + ' MiB' : '') +
            '<div>SHA-256 ' + (asset.sha256 ? '<code>' + esc(asset.sha256) + '</code>' : '本次发行未提供') + '</div></li>';
        }).join('') + '</ul>' : '<p>该版本没有匹配的安装包，打开发行页面查看。</p>';
      }).catch(function (error) {
        if (status.isConnected) status.textContent = (installed ? '当前 v' + installed + '。' : '') + (error.message || '暂时无法获取发行信息');
      });
    }

    function openPrivateSsp() {
      openDlg('导出私人 SSP 排片',
        '<p>私人 ZIP 含本机排片、称呼和观看资料，请留给自己使用。可以在 SSP 中覆盖安装并重载 TIARA。</p>' +
        '<p id="sspExportStatus" role="status">正在读取快照覆盖日期…</p>',
        '<button data-close>关闭</button><button class="primary" id="sspExport" disabled>下载私人 ZIP</button>');
      var status = $('#sspExportStatus'), button = $('#sspExport'), plan = null;
      function preview() {
        button.disabled = true;
        json('/api/export/ssp').then(function (info) {
          if (!status.isConnected) return;
          plan = info;
          status.textContent = '开播提醒覆盖北京时间 ' + info.from + ' 至 ' + info.to + '（含首尾）。到期后需重新导出。';
          button.disabled = false;
        }).catch(function (error) { if (status.isConnected) status.textContent = error.message || '无法预览私人快照'; });
      }
      button.onclick = function () {
        button.disabled = true;
        status.textContent = '正在生成私人 ZIP…';
        fetch('/api/export/ssp', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: plan.revision })
        }).then(function (response) {
          if (!response.ok) return response.json().then(function (body) { throw Object.assign(new Error(body.error), { status: response.status }); });
          return response.blob();
        }).then(function (blob) {
          if (!status.isConnected) return;
          var url = URL.createObjectURL(blob);
          var link = document.createElement('a');
          link.href = url;
          link.download = 'TIARA-ssp-private-' + plan.from + '.zip';
          link.click();
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
          status.textContent = '已生成私人快照，覆盖 ' + plan.from + ' 至 ' + plan.to + '。';
          button.disabled = false;
        }).catch(function (error) {
          if (!status.isConnected) return;
          status.textContent = error.message || '导出失败';
          if (error.status === 409) {
            button.textContent = '重新预览';
            button.onclick = function () { closeDlg(); openPrivateSsp(); };
          }
          button.disabled = false;
        });
      };
      preview();
    }


    function openSettingsNav() {
      var groups = [
        ['Bangumi', [['account', 'Bangumi 账号', openBgmAccount], ['sync', '同步 Bangumi', doSync]]],
        ['数据与导出', [['restore', '备份与恢复', openRestore], ['migration', '升级与换机', openMigration],
          ['calendar', '导出日历', openCalendarExport], ['week', '导出周表', function () { location.href = '/api/export?fmt=md'; }],
          ['ssp', '导出私人 SSP 排片', openPrivateSsp]]],
        ['提醒与桌宠', [['reminders', '提醒设置', openReminderSettings],
          ['reminderHistory', '提醒记录', function () { openReminderHistory(); }], ['nickname', '桌宠称呼', openNickname]]],
        ['应用与排查', [['board', '打开副屏看板', function () {
          var board = window.open('/board.html', 'tiara-board', 'popup,width=1100,height=760,resizable=yes');
          if (board) board.focus(); else location.href = '/board.html';
        }], ['update', '检查更新', openReleaseInfo], ['diagnose', '启动诊断', doDiagnose]]],
      ];
      var appearance = '<section class="settings-section settings-display" aria-labelledby="settingsDisplay">' +
        '<h4 id="settingsDisplay">显示偏好</h4><div class="settings-fields">' +
        '<label>主题<select id="themeSel"><option value="light">亮色</option><option value="dark">暗色</option><option value="auto">跟随系统</option></select></label>' +
        '<label>封面尺寸<select id="coverSel"><option value="sm">小</option><option value="md">中</option><option value="lg">大</option><option value="xl">特大</option></select></label>' +
        '<label>排片时制<select id="clockSel"><option value="30h">30 小时制</option><option value="24h">24 小时制</option></select></label>' +
        '<label>启动时打开<select id="settingsHome"><option value="">上次浏览</option><option value="today">我的排片 · 今天</option>' +
        '<option value="week">我的排片 · 本周</option><option value="continue">接着看</option><option value="catchup">补番</option></select></label>' +
        '<label>桌宠尺寸<select id="scaleSel"></select></label>' +
        '<label class="settings-checkbox"><input type="checkbox" id="settingsCompact"' +
        (compactWeek ? ' checked' : '') + '> 本周排片使用紧凑列表</label></div><p id="settingsStatus" role="status" hidden></p></section>';
      var actions = Object.fromEntries(groups.flatMap(function (group) {
        return group[1].map(function (entry) { return [entry[0], entry[2]]; });
      }));
      var sections = groups.map(function (group) {
        return '<section class="settings-section"><h4>' + group[0] + '</h4><div class="settings-actions">' +
          group[1].map(function (entry) {
            return '<button type="button" data-settings-open="' + entry[0] + '">' + entry[1] + '</button>';
          }).join('') + '</div></section>';
      }).join('');
      openDlg('设置', '<div class="settings-layout">' + appearance + sections + '</div>', '<button data-close>完成</button>');
      var clock = $('#clockSel'), scale = $('#scaleSel'), status = $('#settingsStatus');
      var scaleOptions = [0.7, 0.85, 1, 1.25, 1.5, 2];
      var currentScale = num(STATE?.settings?.pet_scale) || 1;
      if (!scaleOptions.includes(currentScale)) scaleOptions.push(currentScale);
      scale.innerHTML = scaleOptions.sort(function (a, b) { return a - b; }).map(function (value) {
        return '<option value="' + value + '">' + Math.round(value * 100) + '%</option>';
      }).join('');
      clock.value = CLOCK;
      scale.value = String(currentScale);
      $('#themeSel').value = themeNow;
      $('#coverSel').value = coverSize;
      $('#settingsHome').value = homeView;
      function showSettingsStatus(message) {
        if (!status.isConnected) return;
        status.textContent = message;
        status.hidden = !message;
      }
      function saveOption(control, key, value) {
        control.disabled = true;
        showSettingsStatus('');
        post('/api/settings', { [key]: value }).then(function (reply) {
          if (!reply.ok) throw new Error(reply.error || '显示设置未保存');
          if (reply.settings && STATE) STATE.settings = reply.settings;
          if (key === 'clock') CLOCK = reply.settings?.clock || value;
          showSettingsStatus('显示设置已保存');
          return refresh();
        }).catch(function (error) {
          control.value = String(key === 'clock' ? CLOCK : STATE?.settings?.pet_scale || currentScale);
          showSettingsStatus(error.message || '显示设置未保存');
        }).finally(function () { control.disabled = false; });
      }
      clock.onchange = function () { saveOption(this, 'clock', this.value); };
      scale.onchange = function () { saveOption(this, 'pet_scale', Number(this.value)); };
      $('#themeSel').onchange = function () {
        themeNow = this.value;
        applyTheme(themeNow);
        try { localStorage.setItem('kx.theme', themeNow); } catch (e) { showSettingsStatus('浏览器无法保存主题'); }
      };
      $('#coverSel').onchange = function () { setCover(this.value); };
      $('#settingsHome').onchange = function () {
        homeView = this.value;
        try { localStorage.setItem('tiara.home', homeView); } catch (e) { showSettingsStatus('浏览器无法保存首页设置'); }
      };
      $('#settingsCompact').onchange = function () {
        compactWeek = this.checked;
        try { localStorage.setItem('tiara.compactWeek', compactWeek ? '1' : '0'); } catch (e) { showSettingsStatus('浏览器无法保存显示设置'); }
        render();
      };
      $('#dlg').querySelectorAll('[data-settings-open]').forEach(function (button) {
        button.onclick = actions[button.dataset.settingsOpen];
      });
    }

    // ---------------- 诊断：服务日志 ----------------
    function doDiagnose() {
      openDlg('诊断 · 启动与版本', '<p id="diagnoseLoading" role="status">正在读取启动信息…</p>');
      var loading = $('#diagnoseLoading');
      Promise.all([json('/api/logs?tail=160'), json('/api/version').catch(function () { return {}; })]).then(function (results) {
        if (!loading.isConnected) return;
        var j = results[0], version = results[1];
        var text = (j.lines || []).join('\n');
        var errs = (j.lines || []).filter(function (l) { return l.indexOf('[error]') >= 0; }).length;
        var launch = version.launch || {}, script = launch.script || {}, binary = launch.binary || {}, target = script.binary || {};
        function samePath(a, b) { return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase(); }
        var mismatch = version.installed_version && (version.version !== version.installed_version ||
          (version.desktop && version.desktop.version !== version.installed_version) ||
          (binary.version && binary.version !== version.installed_version) ||
          (target.version && target.version !== version.installed_version));
        mismatch = mismatch || (script.target && binary.path && !samePath(script.target, binary.path)) ||
          (version.desktop_path && binary.path && !samePath(version.desktop_path, binary.path));
        function row(label, value, file) {
          return '<dt>' + label + '</dt><dd>' + esc(value || '未读到') + (file ? '<br><code>' + esc(file) + '</code>' : '') + '</dd>';
        }
        openDlg('诊断 · 启动与版本',
          '<dl class="launch-diagnostics">' +
          row('安装目录', version.installed_version, version.install_path) +
          row('启动脚本', script.exists ? '已找到' : '未检测到', script.path) +
          row('脚本实际启动', target.version || (target.exists === false ? '目标文件缺失' : '未读到版本'), script.target) +
          row('磁盘桌宠', binary.version || (binary.exists === false ? '文件缺失' : '未读到版本'), binary.path) +
          row('运行中的桌宠', version.desktop ? version.desktop.version : '当前目录未检测到', version.desktop_path) +
          row('运行中的网页后台', version.version, version.server_path) + '</dl>' +
          (mismatch || target.exists === false || binary.exists === false ? '<p role="status" class="watch-error">' +
            '检测到版本或启动文件不一致。请退出旧实例，到新版便携包解压目录启动其中的 pet/Pet.exe。' +
            (binary.version === version.installed_version ? ' 本目录入口为 <code>' + esc(binary.path) + '</code>。' : '') + '</p>' : '') +
          '<div class="note">' +
          '文件 <b>' + esc(j.path || 'cache/server.log') + '</b>　' +
          '大小 ' + Math.round((j.size || 0) / 1024) + ' KB　' +
          '错误 ' + errs + ' 行' +
          '<br />重建失败、预热失败、端口回退都记在这里。要清空直接删文件即可。</div>' +
          '<pre style="max-height:46vh;overflow:auto;margin:0">' + esc(text || '（还没有日志）') + '</pre>',
          '<button data-close>关掉</button><button id="diagShare">脱敏报告</button><button id="diagRefresh">刷新</button>');
        var btn = $('#diagRefresh');
        if (btn) btn.addEventListener('click', function () { closeDlg(); doDiagnose(); });
        $('#diagShare').onclick = openDiagnosticsReport;
      }).catch(function () { if (loading.isConnected) loading.textContent = '读不到日志'; });
    }

    function openDiagnosticsReport() {
      openDlg('脱敏诊断报告', '<p id="diagnosticsLoading" role="status">正在生成…</p>', '<button data-close>关闭</button>');
      var loading = $('#diagnosticsLoading');
      json('/api/diagnostics/report').then(function (reply) {
        if (!loading.isConnected) return;
        openDlg('脱敏诊断报告', '<p>选择要分享的内容，复制前可先检查。</p>' +
          '<label><input type="checkbox" id="reportStartup" checked> 启动与版本</label> ' +
          '<label><input type="checkbox" id="reportSync" checked> 同步状态</label>' +
          '<label class="watch-field">报告预览<textarea id="reportText" rows="12" readonly></textarea></label><p id="reportStatus" role="status"></p>',
          '<button data-close>关闭</button><button id="copyReport">复制报告</button>');
        var a = $('#reportStartup'), b = $('#reportSync'), area = $('#reportText');
        function update() {
          var payload = {};
          if (a.checked) payload.startup = reply.startup;
          if (b.checked) payload.sync = reply.sync;
          area.value = JSON.stringify(payload, null, 2);
          $('#copyReport').disabled = !a.checked && !b.checked;
        }
        a.onchange = b.onchange = update;
        $('#copyReport').onclick = function () {
          function selectForCopy() { area.focus(); area.select(); $('#reportStatus').textContent = '请手动复制选中的报告'; }
          if (!navigator.clipboard) { selectForCopy(); return; }
          navigator.clipboard.writeText(area.value).then(function () { if (area.isConnected) $('#reportStatus').textContent = '已复制'; })
            .catch(function () { if (area.isConnected) selectForCopy(); });
        };
        update();
      }).catch(function (e) { if (loading.isConnected) loading.textContent = e.message || '无法生成报告'; });
    }

    var THEMES = ['dark', 'light', 'auto'];
    var mqDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    function systemIsDark() { return !mqDark || mqDark.matches; }
    function applyTheme(t) {
      var effective = t === 'auto' ? (systemIsDark() ? 'dark' : 'light') : t;
      document.documentElement.dataset.theme = effective;
      var meta = $('#themeColor');
      if (meta) meta.content = effective === 'light' ? '#f7f8fa' : '#181d23';
    }
    var themeNow = 'light';
    try {
      var savedTheme = localStorage.getItem('kx.theme');
      if (THEMES.includes(savedTheme)) themeNow = savedTheme;
    } catch (e) {}
    applyTheme(themeNow);
    if (mqDark) {
      var onSysTheme = function () { if (themeNow === 'auto') applyTheme('auto'); };
      if (mqDark.addEventListener) mqDark.addEventListener('change', onSysTheme);
      else if (mqDark.addListener) mqDark.addListener(onSysTheme);
    }

    $('#mask').addEventListener('click', function (e) { if (e.target === $('#mask')) closeDlg(); });
    document.addEventListener('click', function (e) {
      document.querySelectorAll('.schedule-more[open]').forEach(function (menu) {
        if (!menu.contains(e.target)) closeScheduleMenu(menu);
      });
      var target = e.target.closest('[data-new-watch], [data-detail]');
      if (target) openWatchDetail(target.getAttribute('data-detail'));
      if (e.target.closest('[data-anime-search]')) openAnimeSearch();
      var libraryAction = e.target.closest('[data-resume], [data-archive]');
      if (!libraryAction || libraryAction.disabled) return;
      var archive = libraryAction.hasAttribute('data-archive');
      libraryAction.disabled = true;
      changeWatchState(libraryAction.getAttribute(archive ? 'data-archive' : 'data-resume'), archive ? 'archive' : 'resume').catch(function (err) {
        toast(err.message || '状态更新失败，请重试');
      }).finally(function () { libraryAction.disabled = false; });
    });

    // ---------------- 键盘 ----------------
    // 鼠标记一话要三次点击（找番 → 对准 + → 撤销弹窗），键盘是一条「番列表 + 空格」的路：
    //   j / ↓ 下一部　k / ↑ 上一部　空格 记一话　x 移出在追　u 撤销　1/2/3 切页　/ 搜
    function rowsForKb() {
      return Array.prototype.slice.call(document.querySelectorAll('#view .show[data-card]'));
    }
    function selRow(key) {
      SEL = key;
      var rows = rowsForKb();
      for (var i = 0; i < rows.length; i++) rows[i].classList.toggle('sel', rows[i].id === key);
    }
    function moveSel(step) {
      var rows = rowsForKb();
      if (!rows.length) return;
      var idx = -1;
      for (var i = 0; i < rows.length; i++) if (rows[i].classList.contains('sel')) idx = i;
      idx = idx < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, idx + step));
      selRow(rows[idx].id);
      try { rows[idx].scrollIntoView({ block: 'nearest' }); } catch (e) {}
    }
    function curSel() {
      var r = document.querySelector('#view .show.sel[data-card]');
      return r ? r.getAttribute('data-card') : null;
    }

    document.addEventListener('keydown', function (e) {
      if (e.isComposing) return;
      if ($('#mask').classList.contains('show')) {
        if (e.key === 'Escape') { e.preventDefault(); closeDlg(); }
        if (e.key === 'Tab') {
          var targets = Array.from($('#dlg').querySelectorAll('button, input, select, textarea, a[href], summary, [tabindex="0"]'))
            .filter(function (el) { return !el.matches(':disabled') && el.getClientRects().length; });
          var edge = e.shiftKey ? targets[0] : targets[targets.length - 1];
          if (!targets.length || document.activeElement === edge || !$('#dlg').contains(document.activeElement) ||
              e.shiftKey && document.activeElement.id === 'dlgTitle') {
            e.preventDefault();
            (targets[e.shiftKey ? targets.length - 1 : 0] || $('#dlg')).focus();
          }
        }
        return;
      }
      if (e.key === 'Escape') {
        var menu = $('.schedule-more[open]');
        if (menu) { e.preventDefault(); closeScheduleMenu(menu, menu.contains(document.activeElement)); return; }
      }
      if (e.key === 'Escape' && $('#q').value) {
        e.preventDefault();
        setLibrarySearch('');
        $('#q').focus({ preventScroll: true });
        return;
      }
      var t = e.target || {};
      if (t.tagName && /INPUT|TEXTAREA|SELECT/.test(t.tagName)) return;
      if (t.isContentEditable) return;
      // 按钮、链接的 Enter/Space 是它们自己的激活键。以前这里只排除了输入框，
      // 结果焦点在「主题」上按 Enter 会去选中卡片、再按空格就真记了一话。
      if (t.closest && t.closest('button, a, [role="button"], summary')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // 弹窗开着时页面快捷键全部让路（否则空格会把底下的番记一话）
      if ($('#mask').classList.contains('show')) return;

      if (e.key === '/') { e.preventDefault(); $('#q').focus(); return; }
      if (e.key === '1') return switchTab('week');
      if (e.key === '2') return switchTab('today');
      if (e.key === '3') return document.querySelector('.tab[data-tab=season]').click();
      if (e.key === '4') return document.querySelector('.tab[data-tab=library]').click();
      if (e.key === '5') return document.querySelector('.tab[data-tab=catchup]').click();
      if (q()) return;
      if (e.key === 'u' || e.key === 'U') { e.preventDefault(); return undo(); }
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); return moveSel(1); }
      if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); return moveSel(-1); }
      if (e.key === ' ' || e.key === 'Enter') {
        var id = curSel();
        if (!id) return;            // 没有选中行就不要吞掉空格（它该用来滚页面）
        e.preventDefault();
        return bump(id, 1);
      }
      if (e.key === 'x' || e.key === 'X' || e.key === 'Delete') {
        var xid = curSel();
        if (!xid) return;
        e.preventDefault();
        selRow(null);
        return removeWatch(xid);
      }
    });

    // 顶栏的重试按钮：连不上服务时手动再来一次
    var retry = $('#netbarRetry');
    if (retry) retry.addEventListener('click', function () {
      retry.disabled = true;
      refresh().then(function () { retry.disabled = false; }, function () { retry.disabled = false; });
    });

    refresh().then(function () {
      var watch = new URLSearchParams(location.search).get('watch');
      if (watch) return openWatchDetail(watch);
      if (new URLSearchParams(location.search).get('reminders') === '1') return openReminderHistory();
      if (TAB === 'season' && !SEASON) loadSeason(false);
    });
    setInterval(function () { if (!document.hidden) refresh(); }, 60000);
    setInterval(checkPanelRevision, 3500);
    document.addEventListener('visibilitychange', checkPanelRevision);
    window.addEventListener('focus', checkPanelRevision);
  }

  boot();
})();
