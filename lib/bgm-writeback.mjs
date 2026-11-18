import { fetchBgmIdentity, getJson, httpRequest } from './bgm.mjs';
import { episodeCoverage, MAX_EPISODE } from './watch-episodes.mjs';

const EPISODES = '/v0/users/-/collections/-/episodes/';
const failure = (message, status) => Object.assign(new Error(message), { status, writeback: true });

function options(config) {
  return {
    base: config.base, proxy: config.proxy, retries: 0, timeoutMs: 5000, redirect: 'error',
    headers: { Authorization: 'Bearer ' + config.token },
  };
}

export function writebackWatched(entry, episode) {
  if (!Number.isSafeInteger(episode) || episode < 1 || episode > MAX_EPISODE) return false;
  const { floor, prefix, extras } = episodeCoverage(entry);
  return episode > floor && (episode <= prefix || extras.includes(episode));
}

export async function identifyWriteback(config) {
  if (!config.token) throw failure('请先配置 Bangumi 账号和令牌。', 401);
  const identity = await fetchBgmIdentity(config.token, options(config));
  if (config.user && String(config.user).toLowerCase() !== identity.user.toLowerCase())
    throw failure('令牌对应的账号与当前设置不一致。', 409);
  return identity;
}

export async function findRemoteChapter(config, subject, episode, identity) {
  const opts = options(config);
  const collectionPath = '/v0/users/' + encodeURIComponent(identity.user) + '/collections/' + subject;
  let collection;
  try { collection = await getJson(new URL(collectionPath, config.base), opts); }
  catch (error) {
    if (error.status === 404) throw failure('请先在 Bangumi 收藏这部番，再回写单集。', 404);
    throw error;
  }
  if (Number(collection.subject_id) !== Number(subject) || Number(collection.subject_type) !== 2)
    throw failure('Bangumi 收藏与本机动画条目不一致。', 409);
  const limit = 1000;
  const matches = new Map();
  for (let offset = 0; offset < MAX_EPISODE;) {
    const url = new URL('/v0/users/-/collections/' + subject + '/episodes', config.base);
    url.search = new URLSearchParams({ episode_type: '0', offset: String(offset), limit: String(limit) });
    const page = await getJson(url, opts);
    if (!Array.isArray(page?.data) || page.data.length > limit || !page.data.length && Number(page.total) > offset)
      throw failure('Bangumi 正片列表未读完整。', 502);
    for (const item of page.data) {
      const chapter = item?.episode;
      if (chapter?.type === 0 && Number(chapter.ep ?? chapter.sort) === episode && Number.isSafeInteger(chapter.id) && chapter.id > 0)
        matches.set(chapter.id, { id: chapter.id, title: String(chapter.name_cn || chapter.name || '').slice(0, 160) });
    }
    offset += page.data.length;
    if (!page.data.length || (Number.isInteger(page.total) ? offset >= page.total : page.data.length < limit)) {
      if (matches.size !== 1) throw failure('Bangumi 中找不到唯一的这集正片，请核对集号。', 409);
      return matches.values().next().value;
    }
  }
  throw failure('Bangumi 正片列表超出本次试验范围。', 409);
}

export async function readRemoteChapter(config, chapter) {
  const result = await getJson(new URL(EPISODES + chapter, config.base), options(config));
  if (![0, 1, 2, 3].includes(result?.type) || Number(result.episode?.id) !== chapter)
    throw failure('Bangumi 没有返回可核对的单集状态。', 502);
  return { type: result.type, stamp: Number.isSafeInteger(result.updated_at) ? result.updated_at : 0 };
}

export async function writeRemoteChapter(config, chapter) {
  const response = await httpRequest(new URL(EPISODES + chapter, config.base), {
    ...options(config), method: 'PUT', body: { type: 2 },
  });
  if (response.status !== 204)
    throw Object.assign(new Error('Bangumi 回写未成功。'), { status: response.status });
}

export function writebackError(error) {
  if (error.writeback) return { code: error.status, error: error.message };
  if (error.status === 401) return { code: 401, error: 'Bangumi 令牌无效或已过期。' };
  if (error.status === 403) return { code: 403, error: '当前令牌没有收藏写权限（write:collection）。' };
  if ([400, 404].includes(error.status)) return { code: 409, error: 'Bangumi 拒绝更新，请确认条目和单集仍在收藏范围内。' };
  if (error.status === 429) return { code: 429, error: 'Bangumi 请求太频繁，请稍后重试。' };
  return { code: 502, error: '暂时无法核对 Bangumi 上的结果。再次确认时会先查询当前状态。' };
}
