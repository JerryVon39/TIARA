import { test } from 'node:test';
import assert from 'node:assert/strict';

import { coverIdOf, coverCachePath, isAllowedCoverUrl, pickCoverUrl, COVER_MAX_AGE } from '../lib/cover.mjs';

test('coverIdOf：只认 1–10 位数字', () => {
  assert.equal(coverIdOf('617452'), '617452');
  assert.equal(coverIdOf(425998), '425998');
  assert.equal(coverIdOf(' 123 '), '123');
  assert.equal(coverIdOf('12ab'), null);
  assert.equal(coverIdOf(''), null);
  assert.equal(coverIdOf(null), null);
  assert.equal(coverIdOf('12345678901'), null, '超过 10 位不认');
  assert.equal(coverIdOf('../etc/passwd'), null);
});

test('coverCachePath：落在 data/covers/<id>.jpg', () => {
  assert.equal(coverCachePath('C:/tiara', '617452'), 'C:/tiara/data/covers/617452.jpg');
  assert.equal(coverCachePath('C:/tiara', 'bad'), null, '非法 id 不给路径');
});

test('isAllowedCoverUrl：只放 bgm 图床的 https 图片路径', () => {
  assert.equal(isAllowedCoverUrl('https://lain.bgm.tv/r/100/pic/cover/l/35/c7/617452_BYl92.jpg'), true);
  assert.equal(isAllowedCoverUrl('https://lain.bgm.tv/pic/cover/l/xx.jpg'), true);
  assert.equal(isAllowedCoverUrl('https://api.bgm.tv/v0/subjects/1'), false, '不是图片路径');
  assert.equal(isAllowedCoverUrl('http://lain.bgm.tv/r/100/x.jpg'), false, '只认 https');
  assert.equal(isAllowedCoverUrl('https://evil.com/r/100/x.jpg'), false, '别的域名不放行（避免成为任意代理）');
  assert.equal(isAllowedCoverUrl('file:///C:/Windows/win.ini'), false);
  assert.equal(isAllowedCoverUrl('not a url'), false);
  assert.equal(isAllowedCoverUrl(null), false);
});

test('pickCoverUrl：按 id 找封面，找不到或不合规返回 null', () => {
  const items = [
    { id: 1, image: 'https://lain.bgm.tv/r/100/pic/cover/l/a.jpg' },
    { id: 2, image: 'https://evil.com/x.jpg' },
    { id: 3 },
  ];
  assert.equal(pickCoverUrl(items, 1), 'https://lain.bgm.tv/r/100/pic/cover/l/a.jpg');
  assert.equal(pickCoverUrl(items, 2), null, '不合规的地址不返回');
  assert.equal(pickCoverUrl(items, 3), null);
  assert.equal(pickCoverUrl(items, 999), null);
  assert.equal(pickCoverUrl(null, 1), null);
});

test('COVER_MAX_AGE 是 30 天（浏览器缓存头用它）', () => {
  assert.equal(COVER_MAX_AGE, 2592000);
});
