(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const visible = () => document.visibilityState !== 'hidden';
  const back = $('boardBack');
  const full = $('boardFullscreen');
  const week = $('boardWeek');
  const status = $('boardStatus');
  let timer, request, revision;

  try {
    const theme = localStorage.getItem('kx.theme');
    document.documentElement.dataset.theme = theme === 'dark' ||
      (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  } catch (error) {}

  function node(tag, text) {
    const element = document.createElement(tag);
    element.textContent = text;
    return element;
  }

  function refreshView(data) {
    const current = JSON.stringify(data);
    if (current === revision) return;
    revision = current;
    $('boardNext').textContent = data.next
      ? data.next.date.slice(5) + ' ' + data.next.time + ' · ' + data.next.name +
        (data.next.episode ? ' 第 ' + data.next.episode + ' 话' : '') + (data.next.kind === 'catchup' ? ' · 补番' : '')
      : '接下来暂无已定时排片。';
    const days = new Map();
    for (const row of data.rows) {
      if (!days.has(row.date)) days.set(row.date, []);
      days.get(row.date).push(row);
    }
    const sections = [];
    for (const [date, rows] of days) {
      const group = document.createElement('section');
      group.className = 'board-day';
      group.append(node('h3', date === data.date ? '今天 · ' + date.slice(5) : date.slice(5)));
      const list = document.createElement('ul');
      for (const row of rows) {
        const entry = document.createElement('li');
        entry.append(node('time', row.time || '时间未定'), node('span', row.name),
          node('small', row.kind === 'catchup' ? '补番' : row.episode ? '第 ' + row.episode + ' 话' : '开播'));
        list.append(entry);
      }
      group.append(list);
      sections.push(group);
    }
    week.replaceChildren(...(sections.length ? sections : [node('p', '还没有排片。')]));
  }

  async function refresh(initial = false) {
    clearTimeout(timer);
    if (request || (!initial && !visible())) return;
    request = new AbortController();
    const abort = setTimeout(() => request?.abort(), 6000);
    try {
      const response = await fetch('/api/schedule/board', { signal: request.signal, cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error('排片暂时不可用');
      refreshView(data);
      status.textContent = '';
    } catch (error) {
      if (visible()) status.textContent = '暂时连不上桌宠面板。上一份排片仍可查看，稍后会重试。';
    } finally {
      clearTimeout(abort);
      request = null;
      if (visible()) timer = setTimeout(refresh, 30000);
    }
  }

  function leave(event) {
    if (window.opener && !window.opener.closed) {
      event.preventDefault();
      window.opener.focus();
      window.close();
    }
  }
  back.addEventListener('click', leave);
  full.hidden = !document.documentElement.requestFullscreen;
  full.addEventListener('click', () => {
    const operation = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    operation.catch(() => { status.textContent = '浏览器暂时无法切换全屏。'; });
  });
  document.addEventListener('fullscreenchange', () => {
    full.textContent = document.fullscreenElement ? '退出全屏' : '全屏';
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else back.click();
    event.preventDefault();
  });
  document.addEventListener('visibilitychange', () => { if (visible()) refresh(); else clearTimeout(timer); });
  window.addEventListener('pagehide', () => { clearTimeout(timer); request?.abort(); });
  window.addEventListener('pageshow', event => { if (event.persisted) refresh(true); });
  refresh(true);
})();
