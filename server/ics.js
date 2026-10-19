'use strict';

/* ICS 日历订阅：把管卡的各类时间提醒生成为标准 iCalendar 流（RFC 5545）
 *
 * 事件类型（全部全天事件 DTSTART;VALUE=DATE）：
 *   - 还款日：payment.lastPayDate（最后可还款日 = 银行到期日 + 宽限期）
 *     · 合并账单组的成员卡合并为一条（组内还款日一致）
 *   - 年费日：nextFeeDate（下次年费收取日，>= 今天）
 *   - 账单到期：bills 流水中未还账单的 dueDate（含已逾期）
 *   - 刷卡任务截止：有月度目标卡的当月最后一天
 *   - 资产到期：会员卡/储值卡、卡/票、知识库订阅（非终身）的 expiry，
 *     日历视角展示窗口内全部到期日——不受推送提醒「提前 N 天」窗口限制
 *     （推送口径由 reminder/collectAssetExpiry 负责，两者职责不同）
 * UID 规则 guanka-<type>[-group]-<id>-<date>：跨刷新稳定，客户端据此做增量同步/去重。
 *
 * 时区策略：全天事件（VALUE=DATE）不带时区，日历客户端按本地时区解释，
 * 与原系统「本地时区 YYYY-MM-DD 字符串」的语义一致，无需 VTIMEZONE。
 *
 * 免密访问：/api/calendar.ics?token=<AUTH_TOKEN>——日历客户端无法携带
 * Cookie/Bearer，必须走 URL query token；worker.js 的 credentialOf 与
 * index.js 的 auth.guard 均已支持 ?token=，守卫层零改动。
 */

const D = require('./dates');
const U = require('./util');

const CALNAME = '管卡提醒';
const HORIZON_DAYS = 183; // 滚动窗口约 6 个月

/* ---------- RFC 5545 文本转义 + 折行 ---------- */

function esc(text) {
  return String(text == null ? '' : text)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/* 按规范 75 字节折行（多字节 UTF-8 按「75 字符」算会超限，按字节最稳妥） */
function foldLine(line) {
  const total = Buffer.byteLength(line, 'utf8');
  if (total <= 75) return line;
  const parts = [];
  let cur = '';
  let len = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (len + n > 75) { parts.push(cur); cur = ''; len = 0; }
    cur += ch;
    len += n;
  }
  if (cur) parts.push(cur);
  return parts.join('\r\n ');
}

/* YYYY-MM-DD → ICS 全天日期（无时刻、无时区） */
function icsDate(dateStr) {
  return String(dateStr || '').replace(/-/g, '');
}

function money(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

/* ---------- 事件收集 ---------- */

/** 当月最后一天（本地时区） */
function lastDayOfMonth(y, m) { // m: 1-12
  return D.daysInMonth(y, m);
}

function dstr(d) { return U.toDateStr(d); }

/**
 * 收集全部事件（纯函数，便于测试注入 now）
 * @param {Array} computed 已由 computeMyCard 算好的持卡列表
 * @param {Array} bills 账单流水
 * @param {Date} now
 * @param {Object} assetData 扩展资产 { memberships, vouchers, knowledge }（可省略，
 *                           省略时为旧调用方兼容——仅生成信用卡相关事件）
 */
function collectEvents(computed, bills, now, assetData) {
  now = now || new Date();
  const horizon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + HORIZON_DAYS);
  const events = [];
  const seen = new Set();
  const push = (ev) => {
    if (!ev || !ev.date || seen.has(ev.uid)) return;
    // 窗口外跳过（逾期账单不受窗口限制，日期必在过去）
    const t = new Date(ev.date + 'T00:00:00');
    if (isNaN(t.getTime())) return;
    if (t >= horizon) return;
    seen.add(ev.uid);
    events.push(ev);
  };

  // 合并账单组成员索引
  const groups = new Map();
  for (const m of computed || []) {
    if (!m.billGroupId) continue;
    if (!groups.has(m.billGroupId)) groups.set(m.billGroupId, []);
    groups.get(m.billGroupId).push(m);
  }
  const groupedDone = new Set(); // 组还款日只发一条

  for (const m of computed || []) {
    const name = m.alias || m.name || '未命名卡片';

    // ① 还款日（组内合并：组员还款日服务端强制一致，取首位成员的日期）
    const p = m.payment || {};
    if (p.lastPayDate) {
      if (m.billGroupId) {
        if (!groupedDone.has(m.billGroupId)) {
          groupedDone.add(m.billGroupId);
          const g = groups.get(m.billGroupId) || [];
          const members = g.map((x) => x.alias || x.name || '未命名卡片');
          push({
            uid: 'guanka-repay-group-' + m.billGroupId + '-' + p.lastPayDate,
            date: p.lastPayDate,
            title: '还款日：' + (m.billGroupName || '合并账单组') + '（' + g.length + ' 张卡）',
            desc: [
              '合并账单组还款（组内 ' + g.length + ' 张卡）',
              '成员：' + members.join('、'),
              '最后可还款日（含宽限期）：' + p.lastPayDate,
            ].join('\n'),
          });
        }
      } else {
        push({
          uid: 'guanka-repay-' + m.id + '-' + p.lastPayDate,
          date: p.lastPayDate,
          title: '还款日：' + name,
          desc: [
            '银行：' + (m.bank || '—'),
            '卡片：' + (m.name || '—') + (m.alias ? '（' + m.alias + '）' : ''),
            '本期账单日：' + (p.billDate || '—'),
            '银行到期日：' + (p.dueDate || '—'),
            '最后可还款日（含宽限期）：' + p.lastPayDate,
            '额度：¥' + money(m.creditLimit),
          ].join('\n'),
        });
      }
    }

    // ② 年费日（每卡独立，已豁免也有收取日概念——下一年是否收取决于届时刷免进度）
    if (m.nextFeeDate) {
      push({
        uid: 'guanka-fee-' + m.id + '-' + m.nextFeeDate,
        date: m.nextFeeDate,
        title: '年费日：' + name,
        desc: [
          '银行：' + (m.bank || '—'),
          '卡片：' + (m.name || '—') + (m.alias ? '（' + m.alias + '）' : ''),
          '年费：¥' + money(m.annualFee),
          '当前状态：' + (m.waiver && m.waiver.needsPayment ? '未达标（需缴费）' : '已达标/已豁免'),
          m.waiver && m.waiver.kind ? '刷免方式：' + m.waiver.kind : '',
        ].filter(Boolean).join('\n'),
      });
    }

    // ③ 刷卡任务截止：有月度目标 → 当月最后一天
    if (Number(m.monthlySpendTarget) > 0) {
      const t = new Date(now.getFullYear(), now.getMonth() + 1, 0); // 当月月末
      const end = dstr(t);
      push({
        uid: 'guanka-task-' + m.id + '-' + end,
        date: end,
        title: '刷卡任务截止：' + name,
        desc: [
          '银行：' + (m.bank || '—'),
          '卡片：' + name,
          '本月目标：¥' + money(m.monthlySpendTarget),
          '已消费：¥' + money(m.monthSpend),
          '还差：¥' + money(Math.max(0, Number(m.monthlySpendTarget) - Number(m.monthSpend || 0))),
        ].join('\n'),
      });
    }
  }

  // ④ 账单到期（未还账单，含逾期；逐条列出，含金额）
  for (const b of bills || []) {
    if (b.paid === '已还' || !b.dueDate) continue;
    const m = (computed || []).find((x) => x.id === b.myCardId) || {};
    const name = m.alias || m.name || '未命名卡片';
    push({
      uid: 'guanka-bill-' + b.myCardId + '-' + (b.month || '') + '-' + b.dueDate,
      date: b.dueDate,
      title: '账单到期：' + name + '（' + (b.month || '') + '）',
      desc: [
        '银行：' + (m.bank || '—'),
        '卡片：' + name,
        '出账月份：' + (b.month || '—'),
        '账单金额：¥' + money(b.amount),
        '到期还款日：' + b.dueDate,
        b.paid === '部分还款' ? '状态：部分还款' : '状态：未还',
      ].join('\n'),
    });
  }

  // ⑤ 资产到期（会员卡/储值卡、卡/票、知识库订阅；终身资源与无到期日的跳过）。
  //    与推送提醒不同：日历展示窗口内的全部到期日，便于提前安排使用/续费
  if (assetData && typeof assetData === 'object') {
    const scanAssets = (list, kind, label) => {
      for (const it of list || []) {
        if (!it || !it.expiry) continue; // 无到期日（包括空串）不生成事件
        const nm = it.name || it.title || '未命名';
        const sub = it.brand || it.platform || '';
        // 剩余量：membership/voucher 按类型口径；knowledge 不展示
        let remain = '';
        if (kind === 'membership') {
          remain = it.mode === 'amount' ? '剩余：¥' + money(it.balance) : '剩余：' + Math.max(0, (Number(it.totalUses) || 0) - (Number(it.usedUses) || 0)) + ' 次';
        } else if (kind === 'voucher') {
          remain = it.mode === 'amount' ? '剩余：¥' + money(it.balance) : '剩余：' + Math.max(0, (Number(it.totalUses) || 0) - (Number(it.usedUses) || 0)) + ' 次';
        }
        const desc = [
          label ? '分类：' + label : '',
          sub ? '商家/平台：' + sub : '',
          '到期日：' + it.expiry,
          remain,
        ].filter(Boolean).join('\n');
        push({
          uid: 'guanka-asset-' + kind + '-' + it.id + '-' + it.expiry,
          date: it.expiry,
          title: label + '到期：' + nm,
          desc,
        });
      }
    };
    scanAssets(assetData.memberships, 'membership', '会员卡/储值卡');
    scanAssets(assetData.vouchers, 'voucher', '卡/票');
    scanAssets((assetData.knowledge || []).filter((k) => k && !k.lifetime), 'knowledge', '知识库订阅');
  }

  // 按日期排序，稳定输出
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : String(a.uid).localeCompare(String(b.uid))));
  return events;
}

/* ---------- ICS 序列化 ---------- */

function buildICS(events, now) {
  const stamp = toUTC(new Date(now || new Date().getTime())); // DTSTAMP 必须 UTC
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//guanka//credit-card-manager//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:' + esc(CALNAME),
    'X-WR-CALDESC:' + esc('信用卡还款/年费/账单/刷卡任务 + 会员卡/卡票/知识库到期提醒'),
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
    'X-PUBLISHED-TTL:PT12H',
  ];
  for (const ev of events) {
    lines.push(
      'BEGIN:VEVENT',
      'UID:' + esc(ev.uid),
      'DTSTAMP:' + stamp,
      'DTSTART;VALUE=DATE:' + icsDate(ev.date),
      // 全天事件 DTEND 为排他日：次日
      'DTEND;VALUE=DATE:' + icsDate(nextDay(ev.date)),
      'SUMMARY:' + esc(ev.title),
      'DESCRIPTION:' + esc(ev.desc),
      'TRANSP:TRANSPARENT', // 全天提醒不占用时间块
      'CLASS:PRIVATE',
      // 提前 1 天 09:00 提醒（全天事件的 VALARM 用绝对时刻相对日期算）
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:' + esc(ev.title),
      'TRIGGER;VALUE=DATE-TIME:' + alarmTrigger(ev.date),
      'END:VALARM',
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  // 全部行做 75 字节折行
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

function nextDay(dateStr) {
  const t = new Date(dateStr + 'T00:00:00');
  return dstr(new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1));
}

function toUTC(d) {
  return d.getUTCFullYear() +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0') + 'T' +
    String(d.getUTCHours()).padStart(2, '0') +
    String(d.getUTCMinutes()).padStart(2, '0') +
    String(d.getUTCSeconds()).padStart(2, '0') + 'Z';
}

/** 前一天 09:00 本地时区的 UTC 表示（服务器本地时区） */
function alarmTrigger(dateStr) {
  const t = new Date(dateStr + 'T09:00:00'); // 本地时区
  t.setDate(t.getDate() - 1);
  return toUTC(t);
}

/** 对外入口：生成完整 ICS 文本 */
function generateICS(computed, bills, now, assetData) {
  return buildICS(collectEvents(computed, bills, now, assetData), now);
}

module.exports = { generateICS, collectEvents, _internals: { esc, foldLine, icsDate, buildICS } };
