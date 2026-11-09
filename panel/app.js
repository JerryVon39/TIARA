/* TIARA 面板脚本（从 index.html 拆出，v0.26.1）。
 * 经典脚本：桌宠在没有服务时会用 file:// 打开面板，type="module" 会被 CORS 拦死。
 */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var CN = ['', '一', '二', '三', '四', '五', '六', '日'];
  var WEEK_ORDER = [1, 2, 3, 4, 5, 6, 7];
  var VIEWS = ['week', 'today', 'season', 'library'];
  var WATCH_STATE_LABEL = { watching: '在追', paused: '已暂停', archived: '已归档' };

  var STATE = null;
  var STATS = null;
  var IMAGES = {};
  var missingCovers = new Map();
  var TAB = 'week';
  /** ?welcome=1 时强制给一遍新手引导（老用户想复习时用） */
  var WELCOME_FORCE = false;
  var QUERY = '';
  var CLOCK = '30h';
  var WEEK_ALL = false;
  var BUSY = false;
  /** 键盘当前选中的番 id（.show.sel） */
  var SEL = null;
  var SEASON = null;
  var SEASON_MARK = {};
  var SEASON_Q = '';
  var SEASON_ERR = '';
  var seasonRequest = 0;
  /** 本季筛选条件（放在这里，refresh 重绘后不会被 reset） */
  var SEASON_FILTER = { onlyTv: true, hideWatching: false, onlyTodo: false, sortBy: 'weekday' };
  var COVER = { sm: [28, 38], md: [36, 48], lg: [46, 62], xl: [58, 78] };

  // ---------------- 工具 ----------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function enc(s) { return encodeURIComponent(String(s == null ? '' : s)); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  /** 总话数在最近 3 天内变多 → 显示「新」（同步时 lib/bgm.mjs 写的 eps_updated_at） */
  function isFresh(w) {
    if (!w || !w.eps_updated_at) return false;
    var t = Date.parse(String(w.eps_updated_at) + 'T00:00:00+08:00');
    return isFinite(t) && Date.now() - t < 3 * 86400e3;
  }

  /** 在 STATE.watching 里找一条（乐观更新要就地改它，别整页重绘） */
  function findWatch(id) {
    var list = (STATE && STATE.watching) || [];
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
  function post(url, body) {
    // 所有页面写入按触发顺序提交，撤销不能越过尚在等待的记账。
    if (url !== '/api/progress') flushAllBumps();
    var run = POST_CHAIN.then(function () {
      if (url === '/api/undo' && LAST_WRITE && ['/api/progress', '/api/watch/detail', '/api/watch/lifecycle'].indexOf(LAST_WRITE.url) >= 0) {
        if (!LAST_WRITE.result || !LAST_WRITE.result.changed) return { ok: false, error: '刚才没有写入新改动，无需撤销' };
        body = Object.assign({}, body, { expected_revision: LAST_WRITE.result.revision });
      }
      return sendPost(url, body).then(function (j) {
        LAST_WRITE = { url: url, result: j };
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
        // 服务端重建失败时以前是静默的：数据写进去了、页面也顺，但 today.txt 没动。
        if (j.rebuild_error) toast('改了库，但 ' + j.rebuild_error);
        return j;
      });
    });
  }
  function q() { return QUERY.trim().toLowerCase(); }
  function match(x) {
    var s = q();
    if (!s) return true;
    var hay = [x.name_cn, x.name, x.priority, (x.alias || []).join(' '), (x.tags || []).join(' ')].join(' ');
    return String(hay || '').toLowerCase().indexOf(s) >= 0;
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
    if (action && action.fn) {
      var b = document.createElement('button');
      b.className = 'act';
      b.type = 'button';
      b.textContent = action.label || '撤销';
      b.addEventListener('click', function () {
        el.classList.remove('is-up');
        action.fn();
      });
      el.appendChild(b);
    }
    el.classList.add('is-up');
    clearTimeout(toastTimer);
    // 带操作的停留久一点（点得到），纯提示 2.2 秒
    toastTimer = setTimeout(function () { el.classList.remove('is-up'); }, action ? 5000 : 2200);
  }

  /** 撤销最近一次写库（服务端 data/undo 栈） */
  function undo() {
    post('/api/undo', {}).then(function (j) {
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
  function paintClock() { $('#clockBtn').textContent = CLOCK === '30h' ? '30h' : '24h'; }

  /** 用原始北京时间判断是否开播，显示制式只影响排版。 */
  function airStatus(time, weekday) {
    if (!STATE || Number(weekday) !== Number(STATE.weekday)) return '';
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(time || ''));
    if (!m) return '';
    var now = new Date(Date.now() + 8 * 3600000);
    return Number(m[1]) * 60 + Number(m[2]) <= now.getUTCHours() * 60 + now.getUTCMinutes() ? 'aired' : 'next';
  }

  /** 封面尺寸：小 / 中 / 大 / 特大（记在 localStorage） */
  function setCover(key) {
    var size = COVER[key] || COVER.md;
    document.documentElement.style.setProperty('--cv-w', size[0] + 'px');
    document.documentElement.style.setProperty('--cv-h', size[1] + 'px');
    var sel = document.getElementById('coverSel');
    if (sel) sel.value = COVER[key] ? key : 'md';
    try { localStorage.setItem('kx.cover', key); } catch (e) {}
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
    return '<span class="cover"><img loading="lazy" src="/cover/' + enc(sid) + '.jpg" alt="" data-cover-id="' + sid + '" data-ch="' + esc(ch) + '" /></span>';
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
    var msg = '连不上本地服务：' + ((e && e.message) || '网络错误');
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
        if (STATE && STATE.settings) {
          CLOCK = STATE.settings.clock || '30h';
          var sc = Number(STATE.settings.pet_scale);
          if (sc) $('#scaleSel').value = String(sc);
        }
        hideNetbar();
        paintClock();
        paintPending();
        $('#dateLabel').textContent = (STATE.weekday_cn || '') + ' · ' + (STATE.date || '');
        $('#footHint').textContent = '追番 ' + num(STATE.watching_count) + ' 部 · 更新 ' +
          (STATE.generated ? new Date(STATE.generated).toLocaleTimeString('zh-CN', { hour12: false }) : '—') +
          (STATE.server && STATE.server.pid ? ' · pid ' + STATE.server.pid : '');
        render();
      })
      .catch(function (e) {
        if (STATE) return offlineNote(e);   // 已经有内容：只提示，不拆页面
        showNetbar('连不上本地服务：' + (e.message || '网络错误'));
        $('#view').innerHTML = '<div class="panel"><div class="empty">读不到本地服务：' + esc(e.message) +
          '<br /><br />先跑 <b>node server.mjs --port 7788</b>，或用「打开番组表.bat」。<br />' +
          '起好服务后点上面的「重试」。</div></div>';
      });
  }

  // ---------------- 渲染 ----------------
  function switchTab(to) {
    if (VIEWS.indexOf(to) < 0) return;
    TAB = to;
    try { localStorage.setItem('kx.tab', TAB); } catch (e) {}
    document.querySelectorAll('.tab').forEach(function (x) {
      var active = x.getAttribute('data-tab') === to;
      x.classList.toggle('on', active);
      if (active) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current');
    });
    render();
    if (to === 'season' && !SEASON) loadSeason(false);
    window.scrollTo(0, 0);
  }

  function render() {
    if (!STATE) return;
    var v = $('#view');
    // 整体重绘会把焦点丢到 body：记住当前焦点控件的 id，画完还回去
    var focusId = document.activeElement && document.activeElement.id;
    if (TAB === 'week') v.innerHTML = viewWeek();
    else if (TAB === 'today') v.innerHTML = viewToday();
    else if (TAB === 'library') v.innerHTML = viewLibrary();
    else v.innerHTML = viewSeason();
    bind();
    if (focusId) {
      var again = document.getElementById(focusId);
      if (again && again.focus && again !== document.activeElement) {
        try { again.focus({ preventScroll: true }); } catch (e) { again.focus(); }
      }
    }
  }

  function showCard(x, opts) {
    opts = opts || {};
    var meta = [];
    if (x.mine && x.total) {
      // 「剩 N 话」= 总话数还没看到；「落后 N 话」= 比本周进度少看了。两者别混成一个「差」
      var tail = x.left > 0 ? '剩 ' + x.left + ' 话' : '看齐';
      if (x.behind > 0) tail += ' · 落后 ' + x.behind;
      meta.push(x.watched + '/' + x.total + ' · ' + tail);
    } else if (x.mine) meta.push('已看 ' + x.watched + ' 话 · 总数未定');
    else meta.push('本季');
    if (x.priority) meta.push(x.priority);
    var pct = x.mine && x.total > 0 ? Math.max(0, Math.min(100, Math.round((x.watched / x.total) * 100))) : 0;
    var ops = '';
    if (x.mine) {
      ops = '<span class="ops">' +
        '<button data-op="-1" data-id="' + esc(x.id) + '" title="回退一话">−</button>' +
        '<button data-op="1" data-id="' + esc(x.id) + '" title="记一话（空格）">+</button>' +
        '<button class="x" data-op="remove" data-id="' + esc(x.id) + '" title="移出在追（x）">×</button></span>';
    } else {
      ops = '<span class="ops"><button data-add="' + esc(x.id) + '" data-name="' + esc(x.name) + '">加入在追</button></span>';
    }
    var timeHtml = '<div class="show-time"><span class="t' + (x.time ? '' : ' unknown') + '">' +
      esc(x.time || '时刻未定') + '</span>' +
      (opts.wdLabel ? '<span class="wk">' + esc(opts.wdLabel) + '</span>' : '') +
      (x.status ? '<span class="air-state ' + x.status + '">' + (x.status === 'aired' ? '已播' : '待播') + '</span>' : '') + '</div>';
    return '<div class="show' + (x.mine ? '' : ' dim') + (x.sel ? ' sel' : '') + '"' +
      (x.mine ? ' data-card="' + esc(x.id) + '"' : '') + '>' +
      cover(x.id, x.name) +
      '<div class="body">' + timeHtml +
      '<div class="nm" title="' + esc(x.name) + '">' + watchTitle(x.id, x.name, x.mine) +
      (x.fresh ? ' <span class="chip fresh" title="总话数刚变多">新</span>' : '') + '</div>' +
      (meta.length ? '<div class="meta">' + esc(meta.join(' · ')) + '</div>' : '') +
      (x.mine && x.total ? '<div class="prog' + (pct >= 100 ? ' full' : '') + '"><i style="width:' + pct + '%"></i></div>' : '') +
      ops +
      '</div></div>';
  }

  function watchTitle(id, name, editable) {
    if (!editable) return esc(name);
    return '<button type="button" class="nm-link" data-detail="' + esc(id) + '" aria-label="打开《' + esc(name) + '》详情">' + esc(name) + '</button>';
  }

  function viewLibrary() {
    function section(state, title, empty) {
      var entries = (STATE[state] || []).filter(match);
      var rows = entries.map(function (w) {
        var name = w.name_cn || w.name || String(w.id);
        var progress = num(w.ep_status) + '/' + (num(w.eps) || '?');
        return '<div class="trow library-row">' +
          '<div class="tn"><div class="nm">' + watchTitle(w.id, name, true) + '</div>' +
          '<small>' + (state === 'archived' ? '看完 ' : '已看 ') + esc(progress) + '</small></div>' +
          '<button type="button" data-resume="' + esc(w.id) + '">' + (state === 'archived' ? '恢复到在追' : '继续追番') + '</button></div>';
      }).join('');
      return '<section class="panel"><div class="ph">' + title + '<span class="count">' + entries.length + '</span></div>' +
        '<div class="pb">' + (rows || '<div class="empty">' + (q() ? '没有匹配的番剧' : empty) + '</div>') + '</div></section>';
    }
    return '<div class="sec"><div class="sec-head"><h2>番剧库</h2><span class="note">暂停和归档的番剧保留进度与排期。</span></div>' +
      '<div class="library-sections">' + section('paused', '暂停中', '还没有暂停的番剧') +
      section('archived', '已归档', '还没有归档的番剧') + '</div></div>';
  }

  function weekBuckets(all) {
    var t = STATE;
    var watch = {};
    (t.watching || []).forEach(function (w) { watch[String(w.id)] = w; });
    var buckets = {};
    WEEK_ORDER.forEach(function (d) { buckets[d] = []; });
    WEEK_ORDER.forEach(function (d) {
      ((t.week && t.week[d]) || []).forEach(function (x) {
        var w = watch[String(x.id)];
        var mine = !!w;
        if (!all && !mine) return;
        if (!match(x) && !(mine && match(w))) return;
        var dd = dispShow(x.time_cst, d);
        var bucket = dd.wd || d;
        if (!buckets[bucket]) return;
        var total = w ? num(w.eps) : 0;
        var watched = w ? num(w.ep_status) : 0;
        buckets[bucket].push({
          id: x.id, name: x.name_cn || x.name || String(x.id),
          time: dd.time, status: airStatus(x.time_cst, d), mine: mine, watched: watched, total: total,
          left: w ? Math.max(0, total - watched) : 0,
          behind: w ? Math.max(0, num(w.expected_eps) - watched) : 0,
          priority: w && w.priority,
          fresh: isFresh(w),
          sel: SEL === String(x.id)
        });
      });
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

  function boardHtml(buckets, opts) {
    opts = opts || {};
    var today = num(STATE.weekday);
    var total = 0;
    var cols = WEEK_ORDER.map(function (d) {
      var list = buckets[d] || [];
      total += list.length;
      var isToday = today === d;
      var day = new Date(Date.parse(STATE.date + 'T00:00:00Z') + (d - today) * 86400000);
      var shortDate = isNaN(day.getTime()) ? '' : (day.getUTCMonth() + 1) + '/' + day.getUTCDate();
      var head = '<div class="dhead"><b>周' + CN[d] + '</b><span class="day-date">' + shortDate + '</span>' +
        (isToday ? '<span class="now">今天</span>' : '') +
        '<span class="n">' + list.length + ' 部</span></div>';
      var body = list.length
        ? list.map(function (x) { return showCard(x, { now: isToday, wdLabel: '' }); }).join('')
        : '<div class="dempty">' + (q() ? '没有匹配' : '—') + '</div>';
      return '<section class="dcol' + (isToday ? ' today' : '') + (list.length ? '' : ' day-empty') + '">' + head + '<div class="dbody">' + body + '</div></section>';
    }).join('');
    if (!total && !opts.keepEmpty) {
      if (q()) {
        return '<div class="panel"><div class="empty">没有匹配「' + esc(QUERY.trim()) + '」的番。' +
          '<br />换个关键词，或把搜索框清空。</div></div>';
      }
      return '<div class="panel"><div class="empty empty-start"><strong>本周还没有排片</strong>' +
        '<p>手动添加一部番，或到本季列表挑选。</p>' +
        '<div class="empty-actions"><button class="primary" data-new-watch>手动添加</button>' +
        '<button data-goto="season">去本季选番</button></div></div></div>';
    }
    return '<div class="board">' + cols + '</div>';
  }

  function viewWeek() {
    var buckets = weekBuckets(WEEK_ALL);
    var bar = '<div class="fbar">' +
      '<label><input type="checkbox" id="weekAll"' + (WEEK_ALL ? ' checked' : '') + ' /> 连本季一起看</label>' +
      '<span class="sep"></span><span>' + (WEEK_ALL ? '整季排片，灰的是没在追的' : '只列在追的番') + '</span>' +
      '</div>';
    return '<div class="sec"><div class="sec-head"><h2>本周排片</h2></div>' + bar + boardHtml(buckets) + '</div>';
  }

  function viewToday() {
    var t = STATE;
    var today = (t.today || []).filter(match);
    var watch = (t.watching || []).filter(match);
    var catchup = (t.catchup || []).filter(match);

    var todayList = today.length
      ? today.map(function (s) {
        return showCard({
          id: s.id, name: s.name_cn || s.name, time: dispShow(s.time_cst, t.weekday).time,
          status: s.time_cst ? (s.aired ? 'aired' : 'next') : '',
          mine: true, watched: num(s.watched_eps), total: num(s.total_eps),
          left: Math.max(0, num(s.total_eps) - num(s.watched_eps)), behind: num(s.behind), priority: s.priority
        });
      }).join('')
      : '<div class="empty" style="padding:14px 16px;text-align:left">今天没有你的番。去「本季」挑几部，或用「本周」看整周排片。</div>';

    // 接下来：优先三天卡片；能播的日子太少就摊成本周剩下的列表
    var b = weekBuckets(false);
    var order = [1, 2, 3, 4, 5, 6, 7].map(function (k) { return ((num(t.weekday) - 1 + k) % 7) + 1; });
    var upcoming = order.map(function (d) { return { d: d, list: b[d] || [] }; })
      .filter(function (x) { return x.list.length; });
    var strip = '';
    if (upcoming.length >= 2) {
      strip = '<div class="board" style="grid-template-columns: repeat(' + Math.min(3, upcoming.length) + ', minmax(0, 1fr))">' +
        upcoming.slice(0, 3).map(function (x) {
          var d = x.d;
          var label = d === order[0] ? '明天' : (d <= num(t.weekday) ? '下周' : '周') + CN[d];
          return '<div class="dcol">' +
            '<div class="dhead"><b>' + label + '</b><span class="n">' + x.list.length + ' 部</span></div>' +
            '<div class="dbody">' + x.list.map(function (s) { return showCard(s, {}); }).join('') + '</div></div>';
        }).join('') + '</div>';
    } else if (upcoming.length) {
      strip = '<div class="panel"><div class="pb tight list">' + upcoming.map(function (x) {
        var label = x.d === order[0] ? '明天' : (x.d <= num(t.weekday) ? '下周' : '周') + CN[x.d];
        return '<div class="dayrow" style="padding:6px 12px">' + label +
          '<span style="float:right;color:var(--mute)">' + x.list.length + ' 部</span></div>' +
          x.list.map(function (s) { return showCard(s, {}); }).join('');
      }).join('') + '</div></div>';
    }

    var st = STATS || {};
    var spark = (st.byDay || []).map(function (d) {
      var h = Math.min(44, 4 + num(d.n) * 9);
      return '<i class="' + (num(d.n) > 0 ? 'on' : '') + '" style="height:' + h + 'px" title="' + esc(d.date) + '：' + num(d.n) + ' 话"></i>';
    }).join('');
    // /api/stats 挂了的时候以前显示三个 0——看着像「这周一部没看」，其实是没读到
    var statsBox = STATS
      ? '<div class="stats">' +
        '<div class="stat"><b>' + num(st.week) + '</b><span>本周</span></div>' +
        '<div class="stat"><b>' + num(st.total) + '</b><span>累计</span></div>' +
        '<div class="stat"><b>' + num(st.streak) + '</b><span>连续天</span></div>' +
        '</div><div class="spark">' + (spark || '') + '</div>'
      : '<div class="empty" style="padding:4px 0;text-align:left">统计读不到（历史日志可能不在了），不影响记一话。</div>';

    var watching = watch.map(function (w) {
      return showCard({
        id: w.id, name: w.name_cn || w.name,
        time: dispShow(w.air_time_cst, w.air_weekday).time,
        mine: true, watched: num(w.ep_status), total: num(w.eps),
        left: Math.max(0, num(w.eps) - num(w.ep_status)),
        behind: Math.max(0, num(w.expected_eps) - num(w.ep_status)),
        priority: w.priority,
        fresh: isFresh(w),
        sel: SEL === String(w.id)
      }, { wdLabel: w.air_weekday ? '周' + CN[w.air_weekday] : '不定期' });
    }).join('');

    var catchupHtml = catchup.map(function (w) {
      return showCard({
        id: w.id, name: w.name_cn || w.name, time: '', mine: true,
        watched: num(w.ep_status), total: num(w.eps), left: Math.max(0, num(w.eps) - num(w.ep_status))
      }, {});
    }).join('');

    var aside =
      '<aside class="cols" style="display:block">' +
      '<div class="panel" style="margin-bottom:18px"><div class="ph">在追 <span class="count">' + watch.length + '</span></div>' +
      '<div class="pb tight">' + (watching || '<div class="empty">还没有在追的番。</div>') + '</div></div>' +
      (catchupHtml ? '<div class="panel" style="margin-bottom:18px"><div class="ph">待补完 <span class="count">' + catchup.length + '</span></div>' +
        '<div class="pb tight">' + catchupHtml + '</div></div>' : '') +
      '<div class="panel" style="margin-bottom:18px"><div class="ph">这周</div><div class="pb">' +
      statsBox + '</div></div>' +
      '<div class="panel" style="margin-bottom:18px"><div class="ph">TIARA说</div><div class="pb">' +
      '<div class="say"><span id="sayText">' + esc(t.summary || '') + '</span>' +
      '<div style="margin-top:10px"><button id="sayBtn" class="ghost">让她再说一句</button></div></div></div></div>' +
      '<div class="panel"><div class="ph">今日一句</div><div class="pb"><div class="say">' + esc(t.quote || '—') + '</div></div></div>' +
      '</aside>';

    // 空库（或 ?welcome=1）时给一条三步引导：挑番 → 补时刻 → 同步
    var welcome = '';
    if (!watch.length || WELCOME_FORCE) {
      welcome =
        '<div class="sec"><div class="sec-head"><h2>第一次用？三步就够了</h2><span class="note">点下面任意一步就会带你过去</span></div>' +
        '<div class="panel"><div class="pb tight">' +
        '<div class="wstep"><b>1</b><div><strong>去「本季」挑几部</strong>' +
        '<p>每部右边点「+ 追」，就进了你的在追列表。也可以先勾选几部，再点右上「加入在追」。</p>' +
        '<button class="mini" data-goto="season">去挑番</button></div></div>' +
        '<div class="wstep"><b>2</b><div><strong>补上开播时刻</strong>' +
        '<p>Bangumi 只给星期几，不给几点。在「本季」每部的输入框里填 23:30 这类时刻，' +
        '「本周」和桌宠就能按时间排。不填也能用，只是显示成「时刻未定」。</p></div></div>' +
        '<div class="wstep"><b>3</b><div><strong>（可选）同步 Bangumi</strong>' +
        '<p>在 Bangumi 个人设置里生成一个 Access Token 填进「账号」，之后点「同步」就能一次拉回' +
        '在追进度与整季排片。不联网也完全能用。</p>' +
        '<button class="mini" data-goto="sync">现在同步</button></div></div>' +
        '</div></div></div>';
    }

    return '<div class="cols">' +
      '<div>' + welcome +
      '<div class="sec"><div class="sec-head"><h2>今天放送</h2><span class="count">' + today.length + '</span></div>' +
      '<div class="panel"><div class="pb tight list">' + todayList + '</div></div></div>' +
      (strip ? '<div class="sec"><div class="sec-head"><h2>接下来</h2><span class="note">只列在追的</span></div>' +
        strip + '</div>' : '') +
      '</div>' + aside + '</div>';
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
      '<option value="name"' + (SEASON_FILTER.sortBy === 'name' ? ' selected' : '') + '>按名字</option>' +
      '</select>' +
      '<span class="grow"></span>' +
      '<button id="markAll">全选</button><button id="markNone">清空</button>' +
      '<button id="batchTime" title="给勾选的番批量设开播时刻">批量时刻</button>' +
      '<button class="primary" id="applyBtn">加入在追</button>' +
      '</div>';
    return '<div class="sec"><div class="sec-head"><h2>本季番剧</h2>' +
      '<span class="note">选番加入在追，开播时刻可在行内补充</span></div>' +
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
    ['paused', 'archived'].forEach(function (state) {
      ((STATE && STATE[state]) || []).forEach(function (w) { inactiveById.set(String(w.id), { state: state, entry: w }); });
    });

    var list = (j.items || []).slice();
    if (onlyTv) list = list.filter(tvLike);
    if (hideW || onlyTodo) {
      list = list.filter(function (x) {
        return !watching.some(function (w) { return String(w.id) === String(x.id); }) && (!onlyTodo || !inactiveById.has(String(x.id)));
      });
    }
    if (QUERY) list = list.filter(match);
    list.sort(function (a, b) {
      if (sortBy === 'rating') return num(b.rating) - num(a.rating);
      if (sortBy === 'name') return String(a.name_cn || a.name).localeCompare(String(b.name_cn || b.name), 'zh');
      var aw = a.weekday || 9, bw = b.weekday || 9;
      return aw - bw || String(a.date || '').localeCompare(String(b.date || ''));
    });

    var watchingById = {};
    watching.forEach(function (w) { watchingById[String(w.id)] = w; });

    // 分组计数先算一遍，别在每一行里再 filter 整表
    var perDay = {};
    list.forEach(function (x) { var d = x.weekday || 0; perDay[d] = (perDay[d] || 0) + 1; });

    // 按放送日分组（只有按放送日排序时才分组）
    var rows = '';
    var lastW = null;
    list.forEach(function (x) {
      var id = String(x.id);
      var w = watchingById[id];
      var inactive = inactiveById.get(id);
      var tracked = w || (inactive && inactive.entry);
      var mark = !!SEASON_MARK[id];
      var wd = x.weekday || 0;
      if (sortBy === 'weekday' && wd !== lastW) {
        lastW = wd;
        var label = wd ? '周' + CN[wd] : '放送日未定';
        var n = perDay[wd] || 0;
        var isToday = wd && num(STATE.weekday) === wd;
        rows += '<tr class="dayrow' + (isToday ? ' today' : '') + '"><td colspan="6">' + label +
          '<span class="n">' + n + ' 部</span></td></tr>';
      }
      var meta = [x.date || '', (x.tags || []).slice(0, 3).join(' / '), x.platform || ''].filter(Boolean).join(' · ');
      var opCell;
      if (w) {
        var tt = num(w.eps);
        var ww = num(w.ep_status);
        opCell = '<div class="ops-wrap">' +
          '<div class="ops-line"><span class="ep" data-season-id="' + esc(id) + '">' + ww + '/' + (tt || '?') + '</span>' +
          '<button data-op="-1" data-id="' + esc(id) + '" title="回退一话">−</button>' +
          '<button data-op="1" data-id="' + esc(id) + '" title="记一话">+</button>' +
          '<button class="x" data-op="remove" data-id="' + esc(id) + '" title="移出在追">×</button></div>' +
          '<input class="tin" type="text" data-time="' + esc(id) + '" value="' + esc(w.air_time_cst || '') +
          '" placeholder="时刻 23:00" title="填了就进本周排片" />' +
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
        '<div class="meta">' + esc(meta) + '</div><div class="meta season-mobile-meta">' +
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
      (j.source === 'net' ? '刚拉取' : '来自缓存') + esc(warnText) + '</div>';

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

  // ---------------- 交互 ----------------
  function bind() {
    var v = $('#view');

    v.querySelectorAll('[data-goto]').forEach(function (el) {
      el.addEventListener('click', function () {
        var to = el.getAttribute('data-goto');
        if (to === 'sync') doSync(); else switchTab(to);
      });
    });

    v.querySelectorAll('[data-op]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = el.getAttribute('data-id');
        if (el.getAttribute('data-op') === 'remove') return removeWatch(id);
        bump(id, Number(el.getAttribute('data-op')));
      });
    });

    v.querySelectorAll('[data-add]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        addWatch(el.getAttribute('data-add'), el.getAttribute('data-name'));
      });
    });

    var wa = $('#weekAll');
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
        $('#sayText').textContent = j.text;
      }).catch(function () { toast('没读到台词'); });
    });

    if (TAB === 'season') bindSeason();
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
    post('/api/progress', { id: id, delta: d }).then(function (j) {
      OUTSTANDING[id] -= d;
      if (j.ok === false || j.error) { toast(j.error || '没记上'); return refresh(); }
      var w = findWatch(id);
      // 服务端可能把值夹到上限，以它为准；不重绘整页，只校正这一行
      if (w && typeof j.ep_status === 'number') {
        w.ep_status = Math.max(0, j.ep_status + (OUTSTANDING[id] || 0));
        if (num(w.eps) > 0) w.ep_status = Math.min(num(w.eps), w.ep_status);
        paintWatch(id);
      }
    }).catch(function () { OUTSTANDING[id] -= d; toast('服务没响应，请刷新确认进度'); refresh(); });
  }

  /** 只重绘某一条番的进度数字与进度条（不整页重绘、不打断滚动与焦点） */
  function paintWatch(id) {
    var w = findWatch(id);
    if (!w) return;
    var seen = num(w.ep_status);
    var total = num(w.eps);
    var pct = total > 0 ? Math.max(0, Math.min(100, Math.round((seen / total) * 100))) : 0;
    var cards = document.querySelectorAll('[data-card="' + CSS.escape(String(id)) + '"]');
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      var meta = c.querySelector('.meta');
      if (meta) {
        var left = Math.max(0, total - seen);
        var tail = left > 0 ? '剩 ' + left + ' 话' : '看齐';
        var behind = Math.max(0, num(w.expected_eps) - seen);
        if (behind > 0) tail += ' · 落后 ' + behind;
        var prio = w.priority ? ' · ' + w.priority : '';
        meta.textContent = (total ? seen + '/' + total + ' · ' + tail : '已看 ' + seen + ' 话 · 总数未定') + prio;
      }
      var bar = c.querySelector('.prog');
      if (bar) {
        var fill = bar.querySelector('i');
        if (fill) fill.style.width = pct + '%';
        if (pct >= 100) bar.classList.add('full'); else bar.classList.remove('full');
      }
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
      if (num(list[i].expected_eps) - num(list[i].ep_status) > 0) n += 1;
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
      var gap = num(w.expected_eps) - num(w.ep_status);
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

  /**
   * 移出在追。以前这里是 confirm() 弹窗——一个误点要过两道关，撤销反而只有「恢复上一版」整库回滚。
   * 现在直接做，配一个「撤销」（服务端 data/undo 里有这份库的上一版）。
   */
  function removeWatch(id) {
    if (BUSY) return;
    var w = findWatch(id);
    if (!w) return;
    openDlg('移除追番记录', '<p>将移除《' + esc(w.name_cn || w.name) + '》的追番记录和当前进度。想以后接着看，可以在详情里选择暂停。</p>',
      '<button data-close>取消</button><button id="removeWatchGo">移除记录</button>');
    $('#removeWatchGo').addEventListener('click', function () { closeDlg(); removeWatchRecord(id); });
  }

  function removeWatchRecord(id) {
    if (BUSY) return;
    BUSY = true;
    post('/api/watch', { id: id, action: 'remove' }).then(function (j) {
      BUSY = false;
      if (j.ok === false || j.error) return toast(j.error || '没移出去');
      toast('已移出在追', { label: '撤销', fn: undo });
      refresh();
    }).catch(function () { BUSY = false; toast('服务没响应'); });
  }

  function addWatch(id, name) {
    if (BUSY) return;
    BUSY = true;
    post('/api/watch', { id: id, action: 'add', name: name }).then(function (j) {
      BUSY = false;
      if (j.ok === false || j.error) return toast(j.error || '没加进去');
      toast('加成在追了，记得补开播时刻');
      refresh();
    }).catch(function () { BUSY = false; toast('服务没响应'); });
  }

  /** 本季表里直接点「+ 追」：走 season/apply，连 track_from 一起记下（这样「落后几话」才算得准） */
  function addFromSeason(id) {
    if (BUSY) return;
    BUSY = true;
    var btn = $('#seasonBody') && $('#seasonBody').querySelector('[data-seadd="' + CSS.escape(String(id)) + '"]');
    if (btn) { btn.disabled = true; btn.textContent = '加…'; }
    post('/api/season/apply', { q: SEASON_Q, add: [id] }).then(function (j) {
      BUSY = false;
      if (j.ok === false || j.error) {
        if (btn) { btn.disabled = false; btn.textContent = '+ 追'; }
        return toast(j.error || '没加进去');
      }
      toast('已加进在追，记得补开播时刻');
      return refresh().then(function () { if (TAB === 'season') loadSeason(false); });
    }).catch(function () {
      BUSY = false;
      if (btn) { btn.disabled = false; btn.textContent = '+ 追'; }
      toast('服务没响应');
    });
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
        var ids = Object.keys(SEASON_MARK);
        if (!ids.length) return toast('先勾选几部（点左边的方框）');
        openDlg('批量设开播时刻',
          '<div class="empty" style="padding:0 0 10px;text-align:left">给勾选的 <b>' + ids.length +
          '</b> 部一起写时刻。Bangumi 只给星期几，不给几点，所以这一格要你自己填。</div>' +
          '<div class="row"><span>时刻</span><input type="text" id="btTime" placeholder="23:00（最晚 24:59）" /></div>' +
          '<div class="empty" style="padding:10px 0 0;text-align:left;font-size:11.5px">' +
          '只能给已经在追的番写时刻：没加的先点「+ 追」。</div>',
          '<button data-close>取消</button><button class="primary" id="btGo">写入</button>');
        var input = $('#btTime');
        var go = $('#btGo');
        input.focus();
        var submit = function () {
          var time = input.value.trim();
          if (!time) return toast('先填个时刻，比如 23:00');
          post('/api/season/time-batch', { ids: ids, time: time }).then(function (r) {
            if (r.ok === false || r.error) return toast(r.error || '没写进去');
            closeDlg();
            // 服务端回 {count, changed:[], missing:[]}；old 版回 changed 数组。0 条要说清为什么。
            var n = num(r.count != null ? r.count : (Array.isArray(r.changed) ? r.changed.length : 0));
            if (!n) return toast('这些番还没加进在追，先在表里点「+ 追」');
            toast('已给 ' + n + ' 部写好时刻' + (r.missing && r.missing.length ? '，' + r.missing.length + ' 部没在追' : ''));
            SEASON_MARK = {};
            refresh().then(function () {
              var b = $('#seasonBody');
              if (b) { b.innerHTML = seasonBodyHtml(); bindSeason(); }
            });
          }).catch(function () { toast('服务没响应'); });
        };
        go.addEventListener('click', submit);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
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
        // 必须带上 q：服务端按 q 取缓存里的条目，不传就用「当前季度」，翻旧季加番会写成空名字
        post('/api/season/apply', { q: SEASON_Q, add: ids }).then(function (j) {
          if (j.ok === false || j.error) return toast(j.error || '没加成');
          // 服务端新契约回 {added,changes}：added 才是真加入的部数；changes 是字段级 diff 条数（含周表那条）
          var n = num(j.added != null ? j.added : (j.count != null ? j.count : ids.length));
          if (n === 0) toast('这些番已经在在追里了，没有新增');
          else toast('加了 ' + n + ' 部，时刻可以在本季表里补');
          SEASON_MARK = {};
          refresh().then(function () { if (TAB === 'season') loadSeason(false); });
        }).catch(function () { toast('服务没响应'); });
      });
    }
  }

  // ---------------- 弹层 ----------------
  var dlgReturnFocus = null;
  function openDlg(title, bodyHtml, footHtml) {
    if (!$('#mask').classList.contains('show')) dlgReturnFocus = document.activeElement;
    $('#dlg').innerHTML = '<h3 id="dlgTitle">' + esc(title) + '</h3>' +
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
    var first = $('#dlg').querySelector('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]');
    (first || $('#dlg')).focus({ preventScroll: true });
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

  function openWatchDetail(id) {
    if (!id) return showWatchForm({ ep_status: 0 });
    openDlg('番剧详情', '<p id="watchLoading" role="status">正在读取番剧资料…</p>');
    var marker = $('#watchLoading');
    flushAllBumps();
    POST_CHAIN.then(function () { return json('/api/watch/detail?id=' + enc(id)); }).then(function (j) {
      if (marker.isConnected) showWatchForm(j.detail);
    }).catch(function (e) {
      if (marker.isConnected) openDlg('读不到番剧详情', '<p role="alert">' + esc(e.message || '请刷新后再试') + '</p>');
    });
  }

  function changeWatchState(id, action, revision, dialog) {
    return post('/api/watch/lifecycle', { id: String(id), action: action, expected_revision: revision }).then(function (j) {
      if (!j.ok) throw new Error(j.error || '没有改成，请重试');
      if (dialog && dialog.isConnected) closeDlg();
      if (j.changed) {
        var message = action === 'pause' ? '已暂停，停止开播提醒' : action === 'archive' ? '已归档，可在番库找到' : '已恢复，保留原进度';
        toast(j.rebuild_error ? '状态已保存，桌宠数据暂未刷新' : message, { label: '撤销', fn: undo });
      }
      return refresh();
    });
  }

  function showWatchForm(detail) {
    var archived = detail.state === 'archived';
    var controls = '';
    if (detail.id) {
      controls = '<div class="watch-lifecycle"><span class="tag mut">' + WATCH_STATE_LABEL[detail.state] + '</span>' +
        (detail.state === 'watching' ? '<button type="button" data-life="pause">暂停追番</button>' :
          '<button type="button" data-life="resume">' + (archived ? '恢复到在追' : '继续追番') + '</button>') +
        (!archived && detail.eps > 0 && detail.ep_status >= detail.eps ? '<button type="button" data-life="archive">归档已看完</button>' : '') +
        '</div>';
    }
    var opts = '<option value="">未排期</option>' + WEEK_ORDER.map(function (d) {
      return '<option value="' + d + '"' + (d === detail.air_weekday ? ' selected' : '') + '>周' + CN[d] + '</option>';
    }).join('');
    openDlg(detail.id ? '番剧详情' : '手动添加番剧',
      '<form id="watchForm"><fieldset class="watch-fields" aria-label="番剧资料"' + (archived ? ' disabled' : '') + '>' +
      '<label class="watch-field watch-wide">番名<input id="watchName" type="text" maxlength="160" required value="' + esc(detail.name) + '" /></label>' +
      '<label class="watch-field">已看到第几集<input id="watchSeen" type="number" min="0" step="1" required inputmode="numeric" value="' + esc(detail.ep_status) + '" /></label>' +
      '<label class="watch-field">总集数<input id="watchTotal" type="number" min="1" step="1" inputmode="numeric" placeholder="未知可留空" value="' + esc(detail.eps) + '" /></label>' +
      '<label class="watch-field">开播星期<select id="watchDay">' + opts + '</select></label>' +
      '<label class="watch-field">开播时间（北京时间）<input id="watchTime" type="text" maxlength="12" placeholder="如 23:30" aria-describedby="watchTimeHint" value="' + esc(detail.air_time_cst) + '" /></label>' +
      '<p id="watchTimeHint" class="watch-wide watch-hint">时间可留空。周一 25:30 会排到周二 01:30。修改已看集数不会增加今日观看统计。</p>' +
      (archived ? '' : '<div class="watch-wide watch-lookup"><button type="button" id="watchLookup">联网查时刻</button>' +
      '<span class="watch-hint">来源 <a href="https://github.com/bangumi-data/bangumi-data" target="_blank" rel="noopener noreferrer">bangumi-data</a>（CC BY 4.0）</span></div>' +
      '<div id="watchMatches" class="watch-wide" role="status" hidden></div>') +
      '</fieldset>' + controls + '<p id="watchError" class="watch-error" role="alert" hidden></p></form>',
      '<button type="button" data-close>' + (archived ? '关闭' : '取消') + '</button>' +
      (archived ? '' : '<button type="submit" form="watchForm" id="watchSave" class="primary">' + (detail.id ? '保存修改' : '加入在追') + '</button>'));
    var form = $('#watchForm');
    var name = $('#watchName', form), seen = $('#watchSeen', form), total = $('#watchTotal', form);
    var day = $('#watchDay', form), time = $('#watchTime', form), error = $('#watchError', form);
    var matches = $('#watchMatches', form), lookup = $('#watchLookup', form);
    var save = $('#watchSave');
    var saving = false;
    function setBusy(value) {
      saving = value;
      if (save) save.disabled = value;
      form.querySelector('fieldset').disabled = value || archived;
      form.querySelectorAll('[data-life]').forEach(function (b) { b.disabled = value; });
    }
    function showError(message) { error.textContent = message; error.hidden = false; }
    form.querySelectorAll('[data-life]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (saving) return;
        if (!archived && (name.value.trim() !== detail.name || Number(seen.value) !== detail.ep_status ||
            (Number(total.value) || null) !== detail.eps || (Number(day.value) || null) !== detail.air_weekday ||
            (time.value.trim() || null) !== detail.air_time_cst)) {
          return showError('请先保存详情修改，再调整追番状态。');
        }
        error.hidden = true;
        setBusy(true);
        changeWatchState(detail.id, b.getAttribute('data-life'), detail.revision, form)
          .catch(function (e) { showError(e.message || '没有改成，请重试'); })
          .finally(function () { setBusy(false); });
      });
    });

    if (archived) return;

    day.addEventListener('change', function () { if (!day.value) time.value = ''; });

    lookup.addEventListener('click', function () {
      var query = name.value.trim();
      matches.hidden = false;
      if (!query) { matches.textContent = '请先填番名'; name.focus(); return; }
      lookup.disabled = true;
      matches.textContent = '正在查周播时刻…';
      // This request only searches; it does not change the last library write or its undo target.
      sendPost('/api/schedule/lookup', { id: detail.id, name: query }).then(function (j) {
        if (!form.isConnected) return;
        if (!j.ok) { matches.textContent = j.error || '查时刻失败，可以手填后保存。'; return; }
        var candidates = j.candidates || [];
        if (!candidates.length) { matches.textContent = '没有找到明确的周播时刻。可试试原名，或手填后保存。'; return; }
        matches.textContent = '';
        var hint = document.createElement('p');
        hint.textContent = '请选择同一部番的周播时段（北京时间），临时调档以播放平台为准。';
        matches.appendChild(hint);
        candidates.forEach(function (item) {
          var button = document.createElement('button');
          button.type = 'button';
          var label = document.createElement('strong');
          label.textContent = item.name;
          var caption = document.createElement('span');
          caption.textContent = '周' + CN[item.weekday] + ' ' + item.time_cst + ' · ' + item.since +
            (item.original_name !== item.name ? ' · ' + item.original_name : '');
          button.appendChild(label);
          button.appendChild(caption);
          button.addEventListener('click', function () {
            day.value = String(item.weekday);
            time.value = item.time_cst;
            matches.textContent = '已填入周' + CN[item.weekday] + ' ' + item.time_cst + '。保存后生效。';
            time.focus();
          });
          matches.appendChild(button);
        });
      }).catch(function () { matches.textContent = '查询未完成，可以手填后保存。'; })
        .finally(function () { lookup.disabled = false; });
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (saving) return;
      error.hidden = true;
      var payload = { id: detail.id, expected_revision: detail.revision, name: name.value.trim(),
        eps: total.value === '' ? null : Number(total.value), ep_status: Number(seen.value),
        air_weekday: day.value ? Number(day.value) : null, air_time_cst: time.value.trim() || null };
      setBusy(true);
      post('/api/watch/detail', payload).then(function (j) {
        if (!j.ok) { error.textContent = j.error || '保存失败'; error.hidden = false; return; }
        if (form.isConnected) closeDlg();
        if (j.changed) toast(j.rebuild_error ? '已保存，桌宠数据暂未刷新' : (j.added ? '已加入在追' : '详情已保存'), { label: '撤销', fn: undo });
        return refresh().then(function () {
          if (j.added) {
            QUERY = '';
            $('#q').value = '';
            switchTab(j.detail.air_weekday ? 'week' : 'today');
          }
        });
      }).catch(function () { error.textContent = '服务没有响应，请刷新后确认是否已经保存'; error.hidden = false; })
        .finally(function () { setBusy(false); });
    });
  }

  // ---------------- 同步 ----------------
  function doSync() {
    if (BUSY) return toast('还在跑，等它跑完');
    BUSY = true;
    var btn = $('#syncBtn');
    btn.disabled = true;
    btn.textContent = '同步中…';
    post('/api/sync', { dry_run: true }).then(function (j) {
      BUSY = false; btn.disabled = false; btn.textContent = '同步';
      if (j.ok === false || j.error) {
        return openDlg('同步失败', '<div class="empty">' + esc((j.log || '').slice(-800) || '没有输出') +
          '<br />常见原因：没开代理，或 bgm.tv 连不上。把代理填在「账号」里。</div>');
      }
      var log = String(j.log || '').trim();
      openDlg('同步预览（还没落盘）',
        '<div>下面是从 Bangumi 拉回来的改动，确认后才会写进库里。</div><pre>' + esc(log || '（没有需要改的地方）') + '</pre>',
        '<button data-close>先不动</button><button class="primary" id="syncGo">确认写入</button>');
      var go = $('#syncGo');
      if (go) go.addEventListener('click', function () {
        closeDlg();
        BUSY = true; btn.disabled = true; btn.textContent = '写入中…';
        post('/api/sync', { dry_run: false }).then(function (r) {
          BUSY = false; btn.disabled = false; btn.textContent = '同步';
          if (r.ok === false || r.error) return openDlg('同步失败',
            '<div class="empty">' + esc(String(r.log || r.error || '没有输出').slice(-800)) + '</div>');
          toast('同步完成');
          refresh().then(function () { if (TAB === 'season') loadSeason(false); });
        }).catch(function () {
          // 以前这里没有 catch：写入失败会把「同步中…」和 BUSY 永远挂住，之后点什么都没反应
          BUSY = false; btn.disabled = false; btn.textContent = '同步';
          toast('服务没响应，没有写入');
        });
      });
    }).catch(function () {
      BUSY = false; btn.disabled = false; btn.textContent = '同步';
      toast('服务没响应');
    });
  }

  // ---------------- 启动 ----------------
  function boot() {
    try { TAB = localStorage.getItem('kx.tab') || 'week'; } catch (e) { TAB = 'week'; }
    try { WEEK_ALL = localStorage.getItem('kx.weekAll') === '1'; } catch (e) {}
    try {
      var want = new URLSearchParams(location.search).get('tab');
      if (VIEWS.indexOf(want) >= 0) TAB = want;
      if (new URLSearchParams(location.search).get('all') === '1') WEEK_ALL = true;
      if (new URLSearchParams(location.search).get('welcome') === '1') WELCOME_FORCE = true;
    } catch (e) {}
    if (VIEWS.indexOf(TAB) < 0) TAB = 'week';

    document.querySelectorAll('.tab').forEach(function (b) {
      var active = b.getAttribute('data-tab') === TAB;
      b.classList.toggle('on', active);
      if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
    });
    // 搜索防抖：每敲一个字就重建 167 行表格，输入法组合时尤其卡
    var qTimer = null;
    $('#q').addEventListener('input', function () {
      clearTimeout(qTimer);
      qTimer = setTimeout(function () {
        QUERY = $('#q').value;
        if (TAB === 'season') {
          var b = $('#seasonBody');
          if (b) { b.innerHTML = seasonBodyHtml(); bindSeason(); }
        } else {
          render();
        }
      }, 120);
    });

    $('#clockBtn').addEventListener('click', function () {
      var next = CLOCK === '30h' ? '24h' : '30h';
      post('/api/settings', { clock: next }).then(function (j) {
        if (j.ok === false || j.error) return toast(j.error || '时制没保存');
        CLOCK = (j.settings && j.settings.clock) || next;
        paintClock();
        render();
      }).catch(function () { toast('服务没响应'); });
    });

    $('#syncBtn').addEventListener('click', doSync);

    $('#scaleSel').addEventListener('change', function () {
      post('/api/settings', { pet_scale: Number($('#scaleSel').value) }).then(function (j) {
        if (j.ok === false || j.error) return toast(j.error || '没改成');
        toast('桌宠尺寸已改，桌宠会自己跟上');
      }).catch(function () { toast('服务没响应，尺寸没存'); });
    });

    var coverSaved = 'md';
    try { coverSaved = localStorage.getItem('kx.cover') || 'md'; } catch (e) {}
    try {
      var cv = new URLSearchParams(location.search).get('cover');
      if (cv && COVER[cv]) coverSaved = cv;
    } catch (e) {}
    setCover(coverSaved);
    $('#coverSel').addEventListener('change', function () {
      setCover($('#coverSel').value);
    });

    $('#restoreBtn').addEventListener('click', function () {
      json('/api/backups').then(function (j) {
        var list = (j.backups || []);
        openDlg('恢复上一版',
          '<div>会把 <b>library.json</b> 换成备份。当前版本会先另存一份。</div>' +
          (list.length ? '<pre>' + esc(list.map(function (b) {
            return (b.name || '') + '  ' + (b.mtime ? new Date(b.mtime).toLocaleString('zh-CN') : '');
          }).join('\n')) + '</pre>' : '<div class="empty">还没有备份。</div>'),
          '<button data-close>取消</button><button class="primary" id="restoreGo">恢复</button>');
        var go = $('#restoreGo');
        if (go) go.addEventListener('click', function () {
          post('/api/restore', { name: (list[0] && list[0].name) || 'library.json.bak' }).then(function (r) {
            if (r.ok === false || r.error) { closeDlg(); return toast(r.error || '恢复失败'); }
            closeDlg();
            toast('已恢复');
            refresh();
          }).catch(function () { toast('服务没响应，没有恢复'); });
        });
      }).catch(function () { toast('读不到备份列表'); });
    });

    $('#icsBtn').addEventListener('click', function () { location.href = '/api/export?fmt=ics'; });
    $('#mdBtn').addEventListener('click', function () { location.href = '/api/export?fmt=md'; });

    $('#tokenBtn').addEventListener('click', function () {
      json('/api/token').then(function (j) {
        openDlg('账号与称呼',
          '<div class="empty" style="padding:0 0 10px;text-align:left">Bangumi 的 token 只写在本机 <b>data/bgm.json</b>；不填也能用公开日历。</div>' +
          '<div class="row"><span>用户名</span><input type="text" id="tkUser" value="' + esc(j.user || '') + '" /></div>' +
          '<div class="row"><span>Token</span><input type="text" id="tkTok" placeholder="' + esc(j.token_mask || '还没填') + '" /></div>' +
          '<div class="row"><span>代理</span><input type="text" id="tkProxy" value="' + esc(j.proxy || '') + '" placeholder="http://127.0.0.1:7890" /></div>' +
          '<div class="row" style="margin-top:12px"><span>她叫你</span><input type="text" id="tkNick" maxlength="12" value="' + esc((STATE.nickname) || '') + '" placeholder="' + esc((STATE.persona && STATE.persona.default) || '会長') + '" /></div>' +
          '<div class="empty" style="padding:4px 0 0;text-align:left;font-size:11.5px">' +
          '存进 <b>data/library.json</b> 的 <code>user.nickname_for_pet</code>，桌宠与面板都跟着变。' +
          '生气时的「不届き者」这类固定说法不跟着改。</div>',
          '<button data-close>取消</button><button class="primary" id="tkSave">保存</button>');
        $('#tkSave').addEventListener('click', function () {
          var nick = ($('#tkNick').value || '').trim();
          post('/api/token', {
            user: $('#tkUser').value.trim(),
            token: $('#tkTok').value.trim() || undefined,
            proxy: $('#tkProxy').value.trim()
          }).then(function (r) {
            if (r.ok === false || r.error) { toast(r.error || '账号保存失败'); return; }
            if (!nick || nick === STATE.nickname) { closeDlg(); toast('账号已保存'); return; }
            post('/api/nickname', { nickname: nick }).then(function (n) {
              if (n.ok === false || n.error) { toast(n.error || '称呼保存失败'); return; }
              STATE.nickname = n.nickname;
              closeDlg();
              refresh();
              toast('以后她就叫你「' + n.nickname + '」了');
            }).catch(function () { toast('服务没响应，称呼没存上'); });
          }).catch(function () { toast('服务没响应，账号没存上'); });
        });
      });
    });

    // ---------------- 诊断：服务日志 ----------------
    function doDiagnose() {
      json('/api/logs?tail=160').then(function (j) {
        var text = (j.lines || []).join('\n');
        var errs = (j.lines || []).filter(function (l) { return l.indexOf('[error]') >= 0; }).length;
        openDlg('诊断 · 服务日志',
          '<div class="empty" style="padding:0 0 10px;text-align:left">' +
          '文件 <b>' + esc(j.path || 'cache/server.log') + '</b>　' +
          '大小 ' + Math.round((j.size || 0) / 1024) + ' KB　' +
          '错误 ' + errs + ' 行' +
          '<br />重建失败、预热失败、端口回退都记在这里。要清空直接删文件即可。</div>' +
          '<pre style="max-height:46vh;overflow:auto;margin:0">' + esc(text || '（还没有日志）') + '</pre>',
          '<button data-close>关掉</button><button id="diagRefresh">刷新</button>');
        var btn = $('#diagRefresh');
        if (btn) btn.addEventListener('click', function () { closeDlg(); doDiagnose(); });
      }).catch(function () { toast('读不到日志'); });
    }

    $('#diagBtn').addEventListener('click', doDiagnose);

    // 顶栏「待看 N」
    var pBtn = $('#pendingBtn');
    if (pBtn) pBtn.addEventListener('click', showPending);

    // 主题：暗 → 亮 → 跟随系统
    // 主题：暗 → 亮 → 跟随系统
    var THEMES = ['dark', 'light', 'auto'];
    var mqDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    function systemIsDark() { return !mqDark || mqDark.matches; }
    function paintThemeChrome(t) {
      var eff = t === 'auto' ? (systemIsDark() ? 'dark' : 'light') : t;
      var meta = document.getElementById('themeColor');
      if (meta) meta.setAttribute('content', eff === 'light' ? '#f4f6fa' : '#0e1116');
    }
    function applyTheme(t) {
      var html = document.documentElement;
      if (t === 'auto') html.removeAttribute('data-theme');
      else html.setAttribute('data-theme', t);
      var btn = $('#themeBtn');
      if (btn) btn.textContent = t === 'light' ? '亮色' : t === 'auto' ? '自动' : '暗色';
      paintThemeChrome(t);
    }
    var themeNow = 'dark';
    try { themeNow = localStorage.getItem('kx.theme') || 'dark'; } catch (e) {}
    applyTheme(themeNow);
    $('#themeBtn').addEventListener('click', function () {
      themeNow = THEMES[(THEMES.indexOf(themeNow) + 1) % THEMES.length];
      try { localStorage.setItem('kx.theme', themeNow); } catch (e) {}
      applyTheme(themeNow);
      toast(themeNow === 'light' ? '亮色' : themeNow === 'auto' ? '跟随系统' : '暗色');
    });
    // 「自动」以前等于永远暗色：CSS 里没有 prefers-color-scheme，切了也不跟。现在真的跟系统走。
    if (mqDark) {
      var onSysTheme = function () { if (themeNow === 'auto') applyTheme('auto'); };
      if (mqDark.addEventListener) mqDark.addEventListener('change', onSysTheme);
      else if (mqDark.addListener) mqDark.addListener(onSysTheme);
    }

    $('#mask').addEventListener('click', function (e) { if (e.target === $('#mask')) closeDlg(); });
    document.addEventListener('click', function (e) {
      var target = e.target.closest('[data-new-watch], [data-detail]');
      if (target) openWatchDetail(target.getAttribute('data-detail'));
      var resume = e.target.closest('[data-resume]');
      if (!resume || resume.disabled) return;
      resume.disabled = true;
      changeWatchState(resume.getAttribute('data-resume'), 'resume').catch(function (err) {
        toast(err.message || '恢复失败，请重试');
      }).finally(function () { resume.disabled = false; });
    });

    // ---------------- 键盘 ----------------
    // 鼠标记一话要三次点击（找番 → 对准 + → 撤销弹窗），键盘是一条「番列表 + 空格」的路：
    //   j / ↓ 下一部　k / ↑ 上一部　空格 记一话　x 移出在追　u 撤销　1/2/3 切页　/ 搜
    function rowsForKb() {
      return Array.prototype.slice.call(document.querySelectorAll('#view .show[data-card]'));
    }
    function selRow(id) {
      var rows = rowsForKb();
      for (var i = 0; i < rows.length; i++) rows[i].classList.toggle('sel', rows[i].getAttribute('data-card') === String(id));
    }
    function moveSel(step) {
      var rows = rowsForKb();
      if (!rows.length) return;
      var idx = -1;
      for (var i = 0; i < rows.length; i++) if (rows[i].classList.contains('sel')) idx = i;
      idx = idx < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, idx + step));
      rows.forEach(function (r) { r.classList.remove('sel'); });
      rows[idx].classList.add('sel');
      try { rows[idx].scrollIntoView({ block: 'nearest' }); } catch (e) {}
      SEL = rows[idx].getAttribute('data-card');
    }
    function curSel() {
      var r = document.querySelector('#view .show.sel[data-card]');
      return r ? r.getAttribute('data-card') : null;
    }

    document.addEventListener('keydown', function (e) {
      if ($('#mask').classList.contains('show')) {
        if (e.key === 'Escape') { e.preventDefault(); closeDlg(); }
        if (e.key === 'Tab') {
          var targets = Array.from($('#dlg').querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]'))
            .filter(function (el) { return !el.matches(':disabled') && el.getClientRects().length; });
          var edge = e.shiftKey ? targets[0] : targets[targets.length - 1];
          if (!targets.length || document.activeElement === edge || !$('#dlg').contains(document.activeElement)) {
            e.preventDefault();
            (targets[e.shiftKey ? targets.length - 1 : 0] || $('#dlg')).focus();
          }
        }
        return;
      }
      if (e.key === 'Escape' && $('#q').value) {
        e.preventDefault();
        $('#q').value = '';
        $('#q').dispatchEvent(new Event('input'));
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
      if (e.key === '1') return document.querySelector('.tab[data-tab=week]').click();
      if (e.key === '2') return document.querySelector('.tab[data-tab=today]').click();
      if (e.key === '3') return document.querySelector('.tab[data-tab=season]').click();
      if (e.key === '4') return document.querySelector('.tab[data-tab=library]').click();
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
      if (TAB === 'season' && !SEASON) loadSeason(false);
    });
    setInterval(function () { if (!document.hidden) refresh(); }, 60000);
  }

  boot();
})();
