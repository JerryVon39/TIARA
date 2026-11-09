import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchBgmIdentity, fetchCalendar, fetchCollections } from './bgm.mjs';

export const BGM_REL = 'data/bgm.json';

export async function readBgmConfig(root) {
  try {
    return JSON.parse(await fs.readFile(path.join(root, BGM_REL), 'utf8')) || {};
  } catch {
    return {};
  }
}

export function effectiveBgmConfig(config, overrides = {}) {
  return {
    user: process.env.BGM_USER || overrides.user || config.user || '',
    token: process.env.BGM_TOKEN || overrides.token || config.token || '',
    proxy: process.env.BGM_PROXY || overrides.proxy || config.proxy || '',
    base: process.env.BGM_BASE || overrides.base || config.base || 'https://api.bgm.tv',
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
export async function fetchSyncData(config, { mode = 'collections', connection = false } = {}) {
  const { user, token, proxy, base } = config;
  const opts = { proxy, base, timeoutMs: 8000, retries: 0 };
  const data = {};
  const sources = {};
  let identity = null;
  const load = async (key, fetcher) => {
    try {
      data[key] = await fetcher();
      sources[key] = { status: 'ok', count: data[key].length };
    } catch (error) {
      sources[key] = { status: 'error', ...syncError(error, proxy) };
    }
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
        return fetchCollections(identity.user, token, { ...opts, limit: connection ? 1 : undefined });
      }),
  ]);
  return { data, sources, identity,
    partial: Object.values(sources).some(source => source.status === 'error'),
    usable: Object.values(sources).some(source => source.status === 'ok') };
}
