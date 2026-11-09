/**
 * HTTP 小工具：从 server.mjs 抽出来的纯函数，方便单测。
 *
 * 这里只放「不碰网络、不碰磁盘」的逻辑：Origin 判定、body 上限判定、JSON 解析。
 * 真正的 req/res 处理仍留在 server.mjs（那部分由 tools/check_panel_ui.mjs 做端到端覆盖）。
 */

/** 本机来源：http://127.0.0.1:7788、http://localhost:7788 都算 */
export function isLocalOrigin(origin, port) {
  if (!origin) return true;                       // curl / 本地脚本没有 Origin
  // 注意：'null'（file:// 页面、sandbox iframe）**故意不放行**。
  // 它听起来像「本机」，实际上是任意不透明来源——放行等于给恶意页面开一道写库门。
  // 面板正路是 http://127.0.0.1:PORT/，file:// 只作为没有服务时的降级查看，
  // 那种情况下连 GET 都过不了 CORS，本来也写不了库。
  let u;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  const host = u.hostname;
  const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0']);
  // 端口不校验：面板端口会自动回退（7788→7799），写死端口反而会把自家页面挡掉。
  // 以前这里写成 `... || true`，读代码的人会以为是漏写 —— 其实就是「只要 host 是本机，端口随它」。
  return localHosts.has(host);
}

/** 写接口的门：跨站 Origin 一律拒；返回 null 表示放行，否则返回该回的错误体 */
export function checkWriteOrigin(origin, port) {
  if (isLocalOrigin(origin, port)) return null;
  return { status: 403, body: { error: 'cross-origin write blocked', origin } };
}

/**
 * body 体积检查。
 * @returns {{ok:true}|{ok:false,status:number,body:object}}
 */
export function checkBodySize(bytes, limit = 1024 * 1024) {
  if (bytes > limit) return { ok: false, status: 413, body: { error: 'body too large', limit } };
  return { ok: true };
}

/**
 * 解析 JSON 文本（空串当空对象）。
 * @returns {{ok:true,value:any}|{ok:false,status:number,body:object}}
 */
export function parseJsonBody(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return { ok: true, value: {} };
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, status: 400, body: { error: 'JSON body must be an object' } };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, status: 400, body: { error: 'bad json' } };
  }
}
