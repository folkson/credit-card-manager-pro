'use strict';

/* Cloudflare Workers 版数据库层：替换 server/db.js 的 fs 文件存储。
 *
 * 设计要点（与原版语义严格对齐）：
 * 1. **单实例 Durable Object**：所有请求经 Worker 转发给同一个 DO（按固定 key 命名），
 *    DO 内部串行处理（Workers 平台保证同 DO 同时只有一个请求在执行），因此
 *    「读缓存 → 改 → 回写」之间没有并发让出点，与原版 Node 单线程语义等价——
 *    并发写不丢更新这一核心正确性结论直接平移。
 * 2. **内存缓存 + DO Storage 持久化**：对应原版「内存 cache + JSON 文件」。
 *    DO Storage 是事务性 KV，写入即持久（无需原子临时文件/rename 那套机制）。
 * 3. **类型安全读取**：readArray / readObject 的隔离与回退语义保持一致
 *    （数据损坏在 KV 场景下表现为「值类型不对」而非「JSON 解析失败」，处理等价）。
 * 4. **写入节流**：每次业务写都全量 put 整个数组（与原版全量重写一致），个人规模
 *    （<1MB/数据集）远低于 DO Storage 128KB/值与总容量限制。
 *
 * ⚠️ 异步契约（v1.0.1 修复）：真实 DO Storage API 的 get/put **返回 Promise**
 * （异步 I/O）。为保持 vendored 业务层的同步调用形态（store.read/write 零 await），
 * 采用「预热 + 写队列」两段式：
 *   - warmup()：DO 构造时在 blockConcurrencyWhile 内 await 拉全部数据集进缓存，
 *     并按数据集预期类型（数组/对象）校验，坏值隔离到 bad:* 备份 key；
 *   - 之后所有同步读只操作缓存（必命中，warmup 已覆盖全部数据集）；
 *   - write() 同步更新缓存 + 把 storage.put 的 Promise 排队；
 *     请求收尾统一 await flush()，写失败在请求层抛出 → 500（对齐 Node 版
 *     同步写抛错语义）。DO 串行 + input gate 保证排队期间无并发交叉。
 */

const DATASETS = [
  'cards', 'meta', 'mycards', 'consumptions', 'benefits', 'bills', 'billGroups',
  'settings', 'notify', 'memberships', 'vouchers', 'voucherBrands', 'knowledge',
];

// 对象型数据集（其余全部为数组型）；预热时按预期类型校验，类型不符即隔离
const OBJECT_DATASETS = new Set(['meta', 'settings', 'notify']);

class Store {
  constructor(ctx) {
    this.ctx = ctx;          // DurableObjectState
    this.cache = new Map();
    this.warnings = [];
    this._quarantined = new Set();
    this._pending = [];      // storage.put/delete 的 Promise（写队列，flush 统一收敛）
    this._warmed = false;
  }

  _key(name) { return 'ds:' + name; }

  /** 冷启动预热：await 拉全部已知数据集进缓存（含类型校验 + 坏值隔离）。
   *  必须在 routes.init/任何业务读之前完成（do.js 在 blockConcurrencyWhile 内调用）。
   *  幂等：重复调用直接返回。 */
  async warmup() {
    if (this._warmed) return;
    for (const name of DATASETS) {
      const raw = await this.ctx.storage.get(this._key(name));
      if (raw === undefined) continue; // 首次使用未初始化：留给首次 read 走默认值并缓存
      const typeOk = OBJECT_DATASETS.has(name)
        ? (raw !== null && typeof raw === 'object' && !Array.isArray(raw))
        : Array.isArray(raw);
      if (typeOk) { this.cache.set(name, raw); continue; }
      const expect = OBJECT_DATASETS.has(name) ? '对象' : '数组';
      await this._quarantine(name, '内容不是' + expect + '（实际为 ' + (raw === null ? 'null' : typeof raw) + '）', raw);
    }
    this._warmed = true;
  }

  /** 同步读：仅操作缓存（warmup 后必命中；未预热场景回退默认值，不触持久层） */
  read(name, fallback) {
    if (this.cache.has(name)) return this.cache.get(name);
    this.cache.set(name, fallback);
    return fallback;
  }

  readArray(name) {
    const cached = this.cache.get(name);
    if (Array.isArray(cached)) return cached;
    const v = this.read(name, []);
    if (Array.isArray(v)) return v;
    const kind = v === null ? 'null' : (Array.isArray(v) ? 'array' : typeof v);
    // 防御分支（warmup 后正常不可达）：坏值只污染内存缓存时，就地去掉并告警
    this._quarantine(name, '内容不是数组（实际为 ' + kind + '）');
    this.cache.set(name, []);
    return [];
  }

  readObject(name, fallback) {
    const v = this.read(name, fallback);
    const isPlain = v !== null && typeof v === 'object' && !Array.isArray(v);
    if (isPlain || v === fallback) return v;
    this.cache.set(name, fallback);
    return fallback;
  }

  /** 同步写：缓存即时生效，持久化入队（put 失败经 flush 在请求层抛出 → 500） */
  write(name, data) {
    this.cache.set(name, data);
    this._pending.push(this.ctx.storage.put(this._key(name), data));
  }

  /** 请求收尾：等待本请求排队的全部落盘写完成；任一失败即抛出（由 do.js 捕获返回 500）。
   *  DO 串行语义下无并发请求交叉，flush 后队列必空。 */
  async flush() {
    const pending = this._pending.splice(0);
    await Promise.all(pending);
  }

  /** 隔离坏值：挪到 bad:* 备份 key（异步入队），主数据回退默认值，用户数据可抢救。
   *  raw 提供时（warmup 路径）落备份；未提供（内存防御路径）仅告警。 */
  async _quarantine(name, reason, raw) {
    if (this._quarantined.has(name)) return;
    this._quarantined.add(name);
    if (raw !== undefined) {
      const dst = 'bad:' + name + ':' + Date.now();
      try {
        this._pending.push(this.ctx.storage.put(dst, raw));
        this.warnings.push(name + ' 数据类型异常（' + reason + '），已隔离为 ' + dst + '，本次以空数据继续');
      } catch (e) { /* 隔离失败不阻断启动 */ }
    }
    this.warnings.push(name + ' ' + reason + '，本次以空数据继续');
  }
}

module.exports = { Store };
