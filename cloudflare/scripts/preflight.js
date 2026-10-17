'use strict';

/* 部署前自检：构建产物存在 + 冒烟测试通过 + 关键配置就位。
 * 用法：node scripts/preflight.js（wrangler deploy 前自动跑）
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname + '/..';
let fail = 0;
function ok(cond, name) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + name);
  if (!cond) fail++;
}

console.log('[preflight] 部署前自检');
ok(fs.existsSync(ROOT + '/wrangler.toml'), 'wrangler.toml 存在');
ok(/AUTH_TOKEN/.test(fs.readFileSync(ROOT + '/wrangler.toml', 'utf8')), 'wrangler.toml 已声明鉴权（secret put AUTH_TOKEN 由部署者执行）');

// 构建产物（vendor + public 拷贝）
if (!fs.existsSync(ROOT + '/vendored/routes.js')) {
  console.log('  · 构建产物缺失，执行 npm run build ...');
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
}
ok(fs.existsSync(ROOT + '/vendored/routes.js'), 'vendored 业务层已构建');
ok(fs.existsSync(ROOT + '/public/index.html'), 'public 前端已拷贝');

// 冒烟测试
const out = execSync('node test/smoke.js', { cwd: ROOT, encoding: 'utf8' });
const m = out.match(/冒烟结果: (\d+) 通过 \/ (\d+) 失败/);
ok(m && m[2] === '0', '冒烟测试 ' + (m ? m[1] + ' 通过 / ' + m[2] + ' 失败' : '(无法解析输出)'));

if (fail) { console.log('[preflight] 未通过，终止部署'); process.exit(1); }
console.log('[preflight] 全部通过，可以 deploy');
