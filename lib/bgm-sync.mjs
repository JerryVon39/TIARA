import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchBgmIdentity, fetchCalendar, fetchCollections, validCalendarSnapshot } from './bgm.mjs';

export const BGM_REL = 'data/bgm.json';

export async function readBgmConfig(root) {
  try {
    return JSON.parse(await fs.readFile(path.join(root, BGM_REL), 'utf8')) || {};
  } catch {
    return {};
  }
}

function localBgmFixture(value) {
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
        !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) return url.origin;
  } catch {}
  return null;
}

export function effectiveBgmConfig(config, overrides = {}) {
  return {
    user: process.env.BGM_USER || overrides.user || config.user || '',
    token: process.env.BGM_TOKEN || overrides.token || config.token || '',
    proxy: process.env.BGM_PROXY || overrides.proxy || config.proxy || '',
    base: localBgmFixture(process.env.BGM_BASE || overrides.base) || 'https://api.bgm.tv',
  };
}

export function bgmConfigView(config) {
  const effective = effectiveBgmConfig(config);
  let proxy = '';
  if (effective.proxy) {
    try {
      const url = new URL(effective.proxy.includes('://') ? effective.proxy : 'http://' + effective.proxy);
      proxy = url.host;
    } catch { proxy = '已配置，格式待检查'; }
  }
  return { user: effective.user, has_token: !!effective.token, proxy,
    overrides: ['USER','TOKEN','PROXY'].filter(key => process.env['BGM_' + key]) };
}

export function validateBgmProxy(value) {
  if (!value) return true;
  try {
    const url = new URL(value.includes('://') ? value : 'http://' + value);
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    return url.protocol === 'http:' && !!url.hostname && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}

function syncError(error, proxy) {
  if (error.code === 'account_mismatch') return { code: error.code, error: error.message };
  if (error.status === 401) return { code: 'token_invalid', error: 'Bangumi 令牌无效或已过期，请更换后重试。' };
  if (error.status === 403) return { code: 'forbidden', error: 'Bangumi 拒绝访问，请检查账号和令牌权限。' };
  if (error.status === 404) return { code: 'not_found', error: 'Bangumi 找不到此账号或接口，请核对用户名。' };
  if (error.status === 429) return { code: 'rate_limited', error: 'Bangumi 请求过于频繁，请稍后重试。' };
  if (/407/.test(error.message) || error.status === 407) return { code: 'proxy_auth', error: '代理需要认证，请核对代理账号和密码。' };
  if (error.name === 'AbortError' || /timeout|超时/i.test(error.message)) return { code: 'timeout', error: proxy ? '通过代理连接 Bangumi 超时。' : '连接 Bangumi 超时。' };
  if (error.status >= 500) return { code: 'upstream', error: 'Bangumi 服务暂时不可用，请稍后重试。' };
  if (/格式/.test(error.message)) return { code: 'response', error: 'Bangumi 或代理返回了无法识别的数据。' };
  return { code: proxy ? 'proxy' : 'network', error: proxy ? '无法通过代理连接 Bangumi，请检查代理地址和运行状态。' : '无法连接 Bangumi，请检查网络或配置代理。' };
}

/** Each source has its own outcome. Remote bodies and credentials stay off the UI/logs. */
export async function fetchSyncData(config, { mode = 'collections', connection = false, signal, progress, cache, useCache = true, remember } = {}) {
  const { user, token, proxy, base } = config;
  const opts = { proxy, base, timeoutMs: 8000, retries: 0, signal };
  const data = {};
  const sources = {};
  let identity = null;
  const load = async (key, fetcher) => {
    progress?.(key, { status: 'loading', count: 0 });
    try {
      data[key] = await fetcher();
      signal?.throwIfAborted();
      // Avoid storing remote comments, tags, ratings or user details in the retry cache.
      if (key === 'collections') data[key] = data[key].map(({ subject_id, type, ep_status, subject }) => ({
        subject_id, type, ep_status, subject: subject && {
          id: subject.id, name: subject.name, name_cn: subject.name_cn, eps: subject.eps, total_episodes: subject.total_episodes,
          date: subject.date,
        },
      }));
      sources[key] = { status: 'ok', count: data[key].length, fetched_at: new Date().toISOString() };
      await remember?.(key, { data: data[key], at: sources[key].fetched_at });
    } catch (error) {
      delete data[key];
      signal?.throwIfAborted();
      const failure = syncError(error, proxy);
      const allowCache = !['account_mismatch', 'token_invalid', 'forbidden'].includes(failure.code);
      const saved = allowCache ? await cache?.(key) : null;
      const age = Date.now() - Date.parse(saved?.at);
      const valid = key === 'calendar' ? validCalendarSnapshot(saved?.data) : Array.isArray(saved?.data);
      const available = valid && age >= 0 && age <= 7 * 86400000;
      if (available && useCache) {
        data[key] = saved.data;
        sources[key] = { status: 'cached', count: data[key].length, fetched_at: saved.at, ...failure };
      } else sources[key] = { status: 'error', ...failure,
        ...(cache ? { cache_available: available, ...(available ? { cache_at: saved.at, cache_count: saved.data.length } : {}) } : {}) };
    }
    progress?.(key, sources[key]);
  };
  await Promise.all([
    load('calendar', () => fetchCalendar(opts)),
    mode === 'calendar' || !token
      ? (sources.collections = { status: 'skipped', reason: token ? 'calendar_only' : 'no_token' })
      : load('collections', async () => {
        identity = await fetchBgmIdentity(token, opts);
        if (user && user.toLowerCase() !== identity.user.toLowerCase()) {
          throw Object.assign(new Error('用户名与令牌对应的账号不同，请核对后重试。'), { code: 'account_mismatch' });
        }
        return fetchCollections(identity.user, token, { ...opts, allStatuses: !connection, limit: connection ? 1 : undefined,
          onProgress: (count, total) => progress?.('collections', { status: 'loading', count, total }) });
      }),
  ]);
  return { data, sources, identity,
    partial: Object.values(sources).some(source => ['error', 'cached'].includes(source.status)),
    usable: Object.values(sources).some(source => ['ok', 'cached'].includes(source.status)) };
}
