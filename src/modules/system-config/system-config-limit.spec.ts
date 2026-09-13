import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { SystemConfig } from '../../entities/system-config.entity';
import { Booking, BookingStatus, PaymentStatus, RefundStatus, TimeSlot, TravelMode } from '../../entities/booking.entity';
import { BookingAnomaly } from '../../entities/booking-anomaly.entity';
import { SystemConfigRepository } from '../../repositories/system-config.repository';
import { BookingRepository } from '../../repositories/booking.repository';
import { SystemConfigService } from './system-config.service';
import { SystemConfigController } from './system-config.controller';
import { UpdateSystemConfigDto } from './dto/update-system-config.dto';
import { BookingService, beijingDateStr } from '../booking/booking.service';
import { BookingController } from '../booking/booking.controller';
import { CreateBookingDto } from '../booking/dto/createBooking.dto';
import { MemberService } from '../member/member.service';
import { WechatPayService } from '../wechat-pay/wechat-pay.service';
import { AdminApplicationRepository } from '../../repositories/admin-application.repository';
import { UserProfileRepository } from '../../repositories/user-profile.repository';
import { LoggingService } from '../logging/logging.service';

/**
 * 「后台设置今日最大预约单量 → 下单真的被拦住」全链路诊断。
 *
 * 静态读代码时这条链每一环单看都对，所以本文件的价值在于**把每一环真的跑一遍**，
 * 并让失败落在具体那一环上：
 *   1. admin 的 payload 经真实全局管道 → DTO          （管道剥离白名单/隐式转换）
 *   2. DTO → 仓储 Object.assign → 实体 setter → 列     （写入路径能不能落到 timeSlotLimitJson）
 *   3. 列 → 读回 config.timeSlotLimit                  （读回路径）
 *   4. createBooking 的容量判定                        （真正的拦截点）
 *
 * 第 1 环用 main.ts:37-60 逐字同配置：这个管道带 whitelist + enableImplicitConversion，
 * 与「设置悄悄不生效」这类故障高度相关，绝不能用裸对象绕过它。
 */

/** 与 main.ts 的 useGlobalPipes 逐字同配置 */
const realPipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: false,
    transformOptions: { enableImplicitConversion: true },
    exceptionFactory: (errors) => new BadRequestException(errors),
});

const ADMIN_KEY = 'admin-key';

const makeIdCard = (birth: string, seq = '001'): string => {
    const prefix = '110101' + birth + seq;
    const factors = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    const checkCodes = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
    let sum = 0;
    for (let i = 0; i < 17; i++) sum += parseInt(prefix[i], 10) * factors[i];
    return prefix + checkCodes[sum % 11];
};
const ADULT_CARD = makeIdCard('19900101');
const adult = (over: any = {}) => ({ name: '张三', phone: '13800000001', idCard: ADULT_CARD, ...over });

/** admin/src/pages/system-config/index.tsx:106-123 的 payload，字段与嵌套形状逐字照抄 */
const adminPayload = (morningMaxPeople: number) => ({
    bookingEnabled: true,
    bookingDisabledMessage: '当前时间段暂不开放预约，请稍后再试',
    banners: [],
    timeSlotLimit: { morningMaxPeople, afternoonMaxPeople: 0 },
    paymentConfig: { paymentAmount: 0, freeQuotaEnabled: false, freeQuotaLimit: 100 },
    noticeConfig: { enabled: true, content: 'x' },
});

describe('后台「今日最大预约单量」全链路', () => {
    let controller: SystemConfigController;
    let configService: SystemConfigService;
    let configRepo: Repository<SystemConfig>;
    let bookingService: BookingService;
    let bookingRepo: Repository<Booking>;
    /** 自定义仓储：getBookingStatsByDate 在这里，不在原生 Repository 上 */
    let customBookingRepo: BookingRepository;

    let seq = 0;
    const seedBooking = async (over: Partial<Booking> = {}) => {
        seq += 1;
        await bookingRepo.insert({
            bookingId: `SC${String(seq).padStart(8, '0')}`,
            wechatOpenId: 'user-default',
            passengers: '[]',
            bookingDate: beijingDateStr() as any,
            timeSlot: TimeSlot.MORNING,
            travelMode: TravelMode.SCENIC_BUS,
            personCount: 1,
            isFree: false,
            status: BookingStatus.CONFIRMED,
            paymentStatus: PaymentStatus.PAID,
            refundStatus: RefundStatus.NONE,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...over,
        } as any);
    };

    /** 模拟 admin 点保存：真实管道 + 真实控制器 */
    const saveViaAdmin = async (morningMaxPeople: number) => {
        const dto = await realPipe.transform(adminPayload(morningMaxPeople), {
            type: 'body',
            metatype: UpdateSystemConfigDto,
        });
        const res: any = { status: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() };
        await controller.updateConfig(dto, res);
        return res;
    };

    /** 绕开一切缓存，直接从库里读原始列 */
    const rawColumn = async () => (await configRepo.findOne({ where: { configId: 'system_config' } }))!.timeSlotLimitJson;

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'sqlite',
                    database: ':memory:',
                    synchronize: true,
                    dropSchema: true,
                    entities: [Booking, BookingAnomaly, SystemConfig],
                }),
                TypeOrmModule.forFeature([Booking, BookingAnomaly, SystemConfig]),
            ],
            controllers: [SystemConfigController],
            providers: [
                SystemConfigRepository,
                SystemConfigService,
                BookingRepository,
                BookingService,
                { provide: MemberService, useValue: {} },
                { provide: WechatPayService, useValue: {} },
                { provide: AdminApplicationRepository, useValue: {} },
                { provide: UserProfileRepository, useValue: {} },
                { provide: LoggingService, useValue: { write: jest.fn().mockResolvedValue(undefined) } },
            ],
        }).compile();

        controller = moduleRef.get(SystemConfigController);
        configService = moduleRef.get(SystemConfigService);
        configRepo = moduleRef.get(getRepositoryToken(SystemConfig));
        bookingService = moduleRef.get(BookingService);
        bookingRepo = moduleRef.get(getRepositoryToken(Booking));
        customBookingRepo = moduleRef.get(BookingRepository);
        void ADMIN_KEY;
    });

    beforeEach(async () => {
        await bookingRepo.clear();
        await configRepo.clear();
    });

    // ============ 第 1+2+3 环：写入 → 落库 → 读回 ============

    it('A. admin 保存 37 → timeSlotLimitJson 真的变成 37，且读回一致', async () => {
        await configService.getConfig(); // 触发默认行创建（走 repository:33 的 1000）

        await saveViaAdmin(37);

        // 第 2 环：原始列
        expect(JSON.parse(await rawColumn()).morningMaxPeople).toBe(37);
        // 第 3 环：业务读回
        expect((await configService.getTimeSlotLimit()).morningMaxPeople).toBe(37);
    });

    it('B. 反复保存取最后一次（不是「第一次生效、后续被默认值盖掉」）', async () => {
        await configService.getConfig();

        await saveViaAdmin(37);
        await saveViaAdmin(12);
        await saveViaAdmin(5);

        expect((await configService.getTimeSlotLimit()).morningMaxPeople).toBe(5);
    });

    it('C. 未经管道的裸 payload 也不影响结果（排除管道是变量）', async () => {
        await configService.getConfig();

        await configService.updateConfig({
            timeSlotLimit: { morningMaxPeople: 21, afternoonMaxPeople: 0 },
        } as any);

        expect((await configService.getTimeSlotLimit()).morningMaxPeople).toBe(21);
    });

    it('D. morningMaxPeople=0 会被 DTO 拒绝（@Min(1)），不会静默写成 0', async () => {
        await expect(
            realPipe.transform(adminPayload(0), { type: 'body', metatype: UpdateSystemConfigDto }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    // ============ 第 4 环：真正的拦截点 ============

    it('E. 限额 5、已有 5 人 → createBooking 必须抛「已达上限」', async () => {
        await configService.getConfig();
        await saveViaAdmin(5);
        await seedBooking({ personCount: 5 });

        await expect(
            bookingService.createBooking({
                bookingDate: beijingDateStr(),
                timeSlot: TimeSlot.MORNING,
                travelMode: TravelMode.SCENIC_BUS,
                personCount: 1,
                passengers: [adult()],
                wechatOpenId: 'u-new',
            } as any),
        ).rejects.toThrow(/已达上限/);
    });

    it('F. 限额 5、已有 4 人 → 放行（不能误伤）', async () => {
        await configService.getConfig();
        await saveViaAdmin(5);
        await seedBooking({ personCount: 4 });

        // 放行后的路径会进事务并调用微信支付，这里只断言「没被容量判定拦下」
        const err = await bookingService
            .createBooking({
                bookingDate: beijingDateStr(),
                timeSlot: TimeSlot.MORNING,
                travelMode: TravelMode.SCENIC_BUS,
                personCount: 1,
                passengers: [adult()],
                wechatOpenId: 'u-new',
            } as any)
            .then(() => null)
            .catch((e: Error) => e);

        expect(err === null || !/已达上限/.test(err.message)).toBe(true);
    });

    it('G. 昨日订单不占今日限额（限额 5 + 昨日 5 人 → 今日仍放行）', async () => {
        await configService.getConfig();
        await saveViaAdmin(5);

        const d = new Date(beijingDateStr() + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() - 1);
        await seedBooking({ personCount: 5, bookingDate: d.toISOString().substring(0, 10) as any });

        const err = await bookingService
            .createBooking({
                bookingDate: beijingDateStr(),
                timeSlot: TimeSlot.MORNING,
                travelMode: TravelMode.SCENIC_BUS,
                personCount: 1,
                passengers: [adult()],
                wechatOpenId: 'u-new',
            } as any)
            .then(() => null)
            .catch((e: Error) => e);

        expect(err === null || !/已达上限/.test(err.message)).toBe(true);
    });

    it('I. fctl 原样 payload 经真实管道 + 真实控制器 → 仍被拦下', async () => {
        await configService.getConfig();
        await saveViaAdmin(5);
        await seedBooking({ personCount: 5 });

        // fctl/pages/booking-form/booking-form.vue:1275-1288 的 submitData 逐字照抄
        const fctlBody = {
            passengers: [
                { name: '张三', phone: '13800000001', idCard: ADULT_CARD, passengerType: 'adult', idCardUnavailable: false },
            ],
            bookingDate: beijingDateStr(),
            timeSlot: 'morning',
            travelMode: 'scenicBus',
            licensePlate: undefined,
            vehicleType: undefined,
            tourGroupName: undefined,
            tourOrderNumber: undefined,
            personCount: 1,
            remarks: '',
            wechatOpenId: 'o-from-body', // DTO 里没有这个字段，会被 whitelist 剥掉（无影响，控制器用 JWT 的 openid）
            isAdmin: false,
        };

        // 这一层是此前测试的盲区：前面 E~H 都是裸对象直调 service，绕过了全局管道。
        // 若管道剥掉/改写了 bookingDate 或 personCount，判定就会静默失效。
        const dto = await realPipe.transform(fctlBody, { type: 'body', metatype: CreateBookingDto });
        const controller = new BookingController(bookingService);
        const res: any = { status: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() };

        await expect(
            controller.createBooking(dto, { user: { openid: 'o-jwt' } } as any, res),
        ).rejects.toThrow(/已达上限/);
    });

    it('J. 同一 fctl payload 在限额未满时放行（证明 I 不是恒抛）', async () => {
        await configService.getConfig();
        await saveViaAdmin(5);
        await seedBooking({ personCount: 1 });

        const dto = await realPipe.transform(
            {
                passengers: [
                    { name: '张三', phone: '13800000001', idCard: ADULT_CARD, passengerType: 'adult', idCardUnavailable: false },
                ],
                bookingDate: beijingDateStr(),
                timeSlot: 'morning',
                travelMode: 'scenicBus',
                personCount: 1,
                remarks: '',
                isAdmin: false,
            },
            { type: 'body', metatype: CreateBookingDto },
        );
        const controller = new BookingController(bookingService);

        const err = await controller
            .createBooking(dto, { user: { openid: 'o-jwt' } } as any, {
                status: jest.fn().mockReturnThis(),
                send: jest.fn().mockReturnThis(),
            } as any)
            .then(() => null)
            .catch((e: Error) => e);

        expect(err === null || !/已达上限/.test(err.message)).toBe(true);
    });

    it('K. 【故障复现】bookingDate 非纯 YYYY-MM-DD 的行会被容量统计整体漏掉', async () => {
        const today = beijingDateStr();

        // 绕过实体 transformer，直接写一行「带时间部分的日期」——模拟生产库里
        // 由历史代码/手工 SQL 写入的脏数据（生产 synchronize:false，schema 由人工维护）
        await bookingRepo.query(
            `INSERT INTO bookings (bookingId, wechatOpenId, passengers, bookingDate, timeSlot, travelMode,
                 personCount, isFree, status, paymentStatus, refundStatus, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ['DIRTY001', 'u-dirty', '[]', today + 'T00:00:00.000Z', 'morning', 'scenicBus',
             9, 0, 'confirmed', 'paid', 'none', Date.now(), Date.now()],
        );

        const stats = await customBookingRepo.getBookingStatsByDate(today);

        // 这行有 9 人，但统计看不见它 —— 字符串比较下 "2026-09-12T..." > "2026-09-12"，<= 不成立。
        // 后果：currentPeople 恒偏小 → 限额迟迟不触发，且**不报任何错**。
        expect(stats.morning.totalPeople).toBe(0);

        // 对照：同样的 9 人，日期是纯字符串时统计得到
        await seedBooking({ personCount: 9 });
        expect((await customBookingRepo.getBookingStatsByDate(today)).morning.totalPeople).toBe(9);
    });

    it('L. 【生产排查用】上面的脏数据会让限额失效（限额 5 + 脏行 9 人 → 仍放行）', async () => {
        await configService.getConfig();
        await saveViaAdmin(5);

        await bookingRepo.query(
            `INSERT INTO bookings (bookingId, wechatOpenId, passengers, bookingDate, timeSlot, travelMode,
                 personCount, isFree, status, paymentStatus, refundStatus, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ['DIRTY002', 'u-dirty', '[]', beijingDateStr() + 'T00:00:00.000Z', 'morning', 'scenicBus',
             9, 0, 'confirmed', 'paid', 'none', Date.now(), Date.now()],
        );

        const err = await bookingService
            .createBooking({
                bookingDate: beijingDateStr(),
                timeSlot: TimeSlot.MORNING,
                travelMode: TravelMode.SCENIC_BUS,
                personCount: 1,
                passengers: [adult()],
                wechatOpenId: 'u-new',
            } as any)
            .then(() => null)
            .catch((e: Error) => e);

        // 库里其实已有 9 人（限额 5），但因日期格式不匹配，判定算作 0 人 → 放行。
        // 这就是「后台设置了限额却从来没拦住」在代码逻辑上唯一的可复现成因。
        expect(err === null || !/已达上限/.test(err.message)).toBe(true);
    });

    it('M. 【关键】JSON 合法但缺 morningMaxPeople → 限额静默失效，永不拦截', async () => {
        // 模拟生产库里那行是 {"afternoonMaxPeople":0}（键缺失）。
        // JSON.stringify 会丢弃值为 undefined 的属性，所以「admin 读到的字段是 undefined」
        // 和「库里就是缺这个键」是同一个形态，互为指纹。
        await configRepo.save(
            configRepo.create({ configId: 'system_config', timeSlotLimitJson: '{"afternoonMaxPeople":0}' }),
        );

        // getter 的两条兜底都拦不住：'||' 只管 null/空串，catch 只管 JSON 语法错误。
        // JSON.parse('{"afternoonMaxPeople":0}') 成功返回，但 morningMaxPeople 是 undefined。
        expect((await configService.getTimeSlotLimit()).morningMaxPeople).toBeUndefined();

        await seedBooking({ personCount: 50 }); // 远超任何合理限额

        const err = await bookingService
            .createBooking({
                bookingDate: beijingDateStr(),
                timeSlot: TimeSlot.MORNING,
                travelMode: TravelMode.SCENIC_BUS,
                personCount: 1,
                passengers: [adult()],
                wechatOpenId: 'u-new',
            } as any)
            .then(() => null)
            .catch((e: Error) => e);

        // maxPeople === undefined ⇒ `currentPeople + personCount > undefined` ≡ false，
        // 判定与 `> NaN` 等价，恒不成立 ⇒ 限额彻底失效，且日志里连一条 WARN 都不会有。
        expect(err === null || !/已达上限/.test(err.message)).toBe(true);
    });

    it('N. 同一故障对「今日名额」接口同样成立（remaining 变 NaN → 永远显示充足）', async () => {
        await configRepo.save(
            configRepo.create({ configId: 'system_config', timeSlotLimitJson: '{"afternoonMaxPeople":0}' }),
        );
        await seedBooking({ personCount: 900 });

        const overview = await bookingService.getTodayQuotaOverview();

        // 与下单口径一致地「一起坏」：页面显示充足，下单也确实不拦 —— 不会出现承诺违约，
        // 但整个限额能力静默归零，运营侧只会看到「设置了没用」。
        expect(overview.capacity).toEqual({ level: 'plenty' });
    });

    it('H. cancelled 订单不占限额（限额 1 + 今日 1 条已取消 → 放行）', async () => {
        await configService.getConfig();
        await saveViaAdmin(1);
        await seedBooking({ personCount: 9, status: BookingStatus.CANCELLED });

        const err = await bookingService
            .createBooking({
                bookingDate: beijingDateStr(),
                timeSlot: TimeSlot.MORNING,
                travelMode: TravelMode.SCENIC_BUS,
                personCount: 1,
                passengers: [adult()],
                wechatOpenId: 'u-new',
            } as any)
            .then(() => null)
            .catch((e: Error) => e);

        expect(err === null || !/已达上限/.test(err.message)).toBe(true);
    });
});
