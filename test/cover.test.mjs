import { test } from 'node:test';
import assert from 'node:assert/strict';

import { coverIdOf, coverCachePath, coverMediaType, downloadCover, isAllowedCoverUrl, pickCoverUrl, COVER_MAX_AGE } from '../lib/cover.mjs';

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

test('备用封面需启用且来自季度备用源，拒绝跨域重定向', async () => {
  const image = 'https://bgmimg.anibt.net/r/200/pic/cover/l/1/test.jpg';
  const item = { id: 1, image, cover_source: 'anibt' };
  assert.equal(isAllowedCoverUrl(image), false);
  assert.equal(isAllowedCoverUrl(image, true), true);
  assert.equal(isAllowedCoverUrl('https://bgmimg.anibt.net/r/200/other.jpg', true), false);
  assert.equal(isAllowedCoverUrl('https://bgmimg.anibt.net.example/pic/cover/test.jpg', true), false);
  assert.equal(pickCoverUrl([item], 1), null);
  assert.equal(pickCoverUrl([{ id: 1, image }], 1, true), null);
  assert.equal(pickCoverUrl([item], 1, true), image);
  const visited = [];
  assert.equal(await downloadCover(image, async url => {
    visited.push(url);
    return { status: 302, headers: { location: 'https://example.invalid/pic/cover/test.jpg' } };
  }, true), null);
  assert.deepEqual(visited, [image]);
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

test('封面验格式并逐跳检查换址，损坏文件不能当图片', async () => {
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=', 'base64');
  assert.equal(coverMediaType(image), 'image/png');
  assert.equal(coverMediaType(image.subarray(0, 48)), null);
  assert.equal(coverMediaType(Buffer.from('<html>后台缓存了一段错误网页</html>')), null);
  const seen = [];
  const fetchImage = async url => {
    seen.push(url);
    return seen.length === 1 ? { status: 302, headers: { location: '/pic/new.png' } } : { status: 200, body: image };
  };
  assert.deepEqual(await downloadCover('https://lain.bgm.tv/pic/first.png', fetchImage), image);
  assert.deepEqual(seen, ['https://lain.bgm.tv/pic/first.png', 'https://lain.bgm.tv/pic/new.png']);
  let called = 0;
  assert.equal(await downloadCover('https://lain.bgm.tv/pic/first.png', async () => {
    called++; return { status: 302, headers: { location: 'https://example.com/pic/new.png' } };
  }), null);
  assert.equal(called, 1);
});
