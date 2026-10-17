'use strict';

/* Worker 入口：请求路由 + 鉴权 + DO 转发 + Cron 触发。
 *
 *   浏览器 ─→ Worker
 *              ├─ /api/auth/*   → Worker 本地处理（登录/登出/状态）
 *              ├─ /api/*        → auth.guard() → GuankaDO.fetch()
 *              └─ 其余          → Workers Assets（SPA，自动 gzip/brotli + ETag）
 *   Cron 每 10 分钟 ─→ DO /__cron/checks → 提醒检查 + 推送
 *
 * 登录限流：原版是进程内 Map（ip → 失败计数）。Workers 无常驻进程内存，
 * 用 DO 内部端点承载限流状态（单实例，天然一致）。
 */

import { GuankaDO } from './do.js';
import auth from './auth.js';

export { GuankaDO };

const DO_NAME = 'guanka-singleton';

function jsonResp(status, obj, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}),
  });
}

function decodePath(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

async function getStub(env) {
  const id = env.GUANKA_DO.idFromName('guanka-singleton');
  return env.GUANKA_DO.get(id);
}

export default {
  async fetch(request, env, ctx) {
    globalThis.ENV = env;
    const url = new URL(request.url);
    const pathname = decodePath(url.pathname);
    const method = request.method;

    // ---- 认证路由（不经 guard）----
    if (pathname === '/api/auth/status') {
      const authorized = auth.authEnabled(env)
        ? await auth.checkToken(env, auth.credentialOf(request, url))
        : false;
      return jsonResp(200, { authRequired: auth.authEnabled(env), authorized });
    }
    if (pathname === '/api/auth/login' && method === 'POST') {
      if (!auth.authEnabled(env)) return jsonResp(400, { error: '服务未设置 AUTH_TOKEN，无需登录' });
      const ip = auth.clientIp(request);
      // 限流状态在 DO 内（单实例一致；5 次失败锁 60 秒，与原版一致）
      const stub = await getStub(env);
      const gate = await stub.fetch('https://do.internal/__auth/login-gate', {
        method: 'POST',
        body: JSON.stringify({ ip, token: '' }),
        headers: { 'Content-Type': 'application/json' },
      });
      const gateData = await gate.json();
      if (gateData.locked) {
        return jsonResp(429, { error: '尝试过于频繁，请 ' + gateData.wait + ' 秒后重试' });
      }
      let body = {};
      try { body = await request.json(); } catch (e) { /* 空/坏 body 按 {} 处理 */ }
      const ok = await auth.checkToken(env, String((body && body.token) || '').trim());
      if (!ok) {
        await stub.fetch('https://do.internal/__auth/login-fail', {
          method: 'POST', body: JSON.stringify({ ip }), headers: { 'Content-Type': 'application/json' },
        });
        return jsonResp(401, { error: '令牌不正确' });
      }
      await stub.fetch('https://do.internal/__auth/login-ok', {
        method: 'POST', body: JSON.stringify({ ip }), headers: { 'Content-Type': 'application/json' },
      });
      return jsonResp(200, { ok: true }, { 'Set-Cookie': auth.sessionCookie(env) });
    }
    if (pathname === '/api/auth/logout' && method === 'POST') {
      return jsonResp(200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
    }

    // ---- API：鉴权 + DO 转发 ----
    if (pathname.startsWith('/api/')) {
      const blocked = await auth.guard(request, url, pathname, env);
      if (blocked) return jsonResp(blocked.status, blocked.body);

      const stub = await getStub(env);
      const doReq = new Request('https://do.internal' + url.pathname + url.search, {
        method: request.method,
        headers: request.headers,
        body: (method === 'GET' || method === 'HEAD') ? undefined : await request.arrayBuffer(),
      });
      return stub.fetch(doReq);
    }

    // ---- 静态资源：Workers Assets（wrangler.toml [assets]）----
    return env.ASSETS.fetch(request);
  },

  /** Cron Triggers：每 10 分钟心跳（实际推送节奏由 notify.intervalMinutes 节流，与原版一致） */
  async scheduled(event, env, ctx) {
    globalThis.ENV = env;
    ctx.waitUntil((async () => {
      try {
        const stub = await getStub(env);
        const res = await stub.fetch('https://do.internal/__cron/checks', { method: 'POST' });
        const out = await res.json();
        if (out && !out.skipped) console.log('[管卡] cron 提醒检查：待提醒 %d，已推送 %d', out.checked || 0, out.sent || 0);
        else if (out && out.skipped) console.log('[管卡] cron 跳过：' + (out.reason || ''));
      } catch (e) {
        console.error('[管卡] cron 失败:', (e && e.message) || e);
      }
    })());
  },
};
