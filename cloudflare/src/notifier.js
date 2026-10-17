'use strict';

/* Cloudflare Workers 版推送通知层：适配 server/notifier.js。
 *
 * 差异点：
 * 1. dns.lookup（Node 内置）不可用 → 改用 Cloudflare DoH（1.1.1.1）解析后校验，
 *    SSRF 防护逻辑（isBlockedIp）与原版逐字节一致。
 * 2. fetch / AbortController / URLSearchParams 均为 Workers 原生支持，无需适配。
 * 3. process.env[name] → 由 worker 入口把 env 对象传入 endpoint()。
 */

const TIMEOUT_MS = 10000;
const DOH_URL = 'https://cloudflare-dns.com/dns-query?name=<HOST>&type=A';

function isBlockedIp(ip) {
  // IPv4：环回 / 私有 / 链路本地 / 0.0.0.0 / 保留段（与 server/notifier.js 完全一致）
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 0 || p[0] === 127 || p[0] === 10) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;  // CGNAT
    if (p[0] >= 224) return true;                                 // 组播/保留
    return false;
  }
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(low)) return true;   // fc00::/7 唯一本地
  if (/^fe[89ab][0-9a-f]:/.test(low)) return true;   // fe80::/10 链路本地
  const m = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return isBlockedIp(m[1]);
  return false;
}

/** Workers 版 DNS 解析：走 1.1.1.1 DoH 拿 A 记录（IP 字面量直接返回） */
async function resolveHost(host) {
  if (/^[\d.]+$/.test(host)) return [host];
  if (host.includes(':')) return [host.replace(/^\[|\]$/g, '')];
  try {
    const res = await fetch(DOH_URL.replace('<HOST>', encodeURIComponent(host)), {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
  } catch (e) { return []; }
}

/** 校验自建 Bark 服务器地址是否安全（语义与 server/notifier.js 一致） */
async function assertSafeBarkServer(raw) {
  const s = String(raw || '').trim();
  if (!s) return;
  let u;
  try { u = new URL(s); } catch (e) { throw new Error('Bark 服务器地址格式非法：' + s.slice(0, 60)); }
  if (u.protocol !== 'https:') throw new Error('Bark 服务器地址必须使用 https（当前：' + u.protocol + '）');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = await resolveHost(host);
  if (!addrs.length) throw new Error('Bark 服务器地址无法解析：' + host);
  for (const a of addrs) {
    if (isBlockedIp(a)) {
      throw new Error('Bark 服务器地址不允许指向内网/环回/链路本地地址（解析为 ' + a + '）');
    }
  }
}

/* 判定上游返回码（与 server/notifier.js verdict 一致） */
function verdict(r, expectedCode, label, msgField) {
  if (!r.data || typeof r.data !== 'object') {
    return { ok: false, error: label + '返回非 JSON 响应（HTTP 200）：' + String(r.raw || r.contentType || '').slice(0, 120) };
  }
  if (r.data.code === undefined || r.data.code === null) {
    return { ok: false, error: label + '响应缺少 code 字段：' + JSON.stringify(r.data).slice(0, 120) };
  }
  if (r.data.code !== expectedCode) {
    return { ok: false, error: label + '返回 ' + r.data.code + ': ' + ((msgField && r.data[msgField]) || '') };
  }
  return { ok: true, data: r.data };
}

function endpoint(env, name, fallback) { return env[name] || fallback; }

async function postJson(url, body, headers) {
  const res = await fetch(url, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, headers || {}),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* 非 JSON 响应 */ }
  if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ' ' + text.slice(0, 160) };
  return { ok: true, data, raw: text.slice(0, 200), contentType: res.headers.get('content-type') || '' };
}

async function postForm(url, form) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* ignore */ }
  if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + ' ' + text.slice(0, 160) };
  return { ok: true, data, raw: text.slice(0, 200), contentType: res.headers.get('content-type') || '' };
}

async function sendWxpusher(env, cfg, title, content) {
  const url = endpoint(env, 'NOTIFY_WXPUSHER_URL', 'https://wxpusher.zjiecode.com/api/send/message');
  const uids = String(cfg.uids || '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  const topicIds = String(cfg.topicIds || '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!cfg.appToken) return { ok: false, error: '缺少 appToken' };
  if (!uids.length && !topicIds.length) return { ok: false, error: '缺少 uids 或 topicIds' };
  const r = await postJson(url, {
    appToken: cfg.appToken, content, summary: String(cfg.summaryPrefix || '管卡提醒') + '｜' + title,
    contentType: 3, uids, topicIds, url: '',
  });
  if (!r.ok) return r;
  return verdict(r, 1000, 'wxpusher', 'msg');
}

function sctUrl(cfg) {
  const base = 'https://sctapi.ftqq.com';
  return base.replace(/\/$/, '') + '/' + encodeURIComponent(String(cfg.sendkey || '').trim()) + '.send';
}
async function sendServerChan(env, cfg, title, content) {
  if (!cfg.sendkey) return { ok: false, error: '缺少 SendKey' };
  const r = await postForm(sctUrl(cfg), { title: title.slice(0, 100), desp: content });
  if (!r.ok) return r;
  return verdict(r, 0, 'Server酱', 'message');
}

async function sendBark(env, cfg, title, content) {
  const override = env.NOTIFY_BARK_URL;
  if (!override) await assertSafeBarkServer(cfg.server);
  const base = (override || cfg.server || 'https://api.day.app').replace(/\/$/, '');
  if (!cfg.deviceKey) return { ok: false, error: '缺少 deviceKey' };
  const r = await postJson(base + '/push', {
    device_key: cfg.deviceKey, title: title.slice(0, 100), body: content,
    level: cfg.level || 'active', group: cfg.group || '管卡', isArchive: 1,
  });
  if (!r.ok) return r;
  return verdict(r, 200, 'Bark', 'message');
}

const CHANNELS = {
  wxpusher: { label: 'WxPusher', send: sendWxpusher },
  serverchan: { label: 'Server酱³', send: sendServerChan },
  bark: { label: 'Bark', send: sendBark },
};

/** 向所有已启用通道推送（env 首参，语义对齐 notifier.notifyAll） */
async function notifyAll(env, cfg, title, content) {
  const results = [];
  for (const key of Object.keys(CHANNELS)) {
    const ch = CHANNELS[key];
    const chCfg = (cfg && cfg.channels && cfg.channels[key]) || {};
    if (!chCfg.enabled) continue;
    try {
      const r = await ch.send(env, chCfg, title, content);
      results.push({ channel: key, label: ch.label, ok: !!r.ok, error: r.ok ? '' : (r.error || '发送失败') });
    } catch (e) {
      results.push({ channel: key, label: ch.label, ok: false, error: e && e.message ? e.message : String(e) });
    }
  }
  return results;
}

function enabledChannels(cfg) {
  return Object.keys(CHANNELS).filter((k) => cfg && cfg.channels && cfg.channels[k] && cfg.channels[k].enabled);
}

module.exports = { notifyAll, enabledChannels, CHANNELS, assertSafeBarkServer, isBlockedIp };
