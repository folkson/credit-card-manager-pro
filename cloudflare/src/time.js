'use strict';

/* Workers 时区垫片。
 *
 * 原版业务层（dates/util/routes）大量依赖 `new Date()` 取「本地时区」的年月日
 * （toDateStr / cycleStart / nextFeeDate 等，语义=用户所在时区=北京时间）。
 * Workers 运行时一律 UTC，`new Date()` 在 UTC 00:00-08:00 之间会把「今天」算成昨天，
 * 导致还款提醒/月度统计/年费倒计时全部提前 8 小时切换——这是部署到 Workers 后
 * 最隐蔽的行为差异，必须处理。
 *
 * 方案：不做全局 Date 劫持（脆弱且有平台兼容风险），而是提供一个
 * 「北京时间锚定的 now()」，并打补丁让业务层调用点走它。业务层共 3 类取时点：
 *   1. routes.js handle() 入口 `const now = new Date()`
 *   2. routes.js 各 compute* 的 `now = now || new Date()`
 *   3. util.js todayStr() / clampFeeDate()
 * 这些调用全部「无参使用当前时刻」。因此统一在打包层把 `new Date()` 的
 * 无参调用替换为 `NOW()`（见 build 脚本），NOW() 按 UTC+8 计算并返回一个
 * 「时钟拨快 8 小时的 Date」——其 getFullYear/getMonth/getDate 等**本地分量**
 * 恰好等于北京时间的年月日；getTime() 偏移 8h 只影响 toISOString 展示
 * （仅用于日志/导出时间戳，偏移无业务危害，且原版 Docker 用户也多在 +8 时区）。
 */

const TZ_OFFSET_MS = 8 * 3600 * 1000; // Asia/Shanghai（无夏令时）

/** 北京时间锚定的当前时刻：本地分量 = 北京时间的年月日时分秒 */
function nowBJ() {
  return new Date(Date.now() + TZ_OFFSET_MS);
}

module.exports = { nowBJ, TZ_OFFSET_MS };
