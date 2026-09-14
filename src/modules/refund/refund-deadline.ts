import { beijingDateStr } from '../../common/date-utils';

/**
 * 退款申请截止时刻的**唯一**计算式（纯函数，无 IO、无 DI）
 *
 * ── 为什么单独成文件 ──────────────────────────────────────────────────────
 * 这个公式有**三个**调用方，分属两个模块：
 *   1. `RefundApplyService.buildRefundEntry`——订单详情下发 `applyDeadline`；
 *   2. `RefundApplyService.assertCanApply`——提交申请时的硬性拦截；
 *   3. `BookingService`（T1 ② / T2 ②）——组装「订单已过期，可申请退款」的文案。
 *
 * 第 3 个调用方是它必须抽出来的原因：`BookingService` **不能**注入
 * `RefundApplyService`（见该类构造函数的模块环说明），若公式留在服务里，
 * T1/T2 就只能把 `expiredAt + 7 天` 再抄一遍——两处各自演化，
 * 迟早出现「站内信说 10 月 1 日截止、点进去接口说已超期」。
 *
 * 时限天数由调用方从 `SystemConfigService.getRefundApplyDeadlineDays()` 取，
 * **不要**在这里读环境变量：那样等于又开了一个配置入口，
 * 而该 getter 的注释明确要求三处同源。
 *
 * 基准是 `expiredAt`（T1 翻转时刻）而**不是** `bookingDate`——见 §4.3.2。
 * 历史回刷数据的 `expiredAt` 是回刷当天，退款窗口从回刷日起算，
 * 这一点必须在运营话术里明确。
 */

/**
 * 申请截止时刻（epoch ms）
 *
 * `expiredAt` 为空（理论上不会：过期单必有 expiredAt）时返回 **null**，
 * 调用方**必须据此 fail-closed**（拒绝申请 / 不显示入口），而不是把 null 当成
 * 「没有时限」放行——那等于把「数据缺失」翻译成「永久可退」，与 §4.3.5
 * 「7 天是硬性上限」直接冲突。
 * 两处调用点（`resolveEntryReason` 的 DEADLINE_UNAVAILABLE、`assertCanApply`
 * 的 REFUND_DEADLINE_UNAVAILABLE）都按这个约定处理，且各有独立原因码。
 */
export function resolveApplyDeadlineMs(
    expiredAt: Date | null | undefined,
    deadlineDays: number,
): number | null {
    if (!expiredAt) return null;
    return new Date(expiredAt).getTime() + deadlineDays * 24 * 60 * 60 * 1000;
}

/**
 * 申请截止**日**（北京日期字符串 `YYYY-MM-DD`），站内信文案用
 *
 * 与 `resolveApplyDeadlineMs` 分开导出而不是让调用方自己格式化：
 * 截止时刻是「当天 23:59 前后皆可」的连续量，而文案只到日。
 * 统一走北京日（`beijingDateStr`）——服务器跑 UTC 时用
 * `toISOString().substring(0,10)` 会把 10 月 1 日写成 9 月 30 日，
 * 用户按站内信里的日期卡点来申请就会差一天。
 */
export function resolveApplyDeadlineStr(
    expiredAt: Date | null | undefined,
    deadlineDays: number,
): string | null {
    const ms = resolveApplyDeadlineMs(expiredAt, deadlineDays);
    return ms == null ? null : beijingDateStr(new Date(ms));
}
