/* ============================================================
 * 管卡 — 信用卡管理工具 前端 SPA
 * 数据全部来自 /api，无构建步骤，原生 ES2018+
 * ============================================================ */
'use strict';

// ---------- 工具 ----------
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtMoney(n) {
  const v = Number(n) || 0;
  return '¥' + v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtInt(n) { return (Number(n) || 0).toLocaleString('zh-CN'); }
function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function api(path, opts) {
  opts = opts || {};
  const headers = opts.headers || {};
  let body = opts.body;
  if (body && typeof body === 'object' && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(path, { method: opts.method || 'GET', headers, body });
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('json')) return res.text();
  const data = await res.json();
  // 未授权：统一弹登录框（服务端已把「需登录」标在 401/403 上）
  if (!res.ok) {
    if (data.needAuth || data.needToken) { showLogin(data.error); }
    throw new Error(data.error || ('请求失败 ' + res.status));
  }
  return data;
}

// ---------- 访问控制 ----------
let loginShown = false;

function showLogin(message) {
  const root = $('#modal-root');
  // 已展示则只更新提示，避免重复叠加登录层
  if (loginShown && $('#login-token')) {
    const tip = $('#login-tip');
    if (tip && message) { tip.textContent = message; tip.style.display = ''; }
    return;
  }
  loginShown = true;
  root.innerHTML =
    '<div class="modal-wrap" id="modal-wrap">' +
    '<div class="modal" id="modal" style="width:min(420px,100%)">' +
    '<div class="modal-header"><div class="modal-title">需要访问令牌</div></div>' +
    '<div class="modal-body">' +
    '<div style="font-size:13px;color:var(--text-2);line-height:1.7;margin-bottom:12px">' +
    '本服务已启用访问控制。请输入启动容器时设置的 <code>AUTH_TOKEN</code> 环境变量的值。' +
    '令牌只保存在服务端，浏览器仅持有一个 HttpOnly 会话 Cookie。' +
    '</div>' +
    '<input id="login-token" type="password" placeholder="AUTH_TOKEN" autocomplete="current-password" style="width:100%">' +
    '<div id="login-tip" style="font-size:12px;color:var(--red);margin-top:8px;display:' + (message ? '' : 'none') + '">' + esc(message || '') + '</div>' +
    '</div>' +
    '<div class="modal-footer"><button class="btn primary" id="login-submit">登录</button></div>' +
    '</div></div>';
  const wrap = $('#modal-wrap');
  requestAnimationFrame(() => { if (wrap.isConnected) wrap.classList.add('show'); });
  const input = $('#login-token');
  const submit = async () => {
    const token = input.value.trim();
    if (!token) { $('#login-tip').textContent = '请输入令牌'; $('#login-tip').style.display = ''; return; }
    try {
      await api('/api/auth/login', { method: 'POST', body: { token } });
      loginShown = false;
      $('#modal-root').innerHTML = '';
      toast('已登录');
      await loadAll();
    } catch (e) {
      $('#login-tip').textContent = e.message;
      $('#login-tip').style.display = '';
    }
  };
  $('#login-submit').addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  input.focus();
}

async function checkAuth() {
  try {
    const st = await api('/api/auth/status');
    const btn = $('#btn-logout');
    // 仅在「服务端启用了鉴权」时显示登出按钮；回环免登录模式下隐藏
    if (btn) btn.style.display = st.authRequired ? '' : 'none';
    return st;
  } catch (e) { return { authRequired: false, authorized: true }; }
}

function toast(msg, type) {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, 2600);
}

function confirmDialog(msg) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML =
      '<div class="modal show" style="width:min(400px,100%)">' +
      '<div class="modal-header"><div class="modal-title">请确认</div></div>' +
      '<div class="modal-body" style="font-size:14px">' + esc(msg) + '</div>' +
      '<div class="modal-footer">' +
      '<button class="btn" data-act="no">取消</button>' +
      '<button class="btn primary" data-act="yes">确定</button>' +
      '</div></div>';
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add('show'));
    const close = (v) => { wrap.classList.remove('show'); setTimeout(() => wrap.remove(), 200); resolve(v); };
    wrap.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (act) return close(act.dataset.act === 'yes');
      if (e.target === wrap) close(false);
    });
  });
}

// ---------- 全局状态 ----------
const state = {
  page: 'mycards',
  meta: { channels: [], categories: [], waiverTypes: [], resetCycles: [] },
  settings: { theme: 'light', bankOrder: [], banksCollapsed: {}, cardBanksCollapsed: {} },
  myCards: [],
  cards: [],
  bills: [],
  billGroups: [],
  stats: null,
  drawerId: null,
  filter: 'all',
  sort: 'name',
  // 扩展资产（移植自 Benefit Tracker）
  memberships: [],
  vouchers: [],
  voucherBrands: [],
  knowledge: [],
  assetStats: null,
  // 卡/票页筛选
  voucherTypeFilter: 'all',
  knowledgeCatFilter: 'all',
  // 会员储值页分类筛选：必须独立于 knowledgeCatFilter——
  // 此前两页共用一个状态（靠 '__mem__' 哨兵区分），会员页选中的分类会串到知识库页
  // 造成「当前分类下没有资源」的假空态，且下拉框选中态永远回退到「全部分类」
  membershipCatFilter: 'all',
};

const CYCLE_BADGE = { '自然月': 'badge-blue', '自然年': 'badge-purple', '年费日': 'badge-orange' };
const FEE_BADGE = { default: 'badge-default', yellow: 'badge-yellow', red: 'badge-red' };

// ---------- 启动 ----------
async function boot() {
  applyTheme(state.settings.theme);
  bindNav();
  await checkAuth();
  await loadAll();
}

async function loadAll() {
  // mycards 响应已合并 stats/banks（服务端一次索引计算），省去一次全量统计请求
  let settings, meta, mycardsResp, cards, bills;
  try {
    [settings, meta, mycardsResp, cards, bills] = await Promise.all([
      api('/api/settings'), api('/api/meta'), api('/api/mycards'), api('/api/cards'), api('/api/bills'),
    ]);
  } catch (e) {
    // 未授权：showLogin 已由 api() 弹出，这里静默退出避免覆盖登录层
    if (/未授权|非本地访问|令牌/.test(e.message)) return;
    throw e;
  }
  state.settings = settings;
  state.meta = meta;
  state.myCards = mycardsResp.data || mycardsResp;
  state.stats = mycardsResp.stats || (await api('/api/stats'));
  state.billGroups = mycardsResp.billGroups || [];
  state.cards = cards;
  state.bills = bills || [];
  // 扩展资产：加载失败不阻塞主页面（老备份/异常时优雅降级为空列表）
  try {
    [state.memberships, state.vouchers, state.voucherBrands, state.knowledge, state.assetStats] = await Promise.all([
      api('/api/memberships'), api('/api/vouchers'), api('/api/voucherbrands'), api('/api/knowledge'), api('/api/assets/stats'),
    ]);
  } catch (e) {
    state.memberships = []; state.vouchers = []; state.voucherBrands = []; state.knowledge = []; state.assetStats = null;
  }
  applyTheme(settings.theme || 'light');
  render();
}

function bindNav() {
  $$('.nav-item').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      state.page = a.dataset.page;
      $$('.nav-item').forEach((x) => x.classList.toggle('active', x === a));
      render();
    });
  });
  $('#theme-toggle').addEventListener('click', toggleTheme);
  $('#btn-notify').addEventListener('click', openNotifyModal);
  const logout = $('#btn-logout');
  if (logout) logout.addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch (e) { /* 忽略 */ }
    location.reload();
  });
}

// ---------- 主题 ----------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#theme-icon').textContent = theme === 'dark' ? '☀️' : '🌙';
}
async function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  state.settings.theme = next;
  try { await api('/api/settings', { method: 'PUT', body: { theme: next } }); } catch (e) { /* 忽略 */ }
}

// ---------- 渲染入口 ----------
function render() {
  const app = $('#app');
  if (state.page === 'mycards') app.innerHTML = renderMyCards();
  else if (state.page === 'vouchers') app.innerHTML = renderVouchers();
  else if (state.page === 'memberships') app.innerHTML = renderMemberships();
  else if (state.page === 'knowledge') app.innerHTML = renderKnowledge();
  else if (state.page === 'assetstats') app.innerHTML = renderAssetStats();
  else app.innerHTML = renderCardsDB();
  bindPageEvents();
  if (state.page === 'mycards') renderDrawer();
}

function orderedBanks(banks) {
  const order = state.settings.bankOrder || [];
  const known = order.filter((b) => banks.includes(b));
  const rest = banks.filter((b) => !known.includes(b)).sort((a, b) => a.localeCompare(b, 'zh'));
  return known.concat(rest);
}

// ---------- 页面一：我的持卡 ----------
function renderMyCards() {
  const s = state.stats;
  const feeNames = s.feeExpiring.map((f) => esc(f.name)).join('、');
  let html =
    '<div class="stats">' +
    statCard('持卡总数', fmtInt(s.totalCards) + ' 张', '共 ' + fmtInt(s.totalBanks) + ' 家银行', false) +
    statCard('各银行最高授信合计', fmtMoney(s.maxCreditSum), '每家银行取最高额度相加', false) +
    statCard('本月总消费', fmtMoney(s.monthSpend), '年度总消费 ' + fmtMoney(s.yearSpend), false) +
    statCard('年费即将到期', fmtInt(s.feeExpiring.length) + ' 张', s.feeExpiring.length ? '30 天内需缴费：' + feeNames : '暂无需要缴费的卡', s.feeExpiring.length > 0, 'stat-fee-expiring') +
    '</div>' +
    '<div class="toolbar">' +
    '<button class="btn primary" id="btn-add-card">＋ 添加持卡</button>' +
    '<button class="btn" id="btn-billgroups">合并账单</button>' +
    '<button class="btn" id="btn-export">导出持卡</button>' +
    '<button class="btn" id="btn-mycards-import">批量导入</button>' +
    '<button class="btn" id="btn-backup-export">备份</button>' +
    '<button class="btn" id="btn-backup-import">恢复</button>' +
    '<select id="filter-select" class="filter-select">' +
    option('all', '全部卡片', true) + option('repay', '本月需还款', true) + option('fee', '年费临近(30天)', true) +
    option('met', '年费已达标', true) + option('unpaid', '有未还账单', true) + option('benefit', '有剩余权益', true) +
    '</select>' +
    '<select id="sort-select" class="filter-select">' +
    option('name', '按名称') + option('fee', '按年费临近') + option('repay', '按还款临近') + option('bank', '按银行') +
    '</select>' +
    '<div class="spacer"></div>' +
    '<span style="font-size:12px;color:var(--text-3)">数据自动保存，重启与升级都不丢失</span>' +
    '</div>';

  if (!state.myCards.length) {
    return html + '<div class="empty-tip">还没有持卡，点右上角「添加持卡」开始管理吧</div>';
  }

  const filtered = applyFilterSort(state.myCards);
  if (!filtered.length) {
    return html + '<div class="empty-tip">当前筛选条件下没有卡片，换个筛选试试</div>';
  }

  // 非名称/银行排序时以平铺列表展示（排序优先级高于分组）
  if (state.sort !== 'name' && state.sort !== 'bank') {
    return html + '<div class="bank-group"><div class="bank-body">' + filtered.map(cardRowHtml).join('') + '</div></div>';
  }

  const byBank = {};
  for (const m of filtered) {
    if (!byBank[m.bank]) byBank[m.bank] = [];
    byBank[m.bank].push(m);
  }
  const collapsed = state.settings.banksCollapsed || {};
  for (const bank of orderedBanks(Object.keys(byBank))) {
    const list = byBank[bank].slice().sort((a, b) => (a.alias || a.name).localeCompare(b.alias || b.name, 'zh'));
    const isCollapsed = !!collapsed[bank];
    html +=
      '<div class="bank-group' + (isCollapsed ? ' collapsed' : '') + '" data-bank="' + esc(bank) + '">' +
      '<div class="bank-header" data-act="toggle-bank">' +
      '<span class="collapse-arrow">▾</span>' +
      '<span class="bank-name">' + esc(bank) + '</span>' +
      '<span class="bank-count">' + list.length + ' 张</span>' +
      '<span class="bank-actions">' +
      '<button class="btn icon" data-act="bank-up" title="上移银行">↑</button>' +
      '<button class="btn icon" data-act="bank-down" title="下移银行">↓</button>' +
      '</span></div>' +
      '<div class="bank-body">';
    for (const m of list) html += cardRowHtml(m);
    html += '</div></div>';
  }
  return html;
}

// isFilter：filter 与 sort 下拉框取值有交集（fee/repay），选中态必须各比各的，否则交叉误标
function option(value, label, isFilter) {
  const sel = isFilter ? state.filter === value : state.sort === value;
  return '<option value="' + value + '"' + (sel ? ' selected' : '') + '>' + label + '</option>';
}

function applyFilterSort(list) {
  let out = list.slice();
  const f = state.filter;
  if (f === 'repay') out = out.filter((m) => (m.payment && m.payment.payDaysLeft <= 7));
  else if (f === 'fee') out = out.filter((m) => m.waiver.needsPayment && m.feeDays <= 30);
  else if (f === 'met') out = out.filter((m) => m.feeStatus && m.feeStatus !== '未达标');
  else if (f === 'unpaid') out = out.filter((m) => unpaidCount(m) > 0);
  else if (f === 'benefit') out = out.filter((m) => (m.benefits || []).some((b) => b.total < 0 || (b.remaining != null && b.remaining > 0)));
  const s = state.sort;
  if (s === 'fee') out.sort((a, b) => a.feeDays - b.feeDays);
  else if (s === 'repay') out.sort((a, b) => (a.payment ? a.payment.payDaysLeft : 999) - (b.payment ? b.payment.payDaysLeft : 999));
  else if (s === 'bank') out.sort((a, b) => String(a.bank).localeCompare(String(b.bank), 'zh'));
  return out;
}

function statCard(label, value, sub, warn, id) {
  return '<div class="stat-card' + (id ? ' clickable' : '') + '"' + (id ? ' id="' + id + '"' : '') + '>' +
    '<div class="stat-label">' + label + '</div>' +
    '<div class="stat-value' + (warn ? ' warn' : '') + '">' + value + '</div>' +
    '<div class="stat-sub">' + sub + '</div></div>';
}

function cardRowHtml(m) {
  const p = m.payment || {};
  const groupBadge = m.billGroupId
    ? '<span class="badge badge-purple" title="已合并账单：还款提醒只推 1 条">合并账单 · ' + esc(m.billGroupName || '未命名组') + '</span>'
    : '';
  return '<div class="card-row" data-id="' + m.id + '">' +
    '<div><div class="card-name">' + esc(m.name) + (m.alias ? '<span class="alias">“' + esc(m.alias) + '”</span>' : '') + (groupBadge ? ' ' + groupBadge : '') + '</div>' +
    '<div class="card-sub">' + esc(m.bank) + ' · ' + esc(m.org) + ' · ' + esc(m.level) + ' · 额度 ' + fmtMoney(m.creditLimit) + (m.last4 ? ' · 尾号 ' + esc(m.last4) : '') + '</div>' +
    '<div class="card-sub">还款 ' + esc(p.dueDate || '—') + (p.lastPayDate && p.lastPayDate !== p.dueDate ? '（最晚 ' + esc(p.lastPayDate) + '）' : '') + ' · 账单日 ' + (m.billingDay || '—') + '</div></div>' +
    '<div class="waiver-cell">' + waiverCellHtml(m) + '</div>' +
    '<div class="fee-cell">' + repayBadgeHtml(m) + ' ' + feeBadgeHtml(m) + '</div>' +
    '<div><button class="btn small" data-act="detail">详情</button></div>' +
    '</div>';
}

const REPAY_BADGE = { '已逾期': 'badge-red', '今日到期': 'badge-red', '3天内': 'badge-yellow', '本周内': 'badge-yellow', '正常': 'badge-default' };
const FEE_ALERT_BADGE = { '无年费': 'badge-green', '本年豁免': 'badge-green', '已过日': 'badge-red', '7天内': 'badge-red', '本月内': 'badge-yellow', '正常': 'badge-default' };

function repayBadgeHtml(m) {
  const p = m.payment || {};
  const txt = p.repayAlert || '正常';
  if (txt === '正常') return '';
  return '<span class="badge ' + (REPAY_BADGE[txt] || 'badge-default') + '">还款' + esc(txt) + '</span>';
}

function feeBadgeHtml(m) {
  const alert = m.feeAlert;
  // 豁免态直接显示状态；其余保留「还有 N 天」主信息，再叠加预警标签
  if (alert === '无年费' || alert === '本年豁免') return '<span class="badge badge-green">' + esc(alert) + '</span>';
  const cls = FEE_ALERT_BADGE[alert] || (FEE_BADGE[m.feeDaysColor] || 'badge-default');
  const main = m.waiver.needsPayment ? '年费还有 ' + m.feeDays + ' 天' : '年费已免';
  let s = '<span class="badge ' + cls + '">' + main + '</span>';
  if (alert && alert !== '正常') s += ' <span class="badge ' + cls + '">' + esc(alert) + '</span>';
  return s;
}

function waiverCellHtml(m) {
  const w = m.waiver;
  switch (w.kind) {
    case '免年费':
      return '<span class="badge badge-green">免年费</span>';
    case '刚性':
      return '<span class="badge badge-red">刚性年费</span>';
    case '积分抵扣': {
      const on = m.pointsDeducted;
      return '<button class="slider-toggle' + (on ? ' on' : '') + '" data-act="toggle-points" data-id="' + m.id + '" title="点击切换抵扣状态">' +
        '<span class="slider-track"><span class="slider-knob"></span></span>' +
        '<span><span class="slider-label">' + (on ? '已抵扣' : '未抵扣') + '</span>' +
        (on && m.pointsDeductDate ? '<div class="slider-date">' + esc(m.pointsDeductDate) + '</div>' : '') +
        '</span></button>';
    }
    case '资产存免': {
      const on = m.assetWaived;
      return '<button class="slider-toggle' + (on ? ' on' : '') + '" data-act="toggle-asset" data-id="' + m.id + '" title="需要存款 ' + esc(m.waiverCondition || '0') + '，达标后点击标记">' +
        '<span class="slider-track"><span class="slider-knob"></span></span>' +
        '<span><span class="slider-label">' + (on ? '已达标' : '未达标') + '</span>' +
        (on && m.assetWaivedDate ? '<div class="slider-date">' + esc(m.assetWaivedDate) + '</div>' : '') +
        '</span></button>';
    }
    case '消费刷免':
    case '笔数刷免': {
      const pct = w.target > 0 ? Math.min(100, Math.round((w.progress / w.target) * 100)) : 0;
      const unit = w.unit === '元' ? fmtMoney(w.progress) + ' / ' + fmtMoney(w.target) : fmtInt(w.progress) + ' / ' + fmtInt(w.target) + ' 笔';
      const done = w.met;
      return '<div class="progress">' +
        '<div class="progress-track"><div class="progress-fill' + (done ? ' done' : '') + '" style="width:' + pct + '%"></div></div>' +
        '<div class="progress-text"><span>' + unit + '</span>' +
        (done ? '<span style="color:var(--green);font-weight:600">已达标</span>'
          : '<span class="remaining">剩余 ' + (w.unit === '元' ? fmtMoney(w.remaining) : fmtInt(w.remaining) + ' 笔') + '</span>') +
        '</div></div>';
    }
    default:
      return '';
  }
}

// ---------- 页面二：卡种数据库 ----------
function renderCardsDB() {
  let html =
    '<div class="page-title">卡种数据库</div>' +
    '<div class="page-desc">市面上常见卡的重要信息（内置 ' + state.cards.length + ' 张 / ' + new Set(state.cards.map((c) => c.bank)).size + ' 家银行），添加持卡时从这里选卡</div>' +
    '<div class="toolbar">' +
    '<button class="btn primary" id="btn-new-card-type">＋ 新增卡种</button>' +
    '<button class="btn" id="btn-import">批量导入 CSV</button>' +
    '<div class="spacer"></div></div>';

  if (!state.cards.length) return html + '<div class="empty-tip">卡种库为空，点「新增卡种」或「批量导入」添加</div>';

  const byBank = {};
  for (const c of state.cards) {
    if (!byBank[c.bank]) byBank[c.bank] = [];
    byBank[c.bank].push(c);
  }
  const collapsed = state.settings.cardBanksCollapsed || {};
  for (const bank of orderedBanks(Object.keys(byBank))) {
    const list = byBank[bank].slice().sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    const isCollapsed = collapsed[bank] !== false; // 首次默认收起
    html +=
      '<div class="bank-group' + (isCollapsed ? ' collapsed' : '') + '" data-bank="' + esc(bank) + '">' +
      '<div class="bank-header" data-act="toggle-cardbank">' +
      '<span class="collapse-arrow">▾</span><span class="bank-name">' + esc(bank) + '</span>' +
      '<span class="bank-count">' + list.length + ' 张</span>' +
      '</div><div class="bank-body"><table class="db-table"><thead><tr>' +
      '<th>卡片名称</th><th>卡组织</th><th>卡等级</th><th>起批额度</th><th>年费</th><th>免年费类型</th><th>免年费政策</th><th>主要权益</th><th>操作</th>' +
      '</tr></thead><tbody>';
    for (const c of list) {
      html += '<tr data-id="' + c.id + '">' +
        '<td><b>' + esc(c.name) + '</b></td>' +
        '<td>' + esc(c.org) + '</td>' +
        '<td>' + esc(c.level) + '</td>' +
        '<td>' + (c.startCredit ? fmtMoney(c.startCredit) : '—') + '</td>' +
        '<td>' + (c.annualFee ? fmtMoney(c.annualFee) : '免') + '</td>' +
        '<td>' + esc(c.waiverType) + (c.waiverCondition && c.waiverCondition !== '0' ? '（' + esc(c.waiverCondition) + '）' : '') + '</td>' +
        '<td style="max-width:180px">' + esc(c.waiverPolicy) + '</td>' +
        '<td class="db-benefits">' + esc((c.benefits || []).join(' | ')) + '</td>' +
        '<td class="db-actions">' +
        '<button class="btn small" data-act="edit-card-type">编辑</button>' +
        '<button class="btn small danger" data-act="del-card-type">删除</button>' +
        '</td></tr>';
    }
    html += '</tbody></table></div></div>';
  }
  return html;
}

// ---------- 页面事件 ----------
function bindPageEvents() {
  const app = $('#app');

  // 统计卡：年费到期点击
  const feeCard = $('#stat-fee-expiring', app);
  if (feeCard) feeCard.addEventListener('click', showFeeExpiring);

  // 添加持卡 / 导出
  const addBtn = $('#btn-add-card', app);
  if (addBtn) addBtn.addEventListener('click', openAddCardModal);
  const expBtn = $('#btn-export', app);
  if (expBtn) expBtn.addEventListener('click', exportCards);
  const backupExpBtn = $('#btn-backup-export', app);
  if (backupExpBtn) backupExpBtn.addEventListener('click', exportBackup);
  const backupImpBtn = $('#btn-backup-import', app);
  if (backupImpBtn) backupImpBtn.addEventListener('click', openBackupImportModal);
  const myImportBtn = $('#btn-mycards-import', app);
  if (myImportBtn) myImportBtn.addEventListener('click', openMyCardsImportModal);
  const bgBtn = $('#btn-billgroups', app);
  if (bgBtn) bgBtn.addEventListener('click', openBillGroupsModal);

  const filterSel = $('#filter-select', app);
  if (filterSel) filterSel.addEventListener('change', (e) => { state.filter = e.target.value; render(); });
  const sortSel = $('#sort-select', app);
  if (sortSel) sortSel.addEventListener('change', (e) => { state.sort = e.target.value; render(); });

  // 卡种库按钮
  const newType = $('#btn-new-card-type', app);
  if (newType) newType.addEventListener('click', () => openCardTypeModal(null));
  const impBtn = $('#btn-import', app);
  if (impBtn) impBtn.addEventListener('click', openImportModal);

  // 银行分组
  $$('.bank-header', app).forEach((h) => {
    h.addEventListener('click', (e) => {
      const actEl = e.target.closest('[data-act]');
      const group = h.closest('.bank-group');
      const bank = group.dataset.bank;
      if (actEl && actEl.dataset.act === 'bank-up') { e.stopPropagation(); moveBank(bank, -1); return; }
      if (actEl && actEl.dataset.act === 'bank-down') { e.stopPropagation(); moveBank(bank, 1); return; }
      if (actEl && actEl.dataset.act === 'toggle-bank') toggleCollapse('banksCollapsed', bank);
      if (actEl && actEl.dataset.act === 'toggle-cardbank') toggleCollapse('cardBanksCollapsed', bank);
    });
  });

  // 持卡行
  $$('.card-row', app).forEach((row) => {
    $('[data-act="detail"]', row).addEventListener('click', () => openDrawer(row.dataset.id));
    const pts = $('[data-act="toggle-points"]', row);
    if (pts) pts.addEventListener('click', (e) => { e.stopPropagation(); togglePoints(row.dataset.id); });
    const asset = $('[data-act="toggle-asset"]', row);
    if (asset) asset.addEventListener('click', (e) => { e.stopPropagation(); toggleAsset(row.dataset.id); });
  });

  // 卡种库行
  $$('.db-table tbody tr', app).forEach((tr) => {
    const id = tr.dataset.id;
    $('[data-act="edit-card-type"]', tr).addEventListener('click', () => openCardTypeModal(id));
    $('[data-act="del-card-type"]', tr).addEventListener('click', () => deleteCardType(id));
  });

  // 扩展资产页面（卡/票 · 会员储值 · 知识库 · 统计）
  bindAssetPageEvents();
}

async function toggleCollapse(key, bank) {
  state.settings[key] = state.settings[key] || {};
  state.settings[key][bank] = !state.settings[key][bank];
  render();
  try { await api('/api/settings', { method: 'PUT', body: { [key]: state.settings[key] } }); } catch (e) { /* 忽略 */ }
}

async function moveBank(bank, dir) {
  const banks = orderedBanks([...new Set(state.myCards.map((m) => m.bank))]);
  const i = banks.indexOf(bank);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= banks.length) return;
  banks.splice(j, 0, banks.splice(i, 1)[0]);
  state.settings.bankOrder = banks;
  render();
  try { await api('/api/settings', { method: 'PUT', body: { bankOrder: banks } }); } catch (e) { /* 忽略 */ }
}

async function togglePoints(id) {
  const m = state.myCards.find((x) => x.id === id);
  if (!m) return;
  try {
    await api('/api/mycards/' + id + '/points', { method: 'POST', body: { value: !m.pointsDeducted } });
    toast(m.pointsDeducted ? '已取消抵扣标记' : '已标记积分抵扣');
    await loadAll();
  } catch (e) { toast(e.message, 'error'); }
}

async function toggleAsset(id) {
  const m = state.myCards.find((x) => x.id === id);
  if (!m) return;
  try {
    await api('/api/mycards/' + id + '/asset', { method: 'POST', body: { value: !m.assetWaived } });
    toast(m.assetWaived ? '已取消达标标记' : '已标记资产达标');
    await loadAll();
  } catch (e) { toast(e.message, 'error'); }
}

async function exportCards() {
  if (!state.myCards.length) return toast('还没有持卡可导出', 'error');
  // 下载是浏览器直接发起的新导航，不经过 api()，因此需要手动带上会话凭据：
  // 优先用 fetch + Blob（Cookie 自动携带），失败再退化为带 token 的 location 跳转。
  try {
    const res = await fetch('/api/cards/export');
    if (!res.ok) {
      const ct = res.headers.get('content-type') || '';
      const msg = ct.includes('json') ? (await res.json()).error : ('导出失败 ' + res.status);
      if (res.status === 401 || res.status === 403) showLogin(msg);
      return toast(msg, 'error');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cards-export.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    toast('导出失败：' + e.message, 'error');
  }
}

// ---------- 持卡备份：导出（全量 JSON，含权益/消费/账单） ----------
async function exportBackup() {
  if (!state.myCards.length && !state.memberships.length && !state.vouchers.length && !state.knowledge.length) return toast('还没有可备份的数据', 'error');
  try {
    const res = await fetch('/api/mycards/export');
    if (!res.ok) {
      const ct = res.headers.get('content-type') || '';
      const msg = ct.includes('json') ? (await res.json()).error : ('备份导出失败 ' + res.status);
      if (res.status === 401 || res.status === 403) showLogin(msg);
      return toast(msg, 'error');
    }
    const blob = await res.blob();
    // 文件名优先取服务端 Content-Disposition（带日期），取不到就用固定名
    const cd = res.headers.get('content-disposition') || '';
    const m = cd.match(/filename="([^"]+)"/);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (m && m[1]) || 'guanka-backup.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('备份已下载（含持卡、权益、消费、账单）');
  } catch (e) {
    toast('备份导出失败：' + e.message, 'error');
  }
}

// ---------- 持卡备份：恢复（JSON 导入，merge / replace 两种模式） ----------
function openBackupImportModal() {
  openModal('<div class="modal-title">从备份恢复持卡</div>',
    '<div style="font-size:12px;color:var(--text-2);margin-bottom:10px">支持本应用导出的备份 JSON 文件（guanka-backup-*.json）。' +
    '<br>恢复时会自动匹配卡种库（银行+名称+卡组织+卡等级），匹配不上的卡种会自动创建。</div>' +
    '<div class="field" style="margin-bottom:10px"><label>选择备份文件</label><input type="file" id="backup-file" accept=".json,application/json"></div>' +
    '<div class="field" style="margin-bottom:10px"><label>恢复方式</label>' +
    '<select id="backup-mode" style="width:100%">' +
    '<option value="merge">合并（推荐）— 保留现有数据，追加备份中的卡与记录</option>' +
    '<option value="replace">覆盖 — 清空现有持卡数据，完全以备份为准</option>' +
    '</select></div>' +
    '<div id="backup-warn" style="display:none;font-size:12px;color:#c0392b;margin-bottom:8px">⚠️ 覆盖模式会先清空现有持卡、消费、权益与账单数据，且不可撤销，请确认已有备份文件。</div>' +
    '<div id="backup-result" style="margin-top:10px"></div>',
    '<button class="btn" data-close>取消</button><button class="btn primary" id="btn-do-backup-import">开始恢复</button>');
  $('#backup-mode').addEventListener('change', (e) => {
    $('#backup-warn').style.display = e.target.value === 'replace' ? 'block' : 'none';
  });
  $('#btn-do-backup-import').addEventListener('click', async () => {
    const btn = $('#btn-do-backup-import');
    if (btn.disabled) return;
    const file = $('#backup-file').files[0];
    if (!file) return toast('请选择备份 JSON 文件', 'error');
    const mode = $('#backup-mode').value;
    if (mode === 'replace' && !confirm('确定覆盖？现有持卡、消费、权益与账单数据将被清空，以备份文件为准，不可撤销。\n\n建议先点「备份」导出当前数据再操作。')) return;
    btn.disabled = true;
    try {
      // 前置大小检查：后端 body 上限 20MB（上限内 JSON 结构开销略超原始数据），
      // 超限文件直接拒绝，避免浏览器先全量读入+parse 数十 MB 导致页面卡死
      if (file.size > 22 * 1024 * 1024) {
        throw new Error('备份文件 ' + (file.size / 1024 / 1024).toFixed(1) + 'MB 超过 22MB 上限，请拆分后导入');
      }
      const data = JSON.parse(await file.text());
      const r = await api('/api/mycards/import', { method: 'POST', body: { data, mode } });
      const badges =
        '<div class="badge badge-green">恢复 ' + r.importedCards + ' 张持卡</div> ' +
        (r.dedupedCards > 0 ? '<div class="badge badge-yellow" style="margin-left:6px">已存在跳过 ' + r.dedupedCards + ' 张</div>' : '') +
        (r.skippedCards > 0 ? '<div class="badge badge-yellow" style="margin-left:6px">卡种匹配失败 ' + r.skippedCards + ' 张</div>' : '') +
        (r.cardTypesAdded > 0 ? '<div class="badge badge-green" style="margin-left:6px">新建卡种 ' + r.cardTypesAdded + ' 个</div>' : '') +
        '<div class="badge" style="margin-left:6px">消费 ' + r.consumptions + ' 条 · 权益 ' + r.benefitRecords + ' 条 · 账单 ' + r.bills + ' 条</div>';
      // v2 备份的四类扩展资产计数（旧备份无此字段则不展示）
      const assetParts = [];
      if (r.memberships != null) assetParts.push('会员卡 ' + r.memberships);
      if (r.vouchers != null) assetParts.push('卡/票 ' + r.vouchers);
      if (r.voucherBrands != null) assetParts.push('商家 ' + r.voucherBrands);
      if (r.knowledge != null) assetParts.push('知识库 ' + r.knowledge);
      if (assetParts.length) badges += '<div class="badge badge-blue" style="margin-left:6px">资产：' + assetParts.join(' · ') + '</div>';
      $('#backup-result').innerHTML = badges +
        (r.groupWarnings && r.groupWarnings.length
          ? '<div style="font-size:12px;color:#b8860b;margin-top:6px">' + r.groupWarnings.map(esc).join('<br>') + '</div>' : '');
      toast('恢复完成');
      await loadAll();
    } catch (e) { toast(e.message, 'error'); }
    btn.disabled = false;
  });
}

// ---------- 持卡批量导入：CSV（含模板下载） ----------
// 与「卡种批量导入」同构，但落的是「我的持卡」。
// 前 4 列（银行/卡片名称/卡组织/卡等级）用于匹配卡种库；库里没有会自动补建卡种。
function openMyCardsImportModal() {
  const header = (state.meta.mycardsCsvHeader || []).join(',');
  const maxCards = state.meta.maxImportCards || 500;
  openModal(
    '<div class="modal-title">批量导入持卡（CSV）</div>',
    '<div style="font-size:12px;color:var(--text-2);margin-bottom:10px;line-height:1.7">' +
    '前 4 列 <b>银行、卡片名称、卡组织、卡等级</b> 用于匹配卡种库；库里没有的卡会<b>自动补建卡种</b>。' +
    '<br>同一张卡（同卡种 + 同后四位）已存在时会自动跳过，重复导入不会产生重复持卡。' +
    '<br>权益列写法：<code>名称:次数:周期</code>，多条用 <code>|</code> 分隔，例如 <code>机场贵宾厅:6:自然年|生日10倍积分:1:自然年</code>（次数填 <code>-1</code> 表示不限次）。' +
    '<br>单次最多导入 ' + maxCards + ' 行。</div>' +
    '<div id="myimp-step1">' +
    '<div class="field" style="margin-bottom:10px"><label>① 下载模板（含表头与 2 行示例，用 Excel 打开填好再上传）</label>' +
    '<button class="btn" id="btn-myimp-template" type="button">下载 CSV 模板</button>' +
    '<span style="font-size:12px;color:var(--text-3);margin-left:8px">列顺序：' + esc(header) + '</span></div>' +
    '<div class="field" style="margin-bottom:10px"><label>② 选择填好的 CSV 文件</label><input type="file" id="myimp-file" accept=".csv,text/csv"></div>' +
    '<div class="field"><label>或直接粘贴 CSV 内容</label><textarea id="myimp-text" style="min-height:120px" placeholder="银行,卡片名称,卡组织,卡等级,别名,…"></textarea></div>' +
    '</div>' +
    '<div id="myimp-result" style="margin-top:10px"></div>',
    '<button class="btn" data-close>取消</button><button class="btn primary" id="btn-do-myimp">开始导入</button>'
  );

  $('#btn-myimp-template').addEventListener('click', downloadMyCardsTemplate);

  $('#btn-do-myimp').addEventListener('click', async () => {
    const btn = $('#btn-do-myimp');
    if (btn.disabled) return; // 防重复提交：文件读取 + 服务端解析期间按钮置灰
    const file = $('#myimp-file').files[0];
    let text = $('#myimp-text').value;
    if (file) {
      try { text = await file.text(); }
      catch (e) { return toast('文件读取失败：' + (e.message || e.name), 'error'); }
    }
    if (!text.trim()) return toast('请选择文件或粘贴 CSV 内容', 'error');
    // 前置拦截：BOM 之外的行数明显超限时直接拒绝，省去一次无用上传
    const lineGuess = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).filter((l) => l.trim()).length - 1;
    if (lineGuess > maxCards) return toast('CSV 约 ' + lineGuess + ' 行，超过单次上限 ' + maxCards + ' 行', 'error');

    btn.disabled = true;
    btn.textContent = '导入中…';
    try {
      const r = await api('/api/mycards/import-csv', { method: 'POST', body: { csv: text } });
      renderMyCardsImportResult(r);
      if (r.added > 0) toast('导入完成：新增 ' + r.added + ' 张持卡');
      else toast('没有新增持卡，请查看下方明细');
      await loadAll();
      const again = $('#btn-do-myimp');
      if (again) { again.disabled = false; again.textContent = '再次导入'; }
      return;
    } catch (e) {
      toast(e.message, 'error');
    }
    btn.disabled = false;
    btn.textContent = '开始导入';
  });
}

function downloadMyCardsTemplate() {
  // 走 api() 而非 <a href>：未登录/令牌失效时能给出可读提示，而不是静默下载一段 JSON
  api('/api/mycards/template.csv')
    .then((csv) => {
      let text = typeof csv === 'string' ? csv : String(csv);
      // fetch 的 Response.text() 按规范会剥掉开头的 BOM，直接落盘会让 Excel 把中文读成乱码
      //（Windows 版 Excel 靠 BOM 判定 UTF-8）——这里补回来。
      if (text.charCodeAt(0) !== 0xFEFF) text = '\uFEFF' + text;
      const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'mycards-template.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('模板已下载，用 Excel 填好后回到这里导入');
    })
    .catch((e) => toast('模板下载失败：' + e.message, 'error'));
}

function renderMyCardsImportResult(r) {
  const parts = [];
  parts.push('<div class="badge badge-green">新增 ' + r.added + ' 张持卡</div>');
  if (r.skipped.length) parts.push('<div class="badge badge-yellow" style="margin-left:6px">跳过 ' + r.skipped.length + ' 张（已存在）</div>');
  if (r.errors.length) parts.push('<div class="badge badge-red" style="margin-left:6px">' + r.errors.length + ' 行有误</div>');
  if (r.cardTypesAdded) parts.push('<div class="badge badge-green" style="margin-left:6px">自动新建卡种 ' + r.cardTypesAdded + ' 个</div>');
  parts.push('<div class="badge" style="margin-left:6px">当前共 ' + r.total + ' 张持卡</div>');

  let detail = '';
  const rows = [];
  for (const s of r.skipped) rows.push('<tr><td>' + s.line + '</td><td>' + esc(s.name || '') + '</td><td style="color:#b8860b">跳过</td><td>' + esc(s.msg) + '</td></tr>');
  for (const e of r.errors) rows.push('<tr><td>' + e.line + '</td><td>' + esc(e.name || '') + '</td><td style="color:#c0392b">有误</td><td>' + esc(e.msg) + '</td></tr>');
  if (rows.length) {
    detail = '<div style="margin-top:8px;max-height:200px;overflow:auto"><table class="record-table"><thead><tr><th>行号</th><th>卡片</th><th>结果</th><th>说明</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
  }
  $('#myimp-result').innerHTML = parts.join('') + detail;
}

function showFeeExpiring() {
  const list = state.stats.feeExpiring;
  if (!list.length) return toast('30 天内没有需要缴费的卡');
  openModal(
    '<div class="modal-title">年费即将到期（30 天内需缴费）</div>',
    '<table class="record-table"><thead><tr><th>卡片</th><th>银行</th><th>年费</th><th>剩余天数</th></tr></thead><tbody>' +
    list.map((f) => '<tr><td>' + esc(f.name) + '</td><td>' + esc(f.bank) + '</td><td>' + fmtMoney(f.annualFee) + '</td><td style="color:var(--red);font-weight:700">' + f.feeDays + ' 天</td></tr>').join('') +
    '</tbody></table>',
    '<button class="btn primary" data-close>关闭</button>'
  );
}

// ---------- 提醒设置 ----------
function notifyModalHtml(cfg) {
  const c = cfg.channels || {};
  const ch = (key, label, desc, fields) =>
    '<div class="notify-channel">' +
    '<div class="nc-head"><label class="switch"><input type="checkbox" id="nc-' + key + '-enabled"' + (c[key] && c[key].enabled ? ' checked' : '') + '><b>' + label + '</b></label>' +
    '<span class="nc-desc">' + desc + '</span></div>' +
    '<div class="form-grid nc-body">' + fields.map((f) => field(f[1], '<input id="nc-' + key + '-' + f[0] + '"' + (f[2] === 'password' ? ' type="password"' : (f[2] === 'number' ? ' type="number"' : '')) + ' placeholder="' + esc(f[3] || '') + '" value="' + esc((c[key] && c[key][f[0]]) != null ? String(c[key][f[0]]) : '') + '">')).join('') + '</div></div>';

  return (
    '<label class="switch-row"><input type="checkbox" id="n-enabled"' + (cfg.enabled ? ' checked' : '') + '> <b>启用提醒</b>（容器常驻进程定时检查，无需 cron）</label>' +
    ch('wxpusher', 'WxPusher', '微信推送：wxpusher 后台获取 appToken，UID 为接收用户',
      [['appToken', 'appToken', 'password', 'AT_xxx'], ['uids', 'UID（多个用逗号分隔）', 'text', 'UID_xxx'], ['topicIds', '主题ID（可选）', 'text', ''], ['summaryPrefix', '消息前缀', 'text', '管卡提醒']]) +
    ch('serverchan', 'Server酱³', '微信/多端推送：sct.ftqq.com 获取 SendKey（SCT/SCU 开头）',
      [['sendkey', 'SendKey', 'password', 'SCTxxxxx']]) +
    ch('bark', 'Bark', 'iOS 推送：Bark App 中复制 deviceKey（自建服务可改服务器地址）',
      [['deviceKey', 'deviceKey', 'password', ''], ['server', '服务器地址', 'text', 'https://api.day.app'], ['level', '推送级别', 'text', 'active'], ['group', '分组', 'text', '管卡']]) +
    '<div class="notify-rules"><h4>提醒规则</h4><div class="form-grid">' +
    field('年费提前提醒天数（逗号分隔）', '<input id="n-feeDays" value="' + esc((cfg.rules.feeDays || []).join(',')) + '" placeholder="30,7,1">') +
    field('还款日提前天数（0=关闭）', '<input id="n-repayDays" type="number" min="0" value="' + esc(cfg.rules.repayBeforeDays) + '">') +
    field('月任务月末提醒天数（0=关闭）', '<input id="n-taskDays" type="number" min="0" value="' + esc(cfg.rules.taskRemainDays) + '">') +
    field('账单到期提前天数', '<input id="n-billDays" type="number" min="0" value="' + esc(cfg.rules.billBeforeDays) + '">') +
    field('资产到期提前天数（0=关闭）', '<input id="n-assetDays" type="number" min="0" max="90" value="' + esc(cfg.rules.assetExpiryDays != null ? cfg.rules.assetExpiryDays : 7) + '">') +
    field('检查间隔（分钟，最小 5）', '<input id="n-interval" type="number" min="5" value="' + esc(cfg.intervalMinutes) + '">') +
    '<div class="field full"><label>账单已过到期日仍未还时提醒</label><select id="n-billOverdue"><option value="1"' + (cfg.rules.billOverdueRemind ? ' selected' : '') + '>开启</option><option value="0"' + (!cfg.rules.billOverdueRemind ? ' selected' : '') + '>关闭</option></select></div>' +
    '</div></div>' +
    '<div class="notify-rules"><h4>日历订阅（ICS）</h4>' +
    '<div style="font-size:12px;color:var(--text-2);line-height:1.7;margin-bottom:8px">' +
    '把还款日、年费日、账单到期、刷卡任务截止导入系统日历（Apple 日历 / Google 日历 / Outlook 等订阅后自动更新）。' +
    '因日历客户端无法携带登录 Cookie，订阅链接需带访问令牌——在下方输入令牌生成完整链接，或手动拼接 <code>/api/calendar.ics?token=你的令牌</code>。' +
    '</div>' +
    '<div class="form-grid">' +
    '<div class="field full"><label>访问令牌（仅用于本地拼链接，不会发送保存）</label><input id="n-ics-token" type="password" placeholder="AUTH_TOKEN" autocomplete="off"></div>' +
    '</div>' +
    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px">' +
    '<button class="btn" id="n-ics-gen" type="button">生成订阅链接</button>' +
    '<button class="btn" id="n-ics-copy" type="button" style="display:none">复制链接</button>' +
    '</div>' +
    '<div id="n-ics-out" style="margin-top:8px;display:none">' +
    '<input id="n-ics-url" readonly style="width:100%;font-size:12px;font-family:monospace;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-2);color:var(--text-1)">' +
    '<div style="font-size:11px;color:var(--text-3);margin-top:4px">包含事件：还款日（含宽限期）、年费日、账单到期（未还含逾期）、刷卡任务截止；约 6 个月滚动窗口；提前 1 天提醒。</div>' +
    '</div>' +
    '</div>' +
    '<div id="n-result" class="notify-result"></div>' +
    (cfg.history && cfg.history.length ? '<div class="notify-rules"><h4>最近推送记录</h4>' +
      cfg.history.slice(0, 8).map((h) => '<div class="nh-item"><span class="badge ' + (h.ok ? 'badge-green' : 'badge-red') + '">' + (h.ok ? '已推送' : '失败') + '</span>' +
        '<span class="nh-title">' + esc(h.title) + '</span><span class="nh-time">' + esc(String(h.time).slice(0, 16).replace('T', ' ')) + '</span>' +
        (h.channels || []).map((s2) => '<span class="nh-ch">' + esc(s2.label) + (s2.ok ? ' ✓' : ' ✗') + (s2.ok ? '' : ' ' + esc(s2.error)) + '</span>').join('') +
        '</div>').join('') + '</div>' : '')
  );
}

async function openNotifyModal() {
  let cfg;
  try {
    cfg = await api('/api/notify/config');
  } catch (e) { return toast(e.message, 'error'); }
  openModal('<div class="modal-title">提醒设置</div>', notifyModalHtml(cfg),
    '<button class="btn" data-close>关闭</button>' +
    '<button class="btn" id="n-check">立即检查</button>' +
    '<button class="btn" id="n-test">发送测试</button>' +
    '<button class="btn primary" id="n-save">保存</button>');

  const $n = (id) => document.getElementById(id);
  const collect = () => ({
    enabled: !!($n('n-enabled') && $n('n-enabled').checked),
    intervalMinutes: Number($n('n-interval').value) || 60,
    channels: {
      wxpusher: { enabled: $n('nc-wxpusher-enabled').checked, appToken: $n('nc-wxpusher-appToken').value.trim(), uids: $n('nc-wxpusher-uids').value.trim(), topicIds: $n('nc-wxpusher-topicIds').value.trim(), summaryPrefix: $n('nc-wxpusher-summaryPrefix').value.trim() },
      serverchan: { enabled: $n('nc-serverchan-enabled').checked, sendkey: $n('nc-serverchan-sendkey').value.trim() },
      bark: { enabled: $n('nc-bark-enabled').checked, deviceKey: $n('nc-bark-deviceKey').value.trim(), server: $n('nc-bark-server').value.trim(), level: $n('nc-bark-level').value.trim(), group: $n('nc-bark-group').value.trim() },
    },
    rules: {
      feeDays: String($n('n-feeDays').value).split(/[,，\s]+/).map(Number).filter((x) => isFinite(x) && x >= 0),
      repayBeforeDays: Number($n('n-repayDays').value) || 0,
      taskRemainDays: Number($n('n-taskDays').value) || 0,
      billBeforeDays: Number($n('n-billDays').value) || 0,
      assetExpiryDays: Math.max(0, Math.min(90, Number($n('n-assetDays') && $n('n-assetDays').value) || 0)),
      billOverdueRemind: ($n('n-billOverdue') && $n('n-billOverdue').value === '1') ? 1 : 0,
    },
  });

  const showResult = (html) => { const r = $n('n-result'); if (r) r.innerHTML = html; };

  // ---- 日历订阅链接生成 ----
  let icsUrl = '';
  $n('n-ics-gen').addEventListener('click', () => {
    const t = ($n('n-ics-token').value || '').trim();
    if (!t) { showResult('<div class="badge badge-yellow">请先输入访问令牌</div>'); return; }
    icsUrl = location.origin + '/api/calendar.ics?token=' + encodeURIComponent(t);
    const out = $n('n-ics-out');
    out.style.display = '';
    $n('n-ics-url').value = icsUrl;
    $n('n-ics-copy').style.display = '';
  });
  $n('n-ics-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(icsUrl);
      showResult('<div class="badge badge-green">已复制，粘贴到日历 App 的「订阅日历」即可</div>');
    } catch (e) {
      // 剪贴板 API 失败（非 https 或权限拒绝）→ 选中输入框让用户手动复制
      $n('n-ics-url').select();
      showResult('<div class="badge badge-yellow">请手动 Ctrl+C 复制</div>');
    }
  });

  $n('n-save').addEventListener('click', async () => {
    try {
      await api('/api/notify/config', { method: 'PUT', body: collect() });
      toast('提醒设置已保存');
      showResult('<div class="badge badge-green">已保存</div>');
    } catch (e) { showResult('<div class="badge badge-red">' + esc(e.message) + '</div>'); }
  });

  $n('n-test').addEventListener('click', async () => {
    try {
      await api('/api/notify/config', { method: 'PUT', body: collect() });
      const r = await api('/api/notify/test', { method: 'POST', body: {} });
      showResult('<div class="badge ' + (r.ok ? 'badge-green' : 'badge-red') + '">' + (r.ok ? '测试推送成功' : '测试推送失败') + '</div>' +
        (r.results || []).map((s2) => '<div class="nh-item"><span class="badge ' + (s2.ok ? 'badge-green' : 'badge-red') + '">' + esc(s2.label) + '</span>' +
          '<span class="nh-title">' + (s2.ok ? '发送成功' : esc(s2.error)) + '</span></div>').join(''));
    } catch (e) { showResult('<div class="badge badge-red">' + esc(e.message) + '</div>'); }
  });

  $n('n-check').addEventListener('click', async () => {
    try {
      await api('/api/notify/config', { method: 'PUT', body: collect() });
      const r = await api('/api/notify/check', { method: 'POST', body: {} });
      if (r.skipped) { showResult('<div class="badge badge-yellow">' + esc(r.reason || '已跳过') + '</div>'); return; }
      showResult('<div class="badge ' + (r.sent ? 'badge-green' : 'badge-default') + '">检查 ' + r.checked + ' 项，推送 ' + r.sent + ' 项</div>' +
        (r.results || []).map((s2) => '<div class="nh-item"><span class="badge ' + (s2.ok ? 'badge-green' : 'badge-red') + '">' + esc(s2.type) + '</span>' +
          '<span class="nh-title">' + esc(s2.title) + '</span>' + (s2.error ? '<span class="nh-time">' + esc(s2.error) + '</span>' : '') + '</div>').join(''));
    } catch (e) { showResult('<div class="badge badge-red">' + esc(e.message) + '</div>'); }
  });
}

// ---------- 弹窗：合并账单组管理 ----------
// 组本身只存名称，成员关系记在每张卡的 billGroupId 上（服务端强制组内同还款日）
async function openBillGroupsModal(focusGid) {
  const groups = state.billGroups || [];
  const cards = state.myCards || [];
  const memberNames = (g) => cards.filter((x) => x.billGroupId === g.id).map((x) => esc(x.alias || x.name));

  let html = '<div style="font-size:13px;color:var(--text-2);line-height:1.6;margin-bottom:12px">' +
    '把<b>还款日相同</b>的几张卡加入同一组，还款提醒就会合并成 <b>1 条</b>（列出组内所有卡与银行到期日），不再逐卡重复推送。<br>' +
    '年费提醒、月刷卡任务仍按单卡推送（这两类卡片之间本就独立）。</div>';

  if (groups.length) {
    html += groups.map((g) => {
      const names = memberNames(g);
      return '<div class="bg-group" data-gid="' + esc(g.id) + '">' +
        '<div class="bg-head"><span class="bg-name">' + esc(g.name) + '</span>' +
        '<span class="badge badge-purple">' + g.memberCount + ' 张卡</span>' +
        (g.lastPayDate ? '<span class="badge badge-default">最后还款日 ' + esc(g.lastPayDate) + '</span>' : '') +
        '<div class="spacer" style="flex:1"></div>' +
        '<button class="btn small" data-act="bg-edit">编辑</button> ' +
        '<button class="btn small danger" data-act="bg-del">解散</button></div>' +
        '<div class="chip-row" style="margin-top:6px">' + (names.length ? names.map((n) => '<span class="stat-chip">' + n + '</span>').join('') : '<span style="font-size:12px;color:var(--text-3)">暂无成员</span>') + '</div>' +
        '</div>';
    }).join('');
  } else {
    html += '<div class="empty-tip" style="padding:16px">还没有合并账单组，点下面按钮新建</div>';
  }

  html += '<div id="bg-new" style="margin-top:14px">' +
    '<label style="font-size:12px;color:var(--text-2)">新建账单组</label>' +
    '<div class="form-grid" style="margin-top:6px">' +
    field('组名称', '<input id="bg-name" placeholder="如 招行合并还款">') +
    '</div>' +
    '<div style="margin-top:8px"><label style="font-size:12px;color:var(--text-2)">选择成员（至少 2 张，需同还款日）</label>' +
    '<div id="bg-members">' + memberChecklistHtml([]) + '</div></div>' +
    '</div>';

  openModal('<div class="modal-title">合并账单组</div>', html,
    '<button class="btn" data-close>关闭</button><button class="btn primary" id="bg-create">新建账单组</button>');

  const modal = $('.modal-body');
  $$('.bg-group', modal).forEach((el) => {
    const gid = el.dataset.gid;
    $('[data-act="bg-del"]', el).addEventListener('click', async () => {
      if (!(await confirmDialog('解散该组后，组内卡将恢复各自提醒。确定解散？'))) return;
      try {
        await api('/api/billgroups/' + gid, { method: 'DELETE' });
        toast('已解散');
        closeModal();
        await loadAll();
        openBillGroupsModal();
      } catch (e) { toast(e.message, 'error'); }
    });
    $('[data-act="bg-edit"]', el).addEventListener('click', () => openBillGroupEditModal(gid));
  });
  $('#bg-create').addEventListener('click', async () => {
    const name = $('#bg-name').value.trim();
    if (!name) return toast('请填写组名称', 'error');
    const memberIds = $$('#bg-members input:checked').map((x) => x.value);
    if (memberIds.length < 2) return toast('至少选择 2 张卡', 'error');
    try {
      await api('/api/billgroups', { method: 'POST', body: { name, memberIds } });
      toast('账单组已创建');
      closeModal();
      await loadAll();
      openBillGroupsModal();
    } catch (e) { toast(e.message, 'error'); }
  });
  if (focusGid) {
    const el = modal.querySelector('.bg-group[data-gid="' + focusGid + '"]');
    // scrollIntoView 在部分环境（无头浏览器 / 旧内核 / 测试环境）不存在，直接调用会抛 TypeError
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
  }
}

/**
 * 成员勾选列表。
 * @param checkedIds 预勾选的持卡 id
 * @param currentGid 当前正在编辑的组 id。属于「本组」的卡必须保持可勾选（否则无法取消勾选移出成员）；
 *                   属于「其它组」的卡置灰并说明原因，避免误选导致服务端拒绝
 */
function memberChecklistHtml(checkedIds, currentGid) {
  const groups = state.billGroups || [];
  return (state.myCards || []).map((m) => {
    const g = groups.find((x) => x.id === m.billGroupId);
    const isSelf = !!(g && currentGid && g.id === currentGid);
    const label = (m.alias || m.name) + ' · ' + m.bank + ' · 还款 ' + ((m.payment && m.payment.lastPayDate) || '—');
    const disabled = (g && !isSelf) ? ' disabled' : '';
    const tag = (g && !isSelf) ? '（已在「' + esc(g.name) + '」）' : '';
    return '<label class="bg-member"><input type="checkbox" value="' + esc(m.id) + '"' + disabled +
      (checkedIds.includes(m.id) ? ' checked' : '') + '> <span>' + esc(label) + '</span>' +
      '<span style="color:var(--text-3);font-size:12px">' + tag + '</span></label>';
  }).join('');
}

async function openBillGroupEditModal(gid) {
  const g = (state.billGroups || []).find((x) => x.id === gid);
  if (!g) return;
  const my = (state.myCards || []).filter((x) => x.billGroupId === gid).map((x) => x.id);
  openModal('<div class="modal-title">编辑账单组 — ' + esc(g.name) + '</div>',
    '<div class="form-grid">' + field('组名称', '<input id="bg-name" value="' + esc(g.name) + '">') + '</div>' +
    '<div style="margin-top:10px"><label style="font-size:12px;color:var(--text-2)">成员（取消勾选可移出该组）</label>' +
    '<div id="bg-members">' + memberChecklistHtml(my, gid) + '</div></div>',
    '<button class="btn" data-close>取消</button><button class="btn primary" id="bg-save">保存</button>');
  $('#bg-save').addEventListener('click', async () => {
    const name = $('#bg-name').value.trim();
    if (!name) return toast('请填写组名称', 'error');
    const memberIds = $$('#bg-members input:checked').map((x) => x.value);
    if (memberIds.length === 1) return toast('账单组至少需要 2 张卡，可改为解散该组', 'error');
    try {
      await api('/api/billgroups/' + gid, { method: 'PUT', body: { name, memberIds } });
      toast('已保存');
      closeModal();
      await loadAll();
      openBillGroupsModal(memberIds.length ? gid : undefined);
    } catch (e) { toast(e.message, 'error'); }
  });
}

// ---------- 抽屉：持卡详情 ----------
function openDrawer(id) {
  state.drawerId = id;
  renderDrawer();
}

function closeDrawer() {
  state.drawerId = null;
  renderDrawer();
}

function renderDrawer() {
  const root = $('#drawer-root');
  const m = state.myCards.find((x) => x.id === state.drawerId);
  if (!m) { root.innerHTML = ''; return; }

  let overlay = $('.overlay', root);
  if (!overlay) {
    root.innerHTML = '<div class="overlay"></div><div class="drawer" id="drawer"></div>';
    overlay = $('.overlay', root);
    overlay.addEventListener('click', closeDrawer);
  }
  const drawer = $('#drawer', root);
  // 保留滚动位置：loadAll 后重绘抽屉不丢滚动进度（记一笔/补录后仍停在原处）
  const prevScroll = drawer.scrollTop;
  drawer.innerHTML = drawerHtml(m);
  drawer.scrollTop = prevScroll;
  requestAnimationFrame(() => {
    // rAF 是异步的：这一帧之间可能已经 closeDrawer / 切页（root 被清空），
    // 不做存在性判断会直接抛 TypeError 打断后续渲染
    const ov = $('.overlay', root);
    if (ov) ov.classList.add('show');
    if (drawer.isConnected) drawer.classList.add('show');
  });
  bindDrawerEvents(m);
}

function drawerHtml(m) {
  const w = m.waiver;
  let feePolicyHtml = '';
  if (w.kind === '消费刷免' || w.kind === '笔数刷免') {
    const pct = w.target > 0 ? Math.min(100, Math.round((w.progress / w.target) * 100)) : 0;
    feePolicyHtml =
      '<div class="progress"><div class="progress-track"><div class="progress-fill' + (w.met ? ' done' : '') + '" style="width:' + pct + '%"></div></div>' +
      '<div class="progress-text"><span>' + (w.unit === '元' ? fmtMoney(w.progress) + ' / ' + fmtMoney(w.target) : fmtInt(w.progress) + ' / ' + fmtInt(w.target) + ' 笔') + '</span>' +
      (w.met ? '<span style="color:var(--green);font-weight:600">已达标</span>' : '<span class="remaining">剩余 ' + (w.unit === '元' ? fmtMoney(w.remaining) : fmtInt(w.remaining) + ' 笔') + '</span>') +
      '</div></div>' +
      '<div style="font-size:12px;color:var(--text-3)">' + esc(w.kind) + ' ' + esc(m.waiverCondition || '') + ' · 按卡年统计（自上个年费日 ' + esc(m.feeMonth) + ' 月 ' + esc(m.feeDay) + ' 日起）</div>';
  } else if (w.kind === '积分抵扣') {
    feePolicyHtml = sliderHtml('toggle-points-drawer', m.pointsDeducted, m.pointsDeducted ? '已抵扣' : '未抵扣', m.pointsDeductDate, m.id);
  } else if (w.kind === '资产存免') {
    feePolicyHtml = sliderHtml('toggle-asset-drawer', m.assetWaived, m.assetWaived ? '已达标' : '未达标', m.assetWaivedDate, m.id) +
      '<div style="font-size:12px;color:var(--text-3);margin-top:4px">要求存款：' + esc(m.waiverCondition || '0') + '</div>';
  } else if (w.kind === '刚性') {
    feePolicyHtml = '<span class="badge badge-red">刚性年费</span> <span style="font-size:12px;color:var(--text-3)">必须缴费</span>';
  } else {
    feePolicyHtml = '<span class="badge badge-green">免年费</span>';
  }

  const benefitsHtml = (m.benefits || []).map((b, i) => benefitBlockHtml(m, b, i)).join('');

  return (
    '<div class="drawer-header">' +
    '<div class="drawer-title">' + esc(m.name) + (m.alias ? '<span class="alias" style="color:var(--gold-deep);font-weight:500;margin-left:6px">“' + esc(m.alias) + '”</span>' : '') +
    '<div class="drawer-sub">' + esc(m.bank) + ' · ' + esc(m.org) + ' · ' + esc(m.level) + '</div></div>' +
    '<button class="drawer-close" data-act="close" title="关闭">✕</button>' +
    '</div>' +
    '<div class="drawer-body">' +

    '<div class="drawer-section"><h3>基础信息</h3>' +
    '<div class="info-grid">' +
    infoItem('授信额度', fmtMoney(m.creditLimit)) +
    infoItem('卡号后四位', m.last4 ? '**** ' + esc(m.last4) : '未填写') +
    infoItem('账单日', '每月 ' + m.billingDay + ' 日') +
    infoItem('还款方式', m.repayMode === 'afterBill' ? '账单日后 ' + (m.repayValue || 0) + ' 天' : '每月 ' + (m.repayValue || m.repaymentDay || '—') + ' 日') +
    infoItem('宽限期', (m.graceDays || 0) + ' 天') +
    infoItem('最长免息期', (m.payment && m.payment.maxInterestDays) ? m.payment.maxInterestDays + ' 天' : '—') +
    infoItem('合并账单', m.billGroupId
      ? '<span class="badge badge-purple">' + esc(m.billGroupName || '未命名组') + '</span> <span style="font-size:12px;color:var(--text-3)">' + groupMembersOf(m).length + ' 张卡</span>'
      : '<span style="color:var(--text-3)">未合并</span>') +
    '</div>' +
    '<div class="bill-hint">本期账单 ' + esc((m.payment && m.payment.billDate) || '—') + ' · 银行到期 ' + esc((m.payment && m.payment.dueDate) || '—') +
    ((m.payment && m.payment.isInGrace) ? ' <span class="badge badge-yellow">宽限期内</span>' : '') +
    ' · 建议消费日 ' + esc((m.payment && m.payment.bestSpendDate) || '—') + '（免息最长）</div>' +
    '<div style="margin-top:10px;display:flex;gap:8px">' +
    '<button class="btn small" data-act="edit-mycard">编辑持卡</button>' +
    '<button class="btn small danger" data-act="del-mycard">删除持卡</button>' +
    '</div></div>' +

    '<div class="drawer-section"><h3>每月刷卡任务</h3>' +
    (m.monthlySpendTarget > 0
      ? '<div class="progress"><div class="progress-track"><div class="progress-fill" style="width:' + m.monthProgress + '%"></div></div>' +
        '<div class="progress-text"><span>本月消费 ' + fmtMoney(m.monthSpend) + '</span><span>目标 ' + fmtMoney(m.monthlySpendTarget) + '</span></div></div>'
      : '<div style="font-size:13px;color:var(--text-3)">未设置月消费目标（编辑持卡可设置）</div>') +
    '</div>' +

    '<div class="drawer-section"><h3>年费信息</h3>' +
    '<div class="info-grid">' +
    infoItem('下期年费日', m.nextFeeDate) +
    infoItem('年费倒计时', m.waiver.needsPayment ? '<span class="badge ' + (FEE_BADGE[m.feeDaysColor] || 'badge-default') + '">年费还有 ' + m.feeDays + ' 天</span>' : '<span class="badge badge-green">年费已免</span>') +
    infoItem('达标状态', m.feeStatus ? '<span class="badge ' + (m.feeStatus === '未达标' ? 'badge-default' : 'badge-green') + '">' + esc(m.feeStatus) + '</span>' : '—') +
    infoItem('年费预警', m.feeAlert ? '<span class="badge ' + (FEE_ALERT_BADGE[m.feeAlert] || 'badge-default') + '">' + esc(m.feeAlert) + '</span>' : '—') +
    '</div>' +
    (m.feeMonthsLeft != null ? '<div class="bill-hint">距年费约 ' + m.feeMonthsLeft + ' 个月</div>' : '') +
    '<div style="margin-top:10px">' + feePolicyHtml + '</div></div>' +

    '<div class="drawer-section"><h3>消费记录</h3>' +
    '<div class="chip-row">' +
    '<span class="stat-chip">本月 <b>' + fmtMoney(m.monthSpend) + '</b> · ' + m.monthCount + ' 笔 <button class="btn small" data-act="detail-records" data-scope="month">本月明细</button></span>' +
    '<span class="stat-chip">本年 <b>' + fmtMoney(m.yearSpend) + '</b> · ' + m.yearCount + ' 笔 <button class="btn small" data-act="detail-records" data-scope="year">本年明细</button></span>' +
    '<span class="stat-chip">累计 <b>' + fmtMoney(m.totalSpend) + '</b> · ' + m.totalCount + ' 笔 <button class="btn small" data-act="detail-records" data-scope="all">累计明细</button></span>' +
    '</div>' +
    '<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">' +
    '<button class="btn small primary" data-act="record-consumption">记一笔</button>' +
    '<span class="count-topup">补录笔数 <input type="number" id="count-topup-input" min="1" step="1" placeholder="笔数"> <button class="btn small" data-act="count-topup">保存</button></span>' +
    '</div>' +
    (m.recent.length
      ? '<table class="record-table"><thead><tr><th>日期</th><th>渠道</th><th>分类</th><th>备注</th><th style="text-align:right">金额</th></tr></thead><tbody>' +
        m.recent.map((r) => '<tr><td>' + esc(r.date) + '</td><td>' + esc(r.channel) + '</td><td>' + esc(r.category) + '</td><td>' + esc(r.note || '') + '</td><td class="amount">' + fmtMoney(r.amount) + '</td></tr>').join('') +
        '</tbody></table><div style="font-size:12px;color:var(--text-3);margin-top:4px">仅显示最近 5 条，更多见上方明细</div>'
      : '<div style="font-size:13px;color:var(--text-3)">暂无消费记录</div>') +
    '</div>' +

    '<div class="drawer-section"><h3>账单流水</h3>' +
    '<div class="chip-row" style="margin-top:0">' +
    '<button class="btn small primary" data-act="bill-add">新增账单</button>' +
    '<button class="btn small" data-act="bill-gen">生成本期账单</button>' +
    '<span class="stat-chip">未还 <b>' + unpaidCount(m) + '</b> 笔</span>' +
    '</div>' +
    billsHtml(m) + '</div>' +

    (m.billGroupId ? groupBillsSectionHtml(m) : '') +

    '<div class="drawer-section"><h3>权益使用明细</h3>' +
    (benefitsHtml || '<div style="font-size:13px;color:var(--text-3)">暂无权益（编辑持卡可添加）</div>') +
    '</div>' +
    '</div>'
  );
}

function infoItem(k, v) {
  return '<div class="info-item"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
}

/** 合并账单组视角：组内成员 + 按月合计（还款提醒按组只推 1 条） */
function groupBillsSectionHtml(m) {
  const members = groupMembersOf(m);
  const rows = groupBillRows(m);
  const memberHtml = members.map((x) => '<span class="stat-chip">' + esc(x.alias || x.name) +
    (x.id === m.id ? '<span style="color:var(--text-3)">（当前）</span>' : '') + '</span>').join('');
  return '<div class="drawer-section"><h3>合并账单组：' + esc(m.billGroupName || '未命名组') + '</h3>' +
    '<div class="bill-hint">组内 ' + members.length + ' 张卡共用同一还款日，' +
    '提醒按组合并为 1 条（不再逐卡推送）。组内卡的最后还款日：' + esc((m.payment && m.payment.lastPayDate) || '—') + '</div>' +
    '<div class="chip-row">' + memberHtml + '</div>' +
    (rows.length
      ? '<table class="record-table"><thead><tr><th>月份</th><th>合计应还</th><th>到期日</th><th>未还</th></tr></thead><tbody>' +
        rows.map((r) => '<tr><td>' + esc(r.month) + '</td>' +
          '<td class="amount">' + fmtMoney(r.total) + '</td>' +
          '<td>' + esc(r.dueDate || '—') + '</td>' +
          '<td>' + (r.unpaid ? '<span class="badge badge-red">' + r.unpaid + ' 笔</span>' : '<span class="badge badge-green">已还清</span>') + '</td></tr>').join('') +
        '</tbody></table>'
      : '<div style="font-size:13px;color:var(--text-3)">组内暂无账单记录</div>') +
    '<div style="margin-top:10px;display:flex;gap:8px">' +
    '<button class="btn small" data-act="group-edit" data-gid="' + esc(m.billGroupId) + '">管理账单组</button>' +
    '<button class="btn small" data-act="group-leave" data-id="' + m.id + '">退出合并账单</button>' +
    '</div></div>';
}

function myBills(m) {
  return (state.bills || []).filter((b) => b.myCardId === m.id).sort((a, b) => (a.month < b.month ? 1 : -1));
}

function groupMembersOf(m) {
  if (!m.billGroupId) return [];
  return (state.myCards || []).filter((x) => x.billGroupId === m.billGroupId);
}

// 合并账单组：同月账单合计（组内还款日一致，到期日应相同）
function groupBillRows(m) {
  const members = groupMembersOf(m);
  if (!members.length) return [];
  const ids = members.map((x) => x.id);
  const byMonth = {};
  for (const b of state.bills || []) {
    if (!ids.includes(b.myCardId)) continue;
    const e = byMonth[b.month] || (byMonth[b.month] = { month: b.month, total: 0, unpaid: 0, count: 0, dueDate: '', paidDate: '' });
    e.total += Number(b.amount) || 0;
    e.count++;
    if (b.paid !== '已还') e.unpaid++;
    // 到期日取最早（组内不一致时宁可提前提醒）
    if (b.dueDate && (!e.dueDate || b.dueDate < e.dueDate)) e.dueDate = b.dueDate;
    if (b.paidDate && (!e.paidDate || b.paidDate > e.paidDate)) e.paidDate = b.paidDate;
  }
  return Object.values(byMonth).sort((a, b) => (a.month < b.month ? 1 : -1));
}

function unpaidCount(m) {
  return myBills(m).filter((b) => b.paid !== '已还').length;
}

function billsHtml(m) {
  const list = myBills(m);
  if (!list.length) return '<div style="font-size:13px;color:var(--text-3)">暂无账单记录（点「生成本期账单」快速创建）</div>';
  return '<table class="record-table"><thead><tr><th>月份</th><th>金额</th><th>到期日</th><th>状态</th><th>操作</th></tr></thead><tbody>' +
    list.map((b) => '<tr data-bill-id="' + b.id + '">' +
      '<td>' + esc(b.month) + '</td>' +
      '<td class="amount">' + fmtMoney(b.amount) + '</td>' +
      '<td>' + esc(b.dueDate || '—') + '</td>' +
      '<td><span class="badge ' + (b.paid === '已还' ? 'badge-green' : 'badge-red') + '">' + esc(b.paid) + '</span>' +
      (b.paidDate ? '<div class="slider-date">' + esc(b.paidDate) + '</div>' : '') + '</td>' +
      '<td><button class="btn small" data-act="bill-toggle">' + (b.paid === '已还' ? '标记未还' : '标记已还') + '</button> ' +
      '<button class="btn small danger" data-act="bill-del">删除</button></td></tr>').join('') +
    '</tbody></table>';
}

async function openBillModal(m) {
  const p = m.payment || {};
  openModal('<div class="modal-title">新增账单 — ' + esc(m.alias || m.name) + '</div>',
    '<div class="form-grid">' +
    field('出账月份（YYYY-MM）', '<input id="b-month" value="' + esc(p.billMonth || '') + '" placeholder="2026-10">') +
    field('账单金额', '<input id="b-amount" type="number" min="0" step="0.01" value="0">') +
    field('到期还款日', '<input id="b-due" type="date" value="' + esc(p.dueDate || '') + '">') +
    field('是否已还', '<select id="b-paid"><option>未还</option><option>已还</option></select>') +
    '</div>',
    '<button class="btn" data-close>取消</button><button class="btn primary" id="b-save">保存</button>');
  $('#b-save').addEventListener('click', async () => {
    try {
      await api('/api/bills', {
        method: 'POST',
        body: {
          myCardId: m.id,
          month: $('#b-month').value.trim(),
          amount: $('#b-amount').value,
          dueDate: $('#b-due').value,
          paid: $('#b-paid').value,
        },
      });
      toast('账单已添加');
      closeModal();
      await loadAll();
    } catch (e) { toast(e.message, 'error'); }
  });
}

function sliderHtml(act, on, label, date, id) {
  return '<button class="slider-toggle' + (on ? ' on' : '') + '" data-act="' + act + '" data-id="' + id + '">' +
    '<span class="slider-track"><span class="slider-knob"></span></span>' +
    '<span><span class="slider-label">' + label + '</span>' +
    (date ? '<div class="slider-date">' + esc(date) + '</div>' : '') + '</span></button>';
}

function benefitBlockHtml(m, b, i) {
  const badgeCls = CYCLE_BADGE[b.resetCycle] || 'badge-default';
  const unlimited = b.total < 0;
  const pct = b.total > 0 ? Math.min(100, Math.round((b.used / b.total) * 100)) : 0;
  const countTxt = unlimited ? '已用 ' + b.used + ' / 不限' : '已用 ' + b.used + ' / ' + b.total;
  const stateBadge = b.expired ? '<span class="badge badge-default">已过期</span>'
    : (unlimited ? '<span class="badge badge-green">不限次</span>'
      : '<span class="badge ' + (b.used >= b.total ? 'badge-red' : 'badge-default') + '">' + (b.remaining != null ? '剩 ' + b.remaining : countTxt) + '</span>');
  return '<div class="benefit-block" data-idx="' + i + '">' +
    '<div class="b-head"><span class="b-name">' + esc(b.name) + '</span>' +
    (b.type ? '<span class="badge badge-blue">' + esc(b.type) + '</span>' : '') +
    '<span class="badge ' + badgeCls + '">' + esc(b.resetCycle) + '重置</span>' +
    '<span class="badge badge-default">' + countTxt + '</span>' + stateBadge +
    (b.validUntil ? '<span class="slider-date">有效期至 ' + esc(b.validUntil) + '</span>' : '') + '</div>' +
    '<div class="progress"><div class="progress-track"><div class="progress-fill' + (b.used >= b.total ? ' done' : '') + '" style="width:' + pct + '%"></div></div></div>' +
    '<div class="b-actions">' +
    '<button class="btn small" data-act="record-benefit">记一笔</button>' +
    '<span class="count-topup">补录 <input type="number" min="1" step="1" placeholder="次数"> <button class="btn small" data-act="count-benefit">保存</button></span>' +
    '<div class="spacer" style="flex:1"></div>' +
    '<button class="btn small" data-act="benefit-history">历史记录</button>' +
    '</div></div>';
}

function bindDrawerEvents(m) {
  const drawer = $('#drawer');
  if (!drawer) return;
  $('[data-act="close"]', drawer).addEventListener('click', closeDrawer);

  const editBtn = $('[data-act="edit-mycard"]', drawer);
  if (editBtn) editBtn.addEventListener('click', () => openMyCardModal(m));

  const delBtn = $('[data-act="del-mycard"]', drawer);
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!(await confirmDialog('确定删除持卡「' + (m.alias || m.name) + '」？消费记录和权益记录将一并删除。'))) return;
    try {
      await api('/api/mycards/' + m.id, { method: 'DELETE' });
      toast('已删除');
      closeDrawer();
      await loadAll();
    } catch (e) { toast(e.message, 'error'); }
  });

  const pts = $('[data-act="toggle-points-drawer"]', drawer);
  if (pts) pts.addEventListener('click', () => togglePoints(m.id));
  const asset = $('[data-act="toggle-asset-drawer"]', drawer);
  if (asset) asset.addEventListener('click', () => toggleAsset(m.id));

  // 消费记录
  $('[data-act="record-consumption"]', drawer).addEventListener('click', () => openConsumptionModal(m));
  $('[data-act="count-topup"]', drawer).addEventListener('click', async () => {
    const input = $('#count-topup-input', drawer);
    const n = parseInt(input.value, 10);
    if (!n || n <= 0) return toast('请输入大于 0 的笔数', 'error');
    try {
      await api('/api/mycards/' + m.id + '/consumptions/count', { method: 'POST', body: { date: today(), count: n } });
      toast('已补录 ' + n + ' 笔');
      await loadAll();
    } catch (e) { toast(e.message, 'error'); }
  });
  $$('[data-act="detail-records"]', drawer).forEach((btn) => {
    btn.addEventListener('click', () => openRecordsModal(m, btn.dataset.scope));
  });

  // 账单流水
  const billAdd = $('[data-act="bill-add"]', drawer);
  if (billAdd) billAdd.addEventListener('click', () => openBillModal(m));
  const billGen = $('[data-act="bill-gen"]', drawer);
  if (billGen) billGen.addEventListener('click', async () => {
    try {
      await api('/api/mycards/' + m.id + '/bills/generate', { method: 'POST', body: {} });
      toast('已生成本期账单');
      await loadAll();
    } catch (e) { toast(e.message, 'error'); }
  });
  $$('[data-act="bill-toggle"]', drawer).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('tr').dataset.billId;
      const b = (state.bills || []).find((x) => x.id === id);
      if (!b) return;
      try {
        await api('/api/bills/' + id, { method: 'PUT', body: { paid: b.paid === '已还' ? '未还' : '已还' } });
        await loadAll();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
  $$('[data-act="bill-del"]', drawer).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('tr').dataset.billId;
      if (!(await confirmDialog('确定删除这条账单记录？'))) return;
      try {
        await api('/api/bills/' + id, { method: 'DELETE' });
        toast('已删除');
        await loadAll();
      } catch (e) { toast(e.message, 'error'); }
    });
  });

  // 合并账单组
  const grpEdit = $('[data-act="group-edit"]', drawer);
  if (grpEdit) grpEdit.addEventListener('click', () => openBillGroupsModal(grpEdit.dataset.gid));
  const grpLeave = $('[data-act="group-leave"]', drawer);
  if (grpLeave) grpLeave.addEventListener('click', async () => {
    if (!(await confirmDialog('退出后这张卡将恢复单独提醒，确定退出合并账单？'))) return;
    try {
      await api('/api/mycards/' + m.id, { method: 'PUT', body: { billGroupId: '' } });
      toast('已退出合并账单');
      await loadAll();
    } catch (e) { toast(e.message, 'error'); }
  });

  // 权益
  $$('.benefit-block', drawer).forEach((block) => {
    const idx = +block.dataset.idx;
    const b = (m.benefits || [])[idx];
    if (!b) return;
    $('[data-act="record-benefit"]', block).addEventListener('click', () => openBenefitModal(m, idx));
    $('[data-act="count-benefit"]', block).addEventListener('click', async () => {
      const input = $('input', block);
      const n = parseInt(input.value, 10);
      if (!n || n <= 0) return toast('请输入大于 0 的次数', 'error');
      try {
        await api('/api/mycards/' + m.id + '/benefits/' + idx + '/count', { method: 'POST', body: { date: today(), count: n, bid: b.id || '' } });
        toast('已补录 ' + n + ' 次');
        await loadAll();
      } catch (e) { toast(e.message, 'error'); }
    });
    $('[data-act="benefit-history"]', block).addEventListener('click', () => openBenefitHistoryModal(m, idx));
  });
}

// ---------- 通用弹窗 ----------
function openModal(titleHtml, bodyHtml, footerHtml) {
  const root = $('#modal-root');
  root.innerHTML =
    '<div class="modal-wrap" id="modal-wrap">' +
    '<div class="modal" id="modal">' +
    '<div class="modal-header">' + titleHtml +
    '<button class="modal-close" data-close>✕</button></div>' +
    '<div class="modal-body">' + bodyHtml + '</div>' +
    (footerHtml ? '<div class="modal-footer">' + footerHtml + '</div>' : '') +
    '</div></div>';
  const wrap = $('#modal-wrap');
  requestAnimationFrame(() => wrap.classList.add('show'));
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) closeModal();
  });
  return $('#modal');
}

function closeModal() {
  const wrap = $('#modal-wrap');
  if (!wrap) return;
  wrap.classList.remove('show');
  // 延迟清理时必须确认仍是同一个弹窗，否则会把期间新开的弹窗误清空
  const node = wrap;
  setTimeout(() => {
    if ($('#modal-wrap') === node) $('#modal-root').innerHTML = '';
  }, 200);
}

// ---------- 弹窗：添加 / 编辑持卡 ----------
function openAddCardModal() {
  const pickHtml =
    '<div class="pick-custom" id="pick-custom-entry">' +
    '<button class="btn" id="btn-custom-card">＋ 自定义卡片（卡种库里没有）</button>' +
    '<span class="pick-custom-tip">手头是卡种库中没有的卡？点这里直接新建</span></div>' +
    '<div class="search-box"><input id="pick-search" placeholder="搜索银行或卡片名称…"></div>' +
    '<div class="pick-list" id="pick-list"></div>' +
    '<div id="pick-form" style="margin-top:14px"></div>';
  openModal('<div class="modal-title">添加持卡</div>', pickHtml,
    '<button class="btn" data-close>取消</button><button class="btn primary" id="btn-save-mycard">保存</button>');
  // custom = null 表示「从卡种库选卡」；custom = {bank,name,...} 表示「自定义新建」
  const selected = { cardId: null, custom: null };
  renderPickList(selected, '');
  $('#pick-search').addEventListener('input', (e) => renderPickList(selected, e.target.value.trim()));
  $('#btn-custom-card').addEventListener('click', () => openCustomCardForm(selected));
  $('#btn-save-mycard').addEventListener('click', () => saveMyCard(selected, null));
}

/** 自定义卡片：切到「卡种信息 + 持卡信息」双段表单，隐藏卡种库选择区 */
function openCustomCardForm(selected) {
  selected.cardId = null;
  selected.custom = selected.custom || { bank: '', name: '', level: '', org: '', annualFee: 0, waiverType: state.meta.waiverTypes[0] || '免年费', startCredit: '' };
  $('#pick-custom-entry').style.display = 'none';
  $('#pick-search').style.display = 'none';
  $('#pick-list').style.display = 'none';
  renderCustomPickForm(selected);
}

/** 从自定义表单退回卡种库列表 */
function backToPickList(selected) {
  selected.custom = null;
  $('#pick-custom-entry').style.display = '';
  $('#pick-search').style.display = '';
  $('#pick-list').style.display = '';
  $('#pick-form').innerHTML = '';
  renderPickList(selected, '');
}

function renderCustomPickForm(selected) {
  const d = selected.custom;
  const types = state.meta.waiverTypes || [];
  const form = $('#pick-form');
  form.innerHTML =
    '<div class="custom-card-form">' +
    '<div class="custom-card-head">' +
    '<span class="custom-card-title">新建卡种</span>' +
    '<button class="btn small" id="btn-back-pick">← 返回卡种库</button></div>' +
    '<div class="form-grid">' +
    field('银行 <span style="color:var(--red)">*</span>', '<input id="c-bank" value="' + esc(d.bank) + '" placeholder="如 招商银行">') +
    field('卡片名称 <span style="color:var(--red)">*</span>', '<input id="c-name" value="' + esc(d.name) + '" placeholder="如 经典白金卡">') +
    field('卡等级', '<input id="c-level" value="' + esc(d.level) + '" placeholder="如 白金卡">') +
    field('卡组织', '<input id="c-org" value="' + esc(d.org) + '" placeholder="如 银联/VISA">') +
    field('年费（元）', '<input id="c-fee" type="number" min="0" value="' + esc(d.annualFee) + '" placeholder="如 3600，免年费填 0">') +
    field('起批额度（元）', '<input id="c-credit" type="number" min="0" step="1000" value="' + esc(d.startCredit) + '" placeholder="如 50000">') +
    field('免年费类型', '<select id="c-waivertype">' + types.map((t) => '<option' + (d.waiverType === t ? ' selected' : '') + '>' + t + '</option>').join('') + '</select>') +
    field('刷免条件（选填）', '<input id="c-condition" placeholder="如 10万、10笔、10000">') +
    '</div>' +
    '<div class="custom-card-divider">持卡信息</div>' +
    '<div id="custom-mycard-form"></div>' +
    '</div>';
  // 持卡表单：以「临时卡种」为模板渲染，复用 myCardFormHtml 的全部字段与默认值
  const fake = {
    id: '__custom__', bank: d.bank, name: d.name || '自定义卡片',
    org: d.org, level: d.level, annualFee: Number(d.annualFee) || 0,
    startCredit: Number(d.startCredit) || 0, benefits: [],
  };
  $('#custom-mycard-form').innerHTML = myCardFormHtml(fake, null);
  bindMyCardForm($('#custom-mycard-form'), fake, null);
  $('#btn-back-pick').addEventListener('click', () => backToPickList(selected));
  // 卡种字段变化时实时同步到 fake，供保存时读取（这里只做即时回填，避免用户来回切换丢失）
  ['c-bank', 'c-name', 'c-level', 'c-org', 'c-fee', 'c-credit'].forEach((id) => {
    const el = $('#' + id, form);
    if (el) el.addEventListener('input', () => {
      d.bank = $('#c-bank', form).value.trim();
      d.name = $('#c-name', form).value.trim();
      d.level = $('#c-level', form).value.trim();
      d.org = $('#c-org', form).value.trim();
      d.annualFee = $('#c-fee', form).value;
      d.startCredit = $('#c-credit', form).value;
    });
  });
}

function renderPickList(selected, kw) {
  const list = $('#pick-list');
  const byBank = {};
  for (const c of state.cards) {
    if (kw && !(c.bank.includes(kw) || c.name.includes(kw))) continue;
    if (!byBank[c.bank]) byBank[c.bank] = [];
    byBank[c.bank].push(c);
  }
  const banks = orderedBanks(Object.keys(byBank));
  if (!banks.length) { list.innerHTML = '<div class="empty-tip" style="padding:20px">没有匹配的卡种</div>'; $('#pick-form').innerHTML = ''; return; }
  let html = '';
  for (const bank of banks) {
    const autoOpen = !!kw;
    html += '<div class="pick-bank" data-bank="' + esc(bank) + '"' + (autoOpen ? '' : ' style="display:none"') + ' data-force="' + (autoOpen ? '1' : '0') + '">' +
      '<div class="pick-bank-header" data-bank-toggle><span class="collapse-arrow">▾</span>' + esc(bank) + '（' + byBank[bank].length + '）</div>';
    for (const c of byBank[bank]) {
      html += '<div class="pick-card' + (selected.cardId === c.id ? ' selected' : '') + '" data-card-id="' + c.id + '">' +
        '<span class="pick-card-name">' + esc(c.name) + '</span>' +
        '<span class="pick-card-meta">' + esc(c.org) + ' · ' + esc(c.level) + ' · 年费 ' + (c.annualFee ? fmtMoney(c.annualFee) : '免') + '</span></div>';
    }
    html += '</div>';
  }
  list.innerHTML = html;
  $$('.pick-bank-header', list).forEach((h) => {
    h.addEventListener('click', () => {
      const bank = h.closest('.pick-bank');
      if (bank.dataset.force === '1') return; // 搜索命中时保持展开
      bank.style.display = bank.style.display === 'none' ? '' : 'none';
    });
  });
  $$('.pick-card', list).forEach((el) => {
    el.addEventListener('click', () => {
      $$('.pick-card', list).forEach((x) => x.classList.remove('selected'));
      el.classList.add('selected');
      selected.cardId = el.dataset.cardId;
      renderPickForm(selected);
    });
  });
}

function renderPickForm(selected) {
  const c = state.cards.find((x) => x.id === selected.cardId);
  const form = $('#pick-form');
  if (!c) { form.innerHTML = ''; return; }
  form.innerHTML = myCardFormHtml(c, null);
  bindMyCardForm(form, c, null);
}

function myCardFormHtml(c, m) {
  const bens = m ? (m.benefits || []) : (c.benefits || []).map((name) => ({ name, total: 1, resetCycle: '自然年' }));
  return (
    '<div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--gold-deep)">' + esc(c.name) + ' · ' + esc(c.bank) + '</div>' +
    '<div class="form-grid">' +
    field('别名（可选）', '<input id="f-alias" placeholder="给卡起个名字" value="' + esc(m ? m.alias : '') + '">') +
    field('卡号后四位（选填）', '<input id="f-last4" maxlength="4" placeholder="如 6688" value="' + esc(m ? m.last4 : '') + '">') +
    field('授信额度', '<input id="f-credit" type="number" min="0" step="1000" value="' + (m ? m.creditLimit : (c.startCredit || 0)) + '">') +
    field('月消费目标（选填）', '<input id="f-target" type="number" min="0" step="1000" value="' + (m ? m.monthlySpendTarget : 0) + '">') +
    field('账单日（1-31）', '<input id="f-billing" type="number" min="1" max="31" value="' + (m ? m.billingDay : 1) + '">') +
    field('还款方式', '<select id="f-repaymode"><option value="fixed"' + (!m || m.repayMode !== 'afterBill' ? ' selected' : '') + '>每月固定日</option><option value="afterBill"' + (m && m.repayMode === 'afterBill' ? ' selected' : '') + '>账单日后 N 天</option></select>') +
    field('还款值', '<input id="f-repay" type="number" min="1" max="365" value="' + (m ? (m.repayValue != null ? m.repayValue : m.repaymentDay) : 20) + '" title="固定日=第几日；账单日后N天=天数">') +
    field('宽限期（天）', '<input id="f-grace" type="number" min="0" max="30" value="' + (m ? (m.graceDays || 0) : 3) + '">') +
    field('最长免息期（天，选填）', '<input id="f-interest" type="number" min="0" max="120" value="' + (m ? (m.maxInterestDays || 0) : 0) + '">') +
    field('年费收取月（1-12）', '<input id="f-feemonth" type="number" min="1" max="12" value="' + (m ? m.feeMonth : 1) + '">') +
    field('年费收取日（1-31）', '<input id="f-feeday" type="number" min="1" max="31" value="' + (m ? m.feeDay : 1) + '">') +
    field('已达标年份（手工，选填）', '<input id="f-waivedyear" type="number" min="0" value="' + (m ? (m.waivedYear || 0) : 0) + '" title="填当前年份表示手工声明本年已达标/已减免">') +
    field('已刷核定期（选填）', '<input id="f-countperiod" type="number" min="0" value="' + (m ? (m.countPeriodYear || 0) : 0) + '" title="填年份表示已刷数据统计到该年，跨年后自动失效">') +
    field('合并账单组', groupSelectHtml(m)) +
    '</div>' +
    '<div style="margin-top:12px"><label style="font-size:12px;color:var(--text-2)">权益（名称 / 总次数 / 重置周期）</label>' +
    '<div id="benefit-rows">' + bens.map((b, i) => benefitEditRow(b, i)).join('') + '</div>' +
    '<button class="btn small" id="btn-add-benefit" style="margin-top:6px">＋ 添加权益</button></div>'
  );
}

/** 合并账单组下拉：空 = 不合并；只列出「与本卡还款日一致」或「尚无成员」的组 */
function groupSelectHtml(m) {
  const cur = (m && m.billGroupId) || '';
  const opts = ['<option value="">不合并（单独提醒）</option>'];
  for (const g of state.billGroups || []) {
    if (g.id === cur) { opts.push('<option value="' + esc(g.id) + '" selected>' + esc(g.name) + '</option>'); continue; }
    // 已有成员的组：还款日不一致的不列出来，避免选完才被服务端拒绝
    if (g.memberCount > 0 && !sameRepayAsGroup(m, g)) continue;
    opts.push('<option value="' + esc(g.id) + '">' + esc(g.name) + '（' + g.memberCount + ' 张）</option>');
  }
  return '<select id="f-billgroup">' + opts.join('') + '</select>';
}

/** 前端预判：本卡与组内首个成员的还款节奏是否一致（最终以服务端校验为准） */
function sameRepayAsGroup(m, g) {
  if (!m) return g.memberCount === 0;
  const peer = (state.myCards || []).find((x) => x.billGroupId === g.id);
  if (!peer || !m.payment || !peer.payment) return g.memberCount === 0;
  // 组内一致性由「最后还款日 + 还款方式 + 账单日 + 宽限期」共同决定，任一项不同即视为不一致
  return m.payment.lastPayDate === peer.payment.lastPayDate
    && (m.repayMode || 'fixed') === (peer.repayMode || 'fixed')
    && Number(m.billingDay) === Number(peer.billingDay)
    && Number(m.graceDays || 0) === Number(peer.graceDays || 0);
}

function benefitEditRow(b, i) {  const cycles = state.meta.resetCycles || [];
  const types = state.meta.benefitTypes || [];
  return '<div class="benefit-row" data-i="' + i + '" data-bid="' + esc(b.id || '') + '">' +
    '<input class="b-name" placeholder="权益名称" value="' + esc(b.name) + '">' +
    '<select class="b-type"><option value="">类型（选填）</option>' +
    types.map((t) => '<option' + (t === (b.type || b.benefitType) ? ' selected' : '') + '>' + esc(t) + '</option>').join('') + '</select>' +
    '<input class="b-total" type="number" min="-1" placeholder="次数" title="-1 = 不限次" value="' + (b.total == null ? 1 : b.total) + '">' +
    '<select class="b-cycle">' + cycles.map((c2) => '<option' + (c2 === b.resetCycle ? ' selected' : '') + '>' + c2 + '</option>').join('') + '</select>' +
    '<input class="b-until" type="date" title="有效期至（选填）" value="' + esc(b.validUntil || '') + '">' +
    '<button class="remove-btn" title="删除">✕</button></div>';
}

function bindMyCardForm(form, c, m) {
  $('#btn-add-benefit', form).addEventListener('click', () => {
    const rows = $('#benefit-rows', form);
    rows.insertAdjacentHTML('beforeend', benefitEditRow({ name: '', total: 1, resetCycle: '自然年' }, rows.children.length));
    bindRemoveButtons(form);
  });
  bindRemoveButtons(form);
}

function bindRemoveButtons(form) {
  $$('.benefit-row .remove-btn', form).forEach((btn) => {
    btn.onclick = () => btn.closest('.benefit-row').remove();
  });
}

function collectBenefits(form) {
  return $$('.benefit-row', form).map((row) => {
    const raw = parseInt($('.b-total', row).value, 10);
    const total = isNaN(raw) ? 1 : (raw < 0 ? -1 : raw); // -1 = 不限次
    const bid = row.dataset.bid || '';
    return {
      id: bid, // 稳定 id：权益增删/重排后使用记录仍能对上（空 = 新建，由服务端分配）
      name: $('.b-name', row).value.trim(),
      type: ($('.b-type', row) && $('.b-type', row).value) || '',
      total,
      resetCycle: $('.b-cycle', row).value,
      validUntil: ($('.b-until', row) && $('.b-until', row).value) || '',
    };
  }).filter((b) => b.name);
}

async function saveMyCard(selected, editing) {
  const form = $('#pick-form');
  const body = {
    alias: $('#f-alias', form).value.trim(),
    last4: $('#f-last4', form).value.trim(),
    creditLimit: $('#f-credit', form).value,
    monthlySpendTarget: $('#f-target', form).value,
    billingDay: $('#f-billing', form).value,
    repaymentDay: $('#f-repay', form).value,
    repayMode: ($('#f-repaymode', form) && $('#f-repaymode', form).value) || 'fixed',
    repayValue: $('#f-repay', form).value,
    graceDays: ($('#f-grace', form) && $('#f-grace', form).value) || 0,
    maxInterestDays: ($('#f-interest', form) && $('#f-interest', form).value) || 0,
    feeMonth: $('#f-feemonth', form).value,
    feeDay: $('#f-feeday', form).value,
    waivedYear: ($('#f-waivedyear', form) && $('#f-waivedyear', form).value) || 0,
    countPeriodYear: ($('#f-countperiod', form) && $('#f-countperiod', form).value) || 0,
    billGroupId: ($('#f-billgroup', form) && $('#f-billgroup', form).value) || '',
    benefits: collectBenefits(form),
  };
  try {
    if (editing) {
      await api('/api/mycards/' + editing.id, { method: 'PUT', body });
      toast('已保存修改');
    } else if (selected.custom) {
      // 自定义卡片：先落卡种（进卡种库），再用新卡种 id 建持卡
      const cardId = await ensureCustomCardType(selected.custom, form);
      if (!cardId) return;
      await api('/api/mycards', { method: 'POST', body: Object.assign({ cardId }, body) });
      toast('已添加持卡（卡种已存入卡种库）');
    } else {
      if (!selected.cardId) return toast('请先选择一张卡', 'error');
      await api('/api/mycards', { method: 'POST', body: Object.assign({ cardId: selected.cardId }, body) });
      toast('已添加持卡');
    }
    closeModal();
    await loadAll();
    if (editing) openDrawer(editing.id);
  } catch (e) { toast(e.message, 'error'); }
}

/**
 * 自定义卡片落库：创建卡种并返回其 id。
 * 若卡种库里已有相同「银行+名称+卡组织+卡等级」的卡种，则直接复用，不重复创建。
 * 返回 null 表示校验未通过（已提示用户）。
 */
async function ensureCustomCardType(d, form) {
  const pick = (id) => { const el = $('#' + id, form); return el ? el.value.trim() : ''; };
  const card = {
    bank: pick('c-bank'),
    name: pick('c-name'),
    level: pick('c-level'),
    org: pick('c-org'),
    annualFee: pick('c-fee') || 0,
    startCredit: pick('c-credit') || 0,
    waiverType: pick('c-waivertype') || '免年费',
    waiverCondition: pick('c-condition'),
    waiverPolicy: '',
    benefits: '',
    applyCondition: '',
    note: '',
  };
  if (!card.bank || !card.name) {
    toast('请填写「银行」和「卡片名称」', 'error');
    return null;
  }
  // 已存在同键卡种 → 复用（避免服务端因重复而报错，也避免卡种库里出现两份一样的卡）
  const key = [card.bank, card.name, card.org, card.level].map((x) => String(x || '').trim()).join('|');
  const dup = (state.cards || []).find((c) => [c.bank, c.name, c.org, c.level].map((x) => String(x || '').trim()).join('|') === key);
  if (dup) return dup.id;
  const created = await api('/api/cards', { method: 'POST', body: card });
  return created.id;
}

function openMyCardModal(m) {
  const c = state.cards.find((x) => x.id === m.cardId) || { name: m.name, bank: m.bank, startCredit: m.creditLimit, benefits: [] };
  openModal('<div class="modal-title">编辑持卡</div>',
    '<div id="pick-form">' + myCardFormHtml(c, m) + '</div>',
    '<button class="btn" data-close>取消</button><button class="btn primary" id="btn-save-mycard">保存</button>');
  bindMyCardForm($('#pick-form'), c, m);
  $('#btn-save-mycard').addEventListener('click', () => saveMyCard(null, m));
}

// ---------- 弹窗：记一笔消费 ----------
function openConsumptionModal(m) {
  const channels = state.meta.channels || [];
  const cats = state.meta.categories || [];
  openModal('<div class="modal-title">记一笔 — ' + esc(m.alias || m.name) + '</div>',
    '<div class="form-grid">' +
    field('日期', '<input id="c-date" type="date" value="' + today() + '">') +
    field('金额', '<input id="c-amount" type="number" min="0.01" step="0.01" placeholder="0.00">') +
    field('支付渠道', '<select id="c-channel">' + channels.map((x) => '<option>' + x + '</option>').join('') + '</select>') +
    field('消费分类', '<select id="c-category">' + cats.map((x) => '<option>' + x + '</option>').join('') + '</select>') +
    field('备注（可选）', '<input id="c-note" placeholder="备注">') +
    '</div>',
    '<button class="btn" data-close>取消</button><button class="btn primary" id="btn-save-consumption">保存</button>');
  $('#btn-save-consumption').addEventListener('click', async () => {
    const amount = parseFloat($('#c-amount').value);
    if (!amount || amount <= 0) return toast('请输入大于 0 的金额', 'error');
    try {
      await api('/api/mycards/' + m.id + '/consumptions', {
        method: 'POST',
        body: { date: $('#c-date').value, amount, channel: $('#c-channel').value, category: $('#c-category').value, note: $('#c-note').value.trim() },
      });
      toast('已记录');
      closeModal();
      await loadAll();
    } catch (e) { toast(e.message, 'error'); }
  });
}

// ---------- 弹窗：消费明细 ----------
async function openRecordsModal(m, scope) {
  const titles = { month: '本月明细', year: '本年明细', all: '累计明细' };
  let recs;
  try {
    const data = await api('/api/mycards/' + m.id + '/consumptions?scope=' + scope);
    recs = data.records;
  } catch (e) { return toast(e.message, 'error'); }

  let body;
  if (!recs.length) {
    body = '<div class="empty-tip">暂无记录</div>';
  } else if (scope === 'month') {
    body = recordsTable(recs, true);
  } else if (scope === 'year') {
    const byMonth = groupBy(recs, (r) => r.date.slice(0, 7));
    body = byMonth.map(([k, list]) => groupHtml(k + ' 月', list, true)).join('');
  } else {
    const byYear = groupBy(recs, (r) => r.date.slice(0, 4));
    body = byYear.map(([y, list]) => {
      const byMonth = groupBy(list, (r) => r.date.slice(0, 7));
      return '<div class="record-group"><div class="record-group-header" data-toggle><span class="collapse-arrow">▾</span>' + y + ' 年<span class="count">' + list.length + ' 笔</span><span class="sum">' + fmtMoney(sum(list)) + '</span></div>' +
        '<div class="record-group-body">' + byMonth.map(([k2, l2]) => groupHtml(k2 + ' 月', l2, true)).join('') + '</div></div>';
    }).join('');
  }
  const total = recs.reduce((s, r) => s + r.amount, 0);
  openModal('<div class="modal-title">' + titles[scope] + ' — ' + esc(m.alias || m.name) + '（共 ' + recs.length + ' 笔 / ' + fmtMoney(total) + '）</div>',
    '<div class="scroll-y">' + body + '</div>',
    '<button class="btn primary" data-close>关闭</button>');
  bindRecordGroups($('#modal'));
  bindRecordDelete($('#modal'), m.id);
}

function groupHtml(title, list, canDelete) {
  return '<div class="record-group"><div class="record-group-header" data-toggle><span class="collapse-arrow">▾</span>' + esc(title) +
    '<span class="count">' + list.length + ' 笔</span><span class="sum">' + fmtMoney(sum(list)) + '</span></div>' +
    '<div class="record-group-body">' + recordsTable(list, canDelete) + '</div></div>';
}

function recordsTable(recs, canDelete) {
  return '<table class="record-table"><thead><tr><th>日期</th><th>渠道</th><th>分类</th><th>备注</th><th style="text-align:right">金额</th>' + (canDelete ? '<th></th>' : '') + '</tr></thead><tbody>' +
    recs.map((r) => '<tr><td>' + esc(r.date) + '</td><td>' + esc(r.channel) + '</td><td>' + esc(r.category) + '</td><td>' + esc(r.note || '') + '</td><td class="amount">' + fmtMoney(r.amount) + '</td>' +
      (canDelete ? '<td class="row-del"><button class="link-btn danger" data-cons-del="' + esc(r.id) + '" title="删除这条记录">删</button></td>' : '') +
      '</tr>').join('') +
    '</tbody></table>';
}

function bindRecordDelete(root, myCardId) {
  $$('[data-cons-del]', root).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.consDel;
      if (!(await confirmDialog('确定删除这条消费记录？删除后统计与刷免进度将同步减少。'))) return;
      try {
        await api('/api/mycards/' + myCardId + '/consumptions/' + id, { method: 'DELETE' });
        toast('已删除');
        closeModal();
        await loadAll();
      } catch (e) { toast(e.message, 'error'); }
    });
  });
}

function bindRecordGroups(root) {
  $$('.record-group-header', root).forEach((h) => {
    h.addEventListener('click', () => h.closest('.record-group').classList.toggle('collapsed'));
  });
}

function groupBy(arr, fn) {
  const map = new Map();
  for (const x of arr) {
    const k = fn(x);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  }
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
}
function sum(arr) { return arr.reduce((s, r) => s + (Number(r.amount) || 0), 0); }

// ---------- 弹窗：权益使用 ----------
function openBenefitModal(m, idx) {
  const b = (m.benefits || [])[idx];
  openModal('<div class="modal-title">权益记一笔 — ' + esc(b.name) + '</div>',
    '<div class="form-grid">' +
    field('日期', '<input id="b-date" type="date" value="' + today() + '">') +
    field('备注（可选）', '<input id="b-note" placeholder="如：上海机场T2">') +
    '</div>' +
    '<div style="font-size:12px;color:var(--text-3);margin-top:8px">当前周期已用 ' + b.used + ' 次（' + esc(b.resetCycle) + '重置' + (b.unlimited ? '，不限次数' : '，上限 ' + b.total + ' 次') + '）</div>',
    '<button class="btn" data-close>取消</button><button class="btn primary" id="btn-save-benefit">保存</button>');
  $('#btn-save-benefit').addEventListener('click', async () => {
    try {
      await api('/api/mycards/' + m.id + '/benefits/' + idx + '/usage', {
        method: 'POST', body: { date: $('#b-date').value, note: $('#b-note').value.trim(), bid: b.id || '' },
      });
      toast('已记录');
      closeModal();
      await loadAll();
    } catch (e) { toast(e.message, 'error'); }
  });
}

async function openBenefitHistoryModal(m, idx) {
  const b = (m.benefits || [])[idx];
  let groups;
  try { groups = await api('/api/mycards/' + m.id + '/benefits/' + idx + '/history?bid=' + encodeURIComponent(b.id || '')); }
  catch (e) { return toast(e.message, 'error'); }
  const body = groups.length
    ? groups.map((g) =>
        '<div class="record-group"><div class="record-group-header" data-toggle>' +
        '<span class="collapse-arrow">▾</span>周期 ' + esc(g.key) +
        '<span class="count">已用 ' + g.used + ' 次</span></div>' +
        '<div class="record-group-body"><table class="record-table"><thead><tr><th>日期</th><th>说明</th></tr></thead><tbody>' +
        g.records.map((r) => '<tr><td>' + esc(r.date) + '</td><td>' + esc(r.note || '') + '</td></tr>').join('') +
        '</tbody></table></div></div>').join('')
    : '<div class="empty-tip">暂无历史记录</div>';
  openModal('<div class="modal-title">历史记录 — ' + esc(b.name) + '（' + esc(b.resetCycle) + '重置）</div>',
    '<div class="scroll-y">' + body + '</div>',
    '<button class="btn primary" data-close>关闭</button>');
  bindRecordGroups($('#modal'));
}

// ---------- 弹窗：新增 / 编辑卡种 ----------
function openCardTypeModal(id) {
  const c = id ? state.cards.find((x) => x.id === id) : null;
  const types = state.meta.waiverTypes || [];
  openModal('<div class="modal-title">' + (c ? '编辑卡种' : '新增卡种') + '</div>',
    '<div class="form-grid">' +
    field('银行', '<input id="t-bank" value="' + esc(c ? c.bank : '') + '" placeholder="如 招商银行">') +
    field('卡片名称', '<input id="t-name" value="' + esc(c ? c.name : '') + '" placeholder="如 经典白金卡">') +
    field('卡等级', '<input id="t-level" value="' + esc(c ? c.level : '') + '" placeholder="如 白金卡">') +
    field('卡组织', '<input id="t-org" value="' + esc(c ? c.org : '') + '" placeholder="如 银联/VISA">') +
    field('年费（元）', '<input id="t-fee" value="' + (c ? c.annualFee : 0) + '" placeholder="如 3600 或 0">') +
    field('起批额度（元）', '<input id="t-credit" value="' + (c ? c.startCredit : 0) + '" placeholder="如 50000 或 5万">') +
    field('免年费类型', '<select id="t-waivertype">' + types.map((x) => '<option' + (c && c.waiverType === x ? ' selected' : '') + '>' + x + '</option>').join('') + '</select>') +
    field('刷免条件', '<input id="t-condition" value="' + esc(c ? c.waiverCondition : '') + '" placeholder="金额/笔数/积分/存款，如 10万、10笔、10000">') +
    field('免年费政策', '<input id="t-policy" class="full" value="' + esc(c ? c.waiverPolicy : '') + '" placeholder="政策说明">') +
    field('主要权益（多个用 | 分隔）', '<textarea id="t-benefits" placeholder="机场贵宾厅|积分兑换里程|道路救援">' + esc(c ? (c.benefits || []).join('|') : '') + '</textarea>') +
    field('申请条件', '<input id="t-apply" value="' + esc(c ? c.applyCondition : '') + '" placeholder="申请条件">') +
    field('备注', '<input id="t-note" value="' + esc(c ? c.note : '') + '" placeholder="备注">') +
    '</div>',
    '<button class="btn" data-close>取消</button><button class="btn primary" id="btn-save-cardtype">保存</button>');
  $('#btn-save-cardtype').addEventListener('click', async () => {
    const body = {
      bank: $('#t-bank').value.trim(),
      name: $('#t-name').value.trim(),
      level: $('#t-level').value.trim(),
      org: $('#t-org').value.trim(),
      annualFee: $('#t-fee').value,
      startCredit: $('#t-credit').value,
      waiverType: $('#t-waivertype').value,
      waiverCondition: $('#t-condition').value.trim(),
      waiverPolicy: $('#t-policy').value.trim(),
      benefits: $('#t-benefits').value,
      applyCondition: $('#t-apply').value.trim(),
      note: $('#t-note').value.trim(),
    };
    try {
      if (c) await api('/api/cards/' + c.id, { method: 'PUT', body });
      else await api('/api/cards', { method: 'POST', body });
      toast(c ? '卡种已更新' : '卡种已添加');
      closeModal();
      await loadAll();
    } catch (e) { toast(e.message, 'error'); }
  });
}

async function deleteCardType(id) {
  const c = state.cards.find((x) => x.id === id);
  if (!c) return toast('卡种不存在，可能已被删除', 'error');
  if (!(await confirmDialog('确定删除卡种「' + c.name + '」？已添加的持卡不受影响（快照保留）。'))) return;
  try {
    await api('/api/cards/' + id, { method: 'DELETE' });
    toast('已删除');
    await loadAll();
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- 弹窗：批量导入 ----------
function openImportModal() {
  openModal('<div class="modal-title">批量导入卡种（CSV）</div>',
    '<div style="font-size:12px;color:var(--text-2);margin-bottom:10px">表头：' + esc((state.meta.csvHeader || []).join(',')) +
    '<br>金额支持纯数字或数字+单位（如 5万）；多个权益用 | 分隔；免年费类型：' + esc((state.meta.waiverTypes || []).join(' / ')) +
    '<br>已存在的卡种（银行+名称+卡组织+卡等级）会自动跳过。</div>' +
    '<div class="field" style="margin-bottom:10px"><label>选择 CSV 文件</label><input type="file" id="import-file" accept=".csv,text/csv"></div>' +
    '<div class="field"><label>或直接粘贴 CSV 内容</label><textarea id="import-text" style="min-height:120px" placeholder="银行,卡片名称,卡等级,…"></textarea></div>' +
    '<div id="import-result" style="margin-top:10px"></div>',
    '<button class="btn" data-close>取消</button><button class="btn primary" id="btn-do-import">开始导入</button>');
  $('#btn-do-import').addEventListener('click', async () => {
    const btn = $('#btn-do-import');
    if (btn.disabled) return; // 防重复提交：文件读取+解析期间按钮置灰
    const file = $('#import-file').files[0];
    let text = $('#import-text').value;
    if (file) {
      try { text = await file.text(); }
      catch (e) { return toast('文件读取失败：' + (e.message || e.name), 'error'); }
    }
    if (!text.trim()) return toast('请选择文件或粘贴内容', 'error');
    btn.disabled = true;
    try {
      const r = await api('/api/cards/import', { method: 'POST', body: { csv: text } });
      $('#import-result').innerHTML =
        '<div class="badge badge-green">成功导入 ' + r.added + ' 张</div> ' +
        (r.skipped.length ? '<div class="badge badge-yellow" style="margin-left:6px">跳过 ' + r.skipped.length + ' 张（已存在）</div>' : '') +
        (r.errors.length ? '<div class="badge badge-red" style="margin-left:6px">' + r.errors.length + ' 行有误</div>' : '');
      toast('导入完成');
      await loadAll();
    } catch (e) { toast(e.message, 'error'); }
    btn.disabled = false;
  });
}

function field(label, inputHtml) {
  return '<div class="field"><label>' + label + '</label>' + inputHtml + '</div>';
}

/* ============================================================
 * 扩展资产页面（移植自 Benefit Tracker）
 *   卡/票（vouchers）· 会员储值（memberships）· 知识库（knowledge）· 统计（assetstats）
 * ============================================================ */

// ---------- 通用小工具 ----------
function daysBadge(expiry) {
  if (!expiry) return '';
  const d = new Date(expiry + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const left = Math.round((d - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  if (left < 0) return '<span class="badge badge-red">已过期</span>';
  if (left <= 7) return '<span class="badge badge-red">' + left + ' 天后到期</span>';
  if (left <= 30) return '<span class="badge badge-yellow">' + left + ' 天后到期</span>';
  return '<span class="badge badge-default">' + left + ' 天后到期</span>';
}

function emptyBox(msg) { return '<div class="empty-tip">' + msg + '</div>'; }

// ---------- 页面三：卡/票 ----------
const VOU_TYPE_BADGE = { coupon: 'badge-blue', storedcard: 'badge-gold', fullred: 'badge-purple' };

function renderVouchers() {
  const list = state.vouchers || [];
  const brands = state.voucherBrands || [];
  const typeCount = { all: list.length, coupon: 0, storedcard: 0, fullred: 0 };
  for (const v of list) if (typeCount[v.type] != null) typeCount[v.type]++;
  let html =
    '<div class="page-title">卡 / 票</div>' +
    '<div class="page-desc">优惠券、储值卡、满减券统一管理，支持核销、回退与余额充值</div>' +
    '<div class="toolbar">' +
    '<button class="btn primary" id="btn-vou-add">＋ 添加卡/票</button>' +
    '<button class="btn" id="btn-brand-add">商家管理</button>' +
    '<div class="spacer"></div>' +
    '<select id="vou-type-filter" class="filter-select">' +
    option2('all', '全部（' + typeCount.all + '）', state.voucherTypeFilter) +
    option2('coupon', '优惠券（' + typeCount.coupon + '）', state.voucherTypeFilter) +
    option2('storedcard', '储值卡（' + typeCount.storedcard + '）', state.voucherTypeFilter) +
    option2('fullred', '满减券（' + typeCount.fullred + '）', state.voucherTypeFilter) +
    '</select></div>';

  if (!list.length) return html + emptyBox('还没有卡/票，点「添加卡/票」开始记录');

  // 按商家分组（brand 为空归入「未指定商家」）
  const byBrand = {};
  for (const v of list) {
    if (state.voucherTypeFilter !== 'all' && v.type !== state.voucherTypeFilter) continue;
    const key = v.brand || '未指定商家';
    if (!byBrand[key]) byBrand[key] = [];
    byBrand[key].push(v);
  }
  const keys = Object.keys(byBrand).sort((a, b) => a.localeCompare(b, 'zh'));
  if (!keys.length) return html + emptyBox('当前筛选条件下没有卡/票');
  for (const brand of keys) {
    const items = byBrand[brand].slice().sort((a, b) => String(a.expiry || '9999').localeCompare(String(b.expiry || '9999')));
    html +=
      '<div class="bank-group"><div class="bank-header" style="cursor:default">' +
      '<span class="bank-name">' + esc(brand) + '</span>' +
      '<span class="bank-count">' + items.length + ' 张</span>' +
      '<span class="bank-actions" style="font-size:12px;color:var(--text-3)">' +
      esc(summarizeBrand(items)) + '</span></div>' +
      '<div class="bank-body">' +
      items.map(voucherRowHtml).join('') +
      '</div></div>';
  }
  return html;
}

/**
 * 商家行汇总：基于「当前筛选后」的券列表统计。
 * 此前按商家名回读全量券列表，类型筛选（如只看储值卡）下汇总数字与行内容不符。
 */
function summarizeBrand(items) {
  let countLeft = 0, moneyLeft = 0;
  for (const v of items) {
    if (v.mode === 'amount') moneyLeft += Number(v.balance) || 0;
    else countLeft += Math.max(0, (Number(v.totalUses) || 0) - (Number(v.usedUses) || 0));
  }
  const parts = [];
  if (countLeft) parts.push('剩 ' + fmtInt(countLeft) + ' 次');
  if (moneyLeft) parts.push('余额 ' + fmtMoney(moneyLeft));
  return parts.join(' · ');
}

function voucherRowHtml(v) {
  const typeLabel = (v.typeLabel) || ({ coupon: '优惠券', storedcard: '储值卡', fullred: '满减券' }[v.type] || v.type);
  const badge = '<span class="badge ' + (VOU_TYPE_BADGE[v.type] || 'badge-default') + '">' + esc(typeLabel) + '</span>';
  let remainHtml = '';
  if (v.mode === 'amount') {
    remainHtml = '<div class="card-sub">余额 <b style="color:var(--gold-deep)">' + fmtMoney(v.balance) + '</b></div>';
  } else {
    const total = Number(v.totalUses) || 0, used = Number(v.usedUses) || 0;
    const left = Math.max(0, total - used);
    const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
    remainHtml =
      '<div class="progress" style="margin-top:4px"><div class="progress-track"><div class="progress-fill' + (left === 0 ? ' done' : '') + '" style="width:' + pct + '%"></div></div>' +
      '<div class="progress-text"><span>已用 ' + used + ' / ' + total + '</span><span class="remaining' + (left === 0 ? ' over' : '') + '">剩 ' + left + ' 次</span></div></div>';
  }
  const ruleHtml = v.type === 'fullred' ? '<div class="card-sub">满 ' + fmtMoney(v.threshold) + ' 减 ' + fmtMoney(v.discount) + '</div>' : '';
  const scopeHtml = v.scope ? '<div class="card-sub">适用：' + esc(v.scope) + '</div>' : '';
  return '<div class="card-row" data-vou-id="' + esc(v.id) + '">' +
    '<div><div class="card-name">' + esc(v.name) + ' ' + badge + '</div>' +
    '<div class="card-sub">' + esc(v.brand || '未指定商家') + (v.note ? ' · ' + esc(v.note) : '') + '</div>' +
    ruleHtml + scopeHtml + '</div>' +
    '<div>' + remainHtml + '</div>' +
    '<div class="fee-cell">' + daysBadge(v.expiry) + '</div>' +
    '<div><button class="btn small" data-act="vou-use">核销</button> <button class="btn small" data-act="vou-detail">详情</button></div>' +
    '</div>';
}

function option2(value, label, cur) {
  return '<option value="' + value + '"' + (cur === value ? ' selected' : '') + '>' + label + '</option>';
}

// 卡/票 表单（新建/编辑共用）
function voucherFormHtml(v) {
  v = v || {};
  const brands = (state.voucherBrands || []).map((b) => b.name);
  const brandOpts = ['<option value="">（自由填写）</option>']
    .concat(brands.map((b) => '<option' + (v.brand === b ? ' selected' : '') + '>' + esc(b) + '</option>')).join('');
  const type = v.type || 'coupon';
  return '<div class="form-grid">' +
    field('商家', '<select id="v-brand-sel">' + brandOpts + '</select>') +
    field('或填写商家名', '<input id="v-brand" value="' + esc(v.brand || '') + '" placeholder="如 星巴克">') +
    field('名称 <span style="color:var(--red)">*</span>', '<input id="v-name" value="' + esc(v.name || '') + '" placeholder="如 咖啡买一送一">') +
    field('类型', '<select id="v-type">' +
      '<option value="coupon"' + (type === 'coupon' ? ' selected' : '') + '>优惠券（按次）</option>' +
      '<option value="storedcard"' + (type === 'storedcard' ? ' selected' : '') + '>储值卡（按金额）</option>' +
      '<option value="fullred"' + (type === 'fullred' ? ' selected' : '') + '>满减券（次数+满减）</option>' +
      '</select>') +
    '<div class="full" id="v-count-fields">' +
    field('总次数', '<input id="v-total" type="number" min="0" value="' + (v.totalUses != null ? v.totalUses : 1) + '">') +
    field('已用次数（编辑时改这里可修正）', '<input id="v-used" type="number" min="0" value="' + (v.usedUses || 0) + '">') +
    '</div>' +
    '<div class="full" id="v-amount-fields" style="display:none">' +
    field('余额（元）', '<input id="v-balance" type="number" min="0" step="0.01" value="' + (v.balance != null ? v.balance : 0) + '">') +
    '</div>' +
    '<div class="full" id="v-fullred-fields" style="display:none">' +
    field('满减门槛（满 X 元可用）', '<input id="v-threshold" type="number" min="0" step="0.01" value="' + (v.threshold || 0) + '">') +
    field('优惠金额（减 Y 元）', '<input id="v-discount" type="number" min="0" step="0.01" value="' + (v.discount || 0) + '">') +
    '</div>' +
    field('有效期至（选填）', '<input id="v-expiry" type="date" value="' + esc(v.expiry || '') + '">') +
    field('适用范围（选填）', '<input id="v-scope" value="' + esc(v.scope || '') + '" placeholder="如 仅门店/限新品">') +
    '<div class="full">' + field('备注（选填）', '<input id="v-note" value="' + esc(v.note || '') + '" placeholder="备注">') + '</div>' +
    '</div>';
}

function openVoucherModal(id) {
  const editing = id ? (state.vouchers || []).find((x) => x.id === id) : null;
  if (id && !editing) return toast('卡/票不存在或已被删除', 'error');
  openModal('<div class="modal-title">' + (editing ? '编辑卡/票' : '添加卡/票') + '</div>', voucherFormHtml(editing),
    '<button class="btn" data-close>取消</button><button class="btn primary" id="btn-vou-save">保存</button>');
  const syncTypeFields = () => {
    const t = $('#v-type').value;
    $('#v-count-fields').style.display = t === 'storedcard' ? 'none' : '';
    $('#v-amount-fields').style.display = t === 'storedcard' ? '' : 'none';
    $('#v-fullred-fields').style.display = t === 'fullred' ? '' : 'none';
  };
  $('#v-type').addEventListener('change', syncTypeFields);
  syncTypeFields();
  $('#btn-vou-save').addEventListener('click', async () => {
    const brandSel = $('#v-brand-sel').value;
    const body = {
      brand: ($('#v-brand').value.trim() || brandSel || '').trim(),
      name: $('#v-name').value.trim(),
      type: $('#v-type').value,
      expiry: $('#v-expiry').value,
      scope: $('#v-scope').value.trim(),
      note: $('#v-note').value.trim(),
    };
    if (!body.name) return toast('请填写名称', 'error');
    if (body.type === 'storedcard') body.balance = $('#v-balance').value;
    else {
      body.totalUses = $('#v-total').value;
      if (editing) body.usedUses = $('#v-used').value;
      if (body.type === 'fullred') { body.threshold = $('#v-threshold').value; body.discount = $('#v-discount').value; }
    }
    try {
      if (editing) await api('/api/vouchers/' + editing.id, { method: 'PUT', body });
      else await api('/api/vouchers', { method: 'POST', body });
      toast(editing ? '已保存' : '已添加');
      closeModal();
      await loadAll();
    } catch (e) { toast(e.message, 'error'); }
  });
}

// 核销弹窗：按类型分流（次数核销 / 金额核销 / 满减校验）
function openVoucherUseModal(id) {
  const v = (state.vouchers || []).find((x) => x.id === id);
  if (!v) return toast('卡/票不存在或已被删除', 'error');
  if (v.mode === 'amount') {
    openModal('<div class="modal-title">金额核销 — ' + esc(v.name) + '</div>',
      '<div class="form-grid">' +
      field('本单消费金额', '<input id="vu-amount" type="number" min="0.01" step="0.01" placeholder="0.00">') +
      field('日期', '<input id="vu-date" type="date" value="' + today() + '">') +
      field('备注（可选）', '<input id="vu-note" placeholder="备注">') +
      '</div>' +
      '<div style="font-size:12px;color:var(--text-3);margin-top:8px">当前余额 ' + fmtMoney(v.balance) + '</div>',
      '<button class="btn" data-close>取消</button><button class="btn primary" id="btn-vu-save">核销</button>');
    $('#btn-vu-save').addEventListener('click', async () => {
      const amount = parseFloat($('#vu-amount').value);
      if (!amount || amount <= 0) return toast('请输入大于 0 的金额', 'error');
      try {
        const r = await api('/api/vouchers/' + v.id + '/topup', { method: 'POST', body: { kind: 'consume', amount, date: $('#vu-date').value, note: $('#vu-note').value.trim() } });
        toast('已核销，余额 ' + fmtMoney(r.balance));
        closeModal();
        await loadAll();
      } catch (e) { toast(e.message, 'error'); }
    });
    return;
  }
  const fullredRow = v.type === 'fullred'
    ? field('本单金额（满 ' + fmtMoney(v.threshold) + ' 可用）', '<input id="vu-spend" type="number" min="0" step="0.01" placeholder="0.00">')
    : '';
  openModal('<div class="modal-title">核销 — ' + esc(v.name) + '</div>',
    '<div class="form-grid">' + fullredRow +
    field('日期', '<input id="vu-date" type="date" value="' + today() + '">') +
    field('备注（可选）', '<input id="vu-note" placeholder="备注">') +
    '</div>' +
    '<div style="font-size:12px;color:var(--text-3);margin-top:8px">已用 ' + (v.usedUses || 0) + ' / ' + v.totalUses + ' 次</div>',
    '<button class="btn" data-close>取消</button><button class="btn primary" id="btn-vu-save">核销</button>');
  $('#btn-vu-save').addEventListener('click', async () => {
    const body = { date: $('#vu-date').value, note: $('#vu-note').value.trim() };
    if (v.type === 'fullred') {
      const spend = parseFloat($('#vu-spend').value);
      if (!spend || spend <= 0) return toast('满减券需填写本单金额', 'error');
      body.amount = spend;
    }
    try {
      const r = await api('/api/vouchers/' + v.id + '/use', { method: 'POST', body });
      toast('已核销，剩 ' + Math.max(0, (v.totalUses || 0) - r.usedUses) + ' 次');
      closeModal();
      await loadAll();
    } catch (e) { toast(e.message, 'error'); }
  });
}

// 储值卡充值弹窗
function openVoucherTopupModal(id) {
  const v = (state.vouchers || []).find((x) => x.id === id);
  if (!v) return toast('卡/票不存在或已被删除', 'error');
  openModal('<div class="modal-title">充值 — ' + esc(v.name) + '</div>',
    '<div class="form-grid">' +
    field('充值金额', '<input id="vt-amount" type="number" min="0.01" step="0.01" placeholder="0.00">') +
    field('日期', '<input id="vt-date" type="date" value="' + today() + '">') +
    field('备注（可选）', '<input id="vt-note" placeholder="如 购卡支出">') +
    '</div>' +
    '<div style="font-size:12px;color:var(--text-3);margin-top:8px">当前余额 ' + fmtMoney(v.balance) + '</div>',
    '<button class="btn" data-close>取消</button><button class="btn primary" id="btn-vt-save">充值</button>');
  $('#btn-vt-save').addEventListener('click', async () => {
    const amount = parseFloat($('#vt-amount').value);
    if (!amount || amount <= 0) return toast('请输入大于 0 的金额', 'error');
    try {
      const r = await api('/api/vouchers/' + v.id + '/topup', { method: 'POST', body: { kind: 'topup', amount, date: $('#vt-date').value, note: $('#vt-note').value.trim() } });
      toast('已充值，余额 ' + fmtMoney(r.balance));
      closeModal();
      await loadAll();
    } catch (e) { toast(e.message, 'error'); }
  });
}

// 卡/票详情抽屉（流水 + 编辑 + 删除）
function openVoucherDetail(id) {
  const v = (state.vouchers || []).find((x) => x.id === id);
  if (!v) return;
  const root = $('#drawer-root');
  root.innerHTML = '<div class="overlay"></div><div class="drawer" id="drawer"></div>';
  const txns = (v.transactions || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const rows = txns.map((t) => '<tr><td>' + esc(t.date) + '</td>' +
    '<td><span class="badge ' + (t.kind === 'topup' ? 'badge-green' : 'badge-default') + '">' + (t.kind === 'topup' ? '充值' : '核销') + '</span></td>' +
    '<td>' + (v.mode === 'amount' ? fmtMoney(t.amount) : '1 次') + '</td>' +
    '<td>' + esc(t.note || '') + '</td></tr>').join('');
  const info = v.mode === 'amount'
    ? infoItem('余额', fmtMoney(v.balance))
    : infoItem('剩余次数', Math.max(0, (Number(v.totalUses) || 0) - (Number(v.usedUses) || 0)) + ' / ' + v.totalUses);
  $('#drawer', root).innerHTML =
    '<div class="drawer-header"><div class="drawer-title">' + esc(v.name) +
    '<div class="drawer-sub">' + esc(v.brand || '未指定商家') + ' · ' + esc(v.typeLabel || v.type) + '</div></div>' +
    '<button class="drawer-close" data-act="close">✕</button></div>' +
    '<div class="drawer-body">' +
    '<div class="drawer-section"><h3>基础信息</h3><div class="info-grid">' +
    info + infoItem('有效期', v.expiry ? esc(v.expiry) + ' ' + daysBadge(v.expiry) : '长期有效') +
    (v.type === 'fullred' ? infoItem('满减规则', '满 ' + fmtMoney(v.threshold) + ' 减 ' + fmtMoney(v.discount)) : '') +
    (v.scope ? infoItem('适用范围', esc(v.scope)) : '') +
    (v.note ? infoItem('备注', esc(v.note)) : '') +
    '</div>' +
    '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
    '<button class="btn small primary" data-act="v-detail-use">核销</button>' +
    (v.mode === 'amount' ? '<button class="btn small" data-act="v-detail-topup">充值</button>' : '') +
    '<button class="btn small" data-act="v-detail-edit">编辑</button>' +
    '<button class="btn small danger" data-act="v-detail-del">删除</button>' +
    '</div></div>' +
    '<div class="drawer-section"><h3>流水记录（' + txns.length + '）</h3>' +
    (txns.length ? '<table class="record-table"><thead><tr><th>日期</th><th>类型</th><th>数量</th><th>备注</th></tr></thead><tbody>' + rows + '</tbody></table>'
      : '<div style="font-size:13px;color:var(--text-3)">暂无流水</div>') +
    '</div></div>';
  requestAnimationFrame(() => { $('.overlay', root).classList.add('show'); $('#drawer', root).classList.add('show'); });
  const close = () => { root.innerHTML = ''; };
  $('.overlay', root).addEventListener('click', close);
  $('[data-act="close"]', root).addEventListener('click', close);
  $('[data-act="v-detail-use"]', root).addEventListener('click', () => { close(); openVoucherUseModal(v.id); });
  const topupBtn = $('[data-act="v-detail-topup"]', root);
  if (topupBtn) topupBtn.addEventListener('click', () => { close(); openVoucherTopupModal(v.id); });
  $('[data-act="v-detail-edit"]', root).addEventListener('click', () => { close(); openVoucherModal(v.id); });
  $('[data-act="v-detail-del"]', root).addEventListener('click', async () => {
    if (!(await confirmDialog('确定删除「' + v.name + '」？流水将一并删除。'))) return;
    try {
      await api('/api/vouchers/' + v.id, { method: 'DELETE' });
      toast('已删除');
      close();
      await loadAll();
    } catch (e) { toast(e.message, 'error'); }
  });
}

// 商家管理弹窗
function openBrandsModal() {
  const renderList = (brands) => {
    return brands.length
      ? brands.map((b) => '<div class="bg-group" data-bid="' + esc(b.id) + '"><div class="bg-head"><span class="bg-name">' + esc(b.name) + '</span>' +
        '<span class="badge badge-default">' + (state.vouchers || []).filter((v) => v.brand === b.name).length + ' 张券</span>' +
        '<div style="flex:1"></div>' +
        '<button class="btn small" data-act="brand-edit">编辑</button> ' +
        '<button class="btn small danger" data-act="brand-del">删除</button></div>' +
        (b.note ? '<div style="font-size:12px;color:var(--text-3);margin-top:4px">' + esc(b.note) + '</div>' : '') +
        '</div>').join('')
      : '<div class="empty-tip" style="padding:16px">还没有商家，可先建商家再往里加券</div>';
  };
  openModal('<div class="modal-title">商家管理</div>',
    '<div style="display:flex;gap:8px;margin-bottom:12px">' +
    '<input id="brand-new-name" placeholder="商家名称" style="flex:1;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);outline:none">' +
    '<button class="btn primary" id="btn-brand-new">添加</button></div>' +
    '<div id="brand-list">' + renderList(state.voucherBrands || []) + '</div>',
    '<button class="btn primary" data-close>关闭</button>');
  $('#btn-brand-new').addEventListener('click', async () => {
    const name = $('#brand-new-name').value.trim();
    if (!name) return toast('请填写商家名称', 'error');
    try {
      await api('/api/voucherbrands', { method: 'POST', body: { name } });
      state.voucherBrands = await api('/api/voucherbrands');
      $('#brand-list').innerHTML = renderList(state.voucherBrands);
      bindBrandActions();
      $('#brand-new-name').value = '';
      toast('商家已添加');
    } catch (e) { toast(e.message, 'error'); }
  });
  const bindBrandActions = () => {
    $$('#brand-list [data-act="brand-edit"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const bid = btn.closest('.bg-group').dataset.bid;
        const b = state.voucherBrands.find((x) => x.id === bid);
        const name = prompt('修改商家名称', b ? b.name : '');
        if (name == null) return;
        try {
          await api('/api/voucherbrands/' + bid, { method: 'PUT', body: { name: name.trim() } });
          state.voucherBrands = await api('/api/voucherbrands');
          $('#brand-list').innerHTML = renderList(state.voucherBrands);
          bindBrandActions();
          toast('已保存');
        } catch (e) { toast(e.message, 'error'); }
      });
    });
    $$('#brand-list [data-act="brand-del"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const bid = btn.closest('.bg-group').dataset.bid;
        if (!(await confirmDialog('确定删除该商家？券上保留的文字品牌不受影响。'))) return;
        try {
          await api('/api/voucherbrands/' + bid, { method: 'DELETE' });
          state.voucherBrands = await api('/api/voucherbrands');
          $('#brand-list').innerHTML = renderList(state.voucherBrands);
          bindBrandActions();
          toast('已删除');
        } catch (e) { toast(e.message, 'error'); }
      });
    });
  };
  bindBrandActions();
}

// ---------- 页面四：会员储值 ----------
const MEM_CAT_BADGE = {
  video: 'badge-purple', ecard: 'badge-gold', dining: 'badge-orange', fitness: 'badge-green',
  beauty: 'badge-red', travel: 'badge-blue', course: 'badge-blue', tool: 'badge-default', subscription: 'badge-default', other: 'badge-default',
};

function renderMemberships() {
  const list = state.memberships || [];
  const meta = state.meta.memCatLabels || {};
  let html =
    '<div class="page-title">会员 / 储值卡</div>' +
    '<div class="page-desc">视频会员、健身年卡、储值卡等订阅资产管理，金额与次数两种模式</div>' +
    '<div class="toolbar"><button class="btn primary" id="btn-mem-add">＋ 添加会员卡</button>' +
    '<div class="spacer"></div>' +
    '<select id="mem-cat-filter" class="filter-select">' +
    option2('all', '全部分类', state.membershipCatFilter) +
    Object.keys(meta).map((k) => option2(k, meta[k], state.membershipCatFilter)).join('') +
    '</select></div>';

  if (!list.length) return html + emptyBox('还没有会员卡，点「添加会员卡」开始管理');

  const cat = state.membershipCatFilter === 'all' ? '' : state.membershipCatFilter;
  const filtered = cat ? list.filter((m) => m.category === cat) : list;
  if (!filtered.length) return html + emptyBox('当前分类下没有会员卡');

  // 分类分组展示
  const byCat = {};
  for (const m of filtered) {
    const key = meta[m.category] || '其他';
    if (!byCat[key]) byCat[key] = [];
    byCat[key].push(m);
  }
  const cats = Object.keys(byCat).sort((a, b) => a.localeCompare(b, 'zh'));
  for (const catName of cats) {
    const items = byCat[catName].slice().sort((a, b) => String(a.expiry || '9999').localeCompare(String(b.expiry || '9999')));
    html += '<div class="bank-group"><div class="bank-header" style="cursor:default">' +
      '<span class="bank-name">' + esc(catName) + '</span><span class="bank-count">' + items.length + ' 张</span></div>' +
      '<div class="bank-body">' + items.map(memRowHtml).join('') + '</div></div>';
  }
  return html;
}

function memRowHtml(m) {
  const catLabel = (state.meta.memCatLabels || {})[m.category] || '其他';
  let remainHtml;
  if (m.mode === 'amount') {
    remainHtml = '<div class="card-sub">余额 <b style="color:var(--gold-deep)">' + fmtMoney(m.balance) + '</b></div>';
  } else {
    const total = Number(m.totalUses) || 0, used = Number(m.usedUses) || 0;
    const left = Math.max(0, total - used);
    const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
    remainHtml = '<div class="progress" style="margin-top:4px"><div class="progress-track"><div class="progress-fill' + (left === 0 ? ' done' : '') + '" style="width:' + pct + '%"></div></div>' +
      '<div class="progress-text"><span>已用 ' + used + ' / ' + total + '</span><span class="remaining' + (left === 0 ? ' over' : '') + '">剩 ' + left + ' 次</span></div></div>';
  }
  return '<div class="card-row" data-mem-id="' + esc(m.id) + '">' +
    '<div><div class="card-name">' + esc(m.name) + ' <span class="badge ' + (MEM_CAT_BADGE[m.category] || 'badge-default') + '">' + esc(catLabel) + '</span></div>' +
    (m.note ? '<div class="card-sub">' + esc(m.note) + '</div>' : '') + '</div>' +
    '<div>' + remainHtml + '</div>' +
    '<div class="fee-cell">' + daysBadge(m.expiry) + '</div>' +
    '<div><button class="btn small" data-act="mem-use">' + (m.mode === 'amount' ? '消费' : '使用') + '</button> ' +
    '<button class="btn small" data-act="mem-detail">详情</button></div>' +
    '</div>';
}

function memFormHtml(m) {
  m = m || {};
  const cats = state.meta.memCatLabels || {};
  return '<div class="form-grid">' +
    field('名称 <span style="color:var(--red)">*</span>', '<input id="m-name" value="' + esc(m.name || '') + '" placeholder="如 腾讯视频VIP">') +
    field('分类', '<select id="m-category">' + Object.keys(cats).map((k) => '<option value="' + k + '"' + ((m.category || 'other') === k ? ' selected' : '') + '>' + esc(cats[k]) + '</option>').join('') + '</select>') +
    field('模式', '<select id="m-mode">' +
      '<option value="amount"' + (m.mode !== 'count' ? ' selected' : '') + '>金额型（储值）</option>' +
      '<option value="count"' + (m.mode === 'count' ? ' selected' : '') + '>次数型（年卡）</option></select>') +
    field('有效期至（选填）', '<input id="m-expiry" type="date" value="' + esc(m.expiry || '') + '">') +
    '<div class="full" id="m-amount-fields"' + (m.mode === 'count' ? ' style="display:none"' : '') + '>' +
    field('余额（元）', '<input id="m-balance" type="number" min="0" step="0.01" value="' + (m.balance != null ? m.balance : 0) + '">') +
    '</div>' +
    '<div class="full" id="m-count-fields"' + (m.mode === 'count' ? '' : ' style="display:none"') + '>' +
    field('总次数', '<input id="m-total" type="number" min="0" value="' + (m.totalUses != null ? m.totalUses : 10) + '">') +
    field('已用次数', '<input id="m-used" type="number" min="0" value="' + (m.usedUses || 0) + '">') +
    '</div>' +
    '<div class="full">' + field('备注（选填）', '<input id="m-note" value="' + esc(m.note || '') + '" placeholder="备注">') + '</div>' +
    '</div>';
}

function openMemModal(id) {
  const editing = id ? (state.memberships || []).find((x) => x.id === id) : null;
  if (id && !editing) return toast('会员卡不存在或已被删除', 'error');
  openModal('<div class="modal-title">' + (editing ? '编辑会员卡' : '添加会员卡') + '</div>', memFormHtml(editing),
    '<button class="btn" data-close>取消</button><button class="btn primary" id="btn-mem-save">保存</button>');
  $('#m-mode').addEventListener('change', () => {
    const isCount = $('#m-mode').value === 'count';
    $('#m-amount-fields').style.display = isCount ? 'none' : '';
    $('#m-count-fields').style.display = isCount ? '' : 'none';
  });
  $('#btn-mem-save').addEventListener('click', async () => {
    const body = {
      name: $('#m-name').value.trim(),
      category: $('#m-category').value,
      mode: $('#m-mode').value,
      expiry: $('#m-expiry').value,
      note: $('#m-note').value.trim(),
    };
    if (!body.name) return toast('请填写名称', 'error');
    if (body.mode === 'count') { body.totalUses = $('#m-total').value; if (editing) body.usedUses = $('#m-used').value; }
    else body.balance = $('#m-balance').value;
    try {
      if (editing) await api('/api/memberships/' + editing.id, { method: 'PUT', body });
      else await api('/api/memberships', { method: 'POST', body });
      toast(editing ? '已保存' : '已添加');
      closeModal();
      await loadAll();
    } catch (e) { toast(e.message, 'error'); }
  });
}

// 会员卡使用/消费/充值弹窗
function openMemTxnModal(id, kind) {
  const m = (state.memberships || []).find((x) => x.id === id);
  if (!m) return toast('会员卡不存在或已被删除', 'error');
  if (m.mode === 'amount') {
    const isTopup = kind === 'topup';
    openModal('<div class="modal-title">' + (isTopup ? '充值 — ' : '消费 — ') + esc(m.name) + '</div>',
      '<div class="form-grid">' +
      field((isTopup ? '充值金额' : '消费金额'), '<input id="mt-amount" type="number" min="0.01" step="0.01" placeholder="0.00">') +
      field('日期', '<input id="mt-date" type="date" value="' + today() + '">') +
      field('备注（可选）', '<input id="mt-note" placeholder="备注">') +
      '</div>' +
      '<div style="font-size:12px;color:var(--text-3);margin-top:8px">当前余额 ' + fmtMoney(m.balance) + '</div>',
      '<button class="btn" data-close>取消</button><button class="btn primary" id="btn-mt-save">' + (isTopup ? '充值' : '消费') + '</button>');
    $('#btn-mt-save').addEventListener('click', async () => {
      const amount = parseFloat($('#mt-amount').value);
      if (!amount || amount <= 0) return toast('请输入大于 0 的金额', 'error');
      try {
        const r = await api('/api/memberships/' + m.id + '/txn', { method: 'POST', body: { kind: isTopup ? 'topup' : 'consume', amount, date: $('#mt-date').value, note: $('#mt-note').value.trim() } });
        toast((isTopup ? '已充值，余额 ' : '已消费，余额 ') + fmtMoney(r.balance));
        closeModal();
        await loadAll();
      } catch (e) { toast(e.message, 'error'); }
    });
    return;
  }
  // 次数型
  openModal('<div class="modal-title">使用一次 — ' + esc(m.name) + '</div>',
    '<div class="form-grid">' +
    field('日期', '<input id="mt-date" type="date" value="' + today() + '">') +
    field('备注（可选）', '<input id="mt-note" placeholder="备注">') +
    '</div>' +
    '<div style="font-size:12px;color:var(--text-3);margin-top:8px">已用 ' + (m.usedUses || 0) + ' / ' + m.totalUses + ' 次</div>',
    '<button class="btn" data-close>取消</button><button class="btn primary" id="btn-mt-save">使用</button>');
  $('#btn-mt-save').addEventListener('click', async () => {
    try {
      const r = await api('/api/memberships/' + m.id + '/txn', { method: 'POST', body: { kind: 'use', date: $('#mt-date').value, note: $('#mt-note').value.trim() } });
      toast('已使用，剩 ' + Math.max(0, (m.totalUses || 0) - r.usedUses) + ' 次');
      closeModal();
      await loadAll();
    } catch (e) { toast(e.message, 'error'); }
  });
}

// 会员卡详情抽屉
function openMemDetail(id) {
  const m = (state.memberships || []).find((x) => x.id === id);
  if (!m) return;
  const root = $('#drawer-root');
  root.innerHTML = '<div class="overlay"></div><div class="drawer" id="drawer"></div>';
  const txns = (m.transactions || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const rows = txns.map((t) => '<tr><td>' + esc(t.date) + '</td>' +
    '<td><span class="badge ' + (t.kind === 'topup' ? 'badge-green' : 'badge-default') + '">' + (t.kind === 'topup' ? '充值' : '消费') + '</span></td>' +
    '<td class="amount">' + fmtMoney(t.amount) + '</td>' +
    '<td>' + esc(t.note || '') + '</td></tr>').join('');
  const catLabel = (state.meta.memCatLabels || {})[m.category] || '其他';
  $('#drawer', root).innerHTML =
    '<div class="drawer-header"><div class="drawer-title">' + esc(m.name) +
    '<div class="drawer-sub">' + esc(catLabel) + ' · ' + (m.mode === 'amount' ? '金额型' : '次数型') + '</div></div>' +
    '<button class="drawer-close" data-act="close">✕</button></div>' +
    '<div class="drawer-body">' +
    '<div class="drawer-section"><h3>基础信息</h3><div class="info-grid">' +
    (m.mode === 'amount' ? infoItem('余额', fmtMoney(m.balance)) : infoItem('剩余次数', Math.max(0, (Number(m.totalUses) || 0) - (Number(m.usedUses) || 0)) + ' / ' + m.totalUses)) +
    infoItem('有效期', m.expiry ? esc(m.expiry) + ' ' + daysBadge(m.expiry) : '长期有效') +
    (m.note ? infoItem('备注', esc(m.note)) : '') +
    '</div>' +
    '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
    '<button class="btn small primary" data-act="md-use">' + (m.mode === 'amount' ? '消费' : '使用') + '</button>' +
    (m.mode === 'amount' ? '<button class="btn small" data-act="md-topup">充值</button>' : '') +
    (m.mode === 'count' ? '<button class="btn small" data-act="md-undo">回退一次</button>' : '') +
    '<button class="btn small" data-act="md-edit">编辑</button>' +
    '<button class="btn small danger" data-act="md-del">删除</button>' +
    '</div></div>' +
    '<div class="drawer-section"><h3>流水记录（' + txns.length + '）</h3>' +
    (txns.length ? '<table class="record-table"><thead><tr><th>日期</th><th>类型</th><th style="text-align:right">金额</th><th>备注</th></tr></thead><tbody>' + rows + '</tbody></table>'
      : '<div style="font-size:13px;color:var(--text-3)">暂无流水</div>') +
    '</div></div>';
  requestAnimationFrame(() => { $('.overlay', root).classList.add('show'); $('#drawer', root).classList.add('show'); });
  const close = () => { root.innerHTML = ''; };
  $('.overlay', root).addEventListener('click', close);
  $('[data-act="close"]', root).addEventListener('click', close);
  $('[data-act="md-use"]', root).addEventListener('click', () => { close(); openMemTxnModal(m.id, 'use'); });
  const topupBtn = $('[data-act="md-topup"]', root);
  if (topupBtn) topupBtn.addEventListener('click', () => { close(); openMemTxnModal(m.id, 'topup'); });
  const undoBtn = $('[data-act="md-undo"]', root);
  if (undoBtn) undoBtn.addEventListener('click', async () => {
    try {
      const r = await api('/api/memberships/' + m.id + '/txn', { method: 'POST', body: { kind: 'undo' } });
      toast('已回退，剩 ' + ((m.totalUses || 0) - r.usedUses) + ' 次');
      close();
      await loadAll();
    } catch (e) { toast(e.message, 'error'); }
  });
  $('[data-act="md-edit"]', root).addEventListener('click', () => { close(); openMemModal(m.id); });
  $('[data-act="md-del"]', root).addEventListener('click', async () => {
    if (!(await confirmDialog('确定删除「' + m.name + '」？流水将一并删除。'))) return;
    try {
      await api('/api/memberships/' + m.id, { method: 'DELETE' });
      toast('已删除');
      close();
      await loadAll();
    } catch (e) { toast(e.message, 'error'); }
  });
}

// ---------- 页面五：知识库 ----------
const KG_TYPE_LABELS_FALLBACK = {
  file: '网盘/文件资料', online_doc: '在线文档/表格', consultation: '在线咨询服务',
  membership: '会员/社群/资讯平台', course: '学习课程', tool: '工具/软件订阅', other: '其他',
};

function renderKnowledge() {
  const list = state.knowledge || [];
  const meta = state.meta.kgCatLabels || {};
  const totalSpend = list.reduce((s, k) => s + (Number(k.price) || 0), 0);
  const active = list.filter((k) => k.lifetime || !k.expiry || k.expiry >= today()).length;
  let html =
    '<div class="page-title">知识库</div>' +
    '<div class="page-desc">课程、专栏、社群、订阅等知识资产管理与使用追踪 · 年度投入 ' + fmtMoney(totalSpend) + ' · 在期 ' + active + ' / ' + list.length + '</div>' +
    '<div class="toolbar"><button class="btn primary" id="btn-kg-add">＋ 添加资源</button>' +
    '<div class="spacer"></div>' +
    '<select id="kg-cat-filter" class="filter-select">' +
    option2('all', '全部分类', state.knowledgeCatFilter) +
    Object.keys(meta).map((k) => option2(k, meta[k], state.knowledgeCatFilter)).join('') +
    '</select></div>';

  if (!list.length) return html + emptyBox('还没有知识资源，点「添加资源」开始记录');

  const cat = state.knowledgeCatFilter === 'all' ? '' : state.knowledgeCatFilter;
  const filtered = cat ? list.filter((k) => k.category === cat) : list;
  if (!filtered.length) return html + emptyBox('当前分类下没有资源');

  // 按分类分组
  const byCat = {};
  for (const k of filtered) {
    const key = meta[k.category] || '其他';
    if (!byCat[key]) byCat[key] = [];
    byCat[key].push(k);
  }
  const cats = Object.keys(byCat).sort((a, b) => a.localeCompare(b, 'zh'));
  for (const catName of cats) {
    const items = byCat[catName].slice().sort((a, b) => String(a.expiry || '9999').localeCompare(String(b.expiry || '9999')));
    html += '<div class="bank-group"><div class="bank-header" style="cursor:default">' +
      '<span class="bank-name">' + esc(catName) + '</span><span class="bank-count">' + items.length + ' 项 · 投入 ' + fmtMoney(items.reduce((s, k) => s + (Number(k.price) || 0), 0)) + '</span></div>' +
      '<div class="bank-body">' + items.map(kgRowHtml).join('') + '</div></div>';
  }
  return html;
}

function kgRowHtml(k) {
  const cycleLabel = (state.meta.kgCycleLabels || { monthly: '月付', yearly: '年付', lifetime: '终身' })[k.cycle] || k.cycle;
  const typeLabel = (state.meta.kgTypeLabels || KG_TYPE_LABELS_FALLBACK)[k.resourceType] || k.resourceType;
  const activeBadge = k.lifetime ? '<span class="badge badge-gold">终身</span>'
    : (k.expiry && k.expiry < today() ? '<span class="badge badge-red">已到期</span>' : '<span class="badge badge-green">在期</span>');
  const progress = Number(k.progress) || 0;
  const uses = Number(k.uses) || 0;
  return '<div class="card-row" data-kg-id="' + esc(k.id) + '">' +
    '<div><div class="card-name">' + esc(k.title) + ' <span class="badge badge-blue">' + esc(typeLabel) + '</span></div>' +
    '<div class="card-sub">' + esc(k.platform || '未填写平台') + ' · ' + esc(cycleLabel) + ' ' + fmtMoney(k.price) + (k.account ? ' · ' + esc(k.account) : '') + '</div>' +
    '<div class="progress" style="margin-top:4px;max-width:260px"><div class="progress-track"><div class="progress-fill' + (progress >= 100 ? ' done' : '') + '" style="width:' + Math.min(100, progress) + '%"></div></div>' +
    '<div class="progress-text"><span>进度 ' + progress + '% · 已用 ' + uses + ' 次</span></div></div></div>' +
    '<div class="fee-cell">' + activeBadge + ' ' + daysBadge(k.lifetime ? '' : k.expiry) + '</div>' +
    '<div><button class="btn small" data-act="kg-use">用一次</button> <button class="btn small" data-act="kg-detail">详情</button></div>' +
    '</div>';
}

function kgFormHtml(k) {
  k = k || {};
  const types = state.meta.kgTypeLabels || KG_TYPE_LABELS_FALLBACK;
  const cats = state.meta.kgCatLabels || {};
  const cycles = state.meta.kgCycleLabels || { monthly: '月付', yearly: '年付', lifetime: '终身' };
  return '<div class="form-grid">' +
    field('资源名称 <span style="color:var(--red)">*</span>', '<input id="k-title" value="' + esc(k.title || '') + '" placeholder="如 极客时间年度会员">') +
    field('平台', '<input id="k-platform" value="' + esc(k.platform || '') + '" placeholder="如 极客时间">') +
    field('资源类型', '<select id="k-resourceType">' + Object.keys(types).map((t) => '<option value="' + t + '"' + ((k.resourceType || 'other') === t ? ' selected' : '') + '>' + esc(types[t]) + '</option>').join('') + '</select>') +
    field('分类', '<select id="k-category">' + Object.keys(cats).map((t) => '<option value="' + t + '"' + ((k.category || 'other') === t ? ' selected' : '') + '>' + esc(cats[t]) + '</option>').join('') + '</select>') +
    field('付费周期', '<select id="k-cycle">' + Object.keys(cycles).map((t) => '<option value="' + t + '"' + ((k.cycle || 'yearly') === t ? ' selected' : '') + '>' + esc(cycles[t]) + '</option>').join('') + '</select>') +
    field('价格（元）', '<input id="k-price" type="number" min="0" step="0.01" value="' + (k.price != null ? k.price : 0) + '">') +
    field('购买日期', '<input id="k-purchaseDate" type="date" value="' + esc(k.purchaseDate || today()) + '">') +
    field('到期日（终身可留空）', '<input id="k-expiry" type="date" value="' + esc(k.expiry || '') + '">') +
    field('学习进度（%）', '<input id="k-progress" type="number" min="0" max="100" value="' + (k.progress || 0) + '">') +
    field('账号（选填）', '<input id="k-account" value="' + esc(k.account || '') + '" placeholder="账号/昵称">') +
    '<div class="full">' + field('标签（多个用 、 分隔）', '<input id="k-tags" value="' + esc((k.tags || []).join('、')) + '" placeholder="如 技术、架构">') + '</div>' +
    '<div class="full">' + field('备注', '<input id="k-note" value="' + esc(k.note || '') + '" placeholder="备注">') + '</div>' +
    '</div>';
}

function openKgModal(id) {
  const editing = id ? (state.knowledge || []).find((x) => x.id === id) : null;
  if (id && !editing) return toast('资源不存在或已被删除', 'error');
  openModal('<div class="modal-title">' + (editing ? '编辑资源' : '添加资源') + '</div>', kgFormHtml(editing),
    '<button class="btn" data-close>取消</button><button class="btn primary" id="btn-kg-save">保存</button>');
  $('#btn-kg-save').addEventListener('click', async () => {
    const body = {
      title: $('#k-title').value.trim(),
      platform: $('#k-platform').value.trim(),
      resourceType: $('#k-resourceType').value,
      category: $('#k-category').value,
      cycle: $('#k-cycle').value,
      price: $('#k-price').value,
      purchaseDate: $('#k-purchaseDate').value,
      expiry: $('#k-expiry').value,
      progress: $('#k-progress').value,
      account: $('#k-account').value.trim(),
      tags: $('#k-tags').value.trim(),
      note: $('#k-note').value.trim(),
    };
    if (!body.title) return toast('请填写资源名称', 'error');
    try {
      if (editing) await api('/api/knowledge/' + editing.id, { method: 'PUT', body });
      else await api('/api/knowledge', { method: 'POST', body });
      toast(editing ? '已保存' : '已添加');
      closeModal();
      await loadAll();
    } catch (e) { toast(e.message, 'error'); }
  });
}

// 知识库详情抽屉（使用记录 + 续费流水 + 操作）
function openKgDetail(id) {
  const k = (state.knowledge || []).find((x) => x.id === id);
  if (!k) return;
  const root = $('#drawer-root');
  root.innerHTML = '<div class="overlay"></div><div class="drawer" id="drawer"></div>';
  const useLog = (k.useLog || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const hist = (k.history || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const HIST_LABEL = { recharge: '充值', renew: '续费', use: '消费', refund: '退款', gift: '赠送' };
  const cycleLabel = (state.meta.kgCycleLabels || { monthly: '月付', yearly: '年付', lifetime: '终身' })[k.cycle] || k.cycle;
  const types = state.meta.kgTypeLabels || KG_TYPE_LABELS_FALLBACK;
  const cats = state.meta.kgCatLabels || {};
  const useRows = useLog.map((u) => '<tr><td>' + esc(u.date) + '</td><td>' + esc(u.note || '') + '</td></tr>').join('');
  const histRows = hist.map((h) => '<tr><td>' + esc(h.date) + '</td>' +
    '<td><span class="badge badge-default">' + esc(HIST_LABEL[h.type] || h.type) + '</span></td>' +
    '<td class="amount">' + fmtMoney(h.amount) + '</td><td>' + esc(h.note || '') + '</td></tr>').join('');
  $('#drawer', root).innerHTML =
    '<div class="drawer-header"><div class="drawer-title">' + esc(k.title) +
    '<div class="drawer-sub">' + esc(k.platform || '未填写平台') + ' · ' + esc(types[k.resourceType] || k.resourceType) + ' · ' + esc(cats[k.category] || k.category) + '</div></div>' +
    '<button class="drawer-close" data-act="close">✕</button></div>' +
    '<div class="drawer-body">' +
    '<div class="drawer-section"><h3>基础信息</h3><div class="info-grid">' +
    infoItem('价格', fmtMoney(k.price) + '（' + esc(cycleLabel) + '）') +
    infoItem('累计使用', (Number(k.uses) || 0) + ' 次') +
    infoItem('购买日期', esc(k.purchaseDate || '—')) +
    infoItem('到期日', k.lifetime ? '终身有效' : (k.expiry ? esc(k.expiry) + ' ' + daysBadge(k.expiry) : '未设置')) +
    (k.account ? infoItem('账号', esc(k.account)) : '') +
    ((k.tags || []).length ? infoItem('标签', esc(k.tags.join('、'))) : '') +
    (k.note ? infoItem('备注', esc(k.note)) : '') +
    '</div>' +
    '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
    '<button class="btn small primary" data-act="kd-use">用一次</button>' +
    '<button class="btn small" data-act="kd-undo">回退一次</button>' +
    '<button class="btn small" data-act="kd-renew">记一笔流水</button>' +
    '<button class="btn small" data-act="kd-edit">编辑</button>' +
    '<button class="btn small danger" data-act="kd-del">删除</button>' +
    '</div></div>' +
    '<div class="drawer-section"><h3>使用记录（' + useLog.length + '）</h3>' +
    (useRows ? '<table class="record-table"><thead><tr><th>日期</th><th>说明</th></tr></thead><tbody>' + useRows + '</tbody></table>'
      : '<div style="font-size:13px;color:var(--text-3)">暂无使用记录</div>') +
    '</div>' +
    '<div class="drawer-section"><h3>付费流水（' + hist.length + '）</h3>' +
    (histRows ? '<table class="record-table"><thead><tr><th>日期</th><th>类型</th><th style="text-align:right">金额</th><th>备注</th></tr></thead><tbody>' + histRows + '</tbody></table>'
      : '<div style="font-size:13px;color:var(--text-3)">暂无流水</div>') +
    '</div></div>';
  requestAnimationFrame(() => { $('.overlay', root).classList.add('show'); $('#drawer', root).classList.add('show'); });
  const close = () => { root.innerHTML = ''; };
  $('.overlay', root).addEventListener('click', close);
  $('[data-act="close"]', root).addEventListener('click', close);
  $('[data-act="kd-use"]', root).addEventListener('click', async () => {
    try {
      const r = await api('/api/knowledge/' + k.id + '/use', { method: 'POST', body: { date: today(), note: '' } });
      toast('已记录使用（累计 ' + r.uses + ' 次）');
      close();
      await loadAll();
    } catch (e) { toast(e.message, 'error'); }
  });
  $('[data-act="kd-undo"]', root).addEventListener('click', async () => {
    try {
      const r = await api('/api/knowledge/' + k.id + '/use', { method: 'POST', body: { undo: true } });
      toast('已回退（累计 ' + r.uses + ' 次）');
      close();
      await loadAll();
    } catch (e) { toast(e.message, 'error'); }
  });
  $('[data-act="kd-renew"]', root).addEventListener('click', () => { close(); openKgHistoryModal(k.id); });
  $('[data-act="kd-edit"]', root).addEventListener('click', () => { close(); openKgModal(k.id); });
  $('[data-act="kd-del"]', root).addEventListener('click', async () => {
    if (!(await confirmDialog('确定删除「' + k.title + '」？使用记录与流水将一并删除。'))) return;
    try {
      await api('/api/knowledge/' + k.id, { method: 'DELETE' });
      toast('已删除');
      close();
      await loadAll();
    } catch (e) { toast(e.message, 'error'); }
  });
}

// 知识库流水弹窗（续费/充值/退款/赠送）
function openKgHistoryModal(id) {
  const k = (state.knowledge || []).find((x) => x.id === id);
  if (!k) return toast('资源不存在或已被删除', 'error');
  const LABELS = { renew: '续费', recharge: '充值', use: '消费', refund: '退款', gift: '赠送' };
  openModal('<div class="modal-title">记一笔流水 — ' + esc(k.title) + '</div>',
    '<div class="form-grid">' +
    field('类型', '<select id="kh-type">' + Object.keys(LABELS).map((t) => '<option value="' + t + '">' + LABELS[t] + '</option>').join('') + '</select>') +
    field('金额（元）', '<input id="kh-amount" type="number" min="0" step="0.01" value="0">') +
    field('日期', '<input id="kh-date" type="date" value="' + today() + '">') +
    field('备注（可选）', '<input id="kh-note" placeholder="如 续费一年">') +
    '</div>',
    '<button class="btn" data-close>取消</button><button class="btn primary" id="btn-kh-save">保存</button>');
  $('#btn-kh-save').addEventListener('click', async () => {
    const amount = parseFloat($('#kh-amount').value);
    if (!isFinite(amount) || amount < 0) return toast('金额不合法', 'error');
    try {
      await api('/api/knowledge/' + k.id + '/history', { method: 'POST', body: { type: $('#kh-type').value, amount, date: $('#kh-date').value, note: $('#kh-note').value.trim() } });
      toast('流水已记录');
      closeModal();
      await loadAll();
    } catch (e) { toast(e.message, 'error'); }
  });
}

// ---------- 页面六：资产统计 ----------
function renderAssetStats() {
  const s = state.assetStats;
  if (!s) return '<div class="page-title">统计</div>' + emptyBox('统计数据加载失败，请刷新重试');
  const mem = s.membership || {}, vou = s.voucher || {}, kg = s.knowledge || {}, ben = s.benefit || {};
  const rate = Number(ben.redemptionRate) || 0;
  const rateColor = rate >= 80 ? 'var(--green)' : rate >= 50 ? 'var(--gold-deep)' : 'var(--red)';
  let html =
    '<div class="page-title">资产统计</div>' +
    '<div class="page-desc">会员储值、卡/票、知识库与信用卡权益的综合视图</div>' +
    '<div class="stats">' +
    statCard('会员/储值余额', fmtMoney(mem.balance), '共 ' + fmtInt(mem.count || 0) + ' 张卡', false) +
    statCard('卡/票剩余', fmtMoney(vou.balance), '另剩 ' + fmtInt(vou.remainingCount || 0) + ' 次核销额度', false) +
    statCard('知识库投入', fmtMoney(kg.totalSpend), '共 ' + fmtInt(kg.count || 0) + ' 项 · 在期 ' + fmtInt(kg.activeCount || 0) + ' 项', false) +
    statCard('权益核销率', rate + '%', '已用 ' + fmtInt(ben.used || 0) + ' / ' + fmtInt(ben.total || 0) + ' 次', rate < 30, 'stat-benefit-rate') +
    '</div>';

  // 资产结构（纯 CSS 条形，不引第三方图表库）
  const structure = s.structure || [];
  const maxVal = Math.max(1, ...structure.map((x) => Number(x.value) || 0));
  html += '<div class="bank-group"><div class="bank-header" style="cursor:default"><span class="bank-name">资产结构</span></div><div class="bank-body" style="padding:14px 16px">';
  for (const it of structure) {
    const pct = Math.round(((Number(it.value) || 0) / maxVal) * 100);
    html += '<div style="margin-bottom:12px">' +
      '<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px"><span>' + esc(it.label) + '</span><b style="font-variant-numeric:tabular-nums">' + fmtMoney(it.value) + '</b></div>' +
      '<div class="progress-track"><div class="progress-fill" style="width:' + pct + '%"></div></div></div>';
  }
  html += '</div></div>';

  // 动态流（最近动态）
  html += '<div class="bank-group"><div class="bank-header" style="cursor:default"><span class="bank-name">最近动态</span>' +
    '<span class="bank-count">会员流水 · 券核销 · 知识使用 · 权益使用</span></div>' +
    '<div class="bank-body" id="feed-body" style="padding:8px 16px">' + emptyBox('加载中…') + '</div></div>';
  return html;
}

async function loadAssetFeed() {
  const body = $('#feed-body');
  if (!body) return;
  try {
    const feed = await api('/api/assets/feed?limit=30');
    if (!feed.length) { body.innerHTML = emptyBox('暂无动态，先去记录一笔吧'); return; }
    const KIND_META = {
      membership: { label: '会员', cls: 'badge-purple' },
      voucher: { label: '卡/票', cls: 'badge-blue' },
      knowledge: { label: '知识', cls: 'badge-green' },
      'knowledge-pay': { label: '知识', cls: 'badge-green' },
      benefit: { label: '权益', cls: 'badge-gold' },
    };
    body.innerHTML = '<table class="record-table"><thead><tr><th>日期</th><th>来源</th><th>事项</th><th>对象</th><th style="text-align:right">金额</th></tr></thead><tbody>' +
      feed.map((f) => {
        const km = KIND_META[f.kind] || { label: f.kind, cls: 'badge-default' };
        return '<tr><td>' + esc(f.date) + '</td>' +
          '<td><span class="badge ' + km.cls + '">' + esc(km.label) + '</span></td>' +
          '<td>' + esc(f.title || '') + '</td><td>' + esc(f.sub || '') + '</td>' +
          '<td class="amount">' + (Number(f.amount) ? fmtMoney(f.amount) : '—') + '</td></tr>';
      }).join('') + '</tbody></table>';
  } catch (e) {
    body.innerHTML = emptyBox('动态加载失败：' + esc(e.message));
  }
}

// 扩展资产页面的事件绑定（在 bindPageEvents 末尾调用）
function bindAssetPageEvents() {
  const app = $('#app');
  if (state.page === 'vouchers') {
    $('#vou-type-filter', app).addEventListener('change', (e) => { state.voucherTypeFilter = e.target.value; render(); });
    $('#btn-vou-add', app).addEventListener('click', () => openVoucherModal(null));
    $('#btn-brand-add', app).addEventListener('click', openBrandsModal);
    $$('.card-row[data-vou-id]', app).forEach((row) => {
      $('[data-act="vou-use"]', row).addEventListener('click', () => openVoucherUseModal(row.dataset.vouId));
      $('[data-act="vou-detail"]', row).addEventListener('click', () => openVoucherDetail(row.dataset.vouId));
    });
  } else if (state.page === 'memberships') {
    $('#btn-mem-add', app).addEventListener('click', () => openMemModal(null));
    const catSel = $('#mem-cat-filter', app);
    if (catSel) catSel.addEventListener('change', (e) => {
      state.membershipCatFilter = e.target.value;
      render();
    });
    $$('.card-row[data-mem-id]', app).forEach((row) => {
      $('[data-act="mem-use"]', row).addEventListener('click', () => openMemTxnModal(row.dataset.memId, 'use'));
      $('[data-act="mem-detail"]', row).addEventListener('click', () => openMemDetail(row.dataset.memId));
    });
  } else if (state.page === 'knowledge') {
    $('#kg-cat-filter', app).addEventListener('change', (e) => { state.knowledgeCatFilter = e.target.value; render(); });
    $('#btn-kg-add', app).addEventListener('click', () => openKgModal(null));
    $$('.card-row[data-kg-id]', app).forEach((row) => {
      $('[data-act="kg-use"]', row).addEventListener('click', () => openKgUseQuick(row.dataset.kgId));
      $('[data-act="kg-detail"]', row).addEventListener('click', () => openKgDetail(row.dataset.kgId));
    });
  } else if (state.page === 'assetstats') {
    loadAssetFeed();
  }
}

// 知识库快速使用（行内按钮，成功后刷新）
async function openKgUseQuick(id) {
  const k = (state.knowledge || []).find((x) => x.id === id);
  if (!k) return;
  try {
    const r = await api('/api/knowledge/' + id + '/use', { method: 'POST', body: { date: today(), note: '' } });
    toast('已记录使用（累计 ' + r.uses + ' 次）');
    await loadAll();
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- 启动 ----------
boot().catch((e) => {
  const app = $('#app');
  if (!app) return;
  app.innerHTML = '<div class="empty-tip">加载失败：' + esc(e.message) + '</div>';
});
