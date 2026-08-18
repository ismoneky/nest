import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Booking, BookingStatus, PaymentStatus, RefundStatus, TimeSlot, TravelMode, VehicleType } from '../../entities/booking.entity';
import { BookingAnomaly } from '../../entities/booking-anomaly.entity';
import { SystemConfig } from '../../entities/system-config.entity';
import { BookingRepository } from '../../repositories/booking.repository';
import { BookingService, beijingDateStr, composeOrderPricing } from './booking.service';
import { MemberService } from '../member/member.service';
import { WechatPayService } from '../wechat-pay/wechat-pay.service';
import { SystemConfigService } from '../system-config/system-config.service';
import { AdminApplicationRepository } from '../../repositories/admin-application.repository';
import { UserProfileRepository } from '../../repositories/user-profile.repository';
import { LoggingService } from '../logging/logging.service';
import { calculateAgePricing, PassengerType } from './passenger-pricing';
import { PassengerErrorCode } from '../../common/passenger-business.exception';
import { PreviewBookingDto } from './dto/previewBooking.dto';

/**
 * 优惠优先级、金额与历史快照回归测试。
 * 夹具均为按 MOD 11-2 生成的虚构身份证号码，不含真实用户信息。
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
const MEMBER_CARD = makeIdCard('19850101');
const CHILD_13_CARD = makeIdCard('20130101'); // 2026 年预约时年龄 13
const CHILD_14_CARD = makeIdCard('20120101'); // 2026 年预约时年龄 14
const SENIOR_70_CARD = makeIdCard('19560101'); // 2026 年预约时年龄 70
const UNIT_PRICE = 10000;
const BOOKING_DATE = '2026-09-01'; // 非今天，避免干扰每日免费分支
// 与服务端同一“当天”口径（北京时间），避免测试机时区导致误判
const TODAY = beijingDateStr();

const adult = (overrides: any = {}) => ({ name: '张三', phone: '13800000001', idCard: ADULT_CARD, ...overrides });

describe('beijingDateStr（每日免费的“当天”口径）', () => {
    it('北京时间凌晨（UTC 前一天 16:00 之后）应算作北京时间第二天', () => {
        // 2026-08-13T16:30Z = 北京时间 2026-08-14 00:30
        expect(beijingDateStr(new Date('2026-08-13T16:30:00Z'))).toBe('2026-08-14');
        // 2026-08-13T15:59Z = 北京时间 2026-08-13 23:59，仍属 13 号
        expect(beijingDateStr(new Date('2026-08-13T15:59:00Z'))).toBe('2026-08-13');
    });

    it('北京时间正午口径与服务器时区无关', () => {
        // 2026-08-14T04:00Z = 北京时间 2026-08-14 12:00
        expect(beijingDateStr(new Date('2026-08-14T04:00:00Z'))).toBe('2026-08-14');
    });
});

describe('composeOrderPricing 纯函数（优惠顺序与金额公式）', () => {
    it('年龄免费关闭：两名 70 岁老人均收费，金额 2*unitPrice、isFree=false', () => {
        // 两名 70 岁老人（AGE_FREE_ENABLED=false，仅自动打标 senior，不免费）
        const ageSummary = calculateAgePricing(
            [
                { name: '老人甲', phone: '13800000001', idCard: SENIOR_70_CARD, passengerType: PassengerType.SENIOR },
                { name: '老人乙', phone: '13800000002', idCard: makeIdCard('19550101'), passengerType: PassengerType.SENIOR },
            ],
            BOOKING_DATE,
        );
        expect(ageSummary.ageFreePeople).toBe(0);
        const result = composeOrderPricing(ageSummary, 2, UNIT_PRICE, null);
        expect(result.amount).toBe(2 * UNIT_PRICE);
        expect(result.isFree).toBe(false);
        expect(result.freeReason).toBeNull();
        expect(result.chargedPeople).toBe(2);
        expect(result.ageFreePeople).toBe(0);
    });

    it('一名 13 岁儿童 + 一名成人：年龄免费关闭，收费人数 2、金额 2*unitPrice', () => {
        const ageSummary = calculateAgePricing(
            [adult(), { name: '儿童', phone: '13800000002', idCard: CHILD_13_CARD, passengerType: PassengerType.CHILD }],
            BOOKING_DATE,
        );
        const result = composeOrderPricing(ageSummary, 2, UNIT_PRICE, null);
        expect(result.amount).toBe(2 * UNIT_PRICE);
        expect(result.isFree).toBe(false);
        expect(result.freeReason).toBeNull();
        expect(result.chargedPeople).toBe(2);
        expect(result.ageFreePeople).toBe(0);
        expect(result.passengerPricing[1].pricingReason).toBe('regular');
        expect(result.passengerPricing[0].pricingReason).toBe('regular');
    });

    it('会员整单免费：所有人员 finalCharged=false、pricingReason=member_order_free', () => {
        const ageSummary = calculateAgePricing(
            [adult(), { name: '儿童', phone: '13800000002', idCard: CHILD_13_CARD, passengerType: PassengerType.CHILD }],
            BOOKING_DATE,
        );
        const result = composeOrderPricing(ageSummary, 2, UNIT_PRICE, 'member');
        expect(result.amount).toBe(0);
        expect(result.isFree).toBe(true);
        expect(result.freeReason).toBe('member');
        expect(result.chargedPeople).toBe(0);
        expect(result.ageFreePeople).toBe(0);
        expect(result.passengerPricing.every((p) => p.finalCharged === false)).toBe(true);
        expect(result.passengerPricing.every((p) => p.pricingReason === 'member_order_free')).toBe(true);
    });

    it('每日免费整单免费：pricingReason=daily_quota_order_free', () => {
        const ageSummary = calculateAgePricing([adult()], BOOKING_DATE);
        const result = composeOrderPricing(ageSummary, 1, UNIT_PRICE, 'dailyQuota');
        expect(result.amount).toBe(0);
        expect(result.freeReason).toBe('dailyQuota');
        expect(result.passengerPricing[0].pricingReason).toBe('daily_quota_order_free');
    });

    it('无身份证儿童：ageFree=false、finalCharged=true、pricingReason=id_card_unavailable', () => {
        const ageSummary = calculateAgePricing(
            [adult(), { name: '儿童', phone: '13800000002', idCard: '', passengerType: PassengerType.CHILD, idCardUnavailable: true }],
            BOOKING_DATE,
        );
        const result = composeOrderPricing(ageSummary, 2, UNIT_PRICE, null);
        expect(result.chargedPeople).toBe(2);
        expect(result.amount).toBe(2 * UNIT_PRICE);
        const child = result.passengerPricing[1];
        expect(child.ageFree).toBe(false);
        expect(child.finalCharged).toBe(true);
        expect(child.pricingReason).toBe('id_card_unavailable');
        expect(child.ageValue).toBeNull();
    });
});

describe('determineFreeEligibility / createBooking 集成', () => {
    let service: BookingService;
    let bookingRepo: Repository<Booking>;
    let configRepo: Repository<SystemConfig>;
    let memberServiceMock: { getActiveMemberByIdCard: jest.Mock };
    let userProfileRepositoryMock: { upsertProfiles: jest.Mock };
    let loggingServiceMock: { write: jest.Mock };

    beforeAll(async () => {
        memberServiceMock = {
            getActiveMemberByIdCard: jest.fn().mockImplementation(async (idCard: string) => {
                if (idCard === MEMBER_CARD) {
                    return { name: '王会员', endDate: new Date(Date.now() + 30 * 86400000), licensePlates: '豫A12345;豫B12345' };
                }
                return null;
            }),
        };
        userProfileRepositoryMock = { upsertProfiles: jest.fn().mockResolvedValue(undefined) };
        loggingServiceMock = { write: jest.fn().mockResolvedValue(undefined) };

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
                { provide: MemberService, useValue: memberServiceMock },
                { provide: WechatPayService, useValue: {} },
                {
                    provide: SystemConfigService,
                    useValue: {
                        isBookingEnabled: jest.fn().mockResolvedValue(true),
                        getBookingDisabledMessage: jest.fn().mockResolvedValue('当前时间段暂不开放预约，请稍后再试'),
                        getTimeSlotLimit: jest.fn().mockResolvedValue({ morningMaxPeople: 100, afternoonMaxPeople: 100 }),
                    },
                },
                { provide: AdminApplicationRepository, useValue: {} },
                { provide: UserProfileRepository, useValue: userProfileRepositoryMock },
                { provide: LoggingService, useValue: loggingServiceMock },
            ],
        }).compile();

        service = moduleRef.get(BookingService);
        bookingRepo = moduleRef.get(getRepositoryToken(Booking));
        configRepo = moduleRef.get(getRepositoryToken(SystemConfig));

        await configRepo.save(
            configRepo.create({
                configId: 'system_config',
                paymentConfigJson: JSON.stringify({ paymentAmount: UNIT_PRICE, freeQuotaEnabled: true, freeQuotaLimit: 5 }),
            }),
        );
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('会员命中：金额 0、freeReason=member、所有 finalCharged=false', async () => {
        const result = await service.determineFreeEligibility(
            'user-1',
            [
                adult({ idCard: MEMBER_CARD }),
                { name: '儿童', phone: '13800000002', idCard: CHILD_13_CARD, passengerType: PassengerType.CHILD },
            ],
            BOOKING_DATE,
            TravelMode.SELF_DRIVING,
            VehicleType.WHEEL_MOTORCYCLE,
            '豫A12345',
        );
        expect(result.isFree).toBe(true);
        expect(result.freeReason).toBe('member');
        expect(result.amount).toBe(0);
        expect(result.chargedPeople).toBe(0);
        expect(result.ageFreePeople).toBe(0);
        expect(result.passengerPricing.every((p) => p.finalCharged === false)).toBe(true);
        expect(result.passengerPricing.every((p) => p.pricingReason === 'member_order_free')).toBe(true);
        expect(result.passengerPricing[1].ageValue).toBe(13);
    });

    it('会员未命中但每日名额命中：金额 0、freeReason=dailyQuota', async () => {
        const result = await service.determineFreeEligibility('user-2', [adult()], TODAY, TravelMode.SCENIC_BUS);
        expect(result.isFree).toBe(true);
        expect(result.freeReason).toBe('dailyQuota');
        expect(result.amount).toBe(0);
        expect(result.passengerPricing[0].pricingReason).toBe('daily_quota_order_free');
    });

    it('前两项未命中，一名 13 岁儿童 + 一名成人：年龄免费关闭，收费人数 2、金额 2*unitPrice', async () => {
        const result = await service.determineFreeEligibility(
            'user-3',
            [adult(), { name: '儿童', phone: '13800000002', idCard: CHILD_13_CARD, passengerType: PassengerType.CHILD }],
            BOOKING_DATE,
            TravelMode.SCENIC_BUS,
        );
        expect(result.isFree).toBe(false);
        expect(result.freeReason).toBeNull();
        expect(result.amount).toBe(2 * UNIT_PRICE);
        expect(result.chargedPeople).toBe(2);
        expect(result.ageFreePeople).toBe(0);
    });

    it('未显式选择类型的 13 岁联系人自动打标 child，但年龄免费关闭不免费', async () => {
        const result = await service.determineFreeEligibility(
            'user-auto-child-contact',
            [adult({ idCard: CHILD_13_CARD, passengerType: PassengerType.ADULT })],
            BOOKING_DATE,
            TravelMode.SCENIC_BUS,
        );

        expect(result.isFree).toBe(false);
        expect(result.freeReason).toBeNull();
        expect(result.amount).toBe(UNIT_PRICE);
        expect(result.ageFreePeople).toBe(0);
        expect(result.passengerPricing[0]).toMatchObject({
            passengerType: PassengerType.CHILD,
            ageValue: 13,
            ageFree: false,
            finalCharged: true,
            pricingReason: 'regular',
        });
    });

    it('无身份证儿童：ageFree=false、finalCharged=true、pricingReason=id_card_unavailable', async () => {
        const result = await service.determineFreeEligibility(
            'user-4',
            [
                adult(),
                { name: '儿童', phone: '13800000002', idCard: '', passengerType: PassengerType.CHILD, idCardUnavailable: true },
            ],
            BOOKING_DATE,
            TravelMode.SCENIC_BUS,
        );
        const child = result.passengerPricing[1];
        expect(child.ageFree).toBe(false);
        expect(child.finalCharged).toBe(true);
        expect(child.pricingReason).toBe('id_card_unavailable');
        expect(result.chargedPeople).toBe(2);
        expect(result.amount).toBe(2 * UNIT_PRICE);
    });

    it('类型与年龄不符在资格判定入口即被拒绝（稳定错误码）', async () => {
        await expect(
            service.determineFreeEligibility(
                'user-5',
                [adult(), { name: '儿童', phone: '13800000002', idCard: CHILD_14_CARD, passengerType: PassengerType.CHILD }],
                BOOKING_DATE,
                TravelMode.SCENIC_BUS,
            ),
        ).rejects.toMatchObject({ code: PassengerErrorCode.TYPE_AGE_MISMATCH });
    });

    it('后端强制车型人数上限：3 人摩托车 create 被拒绝（LIMIT_EXCEEDED）', async () => {
        await expect(
            service.createBooking({
                passengers: [adult(), adult(), adult()] as any,
                bookingDate: BOOKING_DATE,
                travelMode: 'selfDriving',
                vehicleType: 'wheelMotorcycle',
                licensePlate: '豫A12345',
                personCount: 3,
                wechatOpenId: 'user-limit',
            } as any),
        ).rejects.toMatchObject({ code: PassengerErrorCode.LIMIT_EXCEEDED });
    });

    it('preview 同样拒绝超员数组（LIMIT_EXCEEDED）', async () => {
        await expect(
            service.determineFreeEligibility(
                'user-limit2',
                [adult(), adult(), adult()],
                BOOKING_DATE,
                TravelMode.SELF_DRIVING,
                VehicleType.WHEEL_MOTORCYCLE,
                '豫A12345',
            ),
        ).rejects.toMatchObject({ code: PassengerErrorCode.LIMIT_EXCEEDED });
    });

    it('8 人小型客车 create 被拒绝；10 人摆渡车允许、11 人拒绝', async () => {
        // 8 人小型客车超限
        await expect(
            service.createBooking({
                passengers: Array.from({ length: 8 }, () => adult()) as any,
                bookingDate: BOOKING_DATE,
                travelMode: 'selfDriving',
                vehicleType: 'smallCar',
                licensePlate: '豫A12345',
                personCount: 8,
                wechatOpenId: 'user-limit3',
            } as any),
        ).rejects.toMatchObject({ code: PassengerErrorCode.LIMIT_EXCEEDED });

        // 11 人景区摆渡车超限
        await expect(
            service.createBooking({
                passengers: Array.from({ length: 11 }, () => adult()) as any,
                bookingDate: BOOKING_DATE,
                travelMode: 'scenicBus',
                personCount: 11,
                wechatOpenId: 'user-limit4',
            } as any),
        ).rejects.toMatchObject({ code: PassengerErrorCode.LIMIT_EXCEEDED });

        // 10 人景区摆渡车允许进入正常费用预览（上限内）
        const result = await service.determineFreeEligibility(
            'user-limit5',
            Array.from({ length: 10 }, () => adult()),
            BOOKING_DATE,
            TravelMode.SCENIC_BUS,
        );
        expect(result.isFree).toBe(false);
        expect(result.amount).toBe(10 * UNIT_PRICE);
        expect(result.chargedPeople).toBe(10);
    });

    it('personCount !== passengers.length：create 返回稳定人数不一致错误', async () => {
        await expect(
            service.createBooking({
                passengers: [
                    adult(),
                    { name: '儿童', phone: '13800000002', idCard: CHILD_13_CARD, passengerType: PassengerType.CHILD },
                ] as any,
                bookingDate: BOOKING_DATE,
                travelMode: 'scenicBus',
                personCount: 3, // 篡改：与 passengers.length=2 不一致
                wechatOpenId: 'user-6',
            } as any),
        ).rejects.toMatchObject({ code: PassengerErrorCode.COUNT_MISMATCH });
    });

    it('含 13 岁儿童的订单（年龄免费关闭）保持 PENDING/UNPAID，金额为 2 * unitPrice', async () => {
        const booking = await service.createBooking({
            passengers: [
                adult(),
                { name: '儿童', phone: '13800000002', idCard: CHILD_13_CARD, passengerType: PassengerType.CHILD },
            ] as any,
            bookingDate: BOOKING_DATE,
            travelMode: 'scenicBus',
            personCount: 2,
            wechatOpenId: 'user-7',
        } as any);

        expect(booking.status).toBe('pending');
        expect(booking.paymentStatus).toBe('unpaid');
        expect(booking.isFree).toBe(false);
        expect(booking.freeReason).toBeNull();
        expect(booking.amount).toBe(2 * UNIT_PRICE);
        expect(booking.personCount).toBe(2);

        const stored = JSON.parse(booking.passengers);
        expect(stored[0]).toMatchObject({
            passengerType: 'adult',
            idCardUnavailable: false,
            ageValue: null,
            ageFree: false,
            finalCharged: true,
            pricingReason: 'regular',
        });
        expect(stored[1]).toMatchObject({
            passengerType: 'child',
            idCardUnavailable: false,
            ageValue: 13,
            ageFree: false,
            finalCharged: true,
            pricingReason: 'regular',
        });
    });

    it('普通同行人的 70 岁身份证自动打标 senior，年龄免费关闭仍收费', async () => {
        const booking = await service.createBooking({
            passengers: [
                adult(),
                adult({ name: '老人', phone: '13800000002', idCard: SENIOR_70_CARD, passengerType: PassengerType.ADULT }),
            ] as any,
            bookingDate: BOOKING_DATE,
            travelMode: 'scenicBus',
            personCount: 2,
            wechatOpenId: 'user-auto-senior-companion',
        } as any);

        expect(booking.amount).toBe(2 * UNIT_PRICE);
        const stored = JSON.parse(booking.passengers);
        expect(stored[1]).toMatchObject({
            passengerType: 'senior',
            ageValue: 70,
            ageFree: false,
            finalCharged: true,
            pricingReason: 'regular',
        });
    });

    it('摩托车 + 会员联系人 + 13 岁儿童：整单免费直接 confirmed，快照为 member_order_free', async () => {
        const booking = await service.createBooking({
            passengers: [
                adult({ idCard: MEMBER_CARD }),
                { name: '儿童', phone: '13800000002', idCard: CHILD_13_CARD, passengerType: PassengerType.CHILD },
            ] as any,
            bookingDate: BOOKING_DATE,
            travelMode: 'selfDriving',
            vehicleType: 'wheelMotorcycle',
            licensePlate: '豫A12345',
            personCount: 2,
            wechatOpenId: 'user-8',
        } as any);

        expect(booking.status).toBe('confirmed');
        expect(booking.paymentStatus).toBe('paid');
        expect(booking.isFree).toBe(true);
        expect(booking.freeReason).toBe('member');
        expect(booking.amount).toBe(0);

        const stored = JSON.parse(booking.passengers);
        expect(stored.every((p: any) => p.finalCharged === false)).toBe(true);
        expect(stored.every((p: any) => p.pricingReason === 'member_order_free')).toBe(true);
        expect(stored[1].ageValue).toBe(13);
    });

    it('无身份证儿童订单保存 idCardUnavailable 与空身份证快照', async () => {
        const booking = await service.createBooking({
            passengers: [
                adult(),
                { name: '儿童', phone: '13800000002', idCard: '', passengerType: PassengerType.CHILD, idCardUnavailable: true },
            ] as any,
            bookingDate: BOOKING_DATE,
            travelMode: 'scenicBus',
            personCount: 2,
            wechatOpenId: 'user-9',
        } as any);

        expect(booking.status).toBe('pending');
        expect(booking.amount).toBe(2 * UNIT_PRICE);

        const stored = JSON.parse(booking.passengers);
        expect(stored[1]).toMatchObject({
            passengerType: 'child',
            idCard: '',
            idCardUnavailable: true,
            ageValue: null,
            ageFree: false,
            finalCharged: true,
            pricingReason: 'id_card_unavailable',
        });
    });

    it('年龄全免费订单不占用 dailyQuota 名额（名额统计只算 freeReason=dailyQuota）', async () => {
        // 种子：一笔今天创建的年龄免费订单（真实订单中联系人必为 adult，
        // 此处直接落库构造 freeReason=age 的历史数据验证统计口径）
        await bookingRepo.insert({
            bookingId: 'TLAGEFREE001',
            wechatOpenId: 'age-free-user',
            name: '老人',
            phone: '13800000009',
            idCard: SENIOR_70_CARD,
            passengers: '[]',
            bookingDate: TODAY as any,
            timeSlot: TimeSlot.MORNING,
            travelMode: TravelMode.SCENIC_BUS,
            personCount: 1,
            isFree: true,
            freeReason: 'age',
            amount: 0,
            status: BookingStatus.CONFIRMED,
            paymentStatus: PaymentStatus.PAID,
            refundStatus: RefundStatus.NONE,
            createdAt: new Date(),
            updatedAt: new Date(),
        });

        // 免费名额上限收紧为 1：若 age 订单被误计入名额，quotaUsed=1 将不再命中
        await configRepo.update(
            { configId: 'system_config' },
            { paymentConfigJson: JSON.stringify({ paymentAmount: UNIT_PRICE, freeQuotaEnabled: true, freeQuotaLimit: 1 }) },
        );

        const result = await service.determineFreeEligibility('fresh-user', [adult()], TODAY, TravelMode.SCENIC_BUS);
        expect(result.freeQuotaInfo.used).toBe(0);
        expect(result.isFree).toBe(true);
        expect(result.freeReason).toBe('dailyQuota');
    });

    it('preview 不接收 personCount（DTO 白名单剥离）', () => {
        const dto = plainToInstance(PreviewBookingDto, {
            bookingDate: BOOKING_DATE,
            passengers: [{ name: '张三', phone: '13800000001', idCard: ADULT_CARD }],
            personCount: 99,
        });
        const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: false });
        expect(errors).toHaveLength(0);
        expect((dto as any).personCount).toBeUndefined();
    });
});
