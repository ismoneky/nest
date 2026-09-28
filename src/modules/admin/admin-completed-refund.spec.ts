import * as bcrypt from 'bcrypt';
import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    Booking,
    BookingStatus,
    PaymentStatus,
    RefundStatus,
    TimeSlot,
    TravelMode,
} from '../../entities/booking.entity';
import { BookingAnomaly } from '../../entities/booking-anomaly.entity';
import { RefundApply } from '../../entities/refund-apply.entity';
import { Message } from '../../entities/message.entity';
import { BookingRepository } from '../../repositories/booking.repository';
import { RefundApplyRepository } from '../../repositories/refund-apply.repository';
import { BookingService } from '../booking/booking.service';
import { AdminService } from './admin.service';

describe('管理员对已支付订单发起退款', () => {
    let adminService: AdminService;
    let bookingRawRepo: Repository<Booking>;
    let secondaryPasswordHash: string;

    const SECONDARY_PASSWORD = 'refund-only-2026';
    const loggingStub = { write: () => Promise.resolve() };
    const wechatPayStub = {
        refund: jest.fn().mockResolvedValue({ state: 'accepted', refundId: 'WX-REFUND-1' }),
    };

    beforeAll(async () => {
        secondaryPasswordHash = await bcrypt.hash(SECONDARY_PASSWORD, 4);
        process.env.ADMIN_REFUND_PASSWORD_HASH = secondaryPasswordHash;

        const moduleRef = await Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'sqlite',
                    database: ':memory:',
                    synchronize: true,
                    dropSchema: true,
                    entities: [Booking, BookingAnomaly, RefundApply, Message],
                }),
                TypeOrmModule.forFeature([Booking, BookingAnomaly, RefundApply, Message]),
            ],
            providers: [BookingRepository, RefundApplyRepository],
        }).compile();

        const bookingRepository = moduleRef.get(BookingRepository);
        const refundApplyRepository = moduleRef.get(RefundApplyRepository);
        bookingRawRepo = moduleRef.get(getRepositoryToken(Booking));

        const bookingService = new BookingService(
            bookingRepository,
            wechatPayStub as any,
            null as any,
            null as any,
            null as any,
            null as any,
            null as any,
            loggingStub as any,
            refundApplyRepository,
            null as any,
        );

        adminService = new AdminService(
            null as any,
            bookingService,
            null as any,
            null as any,
            loggingStub as any,
            null as any,
        );
    });

    afterAll(() => {
        delete process.env.ADMIN_REFUND_PASSWORD_HASH;
    });

    async function seedCompletedBooking(overrides: Partial<Booking> = {}): Promise<Booking> {
        const bookingId = `TL-ADMIN-REFUND-${Date.now()}-${Math.random()}`;
        return await bookingRawRepo.save(
            bookingRawRepo.create({
                bookingId,
                wechatOpenId: 'openid-admin-refund-test',
                name: '退款测试',
                phone: '13800000000',
                bookingDate: new Date(),
                timeSlot: TimeSlot.MORNING,
                travelMode: TravelMode.SELF_DRIVING,
                personCount: 1,
                remarks: '',
                isFree: false,
                status: BookingStatus.COMPLETED,
                paymentStatus: PaymentStatus.PAID,
                refundStatus: RefundStatus.NONE,
                amount: 6600,
                outTradeNo: `PAY-${bookingId}`,
                paidAt: new Date(),
                ...overrides,
            }),
        );
    }

    it('正确二级密码让已支付且已完成订单进入退款中', async () => {
        const booking = await seedCompletedBooking();

        await (adminService as any).refundBookingAsAdmin(
            booking.bookingId,
            SECONDARY_PASSWORD,
            { adminId: 1, adminName: '测试管理员' },
        );

        const updated = await bookingRawRepo.findOneOrFail({ where: { bookingId: booking.bookingId } });
        expect(updated.status).toBe(BookingStatus.COMPLETED);
        expect(updated.paymentStatus).toBe(PaymentStatus.PAID);
        expect(updated.refundStatus).toBe(RefundStatus.REFUNDING);
        expect(updated.reconcileKind).toBe('refund');
        expect(updated.outRefundNo).toBe(`RF${booking.bookingId}`);
    });

    it('二级密码错误时拒绝退款且订单状态不变', async () => {
        const booking = await seedCompletedBooking();

        await expect(
            (adminService as any).refundBookingAsAdmin(
                booking.bookingId,
                'wrong-secondary-password',
                { adminId: 1, adminName: '测试管理员' },
            ),
        ).rejects.toThrow('退款二级密码错误');

        const unchanged = await bookingRawRepo.findOneOrFail({ where: { bookingId: booking.bookingId } });
        expect(unchanged.refundStatus).toBe(RefundStatus.NONE);
        expect(unchanged.outRefundNo).toBeNull();
    });

    it('服务端未配置二级密码时拒绝退款且明确报告配置错误', async () => {
        const booking = await seedCompletedBooking();
        delete process.env.ADMIN_REFUND_PASSWORD_HASH;

        try {
            await expect(
                (adminService as any).refundBookingAsAdmin(
                    booking.bookingId,
                    SECONDARY_PASSWORD,
                    { adminId: 1, adminName: '测试管理员' },
                ),
            ).rejects.toThrow('退款二级密码未配置');
        } finally {
            process.env.ADMIN_REFUND_PASSWORD_HASH = secondaryPasswordHash;
        }

        const unchanged = await bookingRawRepo.findOneOrFail({ where: { bookingId: booking.bookingId } });
        expect(unchanged.refundStatus).toBe(RefundStatus.NONE);
    });

    it('服务端二级密码哈希格式无效时不伪装成密码错误', async () => {
        const booking = await seedCompletedBooking();
        process.env.ADMIN_REFUND_PASSWORD_HASH = 'not-a-bcrypt-hash';

        try {
            await expect(
                (adminService as any).refundBookingAsAdmin(
                    booking.bookingId,
                    SECONDARY_PASSWORD,
                    { adminId: 1, adminName: '测试管理员' },
                ),
            ).rejects.toThrow('退款二级密码配置无效');
        } finally {
            process.env.ADMIN_REFUND_PASSWORD_HASH = secondaryPasswordHash;
        }

        const unchanged = await bookingRawRepo.findOneOrFail({ where: { bookingId: booking.bookingId } });
        expect(unchanged.refundStatus).toBe(RefundStatus.NONE);
    });

    it('正确二级密码让已支付且待使用订单进入退款中', async () => {
        const booking = await seedCompletedBooking({ status: BookingStatus.CONFIRMED });

        await (adminService as any).refundBookingAsAdmin(
            booking.bookingId,
            SECONDARY_PASSWORD,
            { adminId: 1, adminName: '测试管理员' },
        );

        const updated = await bookingRawRepo.findOneOrFail({ where: { bookingId: booking.bookingId } });
        expect(updated.status).toBe(BookingStatus.CONFIRMED);
        expect(updated.paymentStatus).toBe(PaymentStatus.PAID);
        expect(updated.refundStatus).toBe(RefundStatus.REFUNDING);
        expect(updated.reconcileKind).toBe('refund');
        expect(updated.outRefundNo).toBe(`RF${booking.bookingId}`);
    });

    it('非待使用或已完成状态时拒绝管理员直接退款', async () => {
        const booking = await seedCompletedBooking({ status: BookingStatus.CANCELLED });

        await expect(
            (adminService as any).refundBookingAsAdmin(
                booking.bookingId,
                SECONDARY_PASSWORD,
                { adminId: 1, adminName: '测试管理员' },
            ),
        ).rejects.toThrow('仅待使用或已完成订单可由管理员退款');

        const unchanged = await bookingRawRepo.findOneOrFail({ where: { bookingId: booking.bookingId } });
        expect(unchanged.refundStatus).toBe(RefundStatus.NONE);
    });

    it('已完成但未支付的订单不能退款', async () => {
        const booking = await seedCompletedBooking({ paymentStatus: PaymentStatus.UNPAID });

        await expect(
            (adminService as any).refundBookingAsAdmin(
                booking.bookingId,
                SECONDARY_PASSWORD,
                { adminId: 1, adminName: '测试管理员' },
            ),
        ).rejects.toThrow('订单未支付，无法退款');

        const unchanged = await bookingRawRepo.findOneOrFail({ where: { bookingId: booking.bookingId } });
        expect(unchanged.refundStatus).toBe(RefundStatus.NONE);
    });

    it('免费订单不能进入管理员退款流程', async () => {
        const booking = await seedCompletedBooking({ isFree: true, amount: 0 });

        await expect(
            (adminService as any).refundBookingAsAdmin(
                booking.bookingId,
                SECONDARY_PASSWORD,
                { adminId: 1, adminName: '测试管理员' },
            ),
        ).rejects.toThrow('免费预约无需退款');

        const unchanged = await bookingRawRepo.findOneOrFail({ where: { bookingId: booking.bookingId } });
        expect(unchanged.refundStatus).toBe(RefundStatus.NONE);
    });

    it('上一笔退款已终态失败时使用新的微信退款单号重试', async () => {
        const booking = await seedCompletedBooking({
            refundStatus: RefundStatus.FAILED,
            outRefundNo: 'RF-OLD-CLOSED-REFUND',
        });

        await (adminService as any).refundBookingAsAdmin(
            booking.bookingId,
            SECONDARY_PASSWORD,
            { adminId: 1, adminName: '测试管理员' },
        );

        const updated = await bookingRawRepo.findOneOrFail({ where: { bookingId: booking.bookingId } });
        expect(updated.refundStatus).toBe(RefundStatus.REFUNDING);
        expect(updated.outRefundNo).not.toBe('RF-OLD-CLOSED-REFUND');
        expect(updated.outRefundNo).toMatch(/^RF.*-M[A-Z0-9]+$/);
    });
});
