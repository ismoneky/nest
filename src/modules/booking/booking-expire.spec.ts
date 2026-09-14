import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    Booking,
    BookingStatus,
    PaymentStatus,
    RefundStatus,
    TravelMode,
    TimeSlot,
} from '../../entities/booking.entity';
import { BookingAnomaly } from '../../entities/booking-anomaly.entity';
import { BookingRepository } from '../../repositories/booking.repository';
import { BookingService } from './booking.service';

/**
 * T1 过期扫描（markExpired）与核销（markVerified）的边界与互斥测试。
 *
 * 锁定四件事：
 *   1. **边界**：`bookingDate < 今天` 才下沉，**今天当天的订单不得被置为 expired**
 *      （当天全天可核销）。这条同时验证谓词对 `date` 列字符串存储的实际行为。
 *      **整套测试跑在 UTC 下**（`test/jest-tz-setup.js` 的 globalSetup 强制），因为边界曾经
 *      依赖时区：传 `Date` 参数时 TypeORM 绑定的是 UTC 分量字符串 `'2026-09-13 00:00:00.000'`，
 *      与纯 `'2026-09-13'` 比较时"今天"会被算进去，UTC 服务器下当天订单被误置为 expired；
 *      UTC+8 的开发机上这个缺陷不可见。首个用例会自证时区确实被强制了。
 *   2. **排除退款中/已退款**：这两类订单的 status 仍为 confirmed，
 *      旧实现会把它们错置成 completed（§8 第 4 条现存缺陷）。
 *   3. **与核销互斥**：markExpired 与 markVerified 都要求 status='confirmed'，
 *      谁先成功谁生效，后到者 affected=0——防止核销把已过期订单写回 completed。
 *   4. **Q1 拦截**：`expired` 订单的自助退款入口关闭，资金出口只有审核路径。
 *
 * 夹具均为虚构数据，不含真实用户信息。
 */
describe('T1 过期扫描与核销互斥', () => {
    let repo: BookingRepository;
    let service: BookingService;
    let bookingRepo: Repository<Booking>;

    // 固定基准，避免用例随真实日期漂移
    const TODAY = '2026-09-13';
    const YESTERDAY = '2026-09-12';

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

        // 本文件只覆盖状态流转与原子的互斥性（`markExpired` / `markVerified`），
        // 不触达发通知那一步——T1 步骤② 与 T2 的发送行为在
        // `booking-notify.spec.ts` 里用真实的 MessageService 覆盖。
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
    async function seed(bookingDate: string, over: Partial<Booking> = {}): Promise<Booking> {
        seq += 1;
        return await bookingRepo.save(
            bookingRepo.create({
                bookingId: `TL-EXPIRE-${seq}`,
                wechatOpenId: 'openid-test',
                name: '测试',
                phone: '13800000000',
                bookingDate: new Date(`${bookingDate}T00:00:00`) as any,
                timeSlot: TimeSlot.MORNING,
                travelMode: TravelMode.SELF_DRIVING,
                personCount: 1,
                remarks: '',
                isFree: false,
                status: BookingStatus.CONFIRMED,
                paymentStatus: PaymentStatus.PAID,
                refundStatus: RefundStatus.NONE,
                ...over,
            }),
        );
    }

    /** 直接读原始列值，绕过 transformer，确认 date 列的真实存储格式 */
    async function rawBookingDate(bookingId: string): Promise<string> {
        const row = await bookingRepo.query(
            'SELECT bookingDate FROM bookings WHERE bookingId = ?',
            [bookingId],
        );
        return row[0]?.bookingDate;
    }

    async function statusOf(bookingId: string): Promise<string> {
        const b = await bookingRepo.findOne({ where: { bookingId } });
        return b!.status;
    }

    describe('date 列存储格式（谓词正确性的前提）', () => {
        it('进程时区已被强制为 UTC（整套边界用例的前提）', () => {
            // 自证 globalSetup（test/jest-tz-setup.js）确实生效：若它失效，本文件对边界做的
            // 就只是"在 UTC+8 下碰巧通过"，那正是 2026-09-13 漏掉该缺陷的原因。
            // 这也是唯一可行的写法——jest 的 node 环境会复制 process.env，
            // 在 spec 的 beforeAll 里改 process.env.TZ 影响不到 Node 的时区解析（已实测无效）。
            expect(new Date(2026, 8, 13).getTimezoneOffset()).toBe(0);
        });

        it('bookingDate 以纯 YYYY-MM-DD 字符串存储', async () => {
            const b = await seed(TODAY);
            expect(await rawBookingDate(b.bookingId)).toBe(TODAY);
        });
    });

    describe('markExpired 边界', () => {
        it('昨天的 confirmed 订单被置为 expired 并写入 expiredAt', async () => {
            const b = await seed(YESTERDAY);
            const now = Date.now();

            const affected = await repo.markExpired(TODAY, now);

            expect(affected).toBeGreaterThanOrEqual(1);
            const after = await bookingRepo.findOne({ where: { bookingId: b.bookingId } });
            expect(after!.status).toBe(BookingStatus.EXPIRED);
            expect(after!.expiredAt!.getTime()).toBe(now);
        });

        it('【关键】今天当天的 confirmed 订单不得被置为 expired', async () => {
            const b = await seed(TODAY);

            await repo.markExpired(TODAY, Date.now());

            expect(await statusOf(b.bookingId)).toBe(BookingStatus.CONFIRMED);
        });

        it('明天的订单不受影响', async () => {
            const b = await seed('2026-09-14');
            await repo.markExpired(TODAY, Date.now());
            expect(await statusOf(b.bookingId)).toBe(BookingStatus.CONFIRMED);
        });

        it('已过期的订单不会被重复改写（条件更新）', async () => {
            const b = await seed(YESTERDAY);
            const first = await repo.markExpired(TODAY, Date.now());
            const second = await repo.markExpired(TODAY, Date.now());
            expect(await statusOf(b.bookingId)).toBe(BookingStatus.EXPIRED);
            // 第二轮的 affected 不应包含它
            expect(second).toBeLessThan(first);
        });
    });

    describe('markExpired 排除条件', () => {
        it('退款中的订单不被置为 expired（refundStatus=refunding）', async () => {
            const b = await seed(YESTERDAY, { refundStatus: RefundStatus.REFUNDING });

            await repo.markExpired(TODAY, Date.now());

            // 退款中的订单 status 仍须保持 confirmed（markRefundStarting 的契约）
            expect(await statusOf(b.bookingId)).toBe(BookingStatus.CONFIRMED);
        });

        it('已退款的订单不被置为 expired（refundStatus=refunded）', async () => {
            const b = await seed(YESTERDAY, { refundStatus: RefundStatus.REFUNDED });
            await repo.markExpired(TODAY, Date.now());
            expect(await statusOf(b.bookingId)).toBe(BookingStatus.CONFIRMED);
        });

        it('已核销的订单不被置为 expired', async () => {
            const b = await seed(YESTERDAY, { status: BookingStatus.COMPLETED });
            await repo.markExpired(TODAY, Date.now());
            expect(await statusOf(b.bookingId)).toBe(BookingStatus.COMPLETED);
        });

        it('待支付订单不被置为 expired', async () => {
            const b = await seed(YESTERDAY, {
                status: BookingStatus.PENDING,
                paymentStatus: PaymentStatus.UNPAID,
            });
            await repo.markExpired(TODAY, Date.now());
            expect(await statusOf(b.bookingId)).toBe(BookingStatus.PENDING);
        });
    });

    describe('markVerified 留痕与互斥', () => {
        it('核销写入 verifiedAt / verifiedBy', async () => {
            const b = await seed(TODAY);
            const now = Date.now();

            const affected = await repo.markVerified(b.bookingId, 'openid-staff', now);

            expect(affected).toBe(1);
            const after = await bookingRepo.findOne({ where: { bookingId: b.bookingId } });
            expect(after!.status).toBe(BookingStatus.COMPLETED);
            expect(after!.verifiedAt!.getTime()).toBe(now);
            expect(after!.verifiedBy).toBe('openid-staff');
        });

        it('重复核销 affected=0', async () => {
            const b = await seed(TODAY);
            expect(await repo.markVerified(b.bookingId, 'openid-staff', Date.now())).toBe(1);
            expect(await repo.markVerified(b.bookingId, 'openid-staff', Date.now())).toBe(0);
        });

        it('【关键】已过期订单不可再核销（阻止绕过审核的补核销）', async () => {
            const b = await seed(YESTERDAY);
            await repo.markExpired(TODAY, Date.now());
            expect(await statusOf(b.bookingId)).toBe(BookingStatus.EXPIRED);

            const affected = await repo.markVerified(b.bookingId, 'openid-staff', Date.now());

            expect(affected).toBe(0);
            expect(await statusOf(b.bookingId)).toBe(BookingStatus.EXPIRED);
        });

        it('【关键】markVerified 先成功后，markExpired 不会把它翻成 expired', async () => {
            // 模拟「当天核销 → 次日 T1 扫描」
            const b = await seed(YESTERDAY);
            await repo.markVerified(b.bookingId, 'openid-staff', Date.now());

            await repo.markExpired(TODAY, Date.now());

            expect(await statusOf(b.bookingId)).toBe(BookingStatus.COMPLETED);
        });
    });

    describe('initiateRefund 对已过期订单的拦截（Q1）', () => {
        const OWNER = 'openid-test';

        async function refundStatusOf(bookingId: string): Promise<string> {
            const row = await bookingRepo.findOne({ where: { bookingId } });
            return row!.refundStatus;
        }

        it('过期订单走用户自助退款被拒，且不产生任何写入', async () => {
            const b = await seed(YESTERDAY, { status: BookingStatus.EXPIRED });

            await expect(service.initiateRefund(b.bookingId, OWNER)).rejects.toThrow(/需经管理员审核/);

            // 关键断言：不是"报错但已经进了 REFUNDING"，而是确认真的一行都没写
            expect(await refundStatusOf(b.bookingId)).toBe(RefundStatus.NONE);
            expect(await statusOf(b.bookingId)).toBe(BookingStatus.EXPIRED);
        });

        it('审核路径 asAdmin 不被 Q1 拦截', async () => {
            const b = await seed(YESTERDAY, { status: BookingStatus.EXPIRED });

            const blockedByQ1 = await service
                .initiateRefund(b.bookingId, OWNER, { asAdmin: true })
                .then(
                    () => false,
                    (error: Error) => /需经管理员审核/.test(error.message),
                );

            // 阶段 2A：markRefundStarting 仍要求 status='confirmed'，故本次调用会停在下游条件上；
            // 阶段 3 放开该条件后此处将直接成功。两种情况下都不该命中 Q1 的拦截文案——
            // 若本用例在阶段 3 之后开始失败，说明放开条件时把 asAdmin 传丢了。
            expect(blockedByQ1).toBe(false);
        });
    });
});
