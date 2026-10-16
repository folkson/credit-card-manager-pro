'use strict';

const crypto = require('crypto');
const U = require('./util');
const { SEED_CARDS, SEED_VERSION } = require('./seed');
const notifier = require('./notifier');
const reminder = require('./reminder');
const ics = require('./ics');
const D = require('./dates');

// 账单流水（月账单 + 是否已还）
function getBills() { return store.readArray('bills'); }

// ---------- 合并账单组 ----------
// 组本身只存 id + 名称，成员关系记在 mycards[].billGroupId —— 单一事实来源，
// 删卡/改组不会留下需要两头维护的孤儿成员表。
function getBillGroups() { return store.readArray('billGroups'); }

// 提醒原始配置：必须是对象。若文件被写成数组/标量，readObject 会回退默认值，
// 避免 normalizeConfig 拿到非对象后把 sentLog/history 一起丢掉。
function getNotifyRaw() { return store.readObject('notify', null); }

/* ---------------- 推送凭证掩码 ----------------
 * 接口一律不回传真值，只回「•••• + 末 4 位」；前端把它填进输入框，用户不改动就原样提交，
 * PUT 侧识别出掩码语义并保留磁盘原值。这样既不影响「看着有值」的交互，又不制造泄露面。
 */
const NOTIFY_SECRET_FIELDS = {
  wxpusher: ['appToken'],
  serverchan: ['sendkey'],
  bark: ['deviceKey'],
};
const MASK_PREFIX = '••••';

function isMaskedSecret(v) {
  return typeof v === 'string' && v.startsWith(MASK_PREFIX);
}
function maskSecret(v) {
  const s = String(v || '');
  if (!s) return '';
  return s.length <= 4 ? MASK_PREFIX : MASK_PREFIX + s.slice(-4);
}
/** 深拷贝一份并把凭证替换为掩码，避免污染 store 缓存里的真实对象 */
function maskNotifySecrets(cfg) {
  const clone = JSON.parse(JSON.stringify(cfg || {}));
  for (const ch of Object.keys(NOTIFY_SECRET_FIELDS)) {
    const c = clone.channels && clone.channels[ch];
    if (!c) continue;
    for (const f of NOTIFY_SECRET_FIELDS[ch]) {
      if (c[f]) c[f] = maskSecret(c[f]);
    }
  }
  return clone;
}

function groupNameOf(groupId) {
  if (!groupId) return '';
  const g = getBillGroups().find((x) => x.id === groupId);
  return g ? g.name : '';
}

/**
 * 组内「最后还款日」一致性校验（策略③：组内强制同还款日）
 * 只比当期是不够的——fixed(20) 与 afterBill(N) 可能在某个账单周期恰好落在同一天，
 * 换个月就错开。这里按未来 14 个月 × 每月 10 个采样日逐一推算「最后还款日」，
 * 只有全部一致才判定为同一还款节奏（覆盖月末钳制与跨年闰日的分支）。
 */
const REPAY_PROBE_DAYS = [1, 5, 10, 15, 20, 25, 28, 29, 30, 31];
function sameRepaySchedule(a, b, now) {
  if (a === b) return true;
  const base = now || new Date();
  for (let i = 0; i < 14; i++) {
    for (const d of REPAY_PROBE_DAYS) {
      const probe = new Date(base.getFullYear(), base.getMonth() + i, d);
      if (D.paymentInfo(a, probe).lastPayDate !== D.paymentInfo(b, probe).lastPayDate) return false;
    }
  }
  return true;
}

/** 校验把 target 放入 groupId 是否合法；返回错误文案，合法则返回 '' */
function groupAssignError(myCards, target, groupId, now) {
  if (!groupId) return '';
  if (!getBillGroups().some((g) => g.id === groupId)) return '合并账单组不存在';
  for (const other of myCards) {
    if (other.id === target.id || other.billGroupId !== groupId) continue;
    if (!sameRepaySchedule(other, target, now)) {
      return '与「' + (other.alias || other.name) + '」的最后还款日不一致，无法合并（组内卡必须同还款日）';
    }
  }
  return '';
}

// 迁移/自愈：清掉指向已不存在账单组的悬空引用；成员被删空后解散空组
function cleanBillGroups() {
  const groups = getBillGroups();          // readArray 保证是数组
  const myCards = getMyCards();            // 同上
  const ids = new Set(groups.map((g) => g && g.id).filter(Boolean));
  let changed = false;
  for (const m of myCards) {
    if (m.billGroupId && !ids.has(m.billGroupId)) { m.billGroupId = ''; changed = true; }
  }
  if (changed) store.write('mycards', myCards);
  const alive = new Set(myCards.map((m) => m.billGroupId).filter(Boolean));
  const kept = groups.filter((g) => g && alive.has(g.id));
  if (kept.length !== groups.length) store.write('billGroups', kept);
}

// 年费达标状态（金山口径：无年费 / 手工声明 / 自动判定）
// ws 必须由调用方传入 waiverState() 的结果——原始持卡记录上没有 waiver 字段（那是 computeMyCard 的计算输出），
// 之前直接读 mc.waiver 恒为 {}，导致免年费/刷免达标一律误报「未达标」
function feeStatusOf(mc, now, ws) {
  const year = now.getFullYear();
  if (!(Number(mc.annualFee) > 0)) return '无年费';
  if (Number(mc.waivedYear) >= year && Number(mc.waivedYear) > 0) return '已达标(手工)';
  const w = ws || {};
  // 已刷核定期：填了往年 → 跨年后已刷数据自动失效
  const periodOk = !Number(mc.countPeriodYear) || Number(mc.countPeriodYear) >= year;
  let autoMet = false;
  if (w.kind === '免年费') autoMet = true;
  else if (w.kind === '刚性') autoMet = false;
  else autoMet = !!w.met; // 消费/笔数刷免 按进度；积分抵扣/资产存免 按开关
  return (periodOk && autoMet) ? '已达标(自动)' : '未达标';
}

const CARD_FIELDS = ['bank', 'name', 'level', 'org', 'annualFee', 'waiverType', 'waiverCondition', 'waiverPolicy', 'startCredit', 'benefits', 'applyCondition', 'note'];
const CSV_HEADER = ['银行', '卡片名称', '卡等级', '卡组织', '年费', '免年费类型', '刷免条件', '免年费政策', '起批额度', '主要权益', '申请条件', '备注'];
const WAIVER_TYPES = ['消费刷免', '笔数刷免', '积分抵扣', '资产存免', '刚性', '免年费'];
const RESET_CYCLES = ['自然月', '自然年', '年费日', '一次性', '无固定'];
// 权益类型（对齐金山文档权益台账的标准化取值）
const BENEFIT_TYPES = ['境内接送机', '境外接送机', '境内机场贵宾楼', '机场龙腾悦途PP', '机场龙腾悦途PP（可餐食）', '代驾', '租车', '道路救援', '体检', '洗牙', '挂号', '挂号+导诊', '酒店优惠', '运动健身', '延误险', '积分兑换里程', '其他'];
const CHANNELS = ['微信支付', '支付宝支付', '云闪付线上', '云闪付线下', 'ApplePay', '其他手机Pay', '美团支付', '抖音支付', '京东支付', '程支付', '多多支付', 'POS机刷卡'];
const CATEGORIES = ['餐饮', '购物', '交通', '加油', '超市', '旅行', '娱乐', '医疗', '教育', '其他'];

// ---- 「我的持卡」批量导入 CSV ----
// 与卡种 CSV 的区别：卡种 CSV 描述「市面上有什么卡」，本表描述「我持有哪张卡」。
// 前 4 列（银行/卡片名称/卡组织/卡等级）是匹配卡种库的四元组，其余列是持卡人自己的数据。
const MYCARD_FIELDS = [
  'bank', 'name', 'org', 'level',
  'alias', 'last4', 'creditLimit', 'monthlySpendTarget',
  'billingDay', 'repayMode', 'repayValue', 'graceDays', 'maxInterestDays',
  'feeMonth', 'feeDay', 'waivedYear', 'countPeriodYear', 'benefits',
];
const MYCARD_CSV_HEADER = [
  '银行', '卡片名称', '卡组织', '卡等级',
  '别名', '卡号后四位', '授信额度', '月消费目标',
  '账单日', '还款方式', '还款值', '宽限期', '最长免息期',
  '年费收取月', '年费收取日', '已达标年份', '已刷核定期', '权益',
];

// 模板示例行：首行演示「卡种库里已有」的标准用法，次行演示「权益多字段写法」
const MYCARD_CSV_SAMPLES = [
  ['招商银行', '经典白金信用卡', '银联+Mastercard', '白金卡',
    '我的招行白', '6688', '50000', '8000',
    '5', '每月固定日', '20', '3', '50',
    '3', '15', '', '', '机场贵宾厅:6:自然年|生日10倍积分:1:自然年'],
  ['中国银行', '长城环球通信用卡', 'VISA', '金卡',
    '', '1234', '30000', '',
    '12', '账单日后N天', '20', '5', '',
    '6', '1', '', '', '境外返现:1:自然月'],
];

let store;

function init(s) {
  store = s;
  const meta = store.readObject('meta', { seedVersion: 0 });
  // 卡种库必须是数组：类型不符时 readArray 已隔离原文件并回退空数组，这里再按需播种
  let cards = store.readArray('cards');
  if (cards.length === 0) {
    cards = SEED_CARDS.map((c) => normalizeCard(c, null));
    store.write('cards', cards);
    store.write('meta', Object.assign({}, meta, { seedVersion: SEED_VERSION }));
  } else if (meta.seedVersion !== SEED_VERSION) {
    // 升级时合并新卡种：已存在的（银行+名称+组织+等级）不重复导入
    const keys = new Set(cards.map(cardKey));
    let added = 0;
    for (const c of SEED_CARDS) {
      const k = cardKey(c);
      if (!keys.has(k)) { cards.push(normalizeCard(c, null)); keys.add(k); added++; }
    }
    store.write('cards', cards);
    store.write('meta', Object.assign({}, meta, { seedVersion: SEED_VERSION }));
    if (added > 0) console.log(`[管卡] 卡种库已合并 ${added} 张新卡，当前共 ${cards.length} 张`);
  }
  // 预热并做类型归一：这些数据集必须都是数组，否则后续 .map/.push/.filter 会抛 TypeError
  store.readArray('mycards');
  store.readArray('consumptions');
  store.readArray('benefits');
  store.readArray('bills');
  store.readArray('billGroups');
  store.readObject('settings', { theme: 'light', bankOrder: [], banksCollapsed: {}, cardBanksCollapsed: {} });
  // 历史数据自愈：持卡上可能残留指向已删组的引用
  cleanBillGroups();
  migrateBenefitIds();
}

// 一次性迁移：历史权益与权益记录此前只按索引归属，编辑时增删/重排会导致记录错配（B 继承 A 的历史）。
// 这里按「当前索引 → 权益」的对应关系补稳定 id（迁移瞬间该映射仍成立），此后记录一律按 id 归属。
function migrateBenefitIds() {
  const mcs = getMyCards();
  let bChanged = 0;
  for (const mc of mcs) {
    for (const b of mc.benefits || []) {
      if (!b.id) { b.id = U.uid(); bChanged++; }
    }
  }
  if (bChanged) store.write('mycards', mcs);
  const mcById = new Map(mcs.map((m) => [m.id, m]));
  const recs = getBenefits();
  let rChanged = 0;
  for (const r of recs) {
    if (r.bid) continue;
    const mc = mcById.get(r.myCardId);
    const b = mc && (mc.benefits || [])[r.idx];
    if (b && b.id) { r.bid = b.id; rChanged++; }
  }
  if (rChanged) store.write('benefits', recs);
  if (bChanged || rChanged) console.log(`[管卡] 权益稳定 id 迁移完成：权益 ${bChanged} 项、历史记录 ${rChanged} 条`);
}

function cardKey(c) {
  return [c.bank, c.name, c.org, c.level].map((x) => String(x || '').trim()).join('|');
}

function normalizeCard(c, id) {
  return {
    id: id || U.uid(),
    bank: String(c.bank || '').trim(),
    name: String(c.name || '').trim(),
    level: String(c.level || '').trim(),
    org: String(c.org || '').trim(),
    annualFee: U.parseAmount(c.annualFee),
    waiverType: WAIVER_TYPES.includes(c.waiverType) ? c.waiverType : '免年费',
    waiverCondition: String(c.waiverCondition == null ? '0' : c.waiverCondition).trim(),
    waiverPolicy: String(c.waiverPolicy || '').trim(),
    startCredit: U.parseAmount(c.startCredit),
    benefits: Array.isArray(c.benefits) ? c.benefits.map((b) => String(b).trim()).filter(Boolean) : String(c.benefits || '').split('|').map((b) => b.trim()).filter(Boolean),
    applyCondition: String(c.applyCondition || '').trim(),
    note: String(c.note || '').trim(),
  };
}

// ---------- 持卡计算 ----------
function getConsumptions() { return store.readArray('consumptions'); }
function getBenefits() { return store.readArray('benefits'); }
function getMyCards() { return store.readArray('mycards'); }
function getCards() { return store.readArray('cards'); }

// 每请求构建一次索引：消费按卡分桶（金额/笔数分开）、权益记录按 卡→序号 嵌套分桶。
// 避免 computeMyCard/benefitUsed 对全表反复 filter（原实现 O(卡数 × 记录数)）。
function buildIndexes() {
  const consByCard = new Map();
  for (const r of getConsumptions()) {
    let e = consByCard.get(r.myCardId);
    if (!e) { e = { amount: [], count: [] }; consByCard.set(r.myCardId, e); }
    if (r.type === 'amount') e.amount.push(r); else if (r.type === 'count') e.count.push(r);
  }
  const benByCard = new Map();
  for (const r of getBenefits()) {
    let m = benByCard.get(r.myCardId);
    if (!m) { m = new Map(); benByCard.set(r.myCardId, m); }
    // 优先按稳定 id 分桶（权益增删/重排后索引会前移，按 idx 分桶会张冠李戴）；
    // 无 bid 的历史记录退回 idx 桶，由查询侧兼容
    const key = r.bid ? 'bid:' + r.bid : 'idx:' + r.idx;
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(r);
  }
  return { consByCard, benByCard };
}

function cardRecords(idx, myCardId) {
  return idx.consByCard.get(myCardId) || { amount: [], count: [] };
}

function amountRecordsOf(myCardId) {
  return getConsumptions().filter((r) => r.myCardId === myCardId && r.type === 'amount');
}

// 当前卡年内的消费记录（刷免进度区间：自上个年费日起）
function cardYearRecordsOf(records, mc, now) {
  const start = U.cardYearStart(mc.feeMonth, mc.feeDay, now);
  const startStr = U.toDateStr(start);
  return records.amount.filter((r) => r.date >= startStr);
}

function waiverState(mc, now, recs) {
  const st = { needsPayment: true, kind: mc.waiverType, met: false, progress: 0, target: 0, remaining: 0, unit: '' };
  switch (mc.waiverType) {
    case '免年费':
      st.needsPayment = false; st.met = true; break;
    case '刚性':
      st.needsPayment = true; st.met = false; break;
    case '积分抵扣':
      st.needsPayment = !mc.pointsDeducted; st.met = !!mc.pointsDeducted;
      st.target = U.parseAmount(mc.waiverCondition); st.unit = '积分'; break;
    case '资产存免':
      st.needsPayment = !mc.assetWaived; st.met = !!mc.assetWaived;
      st.target = U.parseAmount(mc.waiverCondition); st.unit = '元'; break;
    case '消费刷免': {
      const target = U.parseAmount(mc.waiverCondition);
      const progress = cardYearRecordsOf(recs, mc, now).reduce((s, r) => s + (Number(r.amount) || 0), 0);
      st.target = target; st.progress = progress; st.unit = '元';
      st.met = progress >= target; st.needsPayment = !st.met;
      st.remaining = Math.max(0, target - progress);
      break;
    }
    case '笔数刷免': {
      const target = Math.round(U.parseAmount(mc.waiverCondition));
      const yearRecs = cardYearRecordsOf(recs, mc, now);
      const startStr = U.toDateStr(U.cardYearStart(mc.feeMonth, mc.feeDay, now));
      const countExtra = recs.count.filter((r) => r.date >= startStr).reduce((s, r) => s + (Number(r.count) || 0), 0);
      const progress = yearRecs.length + countExtra;
      st.target = target; st.progress = progress; st.unit = '笔';
      st.met = progress >= target; st.needsPayment = !st.met;
      st.remaining = Math.max(0, target - progress);
      break;
    }
    default: break;
  }
  return st;
}

function feeDaysColor(days, needsPayment) {
  if (!needsPayment) return 'default';
  if (days < 30) return 'red';
  if (days < 60) return 'yellow';
  return 'default';
}

// 已豁免卡的年费预警：无年费卡片显示「无年费」，其余显示达标来源
function feeAlertOfWaived(mc) {
  if (!(Number(mc.annualFee) > 0)) return '无年费';
  return '本年豁免';
}

function computeMyCard(mc, now, idx) {
  now = now || new Date();
  idx = idx || buildIndexes();
  const recs = idx.consByCard.get(mc.id) || { amount: [], count: [] };
  const monthStart = U.toDateStr(new Date(now.getFullYear(), now.getMonth(), 1));
  const yearStart = U.toDateStr(new Date(now.getFullYear(), 0, 1));
  const days = U.feeCountdown(mc.feeMonth, mc.feeDay, now);
  const ws = waiverState(mc, now, recs);
  const benefits = (mc.benefits || []).map((b, i) => {
    const u = benefitUsed(mc, i, now, idx);
    // 展开全部使用态：used / remaining / unlimited / expired / exhausted
    return { ...b, ...u };
  });
  const monthSpend = recs.amount.filter((r) => r.date >= monthStart).reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const yearSpend = recs.amount.filter((r) => r.date >= yearStart).reduce((s, r) => s + (Number(r.amount) || 0), 0);
  // 还款信息（宽限期 + 两种还款方式）与预警分级
  const payment = D.paymentInfo(mc, now);
  const feeStatus = feeStatusOf(mc, now, ws);
  const feeWaived = feeStatus !== '未达标';
  // 注意：nextFeeDate 是计算字段，必须先算出来再用于「距年费月数」
  const nextFeeDateStr = U.toDateStr(U.nextFeeDate(mc.feeMonth, mc.feeDay, now));
  const nextFee = new Date(nextFeeDateStr + 'T00:00:00');
  const feeMonthsLeft = isNaN(nextFee.getTime())
    ? null
    : (nextFee.getFullYear() - now.getFullYear()) * 12 + (nextFee.getMonth() - now.getMonth());
  // 年费预警分级基于「距下次年费日天数」（原始记录无 feeDays 字段，之前读 mc.feeDays 恒为 undefined → 预警恒「正常」）
  const feeDaysLeft = days;
  const feeAlert = feeWaived ? feeAlertOfWaived(mc) : D.feeAlertOf(mc, feeDaysLeft, false);
  return {
    ...mc,
    benefits,
    payment,
    feeStatus,
    feeAlert,
    feeMonthsLeft,
    // 合并账单：组名 + 组内是否为首位成员（负责汇总提醒），无组时为空
    billGroupId: mc.billGroupId || '',
    billGroupName: groupNameOf(mc.billGroupId),
    recent: recs.amount.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 5),
    monthSpend, yearSpend, totalSpend: recs.amount.reduce((s, r) => s + (Number(r.amount) || 0), 0),
    monthCount: recs.amount.filter((r) => r.date >= monthStart).length,
    yearCount: recs.amount.filter((r) => r.date >= yearStart).length,
    totalCount: recs.amount.length,
    monthProgress: mc.monthlySpendTarget > 0 ? Math.min(100, Math.round((monthSpend / mc.monthlySpendTarget) * 100)) : 0,
    feeDays: days,
    feeDaysColor: feeDaysColor(days, ws.needsPayment),
    nextFeeDate: nextFeeDateStr,
    waiver: ws,
  };
}

// computed 可传入已由 computeMyCard 算好的持卡列表（/api/mycards 场景），避免每张卡重复全量计算
function computeStats(now, idx, computed) {
  now = now || new Date();
  idx = idx || buildIndexes();
  const myCards = getMyCards();
  const banks = [...new Set(myCards.map((m) => m.bank))];
  const bankMax = {};
  for (const m of myCards) {
    const lim = Number(m.creditLimit) || 0;
    if (!(m.bank in bankMax) || lim > bankMax[m.bank]) bankMax[m.bank] = lim;
  }
  const monthStart = U.toDateStr(new Date(now.getFullYear(), now.getMonth(), 1));
  const yearStart = U.toDateStr(new Date(now.getFullYear(), 0, 1));
  let monthSpend = 0;
  let yearSpend = 0;
  for (const r of getConsumptions()) {
    if (r.type !== 'amount') continue;
    const a = Number(r.amount) || 0;
    if (r.date >= monthStart) monthSpend += a;
    if (r.date >= yearStart) yearSpend += a;
  }
  const feeExpiring = (computed || myCards.map((m) => computeMyCard(m, now, idx)))
    .filter((m) => m.waiver.needsPayment && m.feeDays < 30)
    .sort((a, b) => a.feeDays - b.feeDays)
    .map((m) => ({ id: m.id, name: m.alias || m.name, bank: m.bank, feeDays: m.feeDays, annualFee: m.annualFee }));
  return {
    totalCards: myCards.length,
    totalBanks: banks.length,
    maxCreditSum: Object.values(bankMax).reduce((s, v) => s + v, 0),
    monthSpend, yearSpend,
    feeExpiring,
  };
}

// ---------- 权益使用 ----------
// 记录归属判定：优先按稳定 id（bid）；无 bid 的历史记录按索引匹配（迁移后应已补齐）
function benefitRecords(idx, myCardId, benefitIdx, bid) {
  const m = idx.benByCard.get(myCardId);
  if (!m) return [];
  const out = [];
  if (bid) out.push(...(m.get('bid:' + bid) || []));
  // 兼容尚未迁移的历史记录（无 bid，只能按 idx 归属）
  for (const r of m.get('idx:' + benefitIdx) || []) if (!r.bid) out.push(r);
  return out;
}

function benefitUsed(mc, idx, now, index, bid) {
  now = now || new Date();
  const b = (mc.benefits || [])[idx];
  if (!b) return { used: 0, total: 0, exhausted: false, cycle: '自然月', missing: true };
  const start = U.cycleStart(b.resetCycle, mc.feeMonth, mc.feeDay, now);
  const startStr = U.toDateStr(start);
  const useBid = bid !== undefined ? bid : b.id;
  const index2 = index || buildIndexes();
  const recs = benefitRecords(index2, mc.id, idx, useBid).filter((r) => r.date >= startStr);
  const used = recs.filter((r) => r.type === 'usage').length
    + recs.filter((r) => r.type === 'count').reduce((s, r) => s + (Number(r.count) || 0), 0);
  const total = Number(b.total) || 0;
  const unlimited = total < 0;
  const expired = !!(b.validUntil && b.validUntil < U.todayStr());
  return {
    used,
    total,
    unlimited,
    expired,
    remaining: unlimited ? null : Math.max(0, total - used),
    exhausted: !unlimited && !expired && used >= total,
    cycle: b.resetCycle,
    cycleStart: startStr,
  };
}

function benefitHistory(mc, idx, bid, index) {
  const b = (mc.benefits || [])[idx];
  if (!b) return [];
  // 第四参可选：未传时兜底构建索引（保证旧式三参调用不报错），统一走 bid/idx 分桶索引查询
  const idx2 = index || buildIndexes();
  const recs = benefitRecords(idx2, mc.id, idx, bid !== undefined ? bid : b.id);
  const groups = new Map();
  for (const r of recs) {
    const key = U.cycleKeyOf(b.resetCycle, mc.feeMonth, mc.feeDay, r.date);
    if (!groups.has(key)) groups.set(key, { key, used: 0, records: [] });
    const g = groups.get(key);
    if (r.type === 'usage') { g.used += 1; g.records.push({ date: r.date, note: r.note || '', count: 1 }); }
    else { g.used += Number(r.count) || 0; g.records.push({ date: r.date, note: (r.note || '') + (r.note ? '，' : '') + '补录 ' + (Number(r.count) || 0) + ' 次', count: Number(r.count) || 0 }); }
  }
  return [...groups.values()].sort((a, b2) => (a.key < b2.key ? 1 : -1));
}

// ---------- HTTP 辅助 ----------
function json(obj, status, headers) {
  return { status: status || 200, body: obj, headers: headers || undefined };
}

function err(msg, status) { return json({ error: msg }, status || 400); }

function matchRoute(method, pathname) {
  const routes = [
    ['GET', /^\/api\/health$/],
    ['GET', /^\/api\/meta$/],
    ['GET', /^\/api\/settings$/],
    ['PUT', /^\/api\/settings$/],
    ['GET', /^\/api\/stats$/],
    ['GET', /^\/api\/cards$/],
    ['POST', /^\/api\/cards$/],
    ['POST', /^\/api\/cards\/import$/],
    ['GET', /^\/api\/cards\/export$/],
    ['PUT', /^\/api\/cards\/([^/]+)$/],
    ['DELETE', /^\/api\/cards\/([^/]+)$/],
    ['GET', /^\/api\/mycards\/export$/],
    ['POST', /^\/api\/mycards\/import$/],
    ['GET', /^\/api\/mycards\/template\.csv$/],
    ['POST', /^\/api\/mycards\/import-csv$/],
    ['GET', /^\/api\/mycards$/],
    ['POST', /^\/api\/mycards$/],
    ['PUT', /^\/api\/mycards\/([^/]+)$/],
    ['DELETE', /^\/api\/mycards\/([^/]+)$/],
    ['GET', /^\/api\/mycards\/([^/]+)\/consumptions$/],
    ['POST', /^\/api\/mycards\/([^/]+)\/consumptions$/],
    ['POST', /^\/api\/mycards\/([^/]+)\/consumptions\/count$/],
    ['DELETE', /^\/api\/mycards\/([^/]+)\/consumptions\/([^/]+)$/],
    ['GET', /^\/api\/mycards\/([^/]+)\/benefits\/(\d+)\/history$/],
    ['POST', /^\/api\/mycards\/([^/]+)\/benefits\/(\d+)\/usage$/],
    ['POST', /^\/api\/mycards\/([^/]+)\/benefits\/(\d+)\/count$/],
    ['POST', /^\/api\/mycards\/([^/]+)\/points$/],
    ['POST', /^\/api\/mycards\/([^/]+)\/asset$/],
    ['GET', /^\/api\/notify\/config$/],
    ['PUT', /^\/api\/notify\/config$/],
    ['POST', /^\/api\/notify\/test$/],
    ['POST', /^\/api\/notify\/check$/],
    ['GET', /^\/api\/notify\/history$/],
    ['GET', /^\/api\/calendar\.ics$/],
    ['GET', /^\/api\/bills$/],
    ['POST', /^\/api\/bills$/],
    ['PUT', /^\/api\/bills\/([^/]+)$/],
    ['DELETE', /^\/api\/bills\/([^/]+)$/],
    ['GET', /^\/api\/billgroups$/],
    ['POST', /^\/api\/billgroups$/],
    ['PUT', /^\/api\/billgroups\/([^/]+)$/],
    ['DELETE', /^\/api\/billgroups\/([^/]+)$/],
    ['POST', /^\/api\/mycards\/([^/]+)\/bills\/generate$/],
    ['POST', /^\/api\/shutdown$/],
  ];
  for (const [m, re] of routes) {
    if (m !== method) continue;
    const match = pathname.match(re);
    if (match) return match;
  }
  return null;
}

async function handle(method, pathname, url, body, req) {
  const match = matchRoute(method, pathname);
  if (!match) return undefined;
  const now = new Date();

  // ---- 基础 ----
  if (pathname === '/api/health') return json({ ok: true, version: '1.0.0', time: now.toISOString() });
  if (pathname === '/api/meta') return json({ channels: CHANNELS, categories: CATEGORIES, waiverTypes: WAIVER_TYPES, resetCycles: RESET_CYCLES, benefitTypes: BENEFIT_TYPES, csvHeader: CSV_HEADER, mycardsCsvHeader: MYCARD_CSV_HEADER, maxImportCards: MAX_IMPORT_CARDS });
  if (pathname === '/api/shutdown') {
    // 需要鉴权（由 index.js 的 auth.guard 保证）；此处再加一层同源校验，
    // 阻断「隐藏表单 POST 到 /api/shutdown」这类 CSRF（GET/跨站来源一律拒绝）
    if (req && !require('./auth').sameOrigin(req)) {
      return err('拒绝跨站请求', 403);
    }
    return { shutdown: true };
  }

  // ---- 设置 ----
  if (pathname === '/api/settings' && method === 'GET') return json(store.readObject('settings', {}));
  if (pathname === '/api/settings' && method === 'PUT') {
    const cur = store.readObject('settings', {});
    const patch = body || {};
    const allowed = ['theme', 'bankOrder', 'banksCollapsed', 'cardBanksCollapsed'];
    for (const k of allowed) if (k in patch) cur[k] = patch[k];
    store.write('settings', cur);
    return json(cur);
  }

  // ---- 统计 ----
  if (pathname === '/api/stats') return json(computeStats(now, null, null));

  // ---- 卡种库 ----
  if (pathname === '/api/cards' && method === 'GET') {
    return json(getCards());
  }
  if (pathname === '/api/cards' && method === 'POST') {
    const c = normalizeCard(body || {}, null);
    if (!c.bank || !c.name) return err('银行和卡片名称必填');
    const cards = getCards();
    if (cards.some((x) => cardKey(x) === cardKey(c))) return err('已存在相同「银行 + 卡片名称 + 卡组织 + 卡等级」的卡种，请修改卡片名称');
    cards.push(c);
    store.write('cards', cards);
    return json(c, 201);
  }
  if (pathname === '/api/cards/import' && method === 'POST') {
    const text = typeof body === 'string' ? body : (body && body.csv) || '';
    if (!text.trim()) return err('CSV 内容为空');
    const rows = U.parseCSV(text);
    if (rows.length < 2) return err('CSV 只有表头或无数据行');
    const cards = getCards();
    const keys = new Set(cards.map(cardKey));
    const fileKeys = new Set();
    let added = 0;
    const skipped = [];
    const errors = [];
    rows.slice(1).forEach((row, i) => {
      const lineNo = i + 2;
      const raw = {};
      CSV_HEADER.forEach((h, ci) => { raw[CARD_FIELDS[ci]] = (row[ci] == null ? '' : String(row[ci])).trim(); });
      if (!raw.bank || !raw.name) { errors.push({ line: lineNo, msg: '银行或卡片名称为空' }); return; }
      const c = normalizeCard(raw, null);
      const k = cardKey(c);
      if (keys.has(k) || fileKeys.has(k)) { skipped.push({ line: lineNo, name: raw.name, msg: '已存在，自动跳过' }); return; }
      fileKeys.add(k);
      keys.add(k);
      cards.push(c);
      added++;
    });
    store.write('cards', cards);
    return json({ added, skipped, errors, total: cards.length });
  }
  if (pathname === '/api/cards/export' && method === 'GET') {
    const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
    const myCards = getMyCards();
    const selected = ids.length ? myCards.filter((m) => ids.includes(m.id)) : myCards;
    const seen = new Set();
    const rows = [CSV_HEADER];
    for (const m of selected) {
      if (seen.has(m.cardId)) continue;
      seen.add(m.cardId);
      const c = getCards().find((x) => x.id === m.cardId) || {};
      rows.push([c.bank || m.bank, c.name || m.name, c.level || '', c.org || '', c.annualFee || 0, c.waiverType || '', c.waiverCondition || '', c.waiverPolicy || '', c.startCredit || 0, (c.benefits || []).join('|'), c.applyCondition || '', c.note || '']);
    }
    return { csv: U.toCSV(rows) };
  }
  const cardMatch = pathname.match(/^\/api\/cards\/([^/]+)$/);
  if (cardMatch && method === 'PUT') {
    const cards = getCards();
    const idx = cards.findIndex((c) => c.id === cardMatch[1]);
    if (idx < 0) return err('卡种不存在', 404);
    const merged = { ...cards[idx], ...(body || {}) };
    const c = normalizeCard(merged, cards[idx].id);
    if (cards.some((x, i) => i !== idx && cardKey(x) === cardKey(c))) return err('已存在相同「银行 + 卡片名称 + 卡组织 + 卡等级」的卡种');
    cards[idx] = c;
    store.write('cards', cards);
    // 同步持卡快照
    syncMyCardSnapshots();
    return json(c);
  }
  if (cardMatch && method === 'DELETE') {
    let cards = getCards();
    if (!cards.some((c) => c.id === cardMatch[1])) return err('卡种不存在', 404);
    cards = cards.filter((c) => c.id !== cardMatch[1]);
    store.write('cards', cards);
    return json({ ok: true });
  }

  // ---- 我的持卡 ----
  // 持卡备份导出：全量字段 JSON（含卡种快照、权益、消费/权益记录），供备份与跨实例迁移。
  // 注意与 /api/cards/export（CSV，只含卡种库展示字段）的区别：那是「导出表格」，
  // 这个是「数据备份」——两者并存服务不同场景。
  if (pathname === '/api/mycards/export' && method === 'GET') {
    const myCards = getMyCards();
    const myIds = new Set(myCards.map((m) => m.id));
    const cards = getCards();
    // 卡种只导出「被持卡引用」的，未引用的卡种（含内置种子库）不属于个人数据
    const usedCardIds = new Set(myCards.map((m) => m.cardId));
    const payload = {
      schema: 'guanka-backup',
      version: 1,
      exportedAt: now.toISOString(),
      cardTypes: cards.filter((c) => usedCardIds.has(c.id)),
      myCards,
      consumptions: getConsumptions().filter((r) => myIds.has(r.myCardId)),
      benefitRecords: getBenefits().filter((r) => myIds.has(r.myCardId)),
      billGroups: getBillGroups(),
      bills: getBills().filter((b) => myIds.has(b.myCardId)),
    };
    const filename = 'guanka-backup-' + U.todayStr() + '.json';
    // no-store：备份含个人金融数据，禁止被浏览器/代理/CDN 缓存。
    // body 传预序列化字符串：send() 对字符串直接透传，避免大对象被二次 stringify
    const payloadJson = JSON.stringify(payload);
    return json(payloadJson, 200, {
      'Content-Type': 'application/json; charset=utf-8', // send() 对字符串默认 text/plain，需显式覆盖
      'Content-Disposition': 'attachment; filename="' + filename + '"',
      'Cache-Control': 'no-store',
    });
  }
  // 持卡备份导入：两种模式——
  //  merge（默认）：按 id 去重追加新记录，已存在的持卡/记录原样保留（适合备份恢复进现有实例）；
  //  replace：先清空现有持卡数据再全量写入（适合迁移/回滚，调用方需明确传 mode）。
  // 卡种按（银行|名称|组织|等级）四元组匹配已有库，匹配不上则自动创建新卡种。
  if (pathname === '/api/mycards/import' && method === 'POST') {
    const b = body && typeof body === 'object' ? body : {};
    const data = b.data && typeof b.data === 'object' ? b.data : b;
    if (data.schema !== 'guanka-backup') return err('不是有效的管卡备份文件（缺少 schema 标识）');
    if (!Array.isArray(data.myCards)) return err('备份文件缺少 myCards 数据');
    if (data.myCards.length > MAX_IMPORT_CARDS) return err('备份包含 ' + data.myCards.length + ' 张持卡，超出单次导入上限 ' + MAX_IMPORT_CARDS);
    // 明细记录（消费/权益/账单/卡种/组）总条数上限：防止单类缺省时在其余字段塞海量数据
    for (const k of ['cardTypes', 'consumptions', 'benefitRecords', 'billGroups', 'bills']) {
      if (Array.isArray(data[k]) && data[k].length > MAX_IMPORT_RECORDS) {
        return err('备份 ' + k + ' 含 ' + data[k].length + ' 条记录，超出单次导入上限 ' + MAX_IMPORT_RECORDS);
      }
    }

    const mode = b.mode === 'replace' ? 'replace' : 'merge';
    const cards = getCards();
    const cardByKey = new Map(cards.map((c) => [cardKey(c), c]));
    const cardById = new Map(cards.map((c) => [c.id, c]));

    // —— 卡种映射/补建 ——
    let cardTypesAdded = 0;
    const importedCardTypes = [];
    for (const c of Array.isArray(data.cardTypes) ? data.cardTypes : []) {
      const key = cardKey(c || {});
      if (!key.split('|').some(Boolean)) continue; // 银行名称全空的垃圾行跳过
      const exist = cardByKey.get(key);
      if (exist) { importedCardTypes.push({ srcId: String(c.id || ''), dstId: exist.id }); continue; }
      const created = normalizeCard(c, null);
      cards.push(created);
      cardByKey.set(key, created);
      cardById.set(created.id, created);
      importedCardTypes.push({ srcId: String(c.id || ''), dstId: created.id });
      cardTypesAdded++;
    }
    // srcCardId → 本库 cardId 的映射（同卡种多条映射取首个）
    const cardIdMap = new Map();
    for (const m of importedCardTypes) {
      if (m.srcId && !cardIdMap.has(m.srcId)) cardIdMap.set(m.srcId, m.dstId);
    }

    // —— 记录 id 池（merge 模式下用于「已存在即跳过」的幂等判断；replace 模式现有数据即将清空）——
    const existingMyIds = new Set(mode === 'merge' ? getMyCards().map((m) => m.id) : []);
    const existingConsIds = new Set(mode === 'merge' ? getConsumptions().map((r) => r.id) : []);
    const existingBenIds = new Set(mode === 'merge' ? getBenefits().map((r) => r.id) : []);

    // —— 持卡归一 ——
    // 备份里的持卡是已归一过的记录，但仍要走一遍防御性归一：
    // 一是兼容旧版本字段差异，二是防手改备份文件注入非法值。
    const nowDate = now;
    const safeMyCards = [];
    const myIdMap = new Map(); // 备份 id → 新 id（消费/权益记录外键引用需要）
    const srcGroupById = new Map(); // 新持卡 id → 备份里的 billGroupId（组归属回填用）
    let dedupedCards = 0; // merge 模式下「id 已存在」被整体跳过的持卡数（幂等恢复：卡跳过则其记录一并跳过）
    let skippedNoId = 0;  // 非对象/无有效 id 且卡种匹配失败的持卡数（与 dedupedCards 区分口径）
    for (const m of data.myCards) {
      if (!m || typeof m !== 'object') continue;
      // 卡种映射：优先四元组匹配（导出→导入的正规路径）；备份 cardId 直接命中本库
      // 已有卡种时也可用（手工构造的备份）。注意 cardId 命中的必须是「本次备份卡种
      // 之外」的既有卡种——若备份里同一 srcId 对应多个不同四元组，直接命中会张冠李戴，
      // 故已走四元组映射的 srcId 不再参与兜底（cardIdMap 里已有首匹配）。
      const srcId = String(m.cardId || '');
      const dstCardId = cardIdMap.get(srcId) || cardById.get(srcId);
      const card = dstCardId ? cardById.get(dstCardId) : null;
      if (!card) { skippedNoId++; continue; }
      // merge 幂等：同 id 持卡已存在 → 视为「库里已有该卡及其数据」，整卡连记录跳过，
      // 保证同一份备份重复恢复不会产生重复数据
      if (mode === 'merge' && typeof m.id === 'string' && m.id && existingMyIds.has(m.id)) {
        dedupedCards++;
        continue;
      }
      const fee = U.clampFeeDate(m.feeMonth, m.feeDay);
      const repayMode = m.repayMode === 'afterBill' ? 'afterBill' : 'fixed';
      const newId = (typeof m.id === 'string' && m.id) ? m.id : U.uid();
      existingMyIds.add(newId);
      myIdMap.set(String(m.id || newId), newId);
      srcGroupById.set(newId, String(m.billGroupId || ''));
      const mc = {
        id: newId,
        cardId: card.id,
        bank: card.bank, name: card.name, org: card.org, level: card.level,
        annualFee: card.annualFee, waiverType: card.waiverType, waiverCondition: card.waiverCondition, waiverPolicy: card.waiverPolicy,
        alias: String(m.alias || '').trim(),
        creditLimit: nonNeg(m.creditLimit, card.startCredit),
        billingDay: clampDay(m.billingDay, 1),
        repaymentDay: repayMode === 'fixed' ? Math.min(31, Math.max(1, clampDay(m.repaymentDay, 20))) : clampDay(m.repaymentDay, 20),
        repayMode,
        repayValue: m.repayValue != null ? Math.max(0, Math.min(365, Math.round(Number(m.repayValue) || 0))) : clampDay(m.repaymentDay, 20),
        graceDays: m.graceDays != null ? Math.max(0, Math.min(30, Math.round(Number(m.graceDays) || 0))) : 3,
        waivedYear: Math.max(0, Math.round(Number(m.waivedYear) || 0)),
        countPeriodYear: Math.max(0, Math.round(Number(m.countPeriodYear) || 0)),
        maxInterestDays: Math.max(0, Math.min(120, Math.round(Number(m.maxInterestDays) || 0))),
        feeMonth: fee.m,
        feeDay: fee.d,
        last4: String(m.last4 || '').replace(/\D/g, '').slice(0, 4),
        monthlySpendTarget: nonNeg(m.monthlySpendTarget, 0),
        // 权益沿用备份里的稳定 id（消费/权益记录按 bid 归属），缺失时补新 id
        benefits: normalizeBenefits(Array.isArray(m.benefits) ? m.benefits : [], card.benefits),
        pointsDeducted: !!m.pointsDeducted,
        pointsDeductDate: m.pointsDeducted && U.parseDateStr(m.pointsDeductDate) ? String(m.pointsDeductDate) : (m.pointsDeducted ? U.todayStr() : null),
        assetWaived: !!m.assetWaived,
        assetWaivedDate: m.assetWaived && U.parseDateStr(m.assetWaivedDate) ? String(m.assetWaivedDate) : (m.assetWaived ? U.todayStr() : null),
        billGroupId: '',
        createdAt: U.parseDateStr(String(m.createdAt || '').slice(0, 10)) ? String(m.createdAt) : nowDate.toISOString(),
      };
      safeMyCards.push(mc);
    }
    if (!safeMyCards.length && !dedupedCards) return err('备份中没有可导入的持卡（卡种匹配全部失败）');

    // —— 合并账单组（备份里的组先重建，成员引用在下面按备份 billGroupId 关联）——
    const groups = mode === 'merge' ? getBillGroups() : [];
    const groupIdMap = new Map(); // 备份组 id → 新/现有组
    for (const g of Array.isArray(data.billGroups) ? data.billGroups : []) {
      if (!g || !g.name) continue;
      // 备份组在本库已存在同名组 → 沿用；否则重建（保持名称）。
      // 成员归属与节奏校验统一在「组归属回填」阶段按 safeMyCards 实际结果做。
      const exist = groups.find((x) => x.name === g.name);
      if (exist) { groupIdMap.set(String(g.id), exist.id); continue; }
      const newId = (typeof g.id === 'string' && g.id && !groups.some((x) => x.id === g.id)) ? g.id : U.uid();
      groups.push({ id: newId, name: g.name, createdAt: U.parseDateStr(String(g.createdAt || '').slice(0, 10)) ? String(g.createdAt) : nowDate.toISOString() });
      groupIdMap.set(String(g.id), newId);
    }

    // —— 组归属回填：组内卡必须同还款节奏，与 UI 创建逻辑一致 ——
    const groupMembers = new Map();
    for (const mc of safeMyCards) {
      const gRaw = srcGroupById.get(mc.id) || '';
      if (!gRaw || !groupIdMap.has(gRaw)) continue;
      const gid = groupIdMap.get(gRaw);
      mc.billGroupId = gid;
      if (!groupMembers.has(gid)) groupMembers.set(gid, []);
      groupMembers.get(gid).push(mc);
    }
    // 组内校验还款节奏：以首张卡为基准逐一比对，不一致的成员移出组（保留卡，不整组拒绝）。
    // 基准 members[0] 在循环内不会被移出，A-B-A 场景下两张 A 卡节奏一致都会保留。
    const groupErrs = [];
    for (const members of groupMembers.values()) {
      if (members.length < 2) { for (const m of members) m.billGroupId = ''; continue; }
      for (let i = 1; i < members.length; i++) {
        if (!sameRepaySchedule(members[0], members[i], now)) {
          groupErrs.push('「' + (members[i].alias || members[i].name) + '」与「' + (members[0].alias || members[0].name) + '」还款日不一致，已移出账单组');
          members[i].billGroupId = '';
        }
      }
    }
    // 清理空组：校验后成员不足 2 的组解散。
    // merge 模式：本次导入的卡若被移出组，其原组可能只剩 1 个成员（另一张是库里的旧卡），
    // 此时也该解散——需要按「库中旧卡 + 本次新卡」的合并视图算成员数。
    const aliveGroups = new Set(safeMyCards.map((m) => m.billGroupId).filter(Boolean));
    const finalGroups = mode === 'merge'
      ? groups.filter((g) => {
          if (!aliveGroups.has(g.id)) return false;
          // 组内成员 = 本次新卡 + 库中仍指向该组的旧卡；不足 2 解散
          const oldMembers = getMyCards().filter((m) => m.billGroupId === g.id && !safeMyCards.some((x) => x.id === m.id));
          const newMembers = safeMyCards.filter((m) => m.billGroupId === g.id);
          return oldMembers.length + newMembers.length >= 2;
        })
      : groups.filter((g) => aliveGroups.has(g.id));

    // —— 消费记录（merge 幂等：id 已存在的记录跳过）——
    const safeCons = [];
    for (const r of Array.isArray(data.consumptions) ? data.consumptions : []) {
      if (!r || typeof r !== 'object') continue;
      if (mode === 'merge' && typeof r.id === 'string' && r.id && existingConsIds.has(r.id)) continue;
      const newMyId = myIdMap.get(String(r.myCardId || ''));
      if (!newMyId) continue;
      const newId = (typeof r.id === 'string' && r.id) ? r.id : U.uid();
      existingConsIds.add(newId);
      const amount = Number(r.amount);
      // 金额必须 > 0（与手工记账 POST /consumptions 口径一致）：count 型无金额豁免，
      // amount 型 0/负数/非数值是垃圾数据，跳过而不是落库
      if (r.type !== 'count' && (!isFinite(amount) || amount <= 0)) continue;
      safeCons.push({
        id: newId,
        myCardId: newMyId,
        type: r.type === 'count' ? 'count' : 'amount',
        date: U.parseDateStr(r.date) ? String(r.date) : U.todayStr(),
        amount: isFinite(amount) ? Math.max(0, Math.min(MAX_MONEY, Math.round(amount * 100) / 100)) : 0,
        count: validCount(r.count) || 0,
        channel: CHANNELS.includes(r.channel) ? r.channel : CHANNELS[0],
        category: CATEGORIES.includes(r.category) ? r.category : '其他',
        note: String(r.note || '').trim(),
        createdAt: U.parseDateStr(String(r.createdAt || '').slice(0, 10)) ? String(r.createdAt) : nowDate.toISOString(),
      });
    }

    // —— 权益使用记录（merge 幂等：id 已存在的记录跳过）——
    const safeBens = [];
    for (const r of Array.isArray(data.benefitRecords) ? data.benefitRecords : []) {
      if (!r || typeof r !== 'object') continue;
      if (mode === 'merge' && typeof r.id === 'string' && r.id && existingBenIds.has(r.id)) continue;
      const newMyId = myIdMap.get(String(r.myCardId || ''));
      if (!newMyId) continue;
      const mc = safeMyCards.find((x) => x.id === newMyId);
      // bid 必须能在该卡的权益列表里找到，否则记录无处归属（UI 上永远查不到）
      const bidOk = r.bid && mc && (mc.benefits || []).some((x) => x.id === r.bid);
      if (!bidOk) continue;
      const newId = (typeof r.id === 'string' && r.id) ? r.id : U.uid();
      existingBenIds.add(newId);
      safeBens.push({
        id: newId,
        myCardId: newMyId,
        idx: Math.max(0, Math.round(Number(r.idx) || 0)),
        bid: String(r.bid),
        type: r.type === 'count' ? 'count' : 'usage',
        date: U.parseDateStr(r.date) ? String(r.date) : U.todayStr(),
        count: validCount(r.count) || 0,
        note: String(r.note || '').trim(),
        createdAt: U.parseDateStr(String(r.createdAt || '').slice(0, 10)) ? String(r.createdAt) : nowDate.toISOString(),
      });
    }

    // —— 账单 ——
    // merge 幂等键 1：(卡, 月份) 唯一——同卡同月只留一条（与手工记账约束一致）
    const existingBillKeys = mode === 'merge'
      ? new Set(getBills().map((x) => x.myCardId + '|' + x.month))
      : new Set();
    // merge 幂等键 2：主键 id 不撞车（消费/权益有 existing 预检，账单此前遗漏——
    // merge 新卡时若备份账单 id 恰与库中已有账单相同，会写出重复主键）
    const existingBillIds = new Set(mode === 'merge' ? getBills().map((x) => x.id) : []);
    const safeBills = [];
    for (const r of Array.isArray(data.bills) ? data.bills : []) {
      if (!r || typeof r !== 'object') continue;
      const newMyId = myIdMap.get(String(r.myCardId || ''));
      if (!newMyId) continue;
      if (!/^\d{4}-\d{2}$/.test(String(r.month || ''))) continue;
      const key = newMyId + '|' + r.month;
      if (existingBillKeys.has(key)) continue; // 该卡该月账单已存在，跳过
      existingBillKeys.add(key);
      const amount = Number(r.amount);
      const newId = (typeof r.id === 'string' && r.id && !existingBillIds.has(r.id)) ? r.id : U.uid();
      existingBillIds.add(newId);
      safeBills.push({
        id: newId,
        myCardId: newMyId,
        month: String(r.month),
        amount: isFinite(amount) ? Math.max(0, Math.min(MAX_MONEY, Math.round(amount * 100) / 100)) : 0,
        dueDate: U.parseDateStr(r.dueDate) ? String(r.dueDate) : '',
        paid: r.paid === '已还' ? '已还' : '未还',
        paidDate: U.parseDateStr(r.paidDate) ? String(r.paidDate) : '',
        note: String(r.note || '').trim(),
        createdAt: U.parseDateStr(String(r.createdAt || '').slice(0, 10)) ? String(r.createdAt) : nowDate.toISOString(),
      });
    }

    // —— 落库 ——
    if (mode === 'replace') {
      store.write('mycards', safeMyCards);
      store.write('consumptions', safeCons);
      store.write('benefits', safeBens);
      store.write('bills', safeBills);
      store.write('billGroups', finalGroups);
    } else {
      const myCards = getMyCards();
      // merge 模式再防一手 id 撞车（前面 existingMyIds 已排除，这里双保险重建数组）
      const have = new Set(myCards.map((m) => m.id));
      for (const mc of safeMyCards) if (!have.has(mc.id)) myCards.push(mc);
      store.write('mycards', myCards);
      const cons = getConsumptions().concat(safeCons);
      store.write('consumptions', cons);
      const bens = getBenefits().concat(safeBens);
      store.write('benefits', bens);
      const bills = getBills().concat(safeBills);
      store.write('bills', bills);
      store.write('billGroups', finalGroups);
    }
    store.write('cards', cards);
    cleanBillGroups();

    return json({
      ok: true,
      mode,
      importedCards: safeMyCards.length,
      // skippedCards = 既没导入也没幂等跳过的部分（卡种匹配失败/垃圾行），
      // 不含 dedupedCards——否则重复导入时前端会把「已存在跳过」误标为「卡种匹配失败」
      skippedCards: (Array.isArray(data.myCards) ? data.myCards.length : 0)
        - safeMyCards.length - dedupedCards - skippedNoId,
      dedupedCards,
      cardTypesAdded,
      consumptions: safeCons.length,
      benefitRecords: safeBens.length,
      bills: safeBills.length,
      billGroups: finalGroups.length,
      groupWarnings: groupErrs,
    }, 200);
  }

  // ---- 「我的持卡」批量导入 CSV ----
  // 模板下载：只给表头 + 两行示例，示例行由前端提示「可删除」，服务端不特殊处理。
  // BOM 与 \r\n 由 U.toCSV 统一产出（Excel/Windows 双击打开才不乱码）——此处**不要**再补 BOM，
  // 否则文件头会出现两个 EF BB BF，部分老版本 Excel 会把首个单元格读成乱码。
  if (pathname === '/api/mycards/template.csv' && method === 'GET') {
    const rows = [MYCARD_CSV_HEADER, ...MYCARD_CSV_SAMPLES];
    const csv = U.toCSV(rows);
    return {
      csv,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="mycards-template.csv"',
        'Cache-Control': 'no-store',
      },
    };
  }

  // 持卡 CSV 导入：与卡种 CSV 导入（/api/cards/import）同构，但落的是「我的持卡」。
  // 卡种匹配规则：按 银行+名称+卡组织+卡等级 四元组在卡种库里找；找不到则自动补建卡种
  // （与 JSON 备份恢复的兜底策略一致，避免用户因为卡种库里缺一张卡就整行导入失败）。
  if (pathname === '/api/mycards/import-csv' && method === 'POST') {
    const text = typeof body === 'string' ? body : (body && body.csv) || '';
    if (!text.trim()) return err('CSV 内容为空');
    const rows = U.parseCSV(text);
    if (rows.length < 2) return err('CSV 只有表头或无数据行');
    if (rows.length - 1 > MAX_IMPORT_CARDS) return err('CSV 含 ' + (rows.length - 1) + ' 行持卡，超出单次导入上限 ' + MAX_IMPORT_CARDS);

    const cards = getCards();
    const cardByKey = new Map(cards.map((c) => [cardKey(c), c]));
    const myCards = getMyCards();
    const added = [];
    const skipped = [];
    const errors = [];
    let cardTypesAdded = 0;

    rows.slice(1).forEach((row, i) => {
      const lineNo = i + 2;
      const raw = {};
      MYCARD_CSV_HEADER.forEach((h, ci) => { raw[MYCARD_FIELDS[ci]] = (row[ci] == null ? '' : String(row[ci])).trim(); });
      if (!raw.bank || !raw.name) { errors.push({ line: lineNo, msg: '银行或卡片名称为空' }); return; }

      // 1) 匹配卡种；缺失则自动建一个只有四元组 + 兜底值的卡种
      const wantKey = [raw.bank, raw.name, raw.org, raw.level].join('|');
      let card = cardByKey.get(wantKey);
      if (!card) {
        card = normalizeCard({ bank: raw.bank, name: raw.name, org: raw.org, level: raw.level }, null);
        cards.push(card);
        cardByKey.set(wantKey, card);
        cardTypesAdded++;
      }

      // 2) 同一张卡（同 cardId + 同后四位）已存在 → 跳过，保证重复导入幂等
      const last4 = raw.last4.replace(/\D/g, '').slice(0, 4);
      if (myCards.some((m) => m.cardId === card.id && String(m.last4 || '') === last4)) {
        skipped.push({ line: lineNo, name: raw.name, msg: last4 ? '同卡同后四位已存在' : '同卡已存在（未填后四位）' });
        return;
      }

      // 3) 组装持卡（字段归一与 POST /api/mycards 完全一致，避免两条路径产出不同结构）
      const fee = U.clampFeeDate(raw.feeMonth, raw.feeDay);
      const repayMode = /账单日后/.test(raw.repayMode) ? 'afterBill' : 'fixed';
      const repayValue = clampDay(raw.repayValue, 20);
      const mc = {
        id: U.uid(),
        cardId: card.id,
        bank: card.bank, name: card.name, org: card.org, level: card.level,
        annualFee: card.annualFee, waiverType: card.waiverType, waiverCondition: card.waiverCondition, waiverPolicy: card.waiverPolicy,
        alias: raw.alias,
        creditLimit: nonNeg(U.parseAmount(raw.creditLimit), card.startCredit),
        billingDay: clampDay(raw.billingDay, 1),
        repaymentDay: repayMode === 'fixed' ? Math.min(31, Math.max(1, repayValue || 20)) : clampDay(raw.repayValue, 20),
        repayMode,
        repayValue,
        graceDays: Math.max(0, Math.min(30, Math.round(Number(raw.graceDays) || 0))),
        waivedYear: Math.max(0, Math.round(Number(raw.waivedYear) || 0)),
        countPeriodYear: Math.max(0, Math.round(Number(raw.countPeriodYear) || 0)),
        maxInterestDays: Math.max(0, Math.min(120, Math.round(Number(raw.maxInterestDays) || 0))),
        feeMonth: fee.m,
        feeDay: fee.d,
        last4,
        monthlySpendTarget: nonNeg(U.parseAmount(raw.monthlySpendTarget), 0),
        benefits: parseBenefitSpec(raw.benefits, card.benefits),
        pointsDeducted: false, pointsDeductDate: null,
        assetWaived: false, assetWaivedDate: null,
        billGroupId: '',
        createdAt: now.toISOString(),
      };
      myCards.push(mc);
      added.push({ line: lineNo, name: card.name, bank: card.bank, id: mc.id });
    });

    if (added.length && cardTypesAdded) store.write('cards', cards);
    if (added.length) store.write('mycards', myCards);
    return json({ added: added.length, skipped, errors, cardTypesAdded, total: myCards.length });
  }
  if (pathname === '/api/mycards' && method === 'GET') {
    const idx = buildIndexes();
    const data = getMyCards().map((m) => computeMyCard(m, now, idx));
    // 与统计合并返回，复用已计算的持卡列表（此前 computeStats 内部对每张卡再跑一遍完整计算，全量开销翻倍）
    return json({
      data,
      stats: computeStats(now, idx, data),
      banks: [...new Set(data.map((m) => m.bank))],
      billGroups: getBillGroups(),
    });
  }
  if (pathname === '/api/mycards' && method === 'POST') {
    const b = body || {};
    if (!b.cardId) return err('缺少 cardId');
    const card = getCards().find((c) => c.id === b.cardId);
    if (!card) return err('卡种不存在', 404);
    const fee = U.clampFeeDate(b.feeMonth, b.feeDay);
    // 还款方式：fixed=每月固定日 / afterBill=账单日后 N 天（老数据 repaymentDay 自动迁移为 fixed）
    const repayMode = b.repayMode === 'afterBill' ? 'afterBill' : 'fixed';
    const repayValue = b.repayValue != null
      ? Math.max(0, Math.min(365, Math.round(Number(b.repayValue) || 0)))
      : clampDay(b.repaymentDay, 20);
    const mc = {
      id: U.uid(),
      cardId: card.id,
      bank: card.bank, name: card.name, org: card.org, level: card.level,
      annualFee: card.annualFee, waiverType: card.waiverType, waiverCondition: card.waiverCondition, waiverPolicy: card.waiverPolicy,
      alias: String(b.alias || '').trim(),
      creditLimit: nonNeg(b.creditLimit, card.startCredit),
      billingDay: clampDay(b.billingDay, 1),
      repaymentDay: repayMode === 'fixed' ? Math.min(31, Math.max(1, repayValue || 20)) : clampDay(b.repaymentDay, 20),
      repayMode,
      repayValue,
      graceDays: b.graceDays != null ? Math.max(0, Math.min(30, Math.round(Number(b.graceDays) || 0))) : 3,
      waivedYear: Math.max(0, Math.round(Number(b.waivedYear) || 0)),
      countPeriodYear: Math.max(0, Math.round(Number(b.countPeriodYear) || 0)),
      maxInterestDays: Math.max(0, Math.min(120, Math.round(Number(b.maxInterestDays) || 0))),
      feeMonth: fee.m,
      feeDay: fee.d,
      last4: String(b.last4 || '').replace(/\D/g, '').slice(0, 4),
      monthlySpendTarget: nonNeg(b.monthlySpendTarget, 0),
      benefits: normalizeBenefits(b.benefits, card.benefits),
      pointsDeducted: false, pointsDeductDate: null,
      assetWaived: false, assetWaivedDate: null,
      billGroupId: String(b.billGroupId || ''),
      createdAt: now.toISOString(),
    };
    // 合并账单：组内必须同一还款节奏（策略③），任何一张卡改还款方式都不得破坏组
    const gErr = groupAssignError(getMyCards(), mc, mc.billGroupId, now);
    if (gErr) return err(gErr);
    const myCards = getMyCards();
    myCards.push(mc);
    store.write('mycards', myCards);
    return json(computeMyCard(mc, now), 201);
  }
  const mcMatch = pathname.match(/^\/api\/mycards\/([^/]+)$/);
  if (mcMatch && method === 'PUT') {
    const myCards = getMyCards();
    const i = myCards.findIndex((m) => m.id === mcMatch[1]);
    if (i < 0) return err('持卡不存在', 404);
    const b = body || {};
    const cur = myCards[i];
    const fee = (b.feeMonth != null || b.feeDay != null)
      ? U.clampFeeDate(b.feeMonth != null ? b.feeMonth : cur.feeMonth, b.feeDay != null ? b.feeDay : cur.feeDay)
      : { m: cur.feeMonth, d: cur.feeDay };
    const repayMode = b.repayMode === 'afterBill' ? 'afterBill' : (b.repayMode === 'fixed' ? 'fixed' : (cur.repayMode || 'fixed'));
    const repayValue = b.repayValue != null
      ? Math.max(0, Math.min(365, Math.round(Number(b.repayValue) || 0)))
      : (b.repaymentDay != null ? clampDay(b.repaymentDay, 20) : (cur.repayValue != null ? cur.repayValue : cur.repaymentDay || 20));
    const updated = {
      ...cur,
      alias: String(b.alias != null ? b.alias : cur.alias).trim(),
      creditLimit: b.creditLimit != null ? nonNeg(b.creditLimit, 0) : cur.creditLimit,
      billingDay: b.billingDay != null ? clampDay(b.billingDay, 1) : cur.billingDay,
      repayMode,
      repayValue,
      repaymentDay: repayMode === 'fixed' ? Math.min(31, Math.max(1, repayValue || 20)) : cur.repaymentDay,
      graceDays: b.graceDays != null ? Math.max(0, Math.min(30, Math.round(Number(b.graceDays) || 0))) : (cur.graceDays || 0),
      waivedYear: b.waivedYear != null ? Math.max(0, Math.round(Number(b.waivedYear) || 0)) : (cur.waivedYear || 0),
      countPeriodYear: b.countPeriodYear != null ? Math.max(0, Math.round(Number(b.countPeriodYear) || 0)) : (cur.countPeriodYear || 0),
      maxInterestDays: b.maxInterestDays != null ? Math.max(0, Math.min(120, Math.round(Number(b.maxInterestDays) || 0))) : (cur.maxInterestDays || 0),
      feeMonth: fee.m,
      feeDay: fee.d,
      last4: b.last4 != null ? String(b.last4).replace(/\D/g, '').slice(0, 4) : cur.last4,
      monthlySpendTarget: b.monthlySpendTarget != null ? nonNeg(b.monthlySpendTarget, 0) : cur.monthlySpendTarget,
      billGroupId: b.billGroupId != null ? String(b.billGroupId) : (cur.billGroupId || ''),
    };
    // 合并账单一致性（策略③）：无论是改本卡还款日、还是把卡挪进/挪出某个组，
    // 都要以「改完之后」的状态重新校验，避免组内出现两个还款节奏
    const gErr = groupAssignError(myCards.filter((x) => x.id !== cur.id).concat([updated]), updated, updated.billGroupId, now);
    if (gErr) return err(gErr);
    if (b.benefits !== undefined) {
      updated.benefits = normalizeBenefits(b.benefits, []);
      // 权益被移除后，其使用记录按 id 归属已无人可展示（历史与次数都查不到），
      // 留着只会随每次编辑无限累积，这里随权益列表一起清理
      const kept = new Set(updated.benefits.map((x) => x.id));
      const recs = getBenefits();
      const remain = recs.filter((r) => !(r.myCardId === cur.id && r.bid && !kept.has(r.bid)));
      if (remain.length !== recs.length) store.write('benefits', remain);
    }
    myCards[i] = updated;
    store.write('mycards', myCards);
    return json(computeMyCard(updated, now));
  }
  if (mcMatch && method === 'DELETE') {
    const myCards = getMyCards();
    if (!myCards.some((m) => m.id === mcMatch[1])) return err('持卡不存在', 404);
    store.write('mycards', myCards.filter((m) => m.id !== mcMatch[1]));
    store.write('consumptions', getConsumptions().filter((r) => r.myCardId !== mcMatch[1]));
    store.write('benefits', getBenefits().filter((r) => r.myCardId !== mcMatch[1]));
    // 删掉的是组内最后一张卡时，组本身已无意义（成员关系记在卡上，空组不会自动消失）
    cleanBillGroups();
    return json({ ok: true });
  }

  // ---- 消费记录 ----
  const consMatch = pathname.match(/^\/api\/mycards\/([^/]+)\/consumptions$/);
  if (consMatch && method === 'GET') {
    const mc = getMyCards().find((m) => m.id === consMatch[1]);
    if (!mc) return err('持卡不存在', 404);
    const scope = url.searchParams.get('scope') || 'all';
    let recs = amountRecordsOf(mc.id);
    const now2 = new Date();
    if (scope === 'month') recs = recs.filter((r) => r.date >= U.toDateStr(new Date(now2.getFullYear(), now2.getMonth(), 1)));
    else if (scope === 'year') recs = recs.filter((r) => r.date >= U.toDateStr(new Date(now2.getFullYear(), 0, 1)));
    recs = recs.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.createdAt < b.createdAt ? 1 : -1)));
    const total = recs.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    return json({ records: recs, total, count: recs.length });
  }
  if (consMatch && method === 'POST') {
    const mc = getMyCards().find((m) => m.id === consMatch[1]);
    if (!mc) return err('持卡不存在', 404);
    const b = body || {};
    const date = U.parseDateStr(b.date) ? String(b.date) : U.todayStr();
    const amount = Number(b.amount);
    if (!isFinite(amount) || amount <= 0) return err('金额必须大于 0');
    if (amount > MAX_MONEY) return err('金额超出允许范围');
    const rec = {
      id: U.uid(), myCardId: mc.id, date, type: 'amount',
      amount: Math.round(amount * 100) / 100,
      channel: CHANNELS.includes(b.channel) ? b.channel : CHANNELS[0],
      category: CATEGORIES.includes(b.category) ? b.category : '其他',
      note: String(b.note || '').trim(),
      createdAt: now.toISOString(),
    };
    const recs = getConsumptions();
    recs.push(rec);
    store.write('consumptions', recs);
    return json(rec, 201);
  }
  const cntMatch = pathname.match(/^\/api\/mycards\/([^/]+)\/consumptions\/count$/);
  if (cntMatch && method === 'POST') {
    const mc = getMyCards().find((m) => m.id === cntMatch[1]);
    if (!mc) return err('持卡不存在', 404);
    const b = body || {};
    const count = validCount(b.count);
    if (count === null) return err('补录笔数必须为大于 0 的整数');
    const rec = {
      id: U.uid(), myCardId: mc.id, type: 'count',
      date: U.parseDateStr(b.date) ? String(b.date) : U.todayStr(),
      count,
      createdAt: now.toISOString(),
    };
    const recs = getConsumptions();
    recs.push(rec);
    store.write('consumptions', recs);
    return json(rec, 201);
  }

  // 删除单条消费记录（金额类）；笔数补录不支持删除（进度按笔累计、无撤销语义）
  const consDelMatch = pathname.match(/^\/api\/mycards\/([^/]+)\/consumptions\/([^/]+)$/);
  if (consDelMatch && method === 'DELETE') {
    const mc = getMyCards().find((m) => m.id === consDelMatch[1]);
    if (!mc) return err('持卡不存在', 404);
    const recs = getConsumptions();
    const rec = recs.find((r) => r.id === consDelMatch[2] && r.myCardId === mc.id);
    if (!rec) return err('消费记录不存在', 404);
    if (rec.type !== 'amount') return err('笔数补录记录不支持删除');
    store.write('consumptions', recs.filter((r) => r.id !== rec.id));
    return json({ ok: true });
  }

  // ---- 权益 ----
  const benHisMatch = pathname.match(/^\/api\/mycards\/([^/]+)\/benefits\/(\d+)\/history$/);
  if (benHisMatch && method === 'GET') {
    const mc = getMyCards().find((m) => m.id === benHisMatch[1]);
    if (!mc) return err('持卡不存在', 404);
    const ref = resolveBenefit(mc, +benHisMatch[2], url.searchParams.get('bid'));
    if (!ref) return err('权益不存在', 404);
    return json(benefitHistory(mc, ref.idx, ref.bid, buildIndexes()));
  }
  const benUseMatch = pathname.match(/^\/api\/mycards\/([^/]+)\/benefits\/(\d+)\/usage$/);
  if (benUseMatch && method === 'POST') {
    const mc = getMyCards().find((m) => m.id === benUseMatch[1]);
    if (!mc) return err('持卡不存在', 404);
    const ref = resolveBenefit(mc, +benUseMatch[2], (body || {}).bid);
    // 越界索引必须拒绝：computeMyCard 的 benefitUsed 对不存在权益返回 exhausted=false，
    // 若这里放行就会写入 idx 找不到权益的垃圾记录（永远无人展示、也无法清理）
    if (!ref) return err('权益不存在', 404);
    const idx = ref.idx;
    const st = benefitUsed(mc, idx, now);
    // 有效期已过：computeMyCard 已把 exhausted 置 false（避免显示成「次数用完」误导），
    // 因此这里必须单独拦 expired，否则过期权益仍能写入记录
    if (st.expired) return err('当前权益已过有效期');
    if (st.exhausted) return err('当前权益次数已用完');
    const b = body || {};
    const rec = {
      id: U.uid(), myCardId: mc.id, idx, bid: ref.bid, type: 'usage',
      date: U.parseDateStr(b.date) ? String(b.date) : U.todayStr(),
      note: String(b.note || '').trim(),
      createdAt: now.toISOString(),
    };
    const recs = getBenefits();
    recs.push(rec);
    store.write('benefits', recs);
    return json({ ok: true, used: st.used + 1, total: st.total }, 201);
  }
  const benCntMatch = pathname.match(/^\/api\/mycards\/([^/]+)\/benefits\/(\d+)\/count$/);
  if (benCntMatch && method === 'POST') {
    const mc = getMyCards().find((m) => m.id === benCntMatch[1]);
    if (!mc) return err('持卡不存在', 404);
    const ref = resolveBenefit(mc, +benCntMatch[2], (body || {}).bid);
    if (!ref) return err('权益不存在', 404);
    const idx = ref.idx;
    const st = benefitUsed(mc, idx, now);
    const b = body || {};
    const count = validCount(b.count);
    if (count === null) return err('补录次数必须为大于 0 的整数');
    if (st.expired) return err('当前权益已过有效期');
    // -1 = 不限次，不做上限拦截（之前 st.used + count > -1 恒为真，不限次权益无法补录）
    if (st.total >= 0 && st.used + count > st.total) return err('当前权益次数已用完（剩余 ' + Math.max(0, st.total - st.used) + ' 次）');
    const rec = {
      id: U.uid(), myCardId: mc.id, idx, bid: ref.bid, type: 'count',
      date: U.parseDateStr(b.date) ? String(b.date) : U.todayStr(),
      count,
      createdAt: now.toISOString(),
    };
    const recs = getBenefits();
    recs.push(rec);
    store.write('benefits', recs);
    return json({ ok: true, used: st.used + count, total: st.total }, 201);
  }
  // ---- 合并账单组（CRUD）----
  if (pathname === '/api/billgroups' && method === 'GET') {
    const myCards = getMyCards();
    const groups = getBillGroups().map((g) => {
      const members = myCards.filter((m) => m.billGroupId === g.id);
      return {
        ...g,
        memberIds: members.map((m) => m.id),
        memberCount: members.length,
        // 组内统一还款节奏（成员必然一致，否则组无法建立）；空组回退显示为空
        lastPayDate: members.length ? D.paymentInfo(members[0], now).lastPayDate : '',
      };
    });
    return json(groups);
  }
  if (pathname === '/api/billgroups' && method === 'POST') {
    const b = body || {};
    const name = String(b.name || '').trim();
    if (!name) return err('请填写账单组名称');
    const groups = getBillGroups();
    if (groups.some((g) => g.name === name)) return err('已存在同名账单组');
    const ids = Array.isArray(b.memberIds) ? b.memberIds.map(String) : [];
    const myCards = getMyCards();
    const picked = [];
    for (const id of ids) {
      const m = myCards.find((x) => x.id === id);
      if (!m) return err('持卡不存在: ' + id, 404);
      if (picked.some((x) => x.id === id)) continue;
      picked.push(m);
    }
    if (picked.length < 2) return err('账单组至少需要 2 张卡');
    // 组内两两校验还款节奏一致（策略③）
    for (let i = 1; i < picked.length; i++) {
      if (!sameRepaySchedule(picked[0], picked[i], now)) {
        return err('「' + (picked[i].alias || picked[i].name) + '」与「' + (picked[0].alias || picked[0].name) + '」的最后还款日不一致，无法合并（组内卡必须同还款日）');
      }
    }
    const g = { id: U.uid(), name, createdAt: now.toISOString() };
    groups.push(g);
    store.write('billGroups', groups);
    for (const m of picked) m.billGroupId = g.id;
    store.write('mycards', myCards);
    return json(g, 201);
  }
  const bgMatch = pathname.match(/^\/api\/billgroups\/([^/]+)$/);
  if (bgMatch && method === 'PUT') {
    const groups = getBillGroups();
    const i = groups.findIndex((g) => g.id === bgMatch[1]);
    if (i < 0) return err('账单组不存在', 404);
    const b = body || {};
    const name = String(b.name != null ? b.name : groups[i].name).trim();
    if (!name) return err('请填写账单组名称');
    if (groups.some((g, k) => k !== i && g.name === name)) return err('已存在同名账单组');
    const myCards = getMyCards();
    if (Array.isArray(b.memberIds)) {
      const ids = b.memberIds.map(String);
      const picked = [];
      for (const id of ids) {
        const m = myCards.find((x) => x.id === id);
        if (!m) return err('持卡不存在: ' + id, 404);
        if (!picked.some((x) => x.id === id)) picked.push(m);
      }
      if (picked.length && picked.length < 2) return err('账单组至少需要 2 张卡');
      for (let k = 1; k < picked.length; k++) {
        if (!sameRepaySchedule(picked[0], picked[k], now)) {
          return err('「' + (picked[k].alias || picked[k].name) + '」与「' + (picked[0].alias || picked[0].name) + '」的最后还款日不一致，无法合并（组内卡必须同还款日）');
        }
      }
      const set = new Set(picked.map((m) => m.id));
      for (const m of myCards) {
        if (m.billGroupId === groups[i].id && !set.has(m.id)) m.billGroupId = '';
        else if (set.has(m.id)) m.billGroupId = groups[i].id;
      }
      store.write('mycards', myCards);
    }
    groups[i] = { ...groups[i], name };
    store.write('billGroups', groups);
    // 成员被清空（memberIds 提交 []）时组随之解散，避免留下无成员的僵尸组
    cleanBillGroups();
    return json(groups[i]);
  }
  if (bgMatch && method === 'DELETE') {
    const groups = getBillGroups();
    if (!groups.some((g) => g.id === bgMatch[1])) return err('账单组不存在', 404);
    const myCards = getMyCards();
    let changed = false;
    for (const m of myCards) {
      if (m.billGroupId === bgMatch[1]) { m.billGroupId = ''; changed = true; }
    }
    if (changed) store.write('mycards', myCards);
    store.write('billGroups', groups.filter((g) => g.id !== bgMatch[1]));
    return json({ ok: true });
  }

  // ---- 账单流水（月账单 + 是否已还）----
  if (pathname === '/api/bills' && method === 'GET') {
    const q = url.searchParams;
    let list = getBills();
    const cardId = q.get('myCardId');
    const month = q.get('month');
    const paid = q.get('paid');
    if (cardId) list = list.filter((b) => b.myCardId === cardId);
    if (month) list = list.filter((b) => b.month === month);
    if (paid) list = list.filter((b) => b.paid === paid);
    return json(list.sort((a, b) => (a.month < b.month ? 1 : -1)));
  }
  if (pathname === '/api/bills' && method === 'POST') {
    const b = body || {};
    if (!b.myCardId) return err('缺少 myCardId');
    if (!getMyCards().some((m) => m.id === b.myCardId)) return err('持卡不存在', 404);
    if (!/^\d{4}-\d{2}$/.test(String(b.month || ''))) return err('出账月份格式应为 YYYY-MM');
    const amount = Number(b.amount);
    if (!isFinite(amount) || amount < 0) return err('账单金额必须不小于 0');
    const bills = getBills();
    if (bills.some((x) => x.myCardId === b.myCardId && x.month === b.month)) {
      return err('该卡该月份账单已存在');
    }
    const rec = {
      id: U.uid(),
      myCardId: b.myCardId,
      month: String(b.month),
      amount: Math.round(amount * 100) / 100,
      // 日期一律经真实校验（拒绝 2026-02-30 / 2026-13-01 这类不存在的日期）
      dueDate: U.parseDateStr(b.dueDate) ? String(b.dueDate) : '',
      paid: b.paid === '已还' ? '已还' : '未还',
      paidDate: U.parseDateStr(b.paidDate) ? String(b.paidDate) : '',
      note: String(b.note || '').trim(),
      createdAt: now.toISOString(),
    };
    bills.push(rec);
    store.write('bills', bills);
    return json(rec, 201);
  }
  const billMatch = pathname.match(/^\/api\/bills\/([^/]+)$/);
  if (billMatch && method === 'PUT') {
    const bills = getBills();
    const i = bills.findIndex((b) => b.id === billMatch[1]);
    if (i < 0) return err('账单不存在', 404);
    const b = body || {};
    const cur = bills[i];
    const amount = b.amount != null ? Number(b.amount) : cur.amount;
    if (!isFinite(amount) || amount < 0) return err('账单金额必须不小于 0');
    const paid = b.paid == null ? cur.paid : (b.paid === '已还' ? '已还' : '未还');
    // 日期一律经真实校验；未显式传入时沿用旧值（旧值若非法则清空/回填今天）
    const dueDate = b.dueDate != null
      ? (U.parseDateStr(b.dueDate) ? String(b.dueDate) : '')
      : (U.parseDateStr(cur.dueDate) ? cur.dueDate : '');
    const paidDate = b.paidDate != null
      ? (U.parseDateStr(b.paidDate) ? String(b.paidDate) : '')
      : (paid === '已还' ? (U.parseDateStr(cur.paidDate) ? cur.paidDate : U.todayStr()) : '');
    bills[i] = {
      ...cur,
      amount: Math.round(amount * 100) / 100,
      dueDate,
      paid,
      // 标记已还且未填还款日期时自动填今天；改回未还则清空
      paidDate,
      note: b.note != null ? String(b.note).trim() : cur.note,
    };
    store.write('bills', bills);
    return json(bills[i]);
  }
  if (billMatch && method === 'DELETE') {
    const bills = getBills();
    if (!bills.some((b) => b.id === billMatch[1])) return err('账单不存在', 404);
    store.write('bills', bills.filter((b) => b.id !== billMatch[1]));
    return json({ ok: true });
  }
  const billGenMatch = pathname.match(/^\/api\/mycards\/([^/]+)\/bills\/generate$/);
  if (billGenMatch && method === 'POST') {
    const mc = getMyCards().find((m) => m.id === billGenMatch[1]);
    if (!mc) return err('持卡不存在', 404);
    const info = D.paymentInfo(mc, now);
    const month = (body && /^\d{4}-\d{2}$/.test(String(body.month || ''))) ? String(body.month) : info.billMonth;
    const bills = getBills();
    const exist = bills.find((b) => b.myCardId === mc.id && b.month === month);
    if (exist) return json(exist);
    const rec = {
      id: U.uid(),
      myCardId: mc.id,
      month,
      amount: 0,
      dueDate: info.dueDate,
      paid: '未还',
      paidDate: '',
      note: '',
      createdAt: now.toISOString(),
    };
    bills.push(rec);
    store.write('bills', bills);
    return json(rec, 201);
  }

  // ---- 提醒功能 ----
  if (pathname === '/api/notify/config' && method === 'GET') {
    // 推送 token 一律不回传真值。
    // 关键背景：normalizeConfig 会把「环境变量注入的 token」合并进返回对象，而 README
    // 恰恰建议「token 别填 UI、改用环境变量更安全」——若这里原样返回，那条无鉴权 GET
    // 就会把「更安全做法」的成果原样吐出，安全性被拉平到与明文落盘一致。
    return json(maskNotifySecrets(reminder.normalizeConfig(getNotifyRaw())));
  }
  if (pathname === '/api/notify/config' && method === 'PUT') {
    const raw = getNotifyRaw() || {};
    const incoming = body || {};
    // 前端回填的是掩码串；用户没改动时应保留磁盘上的原值，不能把掩码写进去
    const existing = reminder.normalizeConfig(raw);
    if (incoming.channels && typeof incoming.channels === 'object') {
      for (const ch of Object.keys(NOTIFY_SECRET_FIELDS)) {
        const inCh = incoming.channels[ch];
        if (!inCh || typeof inCh !== 'object') continue;
        for (const f of NOTIFY_SECRET_FIELDS[ch]) {
          if (f in inCh && isMaskedSecret(inCh[f])) {
            const old = (existing.channels[ch] || {})[f];
            // 有原值 → 沿用；前端提交空掩码且磁盘也没值 → 置空
            inCh[f] = old || '';
          }
        }
      }
    }
    const cfg = reminder.normalizeConfig(Object.assign({}, raw, incoming, {
      // sentLog/history 不能被前端覆盖，只允许通过 check 结果更新
      sentLog: raw.sentLog || {},
      history: raw.history || [],
    }));
    store.write('notify', cfg);
    return json(maskNotifySecrets(cfg));
  }
  if (pathname === '/api/notify/test' && method === 'POST') {
    const cfg = reminder.normalizeConfig(getNotifyRaw());
    const enabled = notifier.enabledChannels(cfg);
    if (!enabled.length) return err('请先启用至少一个提醒通道');
    const results = await notifier.notifyAll(cfg, '管卡提醒测试', '这是一条来自管卡的**测试提醒**。\n\n- 通道：' + enabled.join('、') + '\n- 时间：' + new Date().toLocaleString('zh-CN'));
    const okCount = results.filter((r) => r.ok).length;
    return json({ ok: okCount > 0, results });
  }
  if (pathname === '/api/notify/check' && method === 'POST') {
    return json(await runNotifyChecks(true)); // 手动触发：忽略节流
  }
  if (pathname === '/api/notify/history' && method === 'GET') {
    const cfg = reminder.normalizeConfig(getNotifyRaw());
    return json({ history: cfg.history || [], enabled: cfg.enabled, intervalMinutes: cfg.intervalMinutes });
  }

  // ---- ICS 日历订阅 ----
  // 鉴权已由入口层保证（?token= / Bearer / Cookie 任一）。日历客户端只能带
  // URL token，浏览器已登录用户则带 Cookie，两条路都通。
  if (pathname === '/api/calendar.ics' && method === 'GET') {
    const idx = buildIndexes();
    const computed = getMyCards().map((m) => computeMyCard(m, now, idx));
    const text = ics.generateICS(computed, getBills(), now);
    return {
      ics: text,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="guanka.ics"',
        'Cache-Control': 'no-store',
      },
    };
  }

  const ptsMatch = pathname.match(/^\/api\/mycards\/([^/]+)\/points$/);
  if (ptsMatch && method === 'POST') {
    const myCards = getMyCards();
    const mc = myCards.find((m) => m.id === ptsMatch[1]);
    if (!mc) return err('持卡不存在', 404);
    mc.pointsDeducted = !!(body || {}).value;
    mc.pointsDeductDate = mc.pointsDeducted ? U.todayStr() : null;
    store.write('mycards', myCards);
    return json({ ok: true, pointsDeducted: mc.pointsDeducted, pointsDeductDate: mc.pointsDeductDate });
  }
  const assetMatch = pathname.match(/^\/api\/mycards\/([^/]+)\/asset$/);
  if (assetMatch && method === 'POST') {
    const myCards = getMyCards();
    const mc = myCards.find((m) => m.id === assetMatch[1]);
    if (!mc) return err('持卡不存在', 404);
    mc.assetWaived = !!(body || {}).value;
    mc.assetWaivedDate = mc.assetWaived ? U.todayStr() : null;
    store.write('mycards', myCards);
    return json({ ok: true, assetWaived: mc.assetWaived, assetWaivedDate: mc.assetWaivedDate });
  }

  return undefined;
}

function clampDay(v, dflt) {
  const n = Math.round(Number(v));
  if (!isFinite(n) || n < 1) return dflt;
  return Math.min(31, n);
}

// 非负金额（额度/目标/年费）：空值/负值回退默认，封顶 1 万亿防脏数据
const MAX_MONEY = 1e12;
const MAX_COUNT = 1e6;
// 单次备份导入的持卡数上限：防手改的超大文件拖垮同步写（正常个人规模远低于此）
const MAX_IMPORT_CARDS = 500;
// 消费/权益/账单等明细记录的导入上限：与 20MB 请求体上限共同兜底，
// 防止在 body 上限内塞入海量空对象，让归一循环+全量重写退化成分钟级阻塞
const MAX_IMPORT_RECORDS = 20000;
function nonNeg(v, dflt) {
  if (v == null || String(v).trim() === '') return dflt || 0;
  const n = U.parseAmount(v);
  if (!isFinite(n) || n < 0) return dflt || 0;
  return Math.min(MAX_MONEY, n);
}

// 次数类输入（补录笔数/权益次数）：正整数且封顶
function validCount(v) {
  const n = Math.round(Number(v));
  if (!isFinite(n) || n <= 0) return null;
  return Math.min(MAX_COUNT, n);
}

/**
 * 解析 CSV 里的「权益」列 → normalizeBenefits 能吃的对象数组。
 * 单个权益写法：`名称:次数:重置周期`，冒号段可省略（默认 1 次 / 自然年）；
 * 次数填 -1 表示不限次。多个权益用 `|` 分隔。
 * 例：`机场贵宾厅:6:自然年|生日10倍积分:1:自然年`
 */
function parseBenefitSpec(spec, fallbackNames) {
  const s = String(spec || '').trim();
  if (!s) {
    // 留空时按卡种默认权益走（与表单里不勾选权益的行为一致）
    return normalizeBenefits(undefined, fallbackNames);
  }
  const items = s.split('|').map((seg) => {
    const parts = seg.split(':').map((x) => x.trim());
    const name = parts[0];
    if (!name) return null;
    const total = parts.length > 1 && parts[1] !== '' ? Math.round(Number(parts[1])) : 1;
    return {
      name,
      total: isFinite(total) ? total : 1,
      resetCycle: parts[2] || '自然年',
    };
  }).filter(Boolean);
  return normalizeBenefits(items, fallbackNames);
}

function normalizeBenefits(benefits, fallbackNames) {
  // 只看「是不是数组」而不是「有没有元素」：编辑时把权益全部删掉会提交 []，
  // 若把空数组也当成「未提供」，卡种默认权益就会复活，用户永远删不干净
  if (Array.isArray(benefits)) {
    return benefits.map((b) => {
      const rawTotal = Math.round(Number(b.total));
      const total = isFinite(rawTotal) ? (rawTotal < 0 ? -1 : rawTotal) : 1; // -1 = 不限次
      const type = String(b.type || b.benefitType || '').trim();
      const validUntil = U.parseDateStr(b.validUntil) ? String(b.validUntil) : '';
      return {
        // 稳定 id：权益可增删/重排，若使用记录只认索引会整体错位（B 继承 A 的历史）
        id: (typeof b.id === 'string' && b.id) ? b.id : U.uid(),
        name: String(b.name || '').trim() || '权益',
        type: BENEFIT_TYPES.includes(type) ? type : (type || ''),
        total,
        resetCycle: RESET_CYCLES.includes(b.resetCycle) ? b.resetCycle : '自然年',
        validUntil,
      };
    }).filter((b) => b.name);
  }
  // 未填写时按卡种权益默认：次数 1、自然年
  return (fallbackNames || []).map((name) => ({ id: U.uid(), name, total: 1, resetCycle: '自然年' }));
}

// 定位权益：优先按稳定 id（增删/重排后索引会前移，仅按索引会错配记录）；无 id 时回退索引
function resolveBenefit(mc, idx, bid) {
  const bens = mc.benefits || [];
  if (bid) {
    const i = bens.findIndex((b) => b && b.id === bid);
    if (i < 0) return null;
    return { idx: i, bid: bens[i].id };
  }
  if (!Number.isInteger(idx) || idx < 0 || idx >= bens.length) return null;
  return { idx, bid: bens[idx].id || '' };
}

// 提醒检查：force=true 时忽略节流（手动触发）；否则按 intervalMinutes 节流
// 检查包含网络推送（可能数秒），用互斥标志防止定时 tick 与手动 check 并发执行 → 重复推送
let notifyChecking = false;
async function runNotifyChecks(force) {
  if (notifyChecking) return { skipped: true, reason: '上一次提醒检查仍在进行中' };
  notifyChecking = true;
  try {
    return await runNotifyChecksInner(force);
  } finally {
    notifyChecking = false;
  }
}

async function runNotifyChecksInner(force) {
  const cfg = reminder.normalizeConfig(getNotifyRaw());
  if (!cfg.enabled) return { skipped: true, reason: '提醒未启用' };
  if (!force && cfg.lastCheckAt) {
    const gap = (Date.now() - new Date(cfg.lastCheckAt).getTime()) / 60000;
    if (gap < cfg.intervalMinutes) return { skipped: true, reason: `距上次检查 ${Math.round(gap)} 分钟，未达 ${cfg.intervalMinutes} 分钟间隔` };
  }
  const idx = buildIndexes();
  const now = new Date();
  const cards = getMyCards().map((m) => computeMyCard(m, now, idx));
  const out = await reminder.runChecks(cards, cfg, notifier, now, getBills());
  cfg.lastCheckAt = now.toISOString();
  // 回写时只覆盖「检查自身产生」的字段（lastCheckAt/sentLog/history），其余字段以最新配置为准。
  // 推送是网络操作（可能数秒），期间用户可能改了通道或规则；若直接回写整份 cfg 会把用户的改动抹掉。
  const latest = reminder.normalizeConfig(getNotifyRaw());
  latest.lastCheckAt = cfg.lastCheckAt;
  latest.sentLog = cfg.sentLog;
  latest.history = cfg.history;
  store.write('notify', latest);
  return Object.assign({ skipped: false }, out);
}

// 卡种信息变更后同步所有持卡的快照字段
function syncMyCardSnapshots() {
  const myCards = getMyCards();
  // 先建一次索引：此前在循环内每次 getCards().find(...)，复杂度 O(持卡数 × 卡种数)
  const byId = new Map(getCards().map((c) => [c.id, c]));
  let changed = false;
  for (const mc of myCards) {
    const c = byId.get(mc.cardId);
    if (!c) continue;
    const before = JSON.stringify(mc);
    mc.bank = c.bank; mc.name = c.name; mc.org = c.org; mc.level = c.level;
    mc.annualFee = c.annualFee; mc.waiverType = c.waiverType; mc.waiverCondition = c.waiverCondition; mc.waiverPolicy = c.waiverPolicy;
    if (JSON.stringify(mc) !== before) changed = true;
  }
  if (changed) store.write('mycards', myCards);
}

module.exports = {
  init, handle, runNotifyChecks,
  _internals: { computeMyCard, computeStats, benefitUsed, benefitHistory, waiverState, normalizeCard, normalizeBenefits, cardKey, buildIndexes, resolveBenefit, sameRepaySchedule, groupAssignError },
};
