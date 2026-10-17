'use strict';

/* 打包前补丁：把 server/*.js 的 Node 依赖替换为 Workers 兼容实现。
 *
 * 业务模块（util/dates/assets/seed/reminder/ics/routes）零逻辑改动，只做两类机械替换：
 * 1. 无参 `new Date()` → `NOW()`：UTC→北京时区锚定（见 src/time.js，构建前注入 globalThis.NOW）
 *    有参调用（new Date(y,m,d) / new Date(str)）不动——与偏移锚自洽。
 * 2. `process.env.X` → `(ENV && ENV.X)`：Workers 的 env 仅请求上下文有值，
 *    DO 在每个请求入口把 this.env 写入 globalThis.ENV。
 *
 * 另生成两个垫片（routes.js 的 require 目标在 Workers 环境下的等价物）：
 * - vendored/auth-shim.js：routes.js 只用到 sameOrigin(plainReq)
 * - vendored/notifier.js：包装 src/notifier.js（签名 (env,cfg,...) → Node 版 (cfg,...)），
 *   使 routes/reminder 的既有调用点零改动。
 *
 * 每条替换都有精确的源码形态；匹配不上宁可让构建产物测试失败，不能悄悄改错语义。
 */

const fs = require('fs');
const path = require('path');

const SERVER_DIR = path.resolve(__dirname, '..', '..', 'server');
const OUT_DIR = path.resolve(__dirname, '..', 'vendored');

const FILES = ['util.js', 'dates.js', 'assets.js', 'seed.js', 'reminder.js', 'ics.js', 'routes.js'];

function patch(src, rel) {
  let out = src;
  const orig = src;

  out = out.replace(/new Date\(\s*\)/g, 'NOW()');
  out = out.replace(/process\.env\.([A-Z_][A-Z0-9_]*)/g, '(ENV && ENV.$1)');
  // routes.js 里唯一的动态 require：require('./auth').sameOrigin(req)
  out = out.replace(/require\('\.\/auth'\)\.sameOrigin\(req\)/g, "require('./auth-shim').sameOrigin(req)");

  if (out !== orig) console.log('  patched:', rel);
  return out;
}

console.log('[vendor] copying + patching server modules ->', OUT_DIR);
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const f of FILES) {
  const src = fs.readFileSync(path.join(SERVER_DIR, f), 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, f), patch(src, f));
}

/* 垫片 1：auth-shim —— routes.js 内部对原 server/auth.js 的唯一依赖是 sameOrigin，
 * 且调用传入的是 plain object {headers:{origin,referer,host}}（见 src/do.js 的 req 适配）。 */
fs.writeFileSync(path.join(OUT_DIR, 'auth-shim.js'), `'use strict';
// Workers 垫片：routes.js 的 sameOrigin(plainReq)（原 server/auth.js 同名函数的子集）
function sameOrigin(req) {
  const h = (req && req.headers) || {};
  const source = h.origin || h.referer || '';
  if (!source) return true; // 非浏览器（curl 等）无 Origin/Referer，由鉴权层负责
  try { return new URL(source).host === (h.host || ''); } catch (e) { return false; }
}
module.exports = { sameOrigin };
`);

/* 垫片 2：notifier —— 保持 Node 版签名 (cfg, title, content)，
 * 内部把 globalThis.ENV（DO 每请求写入）传给 Workers 版实现。 */
fs.writeFileSync(path.join(OUT_DIR, 'notifier.js'), `'use strict';
// Workers 垫片：对外暴露 Node 版签名（routes.js / reminder.js 的既有调用点零改动）
const W = require('../src/notifier.js');
module.exports = {
  CHANNELS: W.CHANNELS,
  enabledChannels: W.enabledChannels,
  assertSafeBarkServer: W.assertSafeBarkServer,
  isBlockedIp: W.isBlockedIp,
  notifyAll(cfg, title, content) {
    return W.notifyAll((typeof ENV !== 'undefined' && ENV) || globalThis.ENV || {}, cfg, title, content);
  },
};
`);

console.log('[vendor] done:', FILES.length, 'files + 2 shims');
