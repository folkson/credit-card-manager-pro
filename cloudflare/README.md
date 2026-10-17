# 管卡 · Cloudflare Workers 版

原 Docker 版（Node.js 零依赖）到 Cloudflare Workers 的完整移植。业务逻辑层
（routes / dates / util / assets / seed / reminder / ics，约 3500 行）**零改动复用**；
仅替换平台相关层：存储（fs → Durable Object Storage）、鉴权（进程 env → Worker env）、
DNS（node:dns → DoH）、定时调度（setInterval → Cron Triggers）、静态资源（自写预压缩
→ Workers Assets）。

## 架构

```
浏览器 ──→ Worker (worker.js)
            ├─ /api/auth/*    → Worker 本地处理（登录/登出/状态，恒时比较）
            ├─ /api/*         → auth.guard() → GuankaDO.fetch()
            └─ 其余路径       → Workers Assets（自动 gzip/brotli + ETag）
Cron */10 ──→ DO.runCronChecks()（节流后跑提醒检查 + 推送）

GuankaDO（单实例 'guanka-singleton'）
  ├─ Store：内存缓存 + DO Storage 强一致持久化（对齐原版「内存 cache + JSON 文件」）
  ├─ vendored/server/*.js：业务层（打包时自动 patch：NOW() 时区 / ENV 平台变量）
  └─ 单请求串行 →「读-改-写」无并发让出点（等价原版 Node 单线程，并发写不丢更新）
```

## 为什么需要 Durable Object

| 方案 | 问题 |
|---|---|
| Workers + KV | KV 最终一致（读可能拿到 60 秒前的旧值），「连点开关写 settings」会丢更新 |
| Workers + D1 | 业务层是「整段数组读改写」模型，改 SQL 需重写全部 39 处 store.write 调用 |
| **Workers + DO（本方案）** | 强一致 + 单请求串行语义恰好等价 Node 单线程，业务层零改动 |

## 部署

```bash
cd cloudflare
npm install -g wrangler          # 或 npx wrangler
# 1. 配置访问令牌（首次部署必须）：
wrangler secret put AUTH_TOKEN   # 输入一个强随机字符串
# 2. 部署：
npm run deploy                   # = vendor + wrangler deploy
```

首次部署后 wrangler 输出 `https://guanka.<your-subdomain>.workers.dev`。

### 必要配置

| 项 | 说明 |
|---|---|
| `AUTH_TOKEN` | **必填**。Workers 没有「本机回环」概念，未配置时所有请求 403。用 `wrangler secret put AUTH_TOKEN` 设置 |
| Cron Triggers | `wrangler.toml` 已声明 `*/10 * * * *`（每 10 分钟，对应原版 setInterval 节奏） |

### 可选配置（推送相关，与 Docker 版同名同义）

| 变量 | 用途 |
|---|---|
| `NOTIFY_WXPUSHER_URL` / `NOTIFY_SCT_URL` / `NOTIFY_BARK_URL` | 推送通道端点覆盖（本地 mock 测试用） |
| `WXPUSHER_APP_TOKEN` / `WXPUSHER_UIDS` / `SERVERCHAN_SENDKEY` / `BARK_DEVICE_KEY` | 凭证环境变量兜底（不填 UI 也可用） |

推送凭证主要存在 `notify` 数据集（DO Storage），与 Docker 版一致走 UI 配置 + 掩码回显。

## 时区处理（重要）

原版业务层用「本地时区年月日」做还款/年费/月度统计的日期运算。Workers 运行时
恒为 UTC，直接部署会导致北京时间 00:00–08:00 之间「今天」被算成昨天——提醒提前
8 小时翻转。本移植用 `NOW()`（打包期把无参 `new Date()` 机械替换）返回
**UTC+8 拨快 8 小时的 Date**：其 `getFullYear/getMonth/getDate` 等本地分量
恒等于北京时间的年月日，业务层无需任何改动即获得正确的北京时区语义。
副作用：`toISOString()` 展示的时间戳会偏移 8 小时（仅影响日志/备份里的
exportedAt 展示值，无业务危害）。

## 数据迁移（Docker → Workers）

1. Docker 版 UI → 持卡备份导出（JSON 全量）
2. Workers 版 UI → 持卡备份导入（merge 模式幂等，可重复执行）
3. 推送通道配置在 Workers 版重新填一遍（凭证不进备份文件，是刻意的安全设计）

反向迁移（Workers → Docker）：同样走备份导出/导入，schema 完全兼容。

## 与 Docker 版的行为差异

| 项 | Docker 版 | Workers 版 |
|---|---|---|
| POST /api/shutdown | 进程优雅退出，Docker 拉起 | 返回 200 + 忽略（无进程概念，数据已持久化） |
| 未配置 AUTH_TOKEN | 仅本机回环可访问 | **所有请求 403**（没有本机概念） |
| 首次提醒检查 | 启动 15 秒后跑一次 | 下一个 Cron tick 跑（≤10 分钟） |
| Cookie Secure | 纯 HTTP 部署默认不加 | 恒加 Secure（Workers 一律 HTTPS） |
| 静态资源 | 自写预压缩 + ETag | Workers Assets（边缘 brotli，更快） |
| 免登录回环模式 | 支持 | 不支持（必须配置 AUTH_TOKEN） |
