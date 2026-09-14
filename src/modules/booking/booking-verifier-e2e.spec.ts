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
import { AdminApplication, AdminApplicationStatus } from '../../entities/admin-application.entity';
import { BookingRepository } from '../../repositories/booking.repository';
import { AdminApplicationRepository } from '../../repositories/admin-application.repository';
import { BookingService } from './booking.service';

/**
 * 「核销人姓名」的**端到端**检查：真库 → 真查询 → JSON 序列化
 *
 * ── 为什么单开一个文件 ────────────────────────────────────────────────────
 * `booking-verifier-name.spec.ts` 用替身锁的是**策略**（查不查、抛不抛、回落成什么），
 * 它证明不了「字段真的送到了客户端」——那要真库、真 `IN (...)`、真 TypeORM 实体展开。
 *
 * 中间有整整三段都可能把字段吃掉，而每一段失败都是**静默**的：
 *   1. `findApprovedNamesByOpenids` 的 `IN (...)` + `select: ['openid','name']`
 *      —— 查不出来就是一个空 Map，不报错；
 *   2. `{ ...row }` 展开 TypeORM 实体 —— 列是原型链上的还是自有属性，展开结果不同；
 *   3. `JSON.stringify` —— 实体属性若是 undefined 会被整个丢掉，
 *      前端拿到的是 `verifiedBy: undefined`，界面上就是「核销人：—」。
 *
 * 所以最后一个断言**刻意做一次 JSON 往返**：那才是 `res.send()` 之后
 * 浏览器真正拿到的东西。用 `toBe` 直接比对象会绕过这一段。
 *
 * 夹具为虚构数据，不含真实用户信息。
 */
describe('核销人姓名端到端（真库 → 查询 → JSON）', () => {
    let service: BookingService;
    let bookingRepo: Repository<Booking>;
    let adminRepo: Repository<AdminApplication>;
    let seq = 0;

    const VERIFIER_OPENID = 'openid-verifier-e2e';

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'sqlite',
                    database: ':memory:',
                    synchronize: true,
                    dropSchema: true,
                    entities: [Booking, BookingAnomaly, AdminApplication],
                }),
                TypeOrmModule.forFeature([Booking, BookingAnomaly, AdminApplication]),
            ],
            providers: [BookingRepository, AdminApplicationRepository],
        }).compile();

        const bookingRepository = moduleRef.get(BookingRepository);
        const adminApplicationRepository = moduleRef.get(AdminApplicationRepository);
        bookingRepo = moduleRef.get(getRepositoryToken(Booking));
        adminRepo = moduleRef.get(getRepositoryToken(AdminApplication));

        // 构造函数第 4 个参数是 adminApplicationRepository，其余本文件不触达
        service = new BookingService(
            bookingRepository,
            null as any, // wechatPayService
            null as any, // systemConfigService
            adminApplicationRepository,
            null as any, // dataSource
            null as any, // memberService
            null as any, // userProfileRepository
            null as any, // loggingService
            null as any, // refundApplyRepository
            null as any, // messageService
        );
    });

    beforeEach(async () => {
        await bookingRepo.clear();
        await adminRepo.clear();
    });

    async function seedBooking(over: Partial<Booking> = {}): Promise<Booking> {
        seq += 1;
        return await bookingRepo.save(
            bookingRepo.create({
                bookingId: `TL-E2E-${seq}`,
                wechatOpenId: 'openid-tourist',
                name: '测试',
                phone: '13800000000',
                bookingDate: '2026-09-15',
                timeSlot: TimeSlot.MORNING,
                travelMode: TravelMode.SELF_DRIVING,
                personCount: 1,
                remarks: '',
                isFree: false,
                amount: 10000,
                status: BookingStatus.COMPLETED,
                paymentStatus: PaymentStatus.PAID,
                refundStatus: RefundStatus.NONE,
                verifiedAt: new Date('2026-09-15T02:30:00.000Z'),
                verifiedBy: VERIFIER_OPENID,
                createdAt: new Date('2026-09-14T02:00:00.000Z'),
                updatedAt: new Date('2026-09-15T02:30:00.000Z'),
                ...over,
            }),
        );
    }

    async function seedVerifier(name: string, status = AdminApplicationStatus.APPROVED) {
        await adminRepo.save(
            adminRepo.create({
                applicationId: `APP-${name}`,
                openid: VERIFIER_OPENID,
                phone: '13900000000',
                name,
                status,
                rejectionReason: null,
            }),
        );
    }

    it('后台列表：核销时间与核销人姓名一路走到 JSON 都还在', async () => {
        await seedVerifier('张三');
        await seedBooking();

        const result = await service.getBookingsForAdmin({ page: 1, pageSize: 10 });

        // 这一层是服务返回的对象
        expect(result.bookings).toHaveLength(1);
        expect(result.bookings[0].verifiedByName).toBe('张三');

        // 这一层才是 res.send() 之后浏览器真正拿到的
        const wire = JSON.parse(JSON.stringify(result.bookings[0]));
        expect(wire.verifiedByName).toBe('张三');
        expect(wire.verifiedBy).toBe(VERIFIER_OPENID);
        expect(wire.verifiedAt).toBeTruthy();
        // 核销时间是 Date，过 JSON 会变成 ISO 字符串 —— 前端 dayjs() 能吃，
        // 小程序那边的 verifiedAtText 也专门为这两种形状做了归一
        expect(typeof wire.verifiedAt).toBe('string');
    });

    it('核销员没有「已通过」的申请单 → 姓名 null，但 openid 必须留着（后台靠它追责）', async () => {
        await seedBooking(); // 故意不 seed 申请单

        const wire = JSON.parse(
            JSON.stringify((await service.getBookingsForAdmin({})).bookings[0]),
        );

        expect(wire.verifiedByName).toBeNull();
        expect(wire.verifiedBy).toBe(VERIFIER_OPENID);
    });

    it('申请单还是 pending（没通过）→ 不算核销员，姓名仍为 null', async () => {
        await seedVerifier('李四', AdminApplicationStatus.PENDING);
        await seedBooking();

        const wire = JSON.parse(
            JSON.stringify((await service.getBookingsForAdmin({})).bookings[0]),
        );

        expect(wire.verifiedByName).toBeNull();
    });

    it('未核销的订单：整列没有留痕，不会凭空多出姓名', async () => {
        await seedVerifier('张三');
        await seedBooking({
            status: BookingStatus.EXPIRED,
            verifiedAt: null as any,
            verifiedBy: null as any,
        });

        const wire = JSON.parse(
            JSON.stringify((await service.getBookingsForAdmin({})).bookings[0]),
        );

        expect(wire.verifiedAt).toBeNull();
        expect(wire.verifiedBy).toBeNull();
        expect(wire.verifiedByName).toBeNull();
    });

    it('一页多个订单、同一个核销员：都挂上姓名', async () => {
        await seedVerifier('张三');
        await seedBooking({ bookingId: 'TL-E2E-A' });
        await seedBooking({ bookingId: 'TL-E2E-B' });

        const result = await service.getBookingsForAdmin({ page: 1, pageSize: 10 });

        expect(result.bookings).toHaveLength(2);
        expect(result.bookings.every((b) => b.verifiedByName === '张三')).toBe(true);
    });
});
