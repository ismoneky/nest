/**
 * 北京时间的日期字符串（`YYYY-MM-DD`）
 *
 * ── 为什么不能直接用 `new Date().toISOString().substring(0,10)` ────────────
 * 那取的是 **UTC** 日期。服务器跑 UTC 时，北京时间 08:00 之前的请求会被算成「昨天」，
 * 于是过期扫描、每日免费名额、当日核销提醒全部会在每天凌晨错位 8 小时。
 *
 * ── 为什么不用 `toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })` ──
 * ICU 在小程序/精简版 Node 上可能不带完整时区库，行为不可控；而中国自 1991 年起
 * 不再实行夏令时，UTC+8 是**恒定偏移**，直接加 8 小时再取 ISO 前缀是最稳的写法。
 * 这个前提写在这里，是为了将来有人想「顺手改成 toLocaleDateString」时知道为什么别改。
 *
 * @param now 基准时刻，默认当前。显式传入是为了让调用方在同一个批次里取到同一个「今天」，
 *            也便于测试注入固定时刻。
 */
export function beijingDateStr(now: Date = new Date()): string {
    const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    return beijing.toISOString().substring(0, 10);
}

// 注：原 `beijingDayStartMs`（北京当天 00:00 的毫秒 epoch）已随站内信「每用户每日 5 条」
// 配额的移除而删除（2026-09-15）——它当时只有一个调用方：那条配额统计。
// 将来若要做「按北京日聚合」，按 `beijingDateStr` 的同一手法重建即可：
// 先把时刻加 8 小时，用 UTC 分量取日期，再减回 8 小时得到 epoch。
