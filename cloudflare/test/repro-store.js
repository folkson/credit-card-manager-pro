'use strict';
/* 验证脚本：cloudflare/src/store.js 的 DO Storage 异步契约（v1.0.1 修复回归）
 *
 * 真实 Cloudflare DO Storage API 的 get/put 返回 Promise（异步 I/O）。
 * 历史 bug：store.js 曾未 await，冷启动把 Promise 当数据缓存 → readArray 判非数组
 * → 全量误隔离。修复方案：warmup 预热（await 拉全量进缓存）+ 同步读缓存 + 写队列 flush。
 * 本脚本用「返回 Promise 的 MockStorage」（对齐真实 API 语义）验证：
 *   1. 冷启动正确读回数据（无误隔离）
 *   2. 坏类型数据仍能正确隔离到 bad:* 备份 key
 *   3. write 后 flush，数据落盘；新实例重启可恢复
 *   4. warmup 前（未预热）同步读回退默认值且不误写持久层
 */

const ROOT = __dirname + '/..';
const { Store } = require(ROOT + '/src/store.js');

// 对齐真实 DO Storage：get/put/delete 返回 Promise；put 在微任务后才落盘（模拟真实异步 I/O）
class RealLikeStorage {
  constructor() { this.map = new Map(); }
  get(k) { return Promise.resolve(this.map.has(k) ? this.map.get(k) : undefined); }
  put(k, v) { return Promise.resolve().then(() => { this.map.set(k, structuredClone(v)); }); }
  delete(k) { return Promise.resolve().then(() => { this.map.delete(k); }); }
}

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name); }
}

async function main() {
  console.log('== 1. 冷启动正确读回数据（原 bug：Promise 被当数据误隔离）==');
  const state = { storage: new RealLikeStorage() };
  const s1 = new Store(state);
  await s1.warmup();
  s1.write('cards', [{ id: 'c1', bank: '测试银行', name: '主力卡' }]);
  await s1.flush();

  // 模拟 DO 重启：新 Store 实例，缓存为空，warmup 从持久层冷加载
  const s2 = new Store(state);
  await s2.warmup();
  const cards = s2.readArray('cards');
  ok(Array.isArray(cards) && cards.length === 1 && cards[0].name === '主力卡', '冷启动读回 1 条数据，内容一致');
  ok(s2.warnings.length === 0, '无误隔离告警（原 bug 会报「内容不是数组」）');

  console.log('\n== 2. 坏类型数据隔离（warmup 路径）==');
  state.storage.put('ds:mycards', 'not-an-array');
  state.storage.put('ds:notify', 42);
  const s3 = new Store(state);
  await s3.warmup();
  ok(s3.readArray('mycards').length === 0, '非数组 mycards 隔离回退空数组');
  ok(s3.readObject('notify', null) === null, '非对象 notify 隔离回退默认值');
  ok(s3.warnings.filter((w) => w.includes('已隔离为 bad:')).length === 2, '两条坏值均备份到 bad:* key');
  await s3.flush();
  const badKeys = [...state.storage.map.keys()].filter((k) => k.startsWith('bad:'));
  ok(badKeys.length === 2, '隔离备份实际落盘（' + badKeys.join(', ') + '）');
  // 隔离后原 ds: 值仍在（用户数据可抢救），主 key 下次 read 回退默认值
  ok(state.storage.map.get('ds:mycards') === 'not-an-array', '原坏值保留在 ds: key 下（可人工抢救）');

  console.log('\n== 3. 写队列 flush 语义 ==');
  const s4 = new Store(state);
  await s4.warmup();
  s4.write('bills', [{ id: 'b1', amount: 100 }]);
  ok(s4.readArray('bills').length === 1, 'write 后缓存即时可见（同步语义）');
  const flushP = s4.flush();
  ok(state.storage.map.get('ds:bills') === undefined, 'flush 前尚未保证落盘完成');
  await flushP;
  ok(Array.isArray(state.storage.map.get('ds:bills')), 'flush 后落盘完成');

  console.log('\n== 4. 未预热实例的防御行为 ==');
  const s5 = new Store(state);
  const fallback = s5.readObject('settings', { theme: 'light' });
  ok(fallback.theme === 'light', '未预热 readObject 回退默认值');
  s5.write('settings', { theme: 'dark' });
  await s5.flush();
  ok(state.storage.map.get('ds:settings').theme === 'dark', '未预热实例 write 仍正确落盘');

  console.log('\n========== ' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
