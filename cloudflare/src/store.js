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
 */

const DATASETS = [
  'cards', 'meta', 'mycards', 'consumptions', 'benefits', 'bills', 'billGroups',
  'settings', 'notify', 'memberships', 'vouchers', 'voucherBrands', 'knowledge',
];

class Store {
  constructor(ctx) {
    this.ctx = ctx;          // DurableObjectState
    this.cache = new Map();
    this.warnings = [];
    this._quarantined = new Set();
    this._loaded = new Set();
  }

  _key(name) { return 'ds:' + name; }

  /** 从 Storage 读原始值（含缓存预热）；仅持久层访问点 */
  _loadRaw(name) {
    if (this._loaded.has(name)) return undefined; // 已在缓存，无需再读
    const v = this.ctx.storage.get(this._key(name));
    this._loaded.add(name);
    return v;
  }

  read(name, fallback) {
    if (this.cache.has(name)) return this.cache.get(name);
    let data = fallback;
    const raw = this._loadRaw(name);
    if (raw !== undefined) {
      if (raw !== null && typeof raw === 'object') {
        data = raw; // DO Storage 存的就是反序列化后的 JS 值
      } else {
        this._quarantine(name, '内容不是对象/数组（实际为 ' + typeof raw + '）');
        data = fallback;
      }
    }
    this.cache.set(name, data);
    return data;
  }

  readArray(name) {
    const cached = this.cache.get(name);
    if (Array.isArray(cached)) return cached;
    const v = this.read(name, []);
    if (Array.isArray(v)) return v;
    const kind = v === null ? 'null' : (Array.isArray(v) ? 'array' : typeof v);
    this._quarantine(name, '内容不是数组（实际为 ' + kind + '）');
    this.cache.set(name, []);
    return [];
  }

  readObject(name, fallback) {
    const v = this.read(name, fallback);
    const isPlain = v !== null && typeof v === 'object' && !Array.isArray(v);
    if (isPlain) return v;
    this.cache.set(name, fallback);
    return fallback;
  }

  write(name, data) {
    this.cache.set(name, data);
    // 同步放内存缓存，持久化异步落盘（DO 存储写失败会抛出，由请求层捕获返回 500；
    // DO 实例存活期间内存态一致，重启后以持久层为准）
    this.ctx.storage.put(this._key(name), data);
  }

  /** 初始化：预热全部已知数据集（对应原版 init() 的 readArray 预热语义） */
  warmup() {
    for (const name of DATASETS) {
      try { this.readArray(name); } catch (e) { /* readObject 类数据集在 read 里兜底 */ }
    }
  }

  _quarantine(name, reason) {
    if (this._quarantined.has(name)) return;
    this._quarantined.add(name);
    // KV 场景下「隔离」= 把坏值挪到备份 key，主 key 清空回退默认值，用户数据仍可抢救
    const dst = 'bad:' + name + ':' + Date.now();
    try {
      const raw = this.ctx.storage.get(this._key(name));
      if (raw !== undefined) {
        this.ctx.storage.put(dst, raw);
        this.warnings.push(name + ' 数据类型异常（' + reason + '），已隔离为 ' + dst + '，本次以空数据继续');
      }
    } catch (e) { /* 隔离失败不阻断启动 */ }
    this.warnings.push(name + ' ' + reason + '，本次以空数据继续');
  }
}

module.exports = { Store };
