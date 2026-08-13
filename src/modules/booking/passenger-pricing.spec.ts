import { PassengerErrorCode } from '../../common/passenger-business.exception';
import {
    calculateAgePricing,
    calculateYearAge,
    extractBirthYear,
    getPassengerLimit,
    normalizePassengerType,
    PassengerPricingInput,
    PassengerType,
    validateChineseIdCard,
    validatePassengerBusinessRules,
    validatePassengerLimit,
} from './passenger-pricing';

/**
 * 按 MOD 11-2 生成虚构合法 18 位身份证号（地区 110101 + 出生日期 + 顺序号 + 校验码）。
 * 均为按算法生成的虚构号码，不含任何真实用户身份证。
 */
function makeIdCard(birth: string, seq = '001'): string {
    const prefix = '110101' + birth + seq; // 17 位
    const factors = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    const checkCodes = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
    let sum = 0;
    for (let i = 0; i < 17; i++) {
        sum += parseInt(prefix[i], 10) * factors[i];
    }
    return prefix + checkCodes[sum % 11];
}

/** 常规成人（联系人） */
function adult(overrides: Partial<PassengerPricingInput> = {}): PassengerPricingInput {
    return { name: '张三', phone: '13800000001', idCard: makeIdCard('19900101'), ...overrides };
}

/** 预约 2026 年时 7 岁儿童（2019 年出生） */
const BOOKING_2026 = '2026-08-13';

describe('normalizePassengerType', () => {
    it('合法类型原样返回', () => {
        expect(normalizePassengerType('adult')).toBe(PassengerType.ADULT);
        expect(normalizePassengerType('child')).toBe(PassengerType.CHILD);
        expect(normalizePassengerType('senior')).toBe(PassengerType.SENIOR);
    });

    it('旧客户端缺失或非法值时兼容为 adult', () => {
        expect(normalizePassengerType(undefined)).toBe(PassengerType.ADULT);
        expect(normalizePassengerType(null)).toBe(PassengerType.ADULT);
        expect(normalizePassengerType('')).toBe(PassengerType.ADULT);
        expect(normalizePassengerType('unknown')).toBe(PassengerType.ADULT);
    });
});

describe('validateChineseIdCard', () => {
    it('合法号码通过（含小写 x）', () => {
        const id = makeIdCard('19900101');
        expect(validateChineseIdCard(id)).toBe(true);
        // 末位为 X 的合法号码用小写 x 传入
        const xId = makeIdCard('20190101', '999');
        if (xId.endsWith('X')) {
            expect(validateChineseIdCard(xId.slice(0, 17) + 'x')).toBe(true);
        }
    });

    it('长度不足或非 18 位数字格式拒绝', () => {
        expect(validateChineseIdCard('11010119900101123')).toBe(false);
        expect(validateChineseIdCard('1101011990010112345')).toBe(false);
        expect(validateChineseIdCard('11010119900101123A')).toBe(false);
        expect(validateChineseIdCard('')).toBe(false);
        expect(validateChineseIdCard(null as unknown as string)).toBe(false);
    });

    it('出生日期为不存在的公历日期时拒绝，即使其他字符格式正确', () => {
        // 月份 13：格式正确但日期不存在
        expect(validateChineseIdCard('110101199013011234')).toBe(false);
        // 2 月 30 日：格式正确但日期不存在
        expect(validateChineseIdCard('110101199002301234')).toBe(false);
        // 校验码对错先不管，日期必须有效
        expect(validateChineseIdCard(makeIdCard('19900230'))).toBe(false);
    });

    it('伪造出生年份但校验码错误时拒绝', () => {
        const validChild = makeIdCard('20190101'); // 校验码正确
        // 伪造出生年份（2019 → 2018）但沿用原校验码
        const forged = '11010120180101' + validChild.slice(14);
        expect(forged.slice(6, 10)).toBe('2018');
        expect(forged).not.toBe(validChild);
        // 同序号的真实 2018 出生号码校验码与伪造值不同
        expect(validateChineseIdCard(forged)).toBe(false);
        // 而真实生成的 2018 出生号码合法
        expect(validateChineseIdCard(makeIdCard('20180101'))).toBe(true);
    });
});

describe('extractBirthYear / calculateYearAge', () => {
    it('合法身份证读取出生年份', () => {
        expect(extractBirthYear(makeIdCard('20190101'))).toBe(2019);
        expect(extractBirthYear(makeIdCard('19560101'))).toBe(1956);
    });

    it('非法身份证返回 null', () => {
        expect(extractBirthYear('110101199013011234')).toBeNull();
        expect(extractBirthYear('123')).toBeNull();
        expect(extractBirthYear('')).toBeNull();
    });

    it('年龄值 = 预约游玩年份 - 身份证出生年份', () => {
        // 预约 2026 年、2019 年出生 → 7；2018 年出生 → 8
        expect(calculateYearAge(makeIdCard('20190101'), BOOKING_2026)).toBe(7);
        expect(calculateYearAge(makeIdCard('20180101'), BOOKING_2026)).toBe(8);
        // 1956 年出生 → 70；1957 年出生 → 69
        expect(calculateYearAge(makeIdCard('19560101'), BOOKING_2026)).toBe(70);
        expect(calculateYearAge(makeIdCard('19570101'), BOOKING_2026)).toBe(69);
    });

    it('跨年预约日期按年份重算', () => {
        const child = makeIdCard('20190101');
        expect(calculateYearAge(child, '2026-12-31')).toBe(7);
        expect(calculateYearAge(child, '2027-01-01')).toBe(8);
    });

    it('未来出生年份（校验码正确）得到负年龄', () => {
        const futureCard = makeIdCard('20300101'); // 校验码正确，但出生年份晚于预约年份
        expect(validateChineseIdCard(futureCard)).toBe(true);
        expect(calculateYearAge(futureCard, BOOKING_2026)).toBe(-4);
    });

    it('预约日期无有效年份或身份证非法时返回 null', () => {
        const child = makeIdCard('20190101');
        expect(calculateYearAge(child, '')).toBeNull();
        expect(calculateYearAge(child, 'abc')).toBeNull();
        expect(calculateYearAge('110101199013011234', BOOKING_2026)).toBeNull();
    });
});

describe('validatePassengerBusinessRules', () => {
    it('预约 2026 年、2019 年出生 → 年龄 7 → 儿童有效', () => {
        const passengers = [adult(), { name: '儿童', phone: '13800000002', idCard: makeIdCard('20190101'), passengerType: PassengerType.CHILD }];
        expect(() => validatePassengerBusinessRules(passengers, BOOKING_2026)).not.toThrow();
    });

    it('2018 年出生 → 年龄 8 → 儿童类型不符，抛 TYPE_AGE_MISMATCH', () => {
        const passengers = [adult(), { name: '儿童', phone: '13800000002', idCard: makeIdCard('20180101'), passengerType: PassengerType.CHILD }];
        expect(() => validatePassengerBusinessRules(passengers, BOOKING_2026)).toThrowError(
            expect.objectContaining({ code: PassengerErrorCode.TYPE_AGE_MISMATCH }),
        );
    });

    it('未来出生年份（校验码正确）：儿童/老人类型均抛 TYPE_AGE_MISMATCH', () => {
        const futureCard = makeIdCard('20300101');
        const futureChild = [adult(), { name: '未来儿童', phone: '13800000002', idCard: futureCard, passengerType: PassengerType.CHILD }];
        expect(() => validatePassengerBusinessRules(futureChild, BOOKING_2026)).toThrowError(
            expect.objectContaining({ code: PassengerErrorCode.TYPE_AGE_MISMATCH }),
        );
        const futureSenior = [adult(), { name: '未来老人', phone: '13800000002', idCard: futureCard, passengerType: PassengerType.SENIOR }];
        expect(() => validatePassengerBusinessRules(futureSenior, BOOKING_2026)).toThrowError(
            expect.objectContaining({ code: PassengerErrorCode.TYPE_AGE_MISMATCH }),
        );
    });

    it('1956 年出生 → 年龄 70 → 老人有效；1957 年出生 → 69 → 老人类型不符', () => {
        const seniorOk = [adult(), { name: '老人', phone: '13800000002', idCard: makeIdCard('19560101'), passengerType: PassengerType.SENIOR }];
        expect(() => validatePassengerBusinessRules(seniorOk, BOOKING_2026)).not.toThrow();

        const seniorBad = [adult(), { name: '老人', phone: '13800000002', idCard: makeIdCard('19570101'), passengerType: PassengerType.SENIOR }];
        expect(() => validatePassengerBusinessRules(seniorBad, BOOKING_2026)).toThrowError(
            expect.objectContaining({ code: PassengerErrorCode.TYPE_AGE_MISMATCH }),
        );
    });

    it('类型与年龄不符不静默收费，错误响应不含身份证原值', () => {
        const forgedCard = makeIdCard('20180101');
        const passengers = [adult(), { name: '儿童', phone: '13800000002', idCard: forgedCard, passengerType: PassengerType.CHILD }];
        let thrown: unknown;
        try {
            validatePassengerBusinessRules(passengers, BOOKING_2026);
        } catch (e) {
            thrown = e;
        }
        expect(thrown).toBeDefined();
        expect(JSON.stringify((thrown as any).getResponse?.())).not.toContain(forgedCard);
    });

    it('成人缺失 passengerType 时兼容为 adult', () => {
        const legacy = [adult({ passengerType: undefined as any }), adult({ name: '李四', idCard: makeIdCard('19910101'), passengerType: undefined as any })];
        expect(() => validatePassengerBusinessRules(legacy, BOOKING_2026)).not.toThrow();
    });

    it('联系人是儿童/老人时抛 CONTACT_INVALID', () => {
        const childFirst = [{ name: '儿童', phone: '13800000001', idCard: makeIdCard('20190101'), passengerType: PassengerType.CHILD }, adult()];
        expect(() => validatePassengerBusinessRules(childFirst, BOOKING_2026)).toThrowError(
            expect.objectContaining({ code: PassengerErrorCode.CONTACT_INVALID }),
        );

        const seniorFirst = [{ name: '老人', phone: '13800000001', idCard: makeIdCard('19560101'), passengerType: PassengerType.SENIOR }, adult()];
        expect(() => validatePassengerBusinessRules(seniorFirst, BOOKING_2026)).toThrowError(
            expect.objectContaining({ code: PassengerErrorCode.CONTACT_INVALID }),
        );
    });

    it('成人身份证必填：缺失或空抛 ID_CARD_REQUIRED', () => {
        const missing = [adult(), adult({ idCard: undefined })];
        expect(() => validatePassengerBusinessRules(missing, BOOKING_2026)).toThrowError(
            expect.objectContaining({ code: PassengerErrorCode.ID_CARD_REQUIRED }),
        );
        const empty = [adult(), adult({ idCard: '' })];
        expect(() => validatePassengerBusinessRules(empty, BOOKING_2026)).toThrowError(
            expect.objectContaining({ code: PassengerErrorCode.ID_CARD_REQUIRED }),
        );
    });

    it('成人 idCardUnavailable=true 抛 UNAVAILABLE_NOT_ALLOWED', () => {
        const passengers = [adult(), adult({ idCard: '', idCardUnavailable: true })];
        expect(() => validatePassengerBusinessRules(passengers, BOOKING_2026)).toThrowError(
            expect.objectContaining({ code: PassengerErrorCode.UNAVAILABLE_NOT_ALLOWED }),
        );
    });

    it('unavailable=true 同时传身份证抛 UNAVAILABLE_NOT_ALLOWED', () => {
        const passengers = [adult(), { name: '儿童', phone: '13800000002', idCard: makeIdCard('20190101'), passengerType: PassengerType.CHILD, idCardUnavailable: true }];
        expect(() => validatePassengerBusinessRules(passengers, BOOKING_2026)).toThrowError(
            expect.objectContaining({ code: PassengerErrorCode.UNAVAILABLE_NOT_ALLOWED }),
        );
    });

    it('儿童/老人无身份证且 unavailable=true 时有效', () => {
        const passengers = [
            adult(),
            { name: '儿童', phone: '13800000002', idCard: '', passengerType: PassengerType.CHILD, idCardUnavailable: true },
            { name: '老人', phone: '13800000003', idCard: null as any, passengerType: PassengerType.SENIOR, idCardUnavailable: true },
        ];
        expect(() => validatePassengerBusinessRules(passengers, BOOKING_2026)).not.toThrow();
    });

    it('儿童/老人既无身份证也未勾选暂时无法提供抛 ID_CARD_REQUIRED', () => {
        const passengers = [adult(), { name: '儿童', phone: '13800000002', idCard: '', passengerType: PassengerType.CHILD }];
        expect(() => validatePassengerBusinessRules(passengers, BOOKING_2026)).toThrowError(
            expect.objectContaining({ code: PassengerErrorCode.ID_CARD_REQUIRED }),
        );
    });

    it('身份证格式错误抛 ID_CARD_INVALID', () => {
        const passengers = [adult(), { name: '儿童', phone: '13800000002', idCard: '110101199013011234', passengerType: PassengerType.CHILD }];
        expect(() => validatePassengerBusinessRules(passengers, BOOKING_2026)).toThrowError(
            expect.objectContaining({ code: PassengerErrorCode.ID_CARD_INVALID }),
        );
    });

    it('personCount 不参与纯函数判定（避免双事实来源）', () => {
        const passengers = [
            { ...adult(), personCount: 99 as any },
            { name: '儿童', phone: '13800000002', idCard: makeIdCard('20190101'), passengerType: PassengerType.CHILD, personCount: 1 as any },
        ];
        // 数组长度 2，personCount 篡改为 99 不影响校验与计价
        expect(() => validatePassengerBusinessRules(passengers, BOOKING_2026)).not.toThrow();
        const summary = calculateAgePricing(passengers, BOOKING_2026);
        expect(summary.passengerPricing).toHaveLength(2);
        expect(summary.chargedPeople + summary.ageFreePeople).toBe(2);
    });

    it('空乘客列表抛 CONTACT_INVALID（防御，DTO 之外）', () => {
        expect(() => validatePassengerBusinessRules([], BOOKING_2026)).toThrowError(
            expect.objectContaining({ code: PassengerErrorCode.CONTACT_INVALID }),
        );
    });
});

describe('getPassengerLimit / validatePassengerLimit', () => {
    it('车型人数上限口径：摩托 2 / 小客车 7 / 非机动车与摆渡车等其他方式 10', () => {
        expect(getPassengerLimit('selfDriving', 'wheelMotorcycle')).toBe(2);
        expect(getPassengerLimit('selfDriving', 'smallCar')).toBe(7);
        expect(getPassengerLimit('selfDriving', 'nonMotorized')).toBe(10);
        expect(getPassengerLimit('scenicBus', 'smallCar')).toBe(10);
        expect(getPassengerLimit('scenicBus', undefined)).toBe(10);
        expect(getPassengerLimit('tourGroup', null)).toBe(10);
        expect(getPassengerLimit(undefined, undefined)).toBe(10);
    });

    it('3 人摩托车超限：抛 LIMIT_EXCEEDED，message 包含上限', () => {
        const three = [adult(), adult(), adult()];
        expect(() => validatePassengerLimit(three, 'selfDriving', 'wheelMotorcycle')).toThrowError(
            expect.objectContaining({
                code: PassengerErrorCode.LIMIT_EXCEEDED,
                message: expect.stringContaining('2'),
            }),
        );
    });

    it('8 人小型客车超限：抛 LIMIT_EXCEEDED，message 包含上限', () => {
        const eight = Array.from({ length: 8 }, () => adult());
        expect(() => validatePassengerLimit(eight, 'selfDriving', 'smallCar')).toThrowError(
            expect.objectContaining({
                code: PassengerErrorCode.LIMIT_EXCEEDED,
                message: expect.stringContaining('7'),
            }),
        );
    });

    it('上限内不抛错：2 人摩托、10 人摆渡车', () => {
        expect(() => validatePassengerLimit([adult(), adult()], 'selfDriving', 'wheelMotorcycle')).not.toThrow();
        expect(() => validatePassengerLimit(Array.from({ length: 10 }, () => adult()), 'scenicBus', undefined)).not.toThrow();
    });
});

describe('calculateAgePricing', () => {
    it('2019 年出生儿童：年龄 7、年龄免费', () => {
        const passengers = [adult(), { name: '儿童', phone: '13800000002', idCard: makeIdCard('20190101'), passengerType: PassengerType.CHILD }];
        const summary = calculateAgePricing(passengers, BOOKING_2026);
        expect(summary.ageFreePeople).toBe(1);
        expect(summary.chargedPeople).toBe(1);
        const child = summary.passengerPricing[1];
        expect(child.ageValue).toBe(7);
        expect(child.ageFree).toBe(true);
        expect(child.finalCharged).toBe(false);
        expect(child.pricingReason).toBe('child_age_free');
    });

    it('1956 年出生老人：年龄 70、年龄免费', () => {
        const passengers = [adult(), { name: '老人', phone: '13800000002', idCard: makeIdCard('19560101'), passengerType: PassengerType.SENIOR }];
        const summary = calculateAgePricing(passengers, BOOKING_2026);
        expect(summary.ageFreePeople).toBe(1);
        expect(summary.chargedPeople).toBe(1);
        expect(summary.passengerPricing[1].pricingReason).toBe('senior_age_free');
    });

    it('无身份证人员结果固定为 id_card_unavailable，与 regular 区分', () => {
        const passengers = [
            adult(),
            { name: '儿童', phone: '13800000002', idCard: '', passengerType: PassengerType.CHILD, idCardUnavailable: true },
        ];
        const summary = calculateAgePricing(passengers, BOOKING_2026);
        const noId = summary.passengerPricing[1];
        expect(noId.ageValue).toBeNull();
        expect(noId.ageFree).toBe(false);
        expect(noId.finalCharged).toBe(true);
        expect(noId.pricingReason).toBe('id_card_unavailable');
        // 有身份证的正常收费成人是 regular
        const contact = summary.passengerPricing[0];
        expect(contact.ageValue).toBeNull();
        expect(contact.ageFree).toBe(false);
        expect(contact.finalCharged).toBe(true);
        expect(contact.pricingReason).toBe('regular');
        expect(summary.ageFreePeople).toBe(0);
        expect(summary.chargedPeople).toBe(2);
    });

    it('未来出生年份即使漏过前置校验也不得获得年龄免费（防御）', () => {
        const futureCard = makeIdCard('20300101');
        const summary = calculateAgePricing(
            [adult(), { name: '未来儿童', phone: '13800000002', idCard: futureCard, passengerType: PassengerType.CHILD }],
            BOOKING_2026,
        );
        expect(summary.passengerPricing[1].ageValue).toBe(-4);
        expect(summary.passengerPricing[1].ageFree).toBe(false);
        expect(summary.ageFreePeople).toBe(0);
        expect(summary.chargedPeople).toBe(2);
    });

    it('index 与输入顺序一致，类型缺省归一化为 adult', () => {
        const passengers = [adult(), { name: '旧数据', phone: '13800000002', idCard: makeIdCard('19880101') }];
        const summary = calculateAgePricing(passengers, BOOKING_2026);
        expect(summary.passengerPricing.map((p) => p.index)).toEqual([0, 1]);
        expect(summary.passengerPricing[1].passengerType).toBe(PassengerType.ADULT);
    });
});
