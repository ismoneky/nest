import { Booking, PaymentStatus, RefundStatus } from '../../entities/booking.entity';

/**
 * 管理员退款资格模块（选择性批量退款设计 1.4 / 2.2）
 *
 * 管理员版不看业务状态：已核验（COMPLETED）/已取消（CANCELLED）订单只要满足
 * 资金硬约束即可退。用户自助退款规则（initiateRefund 内联校验）是另一套，不复用本模块。
 *
 * 预览分桶（classifyAdminRefundEligibility）与执行冻结（applyAdminRefundableConditions）
 * 必须同源：SQL 条件与 JS 分类的 refundable 语义一致，
 * 一致性由 refund-eligibility.spec.ts 对照测试保证。
 */

/**
 * 退款有效期：支付后一年（微信侧限制，管理员无法突破；
 * 按 365 天毫秒数比较，预览/执行两侧完全一致）
 */
export const REFUND_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * 管理员退款资格分桶（互斥；按判定顺序取第一个命中的桶）
 */
export type RefundBucket =
    | 'refundable' // 可退
    | 'refunding' // 退款处理中（已有一笔在途退款）
    | 'refunded' // 已退款
    | 'unpaid' // 未支付
    | 'free' // 免费单或金额为 0
    | 'invalid_data' // 数据异常：缺 outTradeNo/paidAt 或金额非法
    | 'expired'; // 支付时间超过退款有效期

/** 分桶展示标签（预览接口透传给管理端） */
export const REFUND_BUCKET_LABELS: Record<Exclude<RefundBucket, 'refundable'>, string> = {
    refunding: '退款处理中',
    refunded: '已退款',
    unpaid: '未支付',
    free: '免费单或金额为 0',
    invalid_data: '数据异常',
    expired: '超过退款有效期',
};

/** 预览分桶使用的最小字段集 */
export type RefundEligibilityBooking = Pick<
    Booking,
    'paymentStatus' | 'refundStatus' | 'isFree' | 'amount' | 'outTradeNo' | 'paidAt'
>;

/**
 * 单笔订单管理员退款资格分桶（预览用）
 *
 * 判定顺序即分桶优先级：一单只进一个桶。
 * 在途/已退优先于未支付：退款成功后 paymentStatus=REFUNDED，
 * 若先判 paymentStatus 会把"已退款"误标为"未支付"。
 * refundable 语义必须与 applyAdminRefundableConditions 的 SQL 条件完全一致。
 */
export function classifyAdminRefundEligibility(booking: RefundEligibilityBooking, now: number): RefundBucket {
    if (booking.refundStatus === RefundStatus.REFUNDING) return 'refunding';
    if (booking.refundStatus === RefundStatus.REFUNDED) return 'refunded';
    if (booking.paymentStatus !== PaymentStatus.PAID) return 'unpaid';
    if (booking.isFree || booking.amount === 0) return 'free';
    // 金额/字段完整性：paidAt 为空无法判超期，先判数据异常
    if (booking.amount == null || booking.amount < 0 || booking.paidAt == null || !booking.outTradeNo) {
        return 'invalid_data';
    }
    if (booking.paidAt.getTime() <= now - REFUND_VALIDITY_MS) return 'expired';
    // 正常剩余情况 refundStatus ∈ (NONE, FAILED) → 可退；
    // 防御：意外取值按数据异常排除，与 SQL 的 IN 条件保持一致（SQL 也不会命中）
    if (booking.refundStatus === RefundStatus.NONE || booking.refundStatus === RefundStatus.FAILED) {
        return 'refundable';
    }
    return 'invalid_data';
}

/**
 * 给 QueryBuilder 追加管理员可退资金硬条件（执行冻结用）
 *
 * 条件与 classifyAdminRefundEligibility 的 refundable 分支一致：
 * PAID、refundStatus IN (NONE, FAILED)、非免费、amount > 0、
 * outTradeNo/paidAt 非空、未超退款有效期。不含业务状态条件。
 *
 * alias 传空字符串时输出裸列名：SQLite 的 UPDATE 不支持别名引用，
 * freezeBookingsForBatchRefund 的批量 UPDATE 必须用裸列名。
 */
export function applyAdminRefundableConditions(
    qb: { andWhere: (...args: any[]) => any },
    alias: string,
    now: number,
): void {
    const col = alias ? `${alias}.` : '';
    qb.andWhere(`${col}paymentStatus = :paidStatus`, { paidStatus: PaymentStatus.PAID })
        .andWhere(`${col}refundStatus IN (:...refundStatuses)`, {
            refundStatuses: [RefundStatus.NONE, RefundStatus.FAILED],
        })
        .andWhere(`${col}isFree = :notFree`, { notFree: false })
        .andWhere(`${col}amount > 0`)
        .andWhere(`${col}outTradeNo IS NOT NULL`)
        .andWhere(`${col}paidAt IS NOT NULL`)
        .andWhere(`${col}paidAt > :refundCutoff`, { refundCutoff: now - REFUND_VALIDITY_MS });
}
