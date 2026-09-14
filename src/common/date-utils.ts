/**
 * 北京时间的日期字符串（`YYYY-MM-DD`）
 *
 * ── 为什么不能直接用 `new Date().toISOString().substring(0,10)` ────────────
 * 那取的是 **UTC** 日期。服务器跑 UTC 时，北京时间 08:00 之前的请求会被算成「昨天」，
 * 于是过期扫描、每日免费名额、当日核销提醒、站内信每日上限全部会在每天凌晨错位 8 小时。
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

/**
 * 北京时间某一天的起点（本地时刻的毫秒 epoch）
 *
 * 用于「今天的消息条数」这类**按北京日切分**的统计。
 * 不用 `new Date('YYYY-MM-DD')`：那按进程本地时区解析，服务器跑 UTC 时会整体偏移 8 小时；
 * 这里显式按 UTC+8 反推回 epoch，与进程时区无关。
 */
export function beijingDayStartMs(now: Date = new Date()): number {
    const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const dayStartUtc = Date.UTC(
        beijing.getUTCFullYear(),
        beijing.getUTCMonth(),
        beijing.getUTCDate(),
    );
    // 减回 8 小时得到北京当天 00:00 对应的真实时刻
    return dayStartUtc - 8 * 60 * 60 * 1000;
}
