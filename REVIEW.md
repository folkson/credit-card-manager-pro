# 管卡 Docker 版 — 代码复盘报告

> 范围：`credit-card-manager/` 全量代码（server 6 文件 + public 3 文件 + tools 6 脚本）
> 本文件包含八轮复盘：第一轮（首轮交付后）、第二轮（P0/P1/P2 对齐金山文档落地后）、第三轮（全量通读后）、第四轮（对第三轮修复的复查）、第五轮（边界与一致性探测）、第六轮（新增合并账单组功能）、第七轮（数据安全与时间基准通读）、第八轮（资产长尾交互全量走查 + 提交防重 + 卡/票页点击失效修复）

---

# 第八轮复盘（2026-10-19，资产长尾交互全量走查 + 提交防重 + 卡/票页点击失效修复）

> 触发：用户要求「review 这个项目，修复 bug 和性能问题」；随后用户反馈「卡/票页面无法点击」
> 侧重：**routes.js 长尾端点**（bills/consumptions/benefits/billgroups/assets 三模块/feed/expiring/notify/syncMyCardSnapshots）、**前端资产三页 CRUD 交互**（弹窗/抽屉/导入导出/云同步全链路）
> 结论：服务端长尾端点**零缺陷**（幂等 generate、parseDateStr 真实校验、resolveBenefit bid 优先、掩码回写、互斥检查等既有防御全部确认有效）；确认缺陷两处——R8-1 提交无防重、R8-2 资产页整页按钮失效
> 验证：dates-test **39/39** ｜ notify-test **128/128** ｜ backup-test **54/54** ｜ assets-smoke **48/48** ｜ ICS 断言 **9/9** ｜ ui-test **75/75**（新增 4 项）｜ cloud-sync-smoke **28/28**

## 一、确认并修复的缺陷

### R8-2 资产页整页按钮失效——bindPageEvents 裸 .card-row 选择器误抓券行（可用性，高）— ✅ 已修复

用户报告「卡/票页面无法点击」。根因不在 1.1.2 的 submitLock 改动（diff 全部是事件包装，
未触碰渲染与绑定），而是资产模块上线时（8e5fc95）就埋下的**选择器串扰**：

`bindPageEvents()` 的「持卡行」绑定用裸选择器 `$$('.card-row', app)` 并对每行直接执行
`$('[data-act="detail"]', row).addEventListener(...)`。而资产三页（卡/票·会员储值·知识库）的行
**同样使用 card-row class**（`data-vou-id` / `data-mem-id` / `data-kg-id`），行内没有
`data-act="detail"` 按钮 → `$()` 返回 null → `addEventListener` 抛 TypeError →

- `bindPageEvents` 在持卡行循环处**中断**
- 末尾的 `bindAssetPageEvents()`（584 行）**执行不到**
- 卡/票页所有按钮（添加/商家管理/筛选/核销/详情）**全部没有绑定** → 整页不可点击

**触发条件**：仅当卡/票列表**非空**时（空列表页面无 `.card-row` 行，不会触发——这也解释了
为何 ui-test 71 项此前全绿：测试环境资产页恰好无数据）。会员/知识库页同理受影响。

**修复**（public/app.js bindPageEvents）：
1. 选择器收紧为 `$$('.card-row[data-id]', app)`——持卡行带 `data-id`，资产行没有，天然隔离
2. 行绑定加判空守卫：`const detailBtn = ...; if (!detailBtn) return;`——结构变动时单行缺按钮不再拖垮整页

**jsdom 实锤复现**：造一条券 → 切卡/票页 → `Cannot read properties of null (reading 'addEventListener')`
at bindPageEvents 569 行；点「添加」「核销」弹窗均不弹。修复后同场景 12/12 断言通过，
并新增 ui-test 第 17 段 4 项防回归断言（造券 → 切页 → 无报错 → 弹窗可开）。

### R8-1 全部提交型弹窗/按钮无防重复提交 → 慢网络下双击双笔记账（数据正确性，高）— ✅ 已修复

所有提交型按钮的事件处理器直接发起异步 `api()` 请求，请求进行中按钮不禁用。
本地服务响应快（<10ms）掩盖了问题；CF Workers 部署后延迟 200–500ms，用户双击「保存/核销/充值」
会发出**两个请求**。涉事端点全部非幂等：

- `POST /api/mycards/:id/consumptions`（消费）→ 双笔消费、刷免进度翻倍
- `POST /api/mycards`（新增持卡）→ **服务端无去重**（routes.js:1201 直接 push），双击建两张卡
- `POST /api/memberships/:id/txn`、`/api/vouchers/:id/topup|use`、`/api/knowledge/:id/use|history` → 双扣余额/双计次数
- `POST /api/billgroups`、`/api/cards`（后者有键去重会报错，但报错体验也差）

**修复**：`public/app.js` 新增 `submitLock(btn, fn)` 助手——提交期间 `btn.disabled = true`，
`finally` 中恢复（失败也要解锁）。CSS 已有 `.btn:disabled` 样式（opacity .5 + not-allowed），
无需改样式。共加固 **23 处**提交点：

| 位置 | 按钮 |
|---|---|
| 账单组 | bg-create / bg-save |
| 账单 | b-save（新增账单） |
| 抽屉 | count-topup（补录笔数）/ count-benefit（权益补录） |
| 持卡 | btn-save-mycard ×2（添加 / 编辑，走 saveMyCard） |
| 消费/权益 | btn-save-consumption / btn-save-benefit |
| 卡种 | btn-save-cardtype |
| 券 | btn-vou-save / btn-vu-save ×2（金额核销 + 次数核销）/ btn-vt-save |
| 商家 | btn-brand-new |
| 会员 | btn-mem-save / btn-mt-save ×2（金额型 + 次数型）/ md-undo（回退） |
| 知识库 | btn-kg-save / kd-use / kd-undo / btn-kh-save（流水） |

另：知识库行内「用一次」按钮（`openKgUseQuick`）不经过弹窗，用模块级 `_kgUseInFlight` Set
按 id 防并发（成功/失败都在 finally 释放）。

**设计取舍**：不加全局请求队列（复杂度高、易引入死锁）；按钮级锁最贴近事故面，
`e.currentTarget` 在同一 tick 捕获，避免异步后 currentTarget 变 null 的坑。

## 二、评审通过项（本轮确认无缺陷，记录防御点备查）

| 模块 | 确认的既有防御 |
|---|---|
| bills generate | 幂等：同卡同月已存在直接返回，不重复建 |
| bills POST/PUT | YYYY-MM 严格正则 + parseDateStr 真实日期校验（拒绝 2 月 30 日） |
| billgroups POST/PUT | 组内两两 sameRepaySchedule 校验，破坏一致性即拒绝 |
| benefits usage/count | expired/exhausted 拦截、-1 不限次跳上限、bid 优先防索引错位 |
| assets stats/feed/expiring | 单趟 reduce + buildIndexes 复用；limit/days 参数钳位 |
| notify runNotifyChecks | 运行互斥；回写只覆盖 lastCheckAt/sentLog/history 三个检查字段 |
| memberships txn | 金额型余额校验（消费不透支）；次数型 use/undo 边界（用完拒绝/无记录拒绝） |
| vouchers use/topup | fullred 门槛校验；mode 分流（储值型拒绝走次数端点）；余额不足拒绝 |
| knowledge use | undo 只撤次数不删流水（与消费撤销语义对齐）；配额联动 quotaKey |
| 云同步 | merge 幂等导入；完全幂等时 `_skipNextPush` 跳过冗余回传（增量合并则回传并集，设计如此）；`_restored` 阀防空数据覆盖云端 |

## 三、验证

| 测试 | 结果 |
|---|---|
| `tools/dates-test.js` | 39/39 通过 |
| `tools/notify-test.js` | 128/128 通过 |
| `tools/backup-test.js` | 54/54 通过 |
| `test/assets-smoke.js` | 48/48 通过 |
| ICS 内联断言（资产三类 UID + DTSTART + 旧调用兼容） | 9/9 通过 |
| `tools/ui-test.js` | 75/75 通过（新增第 17 段 4 项：R8-2 防回归——造券切页/无报错/添加与核销弹窗可开） |
| `test/cloud-sync-smoke.js` | 28/28 通过（含 app.js 全文件可解析） |

# 第七轮复盘（2026-10-13，数据安全与时间基准通读）

> 触发：用户要求「复盘项目，查看 bug，优化代码」
> 侧重：**外部可触发的数据损坏路径**（手改 JSON、异常断电、磁盘满、版本回滚）与**时间基准一致性**（测试/回溯注入历史日期）
> 结论：修复 9 项缺陷（4 项高危、2 项中危、3 项低危），其中 **R7-2 数据损坏静默回退** 与 **R7-5 前端无法取消勾选成员** 是前六轮未覆盖的真实缺陷
> 验证：dates-test **39/39** ｜ notify-test **128/128**（新增 21 项）｜ ui-test **71/71**（新增 6 项）｜ bench 无回归（1.0–1.3x 测量噪音）

## 一、修复的缺陷

### R7-1 数据文件「合法 JSON 但非数组」→ TypeError 崩溃（健壮性，高）— ✅ 已修复

`store.read(name, [])` 只保证「读取失败时返回 `[]`」，**不校验解析结果的类型**。
当 `billGroups.json` 被写成 `{"a":1}`（合法 JSON）、或 `mycards.json` 被写成 `null` 时，
`read()` 会把这个值原样返回，随后 `groups.map(...)` / `for (const m of myCards)` / `recs.push(...)`
直接抛 `TypeError`：

- 启动期（`routes.init()` 预热归一）→ **进程启动失败**
- 运行期（`GET /api/mycards`、`GET /api/billgroups`）→ **接口 500**

**修复**：`server/db.js` 新增类型安全 API——
`readArray(name)` 保证数组类数据集永远是数组（类型不符时隔离并回退 `[]`），
`readObject(name, fallback)` 保证配置类永远是普通对象。
`routes.js` 全部数据读取统一改走这两个 API（`getCards/getMyCards/getConsumptions/getBenefits/getBills/getBillGroups/getNotifyRaw`）。

> 实测：`billGroups.json = {"a":1}`、`mycards.json = null`、`settings.json = [1,2]`
> → 分别得到 `[]` / `[]` / `{}`，**不再抛错**，且累计 3 条告警。

### R7-2 JSON 损坏静默回退 → 任意一次写入即永久覆盖（数据安全，高）— ✅ 已修复

原 `read()` 在 `JSON.parse` 失败时**静默回退默认值**（`data = fallback`）。
危险之处在于：回退只发生在内存里，文件仍是坏的；但此后**任意一次写入**
（记一笔消费、点一次开关、改一个设置）都会用这份「空的」内存数据覆盖原文件 →
**用户全部数据永久丢失，且无任何提示**。

**修复**：`_quarantine(name, reason)` —— 解析失败或类型不符时，把坏文件改名
为 `<name>.json.bad-<时间戳>` 隔离，并把告警累积到 `store.warnings`（由 `index.js` 打印）。
隔离后本次以空数据继续，但**原始字节仍在磁盘上**，用户可手工抢救。

> 实测：手工写入 `cards.json = '{ 坏掉的 JSON '` → 文件被重命名为 `cards.json.bad-1791878…`，
> 目录中同时出现隔离文件，`store.warnings` 记录「cards.json 内容不是合法 JSON，已隔离为 …」。

### R7-3 sentLog 无限增长（性能 / 存储，中）— ✅ 已修复

去重记录 `cfg.sentLog[key] = 推送日期` 只增不减。key 都带日期/月份，历史条目永不命中，
却会随使用年限无限堆积——**实测 400 天 → sentLog 400 条**，最终把 `notify.json` 撑大并拖慢每次读写。

**修复**：`reminder.js` 新增 `pruneSentLog(cfg, now)`，在每次 `runChecks` 末尾调用。
保留窗口 **120 天**（覆盖所有提醒周期：最长约 2 个月），`keys.length <= 200` 时跳过全量扫描。
值格式异常（非 `YYYY-MM-DD`）的一并清理。

> 实测：400 条 400 天前的旧记录 → 全部清空；近期记录保留；50 条小规模时原样保留（跳过扫描）。

### R7-4 提醒检查回写覆盖用户在检查期间的配置改动（正确性，中）— ✅ 已修复

`runNotifyChecksInner` 在开头读取配置 → 逐条推送（**网络操作，可能数秒**）→ 末尾
`store.write('notify', cfg)` **整份回写**。若用户在推送这几秒内改了通道或规则，
改动会被这份「几秒前的旧配置」直接抹掉。

**修复**：回写时只覆盖「检查自身产生」的字段（`lastCheckAt` / `sentLog` / `history`），
其余字段以**最新读取的配置**为准。

> 实测：mock 推送回调里把 `bark.deviceKey` 改成「用户新填的」→ 检查结束后该值仍在，未被回滚。

### R7-5 前端无法取消勾选移出成员（功能失效，高）— ✅ 已修复

`memberChecklistHtml()` 把「已在别的账单组」的卡全部 `disabled`。
但「管理账单组」编辑弹窗复用了同一函数——**属于本组的成员也被 disabled**，
导致用户**无法取消勾选把卡片移出该组**，「成员（取消勾选可移出该组）」的功能形同虚设。

**修复**：函数改为 `memberChecklistHtml(checkedIds, currentGid)`，新增「本组例外」判断——
属于**正在编辑的组**的卡保持可勾选；属于**其它组**的卡才 `disabled` 并标注「（已在「xxx」）」。

### R7-6 `deleteCardType` 未判空（前端健壮性，低）— ✅ 已修复

删除卡种时未校验目标是否存在即访问其属性。补 `if (!c) return toast('卡种不存在，可能已被删除', 'error');`。

### R7-7 `feeAlertOfWaived(mc, feeStatus)` 的 `feeStatus` 是死参（清理，低）— ✅ 已修复

函数体从未使用该参数，去掉以免误导（第二轮的 R2-2 修复已把分级逻辑内联）。

### R7-8 `syncMyCardSnapshots` O(持卡数 × 卡种数)（性能，低）— ✅ 已修复

循环体内 `getCards().find(...)` 是全表线性查找。改为先建 `Map` 索引
（`new Map(getCards().map(c => [c.id, c]))`），整体降为 O(持卡数 + 卡种数)。

### R7-9 `scrollIntoView` 无存在性判断（前端健壮性，中）— ✅ 已修复

`openBillGroupsModal` 定位后直接 `el.scrollIntoView({ block: 'center' })`。
该 API 在部分环境（无头浏览器、旧内核、自动化测试环境）不存在，
一旦缺失就抛 `TypeError` 并**中断整个弹窗渲染流程**（后续按钮绑定全部失效）。
本轮新增的 ui-test 断言恰好踩中此路径并复现了崩溃。

**修复**：加 `typeof el.scrollIntoView === 'function'` 判断后再调用（滚动仅为体验优化，缺失不应影响功能）。

## 二、通读确认无问题

- **组名 XSS**：`openBillGroupsModal` / 编辑弹窗输出的组名均经 `esc()` 转义，`innerHTML` 注入不成立
- **服务端拒绝「改组为 1 张」**：属正确的业务约束（避免产生名存实亡的组），非缺陷
- **提醒去重键语义**：`fee` 区分 `today`/阈值、`repay:group` 区分 `today`/`d+N`、`bill` 区分 `due`/`overdue`，均已正确

## 三、时间基准一致性修正

`repayItem(m, days)` / `taskItem(m, remainDays, gap)` 的兜底 key 用 `todayStr()`（**真实当前日期**）
而非 `collectReminders(cards, cfg, now, bills)` 传入的 `now`。测试或回溯导入历史数据时，
key 里的年月会漂移到真实月份，去重行为不可复现。

**修复**：两函数改为接收 `now`，key 中的年月取 `now` 的年月，与整条链路的时间基准对齐。

> 实测：`now=2026-10-31` 时 task key 为 `task:mc_t7:2026-10`（与传入 now 一致）；
> 跨到 11 月后 key 变化，使新一月的任务可再提醒一次。

## 四、端到端回归（本轮执行）

| 脚本 | 结果 | 说明 |
|---|---|---|
| `tools/dates-test.js` | **39/39** | 日期引擎无回归 |
| `tools/notify-test.js` | **128/128** | 新增 21 项：key 时间基准、配置回写、数据隔离、sentLog 淘汰 |
| `tools/ui-test.js` | **71/71** | 新增 6 项：账单组列表/编辑弹窗层级、本组成员可勾选、仅他组禁用 |
| `tools/bench.js` | 50 卡 13–19ms | 索引化后无回归（多次运行 1.0–1.3x 波动，属测量噪音） |

## 五、本轮新增测试基建

- `notify-test` 5.14：还款/刷卡任务 key 的时间基准与可复现性
- `notify-test` 5.15：提醒检查回写不覆盖并发用户改动（用 monkey-patch 在推送回调里改配置）
- `notify-test` 5.16：数据文件类型安全（对象/null/数组型）与损坏隔离（`.bad-*` 落盘）
- `notify-test` 5.17：sentLog 淘汰（400 天旧记录清理 / 小规模跳过 / 格式异常清理）
- `ui-test` §16：管理账单组弹窗层级（列表 → 编辑）+ 本组成员复选框必须可勾选

---

# 第六轮：新增「合并账单组」功能（2026-10-13）

> 需求：**「设定某几张卡合并账单，至提醒还款一张卡，不需要多张同时提醒」**
> 结论：原项目**不具备**该能力（提醒引擎严格逐卡生成，去重键 `repay:${m.id}:${date}` 也按卡隔离），本轮从零实现
> 设计决策：**策略③——组内强制同还款日**（用户明确选择），录入/编辑时校验并拒绝不一致的组合
> 验证：dates-test **39/39** ｜ notify-test 扩至 **107 项**（新增 37 项）｜ ui-test **65/65**（新增 13 项）｜ bench 50 卡 17.1ms

## 一、设计要点

### 1. 成员关系单一事实来源

组表只存 `{id, name, createdAt}`，成员关系记在每张持卡的 `billGroupId` 上。
不额外维护成员列表，杜绝「两处记录不一致」这类需要双向同步才能维持的缺陷。

### 2. 还款节奏一致性判定（核心）

只比「当天最后还款日」是不够的：`每月固定日 5 号` 与 `账单日后 4 天` 在账单日为 1 号的那个月
可能恰好落在同一天，换个月就错开。因此 `sameRepaySchedule()` 按 **未来 14 个月 × 每月 10 个采样日**
（1/5/10/15/20/25/28/29/30/31，覆盖月末钳制与跨平年闰日）逐一比 `D.paymentInfo().lastPayDate`，
全部一致才判定为同一节奏。还款方式、账单日、宽限期任一不同都会被正确识别为不一致。

> 实测：`fixed20 vs fixed20` → 一致；`fixed20 vs fixed25`、`fixed20 vs afterBill20`、
> `fixed5 vs afterBill4`（当月同日但换月错开）、`同日期不同宽限期` → 全部判为不一致。

### 3. 提醒归并（`reminder.collectReminders`）

- **还款提醒**：按 `billGroupId` 分组后，组内只由**排序后的首位成员**产出 1 条合并提醒，其余成员跳过
- **账单流水提醒**：同组同出账月聚成一条，给出合计应还；被手工改脏（到期日不一致）时取最早者
- **年费 / 月刷卡任务不合并**：这两类本就按卡独立（年费金额与刷卡任务互不相干）

**去重键**：`repay:group:${gid}:${lastPayDate}:${days===0?'today':'d'+days}`。
末段必须区分「当天」与「倒数第 N 天」——否则 3 天→0 天跨阈值时 key 相同，当天的「今日还款」会被去重逻辑吞掉
（与第五轮 R5-4 单卡 fee 提醒同类问题）。

## 二、修复的缺陷（开发过程中自查发现）

### R6-1 组内非首位成员的月刷卡任务被误跳过（逻辑，高）— ✅ 已修复

首版在还款提醒分支用 `if (g && g[0].id !== m.id) continue;` 跳过非首位成员，
但该 `for` 循环体里后面还有**按卡独立的月刷卡任务**判断，`continue` 会把它一并跳过 →
组内第 2 张卡即使月刷卡任务未达标也永远不提醒。

**修复**：改成嵌套 `if` 只跳过还款提醒那一项，不打断循环。

### R6-2 合并提醒 key 缺「倒数天数」导致当天提醒被吞（去重，高）— ✅ 已修复

初版 key 为 `repay:group:${slot}:${lastPayDate}`，同组跨阈值（3 天 → 当天）时 key 不变 →
当天那条被 sentLog 判为已发送。**修复**：key 末段追加 `today` / `d+N`，并加回归断言。

### R6-3 组渲染用未定义变量导致 key 出现 `undefined`（健壮性，中）— ✅ 已修复

`groupRepayItem(name, members, days, lastPayDate, slot)` 调用时未传 `slot`，
`slot` 为 `undefined` → key 变成 `repay:group:undefined:...`。
**修复**：函数签名改为 `(gid, name, members, days, lastPayDate)`，统一从组 id 取。

### R6-4 路由白名单未注册新接口（功能，高）— ✅ 已修复

`handle()` 开头执行 `matchRoute()` 白名单校验，未注册的路径直接返回 `undefined` → 404。
新增 `/api/billgroups` 四个路由后**忘记同步白名单**，探测脚本立刻暴露（建组返回 `undefined`）。
**修复**：在 `matchRoute` 的 routes 数组中补 `GET/POST/PUT/DELETE /api/billgroups`。

### R6-5 抽屉 rAF 回调未判空（前端健壮性，中）— ✅ 已修复

`renderDrawer()` 里 `requestAnimationFrame(() => $('.overlay', root).classList.add('show'))`：
rAF 是异步的，这一帧之间若已 `closeDrawer` / 切页（root 被清空），`$()` 返回 `null` →
`TypeError: Cannot read properties of null (reading 'classList')`，打断后续渲染。
**修复**：回调内判空 + `drawer.isConnected`，出现异常时静默跳过。
（该问题由 ui-test 在「建组后重新渲染再开抽屉」时序下真实触发）

### R6-6 新增边界断言复用了已被删除的测试卡（测试用例，低）— ✅ 已修复

「改组后成员只剩 1 张应被拒绝」这条断言，误用了同一段前面「删卡自动解散空组」步骤中
已被 `del8` 删除的 `gA` / `gB` 去建组 → 建组返回 404、`solo.id` 为 `undefined`，
PUT 打到 `/api/billgroups/undefined` 得到「账单组不存在」，断言以**错误原因**失败。
**后端行为本身正确**（单独探测确认改组到只剩 1 张确实返回 400）。
**修复**：把该断言**前移到删卡之前**，并补一条「被拒绝的改组不落地成员变更」交叉验证状态未被改动。
另外为三套测试脚本统一加上「通过 N/M 项」汇总输出，避免今后靠人工数 ✅ 核对断言总数。

## 三、边界处理清单

| 场景 | 处理 |
|------|------|
| 建组成员 < 2 张 | 400 拒绝（建组与改组两条路径都拦） |
| 组名空 / 重名 | 400 拒绝 |
| 把还款日不一致的卡挪进组（PUT mycards） | 400 拒绝，提示具体冲突的两张卡 |
| 组内成员改还款日（PUT mycards） | 以「改完之后」的状态重新校验，破坏一致性即拒绝 |
| 成员退出组（编辑持卡设 `billGroupId:''`） | 允许；组仍在，若组内只剩 1 张则该卡恢复逐卡提醒，但要清空最后一员须用「解散组」 |
| 改组后成员只剩 1 张（PUT 组 `memberIds` 长度 1） | 400 拒绝，提示「至少需要 2 张卡，可改为解散该组」——避免产生名存实亡的组 |
| 解散组 / memberIds 提交 `[]` | 成员 `billGroupId` 清空 + 组删除 |
| 删卡致组内成员清空 | `cleanBillGroups()` 自动删除僵尸组 |
| 持卡残留指向已删组的 `billGroupId` | 启动时 `cleanBillGroups()` 自愈清空 |
| 卡被移出组后其旧账单 | 恢复逐卡提醒（归并前会确认卡仍在组内） |
| 成员不存在 / 组不存在 | 404 |

## 四、端到端回归（本轮执行）

| 项目 | 结果 |
|------|------|
| `tools/dates-test.js` | 39/39 通过 |
| `tools/notify-test.js` | 107/107 通过（5.13 段扩至 37 项：建组/一致性/合并/改组边界/解散/删卡清理/非法输入/节奏判定） |
| `tools/ui-test.js` | 65/65 通过（新增第 16 段 13 项：按钮/弹窗/建组/徽章/抽屉区块/编辑下拉/退出清理） |
| `tools/bench.js` | 50 卡 / 5000 消费 / 800 权益 → 17.1ms（0.9x，绝对值 16~17ms，属负载波动，无实质回归） |
| 新接口实测 | `curl /api/billgroups` → `[]`、`/api/health` 正常 |

## 五、已知限制

- 组内**必须**同还款日（策略③）。若银行实际允许组内不同日而合并出账，需改策略并重做归并逻辑
- 合并提醒的「合计应还」来自组内各卡账单流水的和；未录入账单时只提示还款日，不估算金额
- 组不跨银行限制（技术上可跨行并组，只要还款日一致）

---

# 第五轮复盘（2026-10-13，边界与一致性探测）

> 本轮动作：**静态 API 一致性比对 + 边界值探测脚本 + 端到端回归**，重点覆盖「权益生命周期」「日期真实性」「路径安全」
> 结果：发现 **8 项缺陷**（3 项高、3 项中、2 项低），全部修复并固化为回归断言
> 验证：dates-test **39** 全过 ｜ notify-test 扩至 **70 项**（新增 23 项，覆盖 R5 全部修复）｜ ui-test **52/52** ｜ bench 50 卡 14.7ms

## 一、发现的问题与修复记录

### R5-5 权益增删/重排导致使用记录错配（正确性，高）— ✅ 已修复

**问题**：权益使用记录只按数组索引（`idx`）归属。编辑持卡时删除或重排权益后索引前移，**B 权益会继承 A 的历史次数**：A 用过 2 次、删掉 A 后 B 立即显示「已用 2 次」。这是数据错乱级缺陷，且随每次编辑不断累积。

**复现**（探测脚本实测）：
```
A 用 2 次 → 删 A（只留 B）→ B.used = 2   ← 应为 0
C 补录 3 次 → 重排（C 前置）→ C=5 / B=0  ← C 莫名多了 2 次
```

**修复**（三层）：
1. `normalizeBenefits` 为每个权益生成**稳定 `id`**；新增 `resolveBenefit(mc, idx, bid)` 优先按 id 定位，无 id 时回退索引
2. 权益三端点（usage/count/history）写入时带 `bid`，`resolveBenefit` 解析出目标权益
3. `buildIndexes` 权益分桶改为 **`bid:` 优先、`idx:` 兜底**；`benefitRecords`/`benefitUsage` 同时查两个桶，兼容无 `bid` 的历史记录
4. 新增 `migrateBenefitIds()`（在 `init()` 末尾执行）：按「迁移瞬间仍成立的索引映射」给历史权益补 id、历史记录补 bid

**回归断言**：5.9 段 4 项（含「删 A 后 B=0」「重排后 C=3/B=0」）。

### R5-4 年费「今日收取」提醒永不发送（正确性，高）— ✅ 已修复

**问题**：`feeItem` 的去重 key 为 `fee:${id}:${nextFeeDate}:${feeDayThreshold}`。`feeDays` 从 1 跨到 0 时，命中的阈值仍是同一个（`applicable[0]` 都是 1），**key 完全相同** → 「年费今日收取」被去重逻辑吞掉，用户永远收不到当天提醒。

**修复**：key 区分「倒数第 N 天」与「当天」——`days === 0 ? 'today' : feeDayThreshold`。

**回归断言**：5.11 段 2 项。

### R5-6 过期权益仍可写入/补录（正确性，高）— ✅ 已修复

**问题**：`benefitUsed` 对 `validUntil` 已过的权益返回 `expired: true` 但 `exhausted: false`（有意如此——避免显示成「次数用完」误导用户）。两个写入端点**只拦 `exhausted`**，于是过期权益从 API 层面完全放行，可无限写入记录。

**修复**：usage / count 两端点分别加 `if (st.expired) return err('当前权益已过有效期')`。

**回归断言**：5.12 段（过期 usage/count 均 400）。

### R5-1 非法日期静默进位入库（正确性，中）— ✅ 已修复

**问题**：`parseDateStr` 只用正则 `^\d{4}-\d{2}-\d{2}$` 校验格式，`2026-02-30`、`2026-13-01`、`2026-00-10` 全部判为「有效」。JS `new Date(2026, 1, 30)` 静默进位到 3-02，脏日期直接落库。

**修复**：构造后**回读比对**——`getFullYear/getMonth/getDate` 与输入年月日不一致即判非法：
```js
const dt = new Date(y, mo - 1, d);
if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
```

**波及**：所有走 `U.parseDateStr` 的入口自动受保护（消费、权益、账单 `dueDate`/`paidDate`）。账单 POST/PUT 此前只做 `String()` 透传，本轮补齐校验，并让 PUT 的「沿用旧值」分支也过校验。

**回归断言**：5.10 段 6 项（含账单 PUT 脏日期）。

### R5-2 权益接口索引越界无拦截（正确性，中）— ✅ 已修复

**问题**：`computeMyCard` 的 `benefitUsed(mc, 99)` 对不存在的权益返回 `exhausted: false`，端点据此放行并**写入一条 `idx: 99` 的垃圾记录**——永远无人展示、也无法通过 UI 清理。前端若因缓存/竞态发出越界请求即可触发。

**修复**：三端点统一改用 `resolveBenefit` 定位，定位失败返回 404『权益不存在』；同时覆盖「传了未知 `bid`」的情况。

**回归断言**：5.10 段 5 项（含「越界请求未产生任何记录」）。

### R5-3 跨年闰日钳制仍会滚月（正确性，中）— ✅ 已修复

**问题**：`clampFeeDate` 只按「当年」天数钳制。年费日设为 2-29，当前平年时 `new Date(平年, 1, 29)` 仍会静默滚到 3-01。

**修复**：新增 `feeDateIn(year, feeMonth, feeDay)`，`nextFeeDate`/`cardYearStart` 一律按**目标年份**的实际天数钳制；`dates.js` 的 `atDay` 同步改为按目标年月钳制。

**验证**：`nextFeeDate(2, 29)` @2029 平年 → `2029-02-28`（原为 3-01）。

### R5-7 移除权益后使用记录成孤儿（健壮性，低）— ✅ 已修复

**问题**：权益被移除后，其使用记录按 `bid` 归属已无人可展示（历史查不到、次数不统计），但记录仍留在 `benefits.json`，随每次编辑无限累积。

**修复**：`PUT /api/mycards/:id` 在更新权益列表时，连带清理「属于本卡、有 `bid`、且 `bid` 已不在新列表中」的记录（无 `bid` 的历史记录保留，避免误删）。

**回归断言**：5.12 段「移除权益后其使用记录被连带清理」。

### R5-8 清空权益后卡种默认权益「复活」（功能，低）— ✅ 已修复

**问题**：`normalizeBenefits` 判断条件是 `Array.isArray(benefits) && benefits.length`——编辑时把权益**全部删掉**会提交 `[]`，被当成「未提供」而回退到卡种默认权益，**用户永远删不干净**。

**修复**：只看「是不是数组」（`Array.isArray(benefits)`），空数组即空列表；仅当字段缺失时才继承卡种默认。

**回归断言**：5.12 段 2 项（显式 `[]` 清空 / 不传继承默认）。

### R5-9 静态文件路径校验前缀比较缺陷（安全，低）— ✅ 已修复

**问题**：`index.js` 的目录逃逸防护写作 `fp.startsWith(PUBLIC_DIR)`，**未带路径分隔符**。同级目录 `public-x/` 因前缀相同被判为合法，可读取其下任意文件；`PUBLIC_DIR` 本身也未 `path.resolve`，依赖调用方传入绝对路径。

**修复**：
```js
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
if (fp !== PUBLIC_DIR && !fp.startsWith(PUBLIC_DIR + path.sep)) { send(res, 403, ...); return; }
```
同时补 NUL 字节拦截与 `fs.statSync` 的 try/catch（原 `existsSync` + `statSync` 双调用在竞态下仍可能抛错）。

**实测**：`/..%2fpublic-x/a.txt`、`/%2e%2e%2fpublic-x/a.txt` → 403 且无内容泄漏。

## 二、端到端回归（全部通过）

| 套件 | 结果 |
|---|---|
| dates-test | 39 项全过 |
| notify-test | **70 项全过**（原 47 + 新增 23） |
| ui-test | 52/52 |
| bench（50 卡 / 5000 消费 / 800 权益记录） | 14.7 ms（与上轮持平） |
| 静态资源路径穿越 | 403 拦截，无泄漏 ✓ |

## 三、本轮新增/加固的测试基建

1. **测试数据目录预清理**：`notify-test` 的 `data2/data4/data5/data6/data7` 在使用前先 `rmSync`。此前脚本被中断会留下脏数据，导致下一次运行的「删除后消费表为空」等断言误报失败——属测试健壮性问题，非产品缺陷。
2. **R5 回归断言固化**：新增 5.9 / 5.10 / 5.11 / 5.12 四段共 23 项断言，覆盖权益 id 稳定性、接口边界、日期真实性、提醒去重键、权益生命周期。

## 四、通读确认无问题的部分（第五轮复核）

- 消费记录的 `count`/`amount` 分桶统计、卡年区间过滤逻辑正确
- 还款日期引擎（`repayMode` fixed/afterBill + `graceDays`）跨期跳期行为符合预期，主表「下次还款日」120 天不变量恒成立
- 提醒去重 `sentLog` 按 key 累积、历史保留 30 条，语义一致
- `/api/mycards` 单请求合并 data+stats+banks，`computeStats` 复用已算列表，无重复全量计算
- 前端 `esc()` 对 `& < > " '` 五字符完整转义，`data-bid` 属性注入安全

---

# 第四轮复查（2026-10-13，对第三轮修复的复查）

> 本轮动作：**逐 diff 复查第三轮全部改动**，另做端到端实测（建卡→记账→删除→跨卡拦截→统计同步）
> 结果：发现 1 项新缺陷 + 1 处风格清理，均已修复（提交 `f3b41dd`）

### R4-1 导入文件读取异常无保护（健壮性，R3-F4 引入）— ✅ 已修复

**问题**：R3-F4 给「开始导入」加了 disabled 防抖，但 `await file.text()`（文件读取）位于 try 块**外**：文件读取失败时异常直接逃逸为未处理 rejection，按钮状态与错误提示全部丢失，用户看不到任何反馈。

**修复**：文件读取纳入 try/catch，失败时 toast「文件读取失败：xxx」且不置灰（用户可立即重试）；`if (!text.trim())` 的空内容早退路径保持不置灰（本来就是正常用户流）。

### 清理：`var urlObj` 提升写法

`index.js` R3-1 修复中 `var urlObj = url` 写在 try 块内（功能正确——var 提升到函数作用域、异常路径直接 return），统一改为 `let urlObj` 在函数顶部声明，语义更清晰。

### 端到端实测结论（全部通过）

| 场景 | 结果 |
|---|---|
| 畸形 URL `/%E0%A4%A` | 400，服务存活 ✓ |
| 删除消费记录 | 200，明细 2 笔→1 笔、总额 199.95→76.5 ✓ |
| 跨卡删除他人记录 | 404 归属拦截 ✓ |
| 删除后统计同步 | 卡片 totalSpend 76.5 同步减少 ✓ |
| 笔数补录拒删 | 400「笔数补录记录不支持删除」✓ |
| UI 套件 | 52/52 ✓ |

> 备注：明细 API（`GET .../consumptions`）只返回 amount 类型记录——设计如此（count 补录无渠道/分类字段，不在「消费明细」语义内），删除按钮只会渲染在金额记录上，前后端一致。

---

# 第三轮复盘（2026-10-12，全量通读代码后）

> 本轮动作：**通读全部源码**（app.js 1310 行、routes.js 889 行、index.js/db.js/dates.js/util.js 全量），发现 4 项问题并全部修复，另落地 1 项高频功能
> 验证：dates-test 全过 ｜ notify-test 扩至 **47 项全过**（新增 6 项）｜ ui-test **52/52** ｜ 畸形 URL 实测返回 400

## 一、发现的问题与修复记录

### R3-1 畸形 URL 可击穿进程（正确性 / 安全，P0 级）— ✅ 已修复

**问题**：`index.js` 中 `decodeURIComponent(url.pathname)` 位于 try 块**之外**。请求 `/%`、`/%E0%A4%A` 等畸形百分号编码时抛 `URIError`，而 async 请求回调中的异常会变成 rejected promise → 触发 `unhandledRejection` 兜底处理器 → **进程直接退出**。单个恶意/意外的请求即可打死整个服务（Docker restart 策略虽会拉起，但期间服务中断、内存态提醒检查丢失）。已实测复现。

**修复**：将 `new URL()` 与 `decodeURIComponent` 一并移入 try 块，解析失败直接返回 400，请求周期内消化异常。实测：`/%` 与 `/%E0%A4%A` 均返回 400，服务存活。

### R3-2 提醒检查无并发防护（正确性）— ✅ 已修复

**问题**：`runNotifyChecks()` 可能被两个入口并发调用——容器内定时 tick（每 10 分钟）与用户手动「立即检查」按钮。检查过程含网络推送（可能耗时数秒），且节流判断（读 `lastCheckAt` → 推送 → 写回）非原子：并发时两边都通过节流检查 → **同一提醒双发推送**。

**修复**：模块级互斥标志，检查进行中时第二次调用直接返回 `{ skipped: true, reason: '上一次提醒检查仍在进行中' }`。断言：`Promise.all` 并发两次 force 检查，恰有一次被跳过。

### R3-F1 消费记录无法删除（功能缺口）— ✅ 已实现

**问题**：记错的消费记录（金额打错、重复记账）没有任何删除入口——这是记账类工具最高频的纠错需求，此前只能删卡重建（连带丢失全部流水与权益记录）。

**修复**：
- 后端：`DELETE /api/mycards/:id/consumptions/:recId`，校验持卡归属；笔数补录记录（type='count'）不支持删除（进度按笔累计、无撤销语义）返回 400
- 前端：消费明细弹窗（本月/本年/累计三种视图）每行追加「删」按钮，确认后删除并刷新；表头相应加空列

### R3-F3 不限次权益显示「已用 0 / -1 次」（显示缺陷）— ✅ 已修复

**问题**：权益记一笔弹窗显示 `已用 X / -1 次`，`-1`（不限次哨兵值）直接暴露给用户。

**修复**：不限次显示「已用 X 次（自然年重置，不限次数）」；有限次维持「上限 N 次」。

### R3-F4 CSV 导入可重复提交（健壮性）— ✅ 已修复

**问题**：「开始导入」按钮在文件读取 + 网络请求期间可被连续点击 → 同一批 CSV 重复提交（服务端虽有卡种去重，但会产生冗余请求与混乱的多次 toast）。

**修复**：点击后按钮置灰（`disabled`），完成/失败后恢复；置灰期间再点击直接忽略。

## 二、通读确认无问题的部分

- **db.js**：JSON 原子写入（tmp + rename）+ 内存缓存，损坏文件回退默认值，逻辑正确
- **dates.js**：`atDay()` 钳制月末（1月31日 setMonth 滚月问题已防护，实测验证）；`payDaysLeft` 跳期语义正确（连续 120 天推演永不指向过去）；「已逾期」分级仅提醒引擎账单路径可达，主表语义无矛盾
- **routes.js 输入校验**：金额封顶 1e12、次数封顶 1e6、正整数校验、枚举值白名单（渠道/分类/周期/免年费类型）、`clampFeeDate` 月末钳制、`clampDay` 范围钳制，覆盖完整
- **index.js 请求体**：20MB 上限、JSON 解析容错、静态路径穿越防护（`startsWith(PUBLIC_DIR)`）
- **CSV 解析器**：引号转义/跨行字段/BOM 处理正确
- **esc() 输出转义**：所有动态插值均经转义，无 XSS 注入点

## 三、遗留事项（评估后暂不做）

- **hash 路由深链接**：单用户本地工具，刷新丢失页签的痛点有限，收益低于改动风险
- **单条消费编辑**：删除已落地；编辑涉及日期/金额/渠道全字段回填，交互成本高，删除+重记可覆盖
- **卡库补丁化**（seed 拆 patch）：当前 SEED_VERSION 全量合并机制工作正常，83 张卡规模下无必要

---

# 第二轮复盘（2026-10-12，P0/P1/P2 落地后）

> 本轮动作：**发现 7 项问题，修复 7 项**（4 项正确性缺陷、2 项性能、1 项清理）
> 验证：dates-test 全过 ｜ notify-test 扩至 41 项全过 ｜ ui-test 扩至 **52/52** ｜ 基准 200 卡 6.1×

## 一、发现的问题与修复记录

### R2-1 年费达标判定恒误报「未达标」（正确性，P1 引入）— ✅ 已修复

**问题**：`feeStatusOf()` 读取 `mc.waiver` 做自动达标判定，但 `waiver` 是 `computeMyCard()` 的**计算输出**字段，原始持卡记录上根本没有——函数内恒为 `{}`，导致：

- `waiverType='免年费'` 的卡 → `autoMet=false` → 恒「未达标」
- 消费/笔数刷免已达标（`w.met`）的卡 → 恒「未达标」
- 前端「年费已达标」筛选、年费徽章绿色态全部失效

**修复**：`feeStatusOf(mc, now, ws)` 增加 `ws` 参数，由调用方（`computeMyCard` 内已算好的 `waiverState` 结果）传入。定点断言：免年费卡 → 「已达标(自动)」。

### R2-2 年费预警分级完全失效（正确性，P0 引入）— ✅ 已修复

**问题**：`computeMyCard()` 中 `feeDaysLeft = mc.feeDays`——原始记录无 `feeDays` 字段（它也是计算字段），恒为 `undefined` → `feeAlertOf(undefined, …)` 走到 `<=30` 前的 `!(…>0)` 判断返回「正常」。**所有卡的年费预警恒为「正常」**，「7天内/本月内/已过日」红色黄色预警从不出现。

**修复**：改用已算好的 `days = U.feeCountdown(...)` 作为剩余天数。豁免卡走 `feeAlertOfWaived()`（无年费 → 「无年费」，其余 → 「本年豁免」）；未达标卡按倒计时分级。定点断言：年费日 5 天后的刚性卡 → 「7天内」。

### R2-3 不限次权益无法补录次数（正确性，P1 引入）— ✅ 已修复

**问题**：权益 `total=-1` 表示不限次，但补录接口拦截条件 `st.used + count > st.total` 在 `total=-1` 时恒为真 → **不限次权益一次都补录不了**（「记一笔」走 usage 接口不受影响，因为只拦 `exhausted`，而不限次的 `exhausted=false`）。

**修复**：`total >= 0` 时才做上限拦截。断言：不限次权益补录 3 次成功、used 累计 3。

### R2-4 还款提醒未接入日期引擎（正确性，P0 引入）— ✅ 已修复

**问题**：P0 落地了「宽限期 + 两种还款方式」的日期引擎（`payment.payDaysLeft` 基于最后可还款日），但提醒引擎 ② 还款日仍按旧的 `repaymentDay + daysToRepay()` 固定日估算：

- `repayMode='afterBill'`（账单日后 N 天）的卡 → 按错误日期提醒
- 宽限期不参与 → 宽限期内实际还能还款时可能漏报/错报
- 提醒文案还是「每月 X 日」，与新 UI 的账单日/到期日/最后还款日口径脱节

**修复**：改用 `m.payment.payDaysLeft`（跳期语义天然正确：主表还款日永远指向未来）；提醒 key 从「年-月」改为「最后还款日」（`repay:卡id:YYYY-MM-DD`），同一天只推一次、跨期可再次提醒；文案输出本期账单日/银行到期日/最后还款日并标注宽限状态。`daysToRepay` 降级为兼容保留。断言：宽限期最后一天命中「今日还款」、afterBill 与 fixed 等价场景一致、`payDaysLeft` 永不为负。

### R2-5 筛选/排序下拉框交叉误标（UX，P2 引入）— ✅ 已修复

**问题**：`option()` 同时用 `state.filter === value || state.sort === value` 判断选中态，而 filter 与 sort 的取值有交集（`fee`/`repay` 同时出现在两个框里）→ 选了筛选「年费临近」后，排序框的「按年费临近」也被误标选中，反之亦然。

**修复**：`option(value, label, isFilter)` 拆开判断。UI 断言：筛选选中不污染排序框、排序选中不污染筛选框。

### R2-6 `/api/mycards` 统计重复全量计算（性能）— ✅ 已修复

**问题**：`computeStats()` 内部对每张卡再跑一遍完整 `computeMyCard`（含 waiverState、权益使用、日期引擎、排序取 recent），而 `/api/mycards` 已算过一次 → 单请求全量计算 **翻倍**。

**修复**：`computeStats(now, idx, computed)` 接受已算好的持卡列表，`/api/mycards` 传入复用。**基准 200 卡/2 万消费/3200 权益：43.8ms → 29.4ms，对比旧实现 6.1×**（第一轮为 4.35×）。

### R2-7 死代码与测试脚本问题（清理）— ✅ 已修复

- `collectReminders` 中 `monthKey` 未使用 → 删除
- `bench.js` 用 C 风格 `%.1f` 格式符（Node `console.log` 不支持，原样输出）；且未把已算列表传给 `computeStats`，基准虚高 → 修复后输出格式正确、数据真实

## 二、评估后「不改」的事项（附理由）

| 事项 | 结论 |
|------|------|
| 提醒引擎「账单流水逾期提醒」与「还款提醒」可能同卡同天各推一条 | 语义不同（账单是「这笔钱没还」，还款是「今天最后期限」），保留双通道；sentLog 按 key 去重不会重推 |
| `daysToRepay` 保留 | 提醒引擎已不用，但作为独立日期工具保留给外部脚本；已注明「旧口径」 |
| bills 表线性过滤（`/api/bills` GET） | 账单量 = 卡数 × 月数，个人规模 < 1 千条，线性足够；不为它建索引 |
| `handle()` 仍线性路由匹配 | 上轮已评估：35 条正则可忽略，保持零依赖 |

## 三、验证记录

| 验证项 | 结果 |
|--------|------|
| 语法检查（改动 6 文件） | ✅ 全过 |
| dates-test（日期引擎 37 项） | ✅ 全过 |
| notify-test（三通道 + 规则 + 账单提醒 + 不限次补录 + feeStatus 回归） | ✅ **41 项全过**（新增 12 项断言） |
| ui-test（jsdom UI 自动化） | ✅ **52/52**（新增 2 项下拉框交叉误标断言） |
| 性能基准 | ✅ 200 卡 6.1×（29.4ms vs 179.1ms）；50 卡 1.1×（个人规模两者均 <20ms） |
| 测试产物清理 | ✅ `.test-data`/`.bench-data`/`.notify-test-data*` 已删，`data/` 仅剩 `.gitkeep` |

## 四、遗留事项（建议后续迭代）

1. hash 路由深链接、单条消费记录编辑/删除（体验对齐原版）
2. 卡库补丁化（seed.js 拆 patch.js）
3. 本地提交尚未推送 GitHub（等用户提供新 token）

---

---

# 第一轮复盘（2026-10-12，首轮交付后）

> 本轮动作：**发现 6 项问题，修复 5 项，基准验证 1 项；另抓出 1 个回归 bug 并修复**

## P0-1 刷免进度/统计的全表重复扫描（性能）— ✅ 已修复

**问题**：`computeMyCard()` 每次调用都 `getConsumptions().filter(...)` 全表扫描；`computeStats()` 又对每张卡再跑一遍完整计算；`benefitUsed()` 按权益再扫一遍权益表。单次页面加载复杂度 **O(卡数 × 记录数)**。

**修复**：`buildIndexes()` 每请求一次建索引——消费按卡分桶（金额/笔数分离）、权益按 卡→序号 嵌套 Map 分桶；`computeMyCard/computeStats/benefitUsed` 全部改为查表。同时把 stats/banks 合并进 `/api/mycards` 响应。

## P0-2 年费日「2 月 31 日」静默滚月（正确性）— ✅ 已修复

**修复**：util.js 新增 `daysInMonth()/clampFeeDate()`——按当月实际天数钳制（2 月 31 → 2 月 28/29），POST/PUT 持卡均走此钳制。

## P0-3 新增持卡不填额度时继承失败（回归 bug）— ✅ 已修复

**问题**：`nonNeg(undefined, card.startCredit)` 中 `parseAmount(undefined)=0` 是有限非负数直接返回，默认值永不生效。UI 套件「编辑表单预填数据」断言抓到。

**修复**：`nonNeg()` 改为「空值/负值 → 回退默认；显式 0 → 保留 0；封顶 1 万亿」。

## P1-1 脏数据无边界（健壮性）— ✅ 已修复

金额 `<=0` 拒绝 + 上限 1 万亿；次数 `validCount()` 正整数封顶 100 万；额度/目标/年费负值回退默认。

## P1-2 无未捕获异常兜底（健壮性）— ✅ 已修复

`uncaughtException/unhandledRejection` 追加写入 `DATA_DIR/error.log` 后 `exit(1)`，由 Docker restart 拉起。

## P2-1/2 抽屉滚动位置丢失 + 前端重复拉数 — ✅ 已修复

`renderDrawer()` 重绘前捕获/恢复 `scrollTop`；stats/banks 合并进 `/api/mycards`。

## 第一轮「不改」事项

刷免窗口口径（两种窗口等价）、JSON 全文件重写（个人规模无感）、补录笔数可追溯优于原版、线性路由匹配、客户端排序。

## 第一轮遗留（已在后续迭代处理）

- ~~年费预警分级失效~~ → 第二轮 R2-2 修复
- ~~达标判定误报~~ → 第二轮 R2-1 修复
- hash 路由、单条记录编辑/删除、卡库补丁化 → 仍待迭代
