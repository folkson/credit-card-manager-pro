'use strict';

/* Durable Object：管卡应用内核。
 *
 * 职责：
 * 1. 持有 Store（内存缓存 + DO Storage 持久化），加载业务层（vendored/ 全套零逻辑改动）
 * 2. 串行化：Workers 平台保证同一 DO 的请求天然逐个执行，「读-改-写」之间无并发
 *    让出点 → 等价原版 Node 单线程语义（并发写不丢更新的结论直接平移）。
 * 3. 注入平台环境：globalThis.NOW（北京时区锚定）/ globalThis.ENV（env 绑定）。
 */

import { Store } from './store.js';
import { nowBJ } from './time.js';

// vendored 业务层（构建产物，见 scripts/vendor.js）：
// - routes.js 从 vendored/ 相对 require util/dates/.../auth-shim/notifier
// - notifier 垫片对外是 Node 版签名，内部读 globalThis.ENV
import routes from '../vendored/routes.js';

export class GuankaDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.store = new Store(state);
    this.loginFails = new Map(); // ip → { count, until }（DO 内存态，与原版进程内 Map 等价）
    // globalThis 注入：vendored 代码通过裸标识符 NOW / ENV 访问
    globalThis.NOW = nowBJ;
    globalThis.ENV = env;
    // init 内含卡种播种 + 数据自愈（幂等，重复调用无害）
    routes.init(this.store);
    this.ready = true;
  }

  async fetch(request) {
    globalThis.ENV = this.env;
    globalThis.NOW = nowBJ;

    const url = new URL(request.url);

    // ---- Cron 转发入口（worker.js scheduled 调用）----
    if (url.pathname === '/__cron/checks') {
      const out = await this.runCronChecks();
      return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    // ---- 登录限流内部端点（worker.js 的 /api/auth/login 调用；原版进程内 Map 的等价物）----
    if (url.pathname.startsWith('/__auth/')) {
      let b = {};
      try { b = await request.json(); } catch (e) { /* ignore */ }
      const ip = String(b.ip || '?');
      return new Response(JSON.stringify(this.loginGate(url.pathname, ip)), {
        status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    return this.handleRequest(request, url);
  }

  /** 登录限流（语义与原版 index.js 一致：5 次失败锁 60 秒） */
  loginGate(action, ip) {
    if (!this.loginFails) this.loginFails = new Map();
    const rec = this.loginFails.get(ip) || { count: 0, until: 0 };
    if (action === '/__auth/login-gate') {
      if (rec.until && Date.now() < rec.until) return { locked: true, wait: Math.ceil((rec.until - Date.now()) / 1000) };
      if (rec.until) { rec.until = 0; rec.count = 0; }
      return { locked: false };
    }
    if (action === '/__auth/login-fail') {
      rec.count++;
      if (rec.count >= 5) { rec.until = Date.now() + 60000; rec.count = 0; }
      this.loginFails.set(ip, rec);
      return { ok: true };
    }
    // login-ok
    this.loginFails.delete(ip);
    return { ok: true };
  }

  /** 处理业务 API 请求（鉴权已在 Worker 层完成） */
  async handleRequest(req, url) {
    const method = req.method;
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch (e) { pathname = url.pathname; }

    let body = {};
    if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
      const raw = await req.text();
      const ct = req.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        try { body = raw ? JSON.parse(raw) : {}; } catch (e) { return resp(400, { error: 'JSON 解析失败' }); }
      } else {
        body = raw;
      }
    }

    try {
      const result = await routes.handle(method, pathname, url, body, {
        // routes.js 的 sameOrigin(plainReq) 只用到这三个头
        headers: {
          origin: req.headers.get('origin'),
          referer: req.headers.get('referer'),
          host: req.headers.get('host'),
        },
      });
      if (result === undefined) return resp(404, { error: 'Not found' });
      if (result.shutdown) {
        // Workers 无进程退出概念：数据已在 DO Storage 强一致持久化，等价语义是「无需退出」
        return resp(200, { ok: true, msg: 'Workers 版无进程退出概念（数据实时持久化），已忽略 shutdown 指令' });
      }
      if (result.csv !== undefined) {
        return new Response(result.csv, {
          status: 200,
          headers: Object.assign({
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="cards-export.csv"',
          }, result.headers || {}),
        });
      }
      if (result.ics !== undefined) {
        return new Response(result.ics, { status: 200, headers: result.headers || {} });
      }
      const status = result.status || 200;
      const isObj = typeof result.body === 'object' && result.body !== null;
      const payload = isObj ? JSON.stringify(result.body) : String(result.body == null ? '' : result.body);
      const headers = Object.assign(
        { 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8' },
        result.headers || {},
      );
      return new Response(payload, { status, headers });
    } catch (e) {
      console.error('[管卡] DO 请求处理错误:', (e && e.stack) || e);
      return resp((e && e.status) || 500, { error: (e && e.message) || '服务器内部错误' });
    }
  }

  /** 提醒检查（Cron 或手动触发共用；force=false 按 notify 配置节流） */
  async runCronChecks() {
    try {
      const out = await routes.runNotifyChecks(false);
      if (out && !out.skipped) {
        console.log('[管卡] 提醒检查完成：待提醒 %d 项，已推送 %d 项', out.checked || 0, out.sent || 0);
      }
      return out;
    } catch (e) {
      console.error('[管卡] 提醒检查失败:', (e && e.message) || e);
      return { skipped: true, reason: String((e && e.message) || e) };
    }
  }
}

function resp(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
