import { fetchSeason } from './bgm.mjs';

export const SEASON_BACKUP = Object.freeze({
  id: 'anibt',
  label: 'AniBT 备用源',
  base: 'https://bgmapi.anibt.net',
  coverHost: 'bgmimg.anibt.net',
});

export async function refreshSeasonFromSources(q, { officialBase, officialProxy, backup, allowEmpty }, fetcher = fetchSeason) {
  async function read(options) {
    const data = await fetcher({ q, ...options });
    if (!allowEmpty && !data.items.length) {
      throw Object.assign(new Error('返回空目录，无法核验'), { code: 'season_empty' });
    }
    return data;
  }

  try {
    return await read({
      base: officialBase, proxy: officialProxy, retries: backup ? 0 : 1, timeoutMs: 10000,
      signal: AbortSignal.timeout(backup ? 16000 : 36000),
    });
  } catch (officialError) {
    if (!backup || (officialError.status >= 400 && officialError.status < 500 && officialError.status !== 429)) throw officialError;
    try {
      const data = await read({
        base: SEASON_BACKUP.base, proxy: '', retries: 0, timeoutMs: 8500,
        redirect: 'error', signal: AbortSignal.timeout(17000),
      });
      return { ...data, catalog_source: SEASON_BACKUP.label,
        items: data.items.map(item => ({ ...item, cover_source: SEASON_BACKUP.id })) };
    } catch (backupError) {
      throw Object.assign(new Error('官方和备用资料源均未完成更新'), { officialError, backupError });
    }
  }
}
