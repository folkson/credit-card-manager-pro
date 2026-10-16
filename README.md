# 管卡 — 信用卡管理工具（Docker 版）

仿「管卡 v2.4.5」制作的同款软件，运行在 Docker 容器中。维护「卡种数据库」（常见卡的重要信息），
记录「我的持卡」（年费、消费、权益使用），自动判断年费是否达标、即将到期提醒。
数据保存在 Docker 卷中，重启、升级不丢失；不依赖公网，可完全离线运行。

## 快速开始

```bash
# 在本目录执行（需要 Docker 20+，自带 compose 插件）
docker compose up -d

# 浏览器打开
http://localhost:3000
```

常用命令：

```bash
docker compose logs -f          # 看日志
docker compose restart          # 重启
docker compose down             # 停止（数据保留在卷里）
docker compose down -v          # 停止并删除数据卷（慎用！）
docker compose up -d --build    # 改代码后重新构建
```

不用 compose 也可以：

```bash
docker build -t credit-card-manager:1.0.0 .
docker run -d --name credit-card-manager -p 3000:3000 -v guanka-data:/app/data --restart unless-stopped credit-card-manager:1.0.0
```

首次启动自动写入内置卡种库（83 张常见卡 / 15 家银行，示例数据），无需任何配置。

## 在群晖 NAS 上部署

完整步骤见 **[DEPLOY-SYNOLOGY.md](DEPLOY-SYNOLOGY.md)**（Container Manager 图形界面 / SSH 两种方式、
目录与权限避坑、备份升级、离线导入镜像、公网访问安全提示）。

要点速览：

1. Container Manager（套件中心安装）→ 建目录 `/volume1/docker/credit-card-manager`
2. 上传源码（`Dockerfile`、`docker-compose.yml`、`server/`、`public/` 必须在**同一层**）→ 新建「项目」
3. 粘贴本项目 `docker-compose.yml` 内容 → 验证 → 创建并启动 → 访问 `http://群晖IP:3000`
4. 若改用「绑定目录挂载」，**必须** `chown -R 1000:1000` 数据目录（容器内以非 root 的 node 用户运行）

## 功能一览（与原版对照）

| 模块 | 功能 |
|------|------|
| 我的持卡 | 4 个统计卡：持卡总数、各银行最高授信合计、本月/年度总消费、年费即将到期（30 天内需缴费，可点开查看） |
| 添加持卡 | 从卡种库按银行分组选卡（支持搜索），填别名、授信额度、账单/还款日、年费收取月日、月消费目标、权益（可设重置周期） |
| 持卡列表 | 按银行分组、可折叠；↑/↓ 调整银行顺序；卡片按名称排序；折叠与顺序自动记忆 |
| 年费倒计时 | 「年费还有 N 天」徽章：不足 60 天黄色、不足 30 天红色（仅需缴费的卡变色） |
| 免年费进度 | 消费刷免/笔数刷免显示进度条与剩余额度/笔数；积分抵扣、资产存免为左右滑块开关；刚性/免年费显示徽章 |
| 消费记录 | 记一笔（日期、金额、12 种支付渠道、分类、备注）；补录消费笔数（只计笔数不记金额） |
| 消费明细 | 本月/本年/累计三个时段查看，本年按月折叠、累计按年+月两级折叠 |
| 权益使用 | 每权益显示重置周期徽章（蓝=自然月/紫=自然年/橙=年费日）与已用/总数进度；可逐笔记录、按次数补录、查各周期历史；次数用完自动拦截 |
| 卡种数据库 | 列表/新增/编辑/删除；批量导入 CSV；按银行分组收起展开（默认收起） |
| 导出持卡 | 导出当前持卡对应的卡种信息 CSV（仅 12 项基础信息，不含个人隐私数据） |
| 备份 / 恢复 | 一键导出**全量个人数据 JSON**（持卡 + 权益 + 消费 + 账单 + 账单组，含卡种自动建库）；恢复支持**合并**（幂等，同 id 自动跳过，适合定期备份回灌）与**覆盖**（清空后以备份为准，适合迁移）两种模式，越界/非法字段自动钳制归一 |
| 主题 | 白色/深色一键切换，选择自动记忆 |
| 合并账单 | 把还款日相同的多张卡加入同一「账单组」，还款/账单提醒合并为 **1 条**（列出组内各卡与合计应还），不再逐卡刷屏；年费与月刷卡任务仍按卡独立 |
| 卡/票管理 | 优惠券（按次）、储值卡（按余额）、满减券（满减门槛校验）三类统一管理；按商家分组、类型筛选；核销/回退/充值全流水；独立商家目录（可先建商家后加券） |
| 会员储值 | 视频会员、健身年卡、储值卡等订阅资产；金额型（余额充值/消费）与次数型（使用/回退）两种模式；10 种分类分组展示；到期倒计时徽章 |
| 知识库 | 课程/专栏/社群/订阅等知识资产；付费周期（月付/年付/终身）、价格、进度、账号、标签管理；使用记录 +1/-1、下载/调用配额联动；续费/充值/退款/赠送付费流水 |
| 资产统计 | 会员余额、券剩余、知识库投入、权益核销率（加权）四大指标卡；资产结构条形图；统一动态流（会员流水+券核销+知识使用+权益使用合并倒序） |
| 到期提醒扩展 | 会员卡/卡票/知识库订阅三类资产临期自动进入提醒引擎（`assetExpiryDays` 规则，默认提前 7 天，0=关闭） |
| 日历订阅 | 生成 **ICS 订阅链接**，把还款日、年费日、账单到期、刷卡任务截止导入系统日历（Apple 日历 / Google 日历 / Outlook 等），订阅后自动更新；无需在应用内逐条查看提醒 |
| 其他 | 卡种库升级自动合并新卡（按 银行+名称+卡组织+等级 去重）；数据原子写入防损坏 |

## 日历订阅（ICS）

把各类时间提醒导入系统日历，订阅一次后自动跟随数据更新，无需反复打开应用查看。

- **入口**：设置 → 通知提醒设置 → 「日历订阅（ICS）」；输入访问令牌即可生成完整订阅链接并一键复制。
- **端点**：`GET /api/calendar.ics?token=<AUTH_TOKEN>`，返回 `text/calendar`。
  日历客户端无法携带登录 Cookie / Bearer，因此订阅链接必须带 URL token；浏览器已登录用户带 Cookie 也可直接打开。
- **包含事件**（均为全天事件，前 1 天 09:00 本地时间提醒，约 6 个月滚动窗口）：
  ① 还款日（含宽限期，合并账单组只出一条）；② 年费日；③ 账单到期（未还，含逾期未还）；④ 刷卡任务截止（当月月末）。
- **订阅方式**：Apple 日历「文件 → 新建日历订阅」、Google 日历「其他日历 → 通过网址添加」、Outlook「添加日历 → 从 Internet 订阅」，粘贴链接即可。
- 事件 UID 由卡片与日期派生、跨刷新稳定，日历不会因重复订阅产生重复事件。

## 数据与备份

- 所有数据在 Docker 命名卷 `guanka-data`（容器内 `/app/data`）中，为 JSON 文件：
  `cards.json`（卡种库）、`mycards.json`（持卡）、`consumptions.json`（消费记录）、
  `benefits.json`（权益记录）、`bills.json`（账单流水）、`billGroups.json`（合并账单组）、
  `notify.json`（提醒配置，仅在配置过时生成）、`settings.json`（主题/排序/折叠状态）。
- 备份：`docker run --rm -v guanka-data:/data -v %cd%:/backup alpine tar czf /backup/guanka-backup.tar.gz -C /data .`
  （PowerShell 中 `%cd%` 换成 `$(pwd)` 或绝对路径）
- **应用内备份（推荐）**：持卡页「备份」按钮下载 `guanka-backup-日期.json`，含持卡/权益/消费/账单/账单组与被引用卡种；
  「恢复」按钮选择该 JSON 即可合并或覆盖导入，卡种按 银行+名称+卡组织+等级 自动匹配、缺失自动创建。
  另有 API：`GET /api/mycards/export`（下载）、`POST /api/mycards/import`（body: `{ data, mode: "merge"|"replace" }`）。
- 恢复：把备份解压到卷对应目录即可；或直接把宿主机目录挂载为卷：
  `docker run -v /your/data/dir:/app/data ...`（容器内以 node 用户运行，注意宿主机目录的读写权限）

## 提醒功能（3 个通道）

顶栏点击 🔔 打开「提醒设置」，可配置 **WxPusher / Server酱³ / Bark** 三个通道（可同时启用），
容器常驻进程定时检查并推送，**不需要 cron**。

**提醒类型**

| 类型 | 触发条件 | 默认 |
|------|---------|------|
| 年费到期 | 需缴费（未达标/未抵扣/刚性）且剩余天数跨过 30/7/1 天阈值 | 每个阈值只推一次 |
| 还款日 | 距下次还款日 ≤ N 天（自动跨月） | N=3 |
| 月刷卡任务 | 月末最后 N 天仍未达标 | N=3 |

**通道参数**

| 通道 | 参数 | 获取方式 |
|------|------|---------|
| WxPusher | appToken、UID（多个逗号分隔）、主题ID（可选）、消息前缀 | wxpusher.zjiecode.com 后台 |
| Server酱³ | SendKey（SCT/SCU 开头） | sct.ftqq.com |
| Bark | deviceKey、服务器地址（自建填自己的）、级别、分组 | iOS Bark App 复制 key |

**安全建议**：所有推送凭证（appToken / SendKey / deviceKey）在 API 响应中一律以掩码
（`••••` + 末 4 位）返回，不会明文回传；但在磁盘 `data/notify.json` 上仍是明文。
更安全的做法是不填 UI、改用环境变量注入（配置为空时自动回退），这样凭证完全不落盘：

```yaml
services:
  guanka:
    # ...
    environment:
      - WXPUSHER_APP_TOKEN=AT_xxx
      - WXPUSHER_UIDS=UID_xxx
      - SERVERCHAN_SENDKEY=SCTxxx
      - BARK_DEVICE_KEY=xxxxx
```

> 自建 Bark 服务请用 `NOTIFY_BARK_URL` 环境变量配置，不要填 UI 里的「服务器地址」——
> 该字段会校验为 https 且禁止指向内网地址（防 SSRF）。

- 去重：同一提醒（卡 + 周期 + 阈值）只推一次，避免刷屏
- 单通道失败不影响其余通道，失败原因记在「最近推送记录」里
- 上游返回非预期格式（HTTP 200 但不是 JSON）会被判为**失败**并写明原因，不会静默记成成功
- 手动验证：设置页可「发送测试」与「立即检查」；也可 `curl -X POST http://localhost:3000/api/notify/check`
  （启用 AUTH_TOKEN 时需带 `-H "Authorization: Bearer $AUTH_TOKEN"`）

## 访问控制与安全

**默认行为**：未设置 `AUTH_TOKEN` 时，服务**只允许本机（回环地址）访问**，局域网与公网来源
一律返回 403。这样即使误把端口暴露出去，也不会被直接读取数据。

**开放局域网/公网访问**：必须显式设置 `AUTH_TOKEN`：

```bash
# 1) 生成一个高强度令牌
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

# 2) 写入 .env（与 docker-compose.yml 同目录）
echo "AUTH_TOKEN=刚生成的令牌" > .env

# 3) 把 docker-compose.yml 的端口绑定从 127.0.0.1:3000:3000 改成 3000:3000
docker compose up -d
```

浏览器首次访问会弹出令牌输入框，登录后凭 HttpOnly 会话 Cookie 免登录（30 天）。
命令行调用可改用请求头：`curl -H "Authorization: Bearer $AUTH_TOKEN" http://host:3000/api/mycards`。

**其它已内置的防护**

| 项 | 说明 |
|---|---|
| 端口默认只绑回环 | `docker-compose.yml` 用 `127.0.0.1:3000:3000`，避免 Docker 端口映射对所有网卡放行 |
| 会话 Cookie | `HttpOnly`（XSS 偷不到）+ `SameSite=Lax`（阻断跨站表单 CSRF）；反代启用 HTTPS 时设 `TRUST_HTTPS=1` 追加 `Secure` |
| 凭证掩码 | 推送 token 在 API 响应中只回末 4 位；掩码提交视为「不修改」，不会误覆盖 |
| SSRF 防护 | Bark「服务器地址」必须 https 且不得解析到私有/环回/链路本地/保留网段 |
| 关闭接口 | `POST /api/shutdown` 需鉴权，且拒绝跨站来源 |
| 登录限速 | 同一 IP 连续 5 次令牌错误则锁定 60 秒 |
| 请求体上限 | 超过 20MB 返回 **413**（原实现直接断连，客户端只看到连接重置） |
| 路径穿越 | 静态文件目录逃逸拦截（带路径分隔符比较），畸形 URL 返回 400 且不影响进程存活 |

## 性能说明

- **静态资源**：启动时一次性读入内存并预压缩，`app.js` 传输从 86.8KB 降到 23.2KB（gzip 省 73%），
  并启用 `ETag` 条件请求（内容未变返回 304，省掉整个响应体）与 `Cache-Control: max-age=3600`
- **数据文件**：默认写紧凑 JSON（去缩进，体积省约 23%）。需要人类可读的缩进格式时设 `PRETTY_JSON=1`
- **写入路径**：所有写操作是「读缓存数组 → 改 → 原样回写」，校验与写入之间没有 await 让出点，
  因此并发写不会丢更新；代价是写入期间事件循环被同步 IO 阻塞（个人规模下无感，
  数据量到数万条时「记一笔」的耗时会随文件大小线性增长）

## 合并账单（多卡共用一次提醒）

同一家银行的多张卡常常共用还款日，逐卡提醒会很吵。把这几张卡加进同一个**账单组**后：

- **还款提醒合并为 1 条**：标题如「还款提醒」招行合并还款 3 天后到期（3 张卡合并）」，正文列出每张卡与银行到期日
- **账单流水提醒同样合并**：同一组同一出账月的未还账单聚成一条，给出**合计应还**与最晚到期日
- **年费提醒、月刷卡任务不合并**：这两类本就按卡独立（年费金额与刷卡任务互不相干）

**组内必须同还款日**（v1 策略）：建组/改组/编辑持卡时会校验，还款节奏不一致直接拒绝并提示是哪两张卡冲突。
判定不只是比当天日期，而是按未来 14 个月逐月推算「最后还款日」——`每月固定日 5 号` 与 `账单日后 4 天`
可能在某个月恰好同一天，换月就错开，这种组合会被正确识别为不一致。还款方式、账单日、宽限期任一项不同也算不一致。

**用法**

1. 持卡列表工具栏点「合并账单」→ 填组名 → 勾选成员（至少 2 张，已在其他组的卡会自动置灰）→ 新建
2. 或在「编辑持卡」里用「合并账单组」下拉把单张卡加入/移出已有组（只列出还款日匹配的组）
3. 持卡行会显示「合并账单 · 组名」徽章；抽屉里可看到组内成员与按月合计，也可一键「退出合并账单」
4. 解散组、删光组内成员时组会自动清理，不会留下僵尸组

> 数据存于 `billGroups.json`（仅组名），成员关系记在每张持卡的 `billGroupId` 上——单一事实来源，
> 不会出现两处不一致。组内成员不足 2 张或组不存在时，持卡的引用会在启动时自动清空。

## 还款与账单（宽限期 / 账单流水）

还款日期体系对齐金山文档「信用卡掌柜」的口径：

- **还款方式二选一**：`每月固定日`（固定日不晚于账单日时自动落到次月）或 `账单日后 N 天`
- **宽限期**：`最后可还款日 = 银行到期日 + 宽限期`；且宽限期**参与选期判断**——过了到期日但仍在宽限期内仍算本期，不会误跳下期
- **主表还款日永远指向未来**（过即跳下期），判断是否漏还看「账单流水」的**是否已还**
- **预警分级**：还款（已逾期/今日到期/3天内/本周内/正常）、年费（无年费/本年豁免/已过日/7天内/本月内/正常）
- **账单流水**：按月记录（出账月份/金额/到期日/是否已还/还款日期），支持一键生成本期账单；标记已还自动填日期，改回未还自动清空
- **年费达标三路**：无年费 / 手工声明年份 / 自动判定（金额或笔数，含「已刷核定期」跨年闸门）
- **权益增强**：类型标准化（17 种）、`总额度 -1 = 不限次`、有效期至、周期支持「一次性/无固定」
- **免息期**：自动推导最长免息期与「建议消费日」（账单日次日免息最长）
- 列表支持按「本月需还款 / 年费临近 / 已达标 / 有未还账单 / 有剩余权益」筛选，按名称/年费临近/还款临近/银行排序

> 老数据零改动：原有的 `repaymentDay` 会自动迁移为 `repayMode=fixed + repayValue=原值`，宽限期默认 3 天。

## 批量导入 CSV

表头（与原版模板一致）：

```
银行,卡片名称,卡等级,卡组织,年费,免年费类型,刷免条件,免年费政策,起批额度,主要权益,申请条件,备注
```

- 免年费类型：`消费刷免`（条件填金额如 `10万`）、`笔数刷免`（如 `10笔`）、`积分抵扣`（如 `10000`）、
  `资产存免`（如 `500000`）、`刚性`（填 0）、`免年费`（填 0）
- 金额支持纯数字或数字+单位（`50000`、`5万`）
- 多个权益用 `|` 分隔
- 已存在的卡种自动跳过，不会重复导入

## 与原版的差异

- 原版为 Windows/Mac 桌面程序（后台服务 + 托盘图标）；Docker 版为 Web 服务，任意设备浏览器访问
- 原版数据为加密存储；Docker 版为明文 JSON（方便备份和迁移，容器请放在可信环境使用）
- 内置卡种库为示例数据（83 张/15 家银行），与原版 82 张的清单不完全相同，可自行导入补充
- 未实现：托盘/菜单栏图标（容器内无桌面环境意义）、自动打开浏览器

## 技术栈

- 后端：Node.js 原生 `http` 模块，**零 npm 依赖**（路由、JSON 存储、CSV 解析均为内置实现）
- 前端：原生 JS SPA + CSS 变量主题，无构建步骤
- 存储：JSON 文件 + 临时文件原子写入
- 镜像：`node:20-alpine`，非 root 用户运行，带健康检查

## 本地开发（不起容器）

```bash
node server/index.js        # 默认 http://localhost:3000
PORT=8080 node server/index.js
DATA_DIR=./data node server/index.js
```

## 开发自检（可选）

三套自动化验证脚本，均无需额外依赖（`ui-test` 需 jsdom）：

| 脚本 | 覆盖范围 | 断言数 |
|------|---------|--------|
| `tools/dates-test.js` | 日期引擎：账单/还款日推导、宽限期选期、预警分级、跨年闰日钳制 | 39 |
| `tools/notify-test.js` | 提醒引擎：三通道推送、去重、年费达标判定、权益生命周期与接口边界、合并账单组、**数据文件类型安全与损坏隔离、sentLog 淘汰** | 128 |
| `tools/ui-test.js` | 前端逻辑：页面渲染、抽屉、记一笔、补录、权益超限拦截、编辑持卡、卡种库、主题切换、**合并账单组交互（含成员移出）** | 71 |

```bash
node tools/dates-test.js             # 纯逻辑，直接跑
node tools/notify-test.js            # 内置 mock 服务，直接跑

npm i -g jsdom                       # ui-test 需要 jsdom
node server/index.js &               # 先起服务
NODE_PATH=<jsdom所在node_modules> node tools/ui-test.js
```

> `ui-test` 默认连 `localhost:3000`，端口不同时用 `TEST_PORT=3311` 指定。
> 三套脚本结尾都会打印「通过 N/M 项」，便于直接核对断言总数。

## API 摘要

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/health | 健康检查 |
| GET | /api/meta | 渠道/分类/免年费类型等枚举 |
| GET/PUT | /api/settings | 主题、银行顺序、折叠状态 |
| GET | /api/stats | 首页统计 |
| GET/POST | /api/cards | 卡种库查询/新增 |
| PUT/DELETE | /api/cards/:id | 卡种编辑/删除 |
| POST | /api/cards/import | CSV 批量导入 |
| GET | /api/cards/export | 导出持卡对应卡种 CSV |
| GET/POST | /api/mycards | 持卡查询（响应含 data + stats + banks 合并统计）/新增 |
| GET | /api/mycards/export | 持卡备份下载（全量 JSON，含权益/消费/账单/账单组与被引用卡种） |
| POST | /api/mycards/import | 持卡备份恢复（body: `{ data, mode: "merge"|"replace" }`，merge 幂等） |
| PUT/DELETE | /api/mycards/:id | 持卡编辑/删除 |
| POST | /api/mycards/:id/consumptions | 记一笔消费 |
| POST | /api/mycards/:id/consumptions/count | 补录消费笔数 |
| GET | /api/mycards/:id/consumptions?scope=month\|year\|all | 消费明细 |
| POST | /api/mycards/:id/benefits/:idx/usage | 权益记一笔 |
| POST | /api/mycards/:id/benefits/:idx/count | 权益补录次数 |
| GET | /api/mycards/:id/benefits/:idx/history | 权益周期历史 |
| GET/POST | /api/bills | 账单流水查询/新增 |
| PUT/DELETE | /api/bills/:id | 账单标记已还/删除 |
| POST | /api/mycards/:id/bills/generate | 生成本期账单 |
| GET/POST | /api/billgroups | 合并账单组查询/新建（校验组内同还款日） |
| PUT/DELETE | /api/billgroups/:id | 改组名与成员/解散组 |
| POST | /api/mycards/:id/points | 积分抵扣开关 |
| POST | /api/mycards/:id/asset | 资产达标开关 |
| GET | /api/calendar.ics?token=\<AUTH_TOKEN\> | ICS 日历订阅（还款日/年费日/账单到期/刷卡任务截止；约 6 个月滚动窗口，提前 1 天提醒） |
| GET | /api/assets/meta | 扩展资产枚举（会员分类/券类型/知识库类型与分类/周期） |
| GET | /api/assets/stats | 资产聚合统计（会员余额/券剩余/知识投入/权益核销率/资产结构） |
| GET | /api/assets/feed?limit=N | 统一动态流（会员流水+券核销+知识使用+权益使用合并倒序） |
| GET | /api/assets/expiring?days=N | 三类资产到期扫描（含 daysLeft/value） |
| GET/POST | /api/memberships | 会员卡/储值卡查询（含 remaining）/新增 |
| PUT/DELETE | /api/memberships/:id | 会员卡编辑/删除（编辑保留流水） |
| POST | /api/memberships/:id/txn | 会员卡流水：金额型 topup/consume、次数型 use/undo |
| GET/POST | /api/vouchers | 卡/票查询/新增（coupon/storedcard/fullred，旧类型自动映射） |
| PUT/DELETE | /api/vouchers/:id | 券编辑/删除 |
| POST | /api/vouchers/:id/use | 券核销/撤销（满减券校验门槛，body 传 amount/undo） |
| POST | /api/vouchers/:id/topup | 储值型券充值/金额核销（body: `{ kind: "topup"|"consume", amount }`） |
| GET/POST | /api/voucherbrands | 独立商家目录（同名查重） |
| PUT/DELETE | /api/voucherbrands/:id | 商家编辑/删除 |
| GET/POST | /api/knowledge | 知识库资源查询（含 active）/新增 |
| PUT/DELETE | /api/knowledge/:id | 资源编辑（保留 useLog/history）/删除 |
| POST | /api/knowledge/:id/use | 使用 +1/回退（quota 联动：countMax 拦截、download/call 扣减） |
| POST | /api/knowledge/:id/history | 付费流水（renew/recharge/use/refund/gift） |
| POST | /api/shutdown | 优雅退出（数据安全落盘） |
