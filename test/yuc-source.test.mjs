import test from 'node:test';
import assert from 'node:assert/strict';
import { matchYucArticle, parseYucAtom, yucReference } from '../lib/yuc-source.mjs';

const item = { name: 'テスト、同じ名前', name_cn: '另一种译名', date: '2026-04-10' };

function article({ name = 'テスト 同じ名前', date = '4/10 金', quarter = '4', status = '完结',
  episodes = '（全12话）', link = 'https://acg.gamer.com.tw/acgDetail.php?s=1', duplicate = false } = {}) {
  const detail = '<div><img data-src="https://images.invalid/key.jpg"></div><div><table>' +
    '<tr><td><p class="title_jp_r1">' + name + '</p><p class="broadcast_r">' + date +
    '</p></td></tr></table></div>';
  return '<meta property="og:title" content="2026年' + quarter + '月新番表">' +
    '<div class="div_date"><p class="imgtext2">' + status + '</p><p class="imgep">' + episodes +
    '</p><img data-src="https://images.invalid/key.jpg"></div><div><table><tr><td>' +
    '<a href="' + link + '"><p class="area">港台</p></a></td></tr></table></div>' +
    detail + (duplicate ? detail : '');
}

test('从 Atom 验证季度与同源原文地址，较老季度可直接使用索引路径', () => {
  const feed = '<feed xmlns="http://www.w3.org/2005/Atom">' +
    '<entry><title>2027年1月新番表</title><link href="http://yuc.wiki/202701/"/>' +
    '<updated>2026-11-20T00:00:00Z</updated></entry>' +
    '<entry><title>2027年4月新番表</title><link href="https://foreign.invalid/202704/"/></entry>' +
    '<entry><title>2027年7月新番表</title><link href="https://yuc.wiki/202710/"/></entry></feed>';
  const refs = parseYucAtom(feed);
  assert.equal(refs.size, 1);
  assert.equal(refs.get('2027Q1').url, 'https://yuc.wiki/202701/');
  assert.equal(refs.get('2027Q1').article_updated_at, '2026-11-20T00:00:00.000Z');
  assert.equal(yucReference('2019Q4').url, 'https://yuc.wiki/201910/');
  assert.equal(yucReference('2027Q1').url, null);
});

test('核对同季日文名和首播日期，重名、分段和结构变化保留人工判断', () => {
  assert.deepEqual(matchYucArticle(article(), '2026Q2', item), {
    status: 'matched', episodes: 12, broadcast: 'ended',
    regions: [{ region: '港台', url: 'https://acg.gamer.com.tw/acgDetail.php?s=1' }],
  });
  assert.deepEqual(matchYucArticle(article({ status: '暂完', episodes: 'P1=12话', link: 'javascript:alert(1)' }), '2026Q2', item),
    { status: 'matched', episodes: null, broadcast: 'partial', regions: [] });
  assert.equal(matchYucArticle(article({ duplicate: true }), '2026Q2', item).status, 'ambiguous');
  assert.equal(matchYucArticle(article({ date: '4/17 金' }), '2026Q2', item).status, 'date_conflict');
  assert.equal(matchYucArticle(article({ quarter: 7 }), '2026Q2', item).status, 'format_changed');
  assert.equal(matchYucArticle(article({ name: 'テスト 同じ名前 第2期' }), '2026Q2', item).status, 'unmatched');
});
