/**
 * lib/persona.mjs 的单测
 *
 * 重点不是「字符串能不能存」，而是三条约定：
 *   1. 空 / 过长 / 带花括号的称呼要被挡下来（花括号会和占位符打架）；
 *   2. 换行、制表符、连续空格会被压平（否则气泡会被撑坏）；
 *   3. 库里没写、或写了非法值时，一律回落到默认称呼「会長」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_NICKNAME,
  RESERVED_TERMS,
  normalizeNickname,
  addressOf,
  personaInfo,
} from '../lib/persona.mjs';

test('默认称呼是「会長」，固定说法不跟它走', () => {
  assert.equal(DEFAULT_NICKNAME, '会長');
  assert.equal(RESERVED_TERMS.angry, '不届き者');
  assert.equal(RESERVED_TERMS.selfRef, '副会長');
});

test('普通称呼通过，并去掉首尾空白', () => {
  assert.deepEqual(normalizeNickname('会長'), { ok: true, value: '会長' });
  assert.deepEqual(normalizeNickname('  部长  '), { ok: true, value: '部长' });
  assert.deepEqual(normalizeNickname('Senpai'), { ok: true, value: 'Senpai' });
});

test('换行/制表符/连续空格压成一个空格', () => {
  assert.deepEqual(normalizeNickname('前\n辈'), { ok: true, value: '前 辈' });
  assert.deepEqual(normalizeNickname('a\t\tb'), { ok: true, value: 'a b' });
  assert.deepEqual(normalizeNickname('  a     b  '), { ok: true, value: 'a b' });
});

test('空、全空白、非字符串都要挡下来', () => {
  assert.equal(normalizeNickname('').ok, false);
  assert.equal(normalizeNickname('   ').ok, false);
  assert.equal(normalizeNickname(' \n\t ').ok, false);
  assert.equal(normalizeNickname(null).ok, false);
  assert.equal(normalizeNickname(42).ok, false);
});

test('超过 12 个字要挡下来（按字符数算，不是字节数）', () => {
  assert.equal([...'甲乙丙丁戊己庚辛壬癸子丑'].length, 12);
  assert.equal(normalizeNickname('甲乙丙丁戊己庚辛壬癸子丑').ok, true); // 12
  const tooLong = normalizeNickname('甲乙丙丁戊己庚辛壬癸子丑寅'); // 13
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error, /12/);
});

test('花括号会被占位符吃掉，必须拒绝', () => {
  const r = normalizeNickname('{nickname}');
  assert.equal(r.ok, false);
  assert.match(r.error, /花括号/);
  assert.equal(normalizeNickname('前{辈}').ok, false);
});

test('addressOf：正常值直接用，缺失或非法都回落默认', () => {
  assert.equal(addressOf({ user: { nickname_for_pet: '先輩' } }), '先輩');
  assert.equal(addressOf({ user: {} }), DEFAULT_NICKNAME);
  assert.equal(addressOf({}), DEFAULT_NICKNAME);
  assert.equal(addressOf(null), DEFAULT_NICKNAME);
  assert.equal(addressOf({ user: { nickname_for_pet: '' } }), DEFAULT_NICKNAME);
  assert.equal(addressOf({ user: { nickname_for_pet: '{bad}' } }), DEFAULT_NICKNAME);
});

test('personaInfo 给面板的那一包字段齐全', () => {
  const info = personaInfo({ user: { nickname_for_pet: '先輩' } });
  assert.equal(info.address, '先輩');
  assert.equal(info.default, '会長');
  assert.equal(info.max_len, 12);
  assert.equal(info.reserved.angry, '不届き者');
});
