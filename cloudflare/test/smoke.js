'use strict';

/* Workers 版冒烟测试：不依赖 wrangler/miniflare，用 Node 模拟 DO 环境验证：
 * 1. vendor 补丁产物可加载（require 链完整、无 Node 专有 API 残留报错）
 * 2. NOW() 注入后业务层日期语义 = 北京时间
 * 3. routes.handle 全链路：health/meta/settings/cards CRUD/备份导出
 * 4. Store 读写 + 类型隔离
 *
 * 运行：node test/smoke.js（在 cloudflare/ 目录）
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = __dirname + '/..';

// ---- 模拟 DO Storage（对齐真实 API：get/put/delete 返回 Promise；put 微任务后落盘）----
class MockStorage {
  constructor() { this.map = new Map(); }
  get(k) { return Promise.resolve(this.map.has(k) ? this.map.get(k) : undefined); }
  put(k, v) { return Promise.resolve().then(() => { this.map.set(k, structuredClone(v)); }); }
  delete(k) { return Promise.resolve().then(() => { this.map.delete(k); }); }
}

// ---- 构造 globalThis.NOW / ENV（do.js 在运行时注入的等价物）----
const { nowBJ } = require(ROOT + '/src/time.js');
globalThis.NOW = nowBJ;
globalThis.ENV = { AUTH_TOKEN: 'test-token-123' };

const { Store } = require(ROOT + '/src/store.js');
const routes = require(ROOT + '/vendored/routes.js');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

async function main() {
  const state = { storage: new MockStorage() };
  const store = new Store(state);
  await store.warmup(); // v1.0.1 契约：先预热（冷启动 await 拉持久层进缓存）再走同步读
  routes.init(store);

  console.log('== 1. Store 基础 ==');
  store.write('settings', { theme: 'dark' });
  await store.flush();
  ok(state.storage.map.has('ds:settings'), 'write 落盘 DO Storage');
  ok(store.readObject('settings', {}).theme === 'dark', 'read 回读缓存');
  const store2 = new Store(state); // 新实例（模拟 DO 重启）
  await store2.warmup();           // 预热后同步读全部命中缓存
  ok(store2.readObject('settings', {}).theme === 'dark', '重启后从持久层恢复');
  await state.storage.put('ds:cards', 'not-an-array'); // 类型损坏（发生在重启前，需 await 落盘）
  const store3 = new Store(state);
  await store3.warmup(); // warmup 内完成类型校验 + 坏值隔离
  ok(Array.isArray(store3.readArray('cards')) && store3.readArray('cards').length === 0, '非数组数据隔离回退空数组');
  ok(store3.warnings.some((w) => w.includes('cards') && w.includes('隔离')), '坏数据已隔离并告警');

  console.log('== 2. NOW() 时区语义 ==');
  const d = nowBJ();
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  ok(d.getHours() === bj.getHours() && d.getDate() === bj.getDate(), 'NOW() 分量 = UTC+8');
  // UTC 16:00-24:00（北京次日 0-8 点）场景：NOW().getDate() 应比 UTC 日期大 1
  const U = require(ROOT + '/vendored/util.js');
  ok(/^\d{4}-\d{2}-\d{2}$/.test(U.todayStr()), 'todayStr 走 NOW 锚定');

  console.log('== 3. routes 全链路 ==');
  const url = (p) => new URL('https://x.test' + p);
  const req = { headers: { origin: '', referer: '', host: 'x.test' } };

  let r = await routes.handle('GET', '/api/health', url('/api/health'), {}, req);
  ok(r.body && r.body.ok === true, 'GET /api/health');

  r = await routes.handle('GET', '/api/meta', url('/api/meta'), {}, req);
  ok(r.body && r.body.channels && r.body.assets && r.body.csvHeader, 'GET /api/meta（含资产元数据）');

  r = await routes.handle('PUT', '/api/settings', url('/api/settings'), { theme: 'dark' }, req);
  ok(r.body.theme === 'dark', 'PUT /api/settings');

  r = await routes.handle('POST', '/api/cards', url('/api/cards'), { bank: '测试银行', name: '测试卡', level: '白金', org: '银联', annualFee: '1000' }, req);
  ok(r.status === 201 && r.body.id, 'POST /api/cards 创建');
  const cardId = r.body.id;

  r = await routes.handle('GET', '/api/cards', url('/api/cards'), {}, req);
  ok(r.body.some((c) => c.id === cardId), 'GET /api/cards 含新卡');
  ok(r.body.length >= 5, '种子卡种已播种（init）');

  r = await routes.handle('PUT', '/api/cards/' + cardId, url('/api/cards/' + cardId), { annualFee: '2000' }, req);
  ok(Number(r.body.annualFee) === 2000, 'PUT /api/cards/:id 更新');

  r = await routes.handle('GET', '/api/mycards', url('/api/mycards'), {}, req);
  ok(Array.isArray(r.body.data) && r.body.data.length === 0, 'GET /api/mycards 空列表');

  r = await routes.handle('POST', '/api/mycards', url('/api/mycards'), { cardId, alias: '主力卡', creditLimit: '50000' }, req);
  ok(r.status === 201 && r.body.id && r.body.alias === '主力卡', 'POST /api/mycards 持卡');
  const myCardId = r.body.id;

  r = await routes.handle('POST', '/api/mycards/' + myCardId + '/consumptions', url('/api/mycards/' + myCardId + '/consumptions'), { date: U.todayStr(), amount: '66.5', note: '午餐' }, req);
  ok(r.status === 201, 'POST consumptions 记一笔');

  r = await routes.handle('GET', '/api/mycards', url('/api/mycards'), {}, req);
  ok(r.body.data[0].monthSpend === 66.5, 'computeMyCard 月消费统计');

  r = await routes.handle('GET', '/api/mycards/export', url('/api/mycards/export'), {}, req);
  const backup = JSON.parse(r.body);
  ok(backup.schema === 'guanka-backup' && backup.myCards.length === 1, '备份导出 schema/内容');

  // merge 幂等导入
  r = await routes.handle('POST', '/api/mycards/import', url('/api/mycards/import'), { data: backup, mode: 'merge' }, req);
  ok(r.status === 200 && r.body.mode === 'merge' && r.body.dedupedCards === 1, '备份导入 merge（重复持卡按 id 去重）');
  r = await routes.handle('POST', '/api/mycards/import', url('/api/mycards/import'), { data: backup, mode: 'merge' }, req);
  r = await routes.handle('GET', '/api/mycards', url('/api/mycards'), {}, req);
  ok(r.body.data.length === 1, 'merge 幂等：重复导入不产生重复持卡');

  r = await routes.handle('GET', '/api/stats', url('/api/stats'), {}, req);
  ok(r.body && 'monthSpend' in r.body, 'GET /api/stats');

  r = await routes.handle('GET', '/api/notify/config', url('/api/notify/config'), {}, req);
  ok(r.body && r.body.channels, 'GET /api/notify/config');

  r = await routes.handle('GET', '/api/calendar.ics', url('/api/calendar.ics'), {}, req);
  ok(typeof r.ics === 'string' && r.ics.startsWith('BEGIN:VCALENDAR'), 'GET /api/calendar.ics');

  r = await routes.handle('DELETE', '/api/cards/' + cardId, url('/api/cards/' + cardId), {}, req);
  ok(r.body.ok === true, 'DELETE /api/cards/:id');

  console.log('== 4. 无参 new Date 残留检查 ==');
  for (const f of fs.readdirSync(ROOT + '/vendored')) {
    const src = fs.readFileSync(ROOT + '/vendored/' + f, 'utf8');
    ok(!/new Date\(\s*\)/.test(src), f + ' 无裸 new Date() 残留');
    ok(!/process\.env\./.test(src), f + ' 无裸 process.env 残留');
  }

  console.log('\n========== 冒烟结果: ' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
