import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// Execute the real panel functions; only DOM painting and HTTP are replaced.
async function panel() {
  let value = 3, previous = 0;
  const requests = [];
  const element = { addEventListener() {}, querySelector() { return null; }, classList: { add() {}, remove() {} } };
  const context = vm.createContext({ setTimeout, clearTimeout, console, URLSearchParams,
    document: { addEventListener() {}, querySelector() { return element; }, querySelectorAll() { return []; } },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      await new Promise(r => setTimeout(r, 20));
      let result;
      if (url === '/api/progress') {
        previous = value; value += body.delta;
        result = { ok: true, changed: !!body.delta, ep_status: value, revision: 'r' + value };
      } else {
        assert.equal(body.expected_revision, 'r' + value);
        value = previous; result = { ok: true };
      }
      return { ok: true, json: async () => result };
    }
  });
  let source = await fs.readFile(new URL('../panel/app.js', import.meta.url), 'utf8');
  source = source.replace('  boot();', `
    STATE = { watching: [{id: 1, eps: 12, ep_status: 3}] };
    toast = function() {}; paintWatch = function() {};
    refresh = function() { return Promise.resolve(); };
    globalThis.panelTest = { bump: bump, undo: undo, flush: flushAllBumps,
      settled: function() { return POST_CHAIN; }, seen: function() { return STATE.watching[0].ep_status; } };
  `);
  vm.runInContext(source, context);
  return { api: context.panelTest, requests, disk: () => value };
}

test('立即撤销先完成本次加一，再撤销该版本，原来的 3 话不受影响', async () => {
  const p = await panel();
  p.api.bump(1, 1); p.api.undo();
  await p.api.settled();
  assert.deepEqual(p.requests.map(x => x.url), ['/api/progress', '/api/undo']);
  assert.equal(p.disk(), 3);
});

test('前一个响应不会覆盖后续尚未提交的乐观进度', async () => {
  const p = await panel();
  p.api.bump(1, 1); p.api.flush();
  p.api.bump(1, 1);
  await p.api.settled();
  assert.equal(p.api.seen(), 5);
  p.api.flush(); await p.api.settled();
  assert.equal(p.disk(), 5);
  assert.equal(p.api.seen(), 5);
});

test('先加后减相互抵消，再撤销不会误撤销更早的记录', async () => {
  const p = await panel();
  p.api.bump(1,1); p.api.bump(1,-1); p.api.undo();
  await p.api.settled();
  assert.equal(p.disk(),3);
  assert.equal(p.requests.some(x=>x.url==='/api/undo'),false);
});
