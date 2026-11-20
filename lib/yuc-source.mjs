import { httpGet } from './bgm.mjs';

const SITE = 'https://yuc.wiki';
const INDEX = SITE + '/index/';
const LICENSE = 'https://creativecommons.org/licenses/by-nc-sa/4.0/';
const FIRST_INDEXED = '2019Q4';
const LAST_INDEXED = '2026Q4';
const CACHE_AGE = 6 * 3600_000;
const checked = new Map();
const inFlight = new Map();
const mediaHosts = ['bilibili.com', 'acg.gamer.com.tw', 'gamer.com.tw', 'youtube.com',
  'iqiyi.com', 'youku.com', 'netflix.com', 'amazon.co.jp', 'abema.tv', 'ani.gamer.com.tw'];

function text(value = '') {
  return value.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, (raw, key) => {
      const simple = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
      if (Object.hasOwn(simple, key)) return simple[key];
      const code = key.startsWith('#x') ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : raw;
    }).replace(/\s+/g, ' ').trim();
}

function titleKey(value) {
  return value.normalize('NFKC').toLowerCase().replace(/[\p{White_Space}\p{Punctuation}\p{Symbol}]/gu, '');
}

function quarter(year, month) {
  return [1, 4, 7, 10].includes(Number(month)) ? year + 'Q' + Math.ceil(Number(month) / 3) : null;
}

function articleUrl(raw) {
  try {
    const url = new URL(raw, SITE);
    if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'yuc.wiki' ||
        url.port || url.username || url.password || url.search || url.hash) return null;
    const path = /^\/(\d{4})(01|04|07|10)\/?$/.exec(url.pathname);
    return path ? { q: quarter(path[1], path[2]), url: SITE + '/' + path[1] + path[2] + '/' } : null;
  } catch { return null; }
}

function source(url, extras = {}) {
  return { url, index: INDEX, author: '長門有C', license: LICENSE, ...extras };
}

export function yucReference(q) {
  if (checked.has(q)) return checked.get(q).ref;
  if (!/^\d{4}Q[1-4]$/.test(q) || q < FIRST_INDEXED || q > LAST_INDEXED) return source(null);
  const month = String(1 + (Number(q.at(-1)) - 1) * 3).padStart(2, '0');
  return source(SITE + '/' + q.slice(0, 4) + month + '/');
}

function retain(q, state) {
  checked.delete(q);
  checked.set(q, state);
  if (checked.size > 8) checked.delete(checked.keys().next().value);
}

export function parseYucAtom(xml) {
  const entries = new Map();
  if (!/<feed\b[^>]*xmlns=["']http:\/\/www.w3.org\/2005\/Atom["']/i.test(xml)) return entries;
  for (const [, entry] of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const header = entry.split(/<(?:content|summary)\b/i, 1)[0];
    const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(header)?.[1];
    const term = /^(\d{4})年(\d{1,2})月新番(?:表)?$/.exec(text(title));
    const link = /<link\b[^>]*\bhref=["']([^"']+)["']/i.exec(header)?.[1];
    const article = articleUrl(link);
    if (!term || !article || article.q !== quarter(term[1], term[2])) continue;
    const updated = /<updated\b[^>]*>([^<]+)<\/updated>/i.exec(header)?.[1];
    entries.set(article.q, source(article.url, {
      discovered_by: 'Atom', article_updated_at: Number.isFinite(Date.parse(updated)) ? new Date(updated).toISOString() : null,
    }));
  }
  return entries;
}

function byClass(html, tag, name) {
  const re = new RegExp('<' + tag + '\\b[^>]*class=["\'][^"\']*\\b' + name +
    '\\b[^"\']*["\'][^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  return re.exec(html)?.[1] || '';
}

function images(html) {
  return [...html.matchAll(/<img\b[^>]*\b(?:data-src|src)=["']([^"']+)["']/gi)].map(match => match[1]);
}

function regionalLinks(card) {
  return [...card.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].flatMap(match => {
    const region = text(byClass(match[2], 'p', 'area'));
    if (!/^(?:大陆|港澳台|港台|香港|台湾|环大陆|日本|海外|全球)$/.test(region)) return [];
    try {
      const u = new URL(text(match[1]));
      if (u.protocol !== 'https:' || u.username || u.password || u.port ||
          !mediaHosts.some(host => u.hostname === host || u.hostname.endsWith('.' + host))) return [];
      return [{ region, url: u.href }];
    } catch { return []; }
  });
}

export function matchYucArticle(html, q, item) {
  const title = text(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1] ||
    /<title>([^<]+)<\/title>/i.exec(html)?.[1]);
  const dated = /^(\d{4})年(\d{1,2})月新番/.exec(title);
  if (!dated || quarter(dated[1], dated[2]) !== q) return { status: 'format_changed' };
  const japanese = titleKey(item.name || '');
  if (!japanese || !item.date) return { status: 'unmatched' };
  const detailRows = [...html.matchAll(/(<div\b[^>]*>[\s\S]*?<(?:td|table)\b[\s\S]*?<\/table>)[\t \r\n]*<\/div>/gi)]
    .map(match => match[1]);
  // The article lists original titles separately from its weekly tiles. Only join on the exact shared image URL.
  const matching = detailRows.filter(row => titleKey(text(byClass(row, 'p', 'title_jp_r[12]?'))) === japanese);
  if (!matching.length) return { status: 'unmatched' };
  if (matching.length !== 1) return { status: 'ambiguous' };
  const detail = matching[0];
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(item.date);
  const premiere = /^(\d{1,2})\/(\d{1,2})/.exec(text(byClass(detail, 'p', 'broadcast_r')));
  if (!date || !premiere || date[1] !== dated[1] || Number(date[2]) !== Number(premiere[1]) ||
      Number(date[3]) !== Number(premiere[2])) return { status: 'date_conflict' };
  const originalImages = images(detail);
  const tiles = [...html.matchAll(/(<div\b[^>]*class=["'][^"']*\bdiv_date\b[^"']*["'][^>]*>[\s\S]*?<\/table>)/gi)]
    .map(match => match[1]).filter(tile => images(tile).some(image => originalImages.includes(image)));
  if (tiles.length !== 1) return { status: tiles.length ? 'ambiguous' : 'format_changed' };
  const tile = tiles[0];
  const episodes = text(byClass(tile, 'p', 'imgep'));
  const note = text(byClass(tile, 'p', 'imgtext2'));
  const full = /^\(全([1-9]\d{0,2})[话話集]\)$/.exec(episodes.normalize('NFKC'));
  const split = /暂完|階段|阶段|分割|part|P\d+\s*=/i.test(note + ' ' + episodes);
  return { status: 'matched', episodes: full && !split ? Number(full[1]) : null,
    broadcast: split ? 'partial' : /^完[结結]$/.test(note) ? 'ended' : 'unknown', regions: regionalLinks(tile) };
}

async function load(url, proxy) {
  const result = await httpGet(url, { proxy, timeoutMs: 6000, signal: AbortSignal.timeout(6000), redirect: 'manual' });
  if (result.status !== 200 || result.body.length > 800_000) throw new Error('長門番堂暂不可用');
  return result.body.toString('utf8');
}

export async function lookupYuc(q, item, proxy) {
  let ref = yucReference(q);
  try {
    let state = checked.get(q);
    if (!state || Date.now() - Date.parse(state.at) > CACHE_AGE) {
      if (!inFlight.has(q)) {
        const pending = (async () => {
          const atom = await load(SITE + '/atom.xml', proxy).then(parseYucAtom).catch(() => new Map());
          const index = !ref.url && !atom.has(q) ? await load(INDEX, proxy).catch(() => '') : '';
          for (const [, link] of index.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)) {
            const hit = articleUrl(link);
            if (hit?.q === q) { ref = source(hit.url, { discovered_by: '季度索引' }); break; }
          }
          ref = atom.get(q) || ref;
          if (!ref.url) return { ref, at: null };
          return { ref, at: new Date().toISOString(), ...(item ? { html: await load(ref.url, proxy) } : {}) };
        })().finally(() => inFlight.delete(q));
        inFlight.set(q, pending);
      }
      state = await inFlight.get(q);
      if (state.at) retain(q, state);
    }
    if (item && state.ref.url && !state.html) {
      state = { ...state, html: await load(state.ref.url, proxy), at: new Date().toISOString() };
      retain(q, state);
    }
    return { ...state.ref, checked_at: state.at,
      ...(item ? { review: state.html ? matchYucArticle(state.html, q, item) : { status: 'unavailable' } } : {}) };
  } catch { return { ...ref, review: { status: 'unavailable' } }; }
}
