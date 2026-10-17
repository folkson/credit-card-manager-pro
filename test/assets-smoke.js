'use strict';
/* 资产模块 API 冒烟测试：起真实 server，走 HTTP 全链路验证 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-assets-'));
process.env.DATA_DIR = DATA;

// 预置脏数据（服务器启动前写入；server 有内存缓存，启动后改文件不可见）：
// - vouchers 含未知 type「movie」（旧版遗留类型，模拟手改/旧数据文件）
// - knowledge 缺 useLog/history/quota 数组字段
fs.writeFileSync(path.join(DATA, 'vouchers.json'), JSON.stringify([
  { id: 'dirty-vou', brand: '脏数据商家', name: '未知类型券', type: 'movie', totalUses: 2, usedUses: 0, balance: 0, createdAt: '2026-01-01T00:00:00.000Z' },
]));
fs.writeFileSync(path.join(DATA, 'knowledge.json'), JSON.stringify([
  { id: 'dirty-kg', title: '缺数组字段资源', uses: 0, price: 0, createdAt: '2026-01-01T00:00:00.000Z' },
]));

const server = require(ROOT + '/server/index.js');
const U = require(ROOT + '/server/util');

const PORT = parseInt(process.env.PORT || '3000', 10);
let BASE = '';
let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}

async function api(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let j = null;
  try { j = await res.json(); } catch (e) { /* ignore */ }
  return { status: res.status, body: j };
}

async function main() {
  // index.js 顶层即 listen，等待端口就绪即可
  await new Promise((r) => setTimeout(r, 600));
  BASE = 'http://127.0.0.1:' + PORT;

  // 回环访问默认放行（未设 AUTH_TOKEN），token 留空
  const cfgRes = await api('GET', '/api/auth/status');
  check('服务已启动且回环可访问', cfgRes.status === 200 && cfgRes.body.authorized === true, JSON.stringify(cfgRes.body));
  const token = '';

  // ---------- 会员卡 ----------
  console.log('\n== memberships ==');
  let r = await api('POST', '/api/memberships', { name: '腾讯视频VIP', category: 'video', mode: 'amount', balance: 100, expiry: U.todayStr() }, token);
  check('创建会员卡(金额模式,今天到期)', r.status === 201 && r.body.balance === 100, JSON.stringify(r.body).slice(0, 120));
  const memId = r.body.id;
  r = await api('POST', '/api/memberships', { name: '健身房年卡', category: 'fitness', mode: 'count', totalUses: 20 }, token);
  check('创建会员卡(次数模式)', r.status === 201 && r.body.totalUses === 20, JSON.stringify(r.body).slice(0, 120));
  const memCntId = r.body.id;
  r = await api('POST', '/api/memberships/' + memId + '/txn', { kind: 'consume', amount: 30 }, token);
  check('会员卡消费30 → 余额70', r.status === 201 && r.body.balance === 70, JSON.stringify(r.body));
  r = await api('POST', '/api/memberships/' + memId + '/txn', { kind: 'consume', amount: 9999 }, token);
  check('超额消费被拒(余额不足)', r.status === 400, 'status=' + r.status);
  r = await api('POST', '/api/memberships/' + memCntId + '/txn', { kind: 'use' }, token);
  check('按次使用 → usedUses=1', r.status === 201 && r.body.usedUses === 1, JSON.stringify(r.body));
  r = await api('POST', '/api/memberships/' + memCntId + '/txn', { kind: 'undo' }, token);
  check('回退 → usedUses=0', r.status === 201 && r.body.usedUses === 0, JSON.stringify(r.body));
  r = await api('PUT', '/api/memberships/' + memId, { note: '家庭共享' }, token);
  check('编辑会员卡保留流水与到期日', r.status === 200 && r.body.expiry === U.todayStr() && (r.body.transactions || []).length === 1, JSON.stringify(r.body).slice(0, 150));

  // ---------- 卡/票 ----------
  console.log('\n== vouchers ==');
  await api('POST', '/api/voucherbrands', { name: '星巴克', note: '咖啡券常用商家' }, token);
  r = await api('POST', '/api/voucherbrands', { name: '星巴克' }, token);
  check('商家同名查重', r.status === 400, 'status=' + r.status);
  r = await api('POST', '/api/vouchers', { brand: '星巴克', name: '咖啡买一送一', type: 'coupon', totalUses: 3, expiry: '2027-01-01' }, token);
  check('创建优惠券', r.status === 201 && r.body.mode === 'count', JSON.stringify(r.body).slice(0, 120));
  const vouCoupon = r.body.id;
  r = await api('POST', '/api/vouchers', { brand: '瑞幸', name: '100元储值卡', type: 'storedcard', balance: 100 }, token);
  check('创建储值卡券', r.status === 201 && r.body.mode === 'amount' && r.body.balance === 100, JSON.stringify(r.body).slice(0, 120));
  const vouCard = r.body.id;
  r = await api('POST', '/api/vouchers', { brand: '麦当劳', name: '满50减10', type: 'fullred', threshold: 50, discount: 10, totalUses: 1 }, token);
  check('创建满减券', r.status === 201 && r.body.threshold === 50 && r.body.discount === 10, JSON.stringify(r.body).slice(0, 120));
  const vouFull = r.body.id;
  r = await api('POST', '/api/vouchers/' + vouCoupon + '/use', {}, token);
  check('核销优惠券 → usedUses=1', r.status === 201 && r.body.usedUses === 1, JSON.stringify(r.body));
  r = await api('POST', '/api/vouchers/' + vouCoupon + '/use', { undo: true }, token);
  check('回退核销 → usedUses=0', r.status === 201 && r.body.usedUses === 0, JSON.stringify(r.body));
  r = await api('POST', '/api/vouchers/' + vouCard + '/topup', { kind: 'topup', amount: 50 }, token);
  check('储值券充值50 → 余额150', r.status === 201 && r.body.balance === 150, JSON.stringify(r.body));
  r = await api('POST', '/api/vouchers/' + vouCard + '/topup', { kind: 'consume', amount: 35 }, token);
  check('储值券金额核销35 → 余额115', r.status === 201 && r.body.balance === 115, JSON.stringify(r.body));
  r = await api('POST', '/api/vouchers/' + vouCard + '/topup', { kind: 'consume', amount: 999 }, token);
  check('储值券超额被拒', r.status === 400, 'status=' + r.status);
  r = await api('POST', '/api/vouchers/' + vouFull + '/use', { amount: 60 }, token);
  check('满减券核销(满50门槛，单笔60)', r.status === 201 && r.body.usedUses === 1, JSON.stringify(r.body).slice(0, 120));
  r = await api('POST', '/api/vouchers/' + vouFull + '/use', { undo: true }, token);
  check('满减券撤销核销', r.status === 201 && r.body.usedUses === 0, JSON.stringify(r.body).slice(0, 120));
  r = await api('POST', '/api/vouchers/' + vouFull + '/use', { amount: 30 }, token);
  check('满减券未达门槛被拒', r.status === 400, 'status=' + r.status);

  // ---------- 商家 ----------
  r = await api('GET', '/api/voucherbrands', undefined, token);
  check('商家列表含星巴克', r.status === 200 && r.body.some((x) => x.name === '星巴克'), JSON.stringify(r.body).slice(0, 120));

  // ---------- 知识库 ----------
  console.log('\n== knowledge ==');
  r = await api('POST', '/api/knowledge', { title: '极客时间年度会员', platform: '极客时间', resourceType: 'membership', category: 'subscription', cycle: 'yearly', price: 299, purchaseDate: '2026-01-15', expiry: '2027-01-15', quota: { countMax: 0, download: 10, call: 5 }, tags: '技术、架构' }, token);
  check('创建知识库资源', r.status === 201 && r.body.price === 299, JSON.stringify(r.body).slice(0, 150));
  const kgId = r.body.id;
  check('知识库 tags 字符串切数组', JSON.stringify(r.body.tags) === '["技术","架构"]', JSON.stringify(r.body.tags));
  r = await api('POST', '/api/knowledge/' + kgId + '/use', { note: '学习第一课' }, token);
  check('使用+1 → uses=1', r.status === 201 && r.body.uses === 1, JSON.stringify(r.body));
  r = await api('POST', '/api/knowledge/' + kgId + '/use', { undo: true }, token);
  check('使用回退 → uses=0', r.status === 201 && r.body.uses === 0, JSON.stringify(r.body));
  r = await api('POST', '/api/knowledge/' + kgId + '/use', { quotaKey: 'download' }, token);
  check('扣下载配额请求成功', r.status === 201, JSON.stringify(r.body));
  r = await api('GET', '/api/knowledge', undefined, token);
  const kgAfter = r.body.find((x) => x.id === kgId);
  check('下载配额 10→9', kgAfter && kgAfter.quota.download === 9, JSON.stringify(kgAfter && kgAfter.quota));
  r = await api('POST', '/api/knowledge/' + kgId + '/history', { type: 'renew', amount: 299, note: '续费一年', date: '2027-01-10' }, token);
  check('续费流水', r.status === 201 && r.body.history.amount === 299, JSON.stringify(r.body).slice(0, 120));

  // ---------- 聚合统计 / 动态流 / 到期 ----------
  console.log('\n== stats/feed/expiring ==');
  r = await api('GET', '/api/assets/stats', undefined, token);
  check('stats: membership.balance=70', r.status === 200 && r.body.membership.balance === 70, JSON.stringify(r.body).slice(0, 200));
  check('stats: knowledge.totalSpend=299', r.body.knowledge && r.body.knowledge.totalSpend === 299, JSON.stringify(r.body.knowledge));
  r = await api('GET', '/api/assets/feed?limit=50', undefined, token);
  check('feed 合并多源', r.status === 200 && Array.isArray(r.body) && r.body.length >= 5, 'len=' + (r.body || []).length);
  const kinds = new Set((r.body || []).map((x) => x.kind));
  check('feed 含 membership/voucher/knowledge 三源', kinds.has('membership') && kinds.has('voucher') && kinds.has('knowledge'), JSON.stringify([...kinds]));
  r = await api('GET', '/api/assets/expiring?days=365', undefined, token);
  check('expiring 扫描到临期项', r.status === 200 && Array.isArray(r.body) && r.body.length >= 1, JSON.stringify(r.body).slice(0, 200));
  const expKinds = new Set((r.body || []).map((x) => x.kind));
  // 会员卡今天到期、券 2027、知识库 2027 → 三类都应出现在窗口内
  check('expiring 含三类资产', expKinds.has('membership') && expKinds.has('voucher') && expKinds.has('knowledge'), JSON.stringify([...expKinds]));

  // ---------- 备份导出 v2 ----------
  console.log('\n== backup export v2 ==');
  r = await fetch(BASE + '/api/mycards/export', { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  const backupText = await r.text();
  let backup = null;
  try { backup = JSON.parse(backupText); } catch (e) { /* ignore */ }
  check('备份 schema=guanka-backup', r.status === 200 && backup && backup.schema === 'guanka-backup', backupText.slice(0, 120));
  check('备份 version=2', backup && backup.version === 2, 'version=' + (backup && backup.version));
  check('备份含四类资产', !!(backup && backup.memberships && backup.vouchers && backup.voucherBrands && backup.knowledge), Object.keys(backup || {}).join(','));

  // ---------- 备份导入 v2（merge 幂等）----------
  console.log('\n== backup import v2 ==');
  r = await api('POST', '/api/mycards/import', { mode: 'merge', data: backup }, token);
  check('merge 导入：全量幂等跳过', r.status === 200 && r.body.importedCards === 0 && r.body.memberships === 0 && r.body.vouchers === 0 && r.body.knowledge === 0,
    JSON.stringify(r.body).slice(0, 200));
  r = await api('POST', '/api/mycards/import', { mode: 'replace', data: backup }, token);
  check('replace 导入：资产恢复', r.status === 200 && r.body.memberships >= 1 && r.body.vouchers >= 1 && r.body.knowledge >= 1,
    JSON.stringify(r.body).slice(0, 200));
  r = await api('GET', '/api/memberships', undefined, token);
  check('replace 后会员卡余额正确', r.status === 200 && r.body.length >= 1 && r.body.some((m) => m.name === '腾讯视频VIP' && m.balance === 70), JSON.stringify(r.body).slice(0, 150));

  // ---------- 脏数据容错（预置在启动前的数据文件里，见文件头部） ----------
  console.log('\n== dirty data tolerance ==');
  r = await api('GET', '/api/vouchers', undefined, token);
  const dirty = (r.body || []).find((x) => x.id === 'dirty-vou');
  check('脏 type 不炸列表接口', r.status === 200 && !!dirty, 'status=' + r.status);
  check('脏 type 回退优惠券标签', dirty && dirty.typeLabel === '优惠券', 'typeLabel=' + (dirty && dirty.typeLabel));
  r = await api('POST', '/api/knowledge/dirty-kg/use', {}, token);
  check('缺 useLog 数组时核销不 500', r.status === 201 && r.body.uses === 1, JSON.stringify(r.body).slice(0, 100));
  r = await api('POST', '/api/knowledge/dirty-kg/history', { type: 'renew', amount: 10 }, token);
  check('缺 history 数组时流水不 500', r.status === 201, JSON.stringify(r.body).slice(0, 100));
  r = await api('GET', '/api/knowledge', undefined, token);
  const dk = (r.body || []).find((x) => x.id === 'dirty-kg');
  check('兜底数组已写入', dk && Array.isArray(dk.useLog) && dk.useLog.length === 1 && Array.isArray(dk.history) && dk.history.length === 1, JSON.stringify(dk && { u: dk.useLog && dk.useLog.length, h: dk.history && dk.history.length }));

  // ---------- 清理 ----------
  console.log('\n== cleanup ==');
  r = await api('DELETE', '/api/knowledge/' + kgId, undefined, token);
  check('删除知识库资源', r.status === 200, 'status=' + r.status);
  r = await api('DELETE', '/api/vouchers/' + vouCard, undefined, token);
  check('删除券', r.status === 200, 'status=' + r.status);
  r = await api('DELETE', '/api/memberships/' + memId, undefined, token);
  check('删除会员卡', r.status === 200, 'status=' + r.status);

  console.log('\n========== 结果 ==========');
  console.log('通过 ' + pass + ' / 失败 ' + fail);
  if (failures.length) { console.log('失败项:\n  - ' + failures.join('\n  - ')); }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试脚本异常:', e); process.exit(2); });
