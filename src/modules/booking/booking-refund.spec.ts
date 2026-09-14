import { BadRequestException } from '@nestjs/common';
import { BookingService } from './booking.service';
import { BookingStatus, PaymentStatus, RefundStatus } from '../../entities/booking.entity';

/**
 * 用户自助退款契约与退款对账 NOT_EXIST 复查测试。
 *
 * - P0-2 契约：fctl 一期不改，小程序按 HTTP 状态/success 判断退款成败，
 *   initiateRefund 对非 accepted 结果必须抛 400，不能包成 200 success。
 * - NOT_EXIST 延迟复查（设计 2.6）：第一次查无打标记 5 分钟后复查，
 *   复查仍无才判 FAILED，避免微信建单传播延迟误判。
 */
describe('BookingService 退款契约与对账', () => {
    const now = Date.now();
    const baseBooking = {
        bookingId: 'BK-CONTRACT-1',
        wechatOpenId: 'o-user-1',
        bookingDate: '2026-08-20',
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        refundStatus: RefundStatus.NONE,
        isFree: false,
        amount: 5000,
        outTradeNo: 'OT-CONTRACT-1',
        outRefundNo: null,
        paidAt: new Date(now - 24 * 60 * 60 * 1000),
    };

    function makeService(repoOverrides: Record<string, jest.Mock>, refundResult?: any) {
        const bookingRepository = {
            getBookingById: jest.fn(),
            markRefundStarting: jest.fn(),
            markRefundFailed: jest.fn(),
            markRefundNotExistPending: jest.fn(),
            markRefundSucceeded: jest.fn(),
            resolveAnomaly: jest.fn(),
            rescheduleRefundCheck: jest.fn(),
            ...repoOverrides,
        };
        const wechatPayService = { refund: jest.fn().mockResolvedValue(refundResult) };
        const loggingService = { write: jest.fn() };
        const service = new BookingService(
            bookingRepository as any,
            wechatPayService as any,
            null, null, null, null, null,
            loggingService as any,
        );
        return { service, bookingRepository, wechatPayService };
    }

    describe('initiateRefund（P0-2 契约）', () => {
        function setupAcceptedPath(repoOverrides: Record<string, jest.Mock> = {}) {
            const repo = {
                getBookingById: jest.fn().mockResolvedValue({ ...baseBooking }),
                markRefundStarting: jest.fn().mockResolvedValue(1),
                ...repoOverrides,
            };
            return repo;
        }

        it('accepted → 正常返回（200 success 契约）', async () => {
            const { service } = makeService(setupAcceptedPath(), { state: 'accepted', refundStatus: 'PROCESSING' });
            const result = await service.initiateRefund('BK-CONTRACT-1', 'o-user-1');
            expect(result.state).toBe('accepted');
        });

        it('rejected → 抛 400（微信明确拒绝不能包成 success）', async () => {
            const { service } = makeService(setupAcceptedPath(), { state: 'rejected', code: 'NOT_ENOUGH', message: '余额不足' });
            await expect(service.initiateRefund('BK-CONTRACT-1', 'o-user-1')).rejects.toThrow(BadRequestException);
            await expect(service.initiateRefund('BK-CONTRACT-1', 'o-user-1')).rejects.toThrow(/申请退款失败/);
        });

        it('unknown → 抛 400（超时/断连不能包成 success）', async () => {
            const { service } = makeService(setupAcceptedPath(), { state: 'unknown', code: 'PAYMENT_PREPARATION_TIMEOUT', message: '超时' });
            await expect(service.initiateRefund('BK-CONTRACT-1', 'o-user-1')).rejects.toThrow(BadRequestException);
        });
    });

    describe('applyRefundReconcileResult NOT_EXIST 延迟复查（设计 2.6）', () => {
        it('第一次 NOT_EXIST → 打标记 5 分钟后复查，不判失败', async () => {
            const { service, bookingRepository } = makeService({});
            const booking = { ...baseBooking, refundStatus: RefundStatus.REFUNDING, outRefundNo: 'RFBK-1', reconcileLastErrorCode: null };

            await (service as any).applyRefundReconcileResult(booking, { state: 'NOT_EXIST' });

            expect(bookingRepository.markRefundNotExistPending).toHaveBeenCalledTimes(1);
            const [, , nextAt] = bookingRepository.markRefundNotExistPending.mock.calls[0];
            expect(nextAt).toBeGreaterThan(Date.now() + 4 * 60 * 1000);
            expect(nextAt).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 1000);
            expect(bookingRepository.markRefundFailed).not.toHaveBeenCalled();
        });

        it('复查仍 NOT_EXIST（已有标记）→ 判 FAILED', async () => {
            const { service, bookingRepository } = makeService({});
            const booking = { ...baseBooking, refundStatus: RefundStatus.REFUNDING, outRefundNo: 'RFBK-1', reconcileLastErrorCode: 'REFUND_NOT_EXIST' };

            await (service as any).applyRefundReconcileResult(booking, { state: 'NOT_EXIST' });

            expect(bookingRepository.markRefundFailed).toHaveBeenCalledTimes(1);
            expect(bookingRepository.markRefundNotExistPending).not.toHaveBeenCalled();
        });

        it('PROCESSING → 15 分钟后复查（清标记，NOT_EXIST 计数重新开始）', async () => {
            const { service, bookingRepository } = makeService({});
            const booking = { ...baseBooking, refundStatus: RefundStatus.REFUNDING, outRefundNo: 'RFBK-1', reconcileLastErrorCode: 'REFUND_NOT_EXIST' };

            await (service as any).applyRefundReconcileResult(booking, { state: 'PROCESSING' });

            expect(bookingRepository.rescheduleRefundCheck).toHaveBeenCalledTimes(1);
            expect(bookingRepository.markRefundFailed).not.toHaveBeenCalled();
        });
    });
});
