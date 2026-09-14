import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Booking, BookingStatus, PaymentStatus, RefundStatus, TimeSlot, TravelMode } from '../../entities/booking.entity';
import { BookingAnomaly } from '../../entities/booking-anomaly.entity';
import { SystemConfig } from '../../entities/system-config.entity';
import { BookingRepository } from '../../repositories/booking.repository';
import { BookingService, beijingDateStr } from './booking.service';
import { MemberService } from '../member/member.service';
import { WechatPayService } from '../wechat-pay/wechat-pay.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { AdminApplicationRepository } from '../../repositories/admin-application.repository';
import { UserProfileRepository } from '../../repositories/user-profile.repository';
import { RefundApplyRepository } from '../../repositories/refund-apply.repository';
import { LoggingService } from '../logging/logging.service';
import { MessageService } from '../message/message.service';
import { BookingController } from './booking.controller';

/**
 * 今日名额概览（GET /bookings/today-quota）回归测试。
 *
 * 本文件的核心不是「算得对」，而是【不泄漏】与【不违约】：
 *  - C 组锁住响应形状 —— 单价公开，故「已约人数 × 单价 ≈ 每日营收」，
 *    而「已约人数 = 总限额 − 剩余」，一旦有人顺手加回 total / maxPeople 就前功尽弃
 *  - D 组锁住「接口显示有剩余」⇒「下单真免费」，防止展示与下单口径分叉
 *  - F 组防止已移除的 bookingRank（= 当天已约人数）被加回
 *
 * 夹具身份证号按 MOD 11-2 生成，为虚构号码，不含真实用户信息。
 */
function makeIdCard(birth: string, seq = '001'): string {
    const prefix = '110101' + birth + seq;
    const factors = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    const checkCodes = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
    let sum = 0;
    for (let i = 0; i < 17; i++) {
        sum += parseInt(prefix[i], 10) * factors[i];
    }
    return prefix + checkCodes[sum % 11];
}

const ADULT_CARD = makeIdCard('19900101');
const UNIT_PRICE = 10000;
const FREE_LIMIT = 5;
/** 与服务端同一「当天」口径（北京时间），避免测试机时区导致误判 */
const TODAY = beijingDateStr();
// 相邻日期一律从 TODAY 推算而非写死：写死会随当天漂移，制造假失败
const YESTERDAY = (() => {
    const d = new Date(TODAY + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().substring(0, 10);
})();
const TOMORROW = (() => {
    const d = new Date(TODAY + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().substring(0, 10);
})();

const adult = (overrides: any = {}) => ({ name: '张三', phone: '13800000001', idCard: ADULT_CARD, ...overrides });

describe('getTodayQuotaOverview（今日名额概览）', () => {
    let service: BookingService;
    let bookingRepo: Repository<Booking>;
    let configRepo: Repository<SystemConfig>;
    /** getPaymentConfig 需委托真实仓储，否则测试内对配置表的写入对接口不生效 */
    let configRepoRef: Repository<SystemConfig> | null = null;
    /** 每个用例可改的限额，用于把 remaining 推入 / 推出「紧张」区间 */
    let timeSlotLimit: { morningMaxPeople: number; afternoonMaxPeople: number };

    let seq = 0;
    const seed = async (overrides: Partial<Booking> = {}) => {
        seq += 1;
        await bookingRepo.insert({
            bookingId: `TQ${String(seq).padStart(8, '0')}`,
            wechatOpenId: 'user-default',
            passengers: '[]',
            bookingDate: TODAY as any,
            timeSlot: TimeSlot.MORNING,
            travelMode: TravelMode.SCENIC_BUS,
            personCount: 1,
            isFree: false,
            status: BookingStatus.CONFIRMED,
            paymentStatus: PaymentStatus.PAID,
            refundStatus: RefundStatus.NONE,
            // 必须显式传：这两个是 NOT NULL，而其默认值写在 @BeforeInsert 钩子里，
            // repository.insert() 会跳过实体钩子 → 不传就 SQLITE_CONSTRAINT
            createdAt: new Date(),
            updatedAt: new Date(),
            ...overrides,
        } as any);
    };

    const setConfig = async (over: { freeQuotaEnabled?: boolean; freeQuotaLimit?: number } = {}) => {
        await configRepo.update(
            { configId: 'system_config' },
            {
                paymentConfigJson: JSON.stringify({
                    paymentAmount: UNIT_PRICE,
                    freeQuotaEnabled: over.freeQuotaEnabled ?? true,
                    freeQuotaLimit: over.freeQuotaLimit ?? FREE_LIMIT,
                }),
            },
        );
    };

    beforeAll(async () => {
        timeSlotLimit = { morningMaxPeople: 100, afternoonMaxPeople: 100 };

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
            providers: [
                BookingRepository,
                BookingService,
                { provide: MemberService, useValue: {} },
                { provide: WechatPayService, useValue: {} },
                {
                    provide: SystemConfigService,
                    useValue: {
                        isBookingEnabled: jest.fn().mockResolvedValue(true),
                        getBookingDisabledMessage: jest.fn().mockResolvedValue(''),
                        getTimeSlotLimit: jest.fn(async () => timeSlotLimit),
                        // 委托真实仓储：本文件大量用例靠改配置表来驱动行为，
                        // mock 成固定值会让这些用例静默失效
                        getPaymentConfig: jest.fn(async () => {
                            const row = await configRepoRef!.findOne({ where: { configId: 'system_config' } });
                            return row!.paymentConfig;
                        }),
                    },
                },
                { provide: AdminApplicationRepository, useValue: {} },
                { provide: UserProfileRepository, useValue: {} },
                // 退款申请仓库（资金结果镜像用）：本文件只走名额概览路径，不会被触达
                { provide: RefundApplyRepository, useValue: {} },
                { provide: LoggingService, useValue: { write: jest.fn().mockResolvedValue(undefined) } },
                // 站内信（T1 ② / T2 发送用）：本文件只走名额概览路径，不会被触达。
                // 它是一个**必填**依赖（不是可选注入），所以必须显式给一个桩，
                // 否则 Nest 在装配阶段就报 can't resolve dependencies。
                { provide: MessageService, useValue: {} },
            ],
        }).compile();

        service = moduleRef.get(BookingService);
        bookingRepo = moduleRef.get(getRepositoryToken(Booking));
        configRepo = moduleRef.get(getRepositoryToken(SystemConfig));
        configRepoRef = configRepo;

        await configRepo.save(
            configRepo.create({
                configId: 'system_config',
                paymentConfigJson: JSON.stringify({
                    paymentAmount: UNIT_PRICE,
                    freeQuotaEnabled: true,
                    freeQuotaLimit: FREE_LIMIT,
                }),
            }),
        );
    });

    beforeEach(async () => {
        timeSlotLimit = { morningMaxPeople: 100, afternoonMaxPeople: 100 };
        await bookingRepo.clear();
        await setConfig();
        // 方法内有 5 秒进程内 TTL 缓存（键为日期）。不清掉的话，同一用例文件里
        // 后面每个用例都会读到第一个用例的缓存值 —— 缓存本身另有专门用例覆盖。
        (service as any).todayQuotaCache = null;
        jest.clearAllMocks();
    });

    // ================= A. 容量口径 =================

    describe('A. 容量口径', () => {
        it('1. 今日无订单 → 名额充足，且【不下发任何数字】', async () => {
            const data = await service.getTodayQuotaOverview();

            // 「剩余 = 总限额」这个精确值在充足时刻意不可观测：这是本方案成立的前提，
            // 不是断言不便。数字只在 limited 分支才可被验证（见用例 2）
            expect(data.capacity.level).toBe('plenty');
            expect(data.capacity).toEqual({ level: 'plenty' });
            expect(data.date).toBe(TODAY);
        });

        it('2. morning 60 + afternoon 30 → 剩余 10（两桶必须相加）', async () => {
            // 最容易漏的一条：上下午概念已废弃，新单都是 morning，
            // 但历史数据里 afternoon 桶仍有记录，漏加会高估剩余、并在下单时被后端打回
            await seed({ timeSlot: TimeSlot.MORNING, personCount: 60 });
            await seed({ timeSlot: TimeSlot.AFTERNOON, personCount: 30 });

            const data = await service.getTodayQuotaOverview();

            expect(data.capacity.level).toBe('limited'); // 10 <= 100 * 0.3
            expect(data.capacity.remaining).toBe(10);
        });

        it('3. 超卖 → 剩余钳到 0 而非负数，且为「已满」', async () => {
            await seed({ personCount: 120 });

            const data = await service.getTodayQuotaOverview();

            expect(data.capacity).toEqual({ level: 'full' });
        });

        it('4. cancelled / refunded 不计入已约人数', async () => {
            await seed({ personCount: 90 });
            await seed({ personCount: 50, status: BookingStatus.CANCELLED });
            await seed({ personCount: 50, status: BookingStatus.REFUNDED, refundStatus: RefundStatus.REFUNDED });

            const data = await service.getTodayQuotaOverview();

            expect(data.capacity.remaining).toBe(10);
        });

        it('5. 昨日 / 明日订单不计入（锁住 SQLite 纯日期字符串比较）', async () => {
            await seed({ personCount: 90 });
            await seed({ bookingDate: YESTERDAY as any, personCount: 50 });
            await seed({ bookingDate: TOMORROW as any, personCount: 50 });

            const data = await service.getTodayQuotaOverview();

            expect(data.capacity.remaining).toBe(10);
        });
    });

    // ================= B. 免费额度口径 =================

    describe('B. 免费额度口径', () => {
        const quotaOrder = (openid: string, over: Partial<Booking> = {}) =>
            seed({
                wechatOpenId: openid,
                isFree: true,
                freeReason: 'dailyQuota',
                paymentStatus: PaymentStatus.PAID,
                ...over,
            });

        it('6. freeQuotaEnabled=false → enabled=false，容量行不受影响', async () => {
            await setConfig({ freeQuotaEnabled: false });
            await seed({ personCount: 90 });

            const data = await service.getTodayQuotaOverview();

            expect(data.freeQuota.enabled).toBe(false);
            expect(data.capacity.level).toBe('limited');
            expect(data.capacity.remaining).toBe(10);
        });

        it('7. 今日 3 个不同 openid 的 dailyQuota 单 → 剩余 = limit − 3', async () => {
            await quotaOrder('u-a');
            await quotaOrder('u-b');
            await quotaOrder('u-c');

            const data = await service.getTodayQuotaOverview();

            expect(data.freeQuota).toEqual({ enabled: true, limit: FREE_LIMIT, remaining: FREE_LIMIT - 3 });
        });

        it('8. 同一 openid 两单 → 只占 1 个名额（COUNT DISTINCT）', async () => {
            await quotaOrder('u-same');
            await quotaOrder('u-same');

            const data = await service.getTodayQuotaOverview();

            expect(data.freeQuota.remaining).toBe(FREE_LIMIT - 1);
        });

        it('9. freeReason 为 member / age 的免费单不占每日名额', async () => {
            await quotaOrder('u-member', { freeReason: 'member' });
            await quotaOrder('u-age', { freeReason: 'age' });

            const data = await service.getTodayQuotaOverview();

            expect(data.freeQuota.remaining).toBe(FREE_LIMIT);
        });

        it('10. cancelled 的 dailyQuota 单仍占名额（取消不退名额的回归锁）', async () => {
            await quotaOrder('u-cancel', { status: BookingStatus.CANCELLED });

            const data = await service.getTodayQuotaOverview();

            expect(data.freeQuota.remaining).toBe(FREE_LIMIT - 1);
        });
    });

    // ================= C. 敏感字段红线（本文件最高价值） =================

    describe('C. 敏感字段红线', () => {
        it('11. 响应结构与字段白名单恒定，任何新增暴露字段立刻失败', async () => {
            const data = await service.getTodayQuotaOverview();

            // 顶层只有这三个键
            expect(Object.keys(data)).toEqual(['date', 'capacity', 'freeQuota']);
            // capacity 只有 level；带 remaining 或加 total 立刻炸
            expect(data.capacity).toEqual({ level: 'plenty' });
            // freeQuota 不返回 used（它可由 limit − remaining 推出，返回没有收益）
            expect(Object.keys(data.freeQuota).sort()).toEqual(['enabled', 'limit', 'remaining']);
        });

        it('11b. 序列化后仍不含任何「已约人数」线索', async () => {
            await seed({ personCount: 42 });

            const raw = JSON.stringify(await service.getTodayQuotaOverview());

            // 「已约人数 = 总限额 − 剩余」，故总限额本身就是答案
            for (const banned of ['maxPeople', 'totalPeople', 'currentPeople', 'bookedPeople', 'bookingCount', 'total', 'used']) {
                expect(raw).not.toContain(banned);
            }
        });
    });

    // ================= D. 口径一致性 / 承诺不违约 =================

    describe('D. 与下单口径一致（展示与下单必须同源）', () => {
        it('12. 同一 DB 下，接口剩余与 preview 的 freeQuotaInfo.remaining 恒等', async () => {
            await seed({ wechatOpenId: 'u-x', isFree: true, freeReason: 'dailyQuota' });
            await seed({ wechatOpenId: 'u-y', isFree: true, freeReason: 'dailyQuota' });

            const overview = await service.getTodayQuotaOverview();
            const preview = await service.determineFreeEligibility('u-fresh', [adult()], TODAY, TravelMode.SCENIC_BUS);

            expect(preview.freeQuotaInfo).not.toBeNull();
            expect(overview.freeQuota.remaining).toBe(preview.freeQuotaInfo!.remaining);
            expect(overview.freeQuota.limit).toBe(preview.freeQuotaInfo!.limit);
        });

        it('13. 剩余 1 个时：接口显示 1，且下单【真的免费】', async () => {
            await setConfig({ freeQuotaLimit: 3 });
            await seed({ wechatOpenId: 'u-a', isFree: true, freeReason: 'dailyQuota' });
            await seed({ wechatOpenId: 'u-b', isFree: true, freeReason: 'dailyQuota' });

            const overview = await service.getTodayQuotaOverview();
            expect(overview.freeQuota.remaining).toBe(1);

            const preview = await service.determineFreeEligibility('u-fresh', [adult()], TODAY, TravelMode.SCENIC_BUS);
            expect(preview.isFree).toBe(true);
            expect(preview.freeReason).toBe('dailyQuota');
        });

        it('14. 剩余 0 个时：接口显示 0，且下单【必然收费】', async () => {
            await setConfig({ freeQuotaLimit: 2 });
            await seed({ wechatOpenId: 'u-a', isFree: true, freeReason: 'dailyQuota' });
            await seed({ wechatOpenId: 'u-b', isFree: true, freeReason: 'dailyQuota' });

            const overview = await service.getTodayQuotaOverview();
            expect(overview.freeQuota.remaining).toBe(0);

            const preview = await service.determineFreeEligibility('u-fresh', [adult()], TODAY, TravelMode.SCENIC_BUS);
            expect(preview.isFree).toBe(false);
            expect(preview.reason).toBe('daily_quota_full');
        });

        it('14b. 未来日期的 dailyQuota 单不占用「今日」名额', async () => {
            const before = await service.getTodayQuotaOverview();

            await seed({ bookingDate: TOMORROW as any, wechatOpenId: 'u-future', isFree: true, freeReason: 'dailyQuota' });

            // 必须清缓存，否则 after 会命中 5 秒 TTL 直接返回旧值，本用例假绿
            (service as any).todayQuotaCache = null;
            const after = await service.getTodayQuotaOverview();
            expect(after.freeQuota.remaining).toBe(before.freeQuota.remaining);
        });
    });

    // ================= E. 路由 =================

    describe('E. 路由', () => {
        const proto = BookingController.prototype as any;

        it('15. 路径为单段 today-quota，且声明在 :bookingId 参数路由之前', async () => {
            expect(Reflect.getMetadata('path', proto.getTodayQuota)).toBe('today-quota');

            const methods: string[] = Object.getOwnPropertyNames(proto);
            expect(methods.indexOf('getTodayQuota')).toBeGreaterThan(-1);
            expect(methods.indexOf('getTodayQuota')).toBeLessThan(methods.indexOf('getBookingById'));
        });

        it('15b. 路由【无 guard】—— 匿名可访问是产品决策，不是遗漏', async () => {
            expect(Reflect.getMetadata('__guards__', proto.getTodayQuota)).toBeUndefined();
        });

        it('15c. 控制器只透传服务结果，不额外拼装字段', async () => {
            const payload = { date: TODAY, capacity: { level: 'plenty' }, freeQuota: { enabled: true, limit: 5, remaining: 5 } };
            // 第二参数是退款申请服务（订单详情下发 refundEntry 用），本用例不触及
            const controller = new BookingController(
                { getTodayQuotaOverview: jest.fn().mockResolvedValue(payload) } as any,
                null as any,
            );
            const res: any = { status: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() };

            await controller.getTodayQuota(res);

            expect(res.status).toHaveBeenCalledWith(200);
            expect(res.send).toHaveBeenCalledWith({ success: true, data: payload });
        });
    });

    // ================= F. bookingRank 已移除 =================

    describe('F. bookingRank（当天已约人数）不得回归', () => {
        it('16. preview 返回值不含 bookingRank', async () => {
            await seed({ personCount: 42 });

            const preview = await service.determineFreeEligibility('u-1', [adult()], TODAY, TravelMode.SCENIC_BUS);

            // 该字段等于 SUM(personCount) WHERE bookingDate=所选日期 AND status IN (pending,confirmed)，
            // 即「当天已约人数」本身。单价公开 ⇒ 已约人数 × 单价 ≈ 每日营收。
            // 零消费方，已于 2026-09 连同其查询一并删除，此处锁死防止被加回。
            expect(preview).not.toHaveProperty('bookingRank');
            expect(JSON.stringify(preview)).not.toContain('bookingRank');
        });
    });

    // ================= G. 进程内 TTL 缓存 =================

    describe('G. 缓存（本接口匿名且无限流，缓存是限流的替代品）', () => {
        afterEach(() => jest.restoreAllMocks());

        it('17. 同一窗口内重复调用只查一次库', async () => {
            const spy = jest.spyOn((service as any).bookingRepository, 'getBookingStatsByDate');

            await service.getTodayQuotaOverview();
            await service.getTodayQuotaOverview();
            await service.getTodayQuotaOverview();

            // 缓存失效 = 匿名接口可被脚本高频抓取，挤压 SQLite 单 writer 的写预算
            expect(spy).toHaveBeenCalledTimes(1);
        });

        it('18. 缓存到期后重新计算，不会永久驻留', async () => {
            const spy = jest.spyOn((service as any).bookingRepository, 'getBookingStatsByDate');

            await service.getTodayQuotaOverview();
            (service as any).todayQuotaCache.expireAt = Date.now() - 1; // 直接推过期，不真实等待 5 秒

            await service.getTodayQuotaOverview();

            // 缓存若永不失效，跨天或配置变更后前端会一直看着旧数字
            expect(spy).toHaveBeenCalledTimes(2);
        });
    });
});
