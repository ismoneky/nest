import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Booking, BookingStatus, PaymentStatus, TravelMode, VehicleType, TimeSlot, RefundStatus } from '../entities/booking.entity';
import { BookingAnomaly } from '../entities/booking-anomaly.entity';
import { BookingRepository } from './booking.repository';

/**
 * 经营统计聚合口径回归测试
 *
 * 夹具均为虚构数据，不含真实用户信息。
 */
describe('BookingRepository.getBookingDashboard', () => {
    let repo: BookingRepository;
    let bookingRepo: Repository<Booking>;

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

        await seedFixtures(bookingRepo);
    });

    afterAll(async () => {
        // sqlite :memory: 连接随进程退出回收；此处不显式 close 以避免 moduleRef 时序问题
    });

    it('日期边界包含 start 和 end 两天', async () => {
        const res = await repo.getBookingDashboard('2026-08-01', '2026-08-01');
        expect(res.range.startDate).toBe('2026-08-01');
        expect(res.range.endDate).toBe('2026-08-01');
        // 8/1 有 1 个 confirmed 订单（见夹具）
        expect(res.summary.validOrderCount).toBe(1);
    });

    it('pending 只进入状态分布，不进入有效订单/人数/车辆/实收', async () => {
        const res = await repo.getBookingDashboard('2026-08-02', '2026-08-02');
        // 8/2 有 1 个 pending 订单（2 人，自驾，有车牌，未支付）
        const pendingDist = res.statusDistribution.find((d) => d.status === BookingStatus.PENDING);
        expect(pendingDist?.orderCount).toBe(1);
        // 不计入有效订单
        expect(res.summary.validOrderCount).toBe(0);
        expect(res.summary.totalPeople).toBe(0);
        expect(res.summary.selfDrivingVehicleCount).toBe(0);
        expect(res.summary.receivedAmount).toBe(0);
    });

    it('cancelled / refunded 不进入有效指标', async () => {
        const res = await repo.getBookingDashboard('2026-08-03', '2026-08-03');
        // 8/3 有 1 cancelled + 1 refunded，均不计入有效
        expect(res.summary.validOrderCount).toBe(0);
        expect(res.summary.totalPeople).toBe(0);
        expect(res.summary.receivedAmount).toBe(0);
        expect(res.statusDistribution.find((d) => d.status === BookingStatus.CANCELLED)?.orderCount).toBe(1);
        expect(res.statusDistribution.find((d) => d.status === BookingStatus.REFUNDED)?.orderCount).toBe(1);
    });

    it('confirmed / completed 进入有效指标', async () => {
        const res = await repo.getBookingDashboard('2026-08-01', '2026-08-04');
        // 8/1 confirmed(1人) + 8/4 completed(3人) = 2 有效订单，4 人
        expect(res.summary.validOrderCount).toBe(2);
        expect(res.summary.totalPeople).toBe(4);
    });

    it('只有 paid 且 confirmed/completed 的金额进入实收', async () => {
        const res = await repo.getBookingDashboard('2026-08-01', '2026-08-05');
        // 有效订单：8/1 confirmed paid amount=6600；8/4 completed paid amount=0(免费)；8/5 confirmed unpaid amount=6600(不计实收)
        // 8/2 pending 不计；8/3 cancelled/refunded 不计
        expect(res.summary.receivedAmount).toBe(6600);
    });

    it('免费/收费人数相加等于有效总人数', async () => {
        const res = await repo.getBookingDashboard('2026-08-01', '2026-08-06');
        // 有效订单：8/1 confirmed(1人,收费) + 8/4 completed(3人,免费) + 8/5 confirmed(1人,收费) + 8/6 confirmed(2人,收费)
        expect(res.summary.validOrderCount).toBe(4);
        expect(res.summary.totalPeople).toBe(7);
        expect(res.summary.freePeople).toBe(3);
        expect(res.summary.paidPeople).toBe(4);
        expect(res.summary.freePeople + res.summary.paidPeople).toBe(res.summary.totalPeople);
    });

    it('自驾车辆数：仅 selfDriving 且有非空车牌的有效订单计数，一单一车', async () => {
        const res = await repo.getBookingDashboard('2026-08-01', '2026-08-07');
        // 有效自驾有车牌订单：8/1(豫A12345) + 8/5(豫A55555) + 8/6(豫B67890) + 8/7(无车牌,不计) = 3 辆
        // 8/4 是 scenicBus 不计
        expect(res.summary.selfDrivingVehicleCount).toBe(3);
    });

    it('状态分布包含全部五种状态，即使为 0 也有元素', async () => {
        const res = await repo.getBookingDashboard('2026-08-01', '2026-08-07');
        const statuses = res.statusDistribution.map((d) => d.status);
        expect(statuses).toEqual(
            expect.arrayContaining([
                BookingStatus.PENDING,
                BookingStatus.CONFIRMED,
                BookingStatus.COMPLETED,
                BookingStatus.CANCELLED,
                BookingStatus.REFUNDED,
            ]),
        );
        expect(res.statusDistribution.length).toBe(5);
    });

    it('出行方式分布包含全部三种方式，仅统计有效订单', async () => {
        const res = await repo.getBookingDashboard('2026-08-01', '2026-08-08');
        const modes = res.travelModeDistribution.map((d) => d.travelMode);
        expect(modes).toEqual(
            expect.arrayContaining([TravelMode.SCENIC_BUS, TravelMode.SELF_DRIVING, TravelMode.TOUR_GROUP]),
        );
        expect(res.travelModeDistribution.length).toBe(3);
        // 8/4 completed scenicBus 3人 → scenicBus 1单 3人
        const bus = res.travelModeDistribution.find((d) => d.travelMode === TravelMode.SCENIC_BUS);
        expect(bus?.orderCount).toBe(1);
        expect(bus?.peopleCount).toBe(3);
        // 8/8 tourGroup confirmed 4人 → tourGroup 1单 4人
        const tour = res.travelModeDistribution.find((d) => d.travelMode === TravelMode.TOUR_GROUP);
        expect(tour?.orderCount).toBe(1);
        expect(tour?.peopleCount).toBe(4);
    });

    it('每日趋势补齐无数据日期为 0，日期连续且升序', async () => {
        const res = await repo.getBookingDashboard('2026-08-09', '2026-08-11');
        expect(res.dailyTrend.length).toBe(3);
        expect(res.dailyTrend.map((d) => d.date)).toEqual(['2026-08-09', '2026-08-10', '2026-08-11']);
        for (const d of res.dailyTrend) {
            expect(d.validOrderCount).toBe(0);
            expect(d.peopleCount).toBe(0);
            expect(d.selfDrivingVehicleCount).toBe(0);
            expect(d.receivedAmount).toBe(0);
        }
    });

    it('每日趋势某天有数据时正确聚合', async () => {
        const res = await repo.getBookingDashboard('2026-08-01', '2026-08-01');
        const d1 = res.dailyTrend[0];
        expect(d1.date).toBe('2026-08-01');
        expect(d1.validOrderCount).toBe(1);
        expect(d1.peopleCount).toBe(1);
        expect(d1.selfDrivingVehicleCount).toBe(1);
        expect(d1.receivedAmount).toBe(6600);
    });

    it('空范围返回全 0 和连续日期，不返回 null/NaN', async () => {
        const res = await repo.getBookingDashboard('2026-12-01', '2026-12-03');
        expect(res.summary.validOrderCount).toBe(0);
        expect(res.summary.totalPeople).toBe(0);
        expect(res.summary.selfDrivingVehicleCount).toBe(0);
        expect(res.summary.receivedAmount).toBe(0);
        expect(res.summary.freePeople).toBe(0);
        expect(res.summary.paidPeople).toBe(0);
        expect(res.dailyTrend.length).toBe(3);
        for (const d of res.dailyTrend) {
            expect(Number.isFinite(d.validOrderCount)).toBe(true);
            expect(Number.isFinite(d.receivedAmount)).toBe(true);
        }
    });
});

/**
 * 构造一条夹具订单
 */
function makeBooking(over: Partial<Omit<Booking, 'bookingDate'>> & { bookingId: string; bookingDate: string; status: BookingStatus; travelMode: TravelMode; personCount: number; wechatOpenId?: string }): Booking {
    const { bookingDate: dateStr, ...rest } = over;
    return {
        bookingId: over.bookingId,
        wechatOpenId: over.wechatOpenId || 'test-openid',
        passengers: null,
        name: '测试',
        phone: '13800000000',
        idCard: '110101199001011237',
        bookingDate: new Date(dateStr) as any,
        timeSlot: TimeSlot.MORNING,
        travelMode: over.travelMode,
        licensePlate: over.licensePlate,
        vehicleType: over.vehicleType,
        personCount: over.personCount,
        remarks: '',
        isFree: over.isFree ?? false,
        freeReason: over.freeReason,
        status: over.status,
        paymentStatus: over.paymentStatus ?? PaymentStatus.UNPAID,
        refundStatus: RefundStatus.NONE,
        amount: over.amount,
        createdAt: new Date() as any,
        updatedAt: new Date() as any,
        ...rest,
    } as Booking;
}

async function seedFixtures(bookingRepo: Repository<Booking>) {
    const fixtures: Booking[] = [
        // 8/1 confirmed paid 收费 1人 自驾 有车牌 amount=6600
        makeBooking({ bookingId: 'TL001', bookingDate: '2026-08-01', status: BookingStatus.CONFIRMED, travelMode: TravelMode.SELF_DRIVING, vehicleType: VehicleType.SMALL_CAR, licensePlate: '豫A12345', personCount: 1, paymentStatus: PaymentStatus.PAID, amount: 6600 }),
        // 8/2 pending 未支付 2人 自驾 有车牌 amount=6600（不计入有效）
        makeBooking({ bookingId: 'TL002', bookingDate: '2026-08-02', status: BookingStatus.PENDING, travelMode: TravelMode.SELF_DRIVING, vehicleType: VehicleType.SMALL_CAR, licensePlate: '豫A22222', personCount: 2, paymentStatus: PaymentStatus.UNPAID, amount: 6600 }),
        // 8/3 cancelled 已支付 1人（不计入有效，不计入实收）
        makeBooking({ bookingId: 'TL003', bookingDate: '2026-08-03', status: BookingStatus.CANCELLED, travelMode: TravelMode.SELF_DRIVING, vehicleType: VehicleType.SMALL_CAR, licensePlate: '豫A33333', personCount: 1, paymentStatus: PaymentStatus.PAID, amount: 6600 }),
        // 8/3 refunded 已退款 1人（不计入有效，不计入实收）
        makeBooking({ bookingId: 'TL004', bookingDate: '2026-08-03', status: BookingStatus.REFUNDED, travelMode: TravelMode.SELF_DRIVING, vehicleType: VehicleType.SMALL_CAR, licensePlate: '豫A44444', personCount: 1, paymentStatus: PaymentStatus.REFUNDED, amount: 6600 }),
        // 8/4 completed paid 免费 3人 景区摆渡车（无车牌）amount=0
        makeBooking({ bookingId: 'TL005', bookingDate: '2026-08-04', status: BookingStatus.COMPLETED, travelMode: TravelMode.SCENIC_BUS, personCount: 3, paymentStatus: PaymentStatus.PAID, amount: 0, isFree: true, freeReason: 'dailyQuota' }),
        // 8/5 confirmed 未支付 收费 1人 自驾 有车牌 amount=6600（不计入实收，但计入有效订单和人数）
        makeBooking({ bookingId: 'TL006', bookingDate: '2026-08-05', status: BookingStatus.CONFIRMED, travelMode: TravelMode.SELF_DRIVING, vehicleType: VehicleType.SMALL_CAR, licensePlate: '豫A55555', personCount: 1, paymentStatus: PaymentStatus.UNPAID, amount: 6600 }),
        // 8/6 confirmed paid 收费 2人 自驾 有车牌 amount=9900
        makeBooking({ bookingId: 'TL007', bookingDate: '2026-08-06', status: BookingStatus.CONFIRMED, travelMode: TravelMode.SELF_DRIVING, vehicleType: VehicleType.SMALL_CAR, licensePlate: '豫B67890', personCount: 2, paymentStatus: PaymentStatus.PAID, amount: 9900 }),
        // 8/7 confirmed paid 收费 1人 自驾 无车牌（不计入车辆数）amount=6600
        makeBooking({ bookingId: 'TL008', bookingDate: '2026-08-07', status: BookingStatus.CONFIRMED, travelMode: TravelMode.SELF_DRIVING, vehicleType: VehicleType.SMALL_CAR, licensePlate: null, personCount: 1, paymentStatus: PaymentStatus.PAID, amount: 6600 }),
        // 8/8 confirmed paid 收费 4人 观光团 amount=13200
        makeBooking({ bookingId: 'TL009', bookingDate: '2026-08-08', status: BookingStatus.CONFIRMED, travelMode: TravelMode.TOUR_GROUP, personCount: 4, paymentStatus: PaymentStatus.PAID, amount: 13200 }),
    ];
    await bookingRepo.save(fixtures);
}
