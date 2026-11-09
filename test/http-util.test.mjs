/**
 * lib/http-util.mjs 的单测：这三个函数决定了「谁能写库」和「坏请求回什么码」，
 * 出错的方式都很安静（写接口被挡掉 / 413 变 ECONNRESET），值得钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isLocalOrigin, checkWriteOrigin, checkBodySize, parseJsonBody } from '../lib/http-util.mjs';

test('无 Origin（curl、本地脚本）一律放行', () => {
  assert.equal(isLocalOrigin(undefined), true);
  assert.equal(isLocalOrigin(''), true);
  assert.equal(checkWriteOrigin(undefined), null);
});

test('本机来源放行：127.0.0.1 / localhost / [::1]，端口随意', () => {
  assert.equal(isLocalOrigin('http://127.0.0.1:7788'), true);
  assert.equal(isLocalOrigin('http://127.0.0.1:7799'), true);
  assert.equal(isLocalOrigin('http://localhost:7788'), true);
  assert.equal(isLocalOrigin('http://[::1]:7788'), true);
  assert.equal(isLocalOrigin('https://127.0.0.1'), true);
});

test('外站来源挡掉，并回 403 + 原始 origin', () => {
  for (const bad of ['http://evil.com', 'https://evil.com:7788', 'http://127.0.0.1.evil.com', 'null']) {
    assert.equal(isLocalOrigin(bad), false, bad + ' 不该被放行');
    const r = checkWriteOrigin(bad);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'cross-origin write blocked');
    assert.equal(r.body.origin, bad);
  }
});

test('body 体积：刚好等于上限算过，超一字节就 413', () => {
  assert.equal(checkBodySize(1024, 1024).ok, true);
  const over = checkBodySize(1025, 1024);
  assert.equal(over.ok, false);
  assert.equal(over.status, 413);
  assert.equal(over.body.error, 'body too large');
  assert.equal(over.body.limit, 1024);
  // 默认 1 MB
  assert.equal(checkBodySize(1024 * 1024).ok, true);
  assert.equal(checkBodySize(1024 * 1024 + 1).ok, false);
});

test('JSON 解析：空串当空对象，坏 JSON 回 400', () => {
  assert.deepEqual(parseJsonBody(''), { ok: true, value: {} });
  assert.deepEqual(parseJsonBody('   \n '), { ok: true, value: {} });
  assert.deepEqual(parseJsonBody('{"a":1}').value, { a: 1 });
  const bad = parseJsonBody('{a:1}');
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'bad json');
});

test('超大 body 不该解析成功（护栏顺序：先解析再量体积也不行，两处都要挡）', () => {
  const big = '{"x":"' + 'a'.repeat(2 * 1024 * 1024) + '"}';
  assert.equal(parseJsonBody(big).ok, true);          // JSON 本身是合法的
  assert.equal(checkBodySize(Buffer.byteLength(big, 'utf8')).ok, false); // 但体积拦下来
});

test('写请求必须是 JSON 对象，标量和数组直接回 400', () => {
  for (const text of ['null', 'false', '0', '""', '"abc"', '[]', '[{}]']) {
    assert.equal(parseJsonBody(text).status, 400, text);
  }
});
