import {
    classifyAdminRefundEligibility,
    applyAdminRefundableConditions,
    REFUND_VALIDITY_MS,
} from './refund-eligibility';
import {
    Booking,
    BookingStatus,
    PaymentStatus,
    RefundStatus,
} from '../../entities/booking.entity';

/**
 * 管理员退款资格模块测试（选择性批量退款设计 1.4 / 2.2）
 * 重点：管理员版不看业务状态（已核验/已取消可退），仅资金硬约束；
 * classifyAdminRefundEligibility 的 refundable 语义与
 * applyAdminRefundableConditions 的 SQL 条件一致（分桶口径不漂移）。
 */
describe('refund-eligibility（管理员版）', () => {
    const now = Date.now();

    function makeBooking(overrides: Partial<Booking>): Booking {
        return {
            status: BookingStatus.CONFIRMED,
            paymentStatus: PaymentStatus.PAID,
            refundStatus: RefundStatus.NONE,
            isFree: false,
            amount: 5000,
            outTradeNo: 'OT123',
            paidAt: new Date(now - 24 * 60 * 60 * 1000), // 昨天
            ...overrides,
        } as Booking;
    }

    describe('classifyAdminRefundEligibility', () => {
        it('正常已支付订单 → refundable', () => {
            expect(classifyAdminRefundEligibility(makeBooking({}), now)).toBe('refundable');
        });

        it('refundStatus FAILED 仍可退', () => {
            expect(classifyAdminRefundEligibility(makeBooking({ refundStatus: RefundStatus.FAILED }), now)).toBe('refundable');
        });

        it('已完成核验 → refundable（管理员版不看业务状态）', () => {
            expect(classifyAdminRefundEligibility(makeBooking({ status: BookingStatus.COMPLETED }), now)).toBe('refundable');
        });

        it('已取消但已支付 → refundable（管理员版不看业务状态）', () => {
            expect(classifyAdminRefundEligibility(makeBooking({ status: BookingStatus.CANCELLED }), now)).toBe('refundable');
        });

        it('退款处理中 → refunding（优先于未支付：在途退款先归类）', () => {
            expect(classifyAdminRefundEligibility(makeBooking({ refundStatus: RefundStatus.REFUNDING }), now)).toBe('refunding');
        });

        it('已退款 → refunded（paymentStatus=REFUNDED 也不能误判为未支付）', () => {
            expect(
                classifyAdminRefundEligibility(
                    makeBooking({ refundStatus: RefundStatus.REFUNDED, paymentStatus: PaymentStatus.REFUNDED }),
                    now,
                ),
            ).toBe('refunded');
        });

        it('未支付 → unpaid', () => {
            expect(classifyAdminRefundEligibility(makeBooking({ paymentStatus: PaymentStatus.UNPAID }), now)).toBe('unpaid');
        });

        it('支付中 → unpaid', () => {
            expect(classifyAdminRefundEligibility(makeBooking({ paymentStatus: PaymentStatus.PAYING }), now)).toBe('unpaid');
        });

        it('免费单 → free', () => {
            expect(classifyAdminRefundEligibility(makeBooking({ isFree: true }), now)).toBe('free');
        });

        it('金额为 0 → free', () => {
            expect(classifyAdminRefundEligibility(makeBooking({ amount: 0 }), now)).toBe('free');
        });

        it('缺少 outTradeNo → invalid_data', () => {
            expect(classifyAdminRefundEligibility(makeBooking({ outTradeNo: null as any }), now)).toBe('invalid_data');
        });

        it('缺少 paidAt → invalid_data（无法判超期）', () => {
            expect(classifyAdminRefundEligibility(makeBooking({ paidAt: null as any }), now)).toBe('invalid_data');
        });

        it('负金额 → invalid_data', () => {
            expect(classifyAdminRefundEligibility(makeBooking({ amount: -1 }), now)).toBe('invalid_data');
        });

        it('refundStatus 意外取值 → invalid_data（与 SQL IN 条件一致排除）', () => {
            expect(classifyAdminRefundEligibility(makeBooking({ refundStatus: 'weird' as any }), now)).toBe('invalid_data');
        });

        it('支付超过一年 → expired', () => {
            expect(classifyAdminRefundEligibility(makeBooking({ paidAt: new Date(now - REFUND_VALIDITY_MS - 1000) }), now)).toBe('expired');
        });

        it('恰好未到一年 → refundable（边界）', () => {
            expect(classifyAdminRefundEligibility(makeBooking({ paidAt: new Date(now - REFUND_VALIDITY_MS + 60 * 1000) }), now)).toBe('refundable');
        });
    });

    describe('applyAdminRefundableConditions 与 classify 的一致性', () => {
        it('追加的 SQL 条件覆盖 refundable 判定的全部维度，且不含业务状态/日期条件', () => {
            // 断言 SQL 字符串与 refundable 分支一一对应，
            // 防止后续只改一处造成预览与执行条件漂移。
            const conditions: string[] = [];
            const qb = {
                andWhere: (condition: string) => {
                    conditions.push(condition);
                    return qb;
                },
            };
            applyAdminRefundableConditions(qb as any, 'booking', now);

            expect(conditions).toContain('booking.paymentStatus = :paidStatus');
            expect(conditions).toContain('booking.refundStatus IN (:...refundStatuses)');
            expect(conditions).toContain('booking.isFree = :notFree');
            expect(conditions).toContain('booking.amount > 0');
            expect(conditions).toContain('booking.outTradeNo IS NOT NULL');
            expect(conditions).toContain('booking.paidAt IS NOT NULL');
            expect(conditions).toContain('booking.paidAt > :refundCutoff');
            // 管理员版明确不含业务状态与预约日期条件
            expect(conditions.some((c) => c.includes('status =') && !c.includes('paymentStatus') && !c.includes('refundStatus'))).toBe(false);
            expect(conditions.some((c) => c.includes('bookingDate'))).toBe(false);
        });

        it('alias 为空时输出裸列名（SQLite UPDATE 不支持别名）', () => {
            const conditions: string[] = [];
            const qb = {
                andWhere: (condition: string) => {
                    conditions.push(condition);
                    return qb;
                },
            };
            applyAdminRefundableConditions(qb as any, '', now);
            expect(conditions).toContain('paymentStatus = :paidStatus');
            expect(conditions.every((c) => !c.startsWith('booking.'))).toBe(true);
        });
    });
});
