/**
 * 让整个 jest 套件跑在 UTC 下（最坏时区）。
 *
 * 为什么需要：`bookings.bookingDate` 是 `type:'date'`、存纯 `'YYYY-MM-DD'`，
 * 而 TypeORM 对 `where` 里的 `Date` 参数绑定的是 **UTC 分量**的 `'YYYY-MM-DD HH:mm:ss.SSS'`。
 * 字符串比较下 `'2026-09-13' < '2026-09-13 00:00:00.000'` 为真，于是「bookingDate < 今天」
 * 会退化成「≤ 今天」——**开发机是 UTC+8 时边界碰巧落在昨天、测试全绿，UTC 服务器上却会把
 * 当天的订单也置为 expired**（2026-09-13 在 T1 过期扫描上实测到）。详见
 * docs/implementation-todo.md 说明 23。
 *
 * 所以测试必须在一个非 UTC+8 的时区里跑，否则这一类缺陷只在生产暴露。
 *
 * 为什么放 globalSetup 而不是某个 spec 的 beforeAll：jest 的 node 测试环境会**复制**
 * `process.env` 给沙箱，在 spec 里改 `process.env.TZ` 影响不到 Node 原生的时区解析
 * （已实测：`booking-expire.spec.ts` 里加自证断言会失败）。globalSetup 跑在父进程、
 * 早于 worker 派生，TZ 会被 worker 继承，因此对全部 spec 生效。
 *
 * 注意：本仓其余 spec 的日期构造都与时区无关（纯日期字符串、显式 Z 的 ISO 串、
 * 或 beijingDateStr()），换时区不应改变它们的结果——若某个 spec 因此变红，
 * 那说明它本身有时区依赖，属于真实缺陷而非本文件的问题。
 */
module.exports = () => {
    process.env.TZ = 'UTC';
};
