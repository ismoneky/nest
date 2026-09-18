import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import {
    Booking,
    BookingStatus,
    PaymentStatus,
    TravelMode,
    TimeSlot,
} from '../../entities/booking.entity';
import { BookingAnomaly } from '../../entities/booking-anomaly.entity';
import { BookingRepository } from '../../repositories/booking.repository';
import { BookingService } from './booking.service';
import { BookingException, BookingErrorCode } from '../../common/booking-errors';

/**
 * 用户主动取消订单 —— 安全与状态守卫回归测试。
 *
 * 背景：该能力此前挂在无 Guard、无归属校验、允许任意 status 的 `PUT /bookings/:id` 上，
 * 任何人拿到订单号就能取消他人订单（或把订单改成 confirmed 伪造核销码）。
 * 本测试锁定修复后的三条性质：
 *   1. 非本人订单不可取消，且**未产生任何写入**；
 *   2. 只有 pending + unpaid 可取消（PAYING 需等关单对账收敛，避免「已取消却收到钱」）；
 *   3. 条件更新在并发下返回 0 而不是盲目覆盖。
 *
 * 夹具均为虚构数据，不含真实用户信息。
 */
describe('BookingService.cancelBooking', () => {
    let service: BookingService;
    let repo: BookingRepository;
    let bookingRepo: Repository<Booking>;

    const OWNER = 'openid-owner';
    const OTHER = 'openid-other';

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'sqlite',
                    database: ':memory:',
                    synchronize: true,
                    dropSchema: true,
                    entities: [Booking, BookingAnomaly],
                }),
                TypeOrmModule.forFeature([Booking, BookingAnomaly]),
            ],
            providers: [BookingRepository],
        }).compile();

        repo = moduleRef.get(BookingRepository);
        bookingRepo = moduleRef.get(getRepositoryToken(Booking));

        // 取消路径只依赖 bookingRepository，其余协作者（含退款申请仓库与站内信）不会被触达
        service = new BookingService(
            repo,
            null as any, // wechatPayService
            null as any, // systemConfigService
            null as any, // adminApplicationRepository
            null as any, // dataSource
            null as any, // memberService
            null as any, // userProfileRepository
            null as any, // loggingService
            null as any, // refundApplyRepository
            null as any, // messageService
        );
    });

    let seq = 0;
    async function seed(over: Partial<Booking> = {}): Promise<Booking> {
        seq += 1;
        const booking = bookingRepo.create({
            bookingId: `TL-CANCEL-${seq}`,
            wechatOpenId: OWNER,
            name: '测试',
            phone: '13800000000',
            bookingDate: new Date('2099-01-01') as any,
            timeSlot: TimeSlot.MORNING,
            travelMode: TravelMode.SELF_DRIVING,
            personCount: 1,
            remarks: '',
            isFree: false,
            status: BookingStatus.PENDING,
            paymentStatus: PaymentStatus.UNPAID,
            ...over,
        });
        return await bookingRepo.save(booking);
    }

    function readStatus(id: string) {
        return bookingRepo.findOne({ where: { bookingId: id } });
    }

    it('本人取消待支付订单成功，并落到与超时关单一致的终态', async () => {
        const b = await seed({ reconcileKind: 'close', reconcileNextAt: Date.now() });

        const result = await service.cancelBooking(b.bookingId, OWNER);

        expect(result.status).toBe(BookingStatus.CANCELLED);
        expect(result.paymentStatus).toBe(PaymentStatus.FAILED);
        // 清空 close 调度：UNPAID 严格等价于「微信侧无单」，没有单需要关
        expect(result.reconcileKind).toBeNull();
        expect(result.reconcileNextAt).toBeNull();
    });

    it('免费订单同样可取消', async () => {
        const b = await seed({ isFree: true, freeReason: 'member' });
        const result = await service.cancelBooking(b.bookingId, OWNER);
        expect(result.status).toBe(BookingStatus.CANCELLED);
    });

    it('取消他人订单被拒，且数据库无任何改动', async () => {
        const b = await seed();

        await expect(service.cancelBooking(b.bookingId, OTHER)).rejects.toBeInstanceOf(BadRequestException);

        // 关键断言：不只是报错，而是确认没有发生越权写入
        const after = await readStatus(b.bookingId);
        expect(after!.status).toBe(BookingStatus.PENDING);
        expect(after!.paymentStatus).toBe(PaymentStatus.UNPAID);
    });

    it('已支付订单不可取消（走退款申请，不走取消）', async () => {
        const b = await seed({ status: BookingStatus.CONFIRMED, paymentStatus: PaymentStatus.PAID });

        await expect(service.cancelBooking(b.bookingId, OWNER)).rejects.toMatchObject({
            code: BookingErrorCode.ORDER_CANNOT_CANCEL,
        });

        const after = await readStatus(b.bookingId);
        expect(after!.status).toBe(BookingStatus.CONFIRMED);
        expect(after!.paymentStatus).toBe(PaymentStatus.PAID);
    });

    it('已完成订单不可取消', async () => {
        const b = await seed({ status: BookingStatus.COMPLETED, paymentStatus: PaymentStatus.PAID });
        await expect(service.cancelBooking(b.bookingId, OWNER)).rejects.toMatchObject({
            code: BookingErrorCode.ORDER_CANNOT_CANCEL,
        });
    });

    it('PAYING 订单返回可重试错误码，不杀单（避免已取消却收到钱）', async () => {
        const b = await seed({ paymentStatus: PaymentStatus.PAYING, outTradeNo: 'OT-1' });

        await expect(service.cancelBooking(b.bookingId, OWNER)).rejects.toMatchObject({
            code: BookingErrorCode.ORDER_PAYMENT_IN_PROGRESS,
        });

        const after = await readStatus(b.bookingId);
        expect(after!.status).toBe(BookingStatus.PENDING);
        expect(after!.paymentStatus).toBe(PaymentStatus.PAYING);
    });

    it('订单不存在时报错', async () => {
        await expect(service.cancelBooking('TL-NOT-EXIST', OWNER)).rejects.toBeTruthy();
    });

    describe('markCancelledByUser 条件更新语义', () => {
        it('pending+unpaid → affected=1', async () => {
            const b = await seed();
            expect(await repo.markCancelledByUser(b.bookingId)).toBe(1);
        });

        it('pending+paying → affected=0（并发下不误杀在途支付）', async () => {
            const b = await seed({ paymentStatus: PaymentStatus.PAYING, outTradeNo: 'OT-2' });
            expect(await repo.markCancelledByUser(b.bookingId)).toBe(0);
            const after = await readStatus(b.bookingId);
            expect(after!.status).toBe(BookingStatus.PENDING);
        });

        it('重复取消 → 第二次 affected=0', async () => {
            const b = await seed();
            expect(await repo.markCancelledByUser(b.bookingId)).toBe(1);
            expect(await repo.markCancelledByUser(b.bookingId)).toBe(0);
        });
    });
});
