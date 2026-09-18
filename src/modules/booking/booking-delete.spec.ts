import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
    Booking,
    BookingStatus,
    PaymentStatus,
    RefundStatus,
    TimeSlot,
    TravelMode,
} from '../../entities/booking.entity';
import { BookingAnomaly } from '../../entities/booking-anomaly.entity';
import { BookingRepository } from '../../repositories/booking.repository';
import { BookingService } from './booking.service';
import { MESSAGE_QUIET_WINDOW_MS } from '../message/message-policy';

/**
 * 用户删除自己的订单（**软删除**）—— 可见性与边界回归测试。
 *
 * 需求原话：「只有用户自己看不到，后台可以看到，管理员也不能删除」。
 * 这三句话各自对应一组断言，本文件把它们都变成可执行的锁：
 *
 *   1. **只有用户自己看不到**：列表、角标计数、详情、退款申请入口都拿不到；
 *   2. **后台可以看到**：管理端列表/导出/管理端读单不受影响，资金链路与核销照常；
 *   3. **管理员不能删除**：删除接口的归属校验写死在 SQL 里，管理端没有删除入口。
 *
 * 还有两条容易被后人「顺手改掉」的性质，单独锁住：
 *   · 删除**不参与状态机**——status/paymentStatus/refundStatus 一个都不许变；
 *   · 重复删除**幂等**，且不刷新删除时刻（`deletedByUserAt IS NULL` 是语义的一部分）。
 *
 * ⚠️ 本文件里唯一「不能加过滤」的那处也做了断言（`getBookingById` 仓库方法），
 * 因为它是核销、退款、支付回调、对账共用的读入口——给它加软删除过滤会**静默掐断
 * 资金链路**，而那不会有任何编译期提示。
 *
 * 夹具均为虚构数据，不含真实用户信息。
 */
describe('BookingService.deleteBooking（C 端软删除）', () => {
    let service: BookingService;
    let repo: BookingRepository;
    let bookingRepo: Repository<Booking>;

    const OWNER = 'openid-del-owner';
    const OTHER = 'openid-del-other';

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

        // 删除路径只依赖 bookingRepository 与一层日志，其余协作者不会被触达。
        // loggingService 给个空壳而不是 null：删除成功会写一条业务记录点，
        // 用 null 会让「记日志失败」和「删除本身失败」在测试里长得一样
        service = new BookingService(
            repo,
            null as any, // wechatPayService
            null as any, // systemConfigService
            null as any, // adminApplicationRepository
            null as any, // dataSource
            null as any, // memberService
            null as any, // userProfileRepository
            { write: () => undefined } as any, // loggingService
            null as any, // refundApplyRepository
            null as any, // messageService
        );
    });

    beforeEach(async () => {
        await bookingRepo.clear();
    });

    let seq = 0;
    async function seed(over: Partial<Booking> = {}): Promise<Booking> {
        seq += 1;
        return await bookingRepo.save(
            bookingRepo.create({
                bookingId: `TL-DEL-${seq}`,
                wechatOpenId: OWNER,
                name: '测试',
                phone: '13800000000',
                bookingDate: new Date('2099-01-01') as any,
                timeSlot: TimeSlot.MORNING,
                travelMode: TravelMode.SELF_DRIVING,
                personCount: 1,
                remarks: '',
                isFree: false,
                amount: 10000,
                status: BookingStatus.CONFIRMED,
                paymentStatus: PaymentStatus.PAID,
                refundStatus: RefundStatus.NONE,
                ...over,
            }),
        );
    }

    /** 原始列值，绕过 transformer（`deletedByUserAt` 在实体上是 Date） */
    async function deletedAtOf(bookingId: string): Promise<number | null> {
        const rows = await bookingRepo.query(
            'SELECT deletedByUserAt FROM bookings WHERE bookingId = ?',
            [bookingId],
        );
        return rows[0]?.deletedByUserAt ?? null;
    }

    // ═════════════════════════════════════════════════════════════════════════
    describe('删除本身', () => {
        it('本人删除成功，且**其余字段一个都没变**（删除不参与状态机）', async () => {
            const b = await seed({
                status: BookingStatus.EXPIRED,
                expiredAt: new Date(),
                reconcileKind: 'refund',
                reconcileNextAt: Date.now(),
            });

            const result = await service.deleteBooking(b.bookingId, OWNER);

            expect(result).toEqual({ bookingId: b.bookingId, alreadyDeleted: false });
            expect(await deletedAtOf(b.bookingId)).not.toBeNull();

            const after = await bookingRepo.findOne({ where: { bookingId: b.bookingId } });
            expect(after!.status).toBe(BookingStatus.EXPIRED);
            expect(after!.paymentStatus).toBe(PaymentStatus.PAID);
            expect(after!.refundStatus).toBe(RefundStatus.NONE);
            // 对账调度也不能被清：退款还在收敛中，删除只是用户视角的事
            expect(after!.reconcileKind).toBe('refund');
        });

        it('任意状态都可删：待支付 / 已核销 / 退款中 各删一次', async () => {
            const pending = await seed({ status: BookingStatus.PENDING, paymentStatus: PaymentStatus.UNPAID });
            const completed = await seed({ status: BookingStatus.COMPLETED });
            const refunding = await seed({
                status: BookingStatus.EXPIRED,
                refundStatus: RefundStatus.REFUNDING,
                outRefundNo: 'RF-1',
            });

            for (const b of [pending, completed, refunding]) {
                const r = await service.deleteBooking(b.bookingId, OWNER);
                expect(r.alreadyDeleted).toBe(false);
                expect(await deletedAtOf(b.bookingId)).not.toBeNull();
            }
        });

        it('PAYING（钱可能正在落账）也可删，且不动支付状态', async () => {
            const b = await seed({
                status: BookingStatus.PENDING,
                paymentStatus: PaymentStatus.PAYING,
                outTradeNo: 'OT-DEL-1',
            });

            await service.deleteBooking(b.bookingId, OWNER);

            // 删除不杀单：钱落到一张用户看不见的单上，由对账照常推进
            const after = await bookingRepo.findOne({ where: { bookingId: b.bookingId } });
            expect(after!.paymentStatus).toBe(PaymentStatus.PAYING);
            expect(after!.status).toBe(BookingStatus.PENDING);
        });

        it('重复删除**幂等**：第二次 alreadyDeleted=true，且不刷新删除时刻', async () => {
            const b = await seed();

            const first = await service.deleteBooking(b.bookingId, OWNER);
            const firstAt = await deletedAtOf(b.bookingId);

            const second = await service.deleteBooking(b.bookingId, OWNER);

            expect(first.alreadyDeleted).toBe(false);
            expect(second.alreadyDeleted).toBe(true);
            // 条件里的 `deletedByUserAt IS NULL` 是幂等语义的一部分：
            // 少了它，重复点击会把「用户什么时候删的」越写越新
            expect(await deletedAtOf(b.bookingId)).toBe(firstAt);
        });

        it('删他人订单被拒，且**数据库无任何改动**', async () => {
            const b = await seed();

            await expect(service.deleteBooking(b.bookingId, OTHER)).rejects.toBeInstanceOf(BadRequestException);

            // 关键断言：不只是报错，而是确认没有发生越权写入
            expect(await deletedAtOf(b.bookingId)).toBeNull();
        });

        it('订单号不存在时抛 NotFoundException（而不是 400）', async () => {
            await expect(service.deleteBooking('TL-NOT-EXIST', OWNER)).rejects.toBeInstanceOf(NotFoundException);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    describe('用户侧看不到', () => {
        it('列表里不出现（列表与计数必须是同一口径）', async () => {
            const kept = await seed();
            const removed = await seed();
            await service.deleteBooking(removed.bookingId, OWNER);

            const result = await repo.getBookings({ wechatOpenId: OWNER });

            expect(result.total).toBe(1);
            expect(result.bookings.map((b) => b.bookingId)).toEqual([kept.bookingId]);
            // 计数不过滤的话，小程序会出现「角标 2 条、点进去只有 1 条」
            expect(await repo.countBookingsByStatus(OWNER)).toBe(1);
        });

        it('详情返回「订单不存在」', async () => {
            const b = await seed();
            await service.deleteBooking(b.bookingId, OWNER);

            await expect(service.getBookingById(b.bookingId, OWNER)).rejects.toBeInstanceOf(NotFoundException);
        });

        it('**归属校验在前**：非本人拿到的仍然是「无权访问」，不是「不存在」', async () => {
            const b = await seed();
            await service.deleteBooking(b.bookingId, OWNER);

            // 顺序反了会把「这单存在、只是被删了」泄露给非本人
            await expect(service.getBookingById(b.bookingId, OTHER)).rejects.toBeInstanceOf(BadRequestException);
        });

        it('退款申请入口被同一条拦下（controller 在 submitApply 之前先调 getBookingById）', async () => {
            const b = await seed({ status: BookingStatus.EXPIRED, expiredAt: new Date() });
            await service.deleteBooking(b.bookingId, OWNER);

            // 这就是 `POST /bookings/:id/refund-apply` 的第一个动作，
            // 它抛错即代表请求在触达 refund_apply 之前就被拦下
            await expect(service.getBookingById(b.bookingId, OWNER)).rejects.toBeInstanceOf(NotFoundException);
        });

        it('三个扫描类通知都不再取到已删订单', async () => {
            const b = await seed({
                status: BookingStatus.EXPIRED,
                expiredAt: new Date(),
                bookingDate: new Date('2000-01-01') as any,
            });
            await service.deleteBooking(b.bookingId, OWNER);

            const now = Date.now();
            expect(await repo.findExpiredNotNotified(now, MESSAGE_QUIET_WINDOW_MS)).toHaveLength(0);
            expect(await repo.findExpiredForRefundReminder(now, 7 * 24 * 60 * 60 * 1000)).toHaveLength(0);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    describe('后台与资金链路不受影响', () => {
        it('管理端列表与导出**仍然包含**已删订单', async () => {
            const b = await seed();
            await service.deleteBooking(b.bookingId, OWNER);

            const adminList = await repo.getBookingsForAdmin({});
            expect(adminList.bookings.map((x) => x.bookingId)).toContain(b.bookingId);

            const exported = await repo.getAllBookingsForExport({});
            expect(exported.map((x) => x.bookingId)).toContain(b.bookingId);
        });

        it('管理端读单（退款审核详情用的那条）能拿到已删订单', async () => {
            const b = await seed();
            await service.deleteBooking(b.bookingId, OWNER);

            const forAdmin = await service.getBookingByIdForAdmin(b.bookingId);
            expect(forAdmin.bookingId).toBe(b.bookingId);
        });

        it('仓库 getBookingById **不过滤**：核销/退款/支付回调/对账都靠它', async () => {
            const b = await seed();
            await service.deleteBooking(b.bookingId, OWNER);

            // 这条断言的作用是「反向的」：一旦有人给仓库方法加上软删除过滤，
            // 它会立刻变红。那处过滤会静默掐断资金链路，是本次改动最大的风险点
            const raw = await repo.getBookingById(b.bookingId);
            expect(raw.bookingId).toBe(b.bookingId);
            expect(raw.deletedByUserAt).not.toBeNull();
        });

        it('名额与统计不过滤：删掉的订单照样占着当天的名额', async () => {
            const b = await seed({
                bookingDate: new Date('2099-01-01') as any,
                status: BookingStatus.CONFIRMED,
                personCount: 3,
            });
            await service.deleteBooking(b.bookingId, OWNER);

            // 与「取消/退款不退还名额」同一口径：用户藏起来的只是自己那条记录，
            // 不是放弃这笔预约。加了过滤会造出「删单即可重领当天免费名额」的洞
            const stats = await repo.getBookingStatsByDate('2099-01-01');
            expect(stats.morning.totalPeople).toBe(3);
        });
    });

    // ═════════════════════════════════════════════════════════════════════════
    describe('markDeletedByUser 条件更新语义', () => {
        it('本人订单 → affected=1；重复调用 → 0', async () => {
            const b = await seed();

            expect(await repo.markDeletedByUser(b.bookingId, OWNER, Date.now())).toBe(1);
            expect(await repo.markDeletedByUser(b.bookingId, OWNER, Date.now())).toBe(0);
        });

        it('非本人 → affected=0（归属校验在 SQL 的 WHERE 里）', async () => {
            const b = await seed();

            expect(await repo.markDeletedByUser(b.bookingId, OTHER, Date.now())).toBe(0);
            expect(await deletedAtOf(b.bookingId)).toBeNull();
        });
    });
});
