'use strict';
/* 云同步（GitHub Gist）冒烟测试
 * 模拟浏览器环境（localStorage / crypto.subtle / btoa / fetch），
 * 从 public/app.js 中抽取云同步相关代码段在 Node 里执行，验证：
 *   1. AES-GCM 加密 → 解密往返（PBKDF2 100000 轮）
 *   2. gist push：无 gistId 自动创建私密 Gist，有 gistId PATCH 更新
 *   3. gist pull：拉取 + 解密还原原始备份对象
 *   4. 防抖 scheduleSyncPush 只触发一次上传
 *   5. 坏密码 / 坏 token 的错误路径
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg); }
}

// ---- 模拟浏览器环境 ----
const storage = new Map();
const localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};

// ---- 从 app.js 抽取云同步代码段 ----
const appJs = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'app.js'), 'utf8');
function extract(name) {
  const start = appJs.indexOf('const SYNC = {');
  if (start < 0) throw new Error('未找到 SYNC 定义');
  // 抓取从 SYNC 定义到 initCloudSync 结束的整段（云同步模块连续区块）
  const end = appJs.indexOf('// ---------- 云同步设置弹窗 ----------');
  if (end < 0) throw new Error('未找到云同步模块边界');
  return appJs.slice(start, end);
}
const syncModule = extract();

// mock GitHub API server
const gistStore = { id: 'mock-gist-id-123', files: {}, description: '' };
let ghCallLog = [];
const mockFetch = async (url, opts) => {
  opts = opts || {};
  ghCallLog.push({ url, method: opts.method || 'GET', auth: (opts.headers || {}).Authorization });
  const respond = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const headers = opts.headers || {};
  if (headers.Authorization !== 'Bearer good-token') return respond(401, { message: 'Bad credentials' });
  if (url === 'https://api.github.com/gists' && opts.method === 'POST') {
    const b = JSON.parse(opts.body);
    gistStore.description = b.description;
    for (const [fn, f] of Object.entries(b.files)) gistStore.files[fn] = { content: f.content };
    return respond(201, { id: gistStore.id, files: JSON.parse(JSON.stringify(gistStore.files)) });
  }
  const m = url.match(/^https:\/\/api\.github\.com\/gists\/(.+)$/);
  if (m && m[1] === gistStore.id) {
    if (opts.method === 'PATCH') {
      const b = JSON.parse(opts.body);
      for (const [fn, f] of Object.entries(b.files)) gistStore.files[fn] = { content: f.content };
      return respond(200, { id: gistStore.id, files: JSON.parse(JSON.stringify(gistStore.files)) });
    }
    return respond(200, { id: gistStore.id, files: JSON.parse(JSON.stringify(gistStore.files)) });
  }
  return respond(404, { message: 'Not Found' });
};

// mock 管卡后端 /api/mycards/export 与 /api/mycards/import
const backupSample = {
  schema: 'guanka-backup', version: 2, exportedAt: '2026-10-17T08:00:00.000Z',
  cardTypes: [{ id: 'c1', bank: '招商银行', name: '经典白' }],
  myCards: [{ id: 'm1', cardId: 'c1', note: '测试卡' }],
  consumptions: [], benefitRecords: [], billGroups: [], bills: [],
  memberships: [], vouchers: [], voucherBrands: [], knowledge: [],
};
let importedPayload = null;
const appFetch = async (url) => {
  if (url === '/api/mycards/export') return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(backupSample)) };
  if (url === '/api/mycards/import') return { ok: true, status: 200, json: async () => { return { importedCards: 1 }; } };
  return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
};
// fetch 分发：github.com 开头走 mock GH，其余走 mock 管卡后端
const fetchDispatch = (url, opts) => (String(url).indexOf('https://api.github.com') === 0 ? mockFetch(url, opts) : appFetch(url, opts));

// 检查 _skipNextPush 是否被 scheduleSyncPush 消费
function SYNC_skipNextPushConsumed(ctx) {
  const v = vm.runInContext('SYNC._skipNextPush', ctx);
  return v === false;
}

const sandbox = {
  console, localStorage,
  crypto: globalThis.crypto,           // Node 20 内置 WebCrypto，与浏览器一致
  TextEncoder, TextDecoder,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  fetch: fetchDispatch,
  clearTimeout, setTimeout: (fn) => { sandbox.__timer = fn; return 1; }, // 捕获防抖定时器
  api: async (path, opts) => { await appFetch('/api/mycards/import', opts); return { importedCards: 1 }; },
  state: { myCards: [], memberships: [], vouchers: [], knowledge: [] },
  loadAll: async () => {},
  toast: (msg) => { sandbox.__toasts.push(msg); },
  confirm: () => true,
};
sandbox.__toasts = [];
const ctx = vm.createContext(sandbox);

async function main() {
  console.log('\n== 1. 云同步模块注入并初始化 ==');
  vm.runInContext(syncModule + '\nthis.SYNC = SYNC; this.syncEncrypt = syncEncrypt; this.syncDecrypt = syncDecrypt; this.syncPush = syncPush; this.syncPull = syncPull; this.scheduleSyncPush = scheduleSyncPush;', ctx, { filename: 'sync-module.js' });
  ok(sandbox.SYNC && sandbox.SYNC.on === false, 'SYNC 初始为关闭状态');
  ok(sandbox.SYNC.token === '', 'SYNC.token 初始为空');

  console.log('\n== 2. AES-GCM 加密 → 解密往返 ==');
  const enc = await vm.runInContext('syncEncrypt(' + JSON.stringify(backupSample) + ', "test-pass-123")', ctx);
  ok(typeof enc === 'string' && enc.length > 100, '密文为 base64 字符串（' + enc.length + ' chars）');
  ok(!enc.includes('招商银行'), '密文中不含明文关键词');
  const dec = await vm.runInContext('syncDecrypt(' + JSON.stringify(enc) + ', "test-pass-123")', ctx);
  ok(dec.schema === 'guanka-backup' && dec.myCards.length === 1, '解密还原出原始备份对象');
  ok(dec.myCards[0].note === '测试卡', '解密内容字段一致');
  // 相同数据两次加密产生不同密文（随机 salt+iv）
  const enc2 = await vm.runInContext('syncEncrypt(' + JSON.stringify(backupSample) + ', "test-pass-123")', ctx);
  ok(enc !== enc2, '两次加密密文不同（随机 salt/iv）');
  // 坏密码解密必须失败
  let badPass = false;
  try { await vm.runInContext('syncDecrypt(' + JSON.stringify(enc) + ', "wrong-pass")', ctx); } catch (e) { badPass = true; }
  ok(badPass, '错误密码解密被拒绝（GCM 认证失败）');

  console.log('\n== 3. push：无 token 拒绝 / 有 token 自动建 Gist ==');
  let err1 = '';
  try { await vm.runInContext('syncPush()', ctx); } catch (e) { err1 = e.message; }
  ok(err1 === '', '未开启同步时 syncPush 静默返回');
  vm.runInContext('SYNC.on = true; SYNC.token = "bad-token"; SYNC.pass = "test-pass-123"; SYNC.ready = true; SYNC.gistId = "";', ctx);
  let err2 = '';
  try { await vm.runInContext('(async () => syncPush())()', ctx); } catch (e) { err2 = e.message; }
  ok(/401/.test(err2), '坏 token 推送报 401：' + err2);
  vm.runInContext('SYNC.token = "good-token"; SYNC.pass = "test-pass-123";', ctx);
  ghCallLog = [];
  await vm.runInContext('(async () => syncPush())()', ctx);
  const postCall = ghCallLog.find((c) => c.method === 'POST');
  ok(!!postCall, '无 gistId 时 POST /gists 创建新 Gist');
  ok(gistStore.files['guanka-sync.json'] && gistStore.files['guanka-sync.json'].content.length > 100, 'Gist 中存入加密备份 blob');
  ok(!gistStore.files['guanka-sync.json'].content.includes('招商银行'), 'Gist 内容不含明文');
  ok(vm.runInContext('SYNC.gistId', ctx) === 'mock-gist-id-123', 'gistId 已写回 SYNC 状态');
  ok(storage.get('ghGistId') === 'mock-gist-id-123', 'gistId 已持久化到 localStorage');
  ok(gistStore.description === '管卡 · 同步备份', 'Gist 描述正确');

  console.log('\n== 4. push 第二次走 PATCH 更新 ==');
  ghCallLog = [];
  await vm.runInContext('(async () => syncPush())()', ctx);
  const patchCall = ghCallLog.find((c) => c.method === 'PATCH');
  ok(!!patchCall && !ghCallLog.some((c) => c.method === 'POST'), '已有 gistId 时 PATCH 更新，不再新建');

  console.log('\n== 5. pull：拉取并解密还原 ==');
  vm.runInContext('SYNC._status = "off"', ctx);
  const pulled = await vm.runInContext('(async () => syncPull())()', ctx);
  ok(pulled && pulled.schema === 'guanka-backup', 'syncPull 返回解密后的备份对象');
  ok(pulled.cardTypes[0].bank === '招商银行', '拉取数据与推送数据一致');

  console.log('\n== 6. 防抖安全阀：未校验前禁止自动上传（防覆盖云端备份）==');
  sandbox.__timer = null;
  vm.runInContext('SYNC._restored = false; SYNC._skipNextPush = false; scheduleSyncPush()', ctx);
  ok(sandbox.__timer === null, '首次云端校验未完成：自动上传被封锁（防空数据覆盖云端）');
  vm.runInContext('SYNC._restored = true; scheduleSyncPush()', ctx);
  ok(typeof sandbox.__timer === 'function', '校验完成后防抖定时器正常挂起');
  const logBefore = ghCallLog.length;
  sandbox.__timer(); // 触发防抖回调（回调内部 syncPush().catch(()=>{}) 不回传 promise）
  for (let i = 0; i < 50 && ghCallLog.length === logBefore; i++) await new Promise((r) => setTimeout(r, 20));
  ok(ghCallLog.length > logBefore, '防抖到期后触发一次上传');

  console.log('\n== 6b. _skipNextPush：恢复导入后跳过一次冗余回传 ==');
  vm.runInContext('SYNC._skipNextPush = true; scheduleSyncPush()', ctx);
  ok(SYNC_skipNextPushConsumed(ctx), 'skip 标记被消费，本轮不上传');

  console.log('\n== 6c. 并发互斥：推送进行中复用同一 promise ==');
  ghCallLog = [];
  vm.runInContext('SYNC.gistId = "mock-gist-id-123"', ctx);
  const p1 = vm.runInContext('(async () => syncPush())()', ctx);
  const p2 = vm.runInContext('(async () => syncPush())()', ctx);
  await Promise.all([p1, p2]);
  const patches = ghCallLog.filter((c) => c.method === 'PATCH').length;
  ok(patches === 1, '并发两次调用只产生一次 PATCH（其余复用 _pushing）');

  console.log('\n== 6d. Gist 被删后 PATCH 404 自动重建 ==');
  ghCallLog = [];
  vm.runInContext('SYNC.gistId = "deleted-gist"', ctx);
  await vm.runInContext('(async () => syncPush())()', ctx);
  ok(vm.runInContext('SYNC.gistId', ctx) === 'mock-gist-id-123', '404 后清 gistId 并重建成功');

  console.log('\n== 7. 恢复链路（syncPull → import merge）==');
  // 直接验证解密产物能通过 /api/mycards/import 的 schema 校验结构
  ok(pulled.myCards && Array.isArray(pulled.myCards), '解密备份含 myCards 数组（可走导入端点）');
  ok(pulled.version === 2, '备份 schema v2（含扩展资产字段）');

  console.log('\n== 8. app.js 语法完整性 ==');
  new Function(fs.readFileSync(path.resolve(__dirname, '..', 'public', 'app.js'), 'utf8').replace(/'use strict';/, ''));
  ok(true, 'public/app.js 全文件可解析（无语法错误）');

  console.log('\n========================================');
  console.log('通过 ' + passed + ' / 失败 ' + failed);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('测试执行异常:', e); process.exit(1); });
