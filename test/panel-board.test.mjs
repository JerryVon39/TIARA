import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('排片看板先加载内容，隐藏时暂停定时刷新', async () => {
  const elements = new Map();
  const events = new Map();
  const timers = new Map();
  const listen = (event, callback) => events.set(event, callback);
  const element = () => ({ textContent: '', append() {}, replaceChildren() {}, addEventListener() {} });
  const document = {
    visibilityState: 'hidden',
    documentElement: { dataset: {} },
    addEventListener: listen,
    createElement: element,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
  };
  let requests = 0;
  const source = await fs.readFile(new URL('../panel/board.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    document, window: { addEventListener: listen }, localStorage: { getItem: () => null }, AbortController,
    fetch: async url => {
      assert.equal(url, '/api/schedule/board');
      requests++;
      return { ok: true, json: async () => ({ ok: true, rows: [], next: {
        date: '2026-11-19', time: '21:35', name: '下一档测试',
      } }) };
    },
    setTimeout(callback, delay) { const id = Symbol(); timers.set(id, delay); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  await new Promise(setImmediate);
  assert.equal(requests, 1);
  assert.match(elements.get('boardNext').textContent, /下一档测试/);
  assert.equal(timers.size, 0);

  document.visibilityState = 'visible';
  events.get('visibilitychange')();
  await new Promise(setImmediate);
  assert.equal(requests, 2);
  assert.deepEqual([...timers.values()], [30000]);
});
