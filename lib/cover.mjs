/**
 * 封面本地缓存。
 *
 * 为什么要这层：`lain.bgm.tv` 的图**不走面板服务**，是浏览器自己去拿的。
 * 实测（2026-11-05，本机）：
 *   - 直连：24 张全失败（ERR fetch failed，0/24）；
 *   - 走本地代理：166/166 成功，但平均 1.3 秒/张，并发 8 也要 27 秒；
 *   - 一页要 100+ 张，浏览器对单域名只开 6 条连接 → 滚到哪儿哪儿是白块。
 * 所以改成「服务端取一次 → 落盘 → 浏览器拿本机图」，第二次之后就与网络无关。
 *
 * 这里只放纯函数，方便单测；真正的取图在 server.mjs 的 /cover 路由里。
 */

export const COVER_MAX_AGE = 60 * 60 * 24 * 30; // 30 天

/** id 只允许 1–10 位数字（Bangumi 的 subject id） */
export function coverIdOf(raw) {
  const s = String(raw == null ? '' : raw).trim();
  return /^\d{1,10}$/.test(s) ? s : null;
}

/** `data/covers/<id>.jpg` */
export function coverCachePath(root, id) {
  const safe = coverIdOf(id);
  if (!safe) return null;
  return `${root}/data/covers/${safe}.jpg`;
}

/** 只认 Bangumi 图床，且 https——防止这个路由变成任意 URL 代理 */
export function isAllowedCoverUrl(u) {
  let parsed;
  try {
    parsed = new URL(String(u || ''));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  const okHost = host === 'lain.bgm.tv' || host === 'bgm.tv' || host === 'api.bgm.tv' || host.endsWith('.bgm.tv');
  if (!okHost) return false;
  return /^\/(r\/|pic\/)/.test(parsed.pathname);
}

/** 从一季的 items 里找 id 对应的封面地址 */
export function pickCoverUrl(items, id) {
  const want = coverIdOf(id);
  if (!want || !Array.isArray(items)) return null;
  for (const it of items) {
    if (String(it && it.id) === want && isAllowedCoverUrl(it.image)) return it.image;
  }
  return null;
}
