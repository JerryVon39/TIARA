/**
 * tools/bgm-proxy-worker.js — Cloudflare Worker 反代模板
 *
 * 解决两件事：
 *   1) api.bgm.tv / bgm.tv / lain.bgm.tv 在本地 DNS 被污染（实测解析到 Dropbox / DreamHost 网段）
 *   2) 统一注入 User-Agent，避免 403
 *
 * 部署：
 *   npm i -g wrangler
 *   wrangler login
 *   wrangler deploy tools/bgm-proxy-worker.js --name bgm-proxy --compatibility-date 2026-01-01
 *   # 设置密钥（可选，防白嫖）
 *   wrangler secret put PROXY_KEY
 *
 * 用法（把 api.bgm.tv 换成你的 worker 域名 + 路径前缀）：
 *   https://bgm-proxy.yourname.workers.dev/api/calendar
 *   https://bgm-proxy.yourname.workers.dev/api/v0/subjects/2
 *   https://bgm-proxy.yourname.workers.dev/img/pic/cover/l/xx/xx/123.jpg
 *
 * 本地脚本里只需：BGM_BASE=https://bgm-proxy.yourname.workers.dev/api
 */

const UA = 'ukagaka-bangumi/0.1 (https://github.com/yourname/ukagaka-bangumi)';

const ROUTES = [
  { prefix: '/api/', origin: 'https://api.bgm.tv/', type: 'json' },
  { prefix: '/img/', origin: 'https://lain.bgm.tv/', type: 'image' },
  { prefix: '/www/', origin: 'https://bgm.tv/', type: 'html' },
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 简单鉴权：header 或 query 带 key（PROXY_KEY 未设置时放行）
    if (env.PROXY_KEY) {
      const key = request.headers.get('x-proxy-key') || url.searchParams.get('key');
      if (key !== env.PROXY_KEY) return new Response('forbidden', { status: 403 });
    }

    if (url.pathname === '/health') {
      return Response.json({ ok: true, ts: Date.now() });
    }

    const route = ROUTES.find((r) => url.pathname.startsWith(r.prefix));
    if (!route) return new Response('not found', { status: 404 });

    const target = route.origin + url.pathname.slice(route.prefix.length) + url.search;
    const headers = new Headers(request.headers);
    headers.set('User-Agent', UA);
    headers.set('Referer', 'https://bgm.tv/');
    headers.delete('host');
    headers.delete('x-proxy-key');

    const init = { method: request.method, headers, redirect: 'follow' };
    if (!['GET', 'HEAD'].includes(request.method)) init.body = await request.arrayBuffer();

    const upstream = await fetch(target, init);
    const out = new Headers(upstream.headers);
    out.delete('content-security-policy');
    out.delete('x-frame-options');
    out.set('access-control-allow-origin', '*');
    out.set('cache-control', route.type === 'image' ? 'public, max-age=2592000' : 'no-store');

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'authorization,content-type,x-proxy-key',
          'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
        },
      });
    }

    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
