'use strict';

/* 提醒引擎：生成提醒项 → 去重 → 推送 → 记录
 * 依赖注入：调用方传入「已计算的持卡列表」（含 feeDays/waiver/monthSpend 等），
 * 避免与 routes 形成循环依赖。
 */

function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); } // m: 1-12

function todayStr(d) {
  const x = d || new Date();
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}

function money(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

const DEFAULT_CONFIG = {
  enabled: true,
  intervalMinutes: 60,
  lastCheckAt: '',
  channels: {
    wxpusher: { enabled: false, appToken: '', uids: '', topicIds: '', summaryPrefix: '管卡提醒' },
    serverchan: { enabled: false, sendkey: '' },
    bark: { enabled: false, deviceKey: '', server: 'https://api.day.app', level: 'active', group: '管卡' },
  },
  rules: { feeDays: [30, 7, 1], repayBeforeDays: 3, taskRemainDays: 3, billBeforeDays: 3, billOverdueRemind: 1, assetExpiryDays: 7 },
  sentLog: {},
  history: [],
};

function normalizeConfig(raw) {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const r = raw || {};
  cfg.enabled = r.enabled === undefined ? true : !!r.enabled;
  cfg.intervalMinutes = Math.max(5, Math.min(1440, Number(r.intervalMinutes) || 60));
  if (r.channels) {
    for (const k of Object.keys(cfg.channels)) {
      const src = r.channels[k] || {};
      cfg.channels[k].enabled = !!src.enabled;
      for (const f of Object.keys(src)) {
        if (f === 'enabled') continue;
        cfg.channels[k][f] = String(src[f] === undefined ? (cfg.channels[k][f] || '') : src[f]);
      }
    }
  }
  if (r.rules) {
    const days = Array.isArray(r.rules.feeDays) ? r.rules.feeDays.map(Number).filter((n) => Number.isFinite(n) && n >= 0) : null;
    cfg.rules.feeDays = days && days.length ? days.slice().sort((a, b) => b - a) : DEFAULT_CONFIG.rules.feeDays.slice();
    cfg.rules.repayBeforeDays = Number(r.rules.repayBeforeDays) || 0;
    cfg.rules.taskRemainDays = Number(r.rules.taskRemainDays) || 0;
    cfg.rules.billBeforeDays = r.rules.billBeforeDays == null ? DEFAULT_CONFIG.rules.billBeforeDays : (Number(r.rules.billBeforeDays) || 0);
    cfg.rules.billOverdueRemind = r.rules.billOverdueRemind == null ? 1 : (r.rules.billOverdueRemind ? 1 : 0);
    cfg.rules.assetExpiryDays = Math.max(0, Math.min(90, Number(r.rules.assetExpiryDays) || 0));
  }
  cfg.sentLog = (r.sentLog && typeof r.sentLog === 'object') ? r.sentLog : {};
  cfg.history = Array.isArray(r.history) ? r.history.slice(0, 30) : [];
  cfg.lastCheckAt = r.lastCheckAt || '';

  // 敏感项支持环境变量注入（配置为空时兜底）
  const wp = cfg.channels.wxpusher;
  if (!wp.appToken && process.env.WXPUSHER_APP_TOKEN) wp.appToken = process.env.WXPUSHER_APP_TOKEN;
  if (!wp.uids && process.env.WXPUSHER_UIDS) wp.uids = process.env.WXPUSHER_UIDS;
  const sc = cfg.channels.serverchan;
  if (!sc.sendkey && process.env.SERVERCHAN_SENDKEY) sc.sendkey = process.env.SERVERCHAN_SENDKEY;
  const bk = cfg.channels.bark;
  if (!bk.deviceKey && process.env.BARK_DEVICE_KEY) bk.deviceKey = process.env.BARK_DEVICE_KEY;
  if (!bk.server) bk.server = DEFAULT_CONFIG.channels.bark.server;
  return cfg;
}

/** 还款日距今（旧口径，仅固定还款日估算；提醒引擎已改用日期引擎 payment.payDaysLeft，此函数保留给外部脚本复用） */
function daysToRepay(repayDay, now) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1; // 1-12
  const d = Math.min(Math.max(1, Number(repayDay) || 1), daysInMonth(y, m));
  const target = new Date(y, m - 1, d);
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let diff = Math.round((target - t0) / 86400000);
  if (diff < 0) {
    const nm = m === 12 ? 1 : m + 1;
    const ny = m === 12 ? y + 1 : y;
    const nd = Math.min(Math.max(1, Number(repayDay) || 1), daysInMonth(ny, nm));
    const nt = new Date(ny, nm - 1, nd);
    diff = Math.round((nt - t0) / 86400000);
  }
  return diff;
}

function feeItem(m, days, feeDayThreshold) {
  const w = m.waiver || {};
  const name = m.alias || m.name || '未命名卡片';
  let remain = '';
  if (w.kind === '消费刷免') remain = `已完成 ¥${money(w.progress)} / ¥${money(w.target)}，还差 ¥${money(w.remaining)}`;
  else if (w.kind === '笔数刷免') remain = `已完成 ${w.progress} / ${w.target} 笔，还差 ${w.remaining} 笔`;
  else if (w.kind === '积分抵扣') remain = '需积分抵扣，当前未抵扣';
  else if (w.kind === '资产存免') remain = '需资产达标，当前未达标';
  else if (w.kind === '刚性') remain = '刚性年费，必须缴费';
  const title = days === 0 ? `年费今日收取：${name}` : `年费提醒：${name} 还有 ${days} 天`;
  const body = [
    `- 银行：${m.bank || '—'}`,
    `- 卡片：${m.name || '—'}${m.alias ? `（${m.alias}）` : ''}`,
    `- 年费：¥${money(m.annualFee)}`,
    `- 收取日：${m.nextFeeDate || '—'}（还有 ${days} 天）`,
    `- 状态：${w.statusText || (w.needsPayment ? '需缴费' : '已免')}${remain ? `｜${remain}` : ''}`,
  ].join('\n');
  return {
    type: 'fee',
    // key 必须区分「倒数第 N 天」与「年费当天」：否则 feeDays 从 1 跨到 0 时 key 相同，
    // 当天那条「年费今日收取」会被去重逻辑吞掉、永远发不出去
    key: `fee:${m.id}:${m.nextFeeDate}:${days === 0 ? 'today' : feeDayThreshold}`,
    title, body,
  };
}

function repayItem(m, days, now) {
  const name = m.alias || m.name || '未命名卡片';
  const p = m.payment || {};
  const title = days === 0 ? `今日还款：${name}` : `还款提醒：${name} ${days} 天后到期`;
  const body = [
    `- 银行：${m.bank || '—'}`,
    `- 卡片：${m.name || '—'}${m.alias ? `（${m.alias}）` : ''}`,
    `- 本期账单日：${p.billDate || '—'}`,
    `- 银行到期日：${p.dueDate || '—'}${p.isInGrace ? '（宽限期内，仍可还款）' : ''}`,
    `- 最后还款日：${p.lastPayDate || '—'}（${days === 0 ? '就是今天' : `还有 ${days} 天`}）`,
    `- 额度：¥${money(m.creditLimit)}`,
  ].join('\n');
  // key 按最后还款日去重：同一天同一张卡只推一次，跨期（日期变化）可再次提醒。
  // 兜底用「传入 now 的年月」而非当前真实时间，保证时间基准与 collectReminders 一致（便于测试注入历史日期）
  const ym = (now || new Date());
  const fallbackYm = ym.getFullYear() + '-' + String(ym.getMonth() + 1).padStart(2, '0');
  return { type: 'repay', key: `repay:${m.id}:${p.lastPayDate || fallbackYm}`, title, body };
}

function taskItem(m, remainDays, gap, now) {
  const name = m.alias || m.name || '未命名卡片';
  const title = `刷卡任务：${name} 还差 ¥${money(gap)}`;
  const body = [
    `- 银行：${m.bank || '—'}`,
    `- 卡片：${m.name || '—'}${m.alias ? `（${m.alias}）` : ''}`,
    `- 本月消费：¥${money(m.monthSpend)} / 目标 ¥${money(m.monthlySpendTarget)}`,
    `- 还差：¥${money(gap)}（本月剩 ${remainDays} 天）`,
  ].join('\n');
  const dd = (now || new Date());
  const ym = dd.getFullYear() + '-' + String(dd.getMonth() + 1).padStart(2, '0');
  return { type: 'task', key: `task:${m.id}:${ym}`, title, body };
}

function billItem(b, m, daysLeft) {
  const name = (m && (m.alias || m.name)) || '未命名卡片';
  const title = daysLeft < 0 ? `账单逾期未还：${name}（${b.month}）` : `账单提醒：${name} ${daysLeft === 0 ? '今日到期' : `还有 ${daysLeft} 天`}`;
  const body = [
    `- 银行：${(m && m.bank) || '—'}`,
    `- 卡片：${(m && m.name) || '—'}${(m && m.alias) ? `（${m.alias}）` : ''}`,
    `- 出账月份：${b.month}`,
    `- 账单金额：¥${money(b.amount)}`,
    `- 到期还款日：${b.dueDate}${daysLeft < 0 ? `（已逾期 ${Math.abs(daysLeft)} 天）` : ''}`,
    daysLeft < 0 ? '- 状态：**仍未标记为已还**，请尽快处理' : '- 状态：未还',
  ].join('\n');
  return { type: 'bill', key: `bill:${b.myCardId}:${b.month}:${daysLeft < 0 ? 'overdue' : 'due'}`, title, body };
}

/** 合并账单组的还款提醒：N 张卡合成一条（组内还款日一致，只推最早的到期日） */
function groupRepayItem(gid, name, members, days, lastPayDate) {
  const head = days === 0 ? `今日还款：${name}` : `还款提醒：${name} ${days} 天后到期`;
  const title = `${head}（${members.length} 张卡合并）`;
  const lines = members.map((m) => {
    const p = m.payment || {};
    const n = m.alias || m.name || '未命名卡片';
    const extra = p.isInGrace ? '（宽限期内）' : '';
    return `- ${n}｜${m.bank || '—'}｜银行到期 ${p.dueDate || '—'}${extra}`;
  });
  const body = [
    `- 账单组：${name}（共 ${members.length} 张卡，合并还款）`,
    `- 最后还款日：${lastPayDate}（${days === 0 ? '就是今天' : `还有 ${days} 天`}）`,
    ...lines,
  ].join('\n');
  // key 带上「倒数第几天」：成员变动后组合并项仍在，若 key 只按日期，
  // 同一组跨阈值（3→0 天）会被判成同一条而漏发当天的提醒（与单卡 fee 的 today 处理同理）
  return { type: 'repay', key: `repay:group:${gid}:${lastPayDate}:${days === 0 ? 'today' : 'd' + days}`, title, body };
}

/** 合并账单组的账单流水提醒：把同一组内同一出账月的未还账单聚成一条 */
function groupBillItem(gid, name, entries, month, daysLeft) {
  const title = daysLeft < 0
    ? `账单逾期未还：${name}（${month}）`
    : `账单提醒：${name} ${daysLeft === 0 ? '今日到期' : `还有 ${daysLeft} 天`}`;
  const total = entries.reduce((s, e) => s + (Number(e.b.amount) || 0), 0);
  const lines = entries.map((e) => {
    const m = e.m || {};
    return `- ${(m.alias || m.name) || '未命名卡片'}｜账单 ¥${money(e.b.amount)}｜到期 ${e.b.dueDate}`;
  });
  const body = [
    `- 账单组：${name}（共 ${entries.length} 张卡，合并还款）`,
    `- 出账月份：${month}`,
    `- 合计应还：¥${money(total)}`,
    `- 到期还款日：${entries[0].b.dueDate}${daysLeft < 0 ? `（已逾期 ${Math.abs(daysLeft)} 天）` : ''}`,
    ...lines,
    daysLeft < 0 ? '- 状态：**仍未标记为已还**，请尽快处理' : '- 状态：未还',
  ].join('\n');
  return { type: 'bill', key: `bill:group:${gid}:${month}:${daysLeft < 0 ? 'overdue' : 'due'}`, title, body };
}

/** 收集所有待提醒项（不含去重判断）。bills 为账单流水（月账单 + 是否已还） */
function collectReminders(cards, cfg, now, bills) {
  now = now || new Date();
  const items = [];
  const remainDaysInMonth = daysInMonth(now.getFullYear(), now.getMonth() + 1) - now.getDate();

  // 合并账单组成员索引：同一 billGroupId 的卡在还款/账单提醒上合并为一条
  const groups = new Map();
  for (const m of cards || []) {
    if (!m.billGroupId) continue;
    if (!groups.has(m.billGroupId)) groups.set(m.billGroupId, []);
    groups.get(m.billGroupId).push(m);
  }
  // 组内按最后还款日排序，取最早的那个作为整组的提醒日；组员还款日由服务端强制一致，
  // 这里排序只是兜底（数据被手工改脏时宁可早提醒也不能漏提醒）
  for (const members of groups.values()) {
    members.sort((a, b) => String((a.payment || {}).lastPayDate || '').localeCompare(String((b.payment || {}).lastPayDate || '')));
  }

  for (const m of cards || []) {
    // ① 年费到期：取「已跨越且最接近」的阈值，每个阈值只提醒一次
    //    （年费是每张卡独立的，不随合并账单归并）
    if (m.waiver && m.waiver.needsPayment && Number.isFinite(m.feeDays) && m.feeDays >= 0) {
      const applicable = cfg.rules.feeDays.filter((d) => m.feeDays <= d).sort((a, b) => a - b);
      if (applicable.length) items.push(feeItem(m, m.feeDays, applicable[0]));
    }
    // ② 还款日：基于日期引擎的「最后可还款日」（含宽限期与 afterBill 模式）。
    //    旧实现按固定 repaymentDay + daysToRepay 估算，对「账单日后 N 天」还款的卡会按错误日期提醒，且宽限期不参与。
    if (cfg.rules.repayBeforeDays > 0 && m.payment && Number.isFinite(m.payment.payDaysLeft)) {
      const d = m.payment.payDaysLeft;
      // 跳期后 payDaysLeft 指向下期最后还款日（最长约 2 个月），仅在提醒窗口内触发；
      // 真正「已逾期」的账单由账单流水（billOverdueRemind）负责提醒
      if (d >= 0 && d <= cfg.rules.repayBeforeDays) {
        const g = m.billGroupId ? groups.get(m.billGroupId) : null;
        // 组内只由「首位成员」产出合并提醒，其余成员不再单独推送。
        // 注意不能在这里 continue——下面还有按卡独立的月刷卡任务要处理
        if (g) {
          if (g[0].id === m.id) items.push(groupRepayItem(g[0].billGroupId, g[0].billGroupName || '合并账单组', g, d, m.payment.lastPayDate));
        } else {
          items.push(repayItem(m, d, now));
        }
      }
    }
    // ③ 月刷卡任务未达标（月末临近；按卡独立，不合并）
    if (cfg.rules.taskRemainDays > 0 && m.monthlySpendTarget > 0) {
      const gap = Math.max(0, Number(m.monthlySpendTarget) - Number(m.monthSpend || 0));
      if (gap > 0 && remainDaysInMonth <= cfg.rules.taskRemainDays) items.push(taskItem(m, remainDaysInMonth, gap, now));
    }
  }
  // ④ 账单流水：未还账单到期前提醒 + 已过到期日仍未还的逾期提醒。
  //    同组同月合并成一条（组内还款日一致，到期日相同；被手工改脏时取最早那条作为提醒日）
  const byId = new Map((cards || []).map((m) => [m.id, m]));
  const billBuckets = new Map(); // key: 组 → 月（同组按月归并）；无组时按单张卡
  for (const b of bills || []) {
    if (b.paid === '已还' || !b.dueDate) continue;
    const target = new Date(b.dueDate + 'T00:00:00');
    if (isNaN(target.getTime())) continue;
    const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const daysLeft = Math.round((target - t0) / 86400000);
    const overdue = daysLeft < 0;
    if (overdue ? !cfg.rules.billOverdueRemind : daysLeft > cfg.rules.billBeforeDays) continue;

    const m = byId.get(b.myCardId);
    const gid = m && m.billGroupId;
    // 组提醒必须以「卡还在组里」为前提；卡被移出组后其账单恢复逐卡提醒
    const g = gid ? groups.get(gid) : null;
    const key = g ? 'G:' + gid + ':' + b.month + ':' + (overdue ? 'o' : 'd') : 'C:' + b.myCardId;
    let bucket = billBuckets.get(key);
    if (!bucket) {
      bucket = { gid: gid || '', month: b.month, overdue, entries: [] };
      billBuckets.set(key, bucket);
    }
    bucket.entries.push({ b, m });
  }
  for (const bucket of billBuckets.values()) {
    const g = bucket.gid ? groups.get(bucket.gid) : null;
    if (!g) {
      const e = bucket.entries[0];
      items.push(billItem(e.b, e.m, diffDaysOf(e.b.dueDate, now)));
      continue;
    }
    // 组内成员按到期日升序，取最早者作为整组提醒日
    bucket.entries.sort((x, y) => String(x.b.dueDate).localeCompare(String(y.b.dueDate)));
    const earliest = bucket.entries[0];
    const daysLeft = diffDaysOf(earliest.b.dueDate, now);
    items.push(groupBillItem(bucket.gid, g[0].billGroupName || '合并账单组', bucket.entries, bucket.month, daysLeft));
  }
  return items;
}

/** 距今（自然日）天数，用于账单到期判断 */
function diffDaysOf(dateStr, now) {
  const t = new Date(String(dateStr) + 'T00:00:00');
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((t - t0) / 86400000);
}

/** 执行检查并推送：去重（同一 key 只推一次）→ 发送 → 记录历史 */
async function runChecks(cards, cfg, notifier, now, bills, assetData) {
  now = now || new Date();
  const date = todayStr(now);
  // 第 5 类提醒源：会员卡/卡票/知识库到期（移植自 Benefit Tracker 的到期推送）。
  // assetData 为空（旧调用方）时静默跳过，保持向后兼容。
  const assetItems = assetData ? require('./assets').collectAssetExpiry(assetData, cfg, now) : [];
  const items = collectReminders(cards, cfg, now, bills).concat(assetItems);
  const pending = items.filter((it) => !cfg.sentLog[it.key]);
  const results = [];
  for (const it of pending) {
    const sent = await notifier.notifyAll(cfg, it.title, it.body);
    const okList = sent.filter((s) => s.ok).map((s) => s.label);
    const errList = sent.filter((s) => !s.ok).map((s) => `${s.label}: ${s.error}`);
    if (sent.length === 0) {
      results.push({ type: it.type, key: it.key, title: it.title, ok: false, error: '没有已启用的提醒通道' });
    } else {
      cfg.sentLog[it.key] = date;
      results.push({ type: it.type, key: it.key, title: it.title, ok: okList.length > 0, sent: okList, error: errList.join('；') });
    }
    pushHistory(cfg, {
      time: now.toISOString(),
      type: it.type,
      title: it.title,
      channels: sent,
      ok: okList.length > 0,
    });
  }
  pruneSentLog(cfg, now);
  return { checked: items.length, sent: pending.length, results };
}

/**
 * 淘汰过期去重记录。
 * 去重键里都带日期/月份，只需覆盖「近期」即可防重复；不做清理会随使用年限无限增长
 * （实测 400 天后仍有 400 条），最终把 notify.json 撑大并拖慢每次读写。
 * 保留窗口 120 天，既覆盖所有提醒周期（最长约 2 个月），又给跨期回溯留足余量。
 */
const SENTLOG_KEEP_DAYS = 120;
function pruneSentLog(cfg, now) {
  const log = cfg.sentLog;
  if (!log || typeof log !== 'object') { cfg.sentLog = {}; return; }
  const keys = Object.keys(log);
  if (keys.length <= 200) return; // 小规模直接跳过，避免每次检查都做全量扫描
  const cutoff = new Date((now || new Date()).getTime() - SENTLOG_KEEP_DAYS * 86400000);
  const cutoffStr = todayStr(cutoff);
  for (const k of keys) {
    const d = log[k];
    // 值应为「推送日期」字符串；格式异常或早于保留窗口的一律清掉
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d) || d < cutoffStr) delete log[k];
  }
}

function pushHistory(cfg, entry) {
  cfg.history = cfg.history || [];
  cfg.history.unshift(entry);
  if (cfg.history.length > 30) cfg.history = cfg.history.slice(0, 30);
}

module.exports = {
  DEFAULT_CONFIG, normalizeConfig, collectReminders, runChecks, daysToRepay, todayStr,
};
