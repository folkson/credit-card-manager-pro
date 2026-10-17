'use strict';

/* ============================================================
 * 管卡 — 扩展资产模块（移植自 Benefit Tracker）
 *
 * 三类独立资产 + 商家目录：
 *   memberships   会员卡/储值卡（储值型按余额、按次型按次数，附流水）
 *   vouchers      卡/票（优惠券=次数、储值卡=金额、满减券=次数+满减规则）
 *   knowledge     知识库资源（订阅价格/周期/进度/配额/使用记录）
 *   voucherBrands 独立商家（可先建商家后加券）
 *
 * 设计约定（与 routes.js 一致）：
 *   - 数据存 store 数组键，读经 readArray（坏文件自动隔离回退空数组）
 *   - 写入前一律归一化：字段类型、金额两位小数、日期真实校验
 *   - id 用 U.uid()，createdAt ISO 时间戳；流水/使用记录内嵌于父对象
 * ============================================================ */

const U = require('./util');

const MAX_MONEY = 100000000; // 与 routes.js MAX_MONEY 一致（1 亿，防脏数据封顶）

// ---------- 类别常量（与 bt 对齐） ----------
const MEM_CATEGORIES = ['video', 'ecard', 'dining', 'fitness', 'beauty', 'travel', 'course', 'tool', 'subscription', 'other'];
const MEM_CAT_LABELS = {
  video: '视频娱乐', ecard: '储值卡', dining: '餐饮美食', fitness: '运动健身',
  beauty: '丽人美肤', travel: '出行旅游', course: '在线课程', tool: '效率工具',
  subscription: '软件订阅', other: '其他',
};
const VOUCHER_TYPES = ['coupon', 'storedcard', 'fullred'];
const VOUCHER_TYPE_META = {
  coupon: { l: '优惠券', mode: 'count' },
  storedcard: { l: '储值卡', mode: 'amount' },
  fullred: { l: '满减券', mode: 'count', rule: true },
};
// 旧类型兼容（bt v2.15.79 前的类型，统一映射到优惠券）
const VOUCHER_TYPE_LEGACY = { cyclecard: 'coupon', movie: 'coupon', card: 'coupon', ticket: 'coupon' };
const KG_TYPES = ['file', 'online_doc', 'consultation', 'membership', 'course', 'tool', 'other'];
const KG_TYPE_LABELS = {
  file: '网盘/文件资料', online_doc: '在线文档/表格', consultation: '在线咨询服务',
  membership: '会员/社群/资讯平台', course: '学习课程', tool: '工具/软件订阅', other: '其他',
};
const KG_CATS = ['course', 'column', 'community', 'subscription', 'book', 'database', 'resource', 'other'];
const KG_CAT_LABELS = {
  course: '课程', column: '专栏', community: '社群', subscription: '软件订阅',
  book: '电子书', database: '数据库', resource: '资料库', other: '其他',
};
const KG_CYCLES = ['monthly', 'yearly', 'lifetime'];
const KG_CYCLE_LABELS = { monthly: '月付', yearly: '年付', lifetime: '终身' };

// ---------- 工具 ----------
function round2(n) { return Math.round(Number(n) * 100) / 100; }

function nonNegNum(v, dft) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dft;
}

function moneyIn(v, dft) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) return dft;
  return round2(n);
}

function dateOrNull(v) {
  return U.parseDateStr(v) ? String(v) : '';
}

function nowIso() { return new Date().toISOString(); }

// ---------- 归一化 ----------

function normalizeTxn(t) {
  return {
    id: String(t.id || U.uid()),
    kind: t.kind === 'topup' ? 'topup' : 'consume',
    amount: moneyIn(t.amount, 0),
    note: String(t.note || '').trim(),
    date: dateOrNull(t.date) || U.todayStr(),
    createdAt: t.createdAt || nowIso(),
  };
}

function normalizeMembership(m, existing) {
  const base = existing || {};
  const out = {
    id: base.id || m.id || U.uid(),
    name: String(m.name == null ? base.name : m.name).trim(),
    category: MEM_CATEGORIES.includes(m.category) ? m.category : (MEM_CATEGORIES.includes(base.category) ? base.category : 'other'),
    // 储值型：余额；按次型：totalUses/usedUses。balance 对按次型保留 0
    mode: m.mode === 'count' ? 'count' : 'amount',
    balance: moneyIn(m.balance != null ? m.balance : base.balance, 0),
    totalUses: Math.max(0, Math.round(nonNegNum(m.totalUses != null ? m.totalUses : base.totalUses, 1))),
    usedUses: Math.max(0, Math.round(nonNegNum(m.usedUses != null ? m.usedUses : base.usedUses, 0))),
    expiry: m.expiry !== undefined ? dateOrNull(m.expiry) : (base.expiry || ''),
    note: String(m.note == null ? (base.note || '') : m.note).trim(),
    createdAt: base.createdAt || m.createdAt || nowIso(),
  };
  // 流水：传入即整体替换（编辑场景），否则保留旧流水；单条仍归一化
  const txns = m.transactions !== undefined ? m.transactions : base.transactions;
  out.transactions = Array.isArray(txns) ? txns.map(normalizeTxn) : [];
  return out;
}

function normalizeVoucher(v, existing) {
  const base = existing || {};
  let type = v.type != null ? String(v.type) : base.type;
  type = VOUCHER_TYPES.includes(type) ? type : (VOUCHER_TYPE_LEGACY[type] || 'coupon');
  const meta = VOUCHER_TYPE_META[type];
  const out = {
    id: base.id || v.id || U.uid(),
    brand: String(v.brand == null ? base.brand : v.brand).trim(),
    name: String(v.name == null ? base.name : v.name).trim(),
    type,
    mode: meta.mode,
    totalUses: Math.max(0, Math.round(nonNegNum(v.totalUses != null ? v.totalUses : base.totalUses, 1))),
    usedUses: Math.max(0, Math.round(nonNegNum(v.usedUses != null ? v.usedUses : base.usedUses, 0))),
    balance: moneyIn(v.balance != null ? v.balance : base.balance, 0),
    threshold: moneyIn(v.threshold != null ? v.threshold : base.threshold, 0),
    discount: moneyIn(v.discount != null ? v.discount : base.discount, 0),
    expiry: v.expiry !== undefined ? dateOrNull(v.expiry) : (base.expiry || ''),
    scope: String(v.scope == null ? (base.scope || '') : v.scope).trim(),
    note: String(v.note == null ? (base.note || '') : v.note).trim(),
    createdAt: base.createdAt || v.createdAt || nowIso(),
  };
  const txns = v.transactions !== undefined ? v.transactions : base.transactions;
  out.transactions = Array.isArray(txns) ? txns.map(normalizeTxn) : [];
  return out;
}

function normalizeQuota(q, baseQ) {
  const b = baseQ || {};
  const src = q && typeof q === 'object' ? q : {};
  const f = (key) => Math.max(0, Math.round(nonNegNum(src[key] != null ? src[key] : b[key], 0)));
  return { count: f('count'), countMax: f('countMax'), balance: f('balance'), download: f('download'), call: f('call') };
}

function normalizeKgLog(u) {
  return {
    id: String(u.id || U.uid()),
    date: dateOrNull(u.date) || U.todayStr(),
    note: String(u.note || '').trim(),
    createdAt: u.createdAt || nowIso(),
  };
}

function normalizeKgHistory(h) {
  const types = ['recharge', 'renew', 'use', 'refund', 'gift'];
  return {
    id: String(h.id || U.uid()),
    type: types.includes(h.type) ? h.type : 'renew',
    date: dateOrNull(h.date) || U.todayStr(),
    note: String(h.note || '').trim(),
    amount: moneyIn(h.amount, 0),
    createdAt: h.createdAt || nowIso(),
  };
}

function normalizeKnowledge(k, existing) {
  const base = existing || {};
  const out = {
    id: base.id || k.id || U.uid(),
    title: String(k.title == null ? base.title : k.title).trim(),
    platform: String(k.platform == null ? (base.platform || '') : k.platform).trim(),
    resourceType: KG_TYPES.includes(k.resourceType) ? k.resourceType : (KG_TYPES.includes(base.resourceType) ? base.resourceType : 'other'),
    category: KG_CATS.includes(k.category) ? k.category : (KG_CATS.includes(base.category) ? base.category : 'other'),
    cycle: KG_CYCLES.includes(k.cycle) ? k.cycle : (KG_CYCLES.includes(base.cycle) ? base.cycle : 'yearly'),
    lifetime: k.lifetime != null ? !!k.lifetime : !!base.lifetime,
    price: moneyIn(k.price != null ? k.price : base.price, 0),
    purchaseDate: k.purchaseDate !== undefined ? dateOrNull(k.purchaseDate) : (base.purchaseDate || ''),
    expiry: k.expiry !== undefined ? dateOrNull(k.expiry) : (base.expiry || ''),
    progress: Math.min(100, Math.max(0, Math.round(nonNegNum(k.progress != null ? k.progress : base.progress, 0)))),
    uses: Math.max(0, Math.round(nonNegNum(k.uses != null ? k.uses : base.uses, 0))),
    account: String(k.account == null ? (base.account || '') : k.account).trim(),
    note: String(k.note == null ? (base.note || '') : k.note).trim(),
    remindRenew: k.remindRenew != null ? !!k.remindRenew : !!base.remindRenew,
    createdAt: base.createdAt || k.createdAt || nowIso(),
  };
  const arrOf = (val, dft) => {
    if (val !== undefined) {
      if (Array.isArray(val)) return val.map((x) => String(x).trim()).filter(Boolean);
      if (typeof val === 'string') return val.split(/[、\n|]/).map((x) => x.trim()).filter(Boolean);
      return dft;
    }
    return dft;
  };
  out.links = arrOf(k.links, base.links || []);
  out.catalog = arrOf(k.catalog, base.catalog || []);
  out.tags = arrOf(k.tags, base.tags || []);
  out.topics = arrOf(k.topics, base.topics || []);
  const quotaSrc = k.quota !== undefined ? k.quota : base.quota;
  out.quota = normalizeQuota(quotaSrc, base.quota);
  const useLog = k.useLog !== undefined ? k.useLog : base.useLog;
  out.useLog = Array.isArray(useLog) ? useLog.map(normalizeKgLog) : [];
  const hist = k.history !== undefined ? k.history : base.history;
  out.history = Array.isArray(hist) ? hist.map(normalizeKgHistory) : [];
  return out;
}

function normalizeBrand(b, existing) {
  const base = existing || {};
  return {
    id: base.id || b.id || U.uid(),
    name: String(b.name == null ? base.name : b.name).trim(),
    note: String(b.note == null ? (base.note || '') : b.note).trim(),
    createdAt: base.createdAt || b.createdAt || nowIso(),
  };
}

// ---------- 剩余量口径 ----------
// 次数口径 = 总次数 - 已用；金额口径 = 余额
function voucherRemaining(v) { return v.mode === 'amount' ? (Number(v.balance) || 0) : ((Number(v.totalUses) || 0) - (Number(v.usedUses) || 0)); }

function membershipRemaining(m) { return m.mode === 'amount' ? (Number(m.balance) || 0) : ((Number(m.totalUses) || 0) - (Number(m.usedUses) || 0)); }

// 距到期天数（expiry 为空返回 null）；与管卡「日期字符串直接比较」风格一致
function daysLeftOf(dateStr, now) {
  if (!dateStr) return null;
  const t = new Date(dateStr + 'T00:00:00');
  if (isNaN(t.getTime())) return null;
  const n = now || new Date();
  const t0 = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.round((t - t0) / 86400000);
}

// ---------- 到期提醒项收集（供 reminder 扩展调用） ----------
// cfg.rules.assetExpiryDays 提前天数；返回与 reminder.item 相同结构
function collectAssetExpiry(data, cfg, now) {
  const items = [];
  const days = cfg && cfg.rules && Number(cfg.rules.assetExpiryDays) || 0;
  if (days <= 0) return items;
  const scan = (list, label, kindOf) => {
    for (const it of list || []) {
      const left = daysLeftOf(it.expiry, now);
      if (left == null || left < 0 || left > days) continue;
      items.push({
        type: 'asset',
        key: `asset:${kindOf}:${it.id}:${it.expiry}`,
        title: `${label}到期：${it.name || it.title || '未命名'}`,
        body: [
          `- 项目：${it.name || it.title}`,
          `- 分类：${label}`,
          `- 到期日：${it.expiry}（${left === 0 ? '今天到期' : left + ' 天后到期'}）`,
          `- 状态：${left === 0 ? '今天最后一天，尽快使用' : '临期未使用，请合理安排'}`,
        ].join('\n'),
      });
    }
  };
  scan(data.memberships, '会员卡/储值卡', 'membership');
  scan(data.vouchers, '卡/票', 'voucher');
  scan(data.knowledge.filter((k) => !k.lifetime), '知识库订阅', 'knowledge');
  return items;
}

module.exports = {
  MEM_CATEGORIES, MEM_CAT_LABELS,
  VOUCHER_TYPES, VOUCHER_TYPE_META, VOUCHER_TYPE_LEGACY,
  KG_TYPES, KG_TYPE_LABELS, KG_CATS, KG_CAT_LABELS, KG_CYCLES, KG_CYCLE_LABELS,
  normalizeMembership, normalizeVoucher, normalizeKnowledge, normalizeBrand,
  normalizeTxn, normalizeKgLog, normalizeKgHistory,
  voucherRemaining, membershipRemaining, daysLeftOf, collectAssetExpiry,
  round2, moneyIn, dateOrNull,
};
