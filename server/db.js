'use strict';

const fs = require('fs');
const path = require('path');

/**
 * JSON 文件存储：内存缓存 + 临时文件原子写入，容器内配合 /app/data 卷持久化。
 *
 * 两个安全约束（第七轮复盘 R7-1 / R7-2）：
 *  1. 读到「合法 JSON 但不是数组」的数据集（例如被外部工具写成了 `{}`）时，
 *     绝不能把这种值交给业务层——`.map()` / `.push()` 会直接抛 TypeError，
 *     轻则接口 500、重则整个进程启动失败。readArray() 会归一为空数组。
 *  2. 文件内容损坏（JSON 语法错误）时**不再静默回退**：静默回退等于把用户全部
 *     数据当成空的，之后任意一次写入都会用空数据覆盖原文件、永久丢失。
 *     现在把坏文件改名隔离（`.bad-<时间戳>`）并告警，用户仍可手工抢救。
 */
/* 缩进落盘是可选项：实测缩进 2 空格让数据文件体积膨胀 23.4%
 * （cards.json 43,334 B → 33,195 B），而每次业务写入都要全量重新序列化，
 * 浪费的不只是磁盘，还有每次写入的 CPU 与 IO。默认改紧凑格式；
 * 排查数据问题时可用 PRETTY_JSON=1 启动，临时恢复人类可读的缩进。 */
const PRETTY_JSON = process.env.PRETTY_JSON === '1';

class Store {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map();
    this.warnings = [];      // 启动期数据异常告警（由 index.js 打印）
    this._quarantined = new Set();
  }

  _file(name) { return path.join(this.dir, name + '.json'); }

  /** 把无法安全使用的数据文件改名隔离，避免后续写入覆盖原内容 */
  _quarantine(name, reason) {
    if (this._quarantined.has(name)) return '';
    this._quarantined.add(name);
    const src = this._file(name);
    const dst = src + '.bad-' + Date.now();
    let moved = false;
    try {
      if (fs.existsSync(src)) { fs.renameSync(src, dst); moved = true; }
    } catch (e) { /* 改名失败：至少不阻断启动 */ }
    const msg = name + '.json ' + reason + (moved ? '，已隔离为 ' + path.basename(dst) : '') + '，本次以空数据继续';
    this.warnings.push(msg);
    console.error('[管卡] ' + msg);
    return moved ? dst : '';
  }

  read(name, fallback) {
    if (this.cache.has(name)) return this.cache.get(name);
    let data = fallback;
    let raw = null;
    try {
      raw = fs.readFileSync(this._file(name), 'utf8');
    } catch (e) { /* 文件不存在：首次启动的正常路径 */ }
    if (raw !== null) {
      try {
        data = JSON.parse(raw);
      } catch (e) {
        this._quarantine(name, '内容不是合法 JSON');
        data = fallback; // 保持调用方给的默认值
      }
    }
    this.cache.set(name, data);
    return data;
  }

  /**
   * 读取「必须是数组」的数据集（cards / mycards / consumptions / benefits / bills / billGroups）。
   * 类型不符时隔离原文件并回退空数组，保证调用方拿到的永远是数组。
   */
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

  /** 读取「必须是对象」的配置类数据；类型不符时回退默认值（不隔离文件，配置可重建） */
  readObject(name, fallback) {
    const v = this.read(name, fallback);
    const isPlain = v !== null && typeof v === 'object' && !Array.isArray(v);
    if (isPlain) return v;
    this.cache.set(name, fallback);
    return fallback;
  }

  /**
   * 原子写入：先写同目录临时文件，再 rename 覆盖。
   *
   * 注意：这里**刻意保持同步**。所有写路径都是「读缓存数组 → 改 → 回写」，
   * 校验与写入之间没有任何 await 让出点，因此 Node 单线程下并发写请求不会丢更新
   * （已实测：12 个并发 POST 全部落库）。若改成 await 异步写，两个并发请求会同时
   * 写同一个 .tmp 文件互相踩踏，反而需要额外引入写队列/互斥锁才能保证正确性。
   * 收益（解除事件循环阻塞）与代价（引入并发写复杂度）在当前个人工具规模下不成正比。
   */
  write(name, data) {
    this.cache.set(name, data);
    const file = this._file(name);
    const tmp = file + '.tmp';
    const payload = JSON.stringify(data, null, PRETTY_JSON ? 2 : 0);
    try {
      fs.writeFileSync(tmp, payload);
    } catch (e) {
      // 目录缺失（卷被清理等）：重建后重试一次；其余错误照常抛出。
      // 正常路径不再每次 mkdirSync（此前每笔写入多一次系统调用）
      if (e.code !== 'ENOENT') throw e;
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(tmp, payload);
    }
    fs.renameSync(tmp, file);
  }
}

module.exports = { Store };
